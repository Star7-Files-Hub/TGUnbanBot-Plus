// Read-only node regression suite. SQLite and fake AI; no network or real secrets.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createHash, webcrypto } from 'node:crypto';
import worker, { clearSnapshotCache, SNAPSHOT_TTL_MS, EMBEDDING_MODEL, CLASSIFIER_MODEL } from './node-worker.js';
import {
  constantEqual, normalized, parseSingleLabel, readJson, validateDictionaryInput,
  validateMessageInput, validVector, MAX_DICTIONARY_BYTES, ProtocolError,
} from './protocol.mjs';
globalThis.crypto ||= webcrypto;
const VERSION = 'a'.repeat(64), NEXT_VERSION = 'b'.repeat(64), TOKEN = 'unit-test-only-node-token';
const digest = value => createHash('sha256').update(normalized(value)).digest('hex');
const text = '高价收购实名号四件套长期招代理';
const message = (changes = {}) => ({ chat_id: '-1000123456', user_id: '555555', message_id: 11,
  text, quote: '', contact_name: '', first_name: '普通会员', last_name: '', username: 'ordinary_user', is_bot: false, ...changes });
const data = (changes = {}) => ({ fingerprints: [], samples: [], whitelist: [], owners: [], allowlist: [], ...changes });
const fp = (value, changes = {}) => ({ id: 1, type: 'keyword', value, norm_value: normalized(value),
  status: 'confirmed', source: 'manual', ...changes });
const sample = (value, changes = {}) => ({ id: 1, norm_hash: digest(value), sample_text: value,
  kind: 'text', embedding: null, count: 2, ...changes });
function harness() {
  const sqlite = new DatabaseSync(':memory:');
  const sql = [], ai = [], writes = [];
  const db = { prepare(query) {
    sql.push(query); let args = [];
    return {
      bind(...values) { args = values; return this; },
      async run() {
        const result = sqlite.prepare(query).run(...args);
        const changes = Number(result.changes);
        writes.push({ query, changes });
        return { success: true, meta: { changes, last_row_id: Number(result.lastInsertRowid),
          rows_read: 0, rows_written: /INSERT|UPDATE|DELETE/.test(query) ? changes : 0 } };
      },
      async all() {
        const results = sqlite.prepare(query).all(...args);
        return { success: true, results, meta: { rows_read: results.length, rows_written: 0 } };
      },
    };
  } };
  const env = { DB: db, NODE_TOKEN: TOKEN,
    AI: { async run(model, input) { ai.push({ model, input }); return model === EMBEDDING_MODEL
      ? { data: [[1, 0, 0]], usage: { neurons: 0.5 } } : { response: 'ok', usage: { neurons: 1.5 } }; } } };
  return { env, sqlite, sql, ai, writes };
}
async function call(h, path, body, options = {}) {
  const method = options.method || (path === '/dictionary' ? 'PUT' : path === '/classify' ? 'POST' : 'GET');
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN, ...options.headers };
  const req = new Request('https://node.invalid' + path, { method, headers,
    body: ['GET', 'HEAD'].includes(method) ? undefined : (options.raw ?? JSON.stringify(body)) });
  const response = await worker.fetch(req, h.env);
  const result = response.headers.get('Content-Type')?.includes('json') ? await response.json() : await response.text();
  return { status: response.status, body: result, response };
}
async function dictionary(h, value = data(), version = VERSION) {
  const result = await call(h, '/dictionary', { version, data: value });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result;
}
async function classify(h, value = message(), version = VERSION) {
  return call(h, '/classify', { version, message: value });
}

for (const [value, expected] of [
  ['群---发--推----广，让你的广--告24小时曝光！ @USER123', '群发推广让你的广告24小时曝光 @user123'],
  ['🔥 高价收购 · 实名号，四件套', '高价收购实名号四件套'],
  ['ＡＢＣ＿１２３', 'abc123'],
]) test('normalization is compatible: ' + value, () => assert.equal(normalized(value), expected));
test('constantEqual and shared input protocol reject invalid values', () => {
  assert.equal(constantEqual('same', 'same'), true);
  assert.equal(constantEqual('x', 'long'), false);
  assert.equal(constantEqual(null, ''), false);
  assert.deepEqual(validateMessageInput({ version: VERSION, message: message() }), { ok: true, version: VERSION, message: message() });
  assert.equal(validateMessageInput(message()).ok, true);
  for (const input of [message({ user_id: '' }), message({ chat_id: '100' }), message({ message_id: -1 }),
    message({ text: 'a'.repeat(4001) }), message({ user_id: 555 }), message({ username: 'x'.repeat(65) }),
    message({ is_bot: 'yes' }), message({ secret: 'should-not-forward' }), { version: 'bad', message: message() }]) {
    assert.equal(validateMessageInput(input).ok, false);
  }
});
for (const [output, expected] of [
  ['ad', 'ad'], [' OK \n', 'ok'], [{ response: 'ad' }, 'ad'], [{ response: '"ok"' }, 'ok'],
  [{ result: { response: '{"verdict":"ad"}' } }, 'ad'], [{ response: '```text\nok\n```' }, 'ok'],
  [{ choices: [{ finish_reason: 'stop', message: { content: 'ad' } }] }, 'ad'],
  [{ response: 'ad', finish_reason: 'length' }, null],
  [{ choices: [{ finish_reason: 'length', message: { content: 'ad' } }] }, null],
  [{ choices: [{ finish_reason: 'stop', message: { content: 'ad', refusal: 'not-allowed' } }] }, null],
  [{ response: 'ad or ok' }, null], [{ response: '{"verdict":"ad","extra":true}' }, null],
  [{ response: '' }, null], [{ reasoning_content: 'ad' }, null], [null, null],
]) test('strict single label parse: ' + JSON.stringify(output), () => assert.equal(parseSingleLabel(output), expected));
test('bounded JSON streams reject oversize and malformed bytes without echoing payload', async () => {
  await assert.rejects(readJson(new Request('https://node.invalid', { method: 'POST', body: 'PRIVATE'.repeat(20) }), 8),
    error => error instanceof ProtocolError && error.status === 413 && !error.message.includes('PRIVATE'));
  await assert.rejects(readJson(new Request('https://node.invalid', { method: 'POST', body: '{"private":' }), 100),
    error => error.status === 400 && error.error === 'invalid_json');
  assert.deepEqual(await readJson(new Request('https://node.invalid', { method: 'POST', body: '{"x":1}' }), 16), { x: 1 });
});
test('dictionary guards sizes, vectors, counts, type normalization and duplicates', () => {
  assert.equal(validateDictionaryInput({ version: VERSION, data: data() }).ok, true);
  const invalid = [
    data({ samples: Array.from({ length: 5001 }, (_, i) => sample(text, { id: i + 1 })) }),
    data({ fingerprints: Array.from({ length: 5001 }, (_, i) => fp(text, { id: i + 1 })) }),
    data({ samples: [sample(text, { embedding: [[1, 0]] })] }),
    data({ samples: [sample(text, { embedding: [0, 0] })] }),
    data({ samples: [sample(text, { embedding: [NaN, 1] })] }),
    data({ samples: [sample(text, { embedding: Array(4097).fill(1) })] }),
    data({ samples: [sample(text, { count: -1 })] }),
    data({ samples: [sample(text), sample(text)] }),
    data({ fingerprints: [fp(text, { norm_value: 'different' })] }),
    data({ whitelist: ['-1000'] }), data({ owners: [123] }),
    data({ allowlist: [{ dimension: 'unknown', value: 'x' }] }),
  ];
  for (const value of invalid) assert.equal(validateDictionaryInput({ version: VERSION, data: value }).ok, false);
  assert.equal(validVector([1, 2, 3]), true);
  assert.equal(validVector([1, Infinity]), false);
});
test('auth failure, health and method/routing checks perform no DB queries', async () => {
  const h = harness();
  assert.equal((await call(h, '/health', null, { headers: { Authorization: '' } })).body, 'OK');
  assert.equal((await call(h, '/health', null, { method: 'POST' })).status, 405);
  assert.equal((await call(h, '/unknown')).status, 404);
  assert.equal((await call(h, '/dictionary', {}, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await call(h, '/classify', {}, { method: 'PUT' })).status, 405);
  delete h.env.NODE_TOKEN;
  assert.equal((await call(h, '/classify', {})).status, 503);
  assert.equal(h.sql.length, 0);
});
test('invalid auth payload cannot create snapshot or call AI', async () => {
  const h = harness();
  assert.equal((await call(h, '/dictionary', { version: 'bad', data: data() })).status, 400);
  assert.equal((await call(h, '/classify', { version: VERSION, message: message({ message_id: 0 }) })).status, 400);
  assert.equal(h.sql.length, 0); assert.equal(h.ai.length, 0);
});
test('dictionary update writes one snapshot row, immediately refreshes cache and exposes metrics', async () => {
  const h = harness();
  const uploaded = await dictionary(h, data({ fingerprints: [fp('群发推广')] }));
  assert.deepEqual(uploaded.body.metrics, { rowsRead: 0, rowsWritten: 1 });
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM dictionary_snapshot').get().n, 1);
  assert.deepEqual(h.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name), ['dictionary_snapshot']);
  h.sql.length = 0; h.writes.length = 0;
  const first = await classify(h, message({ text: '群---发--推----广 24小时不停曝光' }));
  assert.equal(first.body.kind, 'fingerprint'); assert.equal(first.body.fingerprint_id, 1);
  assert.deepEqual(first.body.metrics, { rowsRead: 0, rowsWritten: 0 });
  assert.equal(h.sql.length, 0); assert.equal(h.writes.length, 0); assert.equal(h.ai.length, 0);
  assert.equal((await classify(h, message(), NEXT_VERSION)).status, 409);
  const next = await dictionary(h, data({ fingerprints: [fp('新品接批发')] }), NEXT_VERSION);
  assert.equal(next.body.metrics.rowsWritten, 1);
  assert.equal((await classify(h, message({ text: '新品接批发' }), NEXT_VERSION)).body.kind, 'fingerprint');
  assert.equal((await classify(h)).status, 409);
});
test('cold cache does one SELECT and hot cache does none; expiry refreshes once', async () => {
  const h = harness(); await dictionary(h, data({ fingerprints: [fp('群发推广')] }));
  clearSnapshotCache(h.env.DB); h.sql.length = 0;
  const cold = await classify(h, message({ text: '群发推广' }));
  assert.deepEqual(cold.body.metrics, { rowsRead: 1, rowsWritten: 0 });
  assert.equal(h.sql.length, 1); assert.match(h.sql[0], /^SELECT/);
  assert.equal((await classify(h, message({ text: '群发推广' }))).body.metrics.rowsRead, 0);
  assert.equal(h.sql.length, 1);
  const original = Date.now;
  Date.now = () => original() + SNAPSHOT_TTL_MS + 1;
  try { assert.equal((await classify(h, message({ text: '群发推广' }))).body.metrics.rowsRead, 1); }
  finally { Date.now = original; }
  assert.equal(h.sql.length, 2);
});
test('same version cannot silently replace different contents with hot or cold cache', async () => {
  const h = harness(); await dictionary(h);
  const replacement = { version: VERSION, data: data({ fingerprints: [fp('群发推广')] }) };
  const result = await call(h, '/dictionary', replacement);
  assert.equal(result.status, 409); assert.equal(result.body.error, 'dictionary_version_conflict');
  assert.equal(result.body.metrics.rowsWritten, 0);
  clearSnapshotCache(h.env.DB);
  const cold = await call(h, '/dictionary', replacement);
  assert.equal(cold.status, 409); assert.equal(cold.body.metrics.rowsWritten, 0);
  assert.equal(JSON.parse(h.sqlite.prepare('SELECT payload FROM dictionary_snapshot').get().payload).fingerprints.length, 0);
});
test('identity fingerprints are exact typed matches and chat_title is accepted without classification', async () => {
  const h = harness(); await dictionary(h, data({ fingerprints: [fp('广告名用户', { type: 'name' }), fp('@ad_account', { id: 2, type: 'username' })] }));
  const name = await classify(h, message({ text: '', first_name: '广告名用户', chat_title: '仅用做兼容' }));
  assert.equal(name.body.kind, 'fingerprint'); assert.equal(name.body.matched_field, 'name');
  const user = await classify(h, message({ text: '', username: 'ad_account' }));
  assert.equal(user.body.kind, 'fingerprint'); assert.equal(user.body.matched_field, 'username');
  assert.notEqual((await classify(h, message({ text: '广告名用户 @ad_account', first_name: '不同名' }))).body.kind, 'fingerprint');
  assert.notEqual((await classify(h, message({ text: '', first_name: '前缀广告名用户' }))).body.kind, 'fingerprint');
});
test('keyword fields are isolated, card fingerprints apply only to contact_name and retired rows do not match', async () => {
  const h = harness(); await dictionary(h, data({ fingerprints: [fp('广告推广'), fp('名片招代理', { id: 2, type: 'card_name' }), fp('旧的广告', { id: 3, status: 'retired' })] }));
  delete h.env.AI;
  assert.equal((await classify(h, message({ text: '广告', quote: '推广' }))).body.kind, 'candidate');
  assert.equal((await classify(h, message({ text: '普通聊天', first_name: '广告推广', username: '广告推广' }))).body.kind, 'candidate');
  const quote = await classify(h, message({ text: '', quote: '附广告推广信息' }));
  assert.equal(quote.body.kind, 'fingerprint'); assert.equal(quote.body.matched_field, 'quote');
  const card = await classify(h, message({ text: '', contact_name: '名片招代理' }));
  assert.equal(card.body.kind, 'fingerprint'); assert.equal(card.body.fingerprint_id, 2); assert.equal(card.body.matched_field, 'card_name');
  assert.notEqual((await classify(h, message({ text: '名片招代理' }))).body.kind, 'fingerprint');
  assert.notEqual((await classify(h, message({ text: '旧的广告' }))).body.kind, 'fingerprint');
});
test('whitelist, owners, allowlist and command paths return normal without AI or mutation', async () => {
  const h = harness(); await dictionary(h, data({ owners: ['111'], whitelist: ['222'],
    allowlist: [{ dimension: 'text', value: '普通聊天' }], fingerprints: [fp('广告推广')] }));
  for (const input of [message({ user_id: '111' }), message({ user_id: '222' }), message({ text: '普通聊天' }), message({ text: '/spam 555555' })]) {
    const result = await classify(h, input); assert.equal(result.body.kind, 'normal');
  }
  assert.equal(h.ai.length, 0);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM dictionary_snapshot').get().n, 1);
});
test('hash semantic matches require matching kind and do not increment sample count', async () => {
  const h = harness(); await dictionary(h, data({ samples: [sample(text), sample('名片广告样本', { id: 2, kind: 'card_name' }), sample('引用广告样本', { id: 3, kind: 'quote' })] }));
  const hit = await classify(h); assert.equal(hit.body.kind, 'semantic'); assert.equal(hit.body.sample_id, 1);
  assert.equal(h.ai.length, 0); assert.equal(hit.body.metrics.rowsWritten, 0);
  assert.equal((await classify(h, message({ text: '', contact_name: '名片广告样本' }))).body.sample_id, 2);
  assert.equal((await classify(h, message({ text: '', quote: '引用广告样本' }))).body.sample_id, 3);
  assert.notEqual((await classify(h, message({ text: '引用广告样本' }))).body.kind, 'semantic');
  const stored = JSON.parse(h.sqlite.prepare('SELECT payload FROM dictionary_snapshot').get().payload);
  assert.equal(stored.samples[0].count, 2);
});
test('nearby embedding classification validates dimensionality, reports neuron use and never writes', async () => {
  const h = harness(); await dictionary(h, data({ samples: [sample('别的广告话术', { embedding: [1, 0, 0] })] }));
  const hit = await classify(h, message({ text: '新的类似推广话术' }));
  assert.equal(hit.body.kind, 'semantic'); assert.equal(hit.body.similarity, 1);
  assert.equal(hit.body.metrics.neurons, 0.5); assert.equal(hit.body.metrics.rowsWritten, 0);
  assert.equal(h.ai.length, 1); assert.equal(h.ai[0].model, EMBEDDING_MODEL);
  h.env.AI.run = async model => model === EMBEDDING_MODEL ? { data: [[1, 0]] } : { response: 'ok' };
  assert.equal((await classify(h, message({ text: '新的类似推广话术' }))).body.kind, 'normal');
  h.env.AI.run = async model => model === EMBEDDING_MODEL ? { data: [[0, 0, 0]] } : { response: 'ok' };
  assert.equal((await classify(h, message({ text: '新的类似推广话术' }))).body.kind, 'candidate');
});
test('structure/AI verdicts only produce candidate or normal; invalid, missing or failed AI needs human review', async () => {
  const h = harness(); await dictionary(h);
  const structure = await classify(h);
  assert.equal(structure.body.kind, 'candidate'); assert.equal(structure.body.reason, 'structure');
  assert.equal(h.ai.length, 0);
  const normal = await classify(h, message({ text: '今天聊聊普通天气' }));
  assert.equal(normal.body.kind, 'normal'); assert.equal(normal.body.metrics.neurons, 1.5);
  assert.equal(h.ai.at(-1).model, CLASSIFIER_MODEL); assert.equal(h.ai.at(-1).input.max_tokens, 64);
  assert.equal(h.ai.at(-1).input.temperature, 0);
  h.env.AI.run = async () => ({ response: 'ad' });
  assert.equal((await classify(h, message({ text: '联系我们的推广服务' }))).body.reason, 'ai_ad');
  for (const response of [{ response: 'ad or ok' }, { response: 'ad', finish_reason: 'length' }, { choices: [{ finish_reason: 'content_filter', message: { content: 'ad' } }] }]) {
    h.env.AI.run = async () => response;
    assert.equal((await classify(h, message({ text: '联系我们的推广服务' }))).body.reason, 'ai_unavailable');
  }
  h.env.AI.run = async () => { throw new Error('PRIVATE-PROVIDER-SECRET'); };
  const failure = await classify(h, message({ text: '联系我们的推广服务' }));
  assert.equal(failure.body.reason, 'ai_unavailable'); assert.ok(!JSON.stringify(failure.body).includes('PRIVATE'));
  delete h.env.AI;
  assert.equal((await classify(h, message({ text: '联系我们的推广服务' }))).body.reason, 'ai_unavailable');
  assert.equal((await classify(h, message({ text: '🔥🔥🔥' }))).body.kind, 'normal');
});
test('missing, malformed or failed dictionary never returns an unsafe verdict', async () => {
  const h = harness(); await dictionary(h);
  h.sqlite.prepare('DELETE FROM dictionary_snapshot').run(); clearSnapshotCache(h.env.DB);
  assert.equal((await classify(h)).status, 409);
  h.sqlite.prepare('INSERT INTO dictionary_snapshot VALUES (1,?,?,?)').run(VERSION, '{PRIVATE-BAD-JSON', 1);
  clearSnapshotCache(h.env.DB);
  const invalid = await classify(h); assert.equal(invalid.status, 503); assert.equal(invalid.body.error, 'dictionary_invalid');
  assert.ok(!JSON.stringify(invalid.body).includes('PRIVATE'));
  h.env.DB.prepare = () => { throw new Error('PRIVATE-DB-TOKEN'); };
  clearSnapshotCache(h.env.DB);
  const broken = await classify(h); assert.equal(broken.status, 503);
  assert.ok(!JSON.stringify(broken.body).includes('PRIVATE'));
});
test('oversized dictionary HTTP body is rejected before SQL', async () => {
  const h = harness();
  const result = await call(h, '/dictionary', {}, { raw: 'x'.repeat(MAX_DICTIONARY_BYTES + 1) });
  assert.equal(result.status, 413); assert.equal(h.sql.length, 0);
});
