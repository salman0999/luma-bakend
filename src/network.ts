import type {Readable} from 'node:stream';
import {lookup} from 'node:dns/promises';
import {gunzipSync,inflateSync,brotliDecompressSync} from 'node:zlib';
import {isIP} from 'node:net';
import ipaddr from 'ipaddr.js';
import {Agent,request} from 'undici';

export function publicIP(address:string):boolean {
 try {let parsed=ipaddr.parse(address);if(parsed.kind()==='ipv6'&&(parsed as ipaddr.IPv6).isIPv4MappedAddress())parsed=(parsed as ipaddr.IPv6).toIPv4Address();return parsed.range()==='unicast';}catch{return false;}
}
export function publicURL(value:string):URL {
 const url=new URL(value);
 const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||value.length>12000)throw new Error('Only HTTP/HTTPS URLs without embedded credentials are allowed.');
 if(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal')||host.endsWith('.test')||(isIP(host)&&!publicIP(host)))throw new Error('Private and local network destinations are not allowed for providers.');
 return url;
}
const dispatcher=new Agent({connect:{lookup(hostname,options,callback){
 void lookup(hostname,{all:true,verbatim:true}).then(entries=>{
   if(!entries.length||entries.some(entry=>!publicIP(entry.address)))throw new Error('Provider hostname resolved to a private or reserved address.');
   if(options.all)callback(null,entries);else callback(null,entries[0].address,entries[0].family);
 }).catch(error=>callback(error,null as never,0));
}}});
export type HttpConfig={url:string;method?:string;headers?:Record<string,string>;data?:unknown;params?:Record<string,unknown>;timeout?:number;responseType?:string};
export type HttpResult={data:unknown;status:number;headers:Record<string,string>;url:string};
export async function safeRequest(config:HttpConfig,signal?:AbortSignal):Promise<HttpResult> {
 let url=publicURL(config.url);if(config.params)for(const [k,v] of Object.entries(config.params)){if(v!==undefined&&v!==null)url.searchParams.append(k,String(v));}
 let method=(config.method||'GET').toUpperCase();
 if(!['GET','POST','HEAD'].includes(method))throw new Error('This HTTP method is not available to providers.');
 let headers:Record<string,string>={'User-Agent':'Mozilla/5.0 Luma/1.1','Accept':'*/*'};
 for(const [k,v] of Object.entries(config.headers||{}))if(/^[a-zA-Z0-9-]{1,60}$/.test(k)&&!/[\r\n]/.test(String(v))&&!/^(host|connection|content-length|proxy-.*|transfer-encoding)$/i.test(k)&&String(v).length<8192)headers[k]=String(v);
 let body:undefined|string;
 if(config.data!==undefined&&method==='POST'){body=typeof config.data==='string'?config.data:JSON.stringify(config.data);if(Buffer.byteLength(body)>1024*1024)throw new Error('Provider request body is too large.');if(!Object.keys(headers).some(k=>k.toLowerCase()==='content-type'))headers['Content-Type']='application/json';}
 const abort=AbortSignal.any([AbortSignal.timeout(Math.min(Math.max(config.timeout||12000,100),20000)),...(signal?[signal]:[])]);
 for(let redirect=0;redirect<=4;redirect++){
   publicURL(url.href);
   const response=await request(url,{method:method as 'GET'|'POST'|'HEAD',headers,body,dispatcher,signal:abort,headersTimeout:15000,bodyTimeout:15000});
   const location=response.headers.location;
   if([301,302,303,307,308].includes(response.statusCode)&&location){discardResponse(response.body);const next=publicURL(new URL(String(location),url).href);if(next.origin!==url.origin){headers=Object.fromEntries(Object.entries(headers).filter(([key])=>!['authorization','cookie','proxy-authorization'].includes(key.toLowerCase())));}if(response.statusCode===303||([301,302].includes(response.statusCode)&&method==='POST')){method='GET';body=undefined;}url=next;continue;}
   if(response.statusCode>=400){discardResponse(response.body);throw new Error(`Upstream returned HTTP ${response.statusCode}.`);}
   let size=0;const chunks:Buffer[]=[];
   for await(const chunk of response.body){size+=chunk.length;if(size>3*1024*1024){discardResponse(response.body);throw new Error('Provider response exceeded the 3 MB limit.');}chunks.push(Buffer.from(chunk));}
   let bytes=Buffer.concat(chunks);const encoding=String(response.headers['content-encoding']||'').toLowerCase();if(encoding==='gzip')bytes=gunzipSync(bytes,{maxOutputLength:3*1024*1024});else if(encoding==='deflate')bytes=inflateSync(bytes,{maxOutputLength:3*1024*1024});else if(encoding==='br')bytes=brotliDecompressSync(bytes,{maxOutputLength:3*1024*1024});let data:unknown=bytes.toString('utf8');
   if(config.responseType==='arraybuffer')data={__binary:bytes.toString('base64')};
   else if(config.responseType!=='text'){try{data=JSON.parse(data as string);}catch{}}
   const resultHeaders:Record<string,string>={};for(const [key,v] of Object.entries(response.headers))if(v!==undefined)resultHeaders[key]=Array.isArray(v)?v.join(', '):String(v);
   return {data,status:response.statusCode,headers:resultHeaders,url:url.href};
 }
 throw new Error('Too many redirects from provider.');
}

// Undici emits an abort error when an unread response is destroyed. Consume that
// expected cancellation so redirects/errors cannot crash the server process.
export function discardResponse(body:Readable){body.on('error',()=>{});body.destroy();}
