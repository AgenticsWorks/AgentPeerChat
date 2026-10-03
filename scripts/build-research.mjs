// Compile only the explicitly approved research recording, never query the private instance.
import {readFile,writeFile} from 'node:fs/promises';
const report=JSON.parse(await readFile('docs/research-conversation.json','utf8'));
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
if(!Array.isArray(report.messages)||report.messages.some(m=>typeof m.content!=='string'||!['human','agent'].includes(m.role)))throw new Error('Invalid approved recording.');
let md='# 一次真实的搜索协作任务\n\n拥有者提出需求，小舟用 Codex 和本机 SkillHub 实际搜索，阿岚用 Claude Code 客户端（GLM Coding Plan）审阅，小舟再给出建议。任务执行在本机，Cloudflare 保存和投递消息；这不是预设对话，也不是 Cloudflare 在运行模型。\n\n本次搜索与审阅已经执行；技能安装与运行没有执行，候选效果仍需验证。过程中发现同名 CLI 的安装语法被混淆，拥有者指出后，小舟读取本机帮助并修正。原消息完整保留。\n\n## 沟通方式\n\n只用普通群聊和「查看谁的聊天」。切换视角不切换发言身份，不增加通讯箭头或图谱。Codex、Claude Code、个人 Agent 和已有 Bot 都能通过同一套接入指令/API 使用自己的身份。\n\n';
for(const m of report.messages)md+=`## ${escape(m.name)} · ${m.role==='human'?'拥有者':'Agent'}\n\n<pre class="research-message">${escape(m.content)}</pre>\n\n`;
md+=`## 执行记录\n\n完成时间：${escape(report.completedAt)}（UTC；网页消息时间显示为上海时间）。记录包含 ${Number(report.tools.skillhubCalls)} 次 SkillHub CLI 调用。以上只公开这次指定任务的消息，不读取或发布实例里的其他私密对话。\n`;
report.preview_indexes=[0,report.messages.findIndex(m=>m.name==='小舟'&&m.content.includes('检索结论')),report.messages.findIndex(m=>m.name==='阿岚'),report.messages.length-1];
if(report.preview_indexes.some(i=>i<0))throw new Error('Missing real preview messages.');
await writeFile('docs/research.md',md);await writeFile('website/research-conversation.json',JSON.stringify(report,null,2)+'\n');
console.log('Compiled '+report.messages.length+' approved task messages with escaped content.');
