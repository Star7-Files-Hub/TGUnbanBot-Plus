// Observe-group sample collection regressions.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const source = fs.readFileSync(new URL('./_worker.js', import.meta.url), 'utf8');
const worker = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

const OWNER = '999', GROUP = '-1009', TARGET = '555';
const adText = '出售实名号四件套 长期合作';

function harness() {
  worker.resetSchemaState(); worker.invalidateOwners(); worker.invalidateGroups(); worker.invalidateUserWhitelist(); worker.invalidateAdminCache(); worker.invalidateObserveGroups();
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
    OWNER_ID: OWNER, GROUP_ID: '-1001', DB: db,
    AI: { async run(model, options) { if (String(model).includes('bge-m3')) return { data: [[1, 0, 0]] }; return { response: 'ok' }; } },
    __tgMock: Object.fromEntries(['sendMessage', 'editMessageText', 'answerCallbackQuery', 'restrictChatMember', 'banChatMember', 'deleteMessage', 'getChatMember'].map(method => [method, async body => {
      calls.push({ method, body });
      if (method === 'getChatMember') return { ok: true, result: { status: 'member', user: { id: body.user_id } } };
      return { ok: true, result: method === 'sendMessage' ? { message_id: 1 } : true };
    }])),
  };
  return { env, sqlite, calls };
}
const rows = (h, table) => h.sqlite.prepare('SELECT * FROM ' + table).all();
const msg = () => ({ message_id: 7, chat: { id: GROUP, type: 'supergroup', title: '广告群' }, from: { id: TARGET, first_name: '广告号', username: 'seller', is_bot: false }, text: adText });

test('add/del listen group via DB updates observe set', async () => {
  const h = harness();
  await worker.adDetectionReady(h.env);
  await worker.handleCommand(h.env, { text: '/addlisten ' + GROUP, chat: { id: OWNER, type: 'private' }, from: { id: OWNER } });
  assert.equal(await worker.isObserveGroup(h.env, GROUP), true);
  await worker.handleCommand(h.env, { text: '/dellisten ' + GROUP, chat: { id: OWNER, type: 'private' }, from: { id: OWNER } });
  assert.equal(await worker.isObserveGroup(h.env, GROUP), false);
});

test('observe mode notifies owner for unmatched ad and never punishes', async () => {
  const h = harness();
  await worker.adDetectionReady(h.env);
  h.sqlite.prepare('INSERT INTO ad_observe_groups VALUES (?, ?, ?, ?)').run(GROUP, '广告群', OWNER, 1);
  worker.invalidateObserveGroups();
  const result = await worker.detectAdOnMessage(h.env, msg(), { observe: true });
  assert.equal(result.action, 'observe');
  assert.equal(h.calls.filter(c => c.method === 'restrictChatMember').length, 0);
  assert.equal(h.calls.filter(c => c.method === 'banChatMember').length, 0);
  const dm = h.calls.find(c => c.method === 'sendMessage' && String(c.body.chat_id) === OWNER);
  assert.ok(dm && String(dm.body.text).includes('观察群疑似广告'));
  assert.ok(String(dm.body.reply_markup.inline_keyboard[0][0].callback_data).startsWith('o:save:'));
  assert.equal(rows(h, 'ad_observe_reports').length, 1);
});

test('observe mode skips messages already covered by fingerprints', async () => {
  const h = harness();
  await worker.adDetectionReady(h.env);
  h.sqlite.prepare('INSERT INTO ad_observe_groups VALUES (?, ?, ?, ?)').run(GROUP, '广告群', OWNER, 1);
  h.sqlite.prepare("INSERT INTO ad_fingerprints (type, value, norm_value, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run('keyword', adText, worker.normalizeAdText(adText), 'confirmed', 'manual', 1, 1);
  worker.invalidateObserveGroups();
  const result = await worker.detectAdOnMessage(h.env, msg(), { observe: true });
  assert.equal(result.action, 'pass');
  assert.equal(h.calls.filter(c => c.method === 'sendMessage' && String(c.body.chat_id) === OWNER).length, 0);
  assert.equal(h.calls.filter(c => c.method === 'restrictChatMember').length, 0);
});

test('owner save/dismiss callbacks update report and samples', async () => {
  const h = harness();
  await worker.adDetectionReady(h.env);
  h.sqlite.prepare('INSERT INTO ad_observe_groups VALUES (?, ?, ?, ?)').run(GROUP, '广告群', OWNER, 1);
  worker.invalidateObserveGroups();
  await worker.detectAdOnMessage(h.env, msg(), { observe: true });
  const reportId = rows(h, 'ad_observe_reports')[0].id;

  await worker.handleCallback(h.env, { id: 'cb1', data: 'o:save:' + reportId, from: { id: OWNER, is_bot: false }, message: { chat: { id: OWNER, type: 'private' }, message_id: 10 } });
  assert.equal(rows(h, 'ad_samples').length, 1);
  assert.equal(rows(h, 'blacklist').length, 1);
  assert.equal(rows(h, 'blacklist')[0].user_id, TARGET);
  assert.ok(h.calls.some(c => c.method === 'banChatMember'));
  assert.equal(rows(h, 'ad_observe_reports')[0].status, 'saved');

  h.sqlite.prepare("UPDATE ad_observe_reports SET status='open' WHERE id=?").run(reportId);
  await worker.handleCallback(h.env, { id: 'cb2', data: 'o:dismiss:' + reportId, from: { id: OWNER, is_bot: false }, message: { chat: { id: OWNER, type: 'private' }, message_id: 11 } });
  assert.equal(rows(h, 'ad_samples').length, 1);
  assert.equal(rows(h, 'ad_observe_reports')[0].status, 'dismissed');
});
