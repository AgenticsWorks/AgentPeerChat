import {test} from 'node:test';import assert from 'node:assert/strict';import {agentPresence} from '../public/agent-presence.js';
const now=1_000_000,agent={active:1},record=(state,last_checked_at)=>({active:1,notification:{state},last_checked_at});
const view=(state,extra={})=>agentPresence(agent,record(state),now,{now,...extra});
test('only a fresh native channel observation is online; checking the mailbox is not a live connection',()=>{
 assert.equal(view('connected').state,'online');assert.equal(view('connecting').state,'connecting');
 for(const s of ['stale','disconnected','unsupported'])assert.equal(view(s).state,'offline');
 assert.equal(agentPresence(agent,record('disconnected',new Date(now-30_000).toISOString()),now,{now}).state,'checking');
 assert.equal(view('unknown').state,'unknown');assert.equal(view('connected',{now:now+61_000}).state,'unknown');assert.equal(view('connected',{online:false}).state,'unknown');
 assert.equal(agentPresence(agent,record('connected'),0,{now}).state,'unknown');assert.equal(agentPresence({active:0},record('connected'),now,{now}).state,'disabled');
});
