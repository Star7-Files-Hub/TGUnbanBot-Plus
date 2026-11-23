// Real in-memory SQLite DO integration; every external API is a fake, never a real account.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createHash, webcrypto } from 'node:crypto';
import worker, { ObservePool, MAX_QUEUE, REFRESH_MS, DICTIONARY_MAX_AGE, accountConfig } from './controller-worker.js';
import { sessionCookie } from './auth.mjs';
import { normalized } from './protocol.mjs';
import { MAX_USAGE_AGE, utcDay } from './quota.mjs';
globalThis.crypto ||= webcrypto;

const ORIGIN = 'https://pool-admin.unit.workers.dev', BETA = 'https://pool-beta.unit.workers.dev';
const GROUP = '-1000123456', OWNER = '999999';
const NODES = ['https://pool-node-one.unit.workers.dev', 'https://pool-node-two.unit.workers.dev'];
const ACCOUNT_IDS = ['1'.repeat(32), '2'.repeat(32)];
const message = (changes = {}) => ({ chat_id: GROUP, chat_title: 'Unit observation source', message_id: 12,
  user_id: '555555', first_name: 'Unit member', last_name: '', username: 'unit_member', is_bot: false,
  text: '高价收购实名号四件套长期招代理', quote: '', contact_name: '', ...changes });
const dictionaryData = () => ({ fingerprints: [], samples: [{ id: 10,
  norm_hash: createHash('sha256').update(normalized('高价收购实名号')).digest('hex'), sample_text: '高价收购实名号',
  kind: 'text', embedding: [1, 0, 0], count: 0 }], owners: [OWNER], whitelist: [], allowlist: [] });
const json = (body, status = 200) => Response.json(body, { status });
const defer = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
function environment() {
  return { POOL_ACCOUNTS: JSON.stringify([
    { alias: 'CF77', accountId: ACCOUNT_IDS[0], url: NODES[0] + '/', nodeTokenEnv: 'FIRST_NODE_TOKEN', analyticsTokenEnv: 'FIRST_ANALYTICS_TOKEN' },
    { alias: '7Star', accountId: ACCOUNT_IDS[1], url: NODES[1] + '/', nodeTokenEnv: 'SECOND_NODE_TOKEN', analyticsTokenEnv: 'SECOND_ANALYTICS_TOKEN' }]),
    FIRST_NODE_TOKEN: 'unit-test-only-first-node-token', SECOND_NODE_TOKEN: 'unit-test-only-second-node-token',
    FIRST_ANALYTICS_TOKEN: 'unit-test-only-first-analytics-token', SECOND_ANALYTICS_TOKEN: 'unit-test-only-second-analytics-token',
    BETA_URL: BETA, BETA_CONTROL_TOKEN: 'unit-test-only-beta-control-token', SOURCE_ALIAS: 'CF77', OWNER_ID: OWNER,
    BOT_TOKEN: 'unit-test-only-bot-token', COLLECTOR_TOKEN: 'unit-test-only-collector-token',
    ADMIN_PASSWORD: 'unit-test-only-admin-password', SESSION_SECRET: 'unit-test-only-session-secret' };
}
function fakeState(db = new DatabaseSync(':memory:')) {
  const statements = [], initialization = []; let alarm = null;
  const ctx = { storage: {
    sql: { exec(sql, ...params) {
      statements.push({ sql, params }); const values = db.prepare(sql).all(...params).map(row => ({ ...row }));
      return { toArray: () => values, one() { assert.equal(values.length, 1); return values[0]; } };
    } },
    async getAlarm() { return alarm; }, async setAlarm(value) { alarm = value; },
    transactionSync(callback) {
      db.exec('BEGIN IMMEDIATE');
      try { const value = callback(); assert.ok(!(value instanceof Promise)); db.exec('COMMIT'); return value; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  }, blockConcurrencyWhile(callback) { const p = Promise.resolve().then(callback); initialization.push(p); return p; } };
  return { ctx, db, statements, initialized: () => Promise.all(initialization), get alarm() { return alarm; } };
}
async function harness(t, { bootstrap = true } = {}) {
  const state = fakeState(), env = environment(), calls = [];
  const usage = new Map(ACCOUNT_IDS.map(id => [id, { rowsRead: 1000, rowsWritten: 100 }]));
  const hooks = { source: null, classify: null, upload: null, telegram: null, analytics: null }; let mid = 100;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(typeof url === 'string' ? url : url.url), body = options.body ? JSON.parse(options.body) : undefined;
    const c = { url: u.href, origin: u.origin, path: u.pathname, options, body }; calls.push(c);
    assert.equal(options.redirect, 'manual', 'Workers-compatible authenticated fetch must never follow redirects');
    if (u.hostname === 'api.cloudflare.com') {
      assert.equal(c.path, '/client/v4/graphql'); assert.match(body.query, /rowsRead rowsWritten/); assert.doesNotMatch(body.query, /databaseId:/);
      if (hooks.analytics) return hooks.analytics(c);
      const sum = usage.get(body.variables.a);
      return json({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: sum ? [{ sum }] : [] }] } }, errors: null });
    }
    if (u.origin === BETA) {
      if (hooks.source) { const r = await hooks.source(c); if (r) return r; }
      if (c.path === '/api/pool/dictionary') return json({ ok: true, data: dictionaryData(), observe_groups: [GROUP] });
      if (c.path === '/api/pool/action') return json({ ok: true, summary: 'Unit approval persisted.' });
      if (c.path === '/api/pool/hits') return json({ ok: true, applied: body.hits.length });
    }
    if (NODES.includes(u.origin)) {
      if (c.path === '/dictionary') {
        if (hooks.upload) { const r = await hooks.upload(c); if (r) return r; }
        return json({ ok: true, version: body.version, metrics: { rowsRead: 0, rowsWritten: 1 } });
      }
      if (c.path === '/classify') return hooks.classify ? hooks.classify(c)
        : json({ ok: true, version: body.version, kind: 'normal', reason: 'ai_ok', evidence: '', metrics: { rowsRead: 1, rowsWritten: 0 } });
    }
    if (u.hostname === 'api.telegram.org') {
      if (hooks.telegram) { const r = await hooks.telegram(c); if (r) return r; }
      return json({ ok: true, result: c.path.endsWith('/sendMessage') ? { message_id: mid++ } : true });
    }
    throw new Error('Unexpected fake API route');
  };
  t.after(() => { globalThis.fetch = originalFetch; state.db.close(); });
  const pool = new ObservePool(state.ctx, env); await state.initialized();
  env.POOL = { idFromName(name) { assert.equal(name, 'primary'); return name; }, get: () => ({ fetch: request => pool.fetch(request) }) };
  if (bootstrap) { await pool.refresh(true); await pool.sync(true); assert.ok(pool.version); }
  calls.length = 0;
  return { ...state, env, pool, calls, usage, hooks,
    classified: () => calls.filter(c => c.path === '/classify'), notifications: () => calls.filter(c => c.path.endsWith('/sendMessage')),
    setUsage(index, changes) { Object.assign(pool.accounts[index], { rowsRead: 1000, rowsWritten: 100, localReads: 0, localWrites: 0,
      day: utcDay(), observedAt: Date.now(), error: null, version: pool.version, cooldownUntil: 0, ...changes }); },
  };
}
const internal = (h, path, body) => h.pool.fetch(new Request('https://pool.internal' + path, {
  method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }));
const ingest = (h, body = message()) => internal(h, '/ingest', body);
function publicCall(h, path, { method = 'GET', body, token, cookie, origin, action } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token; if (cookie) headers.Cookie = cookie.split(';')[0];
  if (origin !== undefined) headers.Origin = origin; if (action) headers['X-Control-Action'] = action;
  return worker.fetch(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), h.env);
}
const candidate = (c, changes = {}) => json({ ok: true, version: c.body.version, kind: 'candidate', evidence: c.body.message.text,
  reason: 'structure', matched_field: 'text', metrics: { rowsRead: 1, rowsWritten: 0 }, ...changes });
const callback = (h, id, action = 'save', changes = {}) => internal(h, '/review', { callback: { id: 'unit-callback-id',
  data: 'op:' + action + ':' + id, from: { id: OWNER }, message: { message_id: h.pool.event(id)?.telegram_mid || 101,
    chat: { id: OWNER, type: 'private' } }, ...changes } });

test('DO initializes state without a D1 binding and redacts configured secrets from status', async t => {
  const h = await harness(t); assert.ok(Number.isFinite(h.alarm));
  const data = (await (await internal(h, '/state')).json()).data;
  assert.equal(data.accounts.length, 2); assert.equal(data.paused, false);
  for (const [key, secret] of Object.entries(h.env)) if (typeof secret === 'string' && /TOKEN|SECRET|PASSWORD/.test(key)) assert.ok(!JSON.stringify(data).includes(secret));
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='dictionary_snapshot'").get().n, 0);
});
test('balanced mode routes to the lower usage and returns a durable global receipt', async t => {
  const h = await harness(t); h.setUsage(0, { rowsRead: 2_000_000 }); h.setUsage(1, { rowsRead: 1_000_000 });
  const res = await ingest(h), data = await res.json(); assert.equal(res.status, 200);
  assert.equal(data.accepted, true); assert.match(data.event_id, /^[a-f0-9]{24}$/);
  assert.equal(h.classified()[0].origin, NODES[1]); assert.equal(h.pool.event(data.event_id).status, 'ignored');
});
test('failover preserves configuration order and excludes the failed node on the next attempt', async t => {
  const h = await harness(t); h.pool.config.mode = 'failover'; h.setUsage(0, { rowsRead: 2_000_000 }); h.setUsage(1, { rowsRead: 100 });
  h.hooks.classify = c => c.origin === NODES[0] ? json({ ok: false }, 503) : json({ ok: true, version: c.body.version, kind: 'normal', metrics: { rowsRead: 1, rowsWritten: 0 } });
  assert.equal((await ingest(h)).status, 200); assert.deepEqual(h.classified().map(c => c.origin), NODES);
  assert.ok(h.pool.accounts[0].cooldownUntil > Date.now());
});
for (const cutoff of [{ rowsRead: 4_000_000 }, { rowsWritten: 80_000 }]) {
  test('all-account cutoff pauses before persistence, classification and notification: ' + JSON.stringify(cutoff), async t => {
    const h = await harness(t); h.setUsage(0, cutoff); h.setUsage(1, cutoff);
    assert.equal(h.pool.status().observe_allowed, false);
    const res = await ingest(h), data = await res.json(); assert.equal(res.status, 503); assert.equal(data.paused, true); assert.equal(data.retryAfter, 60);
    assert.equal(h.classified().length, 0); assert.equal(h.notifications().length, 0); assert.equal(h.db.prepare('SELECT COUNT(*) n FROM events').get().n, 0);
  });
}
test('one cutoff account does not suppress the remaining healthy node', async t => {
  const h = await harness(t); h.setUsage(0, { rowsRead: 4_000_000 }); assert.equal((await ingest(h)).status, 200); assert.equal(h.classified()[0].origin, NODES[1]);
});
test('unknown/stale usage pauses; a fresh new-UTC-day measurement resets old totals and deltas', async t => {
  const h = await harness(t); h.setUsage(0, { rowsRead: null, error: 'usage_unknown' }); h.setUsage(1, { observedAt: Date.now() - MAX_USAGE_AGE - 1 });
  assert.equal(h.pool.status().observe_allowed, false); h.hooks.analytics = () => json({ errors: [{ message: 'unit-test-only-unknown' }] });
  assert.equal((await ingest(h)).status, 503); assert.equal(h.classified().length, 0);
  for (const a of h.pool.accounts) Object.assign(a, { day: '2000-01-01', rowsRead: 6_000_000, localReads: 10 });
  h.hooks.analytics = null; await h.pool.refresh(true); assert.ok(h.pool.accounts.every(a => a.day === utcDay() && a.rowsRead === 1000 && a.localReads === 0));
  assert.equal(h.pool.status().observe_allowed, true);
});
test('manual pause persists, and resume cannot bypass the quota cutoff', async t => {
  const h = await harness(t); await internal(h, '/control/pause', {}); assert.equal(h.pool.status().reason, 'manual_pause');
  assert.equal((await ingest(h)).status, 503); h.setUsage(0, { rowsRead: 4_000_000 }); h.setUsage(1, { rowsWritten: 80_000 });
  await internal(h, '/control/resume', {}); assert.equal(h.pool.status().observe_allowed, false); assert.equal(h.pool.get('config', {}).manualPaused, false);
});
test('notifying events count toward queue capacity and pause status', async t => {
  const h = await harness(t), now = Date.now(); const stmt = h.db.prepare("INSERT INTO events(id,event_key,message,status,created_at,updated_at) VALUES (?,?,?,'notifying',?,?)");
  h.db.exec('BEGIN'); for (let i = 0; i < MAX_QUEUE; i++) stmt.run('unit-' + i, 'key-' + i, '{}', now, now); h.db.exec('COMMIT');
  assert.equal(h.pool.status().reason, 'queue_full'); assert.equal((await ingest(h)).status, 503); assert.equal(h.classified().length, 0);
});
for (const kind of ['fingerprint', 'semantic']) {
  test(kind + ' matches are silent and transport retries do not repeat counters', async t => {
    const h = await harness(t); h.hooks.classify = c => json({ ok: true, version: c.body.version, kind, sample_id: 10,
      fingerprint_id: 1, matched_field: 'text', evidence: c.body.message.text, metrics: { rowsRead: 1, rowsWritten: 0 } });
    const body = await (await ingest(h)).json(); assert.equal(body.accepted, true); assert.equal(body.status, kind); assert.equal(h.notifications().length, 0);
    assert.equal((await (await ingest(h)).json()).status, 'duplicate'); assert.equal(h.classified().length, 1);
    const rows = h.db.prepare('SELECT * FROM hits').all(); assert.equal(rows.length, kind === 'semantic' ? 1 : 0); if (rows.length) assert.equal(rows[0].total, 1);
  });
}
test('candidate sends one globally keyed review and no duplicate notification', async t => {
  const h = await harness(t); h.hooks.classify = c => candidate(c); const data = await (await ingest(h)).json();
  assert.equal(h.pool.event(data.event_id).status, 'review'); assert.equal(h.notifications().length, 1);
  assert.equal(h.notifications()[0].body.reply_markup.inline_keyboard[0][0].callback_data, 'op:save:' + data.event_id);
  assert.equal((await (await ingest(h)).json()).status, 'duplicate'); assert.equal(h.notifications().length, 1);
});
test('same event concurrently returns a separate busy response and only sends one review', async t => {
  const h = await harness(t), began = defer(), finish = defer();
  h.hooks.classify = async c => { began.resolve(); await finish.promise; return candidate(c); };
  const first = ingest(h); await began.promise; const second = await ingest(h); assert.equal(second.status, 409); assert.equal((await second.json()).error, 'busy');
  finish.resolve(); assert.equal((await (await first).json()).accepted, true); assert.equal(h.notifications().length, 1);
});
test('notification uncertainty persists and never triggers an automatic resend', async t => {
  const h = await harness(t); h.hooks.classify = c => candidate(c); h.hooks.telegram = c => { if (c.path.endsWith('/sendMessage')) throw new Error('unit-test-only-transport-uncertainty'); };
  const data = await (await ingest(h)).json(); assert.equal(data.accepted, true); assert.equal(h.pool.event(data.event_id).status, 'notification_uncertain');
  assert.equal((await (await ingest(h)).json()).status, 'duplicate'); assert.equal(h.notifications().length, 1);
});
test('manual multi-ID spam derives unique target reviews without classifying or using command text as evidence', async t => {
  const h = await harness(t); const input = message({ text: '/spam 111111,222222,111111' });
  assert.equal((await (await ingest(h, input)).json()).status, 'command'); assert.equal(h.classified().length, 0); assert.equal(h.notifications().length, 2);
  const children = h.db.prepare("SELECT * FROM events WHERE status='review'").all(); assert.equal(children.length, 2); assert.notEqual(children[0].id, children[1].id);
  assert.deepEqual(children.map(c => JSON.parse(c.message).user_id).sort(), ['111111', '222222']); assert.ok(children.every(c => c.evidence === ''));
  await ingest(h, input); assert.equal(h.notifications().length, 2);
});
test('reply-form spam uses the replied sender and source text, never the reporter', async t => {
  const h = await harness(t); const res = await ingest(h, message({ text: '/spam', user_id: '333333', reply: { user_id: '444444', message_id: 11,
    text: '实名号批发接单', first_name: 'Unit target', last_name: '', username: 'unit_target', quote: '', contact_name: '' } }));
  assert.equal(res.status, 200); assert.equal(h.notifications().length, 1); assert.equal(h.classified().length, 0);
  const child = h.db.prepare("SELECT * FROM events WHERE status='review'").get(); assert.equal(JSON.parse(child.message).user_id, '444444'); assert.equal(child.evidence, '实名号批发接单');
});
test('invalid spam target lists fail atomically without events or notifications', async t => {
  const h = await harness(t); assert.equal((await ingest(h, message({ text: '/spam 111111,not-an-id' }))).status, 400);
  assert.equal(h.notifications().length, 0); assert.equal(h.db.prepare('SELECT COUNT(*) n FROM events').get().n, 0);
});
test('approval execution is single-flight and never repeats a Beta action', async t => {
  const h = await harness(t); h.hooks.classify = c => candidate(c); const id = (await (await ingest(h)).json()).event_id;
  const began = defer(), finish = defer(); h.hooks.source = async c => { if (c.path === '/api/pool/action') { began.resolve(); await finish.promise; return json({ ok: true, summary: 'Unit approval completed.' }); } };
  const first = callback(h, id); await began.promise; assert.equal((await callback(h, id)).status, 200); await h.pool.applyApproval(id);
  assert.equal(h.calls.filter(c => c.path === '/api/pool/action').length, 1); finish.resolve(); await first; assert.equal(h.pool.event(id).status, 'approved');
  assert.equal((await callback(h, id, 'save', { from: { id: '777777' } })).status, 403);
});
test('callback bound to a wrong Telegram message cannot approve an existing review', async t => {
  const h = await harness(t); h.hooks.classify = c => candidate(c); const id = (await (await ingest(h)).json()).event_id;
  await callback(h, id, 'save', { message: { message_id: 999999, chat: { id: OWNER, type: 'private' } } });
  assert.equal(h.pool.event(id).status, 'review'); assert.equal(h.calls.filter(c => c.path === '/api/pool/action').length, 0);
});
test('Beta unavailable leaves pending decision and never reports approval success', async t => {
  const h = await harness(t); h.hooks.classify = c => candidate(c); const id = (await (await ingest(h)).json()).event_id;
  h.hooks.source = c => c.path === '/api/pool/action' ? json({ ok: false }, 503) : null;
  await callback(h, id); assert.equal(h.pool.event(id).status, 'sync_pending');
  const edits = h.calls.filter(c => c.path.endsWith('/editMessageText')); assert.ok(edits.some(c => c.body.text.includes('同步暂不可用')));
  assert.ok(edits.every(c => !c.body.text.includes('✅ 观察复核已确认')));
});
test('unknown source-account usage queues approval without calling Beta', async t => {
  const h = await harness(t); h.hooks.classify = c => candidate(c);
  const id = (await (await ingest(h)).json()).event_id;
  h.setUsage(0, { rowsRead: null, error: 'usage_unknown' });
  await callback(h, id);
  assert.equal(h.pool.event(id).status, 'sync_pending');
  assert.equal(h.calls.filter(c => c.path === '/api/pool/action').length, 0, 'unknown source quota must not be treated as free capacity');
  assert.ok(h.calls.filter(c => c.path.endsWith('/editMessageText')).every(c => !c.body.text.includes('✅ 观察复核已确认')));
});

test('absent configured source account queues approval instead of calling Beta', async t => {
  const h = await harness(t); h.hooks.classify = c => candidate(c);
  const id = (await (await ingest(h)).json()).event_id;
  h.env.SOURCE_ALIAS = 'not-a-configured-account';
  await callback(h, id);
  assert.equal(h.pool.event(id).status, 'sync_pending');
  assert.equal(h.calls.filter(c => c.path === '/api/pool/action').length, 0);
});

for (const limit of [{ rowsRead: 4_000_000 }, { rowsWritten: 80_000 }, { observedAt: Date.now() - MAX_USAGE_AGE - 1 }]) {
  test('source cutoff or stale usage keeps approval pending: ' + JSON.stringify(limit), async t => {
    const h = await harness(t); h.hooks.classify = c => candidate(c);
    const id = (await (await ingest(h)).json()).event_id;
    h.setUsage(0, limit); await callback(h, id);
    assert.equal(h.pool.event(id).status, 'sync_pending');
    assert.equal(h.calls.filter(c => c.path === '/api/pool/action').length, 0);
  });
}

test('dismissal closes review without writing a Beta approval', async t => {
  const h = await harness(t); h.hooks.classify = c => candidate(c); const id = (await (await ingest(h)).json()).event_id;
  await callback(h, id, 'dismiss'); assert.equal(h.pool.event(id).status, 'dismissed'); assert.equal(h.calls.filter(c => c.path === '/api/pool/action').length, 0);
});
test('hit batch synchronization is single-flight and counts each acknowledgement only once', async t => {
  const h = await harness(t); h.db.prepare('INSERT INTO hits(sample_id,total,synced) VALUES (10,5,0)').run(); const began = defer(), finish = defer();
  h.hooks.source = async c => { if (c.path === '/api/pool/hits') { began.resolve(); await finish.promise; return json({ ok: true }); } };
  const first = h.pool.flushHits(); await began.promise; const second = h.pool.flushHits(); finish.resolve(); await Promise.all([first, second]);
  assert.equal(h.calls.filter(c => c.path === '/api/pool/hits').length, 1); assert.equal(h.db.prepare('SELECT synced FROM hits').get().synced, 5);
  assert.equal(h.db.prepare('SELECT status FROM hit_batches').get().status, 'done'); await h.pool.flushHits(); assert.equal(h.calls.filter(c => c.path === '/api/pool/hits').length, 1);
});
test('hit counters remain queued when source account has reached cutoff', async t => {
  const h = await harness(t); h.db.prepare('INSERT INTO hits(sample_id,total,synced) VALUES (10,5,0)').run(); h.setUsage(0, { rowsRead: 4_000_000 });
  await h.pool.flushHits(); assert.equal(h.calls.filter(c => c.path === '/api/pool/hits').length, 0); assert.equal(h.db.prepare('SELECT synced FROM hits').get().synced, 0);
});
test('bootstrap unavailable source pauses without uploading an empty dictionary', async t => {
  const h = await harness(t, { bootstrap: false }); h.hooks.source = () => json({ ok: false }, 503); await h.pool.refresh(true); await h.pool.sync(true);
  assert.equal(h.pool.status().observe_allowed, false); assert.equal(h.pool.version, ''); assert.equal(h.pool.get('sync_error', null), 'source_unavailable');
  assert.equal(h.calls.filter(c => c.path === '/dictionary').length, 0);
});
test('invalid source dictionary cannot become a usable first snapshot', async t => {
  const h = await harness(t, { bootstrap: false }); h.hooks.source = () => json({ ok: true, data: { ...dictionaryData(), samples: [{ id: 1, norm_hash: 'invalid' }] }, observe_groups: [GROUP] });
  await h.pool.refresh(true); await h.pool.sync(true); assert.equal(h.pool.status().observe_allowed, false); assert.equal(h.pool.dictionary, null); assert.equal(h.calls.filter(c => c.path === '/dictionary').length, 0);
});
test('expired dictionary pauses despite fresh account usage', async t => {
  const h = await harness(t); h.pool.syncedAt = Date.now() - DICTIONARY_MAX_AGE - 1;
  assert.equal(h.pool.status().reason, 'dictionary_unavailable'); assert.equal((await ingest(h)).status, 503); assert.equal(h.classified().length, 0);
});
test('persisted config/usage survives DO reconstruction and preserves the pause policy', async t => {
  const h = await harness(t);
  const changed = await internal(h, '/control/config', { mode: 'failover', threshold: 0.7,
    accounts: [{ alias: 'CF77', enabled: false }, { alias: '7Star', enabled: true }] });
  assert.equal(changed.status, 200);
  await internal(h, '/control/pause', {});
  const restoredState = fakeState(h.db), restored = new ObservePool(restoredState.ctx, h.env);
  await restoredState.initialized();
  assert.equal(restored.config.mode, 'failover'); assert.equal(restored.config.threshold, 0.7);
  assert.equal(restored.accounts[0].enabled, false); assert.equal(restored.accounts[1].enabled, true);
  assert.equal(restored.version, h.pool.version); assert.deepEqual(restored.groups, [GROUP]);
  assert.equal(restored.status().reason, 'manual_pause');
});

test('snapshot generation persists a validated exact version on every active node', async t => {
  const h = await harness(t, { bootstrap: false }); await h.pool.refresh(true); await h.pool.sync(true);
  const uploads = h.calls.filter(c => c.path === '/dictionary'); assert.equal(uploads.length, 2);
  assert.ok(uploads.every(c => c.body.version === h.pool.version));
  assert.ok(uploads.every(c => c.body.data.samples[0].count === 0));
  assert.ok(h.pool.accounts.every(a => a.version === h.pool.version));
  const previous = h.pool.version;
  h.hooks.source = c => c.path === '/api/pool/dictionary' ? json({ ok: true,
    data: { ...dictionaryData(), samples: dictionaryData().samples.map(s => ({ ...s, count: 9999 })) }, observe_groups: [GROUP] }) : null;
  await h.pool.sync(true);
  assert.equal(h.pool.version, previous, 'hot hit count cannot churn the dictionary version');
});

test('node 409 version mismatch invalidates sync state and allows upload after cooldown', async t => {
  const h = await harness(t); h.pool.config.mode = 'failover'; h.hooks.classify = c => c.origin === NODES[0] ? json({ ok: false, error: 'dictionary_version_mismatch' }, 409)
    : json({ ok: true, version: c.body.version, kind: 'normal', metrics: { rowsRead: 1, rowsWritten: 0 } });
  assert.equal((await ingest(h)).status, 200); const bad = h.pool.accounts[0]; assert.notEqual(bad.version, h.pool.version);
  bad.cooldownUntil = 0; await h.pool.sync(false); assert.ok(h.calls.some(c => c.origin === NODES[0] && c.path === '/dictionary'));
});
test('wrong collector/Beta/admin auth never accesses the Durable Object', async t => {
  const h = await harness(t); let forwards = 0; h.env.POOL = { idFromName() { forwards++; throw new Error('must-not-forward'); } };
  for (const path of ['/api/collector/status', '/api/ingest', '/api/beta/ingest', '/api/beta/review', '/api/admin/state']) {
    const get = path.endsWith('status') || path.endsWith('state'); assert.equal((await publicCall(h, path, { method: get ? 'GET' : 'POST', body: get ? undefined : message(), token: 'unit-test-only-wrong' })).status, 401);
  }
  assert.equal(forwards, 0);
});
test('admin mutations need a valid cookie, matching Origin and explicit action header', async t => {
  const h = await harness(t), cookie = await sessionCookie(h.env); assert.equal((await publicCall(h, '/api/admin/state', { cookie })).status, 200);
  assert.equal((await publicCall(h, '/api/admin/control/pause', { method: 'POST', body: {}, cookie, origin: 'https://other.unit.workers.dev', action: '1' })).status, 403);
  assert.equal((await publicCall(h, '/api/admin/control/pause', { method: 'POST', body: {}, cookie, origin: ORIGIN })).status, 403); assert.equal(h.pool.config.manualPaused, false);
  assert.equal((await publicCall(h, '/api/admin/control/pause', { method: 'POST', body: {}, cookie, origin: ORIGIN, action: '1' })).status, 200); assert.equal(h.pool.config.manualPaused, true);
  assert.equal((await publicCall(h, '/logout', { method: 'POST', body: {}, cookie, origin: ORIGIN, action: '1' })).status, 204);
});
test('authenticated HTML binds nonce to CSP and does not contain configured secrets', async t => {
  const h = await harness(t), cookie = await sessionCookie(h.env); const res = await publicCall(h, '/', { cookie }), html = await res.text(); assert.equal(res.status, 200);
  const nonce = res.headers.get('Content-Security-Policy').match(/'nonce-([^']+)'/)[1]; assert.ok([...html.matchAll(/nonce="([^"]+)"/g)].every(m => m[1] === nonce));
  for (const [key, value] of Object.entries(h.env)) if (typeof value === 'string' && /TOKEN|SECRET|PASSWORD/.test(key)) assert.ok(!html.includes(value));
});
for (const path of ['/api/collector/status', '/api/beta/ingest', '/api/admin/state', '/api/admin/control/pause', '/login']) {
  test('a rejected DO promise becomes safe JSON503: ' + path, async t => {
    const h = await harness(t), cookie = await sessionCookie(h.env); h.env.POOL = { idFromName: () => 'primary', get: () => ({ fetch: async () => { throw new Error('unit-test-only-private-error'); } }) };
    let res;
    if (path === '/login') res = await worker.fetch(new Request(ORIGIN + '/login', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ['pass' + 'word']: h.env.ADMIN_PASSWORD }) }), h.env);
    else { const get = path.endsWith('status') || path.endsWith('state'); res = await publicCall(h, path, { method: get ? 'GET' : 'POST', body: get ? undefined : {}, token: path.includes('/beta/') ? h.env.BETA_CONTROL_TOKEN : h.env.COLLECTOR_TOKEN, cookie, origin: ORIGIN, action: '1' }); }
    assert.equal(res.status, 503); const body = await res.json(); assert.equal(body.error, 'controller_unavailable'); assert.doesNotMatch(JSON.stringify(body), /private-error/);
  });
}
test('immutable paused response preserves 503, body and adds Retry-After without mutation', async t => {
  const h = await harness(t), payload = { ok: false, paused: true, error: 'all_accounts_unavailable', retryAfter: 60 }, immutable = Response.error();
  Object.defineProperty(immutable, 'status', { value: 503 }); Object.defineProperty(immutable, 'body', { value: new Response(JSON.stringify(payload)).body });
  h.env.POOL = { idFromName: () => 'primary', get: () => ({ fetch: async () => immutable }) };
  const res = await publicCall(h, '/api/ingest', { method: 'POST', body: message(), token: h.env.COLLECTOR_TOKEN });
  assert.equal(res.status, 503); assert.equal(res.headers.get('Retry-After'), '60'); assert.deepEqual(await res.json(), payload);
});
test('config cannot increase threshold or include duplicate/unknown account aliases', async t => {
  const h = await harness(t);
  const valid = [{ alias: 'CF77', enabled: true }, { alias: '7Star', enabled: true }];
  for (const body of [{ mode: 'balanced', threshold: 0.9, accounts: valid }, { mode: 'balanced', threshold: 0.8, accounts: [valid[0], valid[0]] },
    { mode: 'balanced', threshold: 0.8, accounts: [{ alias: 'unknown', enabled: true }, valid[1]] }]) assert.equal((await internal(h, '/control/config', body)).status, 400);
  assert.equal(h.pool.config.threshold, 0.8);
});
test('source request budget blocks concurrent approvals and persists uncertain cost', async t => {
  const h = await harness(t); h.hooks.classify = c => candidate(c);
  const ids = [];
  for (const message_id of [70, 71]) ids.push((await (await ingest(h, message({ message_id }))).json()).event_id);
  h.setUsage(0, { rowsWritten: 79850 });
  const began = defer(), finish = defer();
  h.hooks.source = async c => { if (c.path === '/api/pool/action') { began.resolve(); await finish.promise; return json({ ok: false }, 503); } };
  const first = callback(h, ids[0]); await began.promise;
  await callback(h, ids[1]);
  assert.equal(h.calls.filter(c => c.path === '/api/pool/action').length, 1);
  assert.equal(h.pool.event(ids[1]).status, 'sync_pending');
  assert.ok(h.pool.accounts[0].localWrites >= 100);
  finish.resolve(); await first;
  assert.equal(h.pool.event(ids[0]).status, 'sync_pending');
  assert.ok(h.pool.get('account:CF77', {}).localWrites >= 100, 'failed response must not erase source cost');
});
test('manual bootstrap cannot bypass unknown or cutoff source usage repeatedly', async t => {
  const h = await harness(t, { bootstrap: false });
  h.setUsage(0, { rowsWritten: 80000 }); h.setUsage(1, {});
  await h.pool.sync(true); await h.pool.sync(false); await h.pool.sync(true);
  assert.equal(h.calls.filter(c => c.path === '/api/pool/dictionary').length, 0);
  assert.equal(h.pool.status().observe_allowed, false);
  h.setUsage(0, { rowsRead: null, error: 'usage_unknown' }); await h.pool.sync(true);
  assert.equal(h.calls.filter(c => c.path === '/api/pool/dictionary').length, 0);
});
for (const bootstrap of [true, false]) test('full snapshot budget prevents stale-size underreservation: bootstrap=' + bootstrap, async t => {
  const h = await harness(t, { bootstrap: !bootstrap });
  h.setUsage(0, { rowsRead: 3_998_900 }); h.setUsage(1, {});
  h.hooks.source = c => c.path === '/api/pool/dictionary' ? json({ ok: true, data: { ...dictionaryData(), whitelist: Array.from({ length: 1500 }, (_, i) => String(i + 100000)) }, observe_groups: [GROUP] }) : null;
  await h.pool.sync(true);
  assert.equal(h.calls.filter(c => c.path === '/api/pool/dictionary').length, 0);
  assert.ok(h.pool.get('sync_error', null), 'budget rejection remains visible');
});
test('redirects are rejected without following or treating usage as measured zero', async t => {
  const h = await harness(t); h.hooks.analytics = () => new Response(null, { status: 302, headers: { Location: 'https://untrusted.invalid/' } });
  await h.pool.refresh(true);
  assert.ok(h.pool.accounts.every(a => a.error === 'usage_unknown'));
  assert.equal(h.pool.status().observe_allowed, false);
  assert.equal(h.calls.filter(c => c.origin === 'https://untrusted.invalid').length, 0);
});
test('legacy callbacks migrate the original ID into central idempotent approval', async t => {
  const h = await harness(t);
  h.hooks.source = c => c.path === '/api/pool/legacy-report' ? json({ ok: true, report: { user_id: '555555', body_text: '旧广告正文样本', status: 'open' } }) : null;
  const body = { callback: { id: 'legacy-test', data: 'o:save:55', from: { id: OWNER }, message: { message_id: 88, chat: { id: OWNER, type: 'private' } } } };
  assert.equal((await internal(h, '/legacy-review', body)).status, 200);
  const row = h.db.prepare("SELECT * FROM events WHERE event_key='legacy:55'").get();
  assert.equal(row.status, 'approved'); assert.equal(JSON.parse(row.message).user_id, '555555');
  await internal(h, '/legacy-review', body);
  assert.equal(h.calls.filter(c => c.path === '/api/pool/action').length, 1);
  assert.equal(h.calls.filter(c => c.path === '/api/pool/legacy-report').length, 1);
});
test('legacy unknown-source approval never reads original D1 report or penalizes', async t => {
  const h = await harness(t); h.setUsage(0, { rowsRead: null, error: 'usage_unknown' });
  const body = { callback: { id: 'legacy-test', data: 'o:save:56', from: { id: OWNER }, message: { message_id: 89, chat: { id: OWNER, type: 'private' } } } };
  const response = await internal(h, '/legacy-review', body); assert.equal(response.status, 200); assert.equal((await response.json()).paused, true);
  assert.equal(h.calls.filter(c => c.origin === BETA).length, 0);
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM events').get().n, 0);
});
test('legacy dismissal requires no source reads and cannot later become approval', async t => {
  const h = await harness(t); h.setUsage(0, { rowsWritten: 80000 });
  const body = { callback: { id: 'legacy-test', data: 'o:dismiss:57', from: { id: OWNER }, message: { message_id: 90, chat: { id: OWNER, type: 'private' } } } };
  assert.equal((await internal(h, '/legacy-review', body)).status, 200);
  const row = h.db.prepare("SELECT * FROM events WHERE event_key='legacy:57'").get(); assert.equal(row.status, 'dismissed');
  body.callback.data = 'o:save:57'; await internal(h, '/legacy-review', body);
  assert.equal(h.calls.filter(c => c.origin === BETA).length, 0);
});
test('account configuration refuses unsafe targets and missing authentication', () => {
  for (const url of ['http://node.unit.workers.dev/', 'https://outside.invalid/', 'https://user:unit@node.unit.workers.dev/', NODES[0] + '/admin']) {
    const env = environment(), entries = JSON.parse(env.POOL_ACCOUNTS); entries[0].url = url; env.POOL_ACCOUNTS = JSON.stringify(entries); assert.throws(() => accountConfig(env));
  }
  assert.throws(() => accountConfig({ POOL_ACCOUNTS: '[]' })); assert.throws(() => accountConfig({ ...environment(), FIRST_NODE_TOKEN: '' }));
});
