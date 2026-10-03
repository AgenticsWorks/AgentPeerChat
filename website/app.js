// Only this explicitly published task recording is loaded; the introduction never reads the private inbox.
const agents={boat:{name:'小舟',role:'搜索 Agent',icon:'舟',color:'#edb45f'},mist:{name:'阿岚',role:'审阅 Agent',icon:'岚',color:'#a58ee9'}};
let recording,timer;
const messages=document.querySelector('#demo-messages'),contacts=document.querySelector('#demo-contacts');
function avatar(identity){const span=document.createElement('span');span.className='avatar';span.textContent=identity.icon;span.style.background=identity.color;return span;}
function addMessage(message,index){
 const bubble=document.createElement('div');bubble.className='demo-bubble'+(message.role==='human'?' mine':'');
 if(message.role==='agent'){
  const identity=Object.values(agents).find(a=>a.name===message.name);const sender=document.createElement('div');sender.className='demo-sender';
  const picture=avatar(identity);picture.classList.add('sender-avatar');const name=document.createElement('strong');name.textContent=message.name+' → 搜索技能选型';
  const badge=document.createElement('span');badge.className='agent-badge';badge.textContent=identity.role;sender.append(picture,name,badge);bubble.append(sender);
 }
 const content=document.createElement('p');const long=message.content.length>110;content.textContent=long?message.content.slice(0,110)+'…':message.content;bubble.append(content);
 if(long){const expand=document.createElement('button');expand.className='expand-message';expand.textContent='展开完整消息';expand.type='button';expand.setAttribute('aria-expanded','false');expand.addEventListener('click',()=>{const open=expand.getAttribute('aria-expanded')!=='true';content.textContent=open?message.content:message.content.slice(0,110)+'…';expand.textContent=open?'收起':'展开完整消息';expand.setAttribute('aria-expanded',String(open));});bubble.append(expand);}
 const time=document.createElement('time');time.textContent=new Date(message.created_at).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit'});bubble.append(time);messages.append(bubble);
}
function render(replay=false){
 clearTimeout(timer);
 document.querySelector('#demo-title').textContent='搜索技能选型';
 document.querySelector('#demo-members').textContent='你和 2 位 Agent · 真实任务';
 const headerAvatar=document.querySelector('#demo-avatar');headerAvatar.textContent='搜';headerAvatar.style.background='#70c266';
 const tile=document.createElement('button');tile.className='demo-contact active';tile.type='button';tile.setAttribute('aria-pressed','true');
 const copy=document.createElement('span');copy.className='contact-copy';const name=document.createElement('strong');name.textContent='搜索技能选型';const preview=document.createElement('small');preview.textContent=recording.messages.at(-1).name+'：'+recording.messages.at(-1).content;copy.append(name,preview);tile.append(avatar({icon:'搜',color:'#70c266'}),copy);tile.addEventListener('click',()=>render());contacts.replaceChildren(tile);
 document.querySelector('#demo-placeholder').textContent='查看真实任务记录';messages.replaceChildren();const date=document.createElement('span');date.className='demo-date';date.textContent=new Date(recording.completedAt).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'});messages.append(date);
 const visible=recording.preview_indexes.map(index=>recording.messages[index]);let next=0;function step(){if(next>=visible.length)return;addMessage(visible[next],next++);timer=setTimeout(step,600);}
 if(replay&&!matchMedia('(prefers-reduced-motion: reduce)').matches)step();else visible.forEach(addMessage);
 messages.scrollTop=0;
}
document.querySelector('#replay').addEventListener('click',()=>render(true));
fetch('/research-conversation.json').then(response=>{if(!response.ok)throw new Error('Recording unavailable');return response.json();}).then(data=>{recording=data;render();}).catch(()=>{messages.textContent='任务记录暂时无法加载，请打开完整记录。';});
