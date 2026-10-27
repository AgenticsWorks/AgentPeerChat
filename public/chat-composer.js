import {t} from './i18n.js';
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function mentionQuery(text, caret = text.length) {
  const prefix = text.slice(0, caret), match = /(?:^|\s)@([^@\n]{0,80})$/u.exec(prefix);
  return match ? {start: prefix.lastIndexOf('@'), end: caret, query: match[1]} : null;
}
export function resolveMentions(text, members, selected = []) {
  const found = members.filter(person => new RegExp('(?:^|\\s)@' + escaped(person.name) + '(?=$|[\\s.,!?，。！？:：;；])', 'iu').test(text));
  return [...new Set(found.filter(person => selected.includes(person.id) || found.filter(other => other.name.toLowerCase() === person.name.toLowerCase()).length === 1).map(person => person.id))].sort();
}
export function createComposer({input,form,popup,mentionButton,replyBar,replyName,replyText,cancelReply,feedback,counter,getMembers,getMe,onSubmit,onDraft}) {
  let matches = [], index = 0, query = null, selected = [], replying = null, thread = null, enabled = false, busy = false;
  const drafts = new Map(), send = form.querySelector('[type=submit]');
  const members = () => getMembers().filter(person => person.id !== getMe()?.id && person.active !== 0 && person.active !== false);
  function close() { popup.hidden = true; input.setAttribute('aria-expanded','false'); input.removeAttribute('aria-activedescendant'); matches = []; }
  function resize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight,160) + 'px'; }
  function payload() {
    const mentions = thread?.kind === 'group' ? resolveMentions(input.value,members(),selected) : [];
    if (thread?.kind === 'group' && replying?.sender_id !== getMe()?.id && members().some(person => person.id === replying?.sender_id)) mentions.push(replying.sender_id);
    return {...(mentions.length ? {mentions:[...new Set(mentions)].sort()} : {}), ...(replying ? {reply_to:replying.id} : {})};
  }
  function update() {
    resize(); const bytes = new TextEncoder().encode(input.value).length;
    send.disabled = busy || !enabled || !input.value.trim() || bytes > 16384;
    input.disabled = !enabled; mentionButton.disabled = !enabled || !members().length;
    counter.hidden = bytes < 14000; counter.textContent = `${bytes.toLocaleString()} / 16,384`; counter.classList.toggle('over-limit',bytes > 16384);
    const targets = payload().mentions || [];
    feedback.textContent = targets.length ? t('Notifying {0}',targets.map(id => members().find(p => p.id === id)?.name).filter(Boolean).join(', ')) : t('Enter to send · Shift + Enter for a new line');
    replyBar.hidden = !replying; if(replying){replyName.textContent=t('Replying to {0}',getMembers().find(p=>p.id===replying.sender_id)?.name || t('a message'));replyText.textContent=typeof replying.content==='string'?replying.content:JSON.stringify(replying.content);}
  }
  function choose(person) {
    if (!query || !person) return;
    const insertion='@'+person.name+' ',before=input.value.slice(0,query.start),after=input.value.slice(query.end);
    input.value=before+insertion+after;selected.push(person.id);close();input.focus();input.setSelectionRange(before.length+insertion.length,before.length+insertion.length);update();save();
  }
  function suggestions() {
    close(); if(!enabled)return;
    query=mentionQuery(input.value,input.selectionStart);if(!query)return;
    matches=members().filter(p=>p.name.toLocaleLowerCase().includes(query.query.trim().toLocaleLowerCase())).slice(0,12);if(!matches.length)return;
    index=0;popup.replaceChildren(); const heading=document.createElement('div');heading.className='mention-heading';heading.textContent=t('Mention a member');popup.append(heading);
    for(const [i,person] of matches.entries()) {
      const option=document.createElement('button');option.type='button';option.className='mention-option';option.id='mention-option-'+i;option.setAttribute('role','option');option.dataset.mentionId=person.id;
      const avatar=document.createElement('span');avatar.className='mention-avatar';avatar.textContent=Array.from(person.name)[0];
      const name=document.createElement('strong');name.textContent=person.name;const role=document.createElement('small');role.textContent=person.kind==='agent'?t('Agent'):t('Member');
      option.append(avatar,name,role);option.addEventListener('mousedown',e=>e.preventDefault());option.addEventListener('click',()=>choose(person));popup.append(option);
    }
    popup.hidden=false;input.setAttribute('aria-expanded','true');highlight();
  }
  function highlight(){popup.querySelectorAll('[role=option]').forEach((node,i)=>node.setAttribute('aria-selected',String(i===index)));input.setAttribute('aria-activedescendant','mention-option-'+index);popup.querySelector('[aria-selected=true]')?.scrollIntoView({block:'nearest'});}
  function save(){if(thread)drafts.set(thread.id,{text:input.value,selected:[...selected],replying});onDraft?.();}
  input.addEventListener('input',()=>{update();suggestions();save();});
  input.addEventListener('click',suggestions);
  input.addEventListener('keydown',event=>{
    if(event.isComposing||event.keyCode===229)return;
    if(!popup.hidden&&['ArrowDown','ArrowUp','Enter','Tab','Escape'].includes(event.key)){
      event.preventDefault();event.stopPropagation();if(event.key==='Escape'){close();return;}if(event.key==='Enter'||event.key==='Tab'){choose(matches[index]);return;}
      index=(index+(event.key==='ArrowDown'?1:-1)+matches.length)%matches.length;highlight();return;
    }
    if(event.key==='Escape'&&replying){replying=null;update();save();}
    if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();if(!send.disabled)form.requestSubmit();}
  });
  mentionButton.addEventListener('click',()=>{input.focus();const start=input.selectionStart,end=input.selectionEnd;input.setRangeText((start&& !/\s/.test(input.value[start-1])?' ':'')+'@',start,end,'end');update();suggestions();save();});
  cancelReply.addEventListener('click',()=>{replying=null;update();save();input.focus();});
  document.addEventListener('pointerdown',event=>{if(!form.contains(event.target))close();});
  form.addEventListener('submit',event=>{event.preventDefault();if(!send.disabled)onSubmit();});
  return {payload,save,close,update,
    select(id){save();close();thread={id};const draft=drafts.get(id);input.value=draft?.text||'';selected=draft?.selected||[];replying=draft?.replying||null;enabled=false;update();},
    context(value,canSend){thread=value;enabled=canSend;input.placeholder=value?.kind==='group'?t('Message {0} · @ to mention',value.title):t('Write a message…');update();},
    reply(message){if(!enabled)return;replying=message;update();save();input.focus();},
    sent(){input.value='';selected=[];replying=null;close();save();update();},
    busy(value){busy=value;update();}
  };
}
