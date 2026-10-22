import {getQuickJS,type QuickJSHandle,type QuickJSDeferredPromise} from 'quickjs-emscripten';
import {parentPort,workerData,isMainThread} from 'node:worker_threads';
import {readFile} from 'node:fs/promises';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {safeRequest,type HttpConfig,type HttpResult} from './network.js';

export type Job={code:string;operation:string;params:Record<string,unknown>;kv:Record<string,unknown>;timeoutMs?:number};
export type JobResult={data:unknown;kv:Record<string,unknown>;warnings:string[]};
export async function execute(job:Job,http:(config:HttpConfig,signal?:AbortSignal)=>Promise<HttpResult>=safeRequest):Promise<JobResult>{
 const QuickJS=await getQuickJS();const runtime=QuickJS.newRuntime();runtime.setMemoryLimit(96*1024*1024);runtime.setMaxStackSize(1024*1024);
 const deadline=Date.now()+(job.timeoutMs||35000);runtime.setInterruptHandler(()=>Date.now()>deadline);
 const ctx=runtime.newContext();const abort=new AbortController();let live=true,requests=0,inflight=0;
 const pending=new Set<QuickJSDeferredPromise>();const timers=new Map<number,{timer:ReturnType<typeof setTimeout>;fn:QuickJSHandle;args:QuickJSHandle[]}>();let nextTimer=1,reportedError=false;
 const pump=()=>{if(!live)return;const result=runtime.executePendingJobs();if(result.error){result.error.dispose();reportedError=true;}};
 function expose(name:string,fn:(...args:QuickJSHandle[])=>QuickJSHandle|void){ctx.newFunction(name,fn).consume(handle=>ctx.setProp(ctx.global,name,handle));}
 expose('__http',arg=>{
   if(++requests>90||inflight>=16)throw new Error('Provider request limit exceeded.');
   const config=JSON.parse(ctx.getString(arg)) as HttpConfig;const p=ctx.newPromise();pending.add(p);inflight++;
   void http(config,abort.signal).then(data=>{if(live)ctx.newString(JSON.stringify(data)).consume(v=>p.resolve(v));},error=>{if(live)ctx.newString(error instanceof Error?error.message:'Upstream request failed.').consume(v=>p.reject(v));}).finally(()=>{inflight--;if(live){pump();pending.delete(p);if(p.alive)p.dispose();}});
   return p.handle;
 });
 expose('__url',(value,base,search)=>{const u=new URL(ctx.getString(value),base&&ctx.typeof(base)==='string'?ctx.getString(base):undefined);if(search&&ctx.typeof(search)==='string')u.search=ctx.getString(search);return ctx.newString(JSON.stringify({href:u.href,origin:u.origin,hostname:u.hostname,host:u.host,pathname:u.pathname,protocol:u.protocol,port:u.port,search:u.search,hash:u.hash}));});
 expose('__base64',(v,mode)=>ctx.newString(ctx.getNumber(mode)===1?Buffer.from(ctx.getString(v),'binary').toString('base64'):Buffer.from(ctx.getString(v),'base64').toString('binary')));
 expose('__encode',v=>ctx.newString(JSON.stringify([...Buffer.from(ctx.getString(v),'utf8')])));
 expose('__decode',v=>ctx.newString(Buffer.from(JSON.parse(ctx.getString(v))).toString('utf8')));
 expose('__random',v=>ctx.newString(JSON.stringify([...randomBytes(Math.min(65536,Math.max(0,ctx.getNumber(v))))])));
 expose('__uuid',()=>ctx.newString(randomUUID()));
 expose('__digest',(algorithm,value)=>{const name=ctx.getString(algorithm).toLowerCase().replace(/-/g,'');if(!['sha1','sha256','sha384','sha512'].includes(name))throw new Error('Unsupported digest.');return ctx.newString(JSON.stringify([...createHash(name).update(Buffer.from(JSON.parse(ctx.getString(value)))).digest()]));});
 expose('__logError',()=>{reportedError=true;});
 expose('__timer',(fn,delay,...args)=>{if(timers.size>=100)throw new Error('Too many timers.');const id=nextTimer++,saved=fn.dup(),savedArgs=args.map(x=>x.dup());const timer=setTimeout(()=>{timers.delete(id);if(live){const result=ctx.callFunction(saved,ctx.undefined,...savedArgs);if(result.error){result.error.dispose();reportedError=true;}else result.value.dispose();saved.dispose();savedArgs.forEach(x=>x.dispose());pump();}},Math.min(30000,Math.max(0,ctx.getNumber(delay))));timers.set(id,{timer,fn:saved,args:savedArgs});return ctx.newNumber(id);});
 expose('__clearTimer',id=>{const t=timers.get(ctx.getNumber(id));if(t){clearTimeout(t.timer);t.fn.dispose();t.args.forEach(x=>x.dispose());timers.delete(ctx.getNumber(id));}});
 let waitTimer:ReturnType<typeof setTimeout>|undefined;let root:QuickJSHandle|undefined;
 try{
   const bundle=await readFile(new URL('./cheerio-sandbox.js',import.meta.url),'utf8');ctx.unwrapResult(ctx.evalCode(bundle,'cheerio.js')).dispose();
   const prelude=`
   globalThis.console={log(){},info(){},debug(){},warn(){},error(){__logError()}};
   globalThis.setTimeout=(fn,ms=0,...args)=>__timer(fn,ms,...args);globalThis.clearTimeout=__clearTimer;
   globalThis.atob=s=>__base64(String(s),0);globalThis.btoa=s=>__base64(String(s),1);
   globalThis.TextEncoder=class{encode(s=''){return new Uint8Array(JSON.parse(__encode(String(s))))}};
   globalThis.TextDecoder=class{decode(a){return __decode(JSON.stringify(Array.from(new Uint8Array(a?.buffer||a||[],a?.byteOffset||0,a?.byteLength))))}};
   globalThis.URLSearchParams=class{constructor(value=''){this.p=[];if(typeof value==='string'){for(const part of value.replace(/^\\?/,'').split('&'))if(part){const [a,...b]=part.split('=');this.p.push([decodeURIComponent(a.replace(/\\+/g,' ')),decodeURIComponent(b.join('=').replace(/\\+/g,' '))])}}else if(Array.isArray(value))this.p=value.map(p=>p.map(String));else this.p=Object.entries(value).map(([k,v])=>[k,String(v)])}set(k,v){this.delete(k);this.append(k,v)}get(k){return this.p.find(p=>p[0]===k)?.[1]??null}getAll(k){return this.p.filter(p=>p[0]===k).map(p=>p[1])}has(k){return this.p.some(p=>p[0]===k)}append(k,v){this.p.push([String(k),String(v)])}delete(k){this.p=this.p.filter(p=>p[0]!==k)}toString(){return this.p.map(p=>p.map(s=>encodeURIComponent(s).replace(/%20/g,'+')).join('=')).join('&')}[Symbol.iterator](){return this.p[Symbol.iterator]()}};
   globalThis.URL=class{constructor(value,base){this.u=JSON.parse(__url(String(value),base===undefined?undefined:String(base)));this.searchParams=new URLSearchParams(this.u.search)}get href(){return JSON.parse(__url(this.u.href,undefined,this.searchParams.toString())).href}get origin(){return this.u.origin}get hostname(){return this.u.hostname}get host(){return this.u.host}get pathname(){return this.u.pathname}get protocol(){return this.u.protocol}get search(){const s=this.searchParams.toString();return s?'?'+s:''}get hash(){return this.u.hash}toString(){return this.href}toJSON(){return this.href}};
   globalThis.AbortController=class{constructor(){this.signal={aborted:false,addEventListener(){},removeEventListener(){},throwIfAborted(){if(this.aborted)throw new Error('Aborted')}}}abort(){this.signal.aborted=true}};
   globalThis.crypto={randomUUID:__uuid,getRandomValues(a){a.set(JSON.parse(__random(a.byteLength)));return a},subtle:{async digest(name,a){return new Uint8Array(JSON.parse(__digest(typeof name==='string'?name:name.name,JSON.stringify(Array.from(new Uint8Array(a.buffer||a,a.byteOffset||0,a.byteLength)))))).buffer}}};
   globalThis.window=globalThis;globalThis.self=globalThis;globalThis.global=globalThis;globalThis.navigator={userAgent:'Mozilla/5.0 Luma/1.1'};globalThis.providerGlobal={};
   const kv=${JSON.stringify(job.kv)};
   const kvStore={async get(k){return Object.hasOwn(kv,k)?kv[k]:undefined},async set(k,v){if(['__proto__','constructor','prototype'].includes(k))throw new Error('Invalid storage key');if(JSON.stringify(v).length>32768)throw new Error('Value too large');kv[k]=v},async delete(k){const has=Object.hasOwn(kv,k);delete kv[k];return has},async keys(){return Object.keys(kv)},async clear(){for(const k of Object.keys(kv))delete kv[k]}};
   const request=async(config)=>{const res=JSON.parse(await __http(JSON.stringify(config)));if(res.data&&res.data.__binary)res.data=Uint8Array.from(atob(res.data.__binary),c=>c.charCodeAt(0)).buffer;return res};
   const makeAxios=(defaults={})=>{const ax=(url,config={})=>request(typeof url==='string'?{...defaults,...config,url}:{...defaults,...url});for(const m of ['get','head'])ax[m]=(url,config={})=>request({...defaults,...config,url,method:m});ax.post=(url,data,config={})=>request({...defaults,...config,url,data,method:'POST'});ax.request=c=>request({...defaults,...c});ax.create=c=>makeAxios({...defaults,...c});ax.isCancel=()=>false;ax.all=Promise.all.bind(Promise);ax.defaults=defaults;return ax};
   globalThis.fetch=async(url,config={})=>{const r=await request({url:String(url),method:config.method,headers:config.headers,data:config.body});return {ok:r.status>=200&&r.status<300,status:r.status,url:r.url,headers:{get:k=>r.headers[k.toLowerCase()]},async json(){return typeof r.data==='string'?JSON.parse(r.data):r.data},async text(){return typeof r.data==='string'?r.data:JSON.stringify(r.data)}}};
   const providerContext={axios:makeAxios(),cheerio:globalThis.__cheerio,commonHeaders:{'User-Agent':'Mozilla/5.0 Luma/1.1'},kvStore,async openWebView(){throw new Error('This provider requires an interactive WebView, which this backend does not support.')},async getCookies(){return {}}};
   const exports={};const module={exports};
   const require=name=>{throw new Error('External modules are not available: '+name)};
   `;
   ctx.unwrapResult(ctx.evalCode(prelude,'context.js')).dispose();
   ctx.unwrapResult(ctx.evalCode(job.code,'provider.js')).dispose();
   const operation=JSON.stringify(job.operation),params=JSON.stringify(job.params);
   root=ctx.unwrapResult(ctx.evalCode(`(async()=>{const target=module.exports[${operation}]??exports[${operation}];let data;if(typeof target==='function')data=await target({...${params},providerContext,signal:new AbortController().signal});else if(target!==undefined)data=target;else throw new Error('Provider does not export '+${operation});return JSON.stringify({data:data??null,kv})})()`,'invoke.js'));
   const resolvedPromise=ctx.resolvePromise(root);
   pump();
   const result=await Promise.race([resolvedPromise,new Promise<never>((_,reject)=>waitTimer=setTimeout(()=>reject(new Error('Provider execution timed out.')),Math.max(1,deadline-Date.now())))]);
   const resolved=ctx.unwrapResult(result);let output:JobResult;
   try{output={...JSON.parse(ctx.getString(resolved)),warnings:reportedError?['The provider reported errors; results may be incomplete.']:[]};}finally{resolved.dispose();}
   if(Buffer.byteLength(JSON.stringify(output))>2*1024*1024)throw new Error('Provider result is too large.');
   return output;
 }finally{
   live=false;abort.abort();if(waitTimer)clearTimeout(waitTimer);for(const item of timers.values()){clearTimeout(item.timer);item.fn.dispose();item.args.forEach(a=>a.dispose());}for(const p of pending)if(p.alive)p.dispose();root?.dispose();ctx.dispose();runtime.dispose();
 }
}
if(!isMainThread&&parentPort){execute(workerData as Job).then(result=>parentPort!.postMessage({ok:true,result}),error=>parentPort!.postMessage({ok:false,error:error instanceof Error?error.message:'Provider execution failed.'}));}
