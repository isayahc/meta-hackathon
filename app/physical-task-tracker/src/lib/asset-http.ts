/** Stream project-scoped immutable assets through the application, including video seeking. */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { assetInfo, readAsset } from './assets.js';
/** Parse one HTTP byte range; malformed, multiple and unsatisfiable ranges return null. */
export function byteRange(header:string,size:number):{start:number;end:number}|null{
  const m=/^bytes=(\d*)-(\d*)$/.exec(header);if(!m||(!m[1]&&!m[2])||size<=0)return null;
  let start:number,end:number;
  if(!m[1]){const suffix=Number(m[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)return null;start=Math.max(0,size-suffix);end=size-1;}
  else{start=Number(m[1]);end=m[2]?Math.min(Number(m[2]),size-1):size-1;}
  return Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=0&&start<size&&end>=start?{start,end}:null;
}
/** Respect backpressure while also releasing a cancelled client promptly. */
function waitForDrain(res:ServerResponse):Promise<void>{
  return new Promise((resolve,reject)=>{
    const clean=()=>{res.off('drain',drain);res.off('close',closed);res.off('error',failed);};
    const drain=()=>{clean();resolve();},closed=()=>{clean();reject(new Error('Media client disconnected.'));},failed=(error:Error)=>{clean();reject(error);};
    if(res.destroyed){reject(new Error('Media client disconnected.'));return;}
    res.once('drain',drain);res.once('close',closed);res.once('error',failed);
  });
}
/** Serve the exact stored object version; never reveal credentials or signed object URLs. */
export async function serveAsset(root:string,name:string,req:IncomingMessage,res:ServerResponse):Promise<void>{
  let source:Awaited<ReturnType<typeof readAsset>>|undefined;
  try{
    const asset=await assetInfo(root,name),etag=`"${asset.sha256}"`,headers=req.headers??{};
    const common={'Content-Type':asset.content_type,'X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes',ETag:etag,'Cache-Control':'private, no-cache'};
    if(headers['if-none-match']===etag){res.writeHead(304,common);res.end();return;}
    const requested=typeof headers.range==='string'&&(!headers['if-range']||headers['if-range']===etag)?headers.range:undefined;
    const range=requested?byteRange(requested,asset.size):undefined;
    if(requested&&!range){res.writeHead(416,{...common,'Content-Range':`bytes */${asset.size}`});res.end();return;}
    const responseHeaders={...common,'Content-Length':String(range?range.end-range.start+1:asset.size),...(range?{'Content-Range':`bytes ${range.start}-${range.end}/${asset.size}`}:{})};
    if(req.method==='HEAD'){res.writeHead(range?206:200,responseHeaders);res.end();return;}
    source=await readAsset(root,name,range??undefined);
    res.writeHead(range?206:200,responseHeaders);
    const close=()=>source?.close();res.once?.('close',close);
    try{for await(const chunk of source.stream){if(!res.write(chunk))await waitForDrain(res);}res.end();}finally{res.off?.('close',close);}
  }catch(error){
    if(res.headersSent){res.destroy(error as Error);return;}
    const e=error as NodeJS.ErrnoException&{$metadata?:{httpStatusCode?:number}};
    const missing=e.code==='ENOENT'||e.code==='ASSET_NOT_FOUND'||e.$metadata?.httpStatusCode===404;
    res.writeHead(missing?404:503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:missing?'Asset not found.':'Asset storage is unavailable.'}));
  }finally{source?.close();}
}
