// Offline Beta text-classifier fallback regressions. No real credentials or network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const source = fs.readFileSync(new URL('./_worker.js', import.meta.url), 'utf8');
function harness({ fetchImpl, cfImpl, state = new Map(), now = '2026-11-14T12:00:00Z', dbFails = false } = {}) {
  const calls = [], cfCalls = [], timers = [], logs = [];
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return new Date(now).getTime(); } }
  const sandbox = {
    Request, Response, Headers, URL, TextEncoder, TextDecoder, AbortController, Date: Clock,
    console: { log(...a) { logs.push(a); }, warn(...a) { logs.push(a); }, error(...a) { logs.push(a); } },
    setTimeout(callback, delay) { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimeout(timer) { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1); },
    async fetch(url, options) { calls.push({ url, options }); return fetchImpl ? fetchImpl(url, options) : Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'ad' } }] }); },
  };
  vm.createContext(sandbox);
  const code = source.replace('export default', 'const worker_default =').replace('export {', 'globalThis.worker = { default: worker_default,');
  vm.runInContext(code + '\nglobalThis.backup = judgeAdWithBackup; globalThis.backupConfig = getBackupClassifierConfig; globalThis.refreshQuota = refreshClassifierQuotaState;', sandbox);
  const env = {
    AI_API_TOKEN: 'TEST-SECRET-NOT-REAL', AI_API_BASE_URL: 'https://backup.invalid/v1',
    AI: { async run(model, options) { cfCalls.push({ model, options }); return cfImpl ? cfImpl(model, options) : { response: 'ok' }; } },
    DB: { prepare(sql) { if (dbFails) throw new Error('database unavailable'); let args = []; return {
      bind(...values) { args = values; return this; },
      async run() {
        if (/INSERT.*ai_classifier_state/is.test(sql)) {
          const prior = state.get(args[0]);
          if (prior && prior.utc_day > args[1]) return { success: true };
          const sameDay = prior?.utc_day === args[1];
          const value = sameDay ? JSON.parse(prior.value) : JSON.parse(args[2]);
          const exhaustion = sql.includes("'$.exhausted'");
          if (sameDay && exhaustion) value.exhausted = true;
          if (sameDay && !exhaustion) value.neurons = Math.max(value.neurons ?? 0, JSON.parse(args[2]).neurons);
          const updated_at = exhaustion ? (sameDay ? prior.updated_at : 0) : Math.max(sameDay ? prior.updated_at : 0, args[3]);
          state.set(args[0], { key: args[0], utc_day: args[1], value: JSON.stringify(value), updated_at });
        }
        return { success: true };
      },
      async first() { return state.get(args[0]) || null; },
    }; } },
  };
  return { env, worker: sandbox.worker, backup: sandbox.backup, config: sandbox.backupConfig, refreshQuota: sandbox.refreshQuota, calls, cfCalls, timers, logs, state, setNow(value) { now = value; } };
}

test('gateway URL and key come only from runtime config and redirects are forbidden', async () => {
  const h = harness();
  const result = await h.backup(h.env, '测试广告');
  assert.equal(result.isAd, true);
  assert.equal(h.calls[0].url, 'https://backup.invalid/v1/chat/completions');
  assert.equal(h.calls[0].options.headers.Authorization, 'Bearer TEST-SECRET-NOT-REAL');
  assert.equal(h.calls[0].options.redirect, 'manual');
  assert.ok(h.calls[0].options.signal instanceof AbortSignal);
  const body = JSON.parse(h.calls[0].options.body);
  assert.equal(body.model, 'DeepSeek-V4.1-Flash');
  assert.ok(body.max_tokens >= 512);
  assert.equal(body.temperature, 0);
  assert.equal(body.stream, false);
  assert.ok(body.messages[0].content.includes('指令'));
  assert.ok(body.messages[1].content.includes('测试广告'));
  assert.equal(h.timers.length, 0);
});

for (const url of ['http://backup.invalid/v1', 'ftp://backup.invalid/v1', 'https://user:pass@backup.invalid/v1', 'https://backup.invalid/v1?token=anything', 'https://backup.invalid/v1#fragment', 'not a url']) {
  test(`unsafe/malformed backup base is rejected: ${url}`, async () => {
    const h = harness(); h.env.AI_API_BASE_URL = url;
    assert.equal((await h.backup(h.env, '测试')).error, 'backup_ai_unavailable');
    assert.equal(h.calls.length, 0);
  });
}
test('HTTP requires explicit opt-in and does not put token into URL', async () => {
  const h = harness(); h.env.AI_API_BASE_URL = 'http://backup.invalid/v1/'; h.env.AI_ALLOW_INSECURE_HTTP = '1';
  assert.equal((await h.backup(h.env, '测试')).isAd, true);
  assert.equal(h.calls[0].url, 'http://backup.invalid/v1/chat/completions');
  assert.ok(!h.calls[0].url.includes(h.env.AI_API_TOKEN));
});
for (const output of [
  { choices: [{ finish_reason: 'length', message: { content: 'ad' } }] },
  { choices: [{ finish_reason: 'content_filter', message: { content: 'ad' } }] },
  { choices: [{ message: { content: 'ad' } }] },
  { choices: [{ finish_reason: 'stop', message: { content: 'ad or ok' } }] },
  { choices: [{ finish_reason: 'stop', message: { reasoning_content: 'ad' } }] },
  { choices: [] },
]) {
  test(`unfinished/malformed gateway output cannot produce a punishment: ${JSON.stringify(output)}`, async () => {
    const h = harness({ fetchImpl: async () => Response.json(output) });
    const result = await h.backup(h.env, '测试');
    assert.equal(result.isAd, false); assert.ok(result.error);
  });
}
for (const status of [301, 401, 429, 500]) {
  test(`gateway HTTP ${status} safely fails without logging response`, async () => {
    const h = harness({ fetchImpl: async () => new Response('PRIVATE-RESPONSE', { status }) });
    const result = await h.backup(h.env, 'PRIVATE-TEXT');
    assert.equal(result.isAd, false); assert.equal(result.error, 'backup_ai_request_failed');
    assert.equal(h.logs.length, 0); assert.equal(h.timers.length, 0);
  });
}
test('backup timeout aborts whole request and leaves no loose timer', async () => {
  const h = harness({ fetchImpl: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('SECRET')))) });
  const pending = h.backup(h.env, '测试');
  assert.equal(h.timers[0].delay, 12000);
  h.timers[0].callback();
  const result = await pending;
  assert.equal(result.error, 'backup_ai_request_failed'); assert.equal(h.timers.length, 0); assert.equal(h.logs.length, 0);
});
test('configured public backup model name override is honored', async () => {
  const h = harness(); h.env.AI_FALLBACK_MODEL = 'test-model-name';
  await h.backup(h.env, '测试');
  assert.equal(JSON.parse(h.calls[0].options.body).model, 'test-model-name');
});
test('oversized and non-JSON outputs cannot produce a verdict', async () => {
  for (const body of ['x'.repeat(65537), '<html>not JSON</html>']) {
    const h = harness({ fetchImpl: async () => new Response(body) });
    const result = await h.backup(h.env, '测试');
    assert.equal(result.isAd, false); assert.ok(result.error); assert.equal(h.logs.length, 0);
  }
});
function quotaState(value, day = '2026-11-14') {
  return new Map([['cloudflare_daily', { utc_day: day, value: JSON.stringify(value), updated_at: Date.parse(day + 'T12:00:00Z') / 1000 }]]);
}
for (const state of [quotaState({ neurons: 9000 }), quotaState({ neurons: 10000 }), quotaState({ exhausted: true })]) {
  test(`account monitor near-limit/exhaustion snapshot switches across isolates: ${[...state.values()][0].value}`, async () => {
    for (let i = 0; i < 2; i++) {
      const h = harness({ state });
      assert.equal((await h.worker.judgeAdWithAI(h.env, '测试')).isAd, true);
      assert.equal(h.cfCalls.length, 0); assert.equal(h.calls.length, 1);
    }
  });
}
for (const [name, state] of [
  ['low account usage', quotaState({ neurons: 8999 })],
  ['yesterday exhausted', quotaState({ exhausted: true }, '2026-11-13')],
  ['invalid neuron count', quotaState({ neurons: '10000' })],
  ['invalid JSON', new Map([['cloudflare_daily', { utc_day: '2026-11-14', value: '{broken', updated_at: 1 }]])],
]) {
  test(`Cloudflare remains preferred: ${name}`, async () => {
    const h = harness({ state });
    assert.equal((await h.worker.judgeAdWithAI(h.env, '测试')).isAd, false);
    assert.equal(h.cfCalls.length, 1); assert.equal(h.calls.length, 0);
  });
}
for (const error of [Object.assign(new Error('quota failure'), { code: 3036 }), new Error('AiError: 3036: quota exceeded')]) {
  test(`explicit 3036 persists UTC quota marker but never provider details: ${error.code || 'message'}`, async () => {
    const state = quotaState({ neurons: 8000 });
    const first = harness({ state, cfImpl: async () => { throw error; } });
    assert.equal((await first.worker.judgeAdWithAI(first.env, '测试')).isAd, true);
    const persisted = JSON.parse(state.get('cloudflare_daily').value);
    assert.equal(persisted.exhausted, true); assert.equal(persisted.neurons, 8000);
    const second = harness({ state });
    assert.equal((await second.worker.judgeAdWithAI(second.env, '测试')).isAd, true);
    assert.equal(second.cfCalls.length, 0);
    const tomorrow = harness({ state, now: '2026-11-15T00:00:01Z' });
    assert.equal((await tomorrow.worker.judgeAdWithAI(tomorrow.env, '测试')).isAd, false);
    assert.equal(tomorrow.cfCalls.length, 1);
    assert.equal(first.logs.length, 0);
  });
}
for (const error of [Object.assign(new Error('busy'), { code: 429 }), Object.assign(new Error('unavailable'), { code: 503 }), new Error('transport')]) {
  test(`temporary CF failure switches once without persisting daily exhaustion: ${error.code || 'network'}`, async () => {
    const state = new Map();
    const h = harness({ state, cfImpl: async () => { throw error; } });
    assert.equal((await h.worker.judgeAdWithAI(h.env, '测试')).isAd, true);
    assert.equal(state.size, 0);
    const retry = harness({ state });
    await retry.worker.judgeAdWithAI(retry.env, '测试');
    assert.equal(retry.cfCalls.length, 1);
  });
}
test('D1 quota storage failure does not prevent current-request failover', async () => {
  const h = harness({ dbFails: true, cfImpl: async () => { throw Object.assign(new Error('quota'), { code: 3036 }); } });
  assert.equal((await h.worker.judgeAdWithAI(h.env, '测试')).isAd, true);
  assert.equal(h.calls.length, 1);
});
test('malformed CF output falls back but still requires a valid backup label', async () => {
  const h = harness({ cfImpl: async () => ({ response: 'unknown' }), fetchImpl: async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'unknown' } }] }) });
  const verdict = await h.worker.judgeAdWithAI(h.env, '测试');
  assert.equal(verdict.isAd, false); assert.ok(verdict.error); assert.equal(h.state.size, 0);
});
test('no AI binding can use configured backup; no backup preserves no_ai', async () => {
  const h = harness(); delete h.env.AI;
  assert.equal((await h.worker.judgeAdWithAI(h.env, '测试')).isAd, true);
  delete h.env.AI_API_TOKEN;
  assert.equal((await h.worker.judgeAdWithAI(h.env, '测试')).error, 'no_ai');
});
test('existing judge mock remains isolated from backup routing', async () => {
  const h = harness({ state: quotaState({ exhausted: true }) });
  h.env.__aiJudgeMock = async () => ({ isAd: false });
  assert.equal((await h.worker.judgeAdWithAI(h.env, '测试')).isAd, false);
  assert.equal(h.calls.length, 0); assert.equal(h.cfCalls.length, 0);
});
test('embedding failures never call the text backup model', async () => {
  const h = harness({ state: quotaState({ exhausted: true }), cfImpl: async () => { throw Object.assign(new Error('quota'), { code: 3036 }); } });
  await assert.rejects(h.worker.embedText(h.env, '测试'));
  assert.equal(h.cfCalls[0].model, '@cf/baai/bge-m3');
  assert.equal(h.calls.length, 0);
});
const ANALYTICS_URL = 'https://api.cloudflare.com/client/v4/graphql';
const monitorResponse = neurons => ({ data: { viewer: { accounts: [{ aiInferenceAdaptiveGroups: [{ count: 2, sum: { totalNeurons: neurons } }] }] } } });
function enableMonitor(h) {
  h.env.CF_AI_MONITOR_ENABLED = '1';
  h.env.CF_AI_ANALYTICS_TOKEN = 'TEST-ANALYTICS-SECRET';
  h.env.CF_ACCOUNT_ID = 'a'.repeat(32);
  return h;
}
function monitorHarness(options = {}) {
  return enableMonitor(harness({ ...options, fetchImpl: options.fetchImpl || (async url => url === ANALYTICS_URL ? Response.json(monitorResponse(8000)) : Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'ad' } }] })) }));
}
test('monitor reads account-wide UTC aggregate then caches it for fresh isolates', async () => {
  const state = new Map();
  const first = monitorHarness({ state });
  assert.equal((await first.worker.judgeAdWithAI(first.env, '测试')).isAd, false);
  assert.equal(first.cfCalls.length, 1); assert.equal(first.calls.length, 1);
  const call = first.calls[0];
  assert.equal(call.url, ANALYTICS_URL); assert.equal(call.options.method, 'POST');
  assert.equal(call.options.redirect, 'manual');
  assert.equal(call.options.headers.Authorization, 'Bearer TEST-ANALYTICS-SECRET');
  const body = JSON.parse(call.options.body);
  assert.equal(body.variables.accountTag, 'a'.repeat(32));
  assert.equal(body.variables.start, '2026-11-14T00:00:00.000Z');
  assert.equal(body.variables.end, '2026-11-14T12:00:00.000Z');
  assert.ok(body.query.includes('sum{totalNeurons}'));
  assert.ok(!body.query.includes('model'));
  const second = monitorHarness({ state });
  await second.worker.judgeAdWithAI(second.env, '测试');
  assert.equal(second.calls.length, 0); assert.equal(second.cfCalls.length, 1);
  assert.equal(first.timers.length, 0);
});
test('stale low snapshot refreshes before CF and switches at 9000 neurons', async () => {
  const h = monitorHarness({ state: quotaState({ neurons: 100 }), now: '2026-11-14T12:02:00Z', fetchImpl: async url => url === ANALYTICS_URL ? Response.json(monitorResponse(9000)) : Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] }) });
  assert.equal((await h.worker.judgeAdWithAI(h.env, '测试')).isAd, false);
  assert.equal(h.cfCalls.length, 0); assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].options.headers.Authorization, 'Bearer TEST-SECRET-NOT-REAL');
  assert.ok(!h.calls[1].options.body.includes('TEST-ANALYTICS-SECRET'));
});
test('same-day high usage or exhaustion is sticky and skips analytics', async () => {
  for (const state of [quotaState({ neurons: 9000 }), quotaState({ neurons: 400, exhausted: true })]) {
    const h = monitorHarness({ state, now: '2026-11-14T23:59:00Z' });
    await h.worker.judgeAdWithAI(h.env, '测试');
    assert.equal(h.calls.length, 1); assert.notEqual(h.calls[0].url, ANALYTICS_URL); assert.equal(h.cfCalls.length, 0);
  }
});
test('valid empty aggregate represents zero but missing dataset never does', async () => {
  const empty = { data: { viewer: { accounts: [{ aiInferenceAdaptiveGroups: [] }] } } };
  const h = monitorHarness({ fetchImpl: async () => Response.json(empty) });
  assert.equal((await h.worker.judgeAdWithAI(h.env, '测试')).isAd, false);
  assert.equal(h.cfCalls.length, 1); assert.equal(JSON.parse(h.state.get('cloudflare_daily').value).neurons, 0);
});
for (const response of [
  { errors: [{ message: 'SECRET' }], ...monitorResponse(0) },
  {}, { data: { viewer: { accounts: [] } } },
  { data: { viewer: { accounts: [{}, {}] } } },
  { data: { viewer: { accounts: [{}] } } },
  { data: { viewer: { accounts: [{ aiInferenceAdaptiveGroups: [{ sum: {} }] }] } } },
  monitorResponse('0'), monitorResponse(-1), monitorResponse(null),
]) {
  test(`unknown analytics response uses backup, never assumes free budget: ${JSON.stringify(response)}`, async () => {
    const h = monitorHarness({ fetchImpl: async url => url === ANALYTICS_URL ? Response.json(response) : Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'ad' } }] }) });
    assert.equal((await h.worker.judgeAdWithAI(h.env, '测试')).isAd, true);
    assert.equal(h.cfCalls.length, 0); assert.equal(h.state.size, 0); assert.equal(h.logs.length, 0);
  });
}
test('enabled monitor without credentials uses backup rather than CF', async () => {
  const h = monitorHarness(); delete h.env.CF_AI_ANALYTICS_TOKEN;
  assert.equal((await h.worker.judgeAdWithAI(h.env, '测试')).isAd, true);
  assert.equal(h.cfCalls.length, 0); assert.equal(h.calls.length, 1);
});
test('enabled unknown monitor without backup yields error, never punishment', async () => {
  const h = monitorHarness(); delete h.env.CF_AI_ANALYTICS_TOKEN; delete h.env.AI_API_TOKEN;
  const verdict = await h.worker.judgeAdWithAI(h.env, '测试');
  assert.equal(verdict.isAd, false); assert.equal(verdict.error, 'quota_usage_unavailable');
  assert.equal(h.cfCalls.length, 0); assert.equal(h.calls.length, 0);
});
test('analytics timeout uses five-second abort, clears task, falls back safely', async () => {
  const h = monitorHarness({ fetchImpl: (url, options) => url === ANALYTICS_URL ? new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('SECRET')))) : Promise.resolve(Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] })) });
  const pending = h.worker.judgeAdWithAI(h.env, '测试');
  for (let i = 0; i < 10 && !h.timers.length; i++) await Promise.resolve();
  assert.equal(h.timers[0].delay, 5000); h.timers[0].callback();
  const verdict = await pending;
  assert.equal(verdict.isAd, false); assert.equal(verdict.error, undefined);
  assert.equal(h.cfCalls.length, 0); assert.equal(h.timers.length, 0); assert.equal(h.logs.length, 0);
});
test('late analytics low response cannot overwrite concurrent 3036 exhaustion', async () => {
  const state = quotaState({ neurons: 900, exhausted: false });
  const h = monitorHarness({ state, fetchImpl: async () => {
    state.set('cloudflare_daily', { utc_day: '2026-11-14', value: JSON.stringify({ neurons: 9500, exhausted: true }), updated_at: 0 });
    return Response.json(monitorResponse(1000));
  } });
  const merged = await h.refreshQuota(h.env);
  assert.equal(merged.exhausted, true); assert.equal(merged.neurons, 9500);
});
test('prior-day snapshot resets upon successful next-day analytics', async () => {
  const h = monitorHarness({ state: quotaState({ exhausted: true, neurons: 10000 }, '2026-11-13') });
  await h.worker.judgeAdWithAI(h.env, '测试');
  assert.equal(h.cfCalls.length, 1);
  const value = JSON.parse(h.state.get('cloudflare_daily').value);
  assert.equal(value.exhausted, false); assert.equal(value.neurons, 8000);
});
test('analytics request crossing UTC midnight cannot cache the old day as current', async () => {
  let h;
  h = monitorHarness({ now: '2026-11-14T23:59:59Z', fetchImpl: async url => {
    if (url === ANALYTICS_URL) {
      h.setNow('2026-11-15T00:00:01Z');
      return Response.json(monitorResponse(200));
    }
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] });
  } });
  const verdict = await h.worker.judgeAdWithAI(h.env, '测试');
  assert.equal(verdict.isAd, false); assert.equal(h.cfCalls.length, 0); assert.equal(h.state.size, 0);
});
test('3036 marker does not make a stale low snapshot appear recently measured', async () => {
  const state = quotaState({ neurons: 8000 });
  const before = state.get('cloudflare_daily').updated_at;
  const h = harness({ state, now: '2026-11-14T13:00:00Z', cfImpl: async () => { throw Object.assign(new Error('quota'), { code: 3036 }); } });
  await h.worker.judgeAdWithAI(h.env, '测试');
  assert.equal(state.get('cloudflare_daily').updated_at, before);
});
test('actual SQLite atomic snapshots preserve max usage, exhaustion and UTC reset', async () => {
  const db = new DatabaseSync(':memory:');
  const h = monitorHarness({ fetchImpl: async () => Response.json(monitorResponse(1000)) });
  h.env.DB = { prepare(sql) { let args = []; return {
    bind(...values) { args = values; return this; },
    async run() { const info = db.prepare(sql).run(...args); return { meta: { changes: Number(info.changes) } }; },
    async first() { return db.prepare(sql).get(...args) ?? null; },
  }; } };
  await h.refreshQuota(h.env);
  db.prepare('UPDATE ai_classifier_state SET value = ?, updated_at = ?').run(JSON.stringify({ neurons: 9500, exhausted: true }), 1);
  const merged = await h.refreshQuota(h.env);
  assert.equal(merged.neurons, 9500); assert.equal(merged.exhausted, true);
  h.setNow('2026-11-15T00:00:01Z');
  const nextDay = await h.refreshQuota(h.env);
  assert.equal(nextDay.neurons, 1000); assert.equal(nextDay.exhausted, false);
  const before = nextDay.updatedAt;
  h.env.CF_AI_MONITOR_ENABLED = '0';
  h.env.AI.run = async () => { throw Object.assign(new Error('quota'), { code: 3036 }); };
  // Keep backup network deterministic while checking the actual marker UPSERT.
  h.env.AI_API_BASE_URL = '';
  await h.worker.judgeAdWithAI(h.env, '测试');
  const persisted = db.prepare('SELECT * FROM ai_classifier_state').get();
  assert.equal(JSON.parse(persisted.value).exhausted, true);
  assert.equal(JSON.parse(persisted.value).neurons, 1000);
  assert.equal(persisted.updated_at, before);
  db.close();
});
test('Cloudflare remains preferred when quota state is absent', async () => {
  const h = harness();
  assert.equal((await h.worker.judgeAdWithAI(h.env, '测试')).isAd, false);
  assert.equal(h.cfCalls.length, 1); assert.equal(h.calls.length, 0);
});
