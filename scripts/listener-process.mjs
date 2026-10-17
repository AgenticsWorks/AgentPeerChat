// A host-local supervisor for machines without a service manager. No network listener.
import {createServer,connect} from 'node:net';
import {readFile,writeFile,rm,chmod,open,lstat,rename,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {tmpdir,userInfo} from 'node:os';
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const stateFile=root=>join(root,'process.json');
async function state(root){try{return JSON.parse(await readFile(stateFile(root),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
export function systemdAvailable(system,env=process.env){
 if(process.platform!=='linux')return false;
 // A reachable manager still loads units from its own OS user's home, not a
 // sandbox's temporary HOME. Those hosts need the private process manager.
 if(!system&&env.HOME&&resolve(env.HOME)!==resolve(userInfo().homedir))return false;
 const r=spawnSync('systemctl',[...(system?[]:['--user']),'show-environment'],{env,timeout:5000,stdio:'ignore'});return r.status===0;
}
async function control(root,action){
 const saved=await state(root);if(!saved)return null;
 return new Promise(resolve=>{
  let data='',done=false;const client=connect(saved.socket),finish=value=>{if(done)return;done=true;clearTimeout(timer);client.destroy();resolve(value);};
  const timer=setTimeout(()=>finish(null),1500);client.on('error',()=>finish(null));
  client.on('connect',()=>client.end(JSON.stringify({action,nonce:saved.nonce})+'\n'));
  client.on('data',chunk=>{data+=chunk;if(data.length>8192)return finish(null);if(data.includes('\n'))try{finish(JSON.parse(data));}catch{finish(null);}});
  client.on('end',()=>finish(null));
 });
}
export async function processStatus(root){const value=await control(root,'status');return value||{active:false,watch_active:false};}
export async function stopProcess(root){
 const value=await control(root,'stop');
 if(!value)return;
 for(let i=0;i<80;i++){if(!(await processStatus(root)).active)return;await sleep(100);}
 throw Error('Listener supervisor is still stopping; retry remove.');
}
export async function startProcess({root,profile,cli,env}){
 const existing=await processStatus(root);if(existing.active&&!existing.stopping)return existing;if(existing.stopping)throw Error('Listener supervisor is still stopping; retry start.');
 const log=await open(join(root,'process.log'),'a',0o600);await log.chmod(0o600);
 // Use the profile on disk, not inherited credentials from an interactive shell.
 const childEnv={...env,AGENTPEERCHAT_CONFIG:profile};
 for(const k of Object.keys(childEnv))if(/^(AGENTPEERCHAT|AGENTGRAM|AGENTPENPAL)_(TOKEN|URL)$/.test(k))delete childEnv[k];
 let child;try{child=spawn(process.execPath,[cli,'listen','supervise'],{env:childEnv,detached:true,stdio:['ignore',log.fd,log.fd]});child.on('error',()=>{});child.unref();}finally{await log.close();}
 for(let i=0;i<80;i++){const value=await processStatus(root);if(value.active)return value;if(child.exitCode!==null||child.signalCode)break;await sleep(100);}
 throw Error('Background supervisor did not start. Run listen foreground in a persistent terminal, or inspect its private process.log.');
}
export async function supervise({root,profile,cli,env,everySeconds,onReady=async()=>{},onExit=async()=>{}}){
 const directory=join(tmpdir(),'agentpeerchat-'+(process.getuid?.()??'user'));await mkdir(directory,{recursive:true,mode:0o700});
 const owner=await lstat(directory);if(!owner.isDirectory()||typeof process.getuid==='function'&&owner.uid!==process.getuid()||owner.mode&0o077)throw Error('Supervisor socket directory must be private and owned by this user.');
 const socket=join(directory,createHash('sha256').update(root).digest('hex').slice(0,32)+'.sock');
 const previous=await processStatus(root);if(previous.active)throw Error('A supervisor already owns this profile.');
 try{const info=await lstat(socket);if(!info.isSocket()||typeof process.getuid==='function'&&info.uid!==process.getuid())throw Error('Unexpected supervisor socket; inspect it before restarting.');await rm(socket);}catch(e){if(e.code!=='ENOENT')throw e;}
 const nonce=randomBytes(32).toString('hex'),children=new Set();let stopping=false,watch,tick,timer,restart,stopResolve;const stopped=new Promise(r=>stopResolve=r);
 const launch=action=>{const p=spawn(process.execPath,[cli,'listen',action],{env:{...env,AGENTPEERCHAT_CONFIG:profile},stdio:'ignore',detached:process.platform!=='win32'});children.add(p);p.on('error',()=>{});p.on('close',()=>children.delete(p));return p;};
 const status=()=>({active:true,stopping,pid:process.pid,watch_active:!!watch&&watch.exitCode===null&&watch.signalCode===null,worker_pid:watch?.pid||null,tick_active:!!tick,started_at:started});
 const started=new Date().toISOString();
 const runTick=()=>{if(stopping||tick)return;tick=launch('run');tick.once('close',()=>tick=null);};
 const runWatch=()=>{if(stopping)return;watch=launch('watch');watch.once('close',()=>{watch=null;if(!stopping)restart=setTimeout(runWatch,1000);});};
 const stop=()=>{if(stopping)return;stopping=true;clearInterval(timer);clearTimeout(restart);stopResolve();};
 const server=createServer(client=>{client.setTimeout(1500,()=>client.destroy());let raw='';client.on('error',()=>{});client.on('data',c=>{raw+=c;if(raw.length>1024)return client.destroy();if(!raw.includes('\n'))return;let request;try{request=JSON.parse(raw);}catch{return client.destroy();}const candidate=Buffer.from(typeof request.nonce==='string'?request.nonce:'');const expected=Buffer.from(nonce);if(candidate.length!==expected.length||!timingSafeEqual(candidate,expected))return client.destroy();if(request.action==='status')client.end(JSON.stringify(status())+'\n');else if(request.action==='stop'){client.end('{"stopping":true}\n');stop();}else client.destroy();});});
 try{
  await new Promise((ok,fail)=>{server.once('error',fail);server.listen(socket,ok);});await chmod(socket,0o600);
  const temporary=stateFile(root)+'.'+process.pid+'.tmp';await writeFile(temporary,JSON.stringify({socket,nonce,pid:process.pid})+'\n',{mode:0o600});await rename(temporary,stateFile(root));await chmod(stateFile(root),0o600);
  process.once('SIGTERM',stop);process.once('SIGINT',stop);runWatch();timer=setInterval(runTick,everySeconds*1000);await onReady();await stopped;
 }finally{
  stop();process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);
  const terminate=signal=>{for(const p of children)try{if(process.platform!=='win32')process.kill(-p.pid,signal);else p.kill(signal);}catch(e){if(e.code!=='ESRCH')throw e;}};
  terminate('SIGTERM');for(let i=0;i<30&&children.size;i++)await sleep(100);terminate('SIGKILL');
  await new Promise(r=>server.close(r));await rm(socket,{force:true});await rm(stateFile(root),{force:true});await onExit();
 }
 return {stopped:true};
}
