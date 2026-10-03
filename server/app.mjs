import { createServer } from 'node:http';
import { readFile, mkdir, chmod } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { SQLiteDatabase } from './sqlite.mjs';
const types = { '.tgz': 'application/gzip', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8' };
function readBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = []; let size = 0;
    const data = chunk => { size += chunk.length; if (size > 65536) { request.off('data', data); request.resume(); reject(Object.assign(new Error('Request is too large.'), { status: 413 })); } else chunks.push(chunk); };
    request.on('data', data); request.once('end', () => resolveBody(Buffer.concat(chunks))); request.once('error', reject);
  });
}
export async function createApplication({ worker, databasePath, setupSecret, publicUrl, assetsDirectory, migrationsDirectory }) {
  const origin = new URL(publicUrl);
  if (origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash || !['http:', 'https:'].includes(origin.protocol)) throw new Error('AGENTGRAM_PUBLIC_URL must be an HTTP(S) origin without a path or credentials.');
  if (origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) throw new Error('Use HTTPS for a public server; terminate TLS at your reverse proxy.');
  if (typeof setupSecret !== 'string' || setupSecret.length < 24) throw new Error('SETUP_SECRET must contain at least 24 characters.');
  const path = resolve(databasePath); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const database = new SQLiteDatabase(path); await chmod(path, 0o600);
  try { await database.migrate(resolve(migrationsDirectory)); } catch (error) { database.close(); throw error; }
  const environment = { DB: database, SETUP_SECRET: setupSecret, ASSETS: { async fetch(request) {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed.', { status: 405 });
    const pathname = new URL(request.url).pathname;
    const name = pathname === '/' ? 'index.html' : pathname.slice(1);
    // Serve only top-level public assets, never directories or project/configuration files.
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) return new Response('Not found.', { status: 404 });
    const filename = name.includes('.') ? name : name + '.html';
    const extension = filename.slice(filename.lastIndexOf('.')); if (!types[extension]) return new Response('Not found.', { status: 404 });
    try { const bytes = await readFile(join(assetsDirectory, filename)); return new Response(request.method === 'HEAD' ? null : bytes, { headers: { 'Content-Type': types[extension], 'Cache-Control': 'no-cache' } }); }
    catch (error) { if (['ENOENT', 'EISDIR'].includes(error.code)) return new Response('Not found.', { status: 404 }); throw error; }
  } } };
  const server = createServer(async (incoming, outgoing) => {
    try {
      if (!incoming.url?.startsWith('/') || incoming.url.startsWith('//')) throw Object.assign(new Error('Invalid request URL.'), { status: 400 });
      const url = new URL(incoming.url, origin); if (url.origin !== origin.origin) throw Object.assign(new Error('Invalid request URL.'), { status: 400 });
      if (Number(incoming.headers['content-length']) > 65536) { incoming.resume(); throw Object.assign(new Error('Request is too large.'), { status: 413 }); }
      const bytes = await readBody(incoming);
      const headers = new Headers(); for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      const request = new Request(url, { method: incoming.method, headers, body: ['GET', 'HEAD'].includes(incoming.method) || !bytes.length ? undefined : bytes });
      const response = await worker.fetch(request, environment);
      outgoing.statusCode = response.status;
      for (const [name, value] of response.headers) if (name !== 'set-cookie') outgoing.setHeader(name, value);
      const cookies = response.headers.getSetCookie(); if (cookies.length) outgoing.setHeader('Set-Cookie', cookies);
      outgoing.end(incoming.method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      if (outgoing.headersSent) { outgoing.destroy(); return; }
      const status = error.status ?? 500;
      outgoing.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(status === 413 ? { Connection: 'close' } : {}) });
      outgoing.end(JSON.stringify({ error: { code: status === 413 ? 'body_too_large' : 'server_error', message: status < 500 ? error.message : 'Server is unavailable.' } }));
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 15000;
  return { server, database, async close() { await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())); database.close(); } };
}
