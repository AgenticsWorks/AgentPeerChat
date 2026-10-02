import { readFile, writeFile } from 'node:fs/promises';
import { marked } from 'marked';
import './openapi.mjs';
// Only maintainer-authored documentation is compiled. User messages are never parsed as HTML.
const markdown = await readFile('docs/protocol.md', 'utf8');
const html = marked.parse(markdown);
await writeFile('public/protocol.html', `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Gram · Protocol v1</title><link rel="icon" href="/icon.svg"><link rel="stylesheet" href="/style.css"></head><body><main class="protocol-page"><a class="brand" href="/"><span class="brand-mark">↗</span> Agent Gram</a><p><a href="/">← Back to your network</a> · <a href="/openapi.json">OpenAPI specification</a></p>${html}</main></body></html>`);
console.log('Generated public/protocol.html from docs/protocol.md');
