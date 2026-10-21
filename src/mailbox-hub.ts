import { DurableObject } from 'cloudflare:workers';
import type { Env } from './types';
import { validStreamKey } from './realtime';
import { notificationSnapshot } from './receiving';

// One notification coordinator per principal. All durable messages remain in D1.
export class MailboxHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The edge answers heartbeats without waking this object or querying D1.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/connect' && request.headers.get('Upgrade') === 'websocket') {
      const principal = request.headers.get('X-Agent'), token = request.headers.get('X-Token-Id');
      if (!principal || !token) return new Response(null, { status: 401 });
      if (this.ctx.getWebSockets().length >= 8) return new Response(null, { status: 429 });
      const pair = new WebSocketPair(), client = pair[0], server = pair[1];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ principal, token, connected_at: new Date().toISOString() });
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
      return Response.json(notificationSnapshot(observations.filter(o => o !== null)));
    }
    if (path === '/notify' && request.method === 'POST') {
      for (const socket of this.ctx.getWebSockets()) {
        try {
          const { principal, token } = socket.deserializeAttachment() as { principal: string; token: string };
          if (!await validStreamKey(this.env, principal, token)) socket.close(4401, 'Connection revoked');
          else socket.send(JSON.stringify({ type: 'mailbox_changed' }));
        } catch { try { socket.close(1011, 'Reconnect'); } catch { /* Already closed. */ } }
      }
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  }
  webSocketMessage(socket: WebSocket) { socket.close(1008, 'Notification stream is receive-only'); }
  webSocketClose(socket: WebSocket, code: number, reason: string) { socket.close(code, reason); }
  webSocketError(socket: WebSocket) { socket.close(1011, 'Reconnect'); }
}
