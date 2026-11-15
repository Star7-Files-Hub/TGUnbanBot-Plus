// Admin /spam report -> owner confirmation learning regressions.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const source = fs.readFileSync(new URL('./_worker.js', import.meta.url), 'utf8');
const worker = await import('data:text/javascript;base64,' + Buffer.from(source + '\nexport { handleSpam };').toString('base64'));

const phrase = '高价收购实名号四件套，长期招代理';
const GROUP = '-1001', OWNER = '999', ADMIN = '888', TARGET = '555';

function harness() {
  worker.resetSchemaState(); worker.invalidateOwners(); worker.invalidateGroups(); worker.invalidateUserWhitelist(); worker.invalidateAdminCache();
  const sqlite = new DatabaseSync(':memory:');
  const calls = [], ai = [];
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
    OWNER_ID: OWNER, GROUP_ID: GROUP, DB: db,
    AI: { async run(model, options) { ai.push({ model, options }); if (String(model).includes('bge-m3')) return { data: [[1, 0, 0]] }; return { response: JSON.stringify({ is_ad: true, candidates: [phrase] }) }; } },
    __tgMock: Object.fromEntries(['sendMessage', 'editMessageText', 'answerCallbackQuery', 'banChatMember', 'deleteMessage', 'getChatMember', 'unbanChatMember'].map(method => [method, async body => {
      calls.push({ method, body });
      if (method === 'getChatMember') return { ok: true, result: { status: 'administrator', user: { id: body.user_id } } };
      return { ok: true, result: method === 'sendMessage' ? { message_id: 1 } : true };
    }])),
  };
  return { env, sqlite, calls, ai };
}
const rows = (h, table) => h.sqlite.prepare('SELECT * FROM ' + table).all();
const adminMsg = () => ({
  message_id: 10, text: '/spam',
  chat: { id: GROUP, type: 'supergroup', title: '测试群' },
  from: { id: ADMIN, first_name: '管理员', is_bot: false },
  reply_to_message: { message_id: 11, from: { id: TARGET, first_name: '广告号', username: 'ad_seller' }, text: phrase },
});

test('admin /spam stores report but does not learn immediately', async () => {
  const h = harness();
  await worker.adDetectionReady(h.env);
  const config = { primaryOwner: OWNER, primaryGroup: GROUP, ownerIds: new Set([OWNER]), groupIds: new Set([GROUP]) };
  await worker.handleSpam(h.env, adminMsg(), '', config, false, { waitUntil() {} });
  assert.equal(rows(h, 'ad_spam_reports').length, 1);
  assert.equal(rows(h, 'ad_spam_reports')[0].status, 'open');
  assert.equal(rows(h, 'ad_fingerprints').length, 0);
  assert.equal(rows(h, 'ad_samples').length, 0);
  assert.ok(h.calls.some(c => c.method === 'banChatMember' && String(c.body.chat_id) === GROUP));
  assert.ok(h.calls.some(c => c.method === 'sendMessage' && String(c.body.chat_id) === OWNER));
});

test('owner confirmation learns reviewed phrase and closes the report', async () => {
  const h = harness();
  await worker.adDetectionReady(h.env);
  const config = { primaryOwner: OWNER, primaryGroup: GROUP, ownerIds: new Set([OWNER]), groupIds: new Set([GROUP]) };
  await worker.handleSpam(h.env, adminMsg(), '', config, false, { waitUntil() {} });
  await worker.handleCallback(h.env, {
    id: 'cb1', data: 'c:spam:' + TARGET,
    from: { id: OWNER, is_bot: false, first_name: '主人' },
    message: { chat: { id: OWNER, type: 'private' }, message_id: 9001 },
  });
  const fps = rows(h, 'ad_fingerprints');
  assert.equal(fps.length, 1);
  assert.equal(fps[0].type, 'ad_phrase');
  assert.equal(fps[0].status, 'pending');
  assert.equal(rows(h, 'ad_samples').length, 1);
  assert.equal(rows(h, 'ad_spam_reports')[0].status, 'confirmed');
  assert.ok(h.calls.some(c => c.method === 'editMessageText'));
});
