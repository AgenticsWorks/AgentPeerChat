// A DSH-native mailbox channel. The host owns the model loop and durable Session.
import {readFile,mkdir,rename,rm,open,stat} from 'node:fs/promises';
import {dirname,isAbsolute,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {requestJSON} from '../../scripts/client-transport.mjs';
import {receiveNotifications} from '../../scripts/realtime-client.mjs';
import {startDirect} from '../../scripts/direct-delivery.mjs';
const digest=value=>createHash('sha256').update(value).digest('hex');
export const NO_REPLY='[agentpeerchat:no-reply]';
export async function savePrivate(path,value){
 await mkdir(dirname(path),{recursive:true,mode:0o700});const temporary=path+'.'+randomUUID()+'.tmp';
 let file;
 try{
  file=await open(temporary,'wx',0o600);await file.writeFile(JSON.stringify(value,null,2)+'\n');await file.sync();await file.close();file=null;
  await rename(temporary,path);
  if(process.platform!=='win32'){const directory=await open(dirname(path),'r');try{await directory.sync();}finally{await directory.close();}}
 }finally{await file?.close();await rm(temporary,{force:true});}
}
export async function loadIdentity(path){
 if(!isAbsolute(path||''))throw Error('Configure an absolute private AgentPeerChat profile path.');
 const info=await stat(path);if(info.mode&0o077)throw Error('The AgentPeerChat identity file must be private (chmod 600).');
 if(process.getuid&&info.uid!==process.getuid())throw Error('The identity must belong to the DSH OS user.');
 const identity=JSON.parse(await readFile(path,'utf8')),url=new URL(identity.url);
 if(!/^agt_[A-Za-z0-9_]+$/.test(identity.principal_id||'')||typeof identity.token!=='string'||!identity.token)throw Error('Invalid AgentPeerChat identity.');
 if(url.username||url.password||url.search||url.hash||url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw Error('Use an HTTPS instance, or a local HTTP development instance.');
 return {...identity,url:identity.url.replace(/\/$/,'')};
}
export function dedicatedSessionId(identity){
 const id=digest(identity.url+'\n'+identity.principal_id).slice(0,32);return `session-${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;
}
export async function ownProfile(root){
 await mkdir(root,{recursive:true,mode:0o700});const path=join(root,'owner.json');
 let file;try{file=await open(path,'wx',0o600);}catch(e){
  if(e.code!=='EEXIST')throw e;const previous=JSON.parse(await readFile(path,'utf8'));
  if(!Number.isInteger(previous.pid))throw Error('Invalid DSH channel lock.');
  try{process.kill(previous.pid,0);}catch(error){if(error.code!=='ESRCH')throw error;await rm(path);return ownProfile(root);}
  throw Error('A DSH plugin already owns this AgentPeerChat identity.');
 }
 await file.writeFile(JSON.stringify({pid:process.pid}));return async()=>{await file.close();await rm(path,{force:true});};
}
export class DshMailbox {
 constructor({identity,root,runTask,signal,request=requestJSON,notify=receiveNotifications,fallbackSeconds=1800,onStatus=()=>{},onError=()=>{},dispatchScheduled}){
  if(!Number.isInteger(fallbackSeconds)||fallbackSeconds<30||fallbackSeconds>86400)throw Error('Fallback must be 30..86400 seconds.');
  Object.assign(this,{identity,root,runTask,signal,request,notify,fallbackSeconds,onStatus,onError,dispatchScheduled});this.current=null;this.dirty=false;this.retry=null;this.failures=0;
  this.status={runtime:'dsh',principal_id:identity.principal_id,url:identity.url,session_id:dedicatedSessionId(identity),connected:false,processed:0,scheduled_dispatch:Boolean(dispatchScheduled)};
 }
 async update(patch){this.status={...this.status,...patch};await savePrivate(join(this.root,'status.json'),this.status);this.onStatus(this.status);}
 call(path,options={}){return this.request(this.identity.url+'/api/v1'+path,{token:this.identity.token,...options,...(this.fence?{headers:{'X-AgentPeerChat-Receiver':this.fence}}:{})});}
 async drain(){
  // Validate before any model work, inside the retryable drain: an offline boot must recover.
  if(!this.verified){const me=await this.call('/me');if(me.principal?.id!==this.identity.principal_id||me.principal.kind!=='agent')throw Error('The instance did not confirm this Agent identity.');this.verified=true;}
  const holder=randomUUID(),lease=await this.call('/receiver/lease',{method:'POST',body:{holder}});if(!lease.acquired)throw Error('Another receiver owns this identity.');
  this.fence=lease.fence;let lost=false,renewal;
  const timer=setInterval(()=>{if(!renewal)renewal=this.call('/receiver/lease',{method:'POST',body:{holder}}).then(value=>{if(!value.acquired||value.fence!==lease.fence)throw Error('Receiver lease lost.');}).catch(()=>{lost=true;this.onError(Error('DSH receiver lease lost.'));}).finally(()=>renewal=null);},30000);
  try{await this.drainOwned(()=>{if(lost)throw Error('DSH receiver lease lost; mail remains pending.');});}
  finally{clearInterval(timer);await renewal;this.fence=null;await this.call('/receiver/lease',{method:'DELETE',body:{holder,fence:lease.fence}}).catch(()=>{});}
 }
 async drainOwned(checkLease){
  // Start from pending deliveries after every restart. No notification or local cursor is authoritative.
  const page=await this.call('/inbox?after=0&limit=20');if(!Array.isArray(page.items))throw Error('Invalid inbox.');
  for(const message of page.items){
   checkLease();
   if(this.signal.aborted)break;
   checkLease();
   if(!/^msg_[A-Za-z0-9_]+$/.test(message.id||'')||!/^thr_[A-Za-z0-9_]+$/.test(message.thread_id||''))throw Error('Invalid message identity.');
   const path=join(this.root,'receipts',message.id+'.json');let result;
   try{result=JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
   if(result&&(result.principal_id!==this.identity.principal_id||result.url!==this.identity.url||result.message_id!==message.id))throw Error('The saved receipt belongs to another identity.');
   if(!result){
    await this.update({last_message_id:message.id,working:true,last_error:null});
    const context=await this.call('/threads/'+message.thread_id+'?after=0&limit=10');
    const text=await this.runTask({message,thread:context.thread,signal:this.signal});
    if(typeof text!=='string'||!text.trim()||Buffer.byteLength(text)>16384)throw Error('DSH must produce a nonempty reply within the mailbox text limit.');
    result={principal_id:this.identity.principal_id,url:this.identity.url,message_id:message.id,thread_id:message.thread_id,content:text.trim()===NO_REPLY?null:text};
    // Save the exact result before send. A crash or uncertain reply retries this payload, not the task.
    await savePrivate(path,result);
   }
   if(this.signal.aborted)break;
   if(result.content!==null)await this.call('/messages',{method:'POST',send:true,idempotencyKey:'dsh-reply-'+message.id,body:{thread_id:result.thread_id,type:'text',content:result.content,reply_to:message.id}});
   await this.call('/messages/'+message.id+'/ack',{method:'POST'});
   await this.update({processed:this.status.processed+1,working:false,last_processed_at:new Date().toISOString(),last_error:null});
  }
  if(page.has_more&&!this.signal.aborted)this.dirty=true;
 }
 trigger(){
  if(this.signal.aborted)return Promise.resolve();this.dirty=true;if(this.current)return this.current;
  this.current=(async()=>{
   try{
    while(this.dirty&&!this.signal.aborted){this.dirty=false;await this.drain();}this.failures=0;
   }catch(error){
    this.onError(error);
    await this.update({working:false,last_error:'DSH channel processing failed; pending mail is retained.'});
    if(!this.signal.aborted&&!this.retry){const delay=Math.min(60000,1000*2**Math.min(this.failures++,6));this.retry=setTimeout(()=>{this.retry=null;void this.trigger();},delay);}
   }finally{this.current=null;}
  })();return this.current;
 }
 async start(){
  const timer=setInterval(()=>void this.trigger(),this.fallbackSeconds*1000);
  let dispatch;
  const scheduled=this.dispatchScheduled?setInterval(()=>{if(!dispatch&&!this.signal.aborted)dispatch=this.dispatchScheduled().catch(()=>this.onError(Error('Scheduled delivery failed; the outbox is retained.'))).finally(()=>dispatch=null);},1000):null;
  let direct={close:async()=>{}};try{direct=await startDirect({identity:this.identity,root:this.root,signal:this.signal,onWork:()=>this.trigger(),request:this.request});}catch{/* Direct ingress is optional; keep outbound receiving. */}
  const stop=()=>{clearInterval(timer);clearInterval(scheduled);clearTimeout(this.retry);this.retry=null;};this.signal.addEventListener('abort',stop,{once:true});
  try{
   await this.update({started_at:new Date().toISOString()});void this.trigger();
   await this.notify({identity:this.identity,signal:this.signal,onWork:()=>this.trigger(),onState:patch=>this.update(patch)});
  }finally{stop();await this.current;await dispatch;await direct.close();this.signal.removeEventListener('abort',stop);await this.update({connected:false,working:false});}
 }
}
