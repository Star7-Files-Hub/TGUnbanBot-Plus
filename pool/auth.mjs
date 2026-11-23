// Password login uses an HttpOnly signed cookie; tokens never enter HTML/localStorage.
import { constantEqual, json } from './protocol.mjs';
const COOKIE = '__Host-tgpool';
const encode = value => btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decode = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
async function key(secret) { return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
export async function sessionCookie(env, now = Date.now()) {
  if (!env.SESSION_SECRET) throw new Error('auth_not_configured');
  const payload = encode(new TextEncoder().encode(JSON.stringify({ exp: now + 8 * 3600_000, salt: crypto.randomUUID() })));
  const sig = encode(new Uint8Array(await crypto.subtle.sign('HMAC', await key(env.SESSION_SECRET), new TextEncoder().encode(payload))));
  return `${COOKIE}=${payload}.${sig}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=28800`;
}
export async function validSession(request, env, now = Date.now()) {
  if (!env.SESSION_SECRET) return false;
  const value = (request.headers.get('Cookie') || '').split(';').map(v => v.trim()).find(v => v.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  if (!value || value.length > 1000) return false;
  try {
    const [payload, sig, extra] = value.split('.');
    if (!payload || !sig || extra) return false;
    if (!await crypto.subtle.verify('HMAC', await key(env.SESSION_SECRET), decode(sig), new TextEncoder().encode(payload))) return false;
    const body = JSON.parse(new TextDecoder().decode(decode(payload)));
    return Number.isFinite(body.exp) && body.exp > now && body.exp <= now + 8 * 3600_000;
  } catch { return false; }
}
export const clearCookie = `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
export function sameOrigin(request) { return request.headers.get('Origin') === new URL(request.url).origin; }
export function authenticatedBearer(request, token) { return !!token && constantEqual(request.headers.get('Authorization') || '', 'Bearer ' + token); }
export function htmlPage(html, headers = {}) {
  const nonce = encode(crypto.getRandomValues(new Uint8Array(18)));
  return new Response(html.replaceAll('__ADMIN_CSP_NONCE__', nonce), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...Object.fromEntries(Object.entries(headers).map(([k,v])=>[k,v.replaceAll('__ADMIN_CSP_NONCE__',nonce)])) } });
}
export async function handleLogin(request, env, consumeAttempt) {
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) return json(503, { ok: false, error: 'auth_disabled' });
  if (!sameOrigin(request)) return json(403, { ok: false, error: 'origin_rejected' });
  if (!await consumeAttempt()) return json(429, { ok: false, error: 'login_throttled' });
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > 4096) return json(413, { ok: false, error: 'payload_too_large' });
  const reader=request.body?.getReader(); if(!reader)return json(400,{ok:false,error:'missing_credentials'});
  let bytes=0; const parts=[];
  try { for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>4096){await reader.cancel();return json(413,{ok:false,error:'payload_too_large'});}parts.push(value);} } finally { reader.releaseLock(); }
  const raw=new Uint8Array(bytes);let i=0;for(const p of parts){raw.set(p,i);i+=p.length;}
  const input = new URLSearchParams(new TextDecoder().decode(raw));
  if (!constantEqual(input.get('pass' + 'word') || '', env.ADMIN_PASSWORD)) return new Response('登录失败，请返回重试。', { status: 401, headers: { 'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store' } });
  return new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': await sessionCookie(env), 'Cache-Control': 'no-store' } });
}
