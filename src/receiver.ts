import type {Env,Principal,Message} from './types';
import {body,fail,str,secret} from './security';
const json=(data:unknown)=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
export async function receiverRoutes(request:Request,env:Env,path:string,p:Principal){
 if(!['/receiver/lease','/receiver/direct'].includes(path))return null;
 if(p.kind!=='agent')fail(403,'agent_required','Use an Agent identity.');
 if(path==='/receiver/lease'){
  const b=await body(request),holder=str(b.holder,'holder',80);
  if(!/^[A-Za-z0-9_-]{16,80}$/.test(holder))fail(400,'invalid_holder','Invalid receiver holder.');
  if(request.method==='DELETE'){
   await env.DB.prepare('DELETE FROM receiver_leases WHERE principal_id = ? AND holder = ? AND fence = ?').bind(p.id,holder,str(b.fence,'fence',100)).run();return json({released:true});
  }
  if(request.method!=='POST')fail(405,'method_not_allowed','Use POST or DELETE.');
  const now=Date.now();
  const row=await env.DB.prepare(`INSERT INTO receiver_leases(principal_id,holder,fence,expires_at) VALUES (?,?,?,?)
    ON CONFLICT(principal_id) DO UPDATE SET holder=excluded.holder,
    fence=CASE WHEN receiver_leases.holder=excluded.holder AND receiver_leases.expires_at>? THEN receiver_leases.fence ELSE excluded.fence END,
    expires_at=excluded.expires_at WHERE receiver_leases.expires_at<=? OR receiver_leases.holder=excluded.holder RETURNING fence,expires_at`)
    .bind(p.id,holder,secret('rcv'),now+90000,now,now).first();
  return json(row?{acquired:true,...row}:{acquired:false});
 }
 if(request.method==='DELETE'){const b=await body(request);await env.DB.prepare('DELETE FROM direct_receivers WHERE principal_id=? AND signing_key=? AND (? IS NULL OR endpoint=?)').bind(p.id,str(b.signing_key,'signing_key',128),b.endpoint===undefined?null:str(b.endpoint,'endpoint',2048),b.endpoint===undefined?null:str(b.endpoint,'endpoint',2048)).run();return json({removed:true});}
 if(request.method!=='POST')fail(405,'method_not_allowed','Use POST or DELETE.');
 const b=await body(request),endpoint=str(b.endpoint,'endpoint',2048);let url:URL;
 try{url=new URL(endpoint);}catch{fail(400,'invalid_endpoint','Use an absolute HTTPS receiver endpoint.');}
 if(url.username||url.password||url.search||url.hash||url.pathname!=='/agentpeerchat/direct'||url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&['localhost','127.0.0.1','[::1]'].includes(new URL(request.url).hostname)))fail(400,'invalid_endpoint','Use an HTTPS /agentpeerchat/direct endpoint, or loopback HTTP for local development.');
 const key=str(b.signing_key,'signing_key',128);if(!/^[a-f0-9]{64}$/.test(key))fail(400,'invalid_key','Use a random 256-bit receiver signing key.');
 await env.DB.prepare(`INSERT INTO direct_receivers(principal_id,endpoint,signing_key,expires_at) VALUES (?,?,?,?)
  ON CONFLICT(principal_id) DO UPDATE SET endpoint=excluded.endpoint,signing_key=excluded.signing_key,expires_at=excluded.expires_at`).bind(p.id,endpoint,key,Date.now()+1800000).run();
 return json({registered:true,expires_in:1800});
}
export async function checkReceiverFence(request:Request,env:Env,p:Principal){
 const fence=request.headers.get('X-AgentPeerChat-Receiver');if(!fence)return;
 if(!await env.DB.prepare('SELECT 1 FROM receiver_leases WHERE principal_id=? AND fence=? AND expires_at>?').bind(p.id,fence,Date.now()).first())fail(409,'receiver_lease_lost','This receiver no longer owns the processing lease.');
}
export async function directHints(env:Env,message:Message,recipients:string[]){
 if(!recipients.length)return [];
 const rows=await env.DB.prepare(`SELECT principal_id,endpoint,signing_key FROM direct_receivers WHERE expires_at>? AND principal_id IN (${recipients.map(()=>'?').join(',')})`).bind(Date.now(),...recipients).all<{principal_id:string;endpoint:string;signing_key:string}>();
 const expires=Date.now()+60000;
 return Promise.all(rows.results.map(async row=>{
  const payload={recipient_id:row.principal_id,expires_at:expires,message};const encoded=JSON.stringify(payload);
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(row.signing_key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(encoded)))).map(v=>v.toString(16).padStart(2,'0')).join('');
  return {endpoint:row.endpoint,payload:encoded,signature};
 }));
}
