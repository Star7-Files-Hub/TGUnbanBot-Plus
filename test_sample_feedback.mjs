// /addsample feedback follows the real SQLite write result; no network/credentials.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const source = fs.readFileSync(new URL('./_worker.js', import.meta.url), 'utf8');
const worker = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const OWNER = '999';
const DEPUTY = '998';
const validText = '高价收购实名号四件套，长期招代理';
const fireBlock = Array.from({ length: 7 }, () => '🔥'.repeat(10)).join('\n');

function harness({ insertFailure = '' } = {}) {
  worker.resetSchemaState(); worker.invalidateOwners(); worker.invalidateGroups();
  worker.invalidateUserWhitelist(); worker.invalidateAdminCache(); worker.invalidateObserveGroups();
  const sqlite = new DatabaseSync(':memory:');
  const sent = [];
  const failures = { merge: false };
  const env = {
    OWNER_ID: OWNER, GROUP_ID: '-1001',
    DB: {
      prepare(sql) {
        let args = [];
        return {
          bind(...params) { args = params; return this; },
          async first() { return sqlite.prepare(sql).get(...args) || null; },
          async all() { return { results: sqlite.prepare(sql).all(...args) }; },
          async run() {
            if (failures.merge && /^UPDATE ad_samples SET (count|variants)/.test(sql)) return { success: false };
            if (/INSERT INTO ad_samples/.test(sql)) {
              if (insertFailure === 'throw') throw new Error('PRIVATE-DB-DETAIL');
              if (insertFailure === 'response') return { success: false };
            }
            const result = sqlite.prepare(sql).run(...args);
            return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
          },
        };
      },
      async batch(statements) { return Promise.all(statements.map(stmt => stmt.run())); },
    },
    __tgMock: {
      async sendMessage(body) { sent.push(body); return { ok: true, result: { message_id: sent.length } }; },
    },
  };
  return { env, sqlite, sent, failures };
}
async function command(h, text, userId = OWNER) {
  const result = await worker.default.fetch(new Request('https://test.invalid/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { message_id: 1, chat: { id: userId, type: 'private' }, from: { id: userId }, text } }),
  }), h.env, { waitUntil() { throw new Error('Private receipt must not expire'); } });
  assert.equal(result.status, 200);
  return h.sent.at(-1)?.text || '';
}
async function samples(h) {
  const response = await worker.default.fetch(new Request('https://test.invalid/api/samples'), h.env);
  assert.equal(response.status, 200);
  return response.json();
}

for (const [label, text] of [
  ['multiline pure emoji', fireBlock],
  ['one emoji', '🔥'],
  ['emoji and punctuation', '🔥 !!! --- ++++ ::::'],
  ['ZWJ/variation emoji', '👨‍👩‍👧‍👦❤️‍🔥🎉'],
  ['only a mention', '@sales_agent'],
  ['only a link', 'https://example.invalid/marketing'],
  ['only uppercase links', 'HTTPS://EXAMPLE.INVALID/SALE'],
  ['only Telegram link', 't.me/channel_name'],
]) {
  test(`rejected ${label} never reports success or changes the sample API`, async () => {
    const h = harness();
    const reply = await command(h, '/addsample ' + text);
    assert.match(reply, /未保存/);
    assert.doesNotMatch(reply, /已新增|已合并/);
    const data = await samples(h);
    assert.equal(data.total, 0);
    assert.equal(data.items.length, 0);
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS c FROM ad_fingerprints').get().c, 0);
  });
}
for (const text of ['abc', '缺米', 'a b c', '🔥一🔥二🔥三', '一!二!三!']) {
  test(`short meaningful text is rejected honestly: ${text}`, async () => {
    const h = harness();
    const reply = await command(h, '/addsample ' + text);
    assert.match(reply, /未保存.*4 个有效/);
    assert.doesNotMatch(reply, /已新增|已合并/);
    assert.equal((await samples(h)).total, 0);
  });
}
test('valid text with emoji is saved and exposes its real ID via API', async () => {
  const h = harness();
  const reply = await command(h, '/addsample 🔥' + validText + '🔥');
  const data = await samples(h);
  assert.equal(data.total, 1);
  assert.equal(data.items[0].sample_text, '🔥' + validText + '🔥');
  assert.equal(data.items[0].kind, 'text');
  assert.equal(data.items[0].source, 'manual');
  assert.match(reply, new RegExp('已新增语义样本 #' + data.items[0].id + '$'));
});
test('same sample merges with its ID and count rather than falsely adding a row', async () => {
  const h = harness();
  await command(h, '/addsample ' + validText);
  const reply = await command(h, '/addsample ' + validText);
  const data = await samples(h);
  assert.equal(data.total, 1);
  assert.equal(data.items[0].count, 2);
  assert.match(reply, new RegExp('已合并进语义簇 #' + data.items[0].id));
});
test('signature variant reports a merge instead of adding a duplicate', async () => {
  const h = harness();
  await command(h, '/addsample ' + validText);
  const reply = await command(h, '/addsample ' + validText + '欢迎长期合作');
  const data = await samples(h);
  assert.match(reply, /已合并进语义簇 #\d+（第 2 级）/);
  assert.equal(data.total, 1);
  assert.equal(data.items[0].count, 2);
});
for (const text of [validText, validText + '欢迎长期合作']) {
  test('failed merge never reports a confirmed write: ' + text, async () => {
    const h = harness();
    await command(h, '/addsample ' + validText);
    h.failures.merge = true;
    const reply = await command(h, '/addsample ' + text);
    assert.match(reply, /保存失败/);
    assert.doesNotMatch(reply, /已新增|已合并/);
    const data = await samples(h);
    assert.equal(data.total, 1);
    assert.equal(data.items[0].count, 1);
  });
}
test('valid four-character text is accepted at the boundary', async () => {
  const h = harness();
  assert.match(await command(h, '/addsample 广告样本'), /已新增语义样本/);
  assert.equal((await samples(h)).total, 1);
});
for (const insertFailure of ['throw', 'response']) {
  test(`database ${insertFailure} never emits success or raw details`, async () => {
    const h = harness({ insertFailure });
    const reply = await command(h, '/addsample ' + validText);
    assert.match(reply, /保存失败/);
    assert.doesNotMatch(reply, /已新增|已合并|PRIVATE-DB-DETAIL/);
    assert.equal((await samples(h)).total, 0);
  });
}
test('deputy receives the same validation and receipt as owner', async () => {
  const h = harness(); await worker.adDetectionReady(h.env);
  h.sqlite.prepare('INSERT INTO ad_owners (user_id, created_at) VALUES (?, ?)').run(DEPUTY, 1);
  worker.invalidateOwners();
  assert.match(await command(h, '/addsample ' + fireBlock, DEPUTY), /未保存/);
  assert.equal((await samples(h)).total, 0);
  assert.match(await command(h, '/addsample ' + validText, DEPUTY), /已新增语义样本/);
  assert.equal((await samples(h)).total, 1);
});
test('empty addsample hint is valid Telegram HTML', async () => {
  const h = harness();
  const reply = await command(h, '/addsample');
  assert.match(reply, /用法/);
  assert.match(reply, /<code>广告文本<\/code>/);
  assert.doesNotMatch(reply, /<广告文本>/);
});
