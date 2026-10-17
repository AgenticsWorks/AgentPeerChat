import WebSocket from './vendor-websocket.mjs';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

export function websocketAgent(raw,env=process.env){
 const url=new URL(raw),secure=url.protocol==='wss:',hostname=url.hostname.replace(/^\[|\]$/g,''),port=url.port||(secure?'443':'80');
 const exceptions=(env.NO_PROXY||env.no_proxy||'localhost,127.0.0.1,::1').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
 if(exceptions.some(rule=>{if(rule==='*')return true;const [host,p]=rule.split(':');const domain=host.replace(/^\*?\./,'');return (!p||p===port)&&(hostname===domain||hostname.endsWith('.'+domain));}))return undefined;
 const rawProxy=(secure?(env.HTTPS_PROXY||env.https_proxy):undefined)||env.HTTP_PROXY||env.http_proxy||env.ALL_PROXY||env.all_proxy;
 if(!rawProxy)return undefined;
 const proxy=new URL(rawProxy);if(!['http:','https:'].includes(proxy.protocol))throw Error('WebSocket proxy must use HTTP CONNECT.');
 const Agent=secure?https.Agent:http.Agent;const agent=new Agent({keepAlive:false});
 agent.createConnection=(options,callback)=>{
  let settled=false;const finish=(err,socket)=>{if(settled)return;settled=true;callback(err,socket);};
  const host=hostname.includes(':')?'['+hostname+']':hostname,authority=host+':'+port;
  const request=(proxy.protocol==='https:'?https:http).request({hostname:proxy.hostname,port:proxy.port||undefined,method:'CONNECT',path:authority,headers:{Host:authority,...(proxy.username||proxy.password?{'Proxy-Authorization':'Basic '+Buffer.from(decodeURIComponent(proxy.username)+':'+decodeURIComponent(proxy.password)).toString('base64')}:{})}});
  request.setTimeout(15000,()=>request.destroy(new Error('Proxy connection timed out')));
  request.once('error',()=>finish(new Error('Proxy connection failed')));
  request.once('connect',(response,socket,head)=>{
   request.setTimeout(0);if(response.statusCode!==200){socket.destroy();return finish(new Error('Proxy refused connection'));}
   if(head.length)socket.unshift(head);
   if(!secure)return finish(null,socket);
   const secured=tls.connect({socket,servername:hostname,rejectUnauthorized:true});secured.setTimeout(15000,()=>secured.destroy(new Error('Secure proxy connection timed out')));secured.once('secureConnect',()=>{secured.setTimeout(0);finish(null,secured);});secured.once('error',()=>{secured.destroy();finish(new Error('Secure proxy connection failed'));});
  });request.end();
 };
 return agent;
}
export class NotificationSocket extends WebSocket{
 constructor(url,protocols){super(url,protocols,{agent:websocketAgent(url),maxPayload:65536,handshakeTimeout:15000,perMessageDeflate:false});}
}
