// Quota and cookie/auth regressions: synthetic values only, no network or credentials.
import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import {
  READ_LIMIT, WRITE_LIMIT, MAX_THRESHOLD, MAX_USAGE_AGE,
  utcDay, usageRatio, availability, eligibleAccounts, parseD1Usage, mergeUsage,
} from './quota.mjs';
import {
  authenticatedBearer, clearCookie, handleLogin, loginPage, htmlPage, sameOrigin, sessionCookie, validSession,
} from './auth.mjs';
import { ADMIN_HTML, LOGIN_HTML, ADMIN_HEADERS, CSP_NONCE_PLACEHOLDER } from './admin-page.mjs';

globalThis.crypto ||= webcrypto;
const NOW = Date.parse('2026-11-22T03:00:00Z');
const VERSION = 'a'.repeat(64);
const ORIGIN = 'https://admin.unit.workers.dev';
const FIELD = 'pass' + 'word';
const AUTH_ENV = { ADMIN_PASSWORD: 'unit-test-only-admin-secret', SESSION_SECRET: 'unit-test-only-cookie-signing-secret' };
const account = (changes = {}) => ({
  alias: 'first', enabled: true, day: utcDay(NOW), observedAt: NOW,
  rowsRead: 100, rowsWritten: 20, readLimit: READ_LIMIT, writeLimit: WRITE_LIMIT,
  localReads: 0, localWrites: 0, error: null, version: VERSION, cooldownUntil: 0, ...changes,
});
const analytics = value => ({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: value }] } }, errors: null });
const cookieRequest = value => new Request(ORIGIN + '/', { headers: { Cookie: value.split(';')[0] } });
const loginRequest = (changes = {}) => new Request(ORIGIN + '/login', {
  method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded', ...changes.headers },
  body: changes.body ?? new URLSearchParams({ [FIELD]: AUTH_ENV.ADMIN_PASSWORD }).toString(),
});

test('D1 policy uses account-wide daily rows and the larger read/write fraction', () => {
  assert.equal(READ_LIMIT, 5_000_000);
  assert.equal(WRITE_LIMIT, 100_000);
  assert.equal(MAX_THRESHOLD, 0.8);
  assert.equal(utcDay(NOW), '2026-11-22');
  assert.equal(usageRatio(account({ rowsRead: 1_000_000, rowsWritten: 30_000 })), 0.3);
  assert.equal(usageRatio(account({ rowsRead: 3_000_000, rowsWritten: 30_000 })), 0.6);
});
for (const changes of [
  { rowsRead: null }, { rowsRead: '0' }, { rowsRead: NaN }, { rowsRead: Infinity },
  { rowsWritten: -1 }, { readLimit: 0 }, { writeLimit: NaN },
  { localReads: -1 }, { localWrites: '1' }, { localReads: Infinity },
]) {
  test('unknown or malformed usage is not fabricated as zero: ' + JSON.stringify(changes), () => {
    assert.equal(usageRatio(account(changes)), null);
    assert.equal(availability(account(changes), VERSION, 0.8, NOW), 'usage_unknown');
  });
}
for (const changes of [
  { rowsRead: 4_000_000 }, { rowsWritten: 80_000 },
  { rowsRead: 3_999_990, localReads: 10 }, { rowsWritten: 79_999, localWrites: 1 },
]) {
  test('either read or write usage at 80% excludes that account: ' + JSON.stringify(changes), () => {
    assert.equal(availability(account(changes), VERSION, 0.8, NOW), 'at_threshold');
    assert.deepEqual(eligibleAccounts([account(changes)], VERSION, { mode: 'balanced', threshold: 0.8 }, NOW), []);
  });
}
test('no caller can raise the protection cutoff above 80%', () => {
  assert.equal(availability(account({ rowsRead: 4_000_000 }), VERSION, 0.95, NOW), 'at_threshold');
  assert.equal(availability(account({ rowsRead: 4_000_000 }), VERSION, NaN, NOW), 'at_threshold');
  assert.equal(availability(account({ rowsRead: 1_000_000 }), VERSION, 0.2, NOW), 'at_threshold');
});
test('freshness, UTC day, enablement, cooldown and dictionary versions gate dispatch', () => {
  assert.equal(availability(account(), VERSION, 0.8, NOW), null);
  assert.equal(availability(account({ enabled: false }), VERSION, 0.8, NOW), 'disabled');
  assert.equal(availability(account({ day: '2026-11-21' }), VERSION, 0.8, NOW), 'usage_unknown');
  assert.equal(availability(account({ observedAt: NOW + 1 }), VERSION, 0.8, NOW), 'usage_unknown');
  assert.equal(availability(account({ observedAt: NOW - MAX_USAGE_AGE }), VERSION, 0.8, NOW), null);
  assert.equal(availability(account({ observedAt: NOW - MAX_USAGE_AGE - 1 }), VERSION, 0.8, NOW), 'usage_unknown');
  assert.equal(availability(account({ cooldownUntil: NOW + 1 }), VERSION, 0.8, NOW), 'cooldown');
  assert.equal(availability(account({ version: 'b'.repeat(64) }), VERSION, 0.8, NOW), 'dictionary_unsynced');
  assert.equal(availability(account(), '', 0.8, NOW), 'dictionary_unsynced');
  assert.equal(availability(account({ error: 'usage_unknown' }), VERSION, 0.8, NOW), 'usage_unknown');
});
test('balanced dispatch chooses low load; failover retains configured order and ignores unavailable nodes', () => {
  const first = account({ alias: 'first', rowsRead: 2_000_000 });
  const second = account({ alias: 'second', rowsRead: 1_000_000 });
  const cutoff = account({ alias: 'at-cutoff', rowsRead: 4_000_000 });
  const source = [first, cutoff, second];
  assert.deepEqual(eligibleAccounts(source, VERSION, { mode: 'balanced', threshold: 0.8 }, NOW).map(a => a.alias), ['second', 'first']);
  assert.deepEqual(eligibleAccounts(source, VERSION, { mode: 'failover', threshold: 0.8 }, NOW).map(a => a.alias), ['first', 'second']);
  assert.deepEqual(source.map(a => a.alias), ['first', 'at-cutoff', 'second']);
  assert.deepEqual(eligibleAccounts([account({ alias: 'recent', lastDispatch: 20 }), account({ alias: 'older', lastDispatch: 10 })], VERSION,
    { mode: 'balanced', threshold: 0.8 }, NOW).map(a => a.alias), ['older', 'recent']);
});
for (const mode of ['balanced', 'failover']) test('independent accounts outrank controller and main bot regardless of usage: ' + mode, () => {
  const main = account({ alias: 'CF77', priority: 2, rowsRead: 1, rowsWritten: 0 });
  const control = account({ alias: '7Star', priority: 1, rowsRead: 2, rowsWritten: 0 });
  const first = account({ alias: '1536267368', priority: 0, rowsRead: 2_000_000 });
  const second = account({ alias: 'KF', priority: 0, rowsRead: 1_000_000 });
  const input = [main, control, first, second];
  assert.deepEqual(eligibleAccounts(input, VERSION, { mode, threshold: 0.8 }, NOW).map(a => a.alias),
    mode === 'balanced' ? ['KF', '1536267368', '7Star', 'CF77'] : ['1536267368', 'KF', '7Star', 'CF77']);
  assert.deepEqual(input.map(a => a.alias), ['CF77', '7Star', '1536267368', 'KF']);
  first.rowsWritten = 80_000; second.observedAt = NOW - MAX_USAGE_AGE - 1;
  assert.deepEqual(eligibleAccounts(input, VERSION, { mode, threshold: 0.8 }, NOW).map(a => a.alias), ['7Star', 'CF77']);
  control.enabled = false;
  assert.deepEqual(eligibleAccounts(input, VERSION, { mode, threshold: 0.8 }, NOW).map(a => a.alias), ['CF77']);
  main.rowsRead = 4_000_000;
  assert.deepEqual(eligibleAccounts(input, VERSION, { mode, threshold: 0.8 }, NOW), []);
});
test('only a valid empty aggregate means measured zero', () => {
  assert.deepEqual(parseD1Usage(analytics([])), { rowsRead: 0, rowsWritten: 0 });
  assert.deepEqual(parseD1Usage(analytics([{ sum: { rowsRead: 120, rowsWritten: 8 } }])), { rowsRead: 120, rowsWritten: 8 });
  const bad = [
    null, {}, { errors: [{ message: 'unit-test-only-error' }] },
    { errors: {}, data: analytics([]).data }, { data: { viewer: { accounts: [] } } },
    { data: { viewer: { accounts: [{}, {}] } } }, { data: { viewer: { accounts: [{}] } } },
    analytics([{}]), analytics([{ sum: { rowsRead: '0', rowsWritten: 0 } }]),
    analytics([{ sum: { rowsRead: 0, rowsWritten: -1 } }]), analytics([{ sum: { rowsRead: 0, rowsWritten: NaN } }]),
    analytics([{ sum: { rowsRead: 0, rowsWritten: 0 } }, { sum: { rowsRead: 0, rowsWritten: 0 } }]),
  ];
  for (const body of bad) assert.equal(parseD1Usage(body), null);
});
test('same-day usage and local deltas remain conservative; a new UTC day resets both', () => {
  const previous = account({ rowsRead: 3_999_980, rowsWritten: 50_000, localReads: 20, localWrites: 2, error: 'old-error' });
  const lower = mergeUsage(previous, { rowsRead: 1_000, rowsWritten: 10 }, NOW + 10_000);
  assert.equal(lower.rowsRead, previous.rowsRead);
  assert.equal(lower.rowsWritten, previous.rowsWritten);
  assert.equal(lower.localReads, 20); assert.equal(lower.localWrites, 2);
  assert.equal(lower.error, null);
  assert.equal(availability(lower, VERSION, 0.8, NOW + 10_000), 'at_threshold');
  const higher = mergeUsage(lower, { rowsRead: 4_100_000, rowsWritten: 51_000 }, NOW + 20_000);
  assert.equal(higher.rowsRead, 4_100_000); assert.equal(higher.rowsWritten, 51_000);
  assert.equal(higher.localReads, 20);
  const tomorrow = NOW + 86400_000;
  const reset = mergeUsage(higher, { rowsRead: 2, rowsWritten: 1 }, tomorrow);
  assert.equal(reset.day, utcDay(tomorrow));
  assert.equal(reset.rowsRead, 2); assert.equal(reset.rowsWritten, 1);
  assert.equal(reset.localReads, 0); assert.equal(reset.localWrites, 0);
  assert.equal(availability(reset, VERSION, 0.8, tomorrow), null);
});

test('signed session cookie is Secure, HttpOnly, Strict and refuses tampering/expiry/key changes', async () => {
  const cookie = await sessionCookie(AUTH_ENV, NOW);
  assert.match(cookie, /^__Host-tgpool=/);
  assert.match(cookie, /Path=\//); assert.match(cookie, /Secure/); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  assert.equal(await validSession(cookieRequest(cookie), AUTH_ENV, NOW), true);
  assert.equal(await validSession(cookieRequest(cookie), AUTH_ENV, NOW + 8 * 3600_000), false);
  assert.equal(await validSession(cookieRequest(cookie), { SESSION_SECRET: 'unit-test-only-other-secret' }, NOW), false);
  assert.equal(await validSession(cookieRequest(cookie), {}, NOW), false);
  const value = cookie.split(';')[0];
  const tampered = value.slice(0, -1) + (value.endsWith('a') ? 'b' : 'a');
  assert.equal(await validSession(cookieRequest(tampered), AUTH_ENV, NOW), false);
  assert.equal(await validSession(cookieRequest(value + '.extra'), AUTH_ENV, NOW), false);
  assert.equal(await validSession(new Request(ORIGIN), AUTH_ENV, NOW), false);
  assert.match(clearCookie, /Max-Age=0/);
});
test('cookie fields are signed rather than mutable client-side state', async () => {
  const cookie = await sessionCookie(AUTH_ENV, NOW);
  const [encoded, signature] = cookie.split(';')[0].split('=')[1].split('.');
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString());
  payload.exp += 86400_000;
  const tampered = '__Host-tgpool=' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.' + signature;
  assert.equal(await validSession(cookieRequest(tampered), AUTH_ENV, NOW), false);
  assert.doesNotMatch(JSON.stringify(payload), /unit-test-only-cookie-signing-secret|unit-test-only-admin-secret/);
});
test('Bearer and Origin checks require exact nonempty values', () => {
  assert.equal(authenticatedBearer(new Request(ORIGIN, { headers: { Authorization: 'Bearer unit-test-only-token' } }), 'unit-test-only-token'), true);
  assert.equal(authenticatedBearer(new Request(ORIGIN, { headers: { Authorization: 'Bearer unit-test-only-token-extra' } }), 'unit-test-only-token'), false);
  assert.equal(authenticatedBearer(new Request(ORIGIN), ''), false);
  assert.equal(sameOrigin(loginRequest()), true);
  assert.equal(sameOrigin(loginRequest({ headers: { Origin: 'https://other.unit.workers.dev' } })), false);
  assert.equal(sameOrigin(new Request(ORIGIN)), false);
});
test('native login field matches delivered HTML and successful login creates only a cookie', async () => {
  assert.match(LOGIN_HTML, new RegExp('name="' + FIELD + '"'));
  assert.match(LOGIN_HTML, new RegExp('type="' + FIELD + '"'));
  assert.match(LOGIN_HTML, new RegExp('autocomplete="current-' + FIELD + '"'));
  let attempts = 0;
  const result = await handleLogin(loginRequest(), AUTH_ENV, async () => { attempts++; return true; });
  assert.equal(attempts, 1); assert.equal(result.status, 303);
  assert.equal(result.headers.get('Location'), '/');
  assert.match(result.headers.get('Set-Cookie'), /HttpOnly/);
  assert.equal(await result.text(), '');
  assert.equal(await validSession(cookieRequest(result.headers.get('Set-Cookie')), AUTH_ENV), true);
});
test('login rejects wrong password, cross-origin and throttled requests without creating a session', async () => {
  let attempts = 0;
  const consume = async () => { attempts++; return true; };
  const bad = await handleLogin(loginRequest({ body: new URLSearchParams({ [FIELD]: 'unit-test-only-wrong' }).toString() }), AUTH_ENV, consume);
  assert.equal(bad.status, 401); assert.equal(bad.headers.get('Set-Cookie'), null);
  assert.doesNotMatch(await bad.text(), /unit-test-only-admin-secret/);
  const cross = await handleLogin(loginRequest({ headers: { Origin: 'https://other.unit.workers.dev' } }), AUTH_ENV, consume);
  assert.equal(cross.status, 403); assert.equal(attempts, 1);
  const rate = await handleLogin(loginRequest(), AUTH_ENV, async () => false);
  assert.equal(rate.status, 429); assert.equal(rate.headers.get('Set-Cookie'), null);
  const disabled = await handleLogin(loginRequest(), {}, consume);
  assert.equal(disabled.status, 503); assert.equal(attempts, 1);
});
test('oversized login form is rejected and never echoes submitted data', async () => {
  const res = await handleLogin(loginRequest({ body: FIELD + '=' + 'x'.repeat(5000) }), AUTH_ENV, async () => true);
  assert.equal(res.status, 413); assert.equal(res.headers.get('Set-Cookie'), null);
  assert.equal((await res.json()).error, 'payload_too_large');
});
async function loginForm(now = NOW, origin = ORIGIN) {
  const response = await loginPage(new Request(origin + '/login'), AUTH_ENV, LOGIN_HTML, ADMIN_HEADERS, now);
  const html = await response.text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(csrf); assert.doesNotMatch(csrf, /__LOGIN_CSRF__/);
  return { response, csrf, cookie: response.headers.get('Set-Cookie').split(';')[0] };
}
function fallbackLogin(form, { origin, referer, fetchSite, csrf = form.csrf, cookie = form.cookie, password = AUTH_ENV.ADMIN_PASSWORD } = {}) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (cookie) headers.Cookie = cookie;
  if (origin !== undefined) headers.Origin = origin;
  if (referer !== undefined) headers.Referer = referer;
  if (fetchSite !== undefined) headers['Sec-Fetch-Site'] = fetchSite;
  return new Request(ORIGIN + '/login', { method: 'POST', headers, body: new URLSearchParams({ [FIELD]: password, csrf }) });
}
test('login page emits a short-lived signed form token without session or credential leakage', async () => {
  const form = await loginForm(); const next = await loginForm();
  assert.match(form.cookie, /^__Host-observe-login=/); assert.notEqual(form.csrf, next.csrf);
  const cookie = form.response.headers.get('Set-Cookie');
  assert.match(cookie, /Secure/); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /Max-Age=600/);
  assert.equal(form.response.headers.get('Referrer-Policy'), 'same-origin');
  assert.equal(form.response.headers.get('Cache-Control'), 'no-store');
  assert.equal(await validSession(cookieRequest(cookie), AUTH_ENV, NOW), false, 'form token grants no authenticated session');
  assert.doesNotMatch(form.csrf, /unit-test-only-admin-secret|unit-test-only-cookie-signing-secret/);
  const unavailable = await loginPage(new Request(ORIGIN + '/login'), {}, LOGIN_HTML, ADMIN_HEADERS, NOW); assert.equal(unavailable.status, 503);
});
for (const origin of [undefined, 'null']) test('native signed form login works when Origin is missing or opaque: ' + String(origin), async () => {
  const form = await loginForm();
  const result = await handleLogin(fallbackLogin(form, { origin }), AUTH_ENV, async () => true, NOW);
  assert.equal(result.status, 303); assert.equal(result.headers.get('Location'), '/');
  const cookies = result.headers.getSetCookie(); assert.equal(cookies.length, 2);
  assert.equal(await validSession(cookieRequest(cookies[0]), AUTH_ENV, NOW), true);
  assert.match(cookies[1], /__Host-observe-login=;.*Max-Age=0/);
});
test('missing Origin still requires matching signed form cookie, expiry and host', async () => {
  const form = await loginForm();
  for (const change of [{ cookie: '' }, { csrf: 'unit-test-only-forged' }, { cookie: '__Host-observe-login=unit-test-only-forged', csrf: 'unit-test-only-forged' }]) {
    const response = await handleLogin(fallbackLogin(form, change), AUTH_ENV, async () => true, NOW);
    assert.equal(response.status, 403); assert.equal(response.headers.get('Set-Cookie'), null);
  }
  const expired = await handleLogin(fallbackLogin(form), AUTH_ENV, async () => true, NOW + 600_000); assert.equal(expired.status, 403);
  const other = await loginForm(NOW, 'https://other.unit.workers.dev');
  const wrongHost = await handleLogin(fallbackLogin(other), AUTH_ENV, async () => true, NOW); assert.equal(wrongHost.status, 403);
  const wrongKey = await handleLogin(fallbackLogin(form), { ...AUTH_ENV, SESSION_SECRET: 'unit-test-only-wrong-key' }, async () => true, NOW); assert.equal(wrongKey.status, 403);
});
test('foreign origins, referers and Fetch Metadata are never rescued by a signed form', async () => {
  const form = await loginForm(); let attempts = 0;
  for (const change of [{ origin: 'https://other.unit.workers.dev' }, { referer: 'https://other.unit.workers.dev/login' }, { referer: 'not a URL' }, { fetchSite: 'cross-site' }]) {
    const response = await handleLogin(fallbackLogin(form, change), AUTH_ENV, async () => { attempts++; return true; }, NOW);
    assert.equal(response.status, 403); assert.equal(response.headers.get('Set-Cookie'), null);
  }
  assert.equal(attempts, 0);
  const wrongPassword = await handleLogin(fallbackLogin(form, { password: 'unit-test-only-wrong' }), AUTH_ENV, async () => true, NOW);
  assert.equal(wrongPassword.status, 401);
});
test('authenticated mutation Origin fallback requires same-origin Referer and never mere absence', () => {
  assert.equal(sameOrigin(new Request(ORIGIN + '/api/admin/control/pause', { method: 'POST', headers: { Referer: ORIGIN + '/' } })), true);
  assert.equal(sameOrigin(new Request(ORIGIN, { headers: { Origin: 'null', Referer: ORIGIN + '/login' } })), true);
  assert.equal(sameOrigin(new Request(ORIGIN, { headers: { Origin: 'https://other.unit.workers.dev', Referer: ORIGIN + '/' } })), false);
  assert.equal(sameOrigin(new Request(ORIGIN, { headers: { Referer: ORIGIN + '/', 'Sec-Fetch-Site': 'cross-site' } })), false);
  assert.equal(sameOrigin(new Request(ORIGIN, { headers: { 'Sec-Fetch-Site': 'same-origin' } })), false);
});
test('each page receives one matching CSP/style/script nonce and never renders test credentials', async () => {
  const first = htmlPage(ADMIN_HTML, ADMIN_HEADERS);
  const second = htmlPage(ADMIN_HTML, ADMIN_HEADERS);
  const firstHtml = await first.text(), secondHtml = await second.text();
  const nonce = first.headers.get('Content-Security-Policy').match(/'nonce-([^']+)'/)[1];
  const nonces = [...firstHtml.matchAll(/nonce="([^"]+)"/g)].map(match => match[1]);
  assert.ok(nonces.length >= 2);
  assert.ok(nonces.every(value => value === nonce));
  assert.doesNotMatch(firstHtml, new RegExp(CSP_NONCE_PLACEHOLDER));
  assert.notEqual(firstHtml.match(/nonce="([^"]+)"/)[1], secondHtml.match(/nonce="([^"]+)"/)[1]);
  assert.match(first.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.doesNotMatch(firstHtml, /unit-test-only-admin-secret|unit-test-only-cookie-signing-secret/);
  const login = htmlPage(LOGIN_HTML, ADMIN_HEADERS), loginHtml = await login.text();
  const loginNonce = login.headers.get('Content-Security-Policy').match(/'nonce-([^']+)'/)[1];
  assert.equal(loginHtml.match(/nonce="([^"]+)"/)[1], loginNonce);
});
