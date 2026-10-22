import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {ApiError,ProviderService} from './core.js';

const text=(v:unknown,name:string,max=12000)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw new ApiError(400,`Invalid ${name}.`);return v;};
export async function createBackend(options:{directory:string;token:string;appToken?:string;service?:ProviderService;origins?:string[]}){
 if(options.token.length<32)throw new Error('Use an API token with at least 32 characters.');
 if(options.appToken&&(options.appToken.length<32||options.appToken===options.token))throw new Error('Use a separate app token of at least 32 characters.');
 const service=options.service||new ProviderService(options.directory);await service.init();
 const origins=new Set(options.origins||['https://appassets.androidplatform.net','http://127.0.0.1:4173','http://localhost:4173']);
 let appWindow=Date.now(),appRequests=0;
 const server=createServer(async(req:IncomingMessage,res:ServerResponse)=>{
   const send=(code:number,data:unknown)=>{if(res.destroyed||res.writableEnded)return;const body=JSON.stringify(data);res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(body);};
   try{
     const origin=req.headers.origin;if(origin&&!origins.has(origin))throw new ApiError(403,'This browser origin is not allowed.');if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
     if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,DELETE,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Authorization,Content-Type');res.setHeader('Access-Control-Max-Age','600');res.writeHead(204);res.end();return;}
     const url=new URL(req.url||'/','http://backend.local');const segments=url.pathname.split('/').filter(Boolean).map(decodeURIComponent);if(req.method==='GET'&&url.pathname==='/health'){send(200,{ok:true,name:'Luma Provider Backend',version:'1.2.0'});return;}
     const provided=req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):'';
     const matches=(token:string)=>Buffer.byteLength(provided)===Buffer.byteLength(token)&&timingSafeEqual(Buffer.from(provided),Buffer.from(token));
     const admin=matches(options.token),app=!!options.appToken&&matches(options.appToken);
     if(!admin&&!app)throw new ApiError(401,'Backend token is missing or incorrect.');
     if(!admin){
       if(Date.now()-appWindow>=60000){appWindow=Date.now();appRequests=0;}
       if(++appRequests>120)throw new ApiError(429,'Too many requests. Try again in a moment.');
       const readable=(req.method==='GET'&&(url.pathname==='/api/status'||/^\/api\/providers\/[A-Za-z0-9_.-]+\/catalog$/.test(url.pathname)))||(req.method==='POST'&&(url.pathname==='/api/search'||/^\/api\/providers\/[A-Za-z0-9_.-]+\/(posts|meta|episodes|streams)$/.test(url.pathname)));
       if(!readable)throw new ApiError(403,'This app connection can browse and play. Provider administration requires your private API token.');
     }
     if(segments[0]!=='api')throw new ApiError(404,'Endpoint not found.');
     let body:Record<string,unknown>={};
     if(['POST','PATCH'].includes(req.method||'')){if(!req.headers['content-type']?.startsWith('application/json'))throw new ApiError(415,'Send application/json.');let size=0;const chunks:Buffer[]=[];for await(const chunk of req){size+=chunk.length;if(size>64000)throw new ApiError(413,'Request body is too large.');chunks.push(Buffer.from(chunk));}try{const parsed=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error();body=parsed;}catch{throw new ApiError(400,'Invalid JSON request body.');}}
     const [_,area,id,action]=segments;
     if(req.method==='GET'&&area==='status'){send(200,{ok:true,version:'1.2.0',...service.list()});return;}
     if(area==='sources'){
       if(req.method==='POST'&&!id){const source=await service.addSource(text(body.url,'repository URL',500));send(201,{source});return;}
       if(req.method==='GET'&&id&&action==='manifest'){send(200,{source:service.source(id)});return;}
     }
     if(area==='plugins'){
       if(req.method==='POST'&&id==='install'){send(201,await service.install(text(body.sourceId,'source ID',100),text(body.value,'provider ID',100)));return;}
       if(req.method==='PATCH'&&id){send(200,await service.update(id,body));return;}
       if(req.method==='DELETE'&&id){send(200,await service.uninstall(id));return;}
     }
     if(req.method==='POST'&&area==='search'){const query=text(body.query,'search query',200);let ids:string[]|undefined;if(body.providerIds!==undefined){if(!Array.isArray(body.providerIds)||body.providerIds.length>12||body.providerIds.some(id=>typeof id!=='string'))throw new ApiError(400,'Invalid provider selection.');ids=body.providerIds;}send(200,await service.search(query,ids));return;}
     if(area==='providers'&&id){
       if(req.method==='GET'&&action==='catalog'){send(200,await service.catalog(id));return;}
       if(req.method==='GET'&&action==='settings'){const schema=await service.invoke(id,'getSettingsSchema');const fields=Array.isArray(schema.data)?schema.data.slice(0,60).filter(f=>f&&typeof f.key==='string'&&!['__proto__','constructor','prototype'].includes(f.key)&&['text','number','toggle','select','multiselect'].includes(f.type)):[];send(200,{fields,values:service.plugin(id).kv,warnings:schema.warnings});return;}
       if(req.method==='POST'&&action==='posts'){send(200,await service.posts(id,text(body.filter,'catalog filter',2000),Math.max(1,Math.min(100,Number(body.page)||1))));return;}
       if(req.method==='POST'&&action==='meta'){send(200,await service.meta(id,text(body.link,'item link')));return;}
       if(req.method==='POST'&&action==='episodes'){send(200,await service.episodes(id,text(body.url,'episode link')));return;}
       if(req.method==='POST'&&action==='streams'){send(200,await service.streams(id,text(body.link,'item link'),text(body.type||'movie','media type',40),body.refresh===true));return;}
     }
     throw new ApiError(404,'Endpoint not found.');
   }catch(error){const status=error instanceof ApiError?error.status:502;send(status,{error:error instanceof Error?error.message:'Backend request failed.'});}
 });
 server.requestTimeout=60000;server.headersTimeout=15000;server.maxHeadersCount=50;
 return {server,service};
}
export async function start(){const directory=path.resolve(process.env.LUMA_DATA_DIR||'data');await mkdir(directory,{recursive:true});let token=process.env.LUMA_API_TOKEN;const keyPath=path.join(directory,'auth-token');if(!token){try{token=(await readFile(keyPath,'utf8')).trim();}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;token=randomBytes(32).toString('hex');await writeFile(keyPath,token+'\n',{mode:0o600,flag:'wx'});}}
 const {server}=await createBackend({directory,token,appToken:process.env.LUMA_APP_TOKEN,origins:process.env.LUMA_ALLOWED_ORIGINS?.split(',').map(x=>x.trim()).filter(Boolean)});
 const host=process.env.LUMA_HOST||'127.0.0.1',port=Number(process.env.LUMA_PORT||process.env.PORT||4317);if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid backend port.');await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>resolve());});
 const address=server.address();console.log(`Luma backend 1.2 listening on ${host}:${typeof address==='object'&&address?address.port:port}. Run npm run pair in another terminal for phone connection details.`);
 for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>server.close(()=>process.exit(0)));
 return server;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)start().catch(e=>{console.error(e.message);process.exitCode=1;});
