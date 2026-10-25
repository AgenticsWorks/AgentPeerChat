// Private processing metadata. Pending deliveries and ACKs remain authoritative on the server.
import {readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {readState,writeState,clearWorkspaceReview} from './native-runtime.mjs';

const validId=id=>/^msg_[A-Za-z0-9_]+$/.test(id||'');
const sameIdentity=(saved,identity)=>saved?.principal_id===identity.principal_id&&typeof saved.url==='string'&&saved.url.replace(/\/+$/,'')===identity.url.replace(/\/+$/,'');
const file=(root,id)=>{if(!validId(id))throw Error('Invalid mailbox message ID.');return join(root,'recovery',id+'.json');};
export async function recoveryRecords(root,identity){
 let names;try{names=await readdir(join(root,'recovery'));}catch(error){if(error.code==='ENOENT')return [];throw error;}
 const records=[];
 for(const name of names.filter(n=>/^msg_[A-Za-z0-9_]+\.json$/.test(n))){
  const value=await readState(join(root,'recovery',name));
  if(!sameIdentity(value,identity))throw Error('Mailbox recovery belongs to a different identity.');
  records.push(value);
 }
 return records;
}
export function recoverySummary(records){
 const dates=records.filter(r=>r.status==='retry_wait'&&r.next_retry_at).map(r=>r.next_retry_at).sort();
 return {retrying:records.filter(r=>r.status==='retry_wait').length,paused:records.filter(r=>r.status==='paused').length,
  needs_review:records.filter(r=>r.status==='needs_review').length,next_retry_at:dates[0]??null};
}
export async function saveFailure({root,identity,message,receipt,stage,error,previous,workspace,inspect=false,now=Date.now(),random=Math.random}){
 const attempts=(previous?.attempts||0)+1,consecutive=(previous?.consecutive_attempts||0)+1;
 const http=error.status??Number(/^(\d{3}):/.exec(error.message||'')?.[1]);
 let status='retry_wait',code='temporary_failure';
 if(stage==='execute'&&receipt?.phase==='running'){status='needs_review';code='execution_unconfirmed';}
 else if(error.code==='WORKSPACE_REVIEW_REQUIRED'){status='paused';code='workspace_needs_review';}
 else if(http===401||http===403){status='paused';code='access_required';}
 else if(error.code==='INVALID_REPLY'){status='paused';code='invalid_saved_reply';}
 else if(/Install.*skill|not installed|No interactive operator|permission/i.test(error.message||'')){status='paused';code='configuration_required';}
 else if(consecutive>=5){status='paused';code='retry_limit_reached';}
 const delay=Math.max(Math.min(300000,5000*2**Math.min(consecutive-1,6))+Math.floor(random()*1000),error.retry_after_ms||0);
 const record={url:identity.url,principal_id:identity.principal_id,message_id:message.id,message_seq:message.seq,thread_id:message.thread_id,...(workspace?{workspace}:{}),
  status,stage,error_code:code,attempts,consecutive_attempts:consecutive,failed_at:new Date(now).toISOString(),
  next_retry_at:status==='retry_wait'?new Date(now+delay).toISOString():null,...(inspect&&status==='needs_review'?{reconcile_requested:true}:{})};
 await writeState(file(root,message.id),record);return record;
}
export async function clearFailure(root,id){await rm(file(root,id),{force:true});}
export async function requestRecovery(root,identity,id,action){
 const record=(await recoveryRecords(root,identity)).find(r=>r.message_id===id);
 if(!record)throw Error('No saved failure for this message.');
 const receipt=await readState(join(root,'receipts',id+'.json'));
 if(action==='retry'&&(receipt?.phase==='running'||record.status==='needs_review'&&!['completed','acked'].includes(receipt?.phase)))throw Error('Execution is uncertain. Use mailbox reconcile; retry never clears an execution checkpoint.');
 if(action==='reconcile'&&record.status!=='needs_review')throw Error('Only an uncertain execution needs reconciliation.');
 record.next_retry_at=new Date(0).toISOString();record.consecutive_attempts=0;
 if(action==='reconcile')record.reconcile_requested=true;
 else record.status='retry_wait';
 await writeState(file(root,id),record);return {message_id:id,action,requested:true};
}
export async function resolveRecovery(root,identity,id,text){
 const record=(await recoveryRecords(root,identity)).find(r=>r.message_id===id);
 if(record?.status!=='needs_review')throw Error('Only an uncertain execution can be resolved with an operator-confirmed result.');
 if(typeof text!=='string'||!text.trim()||Buffer.byteLength(text)>16384)throw Error('The confirmed result must be nonempty UTF-8 text within 16384 bytes.');
 const path=join(root,'receipts',id+'.json'),receipt=await readState(path);
 if(!sameIdentity(receipt,identity)||receipt.message_id!==id||receipt.thread_id!==record.thread_id)throw Error('The original private execution checkpoint is required.');
 if(['completed','acked'].includes(receipt.phase))throw Error('A result is already saved. Use mailbox retry to preserve its exact payload.');
 await writeState(path,{...receipt,phase:'completed',content:text.trim()==='[agentpeerchat:no-reply]'?null:text,completed_at:new Date().toISOString(),operator_confirmed:true});
 await writeState(file(root,id),{...record,status:'retry_wait',stage:'reply',consecutive_attempts:0,next_retry_at:new Date(0).toISOString(),reconcile_requested:false});
 await clearWorkspaceReview(record.workspace,identity,{id});
 return {message_id:id,action:'resolve',requested:true};
}
