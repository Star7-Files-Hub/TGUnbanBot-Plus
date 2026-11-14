// Join-profile screening only: actual SQLite, mocked Telegram/AI, no network or secrets.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('./_worker.js', import.meta.url), 'utf8');
const worker = await import('data:text/javascript;base64,' + Buffer.from(source + '\nexport { classifyJoinProfile, pruneJoinProfileAlerts };').toString('base64'));
const OWNER = '999', DEPUTY = '998', TARGET = '555', GROUP = '-1001';
function harness({ verdict = 'ad', lookup, aiThrows = false, enabled = true } = {}) {
  worker.resetSchemaState(); worker.invalidateOwners(); worker.invalidateGroups(); worker.invalidateUserWhitelist(); worker.invalidateAdminCache();
  const sqlite = new DatabaseSync(':memory:');
  const calls = [], ai = [], sqls = [];
  const db = {
    prepare(sql) {
      sqls.push(sql); let values = [];
      return {
        bind(...params) { values = params; return this; },
        async run() { const r = sqlite.prepare(sql).run(...values); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
        async first() { return sqlite.prepare(sql).get(...values) || null; },
        async all() { return { results: sqlite.prepare(sql).all(...values) }; },
      };
    },
    async batch(statements) { return Promise.all(statements.map(s => s.run())); },
  };
  let nextMid = 10;
  const env = {
    OWNER_ID: OWNER, GROUP_ID: GROUP, AI_ENABLED: enabled ? '1' : '0', DB: db,
    AI: { async run(model, input) { ai.push({ model, input }); if (aiThrows) throw new Error('private-provider-data'); return { response: verdict }; } },
    __tgMock: Object.fromEntries(['sendMessage', 'editMessageText', 'answerCallbackQuery', 'getChatMember', 'restrictChatMember', 'banChatMember'].map(method => [method, async body => {
      calls.push({ method, body });
      if (method === 'getChatMember') {
        if (lookup) return lookup(body);
        return { ok: true, result: { status: 'member', user: { id: body.user_id, first_name: '收购账号 日结', username: 'seller_555', bio: '出售账号 联系 @sales_555' } } };
      }
      return { ok: true, result: method === 'sendMessage' ? { message_id: nextMid++ } : true };
    }])),
  };
  const rows = (sql, ...params) => sqlite.prepare(sql).all(...params);
  return { env, db, calls, ai, sqls, rows, sqlite };
}
const join = (user = {}) => ({ message_id: 1, chat: { id: GROUP, type: 'supergroup', title: 'Test group' }, from: { id: '777' }, new_chat_members: [{ id: TARGET, first_name: '普通名字', ...user }] });
const of = (h, method) => h.calls.filter(c => c.method === method);
async function init(h) {
  await worker.adDetectionReady(h.env);
  await h.db.prepare('INSERT INTO ad_owners (user_id, created_at) VALUES (?, ?)').bind(DEPUTY, 1).run();
  worker.invalidateOwners();
}
function noLearning(h) {
  assert.equal(h.rows('SELECT COUNT(*) AS c FROM ad_fingerprints')[0].c, 0);
  assert.equal(h.rows('SELECT COUNT(*) AS c FROM ad_samples')[0].c, 0);
  assert.equal(h.rows('SELECT COUNT(*) AS c FROM blacklist')[0].c, 0);
}
test('AI join profile hit only mutes current group, stores evidence and sends primary-only review', async () => {
  const h = harness(); await init(h);
  await worker.handleUpdate(h.env, { message: join() });
  assert.equal(of(h, 'getChatMember').length, 1);
  assert.equal(h.ai.length, 1);
  assert.ok(h.ai[0].input.messages[0].content.includes('入群资料'));
  assert.ok(h.ai[0].input.messages[0].content.includes('无法确定'));
  const input = h.ai[0].input.messages[1].content;
  assert.ok(input.includes('收购账号') && input.includes('seller_555') && input.includes('出售账号'));
  assert.deepEqual(of(h, 'restrictChatMember').map(c => [String(c.body.chat_id), String(c.body.user_id)]), [[GROUP, TARGET]]);
  assert.equal(of(h, 'banChatMember').length, 0);
  assert.deepEqual(of(h, 'sendMessage').map(c => String(c.body.chat_id)), [OWNER]);
  assert.ok(!h.calls.some(c => c.method === 'sendMessage' && String(c.body.chat_id) === GROUP));
  const row = h.rows('SELECT * FROM ad_profile_alerts')[0];
  assert.equal(row.status, 'open'); assert.equal(row.user_id, TARGET);
  assert.ok(JSON.parse(row.evidence).includes('bio'));
  assert.equal(JSON.parse(row.snapshot).bioAvailable, true);
  noLearning(h);
});
for (const [name, options] of [['safe AI verdict', { verdict: 'ok' }], ['unknown AI verdict', { verdict: 'explanation' }], ['AI unavailable', { aiThrows: true }]]) {
  test(`No punishment or review for ${name}`, async () => {
    const h = harness(options); await init(h); await worker.handleNewChatMembers(h.env, join());
    assert.equal(h.ai.length, 1); assert.equal(of(h, 'restrictChatMember').length, 0); assert.equal(of(h, 'sendMessage').length, 0); noLearning(h);
  });
}
for (const [name, lookup] of [
  ['lookup error', () => { throw new Error('API failure'); }],
  ['Telegram error', () => ({ ok: false })],
  ['different identity', () => ({ ok: true, result: { status: 'member', user: { id: '666', first_name: '出售账号' } } })],
  ['admin', b => ({ ok: true, result: { status: 'administrator', user: { id: b.user_id, first_name: '出售账号' } } })],
  ['creator', b => ({ ok: true, result: { status: 'creator', user: { id: b.user_id, first_name: '出售账号' } } })],
  ['bot returned by API', b => ({ ok: true, result: { status: 'member', user: { id: b.user_id, is_bot: true, first_name: '出售账号' } } })],
  ['plain name and handle', b => ({ ok: true, result: { status: 'member', user: { id: b.user_id, first_name: 'Alice', username: 'alice_123' } } })],
]) {
  test(`Conservative no-AI pass: ${name}`, async () => {
    const h = harness({ lookup }); await init(h); await worker.handleNewChatMembers(h.env, join());
    assert.equal(of(h, 'getChatMember').length, 1); assert.equal(h.ai.length, 0); assert.equal(of(h, 'restrictChatMember').length, 0); assert.equal(of(h, 'sendMessage').length, 0);
  });
}
test('Missing bio stays unknown; no getChat or guessed bio is used', async () => {
  const h = harness({ lookup: b => ({ ok: true, result: { status: 'member', user: { id: b.user_id, first_name: '收购账号 日结' } } }) }); await init(h);
  await worker.handleNewChatMembers(h.env, join({ bio: 'do not trust join payload bio' }));
  const profile = JSON.parse(h.ai[0].input.messages[1].content.split('\n').at(-1)).own_profile;
  assert.equal(profile.bio, null); assert.equal(profile.bioAvailable, false);
  assert.ok(of(h, 'sendMessage')[0].body.text.includes('未知'));
  assert.equal(h.calls.filter(c => c.method === 'getChat').length, 0);
});
test('Actual member.bio is used only after API identity matches; HTML fields are escaped', async () => {
  const h = harness({ lookup: b => ({ ok: true, result: { status: 'member', bio: '出售账号 <b>联系</b> @seller_555', user: { id: b.user_id, first_name: '<img src=x>' } } }) }); await init(h);
  await worker.handleNewChatMembers(h.env, join());
  const text = of(h, 'sendMessage')[0].body.text;
  assert.ok(text.includes('&lt;img src=x&gt;')); assert.ok(!text.includes('<img')); assert.ok(text.includes('&lt;b&gt;联系&lt;/b&gt;'));
});
for (const kind of ['bot', 'owner', 'deputy', 'whitelist', 'disabled']) {
  test(`Join protection preserves ${kind}`, async () => {
    const h = harness({ enabled: kind !== 'disabled' }); await init(h);
    if (kind === 'whitelist') { await h.db.prepare('INSERT INTO ad_user_whitelist (user_id, created_at) VALUES (?, ?)').bind(TARGET, 1).run(); worker.invalidateUserWhitelist(); }
    const user = kind === 'bot' ? { is_bot: true } : kind === 'owner' ? { id: OWNER } : kind === 'deputy' ? { id: DEPUTY } : {};
    await worker.handleNewChatMembers(h.env, join(user));
    assert.equal(h.ai.length, 0); assert.equal(of(h, 'getChatMember').length, 0); assert.equal(of(h, 'restrictChatMember').length, 0);
  });
}
test('Duplicate join alert does not classify or mute twice within 5 minutes', async () => {
  const h = harness(); await init(h); await worker.handleNewChatMembers(h.env, join()); await worker.handleNewChatMembers(h.env, join());
  assert.equal(h.ai.length, 1); assert.equal(of(h, 'restrictChatMember').length, 1); assert.equal(h.rows('SELECT COUNT(*) AS c FROM ad_profile_alerts')[0].c, 1);
});
function callback(id, action = 'ignore', from = OWNER, chat = OWNER) {
  return { id: 'callback', data: `p:${action}:${id}`, from: { id: from }, message: { message_id: 10, chat: { id: chat, type: 'private' } } };
}
for (const [name, from, chat] of [['deputy', DEPUTY, OWNER], ['member', '777', OWNER], ['forwarded group', OWNER, GROUP]]) {
  test(`Profile review denies ${name}`, async () => {
    const h = harness(); await init(h); await worker.handleNewChatMembers(h.env, join()); h.calls.length = 0;
    await worker.handleCallback(h.env, callback(1, 'ban', from, chat));
    assert.equal(of(h, 'banChatMember').length, 0); assert.equal(h.rows('SELECT status FROM ad_profile_alerts')[0].status, 'open');
  });
}
test('Primary owner ignore only dismisses snapshot; no learning, unmute, or allowlist writes', async () => {
  const h = harness(); await init(h); await worker.handleNewChatMembers(h.env, join()); h.calls.length = 0;
  await worker.handleCallback(h.env, callback(1));
  assert.equal(h.rows('SELECT status FROM ad_profile_alerts')[0].status, 'dismissed');
  assert.equal(of(h, 'restrictChatMember').length, 0); assert.equal(of(h, 'banChatMember').length, 0);
  assert.equal(h.rows('SELECT COUNT(*) AS c FROM ad_allowlist')[0].c, 0); noLearning(h);
});
test('Only explicit primary owner confirmation can ban configured groups; repeat callback is idempotent', async () => {
  const h = harness(); await init(h); await h.db.prepare('INSERT INTO ad_groups (chat_id, created_at) VALUES (?, ?)').bind('-1002', 1).run(); worker.invalidateGroups();
  await worker.handleNewChatMembers(h.env, join()); assert.equal(of(h, 'banChatMember').length, 0); h.calls.length = 0;
  await worker.handleCallback(h.env, callback(1, 'ban')); await worker.handleCallback(h.env, callback(1, 'ban'));
  assert.deepEqual(of(h, 'banChatMember').map(c => String(c.body.chat_id)).sort(), ['-1001', '-1002']);
  assert.equal(h.rows('SELECT status FROM ad_profile_alerts')[0].status, 'confirmed'); noLearning(h);
});
test('Expired snapshots cannot act and are pruned after seven days', async () => {
  const h = harness(); await init(h); await worker.handleNewChatMembers(h.env, join());
  await h.db.prepare('UPDATE ad_profile_alerts SET created_at = ?').bind(Math.floor(Date.now() / 1000) - 8 * 86400).run(); h.calls.length = 0;
  await worker.handleCallback(h.env, callback(1, 'ban')); assert.equal(of(h, 'banChatMember').length, 0);
  await worker.pruneJoinProfileAlerts(h.env); assert.equal(h.rows('SELECT COUNT(*) AS c FROM ad_profile_alerts')[0].c, 0);
});
