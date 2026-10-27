// Headless native hosts retain their own sessions; mailbox state stays separate.
import {spawn} from 'node:child_process';import {mkdir,writeFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
export async function hostCliTurn({runner,root,prompt,binding,save,checkpoint,env,signal}){
 const host=runner.result_protocol;if(checkpoint?.phase==='running')throw Error('Native acceptance was interrupted; inspect this session before retrying side effects.');
 let inputFile,argv;if(host==='opencode')argv=['run','--dir',runner.cwd,'--format','json',...(binding?.native_id?['--session',binding.native_id]:[])];
 else{binding??={native_id:randomUUID(),runtime:host};await save(binding);await mkdir(join(root,'inputs'),{recursive:true,mode:0o700});inputFile=join(root,'inputs',randomUUID()+'.txt');await writeFile(inputFile,prompt,{mode:0o600});argv=['agent','--local','--json','--session-id',binding.native_id,'--message-file',inputFile,...(runner.agent_id?['--agent',runner.agent_id]:[]),'--timeout',String(runner.timeout_seconds)];}
 if(checkpoint?.save)await checkpoint.save({phase:'running',native_id:binding?.native_id});
 try{
  const output=await new Promise((resolve,reject)=>{
   const child=spawn(runner.argv[0],argv,{cwd:runner.cwd,env:{...env,PWD:runner.cwd},stdio:['pipe','pipe','pipe']});let stdout='',tail='',failed=false,saves=Promise.resolve(),kill;
   const stop=()=>{failed=true;child.kill('SIGTERM');kill=setTimeout(()=>child.kill('SIGKILL'),3000);kill.unref();};const timer=setTimeout(stop,runner.timeout_seconds*1000);signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
   child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>2*1024*1024)return stop();if(host==='opencode'){tail+=chunk;let end;while((end=tail.indexOf('\n'))>=0){const line=tail.slice(0,end);tail=tail.slice(end+1);try{const event=JSON.parse(line);if(event.sessionID&&!binding){binding={native_id:event.sessionID,runtime:host};saves=saves.then(()=>save(binding));}}catch{}}}});
   child.stderr.on('data',()=>{});child.on('error',()=>{failed=true;});child.on('close',async code=>{clearTimeout(timer);clearTimeout(kill);signal?.removeEventListener('abort',stop);try{await saves;if(code!==0||failed)throw Error('Native host failed; messages remain pending.');resolve(stdout);}catch(error){reject(error);}});child.stdin.on('error',()=>{});child.stdin.end(host==='opencode'?prompt:'');
  });
  if(host==='opencode'){
   const events=output.split('\n').flatMap(line=>{try{return[JSON.parse(line)];}catch{return[];}});if(events.some(e=>e.type==='error'||e.part?.tool&&/permission.*(denied|reject)/i.test(e.part.state?.error||'')))throw Error('OpenCode failed or denied required tools; messages remain pending.');
   if(!binding?.native_id||events.some(e=>e.sessionID&&e.sessionID!==binding.native_id))throw Error('OpenCode session identity changed.');
   const text=events.filter(e=>e.type==='text').map(e=>e.part?.text||'').join('\n').trim();if(!text||!events.some(e=>e.type==='step_finish'&&e.part?.reason==='stop'))throw Error('OpenCode did not report successful completion.');return text;
  }
  let result;try{result=JSON.parse(output);}catch{throw Error('OpenClaw returned invalid output.');}
  if(result.meta?.aborted||result.meta?.stopReason==='error'||result.meta?.agentMeta?.sessionId!==binding.native_id)throw Error('OpenClaw did not complete this native session.');
  const text=(result.payloads||[]).map(p=>p.text||'').join('\n').trim();if(!text)throw Error('OpenClaw returned no answer.');return text;
 }finally{if(inputFile)await rm(inputFile,{force:true});}
}
