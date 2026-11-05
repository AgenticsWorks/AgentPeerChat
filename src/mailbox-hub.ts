import { DurableObject } from 'cloudflare:workers';
import type { Env, Principal } from './types';
import { validStreamKey, validBrowserKey } from './realtime';
import { notificationSnapshot } from './receiving';
import { WakeWebhook } from './wake-webhook';
import { WakeVerification } from './wake-verification';

// One notification coordinator per principal. All durable messages remain in D1.
export class MailboxHub extends DurableObject<Env> {
  private wake: WakeWebhook;
  private verification: WakeVerification;
  private mutations: Promise<unknown> = Promise.resolve();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.wake = new WakeWebhook(ctx.storage, env);
    this.verification = new WakeVerification(ctx.storage, env);
    // The edge answers heartbeats without waking this object or querying D1.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const principal = request.headers.get('X-Agent');
    if (path === '/wake/config' || path === '/wake/test' || path === '/wake/retry') {
      if (!principal) return new Response(null, { status: 400 });
      const work = this.mutations.then(async () => {
        if (path === '/wake/config') {
          if (request.method === 'PUT' || request.method === 'DELETE') {
            const value = request.method === 'DELETE' ? null : await request.json();
            // Reset evidence first: a crash must never verify replacement credentials
            // with the previous configuration's successful test.
            await this.verification.reset();
            await this.wake.configure(principal, value);
          } else if (request.method !== 'GET') return new Response(null, { status: 405 });
          return Response.json({ ...await this.wake.configuration(principal), verification: await this.verification.status(principal) });
        }
        if (request.method !== 'POST') return new Response(null, { status: 405 });
        const agent = await this.env.DB.prepare("SELECT * FROM principals WHERE id=? AND kind='agent' AND active=1").bind(principal).first<Principal>();
        if (!agent) return new Response(null, { status: 400 });
        if (!(await this.wake.configuration(principal)).configured) return new Response(null, { status: 409 });
        if (path === '/wake/retry') return Response.json({ queued: await this.wake.enqueue(principal, true) });
        const owner = request.headers.get('X-Owner'), key = request.headers.get('Idempotency-Key');
        if (!owner || !key) return new Response(null, { status: 400 });
        const verification = await this.verification.start(agent, owner, key);
        const queued = await this.wake.enqueue(principal);
        await this.notifySockets();
        return Response.json({ ...await this.wake.configuration(principal), verification, queued });
      });
      this.mutations = work.catch(() => {});
      try { return await work; } catch { return new Response(null, { status: 503 }); }
    }
    if (path === '/wake' && request.method === 'POST') {
      if (!principal) return new Response(null, { status: 400 });
      return Response.json({ queued: await this.wake.enqueue(principal) });
    }
    if (path === '/connect' && request.headers.get('Upgrade') === 'websocket') {
      const principal = request.headers.get('X-Agent'), token = request.headers.get('X-Token-Id');
      if (!principal || !token) return new Response(null, { status: 401 });
      if (this.ctx.getWebSockets().length >= 8) return new Response(null, { status: 429 });
      const pair = new WebSocketPair(), client = pair[0], server = pair[1];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ principal, token, browser:request.headers.get('X-Browser')==='1', connected_at: new Date().toISOString() });
      server.send(JSON.stringify({ type: 'ready' }));
      return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': 'apc-v1' } });
    }
    // Internal binding only; the public owner route never exposes socket/token metadata.
    if (path === '/status' && request.method === 'GET') {
      const observations = await Promise.all(this.ctx.getWebSockets().map(async socket => {
        if (socket.readyState !== WebSocket.OPEN) return null;
        const { principal, token, connected_at } = socket.deserializeAttachment() as { principal: string; token: string; connected_at?: string };
        if (!await validStreamKey(this.env, principal, token)) return null;
        return { heartbeat: this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? null, connected: Date.parse(connected_at ?? '') };
      }));
      return Response.json({ ...notificationSnapshot(observations.filter(o => o !== null)),
        ...(principal ? { wake_webhook: await this.wake.status(principal) } : {}) });
    }
    if (path === '/notify' && request.method === 'POST') {
      // Browser hubs never receive X-Agent here and cannot trigger model wakes.
      if (principal) {
        try { await this.wake.enqueue(principal); }
        catch { console.warn(JSON.stringify({ code: 'wake_webhook_deferred' })); }
      }
      await this.notifySockets();
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  }
  private async notifySockets() {
    for (const socket of this.ctx.getWebSockets()) {
        try {
          const { principal, token, browser } = socket.deserializeAttachment() as { principal: string; token: string; browser?:boolean };
          if (!await (browser ? validBrowserKey(this.env, principal, token) : validStreamKey(this.env, principal, token))) socket.close(4401, 'Connection revoked');
          else socket.send(JSON.stringify({ type: 'mailbox_changed' }));
        } catch { try { socket.close(1011, 'Reconnect'); } catch { /* Already closed. */ } }
    }
  }
  async alarm() { await this.wake.alarm(); }
  webSocketMessage(socket: WebSocket) { socket.close(1008, 'Notification stream is receive-only'); }
  webSocketClose(socket: WebSocket, code: number, reason: string) { socket.close(code, reason); }
  webSocketError(socket: WebSocket) { socket.close(1011, 'Reconnect'); }
}
