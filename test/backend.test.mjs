import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {execute} from '../dist/runtime.js';
import {ProviderService,cleanStreams,sourceSpec} from '../dist/core.js';
import {publicURL,publicIP,safeRequest,discardResponse} from '../dist/network.js';
import {createServer} from 'node:http';
import {request} from 'undici';
import {createBackend,start} from '../dist/server.js';
import {restoreProviders} from '../dist/bootstrap.js';
import {workerLimit} from '../dist/worker-gate.js';

const fixture={
 catalog:'exports.catalog=[{title:"A public collection",filter:"public"}];',
 posts:'exports.getPosts=async()=>[{title:"Sintel",link:"sample",image:"https://example.com/a.jpg"}];exports.getSearchPosts=exports.getPosts;',
 meta:'exports.getMeta=async()=>({title:"Sintel",type:"movie",synopsis:"Open film",linkList:[{title:"Play",directLinks:[{title:"Trailer",link:"sample"}]}]});',
 stream:'exports.getStream=async()=>[{server:"A",link:"https://media.w3.org/trailer.mp4",type:"mp4",quality:"480",headers:{Referer:"https://example.com"},subtitles:[{uri:"https://example.com/en.vtt",title:"English",type:"text/vtt"}]},{server:"B",link:"https://example.com/stream.m3u8",type:"m3u8",quality:"1080"}];',
 settings:'exports.getSettingsSchema=async()=>[{key:"quality",type:"select",label:"Quality",options:[{value:"1080",label:"1080p"}]}];'
};
const sha='a'.repeat(40);
const scratch=fileURLToPath(new URL('./.tmp/',import.meta.url));await mkdir(scratch,{recursive:true});
async function cleanup(directory){assert.ok(path.resolve(directory).startsWith(path.resolve(scratch)+path.sep));await rm(directory,{recursive:true,force:true});}
async function fixtureHTTP(config){if(config.url.includes('/commits/'))return {status:200,headers:{},url:config.url,data:{sha}};if(config.url.endsWith('/manifest.json'))return {status:200,headers:{},url:config.url,data:[{value:'test',display_name:'Fixture provider',version:'1.0'}]};const match=config.url.match(/\/(\w+)\.js$/);if(match&&fixture[match[1]])return {status:200,headers:{},url:config.url,data:fixture[match[1]]};throw new Error('404');}
const runner=job=>execute({...job,timeoutMs:4000},fixtureHTTP);
test('explicit commit revisions install without an unnecessary GitHub API lookup',async()=>{
 const directory=await mkdtemp(path.join(scratch,'luma-pinned-'));
 try{const service=new ProviderService(directory,config=>{assert.ok(!config.url.startsWith('https://api.github.com/'),'pinned revision should use raw content directly');return fixtureHTTP(config);},runner);await service.init();const source=await service.addSource('https://github.com/owner/providers/tree/'+sha);assert.equal(source.commit,sha);const plugin=await service.install(source.id,'test');assert.equal((await service.catalog(plugin.id)).data.length,1);}finally{await cleanup(directory);}
});
test('discarding a rejected unread HTTP body closes its stream without an unhandled abort',async()=>{
 const server=createServer((req,res)=>{res.writeHead(403,{'Content-Type':'text/plain'});res.write('Denied');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const response=await request('http://127.0.0.1:'+server.address().port);assert.equal(response.statusCode,403);discardResponse(response.body);await new Promise(resolve=>setTimeout(resolve,20));assert.equal(response.body.destroyed,true);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('configured provider restores after an empty-disk restart, without reinstalling existing state',async()=>{
 const first=await mkdtemp(path.join(scratch,'luma-restore-one-')),second=await mkdtemp(path.join(scratch,'luma-restore-two-'));
 try{
  const original=new ProviderService(first,fixtureHTTP,runner);await original.init();await restoreProviders(original,'https://github.com/owner/providers/tree/'+sha,'test');
  const id=original.state.plugins.find(p=>p.value==='test').id;await original.update(id,{enabled:false,settings:{quality:'720'}});
  await restoreProviders(original,'https://github.com/owner/providers/tree/'+sha,'test');assert.equal(original.plugin(id).enabled,false);assert.equal(original.plugin(id).kv.quality,'720');
  const reset=new ProviderService(second,fixtureHTTP,runner);await reset.init();await restoreProviders(reset,'https://github.com/owner/providers/tree/'+sha,'test');assert.equal(reset.plugin(id).enabled,true);assert.equal(reset.plugin(id).commit,sha);assert.equal((await reset.catalog(id)).data.length,1);
 }finally{await cleanup(first);await cleanup(second);}
});
test('single-worker mode queues concurrent provider calls without exceeding its limit',async()=>{
 const saved=process.env.LUMA_MAX_WORKERS;process.env.LUMA_MAX_WORKERS='1';const directory=await mkdtemp(path.join(scratch,'luma-single-'));let active=0,peak=0;
 try{
  const service=new ProviderService(directory,fixtureHTTP,async job=>{active++;peak=Math.max(peak,active);try{await new Promise(resolve=>setTimeout(resolve,15));return await runner(job);}finally{active--;}});await service.init();const source=await service.addSource('https://github.com/owner/providers');const plugin=await service.install(source.id,'test');
  const results=await Promise.all([service.catalog('demo.open-films'),service.catalog(plugin.id),service.search('Sintel')]);assert.equal(peak,1);assert.ok(results[0].data.length);assert.ok(results[1].data.length);assert.ok(results[2].results.every(p=>!p.error));
  assert.throws(()=>workerLimit('0'));assert.throws(()=>workerLimit('NaN'));assert.equal(workerLimit(undefined),6);
 }finally{if(saved===undefined)delete process.env.LUMA_MAX_WORKERS;else process.env.LUMA_MAX_WORKERS=saved;await cleanup(directory);}
});
test('hosted startup uses PORT and preserves credentials and registry across restarts',async()=>{
 const directory=await mkdtemp(path.join(scratch,'luma-hosted-'));
 const names=['LUMA_HOST','LUMA_PORT','PORT','LUMA_DATA_DIR','LUMA_API_TOKEN'];const saved=Object.fromEntries(names.map(name=>[name,process.env[name]]));let active;
 try{
  process.env.LUMA_HOST='127.0.0.1';delete process.env.LUMA_PORT;process.env.PORT='0';process.env.LUMA_DATA_DIR=directory;delete process.env.LUMA_API_TOKEN;
  active=await start();assert.notEqual(active.address().port,4317);
  const token=(await readFile(path.join(directory,'auth-token'),'utf8')).trim();assert.ok(token.length>=32);
  let origin='http://127.0.0.1:'+active.address().port;
  assert.equal((await fetch(origin+'/health')).status,200);assert.equal((await fetch(origin+'/api/status')).status,401);
  const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
  assert.equal((await fetch(origin+'/api/plugins/demo.open-films',{method:'PATCH',headers,body:JSON.stringify({enabled:false})})).status,200);
  await new Promise(resolve=>active.close(resolve));active=await start();origin='http://127.0.0.1:'+active.address().port;
  assert.equal((await readFile(path.join(directory,'auth-token'),'utf8')).trim(),token);
  assert.equal((await fetch(origin+'/api/status',{headers})).status,200);
  assert.equal((await fetch(origin+'/api/providers/demo.open-films/catalog',{headers})).status,400);
 }finally{
  if(active?.listening)await new Promise(resolve=>active.close(resolve));
  for(const name of names){if(saved[name]===undefined)delete process.env[name];else process.env[name]=saved[name];}
  await cleanup(directory);
 }
});
test('public network policy rejects private, mapped, and credential URLs',async()=>{
 for(const address of ['127.0.0.1','0.0.0.0','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','::1','::ffff:127.0.0.1','fc00::1'])assert.equal(publicIP(address),false,address);
 assert.equal(publicIP('8.8.8.8'),true);
 for(const url of ['file:///etc/passwd','http://localhost/a','http://2130706433','http://[::ffff:127.0.0.1]','https://user:pass@example.com'])assert.throws(()=>publicURL(url));
 await assert.rejects(()=>safeRequest({url:'http://127.0.0.1/secret'}),/Private/);
 assert.equal(sourceSpec('https://github.com/Zenda-Cross/vega-providers').owner,'Zenda-Cross');assert.throws(()=>sourceSpec('https://evil.example/repo'));
});
test('QuickJS supports async HTTP, Cheerio, provider KV, URL, and binary helpers',async()=>{
 const result=await execute({code:`exports.getPosts=async({providerContext:c})=>{const r=await c.axios.get('https://example.com');const $=c.cheerio.load(r.data);await c.kvStore.set('count',3);const u=new URL('/x','https://example.com');u.searchParams.set('a','two words');return [{title:$('h1').text(),url:u.href,encoding:btoa('ok'),bytes:[...new TextEncoder().encode('é')]}]}`,operation:'getPosts',params:{},kv:{},timeoutMs:4000},async()=>({data:'<h1>Works</h1>',status:200,headers:{},url:'https://example.com'}));
 assert.equal(result.data[0].title,'Works');assert.equal(result.kv.count,3);assert.match(result.data[0].url,/a=two\+words/);assert.equal(result.data[0].encoding,'b2s=');assert.deepEqual(result.data[0].bytes,[195,169]);
});
test('provider isolate has no process, filesystem, or Node require',async()=>{
 const result=await execute({code:`exports.catalog=[typeof process,typeof globalThis.process,typeof __filename];`,operation:'catalog',params:{},kv:{},timeoutMs:4000});assert.deepEqual(result.data,['undefined','undefined','undefined']);
 await assert.rejects(()=>execute({code:`require('node:fs');exports.catalog=[]`,operation:'catalog',params:{},kv:{},timeoutMs:4000}),/External modules/);
});
test('nonterminating providers are interrupted',async()=>{
 await assert.rejects(()=>execute({code:'while(true){}',operation:'catalog',params:{},kv:{},timeoutMs:120}),/interrupt|timed out/i);
});
test('registry pins provider code, persists settings, aggregates results, and verifies integrity',async()=>{
 const directory=await mkdtemp(path.join(scratch,'luma-registry-'));
 try{const service=new ProviderService(directory,fixtureHTTP,runner);await service.init();const source=await service.addSource('https://github.com/owner/providers');const plugin=await service.install(source.id,'test');assert.equal(plugin.commit,sha);assert.equal((await service.catalog(plugin.id)).data[0].title,'A public collection');
 const searched=await service.search('Sintel',[plugin.id]);assert.equal(searched.results[0].items.length,1);const streams=await service.streams(plugin.id,'sample','movie');assert.equal(streams.items[0].quality,'1080');assert.equal(streams.items[1].headers.Referer,'https://example.com');assert.equal(streams.items[1].subtitles[0].title,'English');
 await service.update(plugin.id,{settings:{quality:'1080'}});const restored=new ProviderService(directory,fixtureHTTP,runner);await restored.init();assert.equal(restored.plugin(plugin.id).kv.quality,'1080');
 const moduleFile=path.join(directory,'modules',plugin.id+'.json');const modules=JSON.parse(await readFile(moduleFile,'utf8'));modules.catalog+=';bad();';await writeFile(moduleFile,JSON.stringify(modules));await assert.rejects(()=>restored.catalog(plugin.id),/integrity/);
 await restored.update(plugin.id,{enabled:false});await assert.rejects(()=>restored.streams(plugin.id,'sample','movie'),/disabled/);
 }finally{await cleanup(directory);}
});
test('one failed provider does not erase results from the others',async()=>{
 const directory=await mkdtemp(path.join(scratch,'luma-partial-'));
 try{const service=new ProviderService(directory,fixtureHTTP,job=>job.params.providerValue==='test'?Promise.reject(new Error('offline')):runner(job));await service.init();const source=await service.addSource('https://github.com/owner/providers');await service.install(source.id,'test');const r=await service.search('Sintel');assert.ok(r.results.some(p=>p.error==='offline'));assert.ok(r.results.some(p=>p.items.length>0));}finally{await cleanup(directory);}
});
test('stream cleanup rejects dangerous URLs and headers while preserving server choices',()=>{
 const result=cleanStreams([{server:'a',link:'http://127.0.0.1/a',quality:'1080'},{server:'b',link:'https://example.com/video.mp4',headers:{Host:'evil',Referer:'https://example.com','X-Bad':'a\r\nb'},subtitles:[{uri:'file:///secret'}]}]);assert.equal(result.length,1);assert.deepEqual(result[0].headers,{Referer:'https://example.com'});assert.equal(result[0].subtitles.length,0);
});
test('forced stream refresh bypasses cached expiring links',async()=>{
 const directory=await mkdtemp(path.join(scratch,'luma-refresh-'));let calls=0;
 try{const service=new ProviderService(directory,fixtureHTTP,job=>{if(job.operation==='getStream')calls++;return runner(job);});await service.init();await service.streams('demo.open-films','sintel','movie');await service.streams('demo.open-films','sintel','movie');assert.equal(calls,1);await service.streams('demo.open-films','sintel','movie',true);assert.equal(calls,2);}finally{await cleanup(directory);}
});
test('HTTP API enforces authentication and origin, and runs browse → details → stream',async()=>{
 const directory=await mkdtemp(path.join(scratch,'luma-http-'));const token='test-token-'.repeat(8);const service=new ProviderService(directory,fixtureHTTP,runner);const {server}=await createBackend({directory,token,service});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 const call=(route,body,extra={})=>fetch(origin+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{}),...extra},body:body?JSON.stringify(body):undefined});
 try{assert.equal((await fetch(origin+'/api/status')).status,401);assert.equal((await call('/api/status',null,{Origin:'https://evil.example'})).status,403);assert.equal((await call('/api/status')).status,200);
 const posts=await (await call('/api/providers/demo.open-films/posts',{filter:'open'})).json();assert.equal(posts.items.length,2);
 const details=await (await call('/api/providers/demo.open-films/meta',{link:posts.items[0].link})).json();assert.equal(details.data.title,'Sintel');
 const streams=await (await call('/api/providers/demo.open-films/streams',{link:details.data.linkList[0].directLinks[0].link,type:'movie'})).json();assert.equal(streams.items.length,2);
 }finally{await new Promise(resolve=>server.close(resolve));await cleanup(directory);}
});


test('built-in app access allows discovery and playback but denies all administration and secrets',async()=>{
 const directory=await mkdtemp(path.join(scratch,'luma-app-'));const token='admin-'.repeat(10),appToken='device-'.repeat(10);
 const {server}=await createBackend({directory,token,appToken});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 const call=(route,method='GET',body)=>fetch(origin+route,{method,headers:{Authorization:'Bearer '+appToken,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
 try{
  assert.equal((await call('/api/status')).status,200);
  assert.equal((await call('/api/providers/demo.open-films/catalog')).status,200);
  const result=await (await call('/api/search','POST',{query:'Sintel'})).json();assert.ok(result.results[0].items.length);
  assert.equal((await call('/api/providers/demo.open-films/streams','POST',{link:'sintel',type:'movie'})).status,200);
  for(const [route,method] of [['/api/providers/demo.open-films/settings','GET'],['/api/plugins/demo.open-films','PATCH'],['/api/plugins/demo.open-films','DELETE'],['/api/sources','POST'],['/api/plugins/install','POST'],['/api/status/extra','GET']])assert.equal((await call(route,method,method==='POST'||method==='PATCH'?{}:undefined)).status,403,route);
  assert.equal((await fetch(origin+'/api/status',{headers:{Authorization:'Bearer wrong'}})).status,401);
 }finally{await new Promise(resolve=>server.close(resolve));await cleanup(directory);}
});
