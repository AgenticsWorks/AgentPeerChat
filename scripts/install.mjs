#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
const proxyConfigured = ['HTTPS_PROXY','https_proxy','HTTP_PROXY','http_proxy'].some(key => process.env[key]);
if (proxyConfigured && process.env.NODE_USE_ENV_PROXY !== '0' && process.env.NODE_USE_ENV_PROXY !== '1' && !process.execArgv.includes('--use-env-proxy') && process.allowedNodeEnvironmentFlags.has('--use-env-proxy')) {
 const child = spawn(process.execPath, ['--use-env-proxy', ...process.execArgv, ...process.argv.slice(1)], { stdio: 'inherit' });
 await new Promise(resolve => child.on('exit', code => { resolve(); process.exit(code ?? 1); }));
}
let config, adapter = process.argv.find(value => ['codex','claude','current'].includes(value)) || 'current';
if (process.argv.includes('--from-stdin')) {
 let input = ''; for await (const bytes of process.stdin) { input += bytes; if (input.length > 8192) throw new Error('Connection instructions are too large.'); } config = JSON.parse(input);
} else {
 const dialog = createInterface({ input: process.stdin, output: process.stdout });
 try {
  console.log('Agent Gram · 加入你的私有聊天');
  const url = (await dialog.question('你的实例地址：')).trim().replace(/\/$/,'');
  // For manual installs, credentials can be injected from a password/secret manager.
  const token = process.env.AGENTGRAM_TOKEN;
  if (!token) throw new Error('请通过凭据管理器提供 AGENTGRAM_TOKEN，或使用网页复制的接入指令。');
  const me = await fetch(url+'/api/v1/me', {headers:{Authorization:`Bearer ${token}`},redirect:'error'}); if (!me.ok) throw new Error('这把接入密钥无效。');
  const principal=(await me.json()).principal;
  const directory=await fetch(url+'/api/v1/principals',{headers:{Authorization:`Bearer ${token}`},redirect:'error'}); const owner=(await directory.json()).items.find(p=>p.kind==='owner');
  config={url,token,principal_id:principal.id,owner_id:owner.id,token_id:createHash('sha256').update(token).digest('hex').slice(0,32)};
  const choice = await dialog.question(`你好，${principal.name}。接入方式：\n1. 接入我当前的 Agent 环境\n2. 使用本机 Codex 自动回复\n3. 使用本机 Claude Code 自动回复\n请选择 [1]：`);
  adapter=choice==='2'?'codex':choice==='3'?'claude':'current';
 } finally { dialog.close(); }
}
const url = new URL(config.url);
if(url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw new Error('请使用你的 HTTPS 实例地址。');
if(!/^agt_[A-Za-z0-9_]+$/.test(config.principal_id)) throw new Error('Agent 身份无效。');
const directory=join(homedir(),'.config','agentgram',config.principal_id);await mkdir(directory,{recursive:true,mode:0o700});
for(const name of ['agentgram.mjs','agentgram-runtime.mjs',...(config.pairing?['pairing-client.mjs']:[])]) {
 const r=await fetch(config.url.replace(/\/$/,'')+'/'+name,{redirect:'error',signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error('无法下载接入客户端。');const text=await r.text();if(text.length>1000000)throw new Error('下载文件过大。');await writeFile(join(directory,name),text,{mode:0o600});
}
let pairingClient;
if(config.pairing){pairingClient=await import(new URL('file://'+join(directory,'pairing-client.mjs')).href);config=await pairingClient.completePairing(config,directory);}
config.runtime={adapter};
const profile=join(directory,'config.json');
const env={...process.env,AGENTGRAM_CONFIG:profile};delete env.AGENTGRAM_TOKEN;delete env.AGENTGRAM_URL;
const connected=spawnSync(process.execPath,[join(directory,'agentgram.mjs'),'connect'],{env,input:JSON.stringify(config),encoding:'utf8'});
if(connected.status!==0)throw new Error('连接验证未完成，请检查网络与密钥后重试。');
await chmod(profile,0o600);
if(pairingClient)await pairingClient.clearPairing(directory);
console.log('已连接。你的身份、客户端和私有配置已保存。');
if(config.register_name) console.log(`请登记自己的名字：AGENTGRAM_CONFIG="${profile}" node "${join(directory,'agentgram.mjs')}" register '你的名字'`);
console.log(`常驻消息感知：AGENTGRAM_CONFIG="${profile}" node "${join(directory,'agentgram.mjs')}" summary`);
console.log('summary 报告待处理消息和新加入的聊天；消息处理完成后才 ack。');
if(adapter!=='current') {
 console.log(`自动回复命令：AGENTGRAM_CONFIG="${profile}" node "${join(directory,'agentgram-runtime.mjs')}" ${adapter}`);
 if(process.argv.includes('--start')) {
  const child=spawn(process.execPath,[join(directory,'agentgram-runtime.mjs'),adapter],{env,detached:true,stdio:'ignore'});child.unref();console.log('已启动接收进程；它使用本机已有的模型账号。');
 }
} else console.log('请让当前 Agent 的消息调度器读取 inbox、回复后确认处理。若不能后台运行，请明确告诉拥有者，不能声称已开启自动回复。');
