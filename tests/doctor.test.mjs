import test from 'node:test';
import assert from 'node:assert/strict';
import {doctor} from '../scripts/doctor.mjs';
const time=Date.parse('2026-10-15T12:00:00Z');
function options(overrides={}){
 return {token:'private-fixture',url:'https://example.test',now:time,config:{principal_id:'agt_peer'},
 request:async path=>path==='/me'?{principal:{id:'agt_peer',name:'Muse',kind:'agent'}}:{agent:{id:'agt_peer'},pending:true},
 listenerStatus:async()=>({installed:false}),...overrides};
}
test('doctor is read-only and distinguishes connection from native/manual receiving',async()=>{
 const calls=[];const settings=options();const report=await doctor({...settings,request:async path=>{calls.push(path);return settings.request(path);}});
 assert.deepEqual(calls,['/me','/probe']);assert.equal(report.connected,true);assert.equal(report.pending,true);
 assert.equal(report.state,'connected_manual_or_external');assert.equal(report.receiving.verified,false);
 assert.ok(!JSON.stringify(report).includes('private-fixture'));
});
test('missing credentials, conflicting overrides and mismatched identities do not report connected',async()=>{
 for(const overrides of [{token:undefined},{config:{token:'different'}},{config:{principal_id:'agt_other'}},{request:async()=>{throw new Error('secret-fixture');}}]){
  const report=await doctor(options(overrides));assert.equal(report.ok,false);assert.equal(report.connected,false);assert.ok(!JSON.stringify(report).includes('secret-fixture'));
 }
});
test('timer installation alone is unverified; verified receiving requires actual processing and ACK',async()=>{
 const status={installed:true,active:true,enabled:true,interval_seconds:60,task_id:'fixture.timer'};
 let report=await doctor(options({listenerStatus:async()=>status}));assert.equal(report.state,'receiving_unverified');
 status.last_check={checked_at:new Date(time).toISOString(),success:true};
 status.last_model_check={success:true,model_started:true,model_finished_at:new Date(time-1000).toISOString()};
 report=await doctor(options({listenerStatus:async()=>status}));assert.equal(report.state,'receiving_unverified');
 status.last_model_check.acknowledged=1;report=await doctor(options({listenerStatus:async()=>status}));assert.equal(report.state,'receiving_verified');assert.equal(report.receiving.verified,true);
 for(const changes of [{active:false},{last_check:{checked_at:new Date(time).toISOString(),success:false,error:'secret-fixture'}},{last_check:{checked_at:new Date(time-3600000).toISOString(),success:true}}]){
  report=await doctor(options({listenerStatus:async()=>({...status,...changes})}));assert.equal(report.state,'needs_attention');assert.equal(report.receiving.verified,false);assert.ok(!JSON.stringify(report).includes('secret-fixture'));
 }
});
test('outbox failures are visible without exposing message contents',async()=>{
 const report=await doctor(options({listenerStatus:async()=>({installed:false,queued:3,failed_queued:1})}));
 assert.equal(report.ok,false);assert.equal(report.state,'needs_attention');assert.deepEqual(report.scheduled_messages,{queued:3,failed:1});
});
test('missing probe support and corrupt local state are explicit instead of being called healthy',async()=>{
 const report=await doctor(options({request:async path=>{if(path==='/me')return {principal:{id:'agt_peer',kind:'agent'}};throw new Error('404');},listenerStatus:async()=>{throw new Error('secret-local-state');}}));
 assert.equal(report.connected,true);assert.equal(report.ok,false);assert.ok(report.checks.find(c=>c.id==='mailbox'&&c.status==='warn'));assert.ok(!JSON.stringify(report).includes('secret-local-state'));
});
