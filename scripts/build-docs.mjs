import './build-cli.mjs';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { marked } from 'marked';
import './openapi.mjs';
// Only maintainer-authored documentation is compiled. User messages are never parsed as HTML.
for (const [name, title, lang] of [
  ['protocol', 'Protocol v1', 'en'],
  ['research', '真实搜索协作记录', 'zh-CN'],
  ['deployment', 'Cloudflare 部署指南', 'zh-CN'],
  ['product', '产品定位与私有边界', 'zh-CN'],
  ['server-deployment', '自有服务器部署指南', 'zh-CN']
]) {
  const bilingual = ['deployment','product','server-deployment'].includes(name);
  for (const version of bilingual ? ['en','zh-CN'] : [lang]) {
  const documentName = version === 'en' && bilingual ? `${name}.en` : name;
  const outputName = version === 'zh-CN' && bilingual ? `${name}.zh-CN` : name;
  const pageTitle = version === 'en' ? ({deployment:'Cloudflare deployment',product:'Product overview','server-deployment':'Server deployment'}[name] ?? title) : title;
  const html = marked.parse(await readFile(`docs/${documentName}.md`, 'utf8')).replace(/href="(?:\.\.\/)?(deployment|server-deployment|product|protocol)(?:\.en)?\.md/g,'href="/$1.html').replace('href="../README.md"','href="https://github.com/AgenticsWorks/AgentPeerChat"');
  const languages = bilingual ? `<span class="doc-languages"><a href="/${name}.html" lang="en">English</a> · <a href="/${name}.zh-CN.html" lang="zh-CN">中文</a></span>` : '';
  const page = `<!doctype html>
<html lang="${version}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentPeerChat · ${pageTitle}</title><link rel="icon" href="/icon.svg"><link rel="stylesheet" href="/style.css"></head><body><main class="protocol-page"><a class="brand" href="/"><span class="brand-mark">↗</span> AgentPeerChat</a>${languages}<p><a href="/">← Home</a> · <a href="/deployment.html">Cloudflare deployment</a> · <a href="/server-deployment.html">Your own server</a> · <a href="/product.html">Product overview</a> · <a href="/protocol.html">API guide</a></p>${html}</main></body></html>`;
  await writeFile(`public/${outputName}.html`, page);
  if (name !== 'research') await writeFile(`website/${outputName}.html`, page.replaceAll('/icon.svg','/assets/icon.svg'));
  }
  console.log(`Generated public/${name}.html from docs/${name}.md`);
}

await copyFile('scripts/agent.mjs', 'public/agentpeerchat.mjs');
await copyFile('docs/agent-guide.md', 'public/agent-guide.md');
await copyFile('docs/agent-guide.zh-CN.md', 'public/agent-guide.zh-CN.md');

await copyFile('scripts/runtime.mjs', 'public/agentpeerchat-runtime.mjs');
await copyFile('scripts/install.mjs', 'public/install.mjs');

await copyFile('scripts/pairing-client.mjs', 'public/pairing-client.mjs');

// Legacy URLs remain valid for previously copied connection commands.
for (const name of ['agentpeerchat.mjs','agentpeerchat-runtime.mjs','agentpeerchat-skill.md','agentpeerchat-cli.tgz']) await copyFile('public/'+name,'public/'+name.replace('agentpeerchat','agentgram'));
