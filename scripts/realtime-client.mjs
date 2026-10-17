// Push carries only a change hint. The existing inbox/ACK path remains authoritative.
import {NotificationSocket} from './websocket-transport.mjs';
import {requestJSON} from './client-transport.mjs';
const sleep=(ms,signal)=>new Promise(resolve=>{if(signal?.aborted)return resolve();const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,ms);signal?.addEventListener('abort',done,{once:true});});
export async function receiveNotifications({identity,onWork,onState=async()=>{},signal,WebSocketImpl=NotificationSocket,request=requestJSON,wait=sleep,heartbeatMs=45000,random=Math.random}) {
  let failures=0,busy=false,dirty=false,work;
  const report=async patch=>{try{await onState(patch);}catch{ /* A local status write must not drop the stream. */ }};
  // Preserve a trailing event while a model turn is busy. Never run two turns concurrently.
  const trigger=()=>{
    dirty=true;if(busy||signal?.aborted)return;
    busy=true;work=(async()=>{try{while(dirty&&!signal?.aborted){dirty=false;const result=await onWork();if(result?.skipped){dirty=true;await wait(1000,signal);}}}catch{await report({work_error:'Mailbox work failed; messages remain pending.'});}finally{busy=false;}})();
  };
  while(!signal?.aborted){
    let rejected=false;
    try{
      const credentials=await request(identity.url.replace(/\/$/,'')+'/api/v1/realtime/ticket',{method:'POST',token:identity.token});
      if(typeof credentials.ticket!=='string'||!/^wst_[A-Za-z0-9_-]+$/.test(credentials.ticket))throw Error('Invalid stream ticket');
      const url=new URL(identity.url);url.protocol=url.protocol==='https:'?'wss:':'ws:';url.pathname=url.pathname.replace(/\/+$/,'')+'/api/v1/events';url.search='';url.hash='';
      await new Promise(resolve=>{
        const ws=new WebSocketImpl(url,['apc-v1','ticket.'+credentials.ticket]);
        let ready=false,lastPong=Date.now(),ended=false;
        const finish=()=>{if(ended)return;ended=true;clearInterval(heartbeat);clearTimeout(handshake);signal?.removeEventListener('abort',abort);try{ws.close();}catch{}resolve();};
        const abort=()=>finish();signal?.addEventListener('abort',abort,{once:true});
        const handshake=setTimeout(finish,15000);
        const heartbeat=setInterval(()=>{if(!ready)return;if(Date.now()-lastPong>heartbeatMs*2.5)return finish();try{ws.send('ping');}catch{finish();}},heartbeatMs);
        ws.addEventListener('message',event=>{
          if(event.data==='pong'){lastPong=Date.now();void report({connected:true,last_heartbeat_at:new Date().toISOString()}).catch(()=>{});return;}
          let value;try{value=JSON.parse(event.data);}catch{return;}
          if(value.type==='ready'){clearTimeout(handshake);ready=true;failures=0;lastPong=Date.now();void report({connected:true,connected_at:new Date().toISOString(),last_heartbeat_at:new Date().toISOString(),fallback_reason:null}).catch(()=>{});trigger();}
          else if(ready&&value.type==='mailbox_changed')trigger();
        });
        ws.addEventListener('close',event=>{if(event.code===4401)rejected=true;finish();});
        ws.addEventListener('error',finish);
        if(signal?.aborted)finish();
      });
    }catch(error){
      // Older/self-hosted servers fall back to the installed timer without a reconnect storm.
      rejected=/^(401|403|404|501):/.test(error.message);
    }
    await report({connected:false,disconnected_at:new Date().toISOString(),...(rejected?{fallback_reason:'Stream unavailable or authorization changed; periodic receiving remains enabled.'}:{})});
    if(signal?.aborted)break;
    const backoff=rejected?1800000:Math.min(60000,1000*2**Math.min(failures++,6));
    await wait(backoff+Math.floor(random()*Math.min(backoff/4,5000)),signal);
  }
  await work;
}
