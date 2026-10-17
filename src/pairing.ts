import { avatarValue } from './avatar';
import type { Env, Principal } from './types';
import { body, fail, hash, id, secret, str } from './security';
interface Pairing { id:string; principal_id:string; created_by:string; code_hash:string; token_id:string; token_hash:string|null; verification_code:string|null; status:string; expires_at:string; approved_at?:string|null; approval_mark?:string|null; approval_required:number }
// Issuer conditions rechecked on every path that can still change an unresolved invitation,
// so removing the owner's delegation withdraws that Agent's still-open invitations at once.
const ISSUER_AUTHORIZED = `EXISTS (SELECT 1 FROM principals issuer WHERE issuer.id = pairings.created_by
  AND issuer.active = 1 AND (issuer.kind = 'owner' OR (issuer.kind = 'agent' AND issuer.can_invite_agents = 1)))`;
const QUOTA = 10;
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const time=()=>new Date().toISOString();
const nameRequired=(name:string|undefined)=>['Unconnected agent','待连接 Agent'].includes(name ?? '');
const delegated=(p:Principal)=>p.kind==='agent'&&p.can_invite_agents===1;
const unresolved=(row:Pairing)=>row.status==='invited'||row.status==='pending';
const NEEDS_GRANT='Ask the owner to allow invitations for this Agent once (Contact → Allow invitations on the instance). Never share the owner’s access key.';
function invitationBase(request:Request){
  // Keep a deployment subdirectory (for example /team/chat) in shared invitation URLs.
  return new URL(request.url).origin+new URL(request.url).pathname.replace(/\/api\/v1(?:\/.*)?$/,'');
}
async function ownerId(env:Env){
  const row=await env.DB.prepare("SELECT id FROM principals WHERE kind = 'owner' LIMIT 1").first<{id:string}>();
  return row?.id??null;
}
async function issuerAuthorized(env:Env,row:Pick<Pairing,'created_by'>){
  const issuer=await env.DB.prepare("SELECT kind, active, can_invite_agents FROM principals WHERE id = ?").bind(row.created_by)
    .first<{kind:string;active:number;can_invite_agents:number}>();
  return !!issuer&&issuer.active===1&&(issuer.kind==='owner'||(issuer.kind==='agent'&&issuer.can_invite_agents===1));
}
async function openInvitations(env:Env,issuer:string){
  const row=await env.DB.prepare("SELECT COUNT(*) AS n FROM pairings WHERE created_by = ? AND status IN ('invited','pending') AND expires_at > ?").bind(issuer,time()).first<{n:number}>();
  return row?.n??0;
}
async function visible(env:Env,row:Pairing){
  const principal=await env.DB.prepare('SELECT * FROM principals WHERE id = ?').bind(row.principal_id).first<Principal>();
  // owner_id is the real instance owner, not the inviter, so a normal join reports to the owner.
  return {pairing:{id:row.id,status:row.status,verification_code:row.verification_code,expires_at:row.expires_at},
    principal,owner_id:await ownerId(env)??row.created_by,invited_by:row.created_by,token_id:row.token_id};
}
// Only the transaction that changes pending -> approved can mint a device key.
// Invitations authorize one device; retrying can never reactivate a revoked identity.
async function activatePairing(env:Env,row:Pairing){
  const mark=crypto.randomUUID();
  const results=await env.DB.batch([
    env.DB.prepare(`UPDATE pairings SET status = 'approved', approved_at = ?, approval_mark = ? WHERE id = ? AND status = 'pending' AND expires_at > ? AND ${ISSUER_AUTHORIZED}`).bind(time(),mark,row.id,time()),
    env.DB.prepare("INSERT INTO tokens(id,principal_id,hash,label,kind) SELECT token_id,principal_id,token_hash,'Paired Agent device','access' FROM pairings WHERE id = ? AND approval_mark = ? ON CONFLICT(id) DO NOTHING").bind(row.id,mark),
    env.DB.prepare("UPDATE principals SET active = 1 WHERE id = ? AND EXISTS(SELECT 1 FROM pairings WHERE id = ? AND approval_mark = ?)").bind(row.principal_id,row.id,mark)
  ]);
  return Boolean(results[0].meta.changes);
}
export async function pairingPublic(request:Request,env:Env,path:string){
  if(path==='/pairings/resolve'&&request.method==='POST'){
    // Read-only: resolving never binds, consumes, or reveals proof/bearer material.
    const b=await body(request),code=str(b.code,'code',256);
    const row=await env.DB.prepare('SELECT * FROM pairings WHERE code_hash = ? AND expires_at > ?').bind(await hash(code),time()).first<Pairing>();
    if(!row||!unresolved(row)||!await issuerAuthorized(env,row))
      fail(410,'invalid_pairing','Pairing invitation expired, revoked, or already used.');
    const principal=await env.DB.prepare('SELECT id, name, kind FROM principals WHERE id = ?').bind(row.principal_id).first<{id:string;name:string;kind:string}>();
    return json({invitation:{id:row.id,status:row.status,expires_at:row.expires_at},principal,
      owner_id:await ownerId(env)??row.created_by,invited_by:row.created_by,name_required:nameRequired(principal?.name)});
  }
  if(path==='/pairings/request'&&request.method==='POST'){
    const b=await body(request),code=str(b.code,'code',256),tokenHash=str(b.token_hash,'token_hash',64);
    if(!/^[a-f0-9]{64}$/.test(tokenHash))fail(400,'invalid_field','Provide a SHA-256 token hash.');
    const codeHash=await hash(code);
    const row=await env.DB.prepare('SELECT * FROM pairings WHERE code_hash = ? AND expires_at > ?').bind(codeHash,time()).first<Pairing>();
    if(!row||row.status==='rejected')fail(410,'invalid_pairing','Pairing invitation expired, revoked, or already used.');
    // A completed approval is final: its bound device may still finish joining, but a withdrawn
    // issuer permission only closes unresolved invitations.
    if(unresolved(row)&&!await issuerAuthorized(env,row))fail(410,'invalid_pairing','Pairing invitation expired, revoked, or already used.');
    const fingerprint=(await hash(row.id+':'+tokenHash)).slice(0,8).toUpperCase();
    const verification=fingerprint.slice(0,4)+'-'+fingerprint.slice(4);
    await env.DB.prepare("UPDATE pairings SET token_hash = ?, verification_code = ?, status = 'pending' WHERE id = ? AND status = 'invited' AND expires_at > ?")
      .bind(tokenHash,verification,row.id,time()).run();
    const actual=await env.DB.prepare('SELECT * FROM pairings WHERE id = ?').bind(row.id).first<Pairing>();
    if(!actual||actual.token_hash!==tokenHash||actual.status==='rejected')fail(410,'invalid_pairing','Pairing invitation is already used.');
    if(actual.status==='pending'&&actual.approval_required===0){
      await activatePairing(env,actual);
      const activated=await env.DB.prepare('SELECT * FROM pairings WHERE id = ?').bind(row.id).first<Pairing>();
      if(activated?.status!=='approved')fail(410,'invalid_pairing','Invitation was withdrawn.');
      return json(await visible(env,activated));
    }
    return json(await visible(env,actual));
  }
  const match=/^\/pairings\/([^/]+)\/check$/.exec(path);
  if(match&&request.method==='POST'){
    const b=await body(request),token=str(b.token,'token',256);
    const row=await env.DB.prepare('SELECT * FROM pairings WHERE id = ? AND token_hash = ? AND expires_at > ?').bind(match[1],await hash(token),time()).first<Pairing>();
    if(!row||(unresolved(row)&&!await issuerAuthorized(env,row)))fail(410,'invalid_pairing','Pairing expired or proof is invalid.');
    return json(await visible(env,row));
  }
  return null;
}
export async function pairingOwner(request:Request,env:Env,path:string,p:Principal){
  const issuer=delegated(p);
  if(path==='/pairings'&&request.method==='GET'){
    if(p.kind!=='owner'&&!issuer)fail(403,'invite_permission_required',NEEDS_GRANT);
    if(p.kind!=='owner')return json({items:(await env.DB.prepare(`SELECT q.id,q.principal_id,q.status,q.verification_code,q.expires_at,q.created_at,q.created_by,p.name
      FROM pairings q JOIN principals p ON p.id = q.principal_id
      WHERE q.created_by = ? AND q.status IN ('invited','pending') AND q.expires_at > ? ORDER BY q.created_at DESC LIMIT 100`).bind(p.id,time()).all()).results});
    return json({items:(await env.DB.prepare(`SELECT q.id,q.principal_id,q.status,q.verification_code,q.expires_at,q.created_by,p.name,i.name AS inviter_name
      FROM pairings q JOIN principals p ON p.id = q.principal_id JOIN principals i ON i.id = q.created_by
      WHERE q.status IN ('invited','pending') AND q.expires_at > ? ORDER BY q.created_at DESC LIMIT 200`).bind(time()).all()).results});
  }
  if(path==='/pairings'&&request.method==='POST'){
    if(p.kind!=='owner'&&!issuer)fail(403,'invite_permission_required',NEEDS_GRANT);
    const b=await body(request);let principal:Principal|null;
    if(b.approval_required!==undefined&&typeof b.approval_required!=='boolean')fail(400,'invalid_field','approval_required must be a boolean.');
    const approvalRequired=b.approval_required===true;
    const code=secret('agp'),pairId=id('pair'),expires=new Date(Date.now()+(approvalRequired?10*60000:24*60*60000)).toISOString(),tokenId=id('tok');
    const statements=[];
    if(p.kind!=='owner'&&b.principal_id!==undefined)fail(403,'forbidden','A delegated invitation must create a new Agent identity.');
    if(b.principal_id!==undefined){
      principal=await env.DB.prepare("SELECT * FROM principals WHERE id = ? AND kind = 'agent'").bind(str(b.principal_id,'principal_id',80)).first<Principal>();
      if(!principal||!principal.active)fail(400,'invalid_principal','Choose an active Agent.');
    }else{
      const count=await env.DB.prepare('SELECT COUNT(*) AS n FROM principals').first<{n:number}>();
      if((count?.n??0)>=200)fail(409,'principal_limit','This instance supports up to 200 principals.');
      const name=b.name===undefined||b.name===''?'Unconnected agent':str(b.name,'name',80);
      const avatar = b.avatar === undefined ? null : avatarValue(b.avatar);
      principal={avatar,id:id('agt'),name,kind:'agent',description:'',active:0,can_invite_agents:1,created_at:time()};
      if(p.kind==='owner')statements.push(env.DB.prepare("INSERT INTO principals(id,name,kind,active,avatar) VALUES (?,?,'agent',0,?)").bind(principal.id,name,avatar));
      else{
        if(await openInvitations(env,p.id)>=QUOTA)fail(409,'invitation_quota',`Finish, reject, or let expire your existing invitations before creating another (${QUOTA} open at a time).`);
        // Quota and principal cap are part of the insert itself, so a concurrent create that
        // loses the boundary race leaves no orphan identity behind.
        statements.push(env.DB.prepare(`INSERT INTO principals(id,name,kind,active,avatar)
          SELECT ?,?,'agent',0,? WHERE (SELECT COUNT(*) FROM principals) < 200
          AND (SELECT COUNT(*) FROM pairings WHERE created_by = ? AND status IN ('invited','pending') AND expires_at > ?) < ?
          AND EXISTS(SELECT 1 FROM principals WHERE id = ? AND kind = 'agent' AND active = 1 AND can_invite_agents = 1)`)
          .bind(principal.id,name,avatar,p.id,time(),QUOTA,p.id));
      }
    }
    statements.push(env.DB.prepare(`INSERT INTO pairings(id,principal_id,created_by,code_hash,token_id,expires_at,approval_required)
      SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM principals WHERE id = ?)`).bind(pairId,principal.id,p.id,await hash(code),tokenId,expires,approvalRequired?1:0,principal.id));
    await env.DB.batch(statements);
    if(p.kind!=='owner'&&!await env.DB.prepare('SELECT 1 AS ok FROM pairings WHERE id = ?').bind(pairId).first()){
      // Authentication may predate a concurrent permission withdrawal. Check that first;
      // both inserts must remain no-ops when the delegation no longer exists.
      if(!await issuerAuthorized(env,{created_by:p.id}))fail(403,'invite_permission_required',NEEDS_GRANT);
      if(await openInvitations(env,p.id)>=QUOTA)fail(409,'invitation_quota',`Finish, reject, or let expire your existing invitations before creating another (${QUOTA} open at a time).`);
      fail(409,'principal_limit','This instance supports up to 200 principals.');
    }
    return json({principal,name_required:nameRequired(principal.name),pairing:{id:pairId,code,approval_required:approvalRequired,expires_at:expires,url:`${invitationBase(request)}/#agent-invite=${code}`}},201);
  }
  const match=/^\/pairings\/([^/]+)\/(approve|reject)$/.exec(path);
  if(match&&request.method==='POST'){
    if(p.kind!=='owner'&&!issuer)fail(403,'invite_permission_required',NEEDS_GRANT);
    const row=await env.DB.prepare('SELECT * FROM pairings WHERE id = ? AND expires_at > ?').bind(match[1],time()).first<Pairing>();
    // A delegated issuer must not learn whether other principals' invitations exist.
    if(p.kind!=='owner'){ if(!row||row.created_by!==p.id)fail(404,'not_found','Pairing not found.'); }
    else if(!row)fail(410,'invalid_pairing','Pairing invitation has expired.');
    if(unresolved(row)&&!await issuerAuthorized(env,row))fail(410,'invalid_pairing','This invitation was withdrawn with its issuer’s permission.');
    if(match[2]==='reject'){
      const changed=await env.DB.prepare("UPDATE pairings SET status = 'rejected' WHERE id = ? AND status IN ('invited','pending')").bind(row.id).run();
      if(!changed.meta.changes)fail(409,'pairing_state','This request is already resolved.');
      return json({ok:true});
    }
    const b=await body(request);
    if(!row.token_hash||str(b.verification_code,'verification_code',20)!==row.verification_code)fail(400,'verification_mismatch','Check the code shown by your Agent.');
    const changed=await activatePairing(env,row);
    const actual=await env.DB.prepare('SELECT * FROM pairings WHERE id = ?').bind(row.id).first<Pairing>();
    if(actual?.status!=='approved')fail(409,'pairing_state','This request is already resolved.');
    return json({ok:true,replayed:!changed});
  }
  return null;
}
