import {randomBytes,createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,chmod,unlink,rename} from 'node:fs/promises';
import {join} from 'node:path';
const baseOf=value=>String(value||'').replace(/\/+$/,'');
// Persist the locally generated proof so interrupted installs can retry the same invitation.
// `noWait` returns a safe pending descriptor instead of blocking: it never reveals the invitation
// code or the bearer proof and never returns access before the owner approves.
export async function completePairing(config,directory,{fetchImpl=fetch,notify=console.log,wait=ms=>new Promise(r=>setTimeout(r,ms)),noWait=false}={}){
 const file=join(directory,'pending-pairing.json');await mkdir(directory,{recursive:true,mode:0o700});
 const base=baseOf(config.url);
 let saved;
 try{saved=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 if(saved&&baseOf(saved.base)!==base)
  // A proof is bound to the instance that issued the invitation. It is never sent to another
  // origin or path, and an old file without a recorded instance is treated as unbound.
  throw new Error("A saved joining proof belongs to a different instance URL (or an older client saved it without one), so it was not sent anywhere. Delete "+file+" and ask for a new invitation.");
 if(!saved||saved.id!==config.pairing.id){saved={id:config.pairing.id,base,token:'agt_'+randomBytes(32).toString('hex')};await writeFile(file,JSON.stringify(saved),{mode:0o600});await chmod(file,0o600);}
 const call=async(path,data)=>{
  const response=await fetchImpl(base+'/api/v1'+path,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error("Pairing invitation is invalid, used, or expired. Ask the owner to create a new connection.");return response.json();
 };
 let result=await call('/pairings/request',{code:config.pairing.code,token_hash:createHash('sha256').update(saved.token).digest('hex')});
 if(result.pairing.id!==config.pairing.id||result.principal.id!==config.principal_id)throw new Error("Pairing identity does not match.");
 const expires=Date.parse(result.pairing.expires_at);
 if(noWait&&result.pairing.status==='pending'){
  if(!(Date.now()<expires))throw new Error("Pairing was rejected or expired. No communication access was granted.");
  return {pending:true,id:result.pairing.id,status:'pending',verification_code:result.pairing.verification_code,expires_at:result.pairing.expires_at};
 }
 if(result.pairing.status==='pending')notify("Pairing code: "+result.pairing.verification_code+". Ask the owner to match it and approve the connection in the web client.");
 while(result.pairing.status==='pending'&&Date.now()<expires){await wait(3000);result=await call('/pairings/'+config.pairing.id+'/check',{token:saved.token});}
 if(result.pairing.status!=='approved')throw new Error("Pairing was rejected or expired. No communication access was granted.");
 const {pairing,...rest}=config;
 return {...rest,token:saved.token,token_id:result.token_id,owner_id:result.owner_id};
}
export async function clearPairing(directory){await unlink(join(directory,'pending-pairing.json')).catch(error=>{if(error.code!=='ENOENT')throw error;});}
// A private local pointer from an invitation link to the identity that bound it. It stores no
// credential and is scoped to the validated instance base, so a different origin or deployment
// path cannot borrow it: only the same device, same instance resumes its own used invitation.
const locatorFile=(root,base,code)=>join(root,'invitations',createHash('sha256').update(base+'\n'+code).digest('hex')+'.json');
export async function rememberInvitation(root,base,code,invitation){
 const file=locatorFile(root,base,code),temporary=file+'.'+randomBytes(8).toString('hex')+'.tmp';
 try{
  await mkdir(join(root,'invitations'),{recursive:true,mode:0o700});
  await writeFile(temporary,JSON.stringify({...invitation,base:baseOf(base)})+'\n',{mode:0o600});await rename(temporary,file);await chmod(file,0o600);
 }catch(error){await unlink(temporary).catch(()=>{});throw error;}
}
export async function recallInvitation(root,base,code){
 let saved;
 try{saved=JSON.parse(await readFile(locatorFile(root,baseOf(base),code),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;return null;}
 // Only same-instance pointers with the expected shape are accepted.
 return typeof saved==='object'&&saved!==null&&baseOf(saved.base)===baseOf(base)&&['id','principal_id','owner_id'].every(key=>typeof saved[key]==='string'&&saved[key])?saved:null;
}
