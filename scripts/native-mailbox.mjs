import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {requestJSON} from './client-transport.mjs';
import {readState,writeState} from './native-runtime.mjs';

// Each result is fsynced before sending. Retrying a send or ACK never reruns tools.
export async function drainNative({identity,root,engine,signal=engine.signal,request=requestJSON}){
 const holder=randomUUID();let lease,lost=false,timer,renewal;
 const call=(path,options={})=>request(identity.url.replace(/\/$/,'')+'/api/v1'+path,{token:identity.token,...options});
 const renew=async()=>{const value=await call('/receiver/lease',{method:'POST',body:{holder}});if(!value.acquired||lease&&lease.fence!==value.fence)throw Error('Another receiver owns this identity.');return value;};
 try{
  lease=await renew();
  timer=setInterval(()=>{if(!renewal)renewal=renew().catch(()=>{lost=true;void engine.close();}).finally(()=>renewal=null);},30000);
  const headers={'X-AgentPeerChat-Receiver':lease.fence};
  let processed=0,modelTurns=0,more=true;
  while(more&&!signal?.aborted){
   const page=await call('/inbox?after=0&limit=20');if(!Array.isArray(page.items))throw Error('Invalid pending mailbox page.');
   for(const message of page.items){
    if(signal?.aborted||lost)throw Error('Receiver stopped or lost its lease; inputs remain pending.');
    if(!/^msg_[A-Za-z0-9_]+$/.test(message.id||'')||!/^thr_[A-Za-z0-9_]+$/.test(message.thread_id||''))throw Error('Invalid message identity.');
    const path=join(root,'receipts',message.id+'.json');let receipt=await readState(path);
    if(receipt&&(receipt.principal_id!==identity.principal_id||receipt.url!==identity.url||receipt.thread_id!==message.thread_id))throw Error('Saved result belongs to another connection.');
    if(receipt?.phase!=='completed'&&receipt?.phase!=='acked'){
     receipt??={message_id:message.id,thread_id:message.thread_id,url:identity.url,principal_id:identity.principal_id,phase:'queued'};
     await writeState(path,receipt);
     const checkpoint={...receipt,save:async patch=>{Object.assign(receipt,patch);await writeState(path,receipt);}};
     const context=await call('/threads/'+message.thread_id+'?after=0&limit=1');
     modelTurns++;const text=await engine.run({message,thread:context.thread,checkpoint});
     if(typeof text!=='string'||!text.trim()||Buffer.byteLength(text)>16384)throw Error('Native task must return a nonempty answer within 16384 UTF-8 bytes.');
     receipt={...receipt,phase:'completed',content:text.trim()==='[agentpeerchat:no-reply]'?null:text,completed_at:new Date().toISOString()};await writeState(path,receipt);
    }
    if(signal?.aborted||lost)throw Error('Receiver lost its lease; saved result is retained.');
    if(receipt.content!==null)await call('/messages',{method:'POST',send:true,idempotencyKey:'native-reply-'+message.id,headers,body:{thread_id:message.thread_id,type:'text',content:receipt.content,reply_to:message.id}});
    await call('/messages/'+message.id+'/ack',{method:'POST',headers});
    receipt.phase='acked';await writeState(path,receipt);processed++;
   }
   more=page.items.length>0;
  }
  return {model_started:modelTurns>0,acknowledged:processed,model_finished_at:modelTurns?new Date().toISOString():undefined,pending_after:false};
 }finally{clearInterval(timer);await renewal;if(lease)await call('/receiver/lease',{method:'DELETE',body:{holder,fence:lease.fence}}).catch(()=>{});}
}
