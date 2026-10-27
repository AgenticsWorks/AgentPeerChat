import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createNotifications} from '../public/chat-notifications.js';
class Button extends EventTarget {constructor(){super();this.attributes={};this.classList={toggle(){}};}setAttribute(key,value){this.attributes[key]=value;}}
function fixture(t){
 const before={document:globalThis.document,window:globalThis.window};const document=new EventTarget();document.hidden=true;document.hasFocus=()=>false;document.title='';globalThis.document=document;globalThis.window=new EventTarget();
 t.after(()=>{for(const [key,value]of Object.entries(before))value===undefined?delete globalThis[key]:globalThis[key]=value;});
 const saved=new Map(),storage={getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value)},notices=[],bell=new Button(),soundButton=new Button();let requests=0;
 class Notice {static permission='default';static async requestPermission(){requests++;Notice.permission='granted';return 'granted';}constructor(title,options){notices.push({title,...options});}}
 const identity={id:'owner'},agent={id:'agent',name:'Muse'},thread={id:'thread',title:'Travel',kind:'group',participants:[identity,agent],message_count:1,last_message:{sender_id:agent.id,content:'First message'}};
 let reading=false;const notifications=createNotifications({bell,soundButton,storage,NotificationAPI:Notice,isReading:()=>reading,onOpen:()=>{}});notifications.start(identity);
 return {notifications,identity,agent,thread,document,saved,notices,bell,soundButton,Notice,get requests(){return requests;},read:()=>{reading=true;}};
}
test('new messages create unread/title badges and notifications only after the browser grants permission',async t=>{
 const f=fixture(t);f.notifications.update([f.thread],f.identity,[f.agent],null);assert.equal(f.notifications.unread('thread'),0);assert.equal(f.requests,0);assert.equal(f.notices.length,0);
 f.bell.dispatchEvent(new Event('click'));await new Promise(r=>setImmediate(r));assert.equal(f.requests,1);
 f.thread.message_count=2;f.thread.last_message.content='Fare comparison is ready';f.notifications.update([f.thread],f.identity,[f.agent],null);
 assert.equal(f.notifications.unread('thread'),1);assert.equal(f.document.title,'(1) AgentPeerChat');await new Promise(r=>setImmediate(r));assert.equal(f.notices.length,1);assert.match(f.notices[0].body,/Fare comparison/);
 f.notifications.read(f.thread,{force:true});assert.equal(f.document.title,'AgentPeerChat');assert.equal(f.notifications.unread('thread'),0);assert.equal(JSON.parse(f.saved.get('agentpeerchat.read.owner')).thread,2);
});
test('own messages and observed Agent-only chats do not send distracting desktop notifications',t=>{
 const f=fixture(t);f.Notice.permission='granted';f.notifications.update([f.thread],f.identity,[f.agent],null);
 f.thread.message_count=2;f.thread.last_message.sender_id=f.identity.id;f.notifications.update([f.thread],f.identity,[f.agent],null);assert.equal(f.notifications.unread('thread'),0);assert.equal(f.notices.length,0);
 f.thread.participants=[f.agent];f.thread.message_count=3;f.thread.last_message.sender_id=f.agent.id;f.notifications.update([f.thread],f.identity,[f.agent],null);assert.equal(f.notifications.unread('thread'),1);assert.equal(f.notices.length,0);
});
test('sound preferences persist and signing out clears the old account badges',t=>{
 const f=fixture(t);f.notifications.update([f.thread],f.identity,[f.agent],null);f.soundButton.dispatchEvent(new Event('click'));assert.equal(f.saved.get('agentpeerchat.sound'),'off');assert.equal(f.soundButton.attributes['aria-pressed'],'false');
 f.thread.message_count=2;f.notifications.update([f.thread],f.identity,[f.agent],null);assert.equal(f.notifications.unread('thread'),1);
 f.notifications.stop();assert.equal(f.document.title,'AgentPeerChat');assert.equal(f.notifications.unread('thread'),0);
});
