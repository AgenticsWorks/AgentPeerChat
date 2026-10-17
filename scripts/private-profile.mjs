// A credential file is independent of the replaceable CLI and runtime installation.
import {readFile,mkdir,open,rename,rm,lstat,link} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
export async function readProfile(path){
 try{const data=JSON.parse(await readFile(path,'utf8'));if(!data||Array.isArray(data)||typeof data!=='object')throw Error();return data;}
 catch(error){if(error.code==='ENOENT')return null;throw Error('The saved identity configuration is unreadable or invalid. Restore the original private configuration; it was not overwritten.');}
}
export async function assertProfileTarget(path,identity){
 const previous=await readProfile(path);
 if(previous&&(typeof previous.url!=='string'||previous.url.replace(/\/+$/,'')!==identity.url.replace(/\/+$/,'')||previous.principal_id!==identity.principal_id))
  throw Error('This configuration already belongs to a different instance or Agent identity. It was not overwritten. Reuse the original configuration or select a separate private profile.');
 return previous;
}
export async function saveProfile(path,identity){
 path=resolve(path);const existing=await assertProfileTarget(path,identity);
 // Do not replace a credentials-provider symlink or a special secret mount.
 const previous=await lstat(path).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
 if(previous&&!previous.isFile())throw Error('The identity path is not a regular writable private file. Use the existing profile with me, or restore it through its credential provider.');
 await mkdir(dirname(path),{recursive:true,mode:0o700});
 const temporary=path+'.'+randomUUID()+'.tmp';let file;
 try{
  file=await open(temporary,'wx',0o600);await file.writeFile(JSON.stringify(identity,null,2)+'\n');await file.sync();await file.close();file=null;
  if(existing)await rename(temporary,path);
  else{
   // Atomic create: two first-time installs cannot replace one another's identities.
   try{await link(temporary,path);}catch(error){if(error.code==='EEXIST')throw Error('Another installation already saved an identity here. Reuse that private configuration; it was not overwritten.');throw error;}
   await rm(temporary);
  }
  // A successful rename plus directory sync keeps the committed identity across host crashes.
  // This guarantees a durable write only to the extent the selected filesystem supports it;
  // it does not turn an ephemeral volume into persistent storage.
  if(process.platform!=='win32'){const directory=await open(dirname(path),'r');try{await directory.sync();}finally{await directory.close();}}
 }finally{await file?.close();await rm(temporary,{force:true});}
}
