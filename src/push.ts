import {buildPushPayload} from '@block65/webcrypto-web-push';
import type {Env} from './types';
import {body,fail,hash} from './security';
import {validBrowserKey} from './realtime';
const encode=(data:Uint8Array)=>btoa(String.fromCharCode(...data)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
export function pushEndpoint(value:unknown):string {
 if(typeof value!=='string'||value.length>2048)fail(400,'invalid_subscription','Invalid push subscription.');
 let url:URL;try{url=new URL(value);}catch{fail(400,'invalid_subscription','Invalid push subscription.');}
 const host=url.hostname;
 if(url.protocol!=='https:'||url.port&&url.port!=='443'||url.username||url.password||url.hash||!(host==='fcm.googleapis.com'||host==='web.push.apple.com'||host.endsWith('.push.apple.com')||host==='updates.push.services.mozilla.com'||host.endsWith('.push.services.mozilla.com')||host.endsWith('.notify.windows.com')))fail(400,'invalid_subscription','Use a supported browser push service.');
 return url.href;
}
function key(value:unknown,length:number){
 if(typeof value!=='string'||!/^[A-Za-z0-9_-]+={0,2}$/.test(value))fail(400,'invalid_subscription','Invalid push encryption key.');
 try{const bytes=Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));if(bytes.length!==length||length===65&&bytes[0]!==4)throw Error();return value;}catch{fail(400,'invalid_subscription','Invalid push encryption key.');}
}
async function configuration(env:Env){
 let config=await env.DB.prepare('SELECT public_key,private_key FROM push_configuration WHERE id=1').first<{public_key:string;private_key:string}>();
 if(!config){const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);if(!('publicKey' in pair))throw Error('Key generation failed');const publicJwk=await crypto.subtle.exportKey('jwk',pair.publicKey),privateJwk=await crypto.subtle.exportKey('jwk',pair.privateKey);if(!('x' in publicJwk)||!('d' in privateJwk)||!publicJwk.x||!publicJwk.y||!privateJwk.d)throw Error('Key export failed');const raw=Uint8Array.from(atob(publicJwk.x.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));const rawY=Uint8Array.from(atob(publicJwk.y.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));const publicKey=encode(Uint8Array.from([4,...raw,...rawY])),priv=privateJwk.d;
  await env.DB.prepare('INSERT OR IGNORE INTO push_configuration(id,public_key,private_key) VALUES(1,?,?)').bind(publicKey,priv).run();config=await env.DB.prepare('SELECT public_key,private_key FROM push_configuration WHERE id=1').first();}
 return config!;
}
export async function pushRoutes(request:Request,env:Env,path:string,principal:string,token:string){
 if(path==='/push/key'&&request.method==='GET')return Response.json({public_key:(await configuration(env)).public_key},{headers:{'Cache-Control':'no-store'}});
 if(path!=='/push/subscriptions')fail(404,'not_found','Push endpoint not found.');
 const b=await body(request),endpoint=pushEndpoint(b.endpoint),digest=await hash(endpoint);
 if(request.method==='DELETE'){await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint_hash=? AND principal_id=?').bind(digest,principal).run();return Response.json({ok:true});}
 if(request.method!=='POST')fail(405,'method_not_allowed','Use POST or DELETE.');
 const keys=b.keys as {p256dh?:unknown;auth?:unknown}|undefined,p256dh=key(keys?.p256dh,65),auth=key(keys?.auth,16);
 // Validate the point before storing it, not during a future delivery.
 try{await crypto.subtle.importKey('raw',Uint8Array.from(atob(p256dh.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0)),{name:'ECDH',namedCurve:'P-256'},false,[]);}catch{fail(400,'invalid_subscription','Invalid push encryption key.');}
 await configuration(env);
 const existing=await env.DB.prepare('SELECT principal_id FROM push_subscriptions WHERE endpoint_hash=?').bind(digest).first<{principal_id:string}>();
 if(existing&&existing.principal_id!==principal)fail(409,'subscription_conflict','This browser subscription belongs to another identity.');
 const result=await env.DB.prepare(`INSERT INTO push_subscriptions(endpoint_hash,principal_id,token_id,endpoint,p256dh,auth,language,updated_at)
 SELECT ?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM push_subscriptions WHERE principal_id=?)<16 OR EXISTS(SELECT 1 FROM push_subscriptions WHERE endpoint_hash=?)
 ON CONFLICT(endpoint_hash) DO UPDATE SET token_id=excluded.token_id,p256dh=excluded.p256dh,auth=excluded.auth,language=excluded.language,updated_at=excluded.updated_at WHERE push_subscriptions.principal_id=excluded.principal_id`)
 .bind(digest,principal,token,endpoint,p256dh,auth,b.language==='zh'?'zh':'en',new Date().toISOString(),principal,digest).run();
 if(!result.meta.changes)fail(409,'subscription_limit','Remove an old notification subscription before adding another.');
 return Response.json({ok:true},{status:201,headers:{'Cache-Control':'no-store'}});
}
export async function notifyPush(env:Env,recipients:string[],thread:string,origin:string,send:typeof fetch=fetch){
 if(!recipients.length)return;
 const {results}=await env.DB.prepare(`SELECT s.* FROM push_subscriptions s JOIN tokens t ON t.id=s.token_id JOIN principals p ON p.id=s.principal_id
 WHERE s.principal_id IN (${recipients.map(()=>'?').join(',')}) AND p.active=1 AND p.kind IN ('owner','human') AND t.revoked_at IS NULL ORDER BY s.updated_at DESC LIMIT 64`).bind(...recipients).all<{endpoint_hash:string;principal_id:string;token_id:string;endpoint:string;p256dh:string;auth:string;language:string}>();
 if(!results.length)return;const config=await configuration(env);let next=0;
 await Promise.all(Array.from({length:Math.min(8,results.length)},async()=>{while(next<results.length){const row=results[next++];try{
  if(!await validBrowserKey(env,row.principal_id,row.token_id)){await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint_hash=?').bind(row.endpoint_hash).run();continue;}
  const endpoint=pushEndpoint(row.endpoint),payload=await buildPushPayload({data:JSON.stringify({thread_id:thread,language:row.language}),options:{ttl:3600}},{endpoint,expirationTime:null,keys:{p256dh:row.p256dh,auth:row.auth}},{subject:origin,publicKey:config.public_key,privateKey:config.private_key});
  const response=await send(endpoint,{...payload,redirect:'error',signal:AbortSignal.timeout(3000)});
  if(response.status===404||response.status===410)await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint_hash=?').bind(row.endpoint_hash).run();
  else if(!response.ok)console.warn(JSON.stringify({code:'browser_push_deferred'}));
 }catch{console.warn(JSON.stringify({code:'browser_push_deferred'}));}}}));
}
