// Beta admin /unban scope regressions. No network or secrets.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./_worker.js', import.meta.url), 'utf8');
const worker = await import('data:text/javascript;base64,' + Buffer.from(source + '\nexport { handleUnban };').toString('base64'));

function makeDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE IF NOT EXISTS blacklist (user_id TEXT PRIMARY KEY, reason TEXT, note TEXT, by TEXT, created_at INTEGER NOT NULL)');
  sqlite.exec('CREATE TABLE IF NOT EXISTS ad_ban_scope (user_id TEXT, chat_id TEXT, reason TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(user_id, chat_id))');
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

function harness({ admin = false, from = '777', chatType = 'supergroup', target = '555' } = {}) {
  worker.resetSchemaState(); worker.invalidateAdminCache();
  const { db, sqlite } = makeDb();
  const calls = []; const tasks = [];
  const env = {
    OWNER_ID: '999', GROUP_ID: '-1001,-1002', DB: db,
    __tgMock: Object.fromEntries(['sendMessage', 'unbanChatMember', 'getChatMember', 'deleteMessage'].map(method => [method, async body => {
      calls.push({ method, body });
      if (method === 'getChatMember') return { ok: true, result: { status: admin ? 'administrator' : 'member', user: { id: body.user_id } } };
      if (method === 'sendMessage') return { ok: true, result: { message_id: 1 } };
      return { ok: true, result: true };
    }])),
  };
  const ctx = { waitUntil(p) { tasks.push(p); } };
  const config = { primaryOwner: '999', ownerIds: new Set(['999']), groupIds: new Set(['-1001', '-1002']) };
  return { env, ctx, calls, tasks, sqlite, config };
}

const unbanMsg = (from, type = 'supergroup') => ({
  message_id: 7, text: '/unban 555',
  chat: { id: type === 'private' ? from : -1001, type, title: '测试群' },
  from: { id: from, first_name: '操作者', is_bot: false },
});

test('group admin unban only current group, never removes blacklist', async () => {
  const h = harness({ admin: true });
  h.sqlite.prepare("INSERT INTO ad_ban_scope VALUES (?, ?, ?, ?)").run('555', '-1001', 'group_admin_ban', 1);
  h.sqlite.prepare("INSERT INTO ad_ban_scope VALUES (?, ?, ?, ?)").run('555', '-1002', 'owner_spam', 1);
  await worker.handleUnban(h.env, unbanMsg('777'), '555', h.config, false, h.ctx);
  const unbans = h.calls.filter(c => c.method === 'unbanChatMember');
  assert.equal(unbans.length, 1);
  assert.equal(String(unbans[0].body.chat_id), '-1001');
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) c FROM ad_ban_scope WHERE user_id=?').get('555').c, 1);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) c FROM ad_ban_scope WHERE user_id=? AND chat_id=?').get('555', '-1002').c, 1);
  assert.equal(h.calls.filter(c => c.method === 'sendMessage').length, 1);
  assert.equal(h.tasks.length, 1, 'group success receipt expires');
});

test('group admin cannot unban a user in the global blacklist', async () => {
  const h = harness({ admin: true });
  h.sqlite.prepare("INSERT INTO blacklist VALUES (?, ?, ?, ?, ?)").run('555', 'spam', null, '999', 1);
  await worker.handleUnban(h.env, unbanMsg('777'), '555', h.config, false, h.ctx);
  assert.equal(h.calls.filter(c => c.method === 'unbanChatMember').length, 0);
  assert.ok(h.calls.some(c => c.method === 'sendMessage' && String(c.body.text).includes('全群黑名单')));
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) c FROM blacklist WHERE user_id=?').get('555').c, 1);
  assert.equal(h.tasks.length, 1, 'rejection receipt expires');
});

test('non-admin group /unban rejection expires after 8 seconds', async () => {
  const h = harness({ admin: false });
  await worker.handleUnban(h.env, unbanMsg('777'), '555', h.config, false, h.ctx);
  assert.equal(h.calls.filter(c => c.method === 'unbanChatMember').length, 0);
  assert.ok(h.calls.some(c => c.method === 'sendMessage' && String(c.body.text).includes('只有群管理员或主人可以 /unban')));
  assert.equal(h.tasks.length, 1);
});

test('owner /unban removes blacklist and clears every group scope', async () => {
  const h = harness({});
  h.sqlite.prepare("INSERT INTO blacklist VALUES (?, ?, ?, ?, ?)").run('555', 'spam', null, '999', 1);
  h.sqlite.prepare("INSERT INTO ad_ban_scope VALUES (?, ?, ?, ?)").run('555', '-1001', 'group_admin_ban', 1);
  h.sqlite.prepare("INSERT INTO ad_ban_scope VALUES (?, ?, ?, ?)").run('555', '-1002', 'owner_spam', 1);
  await worker.handleUnban(h.env, unbanMsg('999'), '555', h.config, true, h.ctx);
  const unbans = h.calls.filter(c => c.method === 'unbanChatMember');
  assert.equal(unbans.length, 2);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) c FROM blacklist WHERE user_id=?').get('555').c, 0);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) c FROM ad_ban_scope WHERE user_id=?').get('555').c, 0);
  assert.ok(h.calls.some(c => c.method === 'sendMessage' && String(c.body.text).includes('已解除黑名单')));
  assert.equal(h.tasks.length, 1);
});

test('private non-owner rejection is durable (no group timer)', async () => {
  const h = harness({ admin: false });
  await worker.handleUnban(h.env, unbanMsg('777', 'private'), '555', h.config, false, h.ctx);
  assert.equal(h.calls.filter(c => c.method === 'unbanChatMember').length, 0);
  assert.ok(h.calls.some(c => c.method === 'sendMessage' && String(c.body.text).includes('只有群管理员或主人可以 /unban')));
  assert.equal(h.tasks.length, 0);
});
