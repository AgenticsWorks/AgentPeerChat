// Direct delivery accelerates a mailbox-committed message; it never creates another message.
import {createServer} from 'node:http';
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {join} from 'node:path';
import {startQuickTunnel} from './cloudflare-tunnel.mjs';
import {writeState} from './native-runtime.mjs';
export async function deliverDirect(items,{fetchImpl=fetch}={}){
 if(!Array.isArray(items))return;
 await Promise.allSettled(items.slice(0,31).map(async hint=>{
  const url=new URL(hint.endpoint);
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/agentpeerchat/direct'||url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))return;
  if(typeof hint.payload!=='string'||Buffer.byteLength(hint.payload)>65536||!/^([a-f0-9]{64})$/.test(hint.signature))return;
  await fetchImpl(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(2000),headers:{'Content-Type':'application/json','X-AgentPeerChat-Signature':hint.signature},body:hint.payload});
 }));
}
export async function startDirect({identity,root,env=process.env,onWork,request,signal,fetchImpl=fetch,tunnelFactory=startQuickTunnel}){
 const manual=env.AGENTPEERCHAT_DIRECT_URL,configured=Boolean(manual)||env.AGENTPEERCHAT_TUNNEL!=='off';
 if(!configured||signal?.aborted)return {configured,available:false,state:'disabled',close:async()=>{}};
 const url=manual?new URL(manual):null;
 if(url&&(url.username||url.password||url.search||url.hash||url.pathname!=='/agentpeerchat/direct'||url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))))throw Error('Use an HTTPS /agentpeerchat/direct endpoint.');
 const port=Number(env.AGENTPEERCHAT_DIRECT_PORT||(url&&['127.0.0.1','localhost'].includes(url.hostname)?url.port:0));
 if(!Number.isInteger(port)||port<0||port>65535||manual&&port===0)throw Error('Invalid local direct receiver port.');
 // A receiver incarnation has its own key, so a stale host cannot remove its successor.
 const key=randomBytes(32).toString('hex');await writeState(join(root,'direct-key.json'),{url:identity.url,principal_id:identity.principal_id,key});
 const seen=new Map(),probe=randomBytes(24).toString('hex'),healthPath='/agentpeerchat/health/'+probe;
 let registration=false,endpoint=manual||null,timer,closed=false,serial=Promise.resolve(),tunnel,closing;
 const controller=new AbortController(),abort=()=>{void close();};
 const status=()=>({configured,mode:manual?'endpoint':'cloudflare-tunnel',available:registration,state:closed?'stopped':registration?'ready':manual?'retrying':tunnel?.state||'starting',endpoint:registration?endpoint:null});
 const publish=()=>writeState(join(root,'direct-state.json'),status()).catch(()=>{});
 const server=createServer(async(req,res)=>{
  try{
   if(req.method==='GET'&&req.url===healthPath){res.writeHead(200,{'Content-Type':'text/plain','Cache-Control':'no-store'}).end(probe);return;}
   if(req.method!=='POST'||req.url!=='/agentpeerchat/direct'){res.writeHead(404).end();return;}
   req.setTimeout(3000,()=>req.destroy());let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>65536){res.writeHead(413).end();return;}}
   const signature=req.headers['x-agentpeerchat-signature'];
   const expected=createHmac('sha256',key).update(raw).digest();
   if(typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature)||!timingSafeEqual(expected,Buffer.from(signature,'hex'))){res.writeHead(403).end();return;}
   const data=JSON.parse(raw);
   if(data.recipient_id!==identity.principal_id||!Number.isSafeInteger(data.expires_at)||data.expires_at<Date.now()||data.expires_at>Date.now()+90000||!/^msg_[A-Za-z0-9_]+$/.test(data.message?.id||'')){res.writeHead(403).end();return;}
   // Direct bodies never execute prompts. Membership and ACK come from the mailbox.
   if(!seen.has(data.message.id)){seen.set(data.message.id,Date.now());if(seen.size>2048)seen.delete(seen.keys().next().value);void Promise.resolve().then(onWork).catch(()=>{seen.delete(data.message.id);});}
   res.writeHead(202).end();
  }catch{if(!res.headersSent)res.writeHead(400);res.end();}
 });
 server.headersTimeout=5000;server.requestTimeout=5000;server.maxConnections=32;
 await new Promise((ok,fail)=>{server.once('error',fail);server.listen(port,env.AGENTPEERCHAT_DIRECT_BIND||'127.0.0.1',ok);});
 const api=identity.url.replace(/\/$/,'')+'/api/v1/receiver/direct';
 const enqueue=fn=>{const next=serial.then(fn);serial=next.catch(()=>{});return next;};
 const unregister=()=>enqueue(async()=>{
  clearTimeout(timer);registration=false;await publish();
  if(endpoint)await request(api,{token:identity.token,method:'DELETE',signal:AbortSignal.timeout(3000),body:{endpoint,signing_key:key}}).catch(()=>{});
  endpoint=null;
 });
 const register=(attemptSignal)=>enqueue(async()=>{
  clearTimeout(timer);if(closed||!endpoint||attemptSignal?.aborted)return;
  const target=endpoint;
  try{
   const result=await request(api,{token:identity.token,method:'POST',signal:attemptSignal?AbortSignal.any([controller.signal,attemptSignal]):controller.signal,body:{endpoint:target,signing_key:key}});
   if(closed)return;if(result?.registered!==true)throw Error('Instance did not register the direct endpoint.');registration=true;
   const seconds=Number(result?.expires_in)||180;
   timer=setTimeout(()=>void register().catch(()=>{}),Math.max(10000,Math.min(600000,seconds*1000/3)));
  }catch(error){registration=false;if(!closed)timer=setTimeout(()=>void register().catch(()=>{}),30000);throw error;}
  finally{await publish();}
 });
 const verify=async(base,attemptSignal)=>{
  for(let n=0;n<8;n++){
   const combined=AbortSignal.any([controller.signal,attemptSignal,AbortSignal.timeout(2500)]);
   try{const res=await fetchImpl(base+healthPath,{redirect:'error',signal:combined});if(res.ok&&await res.text()===probe){attemptSignal.throwIfAborted();controller.signal.throwIfAborted();endpoint=base+'/agentpeerchat/direct';await register(attemptSignal);attemptSignal.throwIfAborted();return;}}catch{}
   controller.signal.throwIfAborted();attemptSignal.throwIfAborted();
   await new Promise(r=>{const t=setTimeout(done,500);function done(){clearTimeout(t);controller.signal.removeEventListener('abort',done);attemptSignal.removeEventListener('abort',done);r();}controller.signal.addEventListener('abort',done,{once:true});attemptSignal.addEventListener('abort',done,{once:true});});
  }
  throw Error('Tunnel did not reach the signed receiver.');
 };
 function close(){
  if(closing)return closing;closed=true;controller.abort();clearTimeout(timer);signal?.removeEventListener('abort',abort);
  closing=(async()=>{await tunnel?.close();await unregister();server.closeAllConnections();await new Promise(r=>server.close(r));await publish();})();return closing;
 }
 if(manual)await register().catch(()=>{});
 else tunnel=tunnelFactory({origin:'http://127.0.0.1:'+server.address().port,root,env,signal:controller.signal,onReady:verify,onUnavailable:unregister});
 signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)await close();await publish();
 return {configured,get available(){return registration;},get endpoint(){return endpoint;},get state(){return status().state;},get status(){return status();},close};
}
