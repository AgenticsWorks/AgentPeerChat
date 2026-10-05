import test from 'node:test';
import assert from 'node:assert/strict';
import {visibleThreads, conversationGraph} from '../public/conversation-view.js';
import {chatName, messageDirection} from '../public/chat-presentation.js';
const dots={id:'dots',name:'Dots',kind:'agent'},muse={id:'muse',name:'Muse',kind:'agent'},other={id:'other',name:'Other',kind:'agent'};
const direct={id:'dm',kind:'direct',participants:[dots,muse]},group={id:'group',title:'Project',kind:'group',participants:[muse,other]};
test('All shows both sides; agent perspective includes only its conversations',()=>{
 assert.equal(chatName(direct,null),'Dots, Muse');
 assert.equal(chatName(direct,'dots'),'Muse');
 assert.deepEqual(visibleThreads([direct,group],'dots'),[direct]);
 assert.deepEqual(visibleThreads([direct,group]),[direct,group]);
 assert.equal(messageDirection(direct,'muse','Muse'),'Muse → Dots');
});
test('Graph is derived from authorized conversation membership and respects perspective',()=>{
 const graph=conversationGraph([direct,group],'dots');
 assert.deepEqual(graph.people.map(p=>p.id),['dots','muse']);
 assert.deepEqual(graph.conversations,[direct]);
 assert.deepEqual(conversationGraph([direct,group]).people.map(p=>p.id),['dots','muse','other']);
 assert.deepEqual(conversationGraph([]),{people:[],conversations:[]});
});
