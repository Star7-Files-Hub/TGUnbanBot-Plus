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
    if (!payload || !sig || extra || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return false;
    const signature = decode(sig);
    // Reject noncanonical base64 aliases that differ only in unused tail bits.
    if (encode(signature) !== sig || encode(decode(payload)) !== payload) return false;
    if (!await crypto.subtle.verify('HMAC', await key(env.SESSION_SECRET), signature, new TextEncoder().encode(payload))) return false;
    const body = JSON.parse(new TextDecoder().decode(decode(payload)));
    return Number.isFinite(body.exp) && body.exp > now && body.exp <= now + 8 * 3600_000;
  } catch { return false; }
}
export const clearCookie = `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
export function sameOrigin(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const origin = request.headers.get('Origin');
  if (origin !== null && origin !== 'null') return origin === new URL(request.url).origin;
  // Browser/webview policies can omit Origin. Only an explicit same-origin
  // Referer with no contradictory Fetch Metadata is accepted for mutations.
  const referer = request.headers.get('Referer');
  if (!referer) return false;
  try { return new URL(referer).origin === new URL(request.url).origin; } catch { return false; }
}
const LOGIN_COOKIE = '__Host-observe-login';
const LOGIN_MAX_AGE = 600_000;
export const LOGIN_CSRF_PLACEHOLDER = '__LOGIN_CSRF__';
const cookieValue = (request, name) => (request.headers.get('Cookie') || '').split(';').map(value => value.trim())
  .find(value => value.startsWith(name + '='))?.slice(name.length + 1);
async function signedLoginToken(request, env, now) {
  const payload = encode(new TextEncoder().encode(JSON.stringify({ purpose: 'login', origin: new URL(request.url).origin,
    exp: now + LOGIN_MAX_AGE, salt: encode(crypto.getRandomValues(new Uint8Array(24))) })));
  const signature = encode(new Uint8Array(await crypto.subtle.sign('HMAC', await key(env.SESSION_SECRET), new TextEncoder().encode(payload))));
  return payload + '.' + signature;
}
async function validLoginToken(request, env, submitted, now) {
  const cookie = cookieValue(request, LOGIN_COOKIE);
  if (!cookie || typeof submitted !== 'string' || cookie.length > 1200 || !constantEqual(cookie, submitted)) return false;
  try {
    const [payload, sig, extra] = cookie.split('.');
    if (!payload || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]{43}$/.test(sig || '') || extra) return false;
    const signature = decode(sig);
    if (encode(signature) !== sig || encode(decode(payload)) !== payload) return false;
    if (!await crypto.subtle.verify('HMAC', await key(env.SESSION_SECRET), signature, new TextEncoder().encode(payload))) return false;
    const body = JSON.parse(new TextDecoder().decode(decode(payload)));
    return body.purpose === 'login' && body.origin === new URL(request.url).origin && typeof body.salt === 'string'
      && Number.isFinite(body.exp) && body.exp > now && body.exp <= now + LOGIN_MAX_AGE;
  } catch { return false; }
}
export async function loginPage(request, env, html, headers = {}, now = Date.now()) {
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) return json(503, { ok: false, error: 'auth_disabled' });
  const token = await signedLoginToken(request, env, now);
  const response = htmlPage(html.replaceAll(LOGIN_CSRF_PLACEHOLDER, token), { ...headers, 'Referrer-Policy': 'same-origin' });
  response.headers.set('Set-Cookie', `${LOGIN_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=600`);
  return response;
}
export function authenticatedBearer(request, token) { return !!token && constantEqual(request.headers.get('Authorization') || '', 'Bearer ' + token); }
export function htmlPage(html, headers = {}) {
  const nonce = encode(crypto.getRandomValues(new Uint8Array(18)));
  return new Response(html.replaceAll('__ADMIN_CSP_NONCE__', nonce), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...Object.fromEntries(Object.entries(headers).map(([k,v])=>[k,v.replaceAll('__ADMIN_CSP_NONCE__',nonce)])) } });
}
export async function handleLogin(request, env, consumeAttempt, now = Date.now()) {
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) return json(503, { ok: false, error: 'auth_disabled' });
  const origin = request.headers.get('Origin');
  // A real foreign Origin or Fetch Metadata is never rescued by the form token.
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site'
      || (origin !== null && origin !== 'null' && origin !== new URL(request.url).origin)) return json(403, { ok: false, error: 'origin_rejected' });
  const referer = request.headers.get('Referer');
  if (referer) {
    try { if (new URL(referer).origin !== new URL(request.url).origin) return json(403, { ok: false, error: 'origin_rejected' }); }
    catch { return json(403, { ok: false, error: 'origin_rejected' }); }
  }
  if (!await consumeAttempt()) return json(429, { ok: false, error: 'login_throttled' });
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > 4096) return json(413, { ok: false, error: 'payload_too_large' });
  const reader=request.body?.getReader(); if(!reader)return json(400,{ok:false,error:'missing_credentials'});
  let bytes=0; const parts=[];
  try { for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>4096){await reader.cancel();return json(413,{ok:false,error:'payload_too_large'});}parts.push(value);} } finally { reader.releaseLock(); }
  const raw=new Uint8Array(bytes);let i=0;for(const p of parts){raw.set(p,i);i+=p.length;}
  const input = new URLSearchParams(new TextDecoder().decode(raw));
  if (origin === null || origin === 'null') {
    if (input.getAll('csrf').length !== 1 || !await validLoginToken(request, env, input.get('csrf'), now)) return json(403, { ok: false, error: 'origin_rejected' });
  }
  if (input.getAll('pass' + 'word').length !== 1 || !constantEqual(input.get('pass' + 'word') || '', env.ADMIN_PASSWORD)) return new Response('登录失败，请返回重试。', { status: 401, headers: { 'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store' } });
  const headers = new Headers({ Location: '/', 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', await sessionCookie(env, now));
  headers.append('Set-Cookie', `${LOGIN_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`);
  return new Response(null, { status: 303, headers });
}
