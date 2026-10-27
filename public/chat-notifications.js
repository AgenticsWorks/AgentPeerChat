import {t} from './i18n.js';
export function createNotifications({bell,soundButton,onChange,onOpen,storage=globalThis.localStorage,NotificationAPI=globalThis.Notification,isReading=id=>!document.hidden&&document.hasFocus(),notifyError=()=>{}}) {
  let me,seen={},latest=new Map(),counts=new Map(),audio,sound=true,started=false,first=true;
  try{sound=storage.getItem('agentpeerchat.sound')!=='off';}catch{}
  const key=()=>`agentpeerchat.read.${me?.id}`;
  const save=()=>{try{storage.setItem(key(),JSON.stringify(seen));}catch{}};
  function translate(){bell.title=bell.ariaLabel=t(NotificationAPI?.permission==='granted'?'Notifications enabled':'Enable notifications');bell.classList.toggle('is-enabled',NotificationAPI?.permission==='granted');soundButton.title=soundButton.ariaLabel=t(sound?'Mute message sounds':'Enable message sounds');soundButton.setAttribute('aria-pressed',String(sound));}
  function title(){const total=[...counts.values()].reduce((sum,count)=>sum+count,0);document.title=(total?`(${total}) `:'')+'AgentPeerChat';onChange?.();}
  function read(thread,{force=false}={}){if(!thread||(!force&&!isReading(thread.id)))return;seen[thread.id]=Number(thread.message_count||0);counts.delete(thread.id);save();title();}
  async function ding(){if(!sound||!audio||audio.state!=='running')return;const now=audio.currentTime,osc=audio.createOscillator(),gain=audio.createGain();osc.type='sine';osc.frequency.setValueAtTime(740,now);osc.frequency.exponentialRampToValueAtTime(1040,now+.09);gain.gain.setValueAtTime(.0001,now);gain.gain.exponentialRampToValueAtTime(.07,now+.012);gain.gain.exponentialRampToValueAtTime(.0001,now+.19);osc.connect(gain);gain.connect(audio.destination);osc.start(now);osc.stop(now+.2);}
  function primeAudio(){if(!sound)return;try{const Context=globalThis.AudioContext||globalThis.webkitAudioContext;if(!Context)return;audio??=new Context();if(audio.state==='suspended')void audio.resume().catch(()=>{});}catch{}}
  function update(threads,identity,principals,selected){
    if(!started||identity?.id!==me?.id)return;latest=new Map(threads.map(thread=>[thread.id,thread]));let shouldSound=false;
    for(const thread of threads){
      const count=Number(thread.message_count||0),last=thread.last_message,previous=Number(seen[thread.id]??0);
      if(first&&seen[thread.id]===undefined){seen[thread.id]=count;continue;}
      if(last?.sender_id===me.id||thread.id===selected&&isReading(thread.id)){seen[thread.id]=count;counts.delete(thread.id);continue;}
      const unread=Math.max(0,count-previous);if(!unread){counts.delete(thread.id);continue;}
      const prior=counts.get(thread.id)||0;counts.set(thread.id,unread);
      const joined=(thread.participants||thread.members||[]).some(p=>p.id===me.id);
      if(!first&&unread>prior&&last&&last.sender_id!==me.id&&joined){
        shouldSound=true;
        if(NotificationAPI?.permission==='granted'&&(document.hidden||!document.hasFocus())){
          const sender=principals.find(p=>p.id===last.sender_id)?.name||t('New message');
          try{const notification=new NotificationAPI(thread.kind==='group'?thread.title:sender,{body:`${sender}: ${typeof last.content==='string'?last.content.slice(0,160):t('Shared an attachment')}`,tag:thread.id,icon:'/icon-192.png'});notification.onclick=()=>{window.focus();onOpen(thread.id);notification.close();};}catch{}
        }
      }
    }
    first=false;save();title();if(shouldSound)void ding();
  }
  bell.addEventListener('click',async()=>{if(!NotificationAPI){notifyError(t('This browser does not support desktop notifications. Unread counts still work.'));return;}try{if(NotificationAPI.permission==='default')await NotificationAPI.requestPermission();if(NotificationAPI.permission==='denied')notifyError(t('Notifications are blocked. Allow them in your browser’s site settings.'));translate();}catch{notifyError(t('Could not enable notifications'));}});
  soundButton.addEventListener('click',()=>{sound=!sound;try{storage.setItem('agentpeerchat.sound',sound?'on':'off');}catch{}primeAudio();translate();if(sound)void ding();});
  document.addEventListener('pointerdown',primeAudio,{passive:true});document.addEventListener('keydown',primeAudio,{passive:true});
  const focused=()=>{for(const thread of latest.values())if(isReading(thread.id))read(thread);};window.addEventListener('focus',focused);document.addEventListener('visibilitychange',focused);
  translate();
  return {start(identity){if(me?.id===identity.id&&started)return;me=identity;started=true;first=true;seen={};counts.clear();try{const saved=JSON.parse(storage.getItem(key())||'{}');if(saved&&typeof saved==='object'&&!Array.isArray(saved))seen=saved;}catch{}translate();},stop(){started=false;me=null;latest.clear();counts.clear();document.title='AgentPeerChat';},update,read,unread:id=>counts.get(id)||0,translate};
}

// A cookie-authenticated, receive-only stream. Idle pings are handled by the
// Cloudflare edge; reconnects and events reconcile against the durable API.
export function createBrowserEvents({url,onChange,WebSocketImpl=globalThis.WebSocket,onState=()=>{}}){
  let active=false,socket,timer,heartbeat,failures=0,lastPong=0;
  const clear=()=>{clearTimeout(timer);clearInterval(heartbeat);};
  function connect(){if(!active||!WebSocketImpl)return;const target=new URL(url,location.href);target.protocol=target.protocol==='https:'?'wss:':'ws:';
    try{socket=new WebSocketImpl(target,'apc-v1');}catch{retry();return;}const current=socket;
    current.onopen=()=>{if(!active){current.close();return;}failures=0;lastPong=Date.now();onState(true);void onChange().catch(()=>{});heartbeat=setInterval(()=>{if(Date.now()-lastPong>90000){current.close();return;}if(current.readyState===1)current.send('ping');},25000);};
    current.onmessage=event=>{if(event.data==='pong'){lastPong=Date.now();return;}try{if(JSON.parse(event.data).type==='mailbox_changed')void onChange().catch(()=>{});}catch{}};
    current.onerror=()=>current.close();current.onclose=()=>{if(socket!==current)return;clearInterval(heartbeat);onState(false);retry();};
  }
  function retry(){clearTimeout(timer);if(active)timer=setTimeout(connect,Math.min(30000,1000*2**Math.min(failures++,5)));}
  return {start(){if(active)return;active=true;connect();},stop(){active=false;clear();const old=socket;socket=null;old?.close();}};
}
