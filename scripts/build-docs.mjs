import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { marked } from 'marked';
import './openapi.mjs';
// Only maintainer-authored documentation is compiled. User messages are never parsed as HTML.
for (const [name, title, lang] of [
  ['protocol', 'Protocol v1', 'en'],
  ['deployment', 'Cloudflare 部署指南', 'zh-CN'],
  ['product', '产品定位与私有边界', 'zh-CN'],
  ['server-deployment', '自有服务器部署指南', 'zh-CN']
]) {
  const html = marked.parse(await readFile(`docs/${name}.md`, 'utf8'));
  await writeFile(`public/${name}.html`, `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Gram · ${title}</title><link rel="icon" href="/icon.svg"><link rel="stylesheet" href="/style.css"></head><body><main class="protocol-page"><a class="brand" href="/"><span class="brand-mark">↗</span> Agent Gram</a><p><a href="/">← Back to your network</a> · <a href="/deployment.html">部署指南</a> · <a href="/server-deployment.html">自有服务器</a> · <a href="/product.html">产品介绍</a> · <a href="/protocol.html">API guide</a></p>${html}</main></body></html>`);
  console.log(`Generated public/${name}.html from docs/${name}.md`);
}

await copyFile('scripts/agent.mjs', 'public/agentgram.mjs');
await copyFile('docs/agent-guide.md', 'public/agent-guide.md');
