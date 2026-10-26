// Optional ingress only. The outbound notification socket and durable mailbox do
// not wait for this process, its download, DNS, or Cloudflare's edge connection.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {access,chmod,mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {delimiter,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const release='2026.9.1';
const pause=(ms,signal)=>new Promise(resolve=>{
 if(signal.aborted)return resolve();
 const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
 const timer=setTimeout(done,ms);signal.addEventListener('abort',done,{once:true});
});
export async function cloudflaredBinary({root,env=process.env,signal,fetchImpl=fetch}){
 if(env.AGENTPEERCHAT_CLOUDFLARED)return env.AGENTPEERCHAT_CLOUDFLARED;
 const executable=process.platform==='win32'?'cloudflared.exe':'cloudflared';
 for(const directory of (env.PATH||'').split(delimiter).filter(Boolean)){
  const path=join(directory,executable);try{await access(path,constants.X_OK);return path;}catch{}
 }
 const arch={x64:'amd64',arm64:'arm64',arm:'arm'}[process.arch];
 const platform={linux:'linux',darwin:'darwin',win32:'windows'}[process.platform];
 if(!arch||!platform)throw Error('No cloudflared build for this host; outbound receiving remains active.');
 const assetName=`cloudflared-${platform}-${arch}`+(platform==='windows'?'.exe':platform==='darwin'?'.tgz':'');
 const cache=join(root,'cloudflared',release),binary=join(cache,executable),manifest=join(cache,'digest.json');
 const sha=data=>createHash('sha256').update(data).digest('hex');
 try{const saved=JSON.parse(await readFile(manifest,'utf8'));if(saved.asset===assetName&&/^[a-f0-9]{64}$/.test(saved.sha256)&&sha(await readFile(binary))===saved.sha256)return binary;}catch{}
 const get=async url=>{const response=await fetchImpl(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(60000)]),headers:{Accept:'application/vnd.github+json','User-Agent':'AgentPeerChat'}});if(!response.ok)throw Error('Official cloudflared download unavailable.');return response;};
 const metadata=await (await get(`https://api.github.com/repos/cloudflare/cloudflared/releases/tags/${release}`)).json();
 const asset=metadata.assets?.find(item=>item.name===assetName);
 if(!asset||!/^sha256:[a-f0-9]{64}$/.test(asset.digest||''))throw Error('Official cloudflared checksum unavailable.');
 const download=new URL(asset.browser_download_url);
 if(download.origin!=='https://github.com'||download.pathname!==`/cloudflare/cloudflared/releases/download/${release}/${assetName}`)throw Error('Unexpected cloudflared download origin.');
 const response=await get(download);let length=0;const chunks=[];
 for await(const chunk of response.body){length+=chunk.byteLength;if(length>100*1024*1024)throw Error('cloudflared download too large.');chunks.push(chunk);}
 const bytes=Buffer.concat(chunks);if('sha256:'+sha(bytes)!==asset.digest)throw Error('cloudflared checksum mismatch.');
 await mkdir(cache,{recursive:true,mode:0o700});const temporary=join(cache,randomUUID());
 try{
  await mkdir(temporary,{mode:0o700});const archive=join(temporary,assetName);await writeFile(archive,bytes,{mode:0o600});let source=archive;
  if(platform==='darwin'){
   // The archive is the checksum-verified official release; extract one member.
   await new Promise((resolve,reject)=>{const child=spawn('tar',['-xzf',archive,'-C',temporary,'cloudflared'],{stdio:'ignore',signal});child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error('cloudflared extraction failed.')));});
   source=join(temporary,'cloudflared');
  }
  await chmod(source,0o700);const digest=sha(await readFile(source));
  await rename(source,binary);await writeFile(manifest,JSON.stringify({asset:assetName,sha256:digest}),{mode:0o600});
 }finally{await rm(temporary,{recursive:true,force:true});}
 return binary;
}

async function stopChild(child){
 if(child.exitCode!==null||child.signalCode)return;
 await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},2000);child.once('close',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');});
}
export function startQuickTunnel({origin,root,env=process.env,signal,onReady,onUnavailable,
 resolveBinary=cloudflaredBinary,spawnImpl=spawn,startupMs=45000,retryMs=1000}){
 const controller=new AbortController();const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 let child,state='starting',endpoint=null,closed=false;
 const task=(async()=>{
  let failures=0;
  while(!controller.signal.aborted){
   try{
    state='starting';const binary=await resolveBinary({root,env,signal:controller.signal});controller.signal.throwIfAborted();
    // Do not inherit the user's tunnel/account configuration or require a login.
    const isolated=join(root,'cloudflared-home');await mkdir(isolated,{recursive:true,mode:0o700});await writeFile(join(isolated,'config.yml'),'{}\n',{mode:0o600});
    const childEnv={...env};for(const key of Object.keys(childEnv))if(key.startsWith('TUNNEL_'))delete childEnv[key];
    child=spawnImpl(binary,['--no-autoupdate','tunnel','--config',join(isolated,'config.yml'),'--url',origin,'--protocol','http2'],{env:childEnv,stdio:['ignore','pipe','pipe']});
    let registered=false,candidate=null,notified=false,buffer='',readyTask;const lines=[],attempt=new AbortController();
    try{
     await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>fail(Error('Tunnel startup timed out.')),startupMs);
      const abortAttempt=()=>fail(Error('Tunnel stopping.'));
      const finish=fn=>value=>{clearTimeout(timeout);controller.signal.removeEventListener('abort',abortAttempt);fn(value);};
      const fail=finish(reject),done=finish(resolve);
      controller.signal.addEventListener('abort',abortAttempt,{once:true});
      child.once('error',()=>fail(Error('cloudflared could not start.')));child.once('close',()=>done());
      const line=value=>{
       buffer=(buffer+value+'\n').slice(-8192);
       candidate??=buffer.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com\b/i)?.[0];
       registered||=/Registered tunnel connection/.test(buffer);
       if(candidate&&registered&&!notified){
        notified=true;
        readyTask=(async()=>{await onReady(candidate,attempt.signal);if(controller.signal.aborted||attempt.signal.aborted||child.exitCode!==null||child.signalCode)return;endpoint=candidate;state='ready';failures=0;clearTimeout(timeout);})().catch(()=>fail(Error('Tunnel endpoint verification failed.')));
       }
      };
      for(const stream of [child.stdout,child.stderr]){const reader=createInterface({input:stream});reader.on('line',line);lines.push(reader);}
     });
    }finally{attempt.abort();for(const reader of lines)reader.close();await stopChild(child);await readyTask;}
   }catch{/* Retain mailbox receiving; retry only the acceleration path. */}
   endpoint=null;state=controller.signal.aborted?'stopped':'retrying';await onUnavailable().catch(()=>{});
   if(!controller.signal.aborted)await pause(Math.min(300000,retryMs*2**Math.min(failures++,9)),controller.signal);
  }
 })();
 return {get state(){return state;},get endpoint(){return endpoint;},close:async()=>{if(closed)return task;closed=true;abort();await task;signal?.removeEventListener('abort',abort);}};
}
