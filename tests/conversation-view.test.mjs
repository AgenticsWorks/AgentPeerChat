import test from 'node:test';
import assert from 'node:assert/strict';
import {threadPeople, archivedConversation, avatarIcon} from '../public/conversation-view.js';
import {chatName, messageDirection} from '../public/chat-presentation.js';
const dots={id:'dots',name:'Dots',kind:'agent'},muse={id:'muse',name:'Muse',kind:'agent'},owner={id:'owner',name:'Owner',kind:'owner'};
test('direct chats show the peer; observed agent chats retain both names and direction',()=>{
 const thread={id:'dm',kind:'direct',participants:[dots,muse]};
 assert.equal(chatName(thread,null),'Dots, Muse');
 assert.equal(chatName(thread,'dots'),'Muse');
 assert.equal(messageDirection(thread,'muse','Muse'),'Muse → Dots');
 assert.deepEqual(threadPeople({members:[owner,dots]}),[owner,dots]);
 assert.deepEqual(threadPeople(null),[]);
});
test('archived conversations follow current contact status without deleting history',()=>{
 const dm={kind:'direct',participants:[owner,dots],message_count:9};
 const group={kind:'group',participants:[owner,dots,muse]};
 const before=structuredClone([dm,group]);
 assert.equal(archivedConversation(dm,[{...dots,active:0}]),true);
 assert.equal(archivedConversation(dm,[{...dots,active:1}]),false);
 assert.equal(archivedConversation(group,[{...dots,active:0}]),false);
 assert.equal(archivedConversation(group,[{...dots,active:0},{...muse,active:false}]),true);
 assert.equal(archivedConversation({kind:'direct',members:[owner,{id:'human',kind:'human'}]}),false);
 assert.deepEqual([dm,group],before);
});
test('agent avatars honor explicit choice before recognized product names',()=>{
 assert.equal(avatarIcon(dots),'/avatars/dots.svg');
 assert.equal(avatarIcon(muse),'/avatars/muse.svg');
 assert.equal(avatarIcon({...dots,avatar:'preset:grok'}),'/avatars/grok.svg');
 assert.equal(avatarIcon({name:'kk-codex'}),null);
});
