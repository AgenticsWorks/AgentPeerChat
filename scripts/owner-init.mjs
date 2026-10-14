import {readFile,writeFile,mkdir,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

// An agent-assisted deploy can finish owner creation and hand back a private sign-in link.
export async function initializeOwner({url,name='Owner',setupSecret,directory}){
 const parsed=new URL(url);if(parsed.username||parsed.password||parsed.search||parsed.hash||!(parsed.protocol==='https:'||parsed.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)))throw new Error('Use the deployed HTTPS instance URL.');
 const origin=parsed.href.replace(/\/$/,'');
 async function api(path,body,key){
  const deadline=Date.now()+60000;let attempt=0;
  while(true){
   try{
    const r=await fetch(origin+'/api/v1'+path,{method:body?'POST':'GET',redirect:'error',headers:{...(body?{'Content-Type':'application/json'}:{}),...(key?{Authorization:'Bearer '+key}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
    let d;try{d=await r.json();}catch{const e=new Error('Instance API is not ready yet.');e.status=r.status;throw e;}
    if(!r.ok){const e=new Error('Owner initialization '+path+' returned '+r.status);e.status=r.status;throw e;}
    if(path==='/status'&&typeof d.initialized!=='boolean')throw new Error('Instance API is not ready yet.');
    return d;
   }catch(error){
    if(body||Date.now()>=deadline||error.status&&[400,401,403].includes(error.status))throw error;
    await new Promise(done=>setTimeout(done,Math.min(1000*++attempt,5000)));
   }
  }
 }

 const file=join(directory,'owner-access.json');
 if((await api('/status')).initialized){
  let saved;try{saved=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(saved?.url===origin&&saved.access_key){const me=await api('/me',undefined,saved.access_key);if(me.principal.kind!=='owner')throw new Error('Saved key does not identify the owner.');return {initialized:true,reused:true,file};}
  return {initialized:true,reused:false,requires_existing_login:true};
 }
 if(typeof setupSecret!=='string'||setupSecret.length<24)throw new Error('A valid deployment setup secret is required.');
 const result=await api('/setup',{name,setup_secret:setupSecret});
 await mkdir(directory,{recursive:true,mode:0o700});const temporary=file+'.'+randomUUID()+'.tmp';
 try{await writeFile(temporary,JSON.stringify({url:origin,principal_id:result.principal.id,access_key:result.access_key,sign_in_url:origin+'/#access_key='+encodeURIComponent(result.access_key)},null,2)+'\n',{mode:0o600});await rename(temporary,file);}finally{await rm(temporary,{force:true});}
 return {initialized:true,reused:false,file};
}
