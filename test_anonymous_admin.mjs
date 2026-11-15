// Beta anonymous admin regressions. No network or secrets.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./_worker.js', import.meta.url), 'utf8');
const worker = await import('data:text/javascript;base64,' + Buffer.from(source + '\nexport { handleBan, handleSpam, handleUnban, isAnonymousAdminMessage, getMessageActorId };').toString('base64'));

const GROUP = '-1001', GROUP2 = '-1002', OWNER = '999', TARGET = '555', ANON_BOT = '1087968824';
function makeDb() {
  const sqlite = new DatabaseSync(':memory:');
  for (const sql of [
    'CREATE TABLE blacklist (user_id TEXT PRIMARY KEY, reason TEXT, note TEXT, by TEXT, created_at INTEGER NOT NULL)',
    'CREATE TABLE ad_ban_scope (user_id TEXT, chat_id TEXT, reason TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(user_id, chat_id))',
    'CREATE TABLE moderation_messages (mid INTEGER, chat_id TEXT, from_id TEXT, created_at INTEGER NOT NULL)',
    'CREATE TABLE ad_owners (user_id TEXT PRIMARY KEY, added_by TEXT, created_at INTEGER NOT NULL)',
    'CREATE TABLE ad_groups (chat_id TEXT PRIMARY KEY, added_by TEXT, created_at INTEGER NOT NULL)',
    'CREATE TABLE ad_spam_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, target_user_id TEXT NOT NULL, chat_id TEXT NOT NULL, reporter_id TEXT, message_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'open\', created_at INTEGER NOT NULL)',
  ]) sqlite.exec(sql);
  const db = {
    prepare(sql) {
      let values = [];
      return {
        bind(...params) { values = params; return this; },
        async run() { const r = sqlite.prepare(sql).run(...values); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
        async first() { return sqlite.prepare(sql).get(...values) || null; },
        async all() { return { results: sqlite.prepare(sql).all(...values) }; },
      };
    },
    async batch(statements) { return Promise.all(statements.map(s => s.run())); },
  };
  return { db, sqlite };
}

function harness() {
  worker.resetSchemaState(); worker.invalidateAdminCache(); worker.invalidateOwners(); worker.invalidateGroups(); worker.invalidateUserWhitelist();
  const { db, sqlite } = makeDb();
  const calls = []; const tasks = [];
  const env = {
    OWNER_ID: OWNER, GROUP_ID: GROUP, DB: db,
    __tgMock: Object.fromEntries(['sendMessage', 'banChatMember', 'unbanChatMember', 'deleteMessage', 'restrictChatMember'].map(method => [method, async body => {
      calls.push({ method, body });
      return { ok: true, result: method === 'sendMessage' ? { message_id: 1 } : true };
    }])),
  };
  const ctx = { waitUntil(p) { tasks.push(p); } };
  const config = { primaryOwner: OWNER, primaryGroup: GROUP, ownerIds: new Set([OWNER]), groupIds: new Set([GROUP, GROUP2]) };
  return { env, ctx, calls, tasks, sqlite, config };
}
const anonMsg = (text, extra = {}) => ({
  message_id: 7, text,
  chat: { id: GROUP, type: 'supergroup', title: '测试群' },
  from: { id: ANON_BOT, is_bot: true, first_name: 'GroupAnonymousBot' },
  sender_chat: { id: GROUP, type: 'supergroup', title: '测试群' },
  ...extra,
});

test('anonymous admin is recognized as the group actor', () => {
  const msg = anonMsg('/ban');
  assert.equal(worker.isAnonymousAdminMessage(msg), true);
  assert.equal(worker.getMessageActorId(msg), 'anonymous_admin:' + GROUP);
});

test('anonymous admin /ban acts on current group without a member lookup', async () => {
  const h = harness();
  await worker.handleBan(h.env, anonMsg('/ban ' + TARGET), TARGET, h.config, false, h.ctx);
  const bans = h.calls.filter(c => c.method === 'banChatMember');
  assert.equal(bans.length, 1);
  assert.equal(String(bans[0].body.chat_id), GROUP);
  assert.equal(h.calls.some(c => c.method === 'getChatMember'), false);
});

test('anonymous admin /spam bans current group and reports the group identity', async () => {
  const h = harness();
  await worker.handleSpam(h.env, anonMsg('/spam', { reply_to_message: { message_id: 8, from: { id: TARGET, first_name: '广告号' }, text: '出售账号' } }), '', h.config, false, h.ctx);
  const bans = h.calls.filter(c => c.method === 'banChatMember');
  assert.equal(bans.length, 1);
  const ownerDm = h.calls.find(c => c.method === 'sendMessage' && String(c.body.chat_id) === OWNER);
  assert.ok(ownerDm && String(ownerDm.body.text).includes('anonymous_admin:' + GROUP));
});

test('anonymous admin /unban acts on current group', async () => {
  const h = harness();
  h.sqlite.prepare('INSERT INTO ad_ban_scope VALUES (?, ?, ?, ?)').run(TARGET, GROUP, 'group_admin_ban', 1);
  await worker.handleUnban(h.env, anonMsg('/unban ' + TARGET), TARGET, h.config, false, h.ctx);
  const unbans = h.calls.filter(c => c.method === 'unbanChatMember');
  assert.equal(unbans.length, 1);
  assert.equal(String(unbans[0].body.chat_id), GROUP);
  assert.equal(h.calls.some(c => c.method === 'getChatMember'), false);
});

test('anonymous admin message is skipped by automatic detection', async () => {
  const h = harness();
  const result = await worker.detectAdOnMessage(h.env, anonMsg('出售账号 加微信 招代理'));
  assert.equal(result, null);
  assert.equal(h.calls.filter(c => c.method === 'restrictChatMember').length, 0);
});

test('anonymous admin message is not recorded into sweepable member ledger', async () => {
  const h = harness();
  await worker.recordMessage(h.env, anonMsg('普通内容'));
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) c FROM moderation_messages').get().c, 0);
});
