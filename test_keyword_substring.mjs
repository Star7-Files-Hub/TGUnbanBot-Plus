// Keyword fingerprints now match normalized message body as substring.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const source = fs.readFileSync(new URL('./_worker.js', import.meta.url), 'utf8');
const worker = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

function harness() {
  worker.resetSchemaState(); worker.invalidateOwners(); worker.invalidateGroups(); worker.invalidateUserWhitelist(); worker.invalidateAdminCache();
  const sqlite = new DatabaseSync(':memory:');
  const calls = [];
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
  const env = {
    OWNER_ID: '999', GROUP_ID: '-1001', DB: db,
    __tgMock: Object.fromEntries(['banChatMember', 'restrictChatMember', 'sendMessage', 'deleteMessage'].map(method => [method, async body => {
      calls.push({ method, body });
      return { ok: true, result: true };
    }])),
  };
  return { env, sqlite, calls };
}

test('keyword fingerprint matches obfuscated body by normalized substring', async () => {
  const h = harness();
  await worker.adDetectionReady(h.env);
  h.sqlite.prepare("INSERT INTO ad_fingerprints (type, value, norm_value, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run('keyword', '群发推广', '群发推广', 'confirmed', 'manual', 1, 1);
  const result = await worker.detectAdOnMessage(h.env, {
    message_id: 1, chat: { id: '-1001', type: 'supergroup', title: '群' },
    from: { id: '555', first_name: '推广号', username: 'xgseller' },
    text: '群---发--推----广，让你的广--告24小时不停曝光！ @XGgzs12378',
  });
  assert.equal(result.action, 'ban_all');
  assert.equal(result.fingerprint.value, '群发推广');
  assert.ok(h.calls.some(c => c.method === 'banChatMember'));
});

test('short confirmed keywords do not substring-match arbitrary discussion', async () => {
  const h = harness();
  await worker.adDetectionReady(h.env);
  h.sqlite.prepare("INSERT INTO ad_fingerprints (type, value, norm_value, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run('keyword', '推广', '推广', 'confirmed', 'manual', 1, 1);
  const result = await worker.detectAdOnMessage(h.env, {
    message_id: 1, chat: { id: '-1001', type: 'supergroup', title: '群' },
    from: { id: '555', first_name: '路人', username: 'user' },
    text: '今天聊聊推广的事情',
  });
  assert.equal(result.action, 'pass');
  assert.equal(h.calls.filter(c => c.method === 'banChatMember').length, 0);
});
