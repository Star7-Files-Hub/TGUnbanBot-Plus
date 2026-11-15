// /spam by ID and multiple-ID regressions.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const source = fs.readFileSync(new URL('./_worker.js', import.meta.url), 'utf8');
const worker = await import('data:text/javascript;base64,' + Buffer.from(source + '\nexport { handleSpam, parseIdList };').toString('base64'));

const OWNER = '999', ADMIN = '888', GROUP = '-1001', GROUP2 = '-1002';

function harness({ admin = true } = {}) {
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
    OWNER_ID: OWNER, GROUP_ID: GROUP + ',' + GROUP2, DB: db,
    __tgMock: Object.fromEntries(['sendMessage', 'banChatMember', 'deleteMessage', 'editMessageText'].map(method => [method, async body => {
      calls.push({ method, body });
      if (method === 'getChatMember') return { ok: true, result: { status: admin ? 'administrator' : 'member', user: { id: body.user_id } } };
      return { ok: true, result: method === 'sendMessage' ? { message_id: 1 } : true };
    }])),
  };
  env.__tgMock.getChatMember = async body => ({ ok: true, result: { status: admin ? 'administrator' : 'member', user: { id: body.user_id } } });
  return { env, sqlite, calls };
}
const rows = (h, table) => h.sqlite.prepare('SELECT * FROM ' + table).all();
const msg = (text, from = OWNER, chat = GROUP) => ({ message_id: 1, text, chat: { id: chat, type: 'supergroup', title: '群' }, from: { id: from, first_name: '操作者', is_bot: false } });
const config = () => ({ primaryOwner: OWNER, primaryGroup: GROUP, ownerIds: new Set([OWNER]), groupIds: new Set([GROUP, GROUP2]) });

test('parseIdList parses, dedupes and filters IDs', () => {
  assert.deepEqual(worker.parseIdList('9112496534'), ['9112496534']);
  assert.deepEqual(worker.parseIdList('9112496534,8888888,666666'), ['9112496534', '8888888', '666666']);
  assert.deepEqual(worker.parseIdList('9112496534，8888888,9112496534,abc,-1'), ['9112496534', '8888888']);
});

test('owner /spam by single ID blacklists and bans all groups without learning', async () => {
  const h = harness();
  await worker.adDetectionReady(h.env);
  await worker.handleSpam(h.env, msg('/spam 9112496534'), '9112496534', config(), true, { waitUntil() {} });
  assert.equal(rows(h, 'blacklist').length, 1);
  assert.equal(h.calls.filter(c => c.method === 'banChatMember').length, 2);
  assert.equal(rows(h, 'ad_fingerprints').length, 0);
  const sent = h.calls.find(c => c.method === 'sendMessage' && String(c.body.chat_id) === GROUP);
  assert.ok(String(sent.body.text).includes('9112496534'));
});

test('owner /spam by multiple IDs handles every ID', async () => {
  const h = harness();
  await worker.adDetectionReady(h.env);
  await worker.handleSpam(h.env, msg('/spam 9112496534,8888888,666666'), '9112496534,8888888,666666', config(), true, { waitUntil() {} });
  assert.equal(rows(h, 'blacklist').length, 3);
  assert.equal(h.calls.filter(c => c.method === 'banChatMember').length, 6);
  assert.equal(rows(h, 'ad_fingerprints').length, 0);
});

test('admin /spam by multiple IDs bans current group and reports each ID', async () => {
  const h = harness({ admin: true });
  await worker.adDetectionReady(h.env);
  await worker.handleSpam(h.env, msg('/spam 9112496534,8888888', ADMIN), '9112496534,8888888', config(), false, { waitUntil() {} });
  assert.equal(h.calls.filter(c => c.method === 'banChatMember' && String(c.body.chat_id) === GROUP).length, 2);
  assert.equal(rows(h, 'ad_spam_reports').length, 2);
  assert.equal(rows(h, 'ad_spam_reports').every(r => r.status === 'open'), true);
  const ownerDms = h.calls.filter(c => c.method === 'sendMessage' && String(c.body.chat_id) === OWNER);
  assert.equal(ownerDms.length, 2);
  assert.equal(rows(h, 'ad_fingerprints').length, 0);
});

test('no ID and no reply still returns usage hint', async () => {
  const h = harness();
  await worker.adDetectionReady(h.env);
  await worker.handleSpam(h.env, msg('/spam'), '', config(), true, { waitUntil() {} });
  const sent = h.calls.find(c => c.method === 'sendMessage');
  assert.ok(String(sent.body.text).includes('用法'));
});
