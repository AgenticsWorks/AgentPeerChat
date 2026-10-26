// Bounded retries are safe only for reads, acknowledgments and keyed message sends.
// Keep the serialized body and idempotency key identical across every attempt.
import {randomUUID} from 'node:crypto';
import {deliverDirect} from './direct-delivery.mjs';
const transient = new Set([408, 429, 500, 502, 503, 504]);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function requestJSON(url, {method = 'GET', token, body, send = false, idempotencyKey, headers: extraHeaders = {}, signal} = {}, {
  fetchImpl = fetch, wait = sleep, now = Date.now, random = Math.random
} = {}) {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  if (encoded !== undefined && Buffer.byteLength(encoded, 'utf8') > 65536) throw new Error('Serialized request must fit in 64 KiB.');
  const headers = {...extraHeaders, Authorization: `Bearer ${token}`,
    ...(encoded === undefined ? {} : {'Content-Type': 'application/json'}),
    ...(send ? {'Idempotency-Key': idempotencyKey ?? randomUUID()} : {})};
  const retryable = method === 'GET' || send || (method === 'POST' && /\/messages\/[^/]+\/ack$/.test(new URL(url).pathname));
  // Share one deadline across requests and waits; do not multiply the old 30s bound.
  const deadline = now() + 30000;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted();
    let response, data, retryAfter;
    try {
      response = await fetchImpl(url, {method, redirect: 'error', headers, body: encoded,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - now()))]) : AbortSignal.timeout(Math.max(1, deadline - now()))});
      try { data = await response.json(); } catch { /* Proxies may return HTML, never echo it. */ }
      if (response.ok && data !== undefined) {if(send&&data.direct)await deliverDirect(data.direct,{fetchImpl});return data;}
      lastError = new Error(response.ok ? 'Invalid JSON response.' : `${response.status}: ${typeof data?.error?.message === 'string' ? data.error.message : 'Request failed'}`);
      if (!response.ok && !transient.has(response.status)) throw lastError;
      retryAfter = response.headers.get('Retry-After');
    } catch (error) {
      signal?.throwIfAborted();
      // Do not reinterpret permanent HTTP failures as transport failures.
      if (response && !response.ok && !transient.has(response.status)) throw error;
      lastError = response ? lastError : new Error('Request failed before a valid response was received.');
    }
    if (!retryable || attempt === 2) throw lastError;
    let delay = 250 * 2 ** attempt + Math.floor(random() * 250);
    if (retryAfter !== null && retryAfter !== undefined) {
      const seconds = /^\d+(?:\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter) : NaN;
      const requested = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now();
      if (Number.isFinite(requested)) delay = Math.max(delay, requested);
    }
    // A longer server cooldown is left to the caller/host scheduler, never shortened.
    if (delay >= deadline - now()) throw lastError;
    await wait(delay);
    if (now() >= deadline) throw lastError;
  }
  throw lastError;
}
