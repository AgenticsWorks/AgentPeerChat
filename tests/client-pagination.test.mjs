import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';

test('bounded page reads and full backlog drains preserve sequence across restart and ack',async t=>{
  const messages=Array.from({length:237},(_,i)=>({id:'msg_'+(i+1),seq:i+1,created_at:'2026-10-13T00:00:00Z',content:i?'small':'界'.repeat(5461)}));
  const acked=new Set(),calls=[];let stuck=false;
  const server=createServer((req,res)=>{
    const url=new URL(req.url,'http://fixture');calls.push(url.pathname);res.setHeader('Content-Type','application/json');
    if(url.pathname.endsWith('/ack')){acked.add(url.pathname.split('/').at(-2));res.end('{}');return;}
    const after=Number(url.searchParams.get('after')),pending=messages.filter(m=>m.seq>after&&!acked.has(m.id)),items=pending.slice(0,81);
    res.end(JSON.stringify({items,next_cursor:stuck?'0':String(items.at(-1)?.seq??after),has_more:pending.length>items.length}));
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));t.after(()=>new Promise(done=>server.close(done)));
  const env={...process.env,NODE_USE_ENV_PROXY:'0',AGENTPEERCHAT_CONFIG:'',AGENTPEERCHAT_URL:`http://127.0.0.1:${server.address().port}`,AGENTPEERCHAT_TOKEN:'fixture'};
  for(const key of Object.keys(env))if(/^(AGENTGRAM_|AGENTPENPAL_)/.test(key))delete env[key];
  const run=async(...args)=>JSON.parse((await promisify(execFile)(process.execPath,[resolve('cli/agentpeerchat.mjs'),...args],{env})).stdout);
  assert.deepEqual((await run('inbox')).map(m=>m.id),messages.map(m=>m.id));assert.equal(calls.length,3);
  assert.equal((await run('chats','--page')).items.length,81);assert.equal(calls.at(-1),'/api/v1/threads');
  const first=await run('inbox','--page');assert.equal(first.items.length,81);assert.equal(first.next_cursor,'81');assert.equal(first.has_more,true);
  assert.deepEqual((await run('inbox','--page')).items,first.items,'restart before ack replays all pending items');
  await run('ack',first.items[0].id);assert.equal((await run('inbox','--page')).items[0].seq,2,'restart after explicit ack excludes only acknowledged input');
  const second=await run('inbox','--page','--after',first.next_cursor);assert.equal(second.items[0].seq,82);
  assert.equal((await run('thread','thr_fixture','--page','--after','81')).items[0].seq,82);
  stuck=true;await assert.rejects(run('inbox'),/Pagination did not advance/);
  await assert.rejects(run('inbox','--page','--after','bad'),/bounded page/);
});
