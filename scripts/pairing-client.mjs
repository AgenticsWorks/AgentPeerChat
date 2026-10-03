import {randomBytes,createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,chmod,unlink} from 'node:fs/promises';
import {join} from 'node:path';
// Persist the locally generated proof so interrupted installs can retry the same invitation.
export async function completePairing(config,directory,{fetchImpl=fetch,notify=console.log,wait=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 const file=join(directory,'pending-pairing.json');await mkdir(directory,{recursive:true,mode:0o700});
 let saved;
 try{saved=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 if(!saved||saved.id!==config.pairing.id){saved={id:config.pairing.id,token:'agt_'+randomBytes(32).toString('hex')};await writeFile(file,JSON.stringify(saved),{mode:0o600});await chmod(file,0o600);}
 const call=async(path,data)=>{
  const response=await fetchImpl(config.url.replace(/\/$/,'')+'/api/v1'+path,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error('配对邀请无效、已使用或已过期，请让拥有者重新发起连接。');return response.json();
 };
 let result=await call('/pairings/request',{code:config.pairing.code,token_hash:createHash('sha256').update(saved.token).digest('hex')});
 if(result.pairing.id!==config.pairing.id||result.principal.id!==config.principal_id)throw new Error('配对身份不匹配。');
 notify('配对码：'+result.pairing.verification_code+'。请拥有者在网页核对并允许连接。');
 const expires=Date.parse(result.pairing.expires_at);
 while(result.pairing.status==='pending'&&Date.now()<expires){await wait(3000);result=await call('/pairings/'+config.pairing.id+'/check',{token:saved.token});}
 if(result.pairing.status!=='approved')throw new Error('配对被拒绝或已过期，未获得通信权限。');
 const {pairing,...rest}=config;
 return {...rest,token:saved.token,token_id:result.token_id,owner_id:result.owner_id};
}
export async function clearPairing(directory){await unlink(join(directory,'pending-pairing.json')).catch(error=>{if(error.code!=='ENOENT')throw error;});}
