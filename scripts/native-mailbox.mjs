import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {requestJSON} from './client-transport.mjs';
import {readState,writeState,markWorkspaceReview,clearWorkspaceReview,workspaceNeedsReview} from './native-runtime.mjs';
import {recoveryRecords,recoverySummary,saveFailure,clearFailure} from './mailbox-recovery.mjs';

const invalidReply=()=>Object.assign(Error('Saved native reply is empty or exceeds 16384 UTF-8 bytes.'),{code:'INVALID_REPLY'});
// Shared by native Codex/Claude and DSH. Scanning cursors are not processing receipts:
// every full sweep returns to zero, and a failed delivery is never ACKed or removed.
export async function processMailbox({identity,root,engine,call,signal=engine.signal,checkLease=()=>{},clock=Date.now,replyPrefix='native-reply-',onProcessed=async()=>{}}){
 const failures=new Map((await recoveryRecords(root,identity)).map(r=>[r.message_id,r]));
 const workspace=engine.workspace||engine.runner?.cwd;
 for(const record of failures.values())if(record.status==='needs_review')await markWorkspaceReview(workspace,identity,{id:record.message_id,thread_id:record.thread_id});
 const scanPath=join(root,'mailbox-scan.json'),savedScan=await readState(scanPath);
 let after=savedScan?.url===identity.url&&savedScan.principal_id===identity.principal_id?savedScan.after:'0';
 const seen=new Set(after!=='0'&&Array.isArray(savedScan?.seen_failures)?savedScan.seen_failures:[]);
 if(!/^\d+$/.test(String(after)))throw Error('Invalid mailbox scanning cursor.');
 // Due failures get a bounded priority pass, so a growing backlog cannot defer
 // their retry until an arbitrarily long scan finally wraps back to zero.
 const priority=[];
 for(const record of [...failures.values()].filter(r=>r.reconcile_requested||r.status==='retry_wait'&&Date.parse(r.next_retry_at)<=clock()).slice(0,10)){
  const saved=await call('/messages/'+record.message_id);
  const delivery=saved.receipts?.find(r=>r.recipient_id===identity.principal_id);
  if(!delivery)throw Error('Saved recovery has no delivery for this identity.');
  if(delivery.acked_at){await clearFailure(root,record.message_id);failures.delete(record.message_id);await clearWorkspaceReview(workspace,identity,{id:record.message_id});}
  else priority.push(saved.message);
 }
 let processed=0,modelTurns=0,reused=0,scanned=0,deferred=0,more=true,finishedAt;
 let priorityPass=priority.length>0;
 try{
  while(more&&scanned<10&&modelTurns<20&&!signal?.aborted){
   const inspectingPriority=priorityPass;priorityPass=false;
   const page=inspectingPriority?{items:priority,has_more:true}:await call('/inbox?after='+after+'&limit=100');
   if(!Array.isArray(page.items))throw Error('Invalid pending mailbox page.');
   scanned++;
   for(const message of page.items){
    checkLease();if(signal?.aborted)break;
    if(!/^msg_[A-Za-z0-9_]+$/.test(message.id||'')||!/^thr_[A-Za-z0-9_]+$/.test(message.thread_id||'')||!Number.isSafeInteger(message.seq)||!inspectingPriority&&message.seq<=Number(after))throw Error('Invalid pending message identity or cursor.');
    if(!inspectingPriority)after=String(message.seq);
    let failure=failures.get(message.id);
    if(failure)seen.add(message.id);
    const path=join(root,'receipts',message.id+'.json');let receipt=await readState(path);
    if(receipt&&(receipt.principal_id!==identity.principal_id||receipt.url!==identity.url||receipt.thread_id!==message.thread_id||receipt.message_id&&receipt.message_id!==message.id))throw Error('Saved result belongs to another connection.');
    if(receipt&&!receipt.phase&&Object.hasOwn(receipt,'content'))receipt.phase='completed';
    if(!receipt&&failure&&failure.stage!=='execute'){
     // A delivery-stage failure proves execution already ended. Losing the local
     // result is a recovery problem, never permission to run the task again.
     receipt={url:identity.url,principal_id:identity.principal_id,message_id:message.id,thread_id:message.thread_id,phase:'running',result_missing:true};
     await writeState(path,receipt);
     failure=await saveFailure({root,identity,message,receipt,stage:'execute',error:Error('Saved result missing'),previous:failure,workspace,inspect:true,now:clock()});
     failures.set(message.id,failure);seen.add(message.id);
    }
    // A crash may leave a native checkpoint before failure metadata was written.
    // Inspect it once without starting another turn, even if a workspace guard exists.
    if(receipt?.phase==='running'&&!failure){
     failure=await saveFailure({root,identity,message,receipt,stage:'execute',error:Error('Interrupted native checkpoint'),workspace,inspect:true,now:clock()});
     failures.set(message.id,failure);seen.add(message.id);
    }
    if([...failures.values()].some(r=>r.thread_id===message.thread_id&&r.message_id!==message.id&&(!r.message_seq||r.message_seq<message.seq))){deferred++;continue;}
    if(failure?.status==='paused'&&failure.error_code!=='workspace_needs_review'){deferred++;continue;}
    if(failure?.status==='needs_review'&&!failure.reconcile_requested&&!['completed','acked'].includes(receipt?.phase)){deferred++;continue;}
    if(failure?.status==='retry_wait'&&Date.parse(failure.next_retry_at)>clock()){deferred++;continue;}
    if(receipt?.phase!=='completed'&&receipt?.phase!=='acked'&&!failure?.reconcile_requested&&await workspaceNeedsReview(workspace)){deferred++;continue;}
    let stage='execute',usedSaved=receipt?.phase==='completed'||receipt?.phase==='acked';
    try{
     if(receipt?.phase!=='completed'&&receipt?.phase!=='acked'){
      receipt??={message_id:message.id,thread_id:message.thread_id,url:identity.url,principal_id:identity.principal_id,phase:'queued'};
      await writeState(path,receipt);
      const checkpoint={...receipt,save:async patch=>{Object.assign(receipt,patch);Object.assign(checkpoint,patch);await writeState(path,receipt);}};
      const context=await call('/threads/'+message.thread_id+'?after=0&limit=1');
      let text;
      if(failure?.reconcile_requested){
       if(!engine.reconcile)throw Error('This runtime cannot inspect uncertain native work automatically.');
       text=await engine.reconcile({message,thread:context.thread,checkpoint});
       usedSaved=true;
      }else{modelTurns++;text=await engine.run({message,thread:context.thread,checkpoint});}
      // Persist even an oversized terminal answer: a formatting failure must not rerun tools.
      receipt={...receipt,phase:'completed',content:typeof text==='string'?(text.trim()==='[agentpeerchat:no-reply]'?null:text):'',completed_at:new Date(clock()).toISOString()};
      await writeState(path,receipt);await clearWorkspaceReview(workspace,identity,message);
     }
     checkLease();if(signal?.aborted)throw Error('Receiver stopped.');
     stage='reply';
     if(receipt.content!==null){
      if(typeof receipt.content!=='string'||!receipt.content.trim()||Buffer.byteLength(receipt.content)>16384)throw invalidReply();
      await call('/messages',{method:'POST',send:true,idempotencyKey:replyPrefix+message.id,body:{thread_id:message.thread_id,type:'text',content:receipt.content,reply_to:message.id}});
     }
     stage='ack';checkLease();if(signal?.aborted)throw Error('Receiver stopped.');
     await call('/messages/'+message.id+'/ack',{method:'POST'});
     receipt.phase='acked';await writeState(path,receipt);await clearFailure(root,message.id);failures.delete(message.id);
     if(receipt.completed_at){finishedAt=receipt.completed_at;if(usedSaved)reused++;}
     await clearWorkspaceReview(workspace,identity,message);processed++;await onProcessed(message);
    }catch(error){
     checkLease();if(signal?.aborted||/^409:/.test(error.message||'')||error.status===409)throw error;
     const record=await saveFailure({root,identity,message,receipt,stage,error,previous:failure,workspace,now:clock()});
     failures.set(message.id,record);
     seen.add(message.id);
     if(record.status==='needs_review')await markWorkspaceReview(workspace,identity,message);
    }
    if(modelTurns>=20)break;
   }
   if(inspectingPriority)continue;
   more=Boolean(page.has_more)||modelTurns>=20;
   if(page.has_more&&(!/^\d+$/.test(String(page.next_cursor))||Number(page.next_cursor)<Number(after)))throw Error('Mailbox page cursor did not advance.');
   if(!page.items.length)more=false;
  }
 }catch(error){await writeState(scanPath,{url:identity.url,principal_id:identity.principal_id,after:'0'});throw error;}
 // Only a complete sweep can prove a saved failure is no longer pending remotely.
 if(!more&&!signal?.aborted)for(const record of failures.values())if(!seen.has(record.message_id)){
  await clearFailure(root,record.message_id);failures.delete(record.message_id);
  await clearWorkspaceReview(workspace,identity,{id:record.message_id});
 }
 await writeState(scanPath,{url:identity.url,principal_id:identity.principal_id,after:more?after:'0',seen_failures:more?[...seen]:[]});
 const recovery=recoverySummary([...failures.values()]);
 const workspaceBlocked=await workspaceNeedsReview(workspace);
 return {model_started:modelTurns>0,reused_results:reused,acknowledged:processed,model_finished_at:finishedAt,
  processing_finished_at:new Date(clock()).toISOString(),pending_after:more||deferred>0||failures.size>0,recovery,workspace_blocked:workspaceBlocked,scan_incomplete:more,next_check_at:more?new Date(clock()+1000).toISOString():workspaceBlocked?null:recovery.next_retry_at};
}

export async function drainNative({identity,root,engine,signal=engine.signal,request=requestJSON,clock=Date.now}){
 const holder=randomUUID();let lease,lost=false,timer,renewal;
 const call=(path,options={})=>request(identity.url.replace(/\/$/,'')+'/api/v1'+path,{token:identity.token,...options,headers:{...options.headers,...(lease?{'X-AgentPeerChat-Receiver':lease.fence}:{})}});
 const renew=async()=>{const value=await call('/receiver/lease',{method:'POST',body:{holder}});if(!value.acquired||lease&&lease.fence!==value.fence)throw Error('Another receiver owns this identity.');return value;};
 const checkLease=()=>{if(lost)throw Error('Receiver lost its lease; inputs remain pending.');};
 try{
  lease=await renew();
  timer=setInterval(()=>{if(!renewal)renewal=renew().catch(()=>{lost=true;void engine.close();}).finally(()=>renewal=null);},30000);
  return await processMailbox({identity,root,engine,call,signal,checkLease,clock});
 }finally{clearInterval(timer);await renewal;if(lease)await call('/receiver/lease',{method:'DELETE',body:{holder,fence:lease.fence}}).catch(()=>{});}
}
