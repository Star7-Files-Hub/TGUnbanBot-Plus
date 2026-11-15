// Precision/semantic learning regressions: real SQLite, synthetic text, no network/secrets.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { webcrypto } from 'node:crypto';
globalThis.crypto ||= webcrypto;
const source = await fs.readFile(new URL('./_worker.js', import.meta.url), 'utf8');
const extra = '\nexport {learnPrecisionSpam, isPrecisionPhrase, getOwnLearningText, reviewTasks, runReviewedAiTask, parsePrecisionLearningResponse};';
const w = await import('data:text/javascript;base64,' + Buffer.from(source + extra).toString('base64'));
const phrase = '高价收购实名号四件套，长期招代理';
function harness(answer = { is_ad: true, candidates: [phrase] }) {
  const db = new DatabaseSync(':memory:');
  const calls = [], ai = [];
  const env = { OWNER_ID: '999', GROUP_ID: '-1001', BOT_ID: '123',
    DB: { prepare(sql) { let args = []; return { bind(...p) { args = p; return this; },
      async first() { return db.prepare(sql).get(...args) || null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; }
    }; }, async batch(stmts) { return Promise.all(stmts.map(s => s.run())); } },
    AI: { async run(model, options) { ai.push({model, options}); if (model.includes('bge-m3')) { const seed = JSON.stringify(options?.text || options || ''); let h = 0; for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return {data:[[(h % 997) / 997, ((h >> 3) % 991) / 991, ((h >> 5) % 983) / 983]]}; } if (answer instanceof Error) throw answer; return {response: JSON.stringify(answer)}; } },
    __tgMock: Object.fromEntries(['sendMessage','banChatMember','deleteMessage','restrictChatMember','getChatAdministrators','getChatMember'].map(method => [method, async body => { calls.push({method,body}); return {ok:true,result:method === 'getChatAdministrators' ? [] : true}; }]))
  };
  w.resetSchemaState(); w.invalidateOwners(); w.invalidateGroups(); w.invalidateUserWhitelist(); w.invalidateAdminCache();
  return {env,db,calls,ai};
}
const target = (text = phrase, extras = {}) => ({from:{id:555,first_name:'普通用户',username:'ordinary_user'},text,...extras});
async function rows(h, table) { return h.db.prepare('SELECT * FROM ' + table).all(); }

test('reviewed own text becomes semantic sample, never a fingerprint', async () => {
  const h = harness(); await w.adDetectionReady(h.env);
  const r = await w.learnPrecisionSpam(h.env, target());
  assert.equal(r.learned, 1);
  assert.equal((await rows(h, 'ad_fingerprints')).length, 0);
  const samples = await rows(h, 'ad_samples');
  assert.equal(samples.length, 1);
  assert.equal(samples[0].source, 'spam_reviewed');
  assert.ok(!samples[0].sample_text.includes('ordinary_user'));
  const prompt = h.ai.find(c => !c.model.includes('bge')).options;
  assert.equal(prompt.max_tokens, 512);
  assert.ok(prompt.messages[1].content.includes(phrase));
  assert.ok(!prompt.messages[1].content.includes('ordinary_user'));
});

for (const answer of [
  {is_ad:false,candidates:[]},
  {is_ad:true,candidates:[phrase],reason:'ad'},
  {is_ad:'true',candidates:[phrase]},
  {is_ad:true,candidates:[phrase,phrase,phrase,phrase]},
  new Error('secret provider failure')
]) {
  test('rejected or erroneous reviewer creates zero learning: ' + JSON.stringify(answer), async () => {
    const h = harness(answer); await w.adDetectionReady(h.env);
    await w.learnPrecisionSpam(h.env, target());
    assert.equal((await rows(h, 'ad_fingerprints')).length, 0);
    assert.equal((await rows(h, 'ad_samples')).length, 0);
  });
}

test('own text and quoted channel text are collected as separate kinds', async () => {
  const h = harness(); await w.adDetectionReady(h.env);
  await w.learnPrecisionSpam(h.env, target('普通正文', { quote: { text: phrase } }));
  const samples = await rows(h, 'ad_samples');
  assert.equal(samples.length, 2);
  const own = samples.find(s => s.kind === 'text');
  const quote = samples.find(s => s.kind === 'quote');
  assert.ok(own && own.sample_text === '普通正文');
  assert.ok(quote && quote.sample_text === phrase);
});

test('contact card name is collected as card_name kind', async () => {
  const h = harness(); await w.adDetectionReady(h.env);
  await w.learnPrecisionSpam(h.env, target('', { contact: { first_name: '缺米的兄弟看过来哦' } }));
  const samples = await rows(h, 'ad_samples');
  assert.equal(samples.length, 1);
  assert.equal(samples[0].kind, 'card_name');
  assert.equal(samples[0].sample_text, '缺米的兄弟看过来哦');
});

test('quote and card_name samples auto-promote to keyword fingerprints at threshold', async () => {
  const h = harness(); await w.adDetectionReady(h.env);
  h.env.SEMANTIC_AUTO_FP_THRESHOLD = '2';
  await w.learnPrecisionSpam(h.env, target('正文A', { quote: { text: phrase } }));
  await w.learnPrecisionSpam(h.env, target('正文B', { quote: { text: phrase } }));
  const fps = await rows(h, 'ad_fingerprints');
  assert.ok(fps.some(f => f.value === phrase && f.status === 'confirmed' && f.type === 'keyword' && f.source === 'auto_semantic_quote'));
});

test('ad_phrase substring match requires own_body; identity/quote/keyword do not match', async () => {
  const h = harness(); await w.adDetectionReady(h.env);
  await w.learnFingerprints(h.env, [{ type: 'ad_phrase', value: phrase }], { source: 'spam_reviewed' });
  for (const type of ['name', 'username', 'keyword', 'card_name']) assert.equal((await w.matchFingerprints(h.env, [{ type, value: '前缀' + phrase + '后缀' }])).length, 0);
  assert.equal((await w.matchFingerprints(h.env, [{ type: 'own_body', value: '前缀' + phrase + '后缀' }])).length, 1);
  await h.env.DB.prepare("UPDATE ad_fingerprints SET status='retired'").run();
  assert.equal((await w.matchFingerprints(h.env, [{ type: 'own_body', value: phrase }])).length, 0);
});

test('legacy unsafe short ad_phrase row is not matched', async () => {
  const h = harness(); await w.adDetectionReady(h.env);
  await w.learnFingerprints(h.env, [{ type: 'ad_phrase', value: 'usdt' }]);
  assert.equal((await w.matchFingerprints(h.env, [{ type: 'own_body', value: 'discussion usdt' }])).length, 0);
});

test('owner spam enforcement survives review failure and action-note never reaches reviewer', async () => {
  const h = harness(new Error('review unavailable')); await w.adDetectionReady(h.env);
  await w.handleCommand(h.env, { text: '/spam ' + phrase, chat: { id: -1001, type: 'supergroup' }, from: { id: 999 }, reply_to_message: target('普通正文', { message_id: 3 }) });
  assert.equal((await rows(h, 'blacklist')).length, 1);
  assert.ok(h.calls.some(c => c.method === 'banChatMember'));
  assert.equal((await rows(h, 'ad_fingerprints')).length, 0);
  assert.equal((await rows(h, 'ad_samples')).length, 0);
  assert.ok(h.ai.every(c => !JSON.stringify(c.options).includes(phrase)));
});

test('binary judge mock cannot approve structured review', async () => {
  const h = harness({ is_ad: false, candidates: [] }); h.env.__aiJudgeMock = async () => ({ isAd: true });
  await w.adDetectionReady(h.env);
  await w.learnPrecisionSpam(h.env, target());
  assert.equal((await rows(h, 'ad_fingerprints')).length, 0);
  assert.equal(h.ai.length, 1);
});

test('automatic structure enforcement cannot re-enroll names, handles, own or quoted raw text', async () => {
  const h = harness(); await w.adDetectionReady(h.env);
  await w.detectAdOnMessage(h.env, { ...target(), message_id: 9, chat: { id: -1001, type: 'supergroup' } });
  assert.ok(h.calls.some(c => c.method === 'restrictChatMember'));
  assert.equal((await rows(h, 'ad_fingerprints')).length, 0);
  assert.equal((await rows(h, 'ad_samples')).length, 0);
});

test('structured precision review shares threshold backup routing and strict completion', async () => {
  const h = harness(); await w.adDetectionReady(h.env);
  await h.env.DB.prepare('CREATE TABLE ai_classifier_state (key TEXT PRIMARY KEY,utc_day TEXT,value TEXT,updated_at INTEGER)').run();
  await h.env.DB.prepare('INSERT INTO ai_classifier_state VALUES (?,?,?,?)').bind('cloudflare_daily', new Date().toISOString().slice(0, 10), JSON.stringify({ neurons: 9000 }), Math.floor(Date.now() / 1000)).run();
  Object.assign(h.env, { AI_API_BASE_URL: 'https://backup.invalid/v1', AI_API_TOKEN: 'TEST-NOT-REAL' });
  const prior = globalThis.fetch; let capture;
  globalThis.fetch = async (url, options) => { capture = { url, options }; return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ is_ad: true, candidates: [phrase] }) } }] }); };
  try {
    const reviewed = await w.judgeAdWithAI(h.env, phrase, 'precision_learn');
    assert.equal(reviewed.is_ad, true);
    assert.equal(h.ai.length, 0);
    assert.equal(JSON.parse(capture.options.body).max_tokens, 1024);
    assert.ok(JSON.parse(capture.options.body).messages[0].content.includes('JSON'));
    assert.equal(capture.options.redirect, 'error');
    globalThis.fetch = async () => Response.json({ choices: [{ finish_reason: 'length', message: { content: JSON.stringify({ is_ad: true, candidates: [phrase] }) } }] });
    assert.ok((await w.judgeAdWithAI(h.env, phrase, 'precision_learn')).error);
  } finally { globalThis.fetch = prior; }
});

test('CF structured truncated completion cannot enroll semantic samples', async () => {
  const h = harness(); h.env.AI.run = async () => ({ response: JSON.stringify({ is_ad: true, candidates: [phrase] }), finish_reason: 'length' });
  await w.adDetectionReady(h.env);
  await w.learnPrecisionSpam(h.env, target());
  assert.equal((await rows(h, 'ad_fingerprints')).length, 0);
  assert.equal((await rows(h, 'ad_samples')).length, 0);
});

test('ordinary sale/contact, generic trade words, names and IDs fail deterministic filter', () => {
  for (const v of ['出售二手手机，联系本人', 'USDT价格行情讨论', '高价出售联系私聊咨询', '123456789012345', 'ordinary_username']) assert.equal(w.isPrecisionPhrase(v), false);
});

test('independent evidence uses disjoint spans, never overlapping income terms', () => {
  for (const value of ['日入1234联系本人', '日入1234月入5678联系本人', '月入1234日入1234长期联系', '网赚日入1234联系本人']) assert.equal(w.isPrecisionPhrase(value), false, value);
  for (const value of ['日入1234四件套联系本人', '高价收购实名号联系本人', '长期出售USDT联系本人', '日入1234博彩招代理联系']) assert.equal(w.isPrecisionPhrase(value), true, value);
});

test('manual addword remains explicit and can store administrator-chosen keywords', async () => {
  const h = harness(); await w.adDetectionReady(h.env);
  await w.handleCommand(h.env, { text: '/addword usdt', chat: { id: 999, type: 'private' }, from: { id: 999 } });
  const fp = await rows(h, 'ad_fingerprints');
  assert.equal(fp.length, 1); assert.equal(fp[0].type, 'keyword'); assert.equal(fp[0].status, 'confirmed');
});

test('join_profile prompt is distinct conservative binary task; precision schema is closed', async () => {
  const join = w.reviewTasks('资料', 'join_profile'), msg = w.reviewTasks('正文');
  assert.notEqual(join.messages[0].content, msg.messages[0].content);
  assert.ok(join.messages[0].content.includes('无法确定必须ok'));
  assert.equal(w.parsePrecisionLearningResponse({ response: '{"is_ad":false,"candidates":[],"extra":1}' }).error, 'invalid_ai_response');
});
