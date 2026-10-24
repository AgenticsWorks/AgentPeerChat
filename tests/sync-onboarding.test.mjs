import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {onboard,detectRuntime} from '../scripts/onboarding.mjs';
import {connectionInstructions} from '../public/connection-kit.js';
test('default connection packet carries automatic receiving in executable configuration',()=>{
 const text=connectionInstructions({url:'https://example.test/team',principal:{id:'agt_peer',name:'Muse'},pairing:{id:'pair_one',code:'agp_one'},ownerId:'hum_owner'});
 const config=JSON.parse(text.match(/AGENTPEERCHAT_CONFIG_JSON'\n([\s\S]*?)\nAGENTPEERCHAT_CONFIG_JSON/)[1]);
 assert.equal(config.receiving.mode,'auto');assert.equal(config.url,'https://example.test/team');
 assert.match(text,/Do not ask for another confirmation/);assert.match(text,/agentpeerchat-cli.tgz/);
});
test('a host without a wake API installs the skill but never claims a listener; manual choice survives retries',async t=>{
 const home=await mkdtemp(join(tmpdir(),'apc-auto-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const profile=join(home,'config.json');await writeFile(profile,JSON.stringify({url:'https://example.test',principal_id:'agt_peer',token:'fixture'}));
 const args={profile,cli:resolve('cli/agentpeerchat.mjs'),skillSource:resolve('skills/agentpeerchat/SKILL.md'),env:{HOME:home,PATH:''}};
 const automatic=await onboard(args);assert.equal(automatic.status,'native_wake_required');
 assert.equal(automatic.receiving.mode,'auto');assert.match(await readFile(join(automatic.skill_directory,'SKILL.md'),'utf8'),/Automatic receiving/);
 await assert.rejects(readFile(profile+'.automation/listener.json'),{code:'ENOENT'});
 const manual=await onboard({...args,preference:{mode:'manual'}});assert.equal(manual.status,'manual');
 const retry=await onboard({...args,preference:{mode:'auto'}});assert.equal(retry.status,'manual');
 assert.equal(JSON.parse(await readFile(profile+'.onboarding.json','utf8')).receiving.mode,'manual');
});
test('runtime detection respects actual host capability and does not guess between unrelated runtimes',async t=>{
 const home=await mkdtemp(join(tmpdir(),'apc-runtime-'));t.after(()=>rm(home,{recursive:true,force:true}));
 for(const runtime of ['codex','claude'])await writeFile(join(home,runtime),'#!/bin/sh\nexit 0\n',{mode:0o700});
 assert.equal(await detectRuntime({PATH:home}),null);
 assert.equal(await detectRuntime({PATH:home,CODEX_THREAD_ID:'supplied-by-runtime'}),'codex');
 assert.equal(await detectRuntime({PATH:home,CLAUDECODE:'1'}),'claude');
});
test('an ordinary Claude setup socket is not mistaken for a persistent receiving session', {timeout:20000},async t=>{
 const {createServer}=await import('node:http');const {createServer:createSocket}=await import('node:net');const {automation}=await import('../scripts/automation.mjs');
 const home=await mkdtemp(join(tmpdir(),'apc-ephemeral-')),profile=join(home,'profile.json'),socket=join(home,'setup.sock'),cli=resolve('cli/agentpeerchat.mjs');
 const local=createSocket();local.listen(socket);await new Promise(done=>local.once('listening',done));
 const server=createServer((req,res)=>{res.setHeader('Content-Type','application/json');if(req.url==='/api/v1/me')return res.end(JSON.stringify({principal:{id:'agt_peer',kind:'agent'}}));if(req.url==='/api/v1/probe')return res.end(JSON.stringify({agent:{id:'agt_peer'},pending:false,membership_cursor:'0'}));res.statusCode=404;res.end('{}');});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));
 await writeFile(profile,JSON.stringify({url:'http://127.0.0.1:'+server.address().port,principal_id:'agt_peer',token:'private-fixture'}),{mode:0o600});
 const runtime=join(home,'fake-claude');
 await writeFile(runtime,'#!/bin/sh\nprintf \'%s\\n\' \'{"type":"result","subtype":"success","is_error":false}\'\n',{mode:0o700});
 const env={HOME:home,PATH:'/usr/bin:/bin',CLAUDECODE:'1',CLAUDE_CODE_MESSAGING_SOCKET:socket,AGENTPEERCHAT_CLAUDE_CLI:runtime,NODE_USE_ENV_PROXY:'0',AGENTPEERCHAT_CONFIG:profile};
 t.after(async()=>{await automation('listen',['remove'],{cli,env});server.closeAllConnections();await new Promise(done=>server.close(done));await new Promise(done=>local.close(done));await rm(home,{recursive:true,force:true});});
 const result=await onboard({profile,cli,skillSource:resolve('skills/agentpeerchat/SKILL.md'),env});
 assert.equal(result.status,'receiving_configured');assert.equal(result.listener.interval_seconds,1800);
 const runner=JSON.parse(await readFile(profile+'.automation/runner.json','utf8'));
 assert.equal(runner.mode,'native');assert.equal(runner.argv[0],runtime);
});
