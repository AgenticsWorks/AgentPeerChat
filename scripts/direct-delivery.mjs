// Direct delivery accelerates a mailbox-committed message; it never creates another message.
import {createServer} from 'node:http';
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {join} from 'node:path';
import {readState,writeState} from './native-runtime.mjs';
export async function deliverDirect(items,{fetchImpl=fetch}={}){
 if(!Array.isArray(items))return;
 await Promise.allSettled(items.slice(0,31).map(async hint=>{
  const url=new URL(hint.endpoint);
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/agentpeerchat/direct'||url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))return;
  if(typeof hint.payload!=='string'||Buffer.byteLength(hint.payload)>65536||!/^([a-f0-9]{64})$/.test(hint.signature))return;
  await fetchImpl(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(2000),headers:{'Content-Type':'application/json','X-AgentPeerChat-Signature':hint.signature},body:hint.payload});
 }));
}
export async function startDirect({identity,root,env=process.env,onWork,request}){
 const endpoint=env.AGENTPEERCHAT_DIRECT_URL;if(!endpoint)return {available:false,reason:'No reachable direct endpoint supplied; outbound WebSocket and durable mailbox remain active.',close:async()=>{}};
 const url=new URL(endpoint);if(url.pathname!=='/agentpeerchat/direct')throw Error('Direct endpoint path must be /agentpeerchat/direct.');
 const port=Number(env.AGENTPEERCHAT_DIRECT_PORT||((url.hostname==='127.0.0.1'||url.hostname==='localhost')?url.port:0));
 if(!Number.isInteger(port)||port<1||port>65535)throw Error('Set AGENTPEERCHAT_DIRECT_PORT to the local receiver port behind your HTTPS endpoint.');
 const keyPath=join(root,'direct-key.json');let saved=await readState(keyPath);
 if(!saved||saved.url!==identity.url||saved.principal_id!==identity.principal_id){saved={url:identity.url,principal_id:identity.principal_id,key:randomBytes(32).toString('hex')};await writeState(keyPath,saved);}
 const seen=new Map();let registration=false;
 const server=createServer(async(req,res)=>{
  try{
   if(req.method!=='POST'||req.url!=='/agentpeerchat/direct'){res.writeHead(404).end();return;}
   req.setTimeout(3000,()=>req.destroy());let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>65536){res.writeHead(413).end();return;}}
   const signature=req.headers['x-agentpeerchat-signature'];
   const expected=createHmac('sha256',saved.key).update(raw).digest();
   if(typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature)||!timingSafeEqual(expected,Buffer.from(signature,'hex'))){res.writeHead(403).end();return;}
   const data=JSON.parse(raw);
   if(data.recipient_id!==identity.principal_id||!Number.isSafeInteger(data.expires_at)||data.expires_at<Date.now()||data.expires_at>Date.now()+90000||!/^msg_[A-Za-z0-9_]+$/.test(data.message?.id||'')){res.writeHead(403).end();return;}
   // The mailbox remains authoritative. Direct bodies never bypass membership/ACK or execute as prompts.
   if(!seen.has(data.message.id)){seen.set(data.message.id,Date.now());if(seen.size>2048)seen.delete(seen.keys().next().value);void onWork().catch(()=>{});}
   res.writeHead(202).end();
  }catch{if(!res.headersSent)res.writeHead(400);res.end();}
 });
 server.headersTimeout=5000;server.requestTimeout=5000;server.maxConnections=32;
 await new Promise((ok,fail)=>{server.once('error',fail);server.listen(port,env.AGENTPEERCHAT_DIRECT_BIND||'127.0.0.1',ok);});
 const register=async()=>{await request(identity.url.replace(/\/$/,'')+'/api/v1/receiver/direct',{token:identity.token,method:'POST',body:{endpoint,signing_key:saved.key}});registration=true;};
 try{await register();}catch{/* An unavailable acceleration path must not disable durable receiving. */}
 const timer=setInterval(()=>void register().catch(()=>{registration=false;}),60000);
 let closed=false;
 return {get available(){return registration;},endpoint,close:async()=>{if(closed)return;closed=true;clearInterval(timer);server.closeAllConnections();await new Promise(r=>server.close(r));await request(identity.url.replace(/\/$/,'')+'/api/v1/receiver/direct',{token:identity.token,method:'DELETE',body:{signing_key:saved.key}}).catch(()=>{});}};
}
