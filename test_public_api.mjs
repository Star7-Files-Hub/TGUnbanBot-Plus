// Public read-only API regressions: fingerprints and blacklist.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const source = fs.readFileSync(new URL('./_worker.js', import.meta.url), 'utf8');
const worker = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

function harness() {
  worker.resetSchemaState();
  const sqlite = new DatabaseSync(':memory:');
  const db = {
    prepare(sql) {
      let args = [];
      return {
        bind(...p) { args = p; return this; },
        async first() { return sqlite.prepare(sql).get(...args) || null; },
        async all() { return { results: sqlite.prepare(sql).all(...args) }; },
        async run() { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
      };
    },
    async batch(statements) { return Promise.all(statements.map(s => s.run())); },
  };
  return { env: { DB: db }, sqlite };
}
const asJson = async (res) => ({ status: res.status, headers: res.headers, body: JSON.parse(await res.text()) });

test('fingerprints endpoint lists non-retired rows without private fields', async () => {
  const h = harness();
  await worker.adDetectionReady(h.env);
  h.sqlite.prepare("INSERT INTO ad_fingerprints (type, value, norm_value, status, source, confirmed_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run('keyword', '出售账号', '出售账号', 'confirmed', 'manual', '999', 1, 1);
  h.sqlite.prepare("INSERT INTO ad_fingerprints (type, value, norm_value, status, source, confirmed_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run('ad_phrase', '高价收购实名号四件套', '高价收购实名号四件套', 'pending', 'spam_reviewed', null, 2, 2);
  h.sqlite.prepare("INSERT INTO ad_fingerprints (type, value, norm_value, status, source, confirmed_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run('keyword', '已停用词', '已停用词', 'retired', 'manual', '999', 0, 0);
  const res = await worker.servePublicList(h.env, 'fingerprints', new URL('https://x/api/fingerprints'));
  const r = await asJson(res);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.count, 2);
  assert.deepEqual(r.body.items.map(i => i.value).sort(), ['出售账号', '高价收购实名号四件套']);
  assert.ok(Object.keys(r.body.items[0]).every(k => !['norm_value', 'confirmed_by'].includes(k)));
});

test('blacklist endpoint lists ids and reasons without operator notes', async () => {
  const h = harness();
  await worker.adDetectionReady(h.env);
  h.sqlite.prepare('INSERT INTO blacklist VALUES (?, ?, ?, ?, ?)').run('9112496534', 'spam', '老板备注', '5608153118', 5);
  const res = await worker.servePublicList(h.env, 'blacklist', new URL('https://x/api/blacklist'));
  const r = await asJson(res);
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 1);
  assert.equal(r.body.items[0].user_id, '9112496534');
  assert.equal(r.body.items[0].reason, 'spam');
  assert.deepEqual(Object.keys(r.body.items[0]).sort(), ['created_at', 'reason', 'user_id']);
});

test('public endpoints respect limit and report no_db', async () => {
  const h = harness();
  const res = await worker.servePublicList({}, 'fingerprints', new URL('https://x/api/fingerprints?limit=5'));
  const r = await asJson(res);
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'no_db');
});
