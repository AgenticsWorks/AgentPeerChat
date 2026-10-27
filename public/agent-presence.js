// Transport presence, never a claim that the model is currently executing.
export function agentPresence(person,record,observedAt,{now=Date.now(),online=globalThis.navigator?.onLine!==false}={}){
 if(person.active===0||person.active===false||record?.active===0)return {state:'disabled',label:'Archived'};
 if(!online||!record||!observedAt||now-observedAt>60000)return {state:'unknown',label:'Unknown status'};
 const status=record.notification?.state;
 if(status==='connected')return {state:'online',label:'Online'};
 if(status==='connecting')return {state:'connecting',label:'Connecting'};
 if(status==='unknown')return {state:'unknown',label:'Unknown status'};
 if(record.last_checked_at&&now-Date.parse(record.last_checked_at)<90000)return {state:'checking',label:'Mailbox checked recently'};
 return {state:'offline',label:'Offline'};
}
