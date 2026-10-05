import type { Env, Principal } from './types';
import { body, fail, hash, id, owner, secret, str } from './security';
interface Pairing { id:string; principal_id:string; created_by:string; code_hash:string; token_id:string; token_hash:string|null; verification_code:string|null; status:string; expires_at:string }
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const time=()=>new Date().toISOString();
async function visible(env:Env,row:Pairing){
  const principal=await env.DB.prepare('SELECT * FROM principals WHERE id = ?').bind(row.principal_id).first<Principal>();
  return {pairing:{id:row.id,status:row.status,verification_code:row.verification_code,expires_at:row.expires_at},principal,owner_id:row.created_by,token_id:row.token_id};
}
export async function pairingPublic(request:Request,env:Env,path:string){
  if(path==='/pairings/request'&&request.method==='POST'){
    const b=await body(request),code=str(b.code,'code',256),tokenHash=str(b.token_hash,'token_hash',64);
    if(!/^[a-f0-9]{64}$/.test(tokenHash))fail(400,'invalid_field','Provide a SHA-256 token hash.');
    const codeHash=await hash(code);
    const row=await env.DB.prepare('SELECT * FROM pairings WHERE code_hash = ? AND expires_at > ?').bind(codeHash,time()).first<Pairing>();
    if(!row||row.status==='rejected')fail(410,'invalid_pairing','Pairing invitation expired, revoked, or already used.');
    const fingerprint=(await hash(row.id+':'+tokenHash)).slice(0,8).toUpperCase();
    const verification=fingerprint.slice(0,4)+'-'+fingerprint.slice(4);
    await env.DB.prepare("UPDATE pairings SET token_hash = ?, verification_code = ?, status = 'pending' WHERE id = ? AND status = 'invited' AND expires_at > ?")
      .bind(tokenHash,verification,row.id,time()).run();
    const actual=await env.DB.prepare('SELECT * FROM pairings WHERE id = ?').bind(row.id).first<Pairing>();
    if(!actual||actual.token_hash!==tokenHash||actual.status==='rejected')fail(410,'invalid_pairing','Pairing invitation is already used.');
    return json(await visible(env,actual));
  }
  const match=/^\/pairings\/([^/]+)\/check$/.exec(path);
  if(match&&request.method==='POST'){
    const b=await body(request),token=str(b.token,'token',256);
    const row=await env.DB.prepare('SELECT * FROM pairings WHERE id = ? AND token_hash = ? AND expires_at > ?').bind(match[1],await hash(token),time()).first<Pairing>();
    if(!row)fail(410,'invalid_pairing','Pairing expired or proof is invalid.');
    return json(await visible(env,row));
  }
  return null;
}
export async function pairingOwner(request:Request,env:Env,path:string,p:Principal){
  if(path==='/pairings'&&request.method==='GET'){
    owner(p);
    return json({items:(await env.DB.prepare(`SELECT q.id,q.principal_id,q.status,q.verification_code,q.expires_at,p.name FROM pairings q JOIN principals p ON p.id = q.principal_id WHERE q.status IN ('invited','pending') AND q.expires_at > ? ORDER BY q.created_at DESC LIMIT 200`).bind(time()).all()).results});
  }
  if(path==='/pairings'&&request.method==='POST'){
    owner(p);const b=await body(request);let principal:Principal|null;
    const code=secret('agp'),pairId=id('pair'),expires=new Date(Date.now()+10*60000).toISOString(),tokenId=id('tok');
    const statements=[];
    if(b.principal_id!==undefined){
      principal=await env.DB.prepare("SELECT * FROM principals WHERE id = ? AND kind = 'agent'").bind(str(b.principal_id,'principal_id',80)).first<Principal>();
      if(!principal||!principal.active)fail(400,'invalid_principal','Choose an active Agent.');
    }else{
      const count=await env.DB.prepare('SELECT COUNT(*) AS n FROM principals').first<{n:number}>();
      if((count?.n??0)>=200)fail(409,'principal_limit','This instance supports up to 200 principals.');
      const name=b.name===undefined||b.name===''?'Unconnected agent':str(b.name,'name',80);
      principal={id:id('agt'),name,kind:'agent',description:'',active:0,created_at:time()};
      statements.push(env.DB.prepare("INSERT INTO principals(id,name,kind,active) VALUES (?,?,'agent',0)").bind(principal.id,name));
    }
    statements.push(env.DB.prepare('INSERT INTO pairings(id,principal_id,created_by,code_hash,token_id,expires_at) VALUES (?,?,?,?,?,?)').bind(pairId,principal.id,p.id,await hash(code),tokenId,expires));
    await env.DB.batch(statements);
    return json({principal,name_required:['Unconnected agent','待连接 Agent'].includes(principal.name),pairing:{id:pairId,code,expires_at:expires}},201);
  }
  const match=/^\/pairings\/([^/]+)\/(approve|reject)$/.exec(path);
  if(match&&request.method==='POST'){
    owner(p);const row=await env.DB.prepare('SELECT * FROM pairings WHERE id = ? AND expires_at > ?').bind(match[1],time()).first<Pairing>();
    if(!row)fail(410,'invalid_pairing','Pairing invitation has expired.');
    if(match[2]==='reject'){
      const changed=await env.DB.prepare("UPDATE pairings SET status = 'rejected' WHERE id = ? AND status IN ('invited','pending')").bind(row.id).run();
      if(!changed.meta.changes)fail(409,'pairing_state','This request is already resolved.');
      return json({ok:true});
    }
    const b=await body(request);
    if(!row.token_hash||str(b.verification_code,'verification_code',20)!==row.verification_code)fail(400,'verification_mismatch','Check the code shown by your Agent.');
    await env.DB.batch([
      env.DB.prepare("UPDATE pairings SET status = 'approved' WHERE id = ? AND status = 'pending' AND expires_at > ?").bind(row.id,time()),
      env.DB.prepare("INSERT INTO tokens(id,principal_id,hash,label,kind) SELECT token_id,principal_id,token_hash,'Paired Agent device','access' FROM pairings WHERE id = ? AND status = 'approved' ON CONFLICT(id) DO NOTHING").bind(row.id),
      env.DB.prepare("UPDATE principals SET active = 1 WHERE id = ? AND EXISTS(SELECT 1 FROM pairings WHERE id = ? AND status = 'approved')").bind(row.principal_id,row.id)
    ]);
    const actual=await env.DB.prepare('SELECT * FROM pairings WHERE id = ?').bind(row.id).first<Pairing>();
    if(actual?.status!=='approved')fail(409,'pairing_state','This request is already resolved.');
    return json({ok:true});
  }
  return null;
}
