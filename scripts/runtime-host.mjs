// A private local control socket forwards timer checks to the resident native runtime.
import {createServer,connect} from 'node:net';
import {mkdir,lstat,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const socketPath=root=>join(tmpdir(),'agentpeerchat-'+(process.getuid?.()??'user'),'runtime-'+createHash('sha256').update(root).digest('hex').slice(0,24)+'.sock');
export async function forwardCheck(root){
 return new Promise(resolve=>{const socket=connect(socketPath(root));let done=false,raw='';const finish=value=>{if(done)return;done=true;clearTimeout(t);socket.destroy();resolve(value);};const t=setTimeout(()=>finish({forwarded:true,awaiting_processing:true}),2000);
  socket.on('connect',()=>socket.write('check\n'));socket.on('error',()=>finish(null));socket.on('data',data=>{raw+=data;if(raw.length>8192)return finish(null);if(raw.includes('\n'))try{finish(JSON.parse(raw));}catch{finish(null);}});socket.on('end',()=>finish(null));});
}
export async function serveChecks(root,check){
 const path=socketPath(root),dir=join(tmpdir(),'agentpeerchat-'+(process.getuid?.()??'user'));await mkdir(dir,{recursive:true,mode:0o700});const info=await lstat(dir);if(!info.isDirectory()||info.mode&0o077||process.getuid&&info.uid!==process.getuid())throw Error('Runtime socket directory must be private.');
 try{const old=await lstat(path);if(!old.isSocket()||process.getuid&&old.uid!==process.getuid())throw Error('Unexpected runtime socket.');await rm(path);}catch(e){if(e.code!=='ENOENT')throw e;}
 const clients=new Set();const server=createServer(c=>{clients.add(c);c.on('close',()=>clients.delete(c));c.on('error',()=>{});let data='';c.setTimeout(3000,()=>c.destroy());c.on('data',chunk=>{data+=chunk;if(data.length>32)return c.destroy();if(data==='check\n'){c.end('{"forwarded":true,"awaiting_processing":true}\n');void check().catch(()=>{});}});});
 await new Promise((ok,fail)=>{server.once('error',fail);server.listen(path,ok);});await chmod(path,0o600);
 return async()=>{for(const c of clients)c.destroy();await new Promise(r=>server.close(r));await rm(path,{force:true});};
}
