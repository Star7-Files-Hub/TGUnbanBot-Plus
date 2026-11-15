// Manager panel and auto-ban notification regressions.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const source = fs.readFileSync(new URL('./_worker.js', import.meta.url), 'utf8');
const worker = await import('data:text/javascript;base64,' + Buffer.from(source + '\nexport { handleManagerPanel, setBotSetting, getBotSetting, buildManagerPanelText, buildManagerPanelKeyboard };').toString('base64'));

const OWNER = '999', DEPUTY = '998', GROUP = '-1001', TARGET = '555';
const adText = '高价收购实名号四件套，长期招代理';

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
    OWNER_ID: OWNER, GROUP_ID: GROUP, DB: db,
    AI: { async run(model, options) { if (String(model).includes('bge-m3')) return { data: [[1, 0, 0]] }; return { response: 'ok' }; } },
    __tgMock: Object.fromEntries(['sendMessage', 'editMessageText', 'answerCallbackQuery', 'restrictChatMember', 'banChatMember', 'deleteMessage'].map(method => [method, async body => {
      calls.push({ method, body });
      return { ok: true, result: method === 'sendMessage' ? { message_id: 1 } : true };
    }])),
  };
  return { env, sqlite, calls };
}

test('/manager is primary-only and private-only', async () => {
  const h = harness();
  await worker.adDetectionReady(h.env);
  await worker.handleManagerPanel(h.env, { chat: { id: OWNER, type: 'private' }, from: { id: OWNER } }, true);
  assert.equal(h.calls.filter(c => c.method === 'sendMessage').length, 1);
  const sent = h.calls.find(c => c.method === 'sendMessage');
  assert.ok(String(sent.body.text).includes('自动封禁通知主人'));
  assert.ok(String(sent.body.text).includes('已关闭'));
  assert.ok(sent.body.reply_markup.inline_keyboard[0][0].callback_data === 'mgr:auto_ban_notify:toggle');

  h.calls.length = 0;
  await worker.handleManagerPanel(h.env, { chat: { id: DEPUTY, type: 'private' }, from: { id: DEPUTY } }, false);
  await worker.handleManagerPanel(h.env, { chat: { id: GROUP, type: 'supergroup' }, from: { id: OWNER } }, true);
  assert.equal(h.calls.filter(c => c.method === 'sendMessage').length, 0);
});

test('toggle callback flips the persisted setting', async () => {
  const h = harness();
  await worker.adDetectionReady(h.env);
  assert.equal(await worker.getBotSetting(h.env, 'auto_ban_notify', '0'), '0');
  await worker.handleCallback(h.env, {
    id: 'cb', data: 'mgr:auto_ban_notify:toggle',
    from: { id: OWNER, is_bot: false },
    message: { chat: { id: OWNER, type: 'private' }, message_id: 10 },
  });
  assert.equal(await worker.getBotSetting(h.env, 'auto_ban_notify', '0'), '1');
  const edited = h.calls.find(c => c.method === 'editMessageText');
  assert.ok(edited && String(edited.body.text).includes('已开启'));
  assert.ok(h.calls.some(c => c.method === 'answerCallbackQuery'));
});

test('auto-ban notification is off by default and honors the switch', async () => {
  const h = harness();
  await worker.adDetectionReady(h.env);
  const msg = { message_id: 1, chat: { id: GROUP, type: 'supergroup', title: '测试群' }, from: { id: TARGET, first_name: '广告号' }, text: adText };
  await worker.detectAdOnMessage(h.env, msg);
  assert.ok(h.calls.some(c => c.method === 'restrictChatMember'));
  assert.equal(h.calls.filter(c => c.method === 'sendMessage' && String(c.body.chat_id) === OWNER).length, 0);

  h.calls.length = 0;
  await worker.setBotSetting(h.env, 'auto_ban_notify', '1');
  await worker.detectAdOnMessage(h.env, { ...msg, message_id: 2 });
  const ownerDm = h.calls.find(c => c.method === 'sendMessage' && String(c.body.chat_id) === OWNER);
  assert.ok(ownerDm && String(ownerDm.body.text).includes('自动处置广告'));
  assert.ok(String(ownerDm.body.text).includes(adText.slice(0, 6)));
});
