import test from 'node:test';
import assert from 'node:assert/strict';
import {threadPeople, visibleThreads, conversationGraph} from '../public/conversation-view.js';
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
test('disabled contacts and direct edges are hidden by default while mixed groups and history survive',()=>{
 const disabled={...other,active:0,sent_count:4},enabled={...muse,active:1,sent_count:3};
 const history=[
  {id:'disabled-dm',kind:'direct',participants:[enabled,disabled],message_count:7},
  {id:'mixed-group',kind:'group',title:'History',participants:[enabled,disabled,dots],message_count:12},
  {id:'disabled-group',kind:'group',participants:[disabled],message_count:4}
 ];
 const before=structuredClone(history),graph=conversationGraph(history);
 assert.deepEqual(graph.people.map(p=>p.id),['muse','dots']);
 assert.deepEqual(graph.conversations.map(t=>t.id),['mixed-group']);
 assert.deepEqual(threadPeople(graph.conversations[0]).map(p=>p.id),['muse','dots']);
 assert.equal(graph.conversations[0].message_count,12,'group counts describe retained history');
 assert.equal(graph.people[0].sent_count,3);
 const all=conversationGraph(history,'all',{showDisabled:true});
 assert.deepEqual(all.conversations,history);
 assert.equal(all.people.find(p=>p.id==='other').active,0,'renderer receives the disabled state');
 assert.deepEqual(history,before,'filtering must not mutate chat history');
 assert.deepEqual(visibleThreads(history,'other'),history,'normal chat access is unaffected');
});
test('latest directory status overrides missing or stale membership status without adding unrelated contacts',()=>{
 const history=[{...direct,participants:[{...dots,active:1},muse]}];
 const principals=[{...dots,active:0},{...muse,active:1},{...other,active:1}];
 assert.deepEqual(conversationGraph(history,'all',{principals}),{people:[],conversations:[]});
 const shown=conversationGraph(history,'all',{principals,showDisabled:true});
 assert.deepEqual(shown.people.map(p=>[p.id,p.active]),[['dots',0],['muse',1]]);
 const enabledAgain=principals.map(p=>({...p,active:1}));
 assert.deepEqual(conversationGraph(history,'all',{principals:enabledAgain}).people.map(p=>p.id),['dots','muse']);
 assert.equal(history[0].participants[0].active,1,'directory join is a projection');
});
test('disabled perspectives and legacy member lists respect the filter without orphan groups',()=>{
 const disabled={...other,active:false};
 const history=[{id:'legacy',kind:'group',members:[dots,disabled]}, {id:'empty',kind:'group',members:[]}];
 assert.deepEqual(conversationGraph(history,'other'),{people:[],conversations:[]});
 assert.deepEqual(conversationGraph(history,'other',{showDisabled:true}).people.map(p=>p.id),['dots','other']);
 const graph=conversationGraph(history,'dots');
 assert.deepEqual(graph.people,[dots]);
 assert.deepEqual(graph.conversations[0].members,[dots]);
 assert.equal(history[0].members.length,2);
 assert.deepEqual(conversationGraph(history,'unrelated',{showDisabled:true}),{people:[],conversations:[]});
});
