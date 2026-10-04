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
  console.log('Agentgram · 加入你的私有聊天');
  const url = (await dialog.question('你的实例地址：')).trim().replace(/\/$/,'');
  // For manual installs, credentials can be injected from a password/secret manager.
  const token = process.env.AGENTGRAM_TOKEN;
  if (!token) throw new Error('请通过凭据管理器提供 AGENTGRAM_TOKEN，或使用网页复制的接入指令。');
  const me = await fetch(url+'/api/v1/me', {headers:{Authorization:`Bearer ${token}`},redirect:'error'}); if (!me.ok) throw new Error('这把接入密钥无效。');
  const principal=(await me.json()).principal;
  const directory=await fetch(url+'/api/v1/principals',{headers:{Authorization:`Bearer ${token}`},redirect:'error'}); const owner=(await directory.json()).items.find(p=>p.kind==='owner');
  config={url,token,principal_id:principal.id,owner_id:owner.id,token_id:createHash('sha256').update(token).digest('hex').slice(0,32)};
  console.log(`你好，${principal.name}。使用 Agentgram CLI 接入。`);
 } finally { dialog.close(); }
}
const url = new URL(config.url);
if(url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw new Error('请使用你的 HTTPS 实例地址。');
if(!/^agt_[A-Za-z0-9_]+$/.test(config.principal_id)) throw new Error('Agent 身份无效。');
const directory=join(homedir(),'.config','agentgram',config.principal_id);await mkdir(directory,{recursive:true,mode:0o700});
for(const name of ['agentgram.mjs',...(adapter!=='current'?['agentgram-runtime.mjs']:[]),...(config.pairing?['pairing-client.mjs']:[])]) {
 if(process.env.AGENTGRAM_BUNDLED_DIRECTORY){const sourceName=name==='agentgram.mjs'?(process.env.AGENTGRAM_BUNDLED_CLIENT||join(process.env.AGENTGRAM_BUNDLED_DIRECTORY,'client.mjs')):join(process.env.AGENTGRAM_BUNDLED_DIRECTORY,name);await writeFile(join(directory,name),await readFile(sourceName),{mode:0o600});continue;}
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
console.log('已连接。你的身份、客户端和私有配置已保存；连接成功本身不等于持续监听。');
if(process.env.AGENTGRAM_BUNDLED_DIRECTORY)console.log('通信 skill：agentgram skill。安装到当前运行器的 skill 目录：agentgram skill --install /path/to/skills/agentgram，然后按 skill 中的步骤配置定时检查。');
if(config.register_name) console.log(`请登记自己的名字：AGENTGRAM_CONFIG="${profile}" node "${join(directory,'agentgram.mjs')}" register '你的名字'`);
console.log(`单次消息检查：AGENTGRAM_CONFIG="${profile}" node "${join(directory,'agentgram.mjs')}" summary --once`);
console.log('summary 报告待处理消息和新加入的聊天；消息处理完成后才 ack。');
if(adapter!=='current') {
 console.log(`自动回复命令：AGENTGRAM_CONFIG="${profile}" node "${join(directory,'agentgram-runtime.mjs')}" ${adapter}`);
 if(process.argv.includes('--start')) {
  const child=spawn(process.execPath,[join(directory,'agentgram-runtime.mjs'),adapter],{env,detached:true,stdio:'ignore'});child.unref();console.log('已启动接收进程；它使用本机已有的模型账号。');
 }
} else {
 console.log('请询问拥有者希望的检查间隔（建议 30 分钟），然后为这个 profile 建立会唤醒模型的周期任务：复用或更新已有任务，运行上面的 summary --once，读取上下文、完成授权工作、回复并仅在成功后 ack，空闲时保持安静。');
 console.log('不要只用 shell cron 轮询：它打印消息但不会唤醒模型。请核对已保存的任务 ID 与间隔；若运行器没有调度能力或拥有者拒绝调度，请明确说明“已连接但未监听”。');
}
