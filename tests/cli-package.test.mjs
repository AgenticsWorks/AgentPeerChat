import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
function run(file,args,env,input=''){return new Promise(resolveResult=>{const child=spawn(file,args,{env:{...process.env,...env,HTTP_PROXY:'',HTTPS_PROXY:'',http_proxy:'',https_proxy:'',ALL_PROXY:'',all_proxy:''}});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.stdin.end(input);child.on('exit',code=>resolveResult({code,stdout,stderr}));});}
test('installable CLI pairs with one identity, selects its private profile and distributes a working skill', {timeout:30000}, async t=>{
 const directory=await mkdtemp(join(tmpdir(),'agentgram-package-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const home=join(directory,'home'),prefix=join(directory,'tools');await mkdir(home,{recursive:true});const env={HOME:home,AGENTGRAM_CONFIG:'',AGENTGRAM_TOKEN:'',AGENTGRAM_URL:'',NODE_USE_ENV_PROXY:'0'};
 let result=await run('npm',['install','--global','--prefix',prefix,'--ignore-scripts','--no-audit','--no-fund',resolve('dist/agentgram-cli.tgz')],env);assert.equal(result.code,0,result.stderr);
 const cli=join(prefix,'bin','agentgram');result=await run(cli,['--help'],env);assert.equal(result.code,0,result.stderr);assert.ok(result.stdout.includes('one CLI'));assert.ok(!result.stdout.includes('Claude'));
 result=await run(cli,['skill','--install',join(directory,'skills','agentgram')],env);assert.equal(result.code,0,result.stderr);assert.ok((await readFile(join(directory,'skills','agentgram','SKILL.md'),'utf8')).includes('agentgram ack'));
 let proof,approved=false,sends=0;const calls=[];
 const server=createServer(async(req,res)=>{calls.push(req.method+' '+req.url);res.setHeader('Content-Type','application/json');let text='';for await(const bytes of req)text+=bytes;const body=text?JSON.parse(text):{};
 if(req.url==='/api/v1/pairings/request'){proof=body.token_hash;assert.equal(body.code,'agp_fixture');return res.end(JSON.stringify({principal:{id:'agt_fixture'},pairing:{id:'pair_fixture',status:'pending',verification_code:'PACK-1234',expires_at:new Date(Date.now()+15000).toISOString()}}));}
 if(req.url==='/api/v1/pairings/pair_fixture/check'){assert.equal(createHash('sha256').update(body.token).digest('hex'),proof);approved=true;return res.end(JSON.stringify({principal:{id:'agt_fixture'},owner_id:'hum_owner',token_id:'tok_fixture',pairing:{id:'pair_fixture',status:'approved'}}));}
 assert.ok(approved,'No authenticated request before approval');assert.equal(createHash('sha256').update(req.headers.authorization.slice(7)).digest('hex'),proof);
 if(req.url==='/api/v1/me')return res.end(JSON.stringify({principal:{id:'agt_fixture',kind:'agent',name:'Muse'}}));
 if(req.url==='/api/v1/messages'){sends++;return res.end(JSON.stringify({message:{id:'msg_fixture'},replayed:false}));}
 if(req.url.startsWith('/api/v1/inbox?'))return res.end(JSON.stringify({items:[{id:'msg_peer',thread_id:'thr_group',content:'请审阅结果'}],next_cursor:'1',has_more:false}));
 if(req.url.startsWith('/api/v1/threads?'))return res.end(JSON.stringify({items:[{id:'thr_group',title:'机会讨论',participants:[]}],next_cursor:'1',has_more:false}));
 res.statusCode=404;res.end('{}');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const config={url:`http://127.0.0.1:${server.address().port}`,principal_id:'agt_fixture',owner_id:'hum_owner',pairing:{id:'pair_fixture',code:'agp_fixture'}};
 result=await run(cli,['join'],env,JSON.stringify(config));assert.equal(result.code,0,result.stderr);assert.ok(result.stdout.includes('PACK-1234'));assert.ok(!result.stdout.includes('agp_fixture'));assert.equal(sends,1);
 const profile=join(home,'.config','agentgram','agt_fixture','config.json');assert.equal((await stat(profile)).mode&0o777,0o600);assert.equal(JSON.parse(await readFile(profile,'utf8')).pairing,undefined);
 result=await run(cli,['me'],env);assert.equal(result.code,0,result.stderr);assert.equal(JSON.parse(result.stdout).principal.name,'Muse');
 result=await run(cli,['summary','--once'],env);assert.equal(result.code,0,result.stderr);assert.equal(JSON.parse(result.stdout).pending_count,1);assert.equal(JSON.parse(result.stdout).new_chats.length,1);assert.equal(sends,1);assert.ok(!calls.some(c=>c.includes('/ack')));
 await mkdir(join(home,'.config','agentgram','agt_second'));await writeFile(join(home,'.config','agentgram','agt_second','config.json'),await readFile(profile));
 result=await run(cli,['me'],env);assert.equal(result.code,1);assert.ok(result.stderr.includes('Multiple agent profiles'));
 result=await run(cli,['--profile','agt_fixture','me'],env);assert.equal(result.code,0,result.stderr);
});
