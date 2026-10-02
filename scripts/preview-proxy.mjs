// Optional local test gateway. Not part of the production Cloudflare deployment.
// Keeps Wrangler's local explorer/debug endpoints off the shared preview route.
import http from 'node:http';
const upstream = 'http://127.0.0.1:8787';
const prefix = (process.env.AGENTGRAM_PREVIEW_PREFIX ?? '/agent-gram').replace(/\/$/, '');
const publicOrigin = process.env.AGENTGRAM_PREVIEW_ORIGIN;
if (!publicOrigin || new URL(publicOrigin).protocol !== 'https:') throw new Error('Set AGENTGRAM_PREVIEW_ORIGIN to the HTTPS test origin.');
const assets = new Set(['/', '/index.html', '/app.js', '/connection-kit.js', '/agentgram.mjs', '/agent-guide.md', '/style.css', '/fonts.css', '/icon.svg', '/protocol.html', '/deployment.html', '/product.html', '/protocol', '/deployment', '/product', '/openapi.json']);
const server = http.createServer(async (req, res) => {
  try {
    const requested = new URL(req.url, publicOrigin);
    if (requested.pathname === prefix) { res.writeHead(302, { Location: prefix + '/' }); res.end(); return; }
    if (!requested.pathname.startsWith(prefix + '/')) { res.writeHead(404); res.end(); return; }
    const path = requested.pathname.slice(prefix.length);
    if (!assets.has(path) && !/^\/api\/v1(?:\/|$)/.test(path)) { res.writeHead(404); res.end(); return; }
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 65536) { res.writeHead(413); res.end(); return; } chunks.push(chunk); }
    const headers = new Headers();
    for (const name of ['content-type', 'authorization', 'cookie', 'idempotency-key', 'origin']) if (req.headers[name]) headers.set(name, req.headers[name]);
    // Translate only the exact legitimate preview Origin. Cross-site mutations stay rejected by the Worker.
    if (headers.get('origin') === publicOrigin) headers.set('origin', upstream);
    const result = await fetch(upstream + path + requested.search, { method: req.method, headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks), redirect: 'manual', signal: AbortSignal.timeout(30000) });
    const output = Object.fromEntries(result.headers);
    delete output['content-length']; delete output['content-encoding']; delete output['transfer-encoding'];
    output['cache-control'] = 'no-store';
    // Workers Assets canonicalizes *.html URLs; keep those redirects inside the preview prefix.
    if (output.location) {
      const target = new URL(output.location, upstream);
      if (target.origin === upstream && assets.has(target.pathname)) output.location = prefix + target.pathname + target.search + target.hash;
    }
    const cookies = result.headers.getSetCookie();
    if (cookies.length) output['set-cookie'] = cookies.map(c => c.replace('Path=/', `Path=${prefix}/`) + (c.includes('; Secure') ? '' : '; Secure'));
    let bytes = Buffer.from(await result.arrayBuffer());
    const type = result.headers.get('content-type') ?? '';
    if (type.includes('text/html')) bytes = Buffer.from(bytes.toString().replace('<head>', `<head><meta name="agentgram-base" content="${prefix}">`).replace(/(\b(?:href|src)=["'])\/(?!\/)/g, `$1${prefix}/`));
    else if (path === '/style.css') bytes = Buffer.from(bytes.toString().replace(/url\((['"]?)\//g, `url($1${prefix}/`));
    else if (path === '/openapi.json') { const spec = JSON.parse(bytes.toString()); spec.servers = [{ url: `${prefix}/api/v1` }]; bytes = Buffer.from(JSON.stringify(spec)); }
    res.writeHead(result.status, output); res.end(bytes);
  } catch { if (!res.headersSent) res.writeHead(502); res.end('Local preview is unavailable.'); }
});
server.listen(8788, '127.0.0.1', () => console.log(`Local preview gateway: ${publicOrigin}${prefix}/`));
process.on('SIGTERM', () => server.close());
