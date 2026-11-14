// Beta-only group receipt lifecycle regressions. All timers and Telegram calls are fake.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('./_worker.js', import.meta.url), 'utf8');
function harness({ verdict = 'ok', sendResult, deleteThrows = false, deleteRejects = false } = {}) {
  const calls = [], timers = [], tasks = [], warnings = [];
  let now = 0, nextId = 100;
  const sandbox = {
    Request, Response, URL, TextEncoder, TextDecoder, atob, btoa,
    console: { log() {}, error() {}, warn(...args) { warnings.push(args.join(' ')); } },
    setTimeout(callback, delay) { timers.push({ callback, at: now + delay, delay }); return timers.length; },
    fetch() { throw new Error('Unexpected network access'); },
  };
  vm.createContext(sandbox);
  const compiled = source.replace('export default', 'const worker_default =').replace('export {', 'globalThis.worker = { default: worker_default,');
  vm.runInContext(compiled + '\nglobalThis.receipt = sendGroupReceipt;', sandbox);
  const worker = sandbox.worker;
  const ctx = { waitUntil(promise) { tasks.push(promise); } };
  const env = {
    OWNER_ID: '999', GROUP_ID: '-1001', WEBHOOK_SECRET: 'test-only',
    DB: {
      async batch() { return []; },
      prepare(sql) {
        const stmt = {
          bind() { return stmt; },
          async run() { return { meta: { changes: 1 } }; },
          async first() { return null; },
          async all() {
            return { results: sql.includes('SELECT user_id FROM ad_owners') ? [{ user_id: '998' }] : [] };
          },
        };
        return stmt;
      },
    },
    AI: { async run() { return { response: verdict }; } },
    __tgMock: Object.fromEntries(['sendMessage', 'deleteMessage', 'restrictChatMember', 'banChatMember', 'unbanChatMember'].map(method => [method, async body => {
      calls.push({ method, body });
      if (method === 'sendMessage') return sendResult === undefined ? { ok: true, result: { message_id: nextId++ } } : sendResult;
      if (method === 'deleteMessage' && deleteThrows) throw new Error('SECRET-PROVIDER-ERROR');
      if (method === 'deleteMessage' && deleteRejects) return { ok: false, description: 'SECRET-PROVIDER-ERROR' };
      return { ok: true, result: true };
    }])),
  };
  function advance(ms) {
    now += ms;
    for (const timer of [...timers]) {
      if (timer.at <= now) { timers.splice(timers.indexOf(timer), 1); timer.callback(); }
    }
  }
  return { env, worker, receipt: sandbox.receipt, ctx, calls, timers, tasks, warnings, advance };
}
function message(text = '/ad', type = 'supergroup', from = 777) {
  return {
    message_id: 1, text,
    from: { id: from, is_bot: false, first_name: 'Reporter' },
    chat: { id: type === 'private' ? from : -1001, type, title: 'Test group' },
    reply_to_message: { message_id: 2, text: 'Test body', from: { id: 555, is_bot: false, first_name: 'Target' } },
  };
}
async function throughFetch(h, msg, ctx = h.ctx) {
  return h.worker.default.fetch(new Request('https://beta.example/', {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'test-only' },
    body: JSON.stringify({ message: msg }),
  }), h.env, ctx);
}
const sends = h => h.calls.filter(c => c.method === 'sendMessage');
const deletes = h => h.calls.filter(c => c.method === 'deleteMessage');

for (const type of ['group', 'supergroup']) {
  for (const verdict of ['ad', 'ok']) {
    test(`/ad ${type} ${verdict}: public receipt lasts 8s, owner DM remains`, async () => {
      const h = harness({ verdict });
      const res = await throughFetch(h, message('/ad@TestBot', type));
      assert.equal(res.status, 200);
      const publicReceipt = sends(h).find(c => c.body.chat_id === -1001);
      const ownerDM = sends(h).find(c => String(c.body.chat_id) === '999');
      assert.ok(publicReceipt && ownerDM);
      assert.equal(sends(h).filter(c => Number(c.body.chat_id) > 0).length, 1, 'no deputy notification');
      assert.equal(h.tasks.length, 1, 'ctx propagated from fetch through update/command');
      assert.equal(h.timers.length, 1);
      assert.equal(h.timers[0].delay, 8000);
      assert.ok(!deletes(h).some(c => c.body.message_id === 101));
      h.advance(7999);
      await Promise.resolve();
      assert.ok(!deletes(h).some(c => c.body.message_id === 101));
      h.advance(1);
      await Promise.all(h.tasks);
      const receiptDeletes = deletes(h).filter(c => c.body.message_id === 101);
      assert.equal(receiptDeletes.length, 1);
      assert.equal(receiptDeletes[0].body.chat_id, -1001);
      assert.ok(!deletes(h).some(c => String(c.body.chat_id) === '999'), 'owner review card remains');
      assert.equal(h.timers.length, 0);
    });
  }
}
for (const reporter of [999, 998, 777]) {
  test(`/ad remains public for reporter ${reporter}`, async () => {
    const h = harness();
    await throughFetch(h, message('/ad', 'supergroup', reporter));
    assert.ok(sends(h).some(c => c.body.chat_id === -1001 && c.body.text.includes('不是广告')));
    assert.equal(h.tasks.length, 1);
    h.advance(8000);
    await Promise.all(h.tasks);
  });
}
for (const type of ['group', 'supergroup', 'private']) {
  test(`/unban success expiry applies only to groups: ${type}`, async () => {
    const h = harness();
    await throughFetch(h, message('/unban 555', type, 998));
    assert.ok(sends(h).some(c => c.body.text.includes('已解除黑名单') && c.body.text.includes('已解封 1 个群')));
    assert.equal(h.tasks.length, type === 'private' ? 0 : 1);
    assert.equal(h.timers.length, type === 'private' ? 0 : 1);
    assert.equal(deletes(h).length, 0);
    h.advance(8000);
    await Promise.all(h.tasks);
    assert.equal(deletes(h).length, type === 'private' ? 0 : 1);
    if (type !== 'private') assert.equal(deletes(h)[0].body.message_id, 100);
  });
}
for (const [label, result] of [
  ['Telegram send rejected', { ok: false, result: { message_id: 100 } }],
  ['missing message id', { ok: true, result: {} }],
  ['zero message id', { ok: true, result: { message_id: 0 } }],
]) {
  test(`No cleanup task for ${label}`, async () => {
    const h = harness({ sendResult: result });
    await h.receipt(h.env, { id: -1001, type: 'group' }, 'Receipt', h.ctx);
    assert.equal(h.tasks.length, 0);
    assert.equal(h.timers.length, 0);
    assert.equal(deletes(h).length, 0);
  });
}
test('Missing ctx preserves exported call compatibility without a loose timer', async () => {
  const h = harness();
  await h.worker.handleUpdate(h.env, { message: message('/ad') });
  assert.ok(sends(h).some(c => c.body.chat_id === -1001));
  assert.equal(h.timers.length, 0);
  assert.equal(h.tasks.length, 0);
});
for (const options of [{ deleteThrows: true }, { deleteRejects: true }]) {
  test(`Cleanup failures settle safely without provider secrets: ${JSON.stringify(options)}`, async () => {
    const h = harness(options);
    await h.receipt(h.env, { id: -1001, type: 'group' }, 'Receipt', h.ctx);
    h.advance(8000);
    await Promise.all(h.tasks);
    assert.equal(h.warnings.length, 1);
    assert.ok(!h.warnings.join().includes('SECRET-PROVIDER-ERROR'));
  });
}
for (const [label, msg, verdict] of [
  ['AI failure', message('/ad'), 'unrecognized'],
  ['usage hint', { ...message('/ad'), reply_to_message: undefined }, 'ok'],
  ['unauthorized unban', message('/unban 555'), 'ok'],
]) {
  test(`Non-final or denied feedback remains unchanged: ${label}`, async () => {
    const h = harness({ verdict });
    await throughFetch(h, msg);
    assert.equal(h.tasks.length, 0);
    assert.equal(h.timers.length, 0);
    assert.equal(deletes(h).length, 0);
  });
}
