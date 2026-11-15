// Beta-only /ad regressions. No network, credentials, or production D1 access.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';

const workerPath = new URL(process.env.WORKER_FILE || './_worker.js', import.meta.url);
const source = await fs.readFile(workerPath, 'utf8');
const worker = await import(`data:text/javascript;base64,${Buffer.from(source + '\nexport { notifyFingerprintPending, notifySpamForApproval };').toString('base64')}`);

const validCases = [
  ['ad', true], ['ok', false], [' AD\n', true], ['\tOK ', false],
  ['"ad"', true], ['"ok"', false],
  ['```\nad\n```', true], ['```text\nok\n```', false],
  ['{"verdict":"ad"}', true], ['{"verdict":"ok"}', false],
  ['```json\n{"verdict":"ad"}\n```', true],
  [{ verdict: 'ad' }, true], [{ verdict: 'ok' }, false],
];
for (const [answer, expected] of validCases) {
  test(`AI label parses exactly: ${JSON.stringify(answer)}`, async () => {
    const result = await worker.judgeAdWithAI({ AI: { run: async () => ({ response: answer }) } }, '普通测试内容');
    assert.equal(result.error, undefined);
    assert.equal(result.isAd, expected);
  });
}

const invalidCases = [
  '', ' ', 'bad', 'advertisement', 'not ad', 'ad, not ok',
  '不是正常交流，而是广告', '这不是广告', '广告', 'normal',
  '```json\n{"verdict":', '{"verdict":"maybe"}',
  '{"verdict":"ad","reason":"ok"}', '{"label":"ad"}',
  'ad\nok', '回复 ad 或 ok', { verdict: true }, [], null, undefined,
];
for (const answer of invalidCases) {
  test(`Unknown/truncated output is an error, not a normal verdict: ${JSON.stringify(answer)}`, async () => {
    const result = await worker.judgeAdWithAI({ AI: { run: async () => ({ response: answer }) } }, '测试内容');
    assert.equal(result.isAd, false);
    assert.equal(result.error, 'invalid_ai_response');
  });
}

for (const envelope of [{ result: { response: 'ad' } }, { result: 'ok' }, { response: { verdict: 'ad' } }]) {
  test(`Supported response envelope: ${JSON.stringify(envelope)}`, async () => {
    const result = await worker.judgeAdWithAI({ AI: { run: async () => envelope } }, '测试内容');
    assert.equal(result.error, undefined);
    assert.equal(result.isAd, JSON.stringify(envelope).includes('ad'));
  });
}

test('Missing AI binding is a visible error', async () => {
  assert.equal((await worker.judgeAdWithAI({}, '测试')).error, 'no_ai');
});

test('Provider errors are caught without leaking error text', async () => {
  const result = await worker.judgeAdWithAI({ AI: { run: async () => { throw new Error('secret-like-provider-detail'); } } }, '测试');
  assert.equal(result.error, 'ai_request_failed');
  assert.ok(!JSON.stringify(result).includes('secret-like-provider-detail'));
});

test('AI request honors a configured model and uses deterministic constrained labels', async () => {
  let captured;
  await worker.judgeAdWithAI({ AD_JUDGE_MODEL: 'explicit-test-model', AI: { run: async (model, options) => {
    captured = { model, options };
    return { response: 'ad' };
  } } }, '广告文本');
  assert.equal(captured.model, 'explicit-test-model');
  assert.equal(captured.options.temperature, 0);
  assert.ok(captured.options.max_tokens >= 8 && captured.options.max_tokens <= 64);
  assert.ok(captured.options.messages[0].content.includes('引用'));
  assert.ok(captured.options.messages[0].content.includes('指令'));
  assert.ok(captured.options.messages[1].content.includes('广告文本'));
});

test('Retired Qwen model is not the default', async () => {
  let model;
  await worker.judgeAdWithAI({ AI: { run: async (id) => { model = id; return { response: 'ok' }; } } }, '测试');
  assert.notEqual(model, '@cf/qwen/qwen1.5-7b-chat-awq');
});

function makeHarness(response = 'ok', { primary = '999', deputies = ['998'], aiError = false } = {}) {
  const calls = [];
  const queries = [];
  const aiCalls = [];
  const env = {
    OWNER_ID: primary, GROUP_ID: '-1001', WEBHOOK_SECRET: 'test-only-secret',
    DB: {
      async batch() { return []; },
      prepare(sql) {
        queries.push(sql);
        const statement = {
          bind() { return statement; },
          async all() {
            if (sql.includes('SELECT user_id FROM ad_owners')) return { results: deputies.map(user_id => ({ user_id })) };
            if (sql.includes('SELECT chat_id FROM ad_groups')) return { results: [] };
            return { results: [] };
          },
          async first() { return null; },
          async run() { return { meta: { changes: 1 } }; },
        };
        return statement;
      },
    },
    AI: { async run(model, options) {
      aiCalls.push({ model, options });
      if (aiError) throw new Error('upstream failure');
      return { response };
    } },
    __tgMock: Object.fromEntries(['sendMessage', 'restrictChatMember', 'banChatMember', 'deleteMessage'].map(method => [method, async body => {
      calls.push({ method, body });
      return { ok: true, result: { message_id: 100 } };
    }])),
  };
  worker.resetSchemaState();
  worker.invalidateOwners();
  worker.invalidateGroups();
  worker.invalidateUserWhitelist();
  return { env, calls, queries, aiCalls };
}

function report(fromId = 998, replied = {}) {
  return {
    message_id: 1, text: '/ad',
    chat: { id: -1001, type: 'supergroup', title: '测试群' },
    from: { id: fromId, is_bot: false, first_name: '举报者' },
    reply_to_message: { message_id: 2, from: { id: 555, is_bot: false, first_name: '被举报者' }, text: '测试正文', ...replied },
  };
}

for (const reporter of [999, 998, 777]) {
  test(`Public /ad classifies for primary, secondary, and ordinary reporter: ${reporter}`, async () => {
    const h = makeHarness('ok');
    await worker.handleUpdate(h.env, { message: report(reporter) });
    assert.equal(h.aiCalls.length, 1);
    assert.ok(h.calls.some(c => c.method === 'sendMessage' && c.body.chat_id === -1001 && c.body.text.includes('不是广告')));
    assert.ok(!h.calls.some(c => ['restrictChatMember', 'banChatMember', 'deleteMessage'].includes(c.method)));
  });
}

test('Deputy ad label acts on the reported user, not the reporter; no all-group blacklist/learning', async () => {
  const h = makeHarness('ad');
  await worker.handleUpdate(h.env, { message: report(998) });
  const mutations = h.calls.filter(c => ['restrictChatMember', 'banChatMember'].includes(c.method));
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].body.user_id, '555');
  assert.equal(mutations[0].body.chat_id, -1001);
  assert.ok(h.calls.some(c => c.method === 'deleteMessage' && c.body.message_id === 2));
  assert.ok(!h.queries.some(sql => /INSERT.+(?:blacklist|ad_fingerprints|ad_samples)/is.test(sql)));
});

for (const bad of ['', 'bad', '这不是正常交流而是广告']) {
  test(`Malformed AI output gets failure feedback without a false non-ad report: ${JSON.stringify(bad)}`, async () => {
    const h = makeHarness(bad);
    await worker.handleUpdate(h.env, { message: report(998) });
    assert.ok(h.calls.some(c => c.method === 'sendMessage' && c.body.chat_id === -1001 && c.body.text.includes('AI 判定失败')));
    assert.equal(h.calls.filter(c => c.method === 'sendMessage').length, 1);
    assert.ok(!h.calls.some(c => ['restrictChatMember', 'banChatMember', 'deleteMessage'].includes(c.method)));
    assert.ok(!h.calls.some(c => c.body.text?.includes('不是广告')));
  });
}

test('Thrown AI error gets group feedback instead of disappearing behind HTTP 200', async () => {
  const h = makeHarness('ok', { aiError: true });
  const response = await worker.default.fetch(new Request('https://beta.test/', {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'test-only-secret' },
    body: JSON.stringify({ message: report(998) }),
  }), h.env);
  assert.equal(response.status, 200);
  assert.ok(h.calls.some(c => c.body.text?.includes('AI 判定失败')));
  assert.ok(!h.calls.some(c => ['restrictChatMember', 'banChatMember', 'deleteMessage'].includes(c.method)));
});

for (const [label, replied] of [
  ['Telegram quote', { text: 'c', quote: { text: '收U秒结 联系 @seller' } }],
  ['external reply', { text: 'v', external_reply: { caption: '收U秒结 联系 @seller' } }],
  ['nested reply', { text: 'x', reply_to_message: { text: '收U秒结 联系 @seller' } }],
  ['quoted-only', { text: '', quote: { text: '收U秒结 联系 @seller' } }],
  ['contact card', { text: '', contact: { first_name: '收U秒结', last_name: '联系 @seller' } }],
]) {
  test(`Reported content reaches AI: ${label}`, async () => {
    const h = makeHarness('ok');
    await worker.handleUpdate(h.env, { message: report(998, replied) });
    assert.equal(h.aiCalls.length, 1);
    const input = h.aiCalls[0].options.messages[1].content;
    assert.ok(input.includes('收U秒结'));
    assert.ok(!input.includes('/ad'));
  });
}

test('Quoted-ad warning stays context-separated; a returned ok never moderates the target', async () => {
  const h = makeHarness('ok');
  await worker.handleUpdate(h.env, { message: report(998, { text: '这是骗子，大家不要相信', quote: { text: '收U秒结 联系 @seller' } }) });
  const input = h.aiCalls[0].options.messages[1].content;
  assert.ok(input.includes('这是骗子'));
  assert.ok(input.includes('引用内容'));
  assert.ok(!h.calls.some(c => ['restrictChatMember', 'banChatMember', 'deleteMessage'].includes(c.method)));
});

test('Long own text does not erase the quoted payload from the request', async () => {
  const h = makeHarness('ok');
  await worker.handleUpdate(h.env, { message: report(998, { text: '长'.repeat(3000), quote: { text: '收U秒结' } }) });
  assert.ok(h.aiCalls[0].options.messages[1].content.includes('收U秒结'));
});

for (const [label, change] of [
  ['private use', message => { message.chat = { id: 998, type: 'private' }; }],
  ['no reply', message => { delete message.reply_to_message; }],
  ['no body or quote', message => { message.reply_to_message.text = ''; }],
]) {
  test(`Pre-existing source precondition retained: ${label}`, async () => {
    const h = makeHarness('ad');
    const message = report(998);
    change(message);
    await worker.handleUpdate(h.env, { message });
    assert.equal(h.aiCalls.length, 0);
    assert.ok(!h.calls.some(c => ['restrictChatMember', 'banChatMember', 'deleteMessage'].includes(c.method)));
  });
}

for (const verdict of ['ad', 'ok']) {
  test(`Deputy /ad review report goes only to primary owner: ${verdict}`, async () => {
    const h = makeHarness(verdict, { deputies: ['998', '997'] });
    await worker.handleUpdate(h.env, { message: report(998) });
    const privateSends = h.calls.filter(c => c.method === 'sendMessage' && Number(c.body.chat_id) > 0);
    assert.deepEqual(privateSends.map(c => String(c.body.chat_id)), ['999']);
    assert.ok(h.calls.some(c => c.method === 'sendMessage' && String(c.body.chat_id) === '-1001'));
  });
}
for (const kind of ['fingerprint', 'spam']) {
  test(`Confirmation notice targets only primary owner: ${kind}`, async () => {
    const h = makeHarness();
    const config = { primaryOwner: '999', ownerIds: new Set(['999', '998', '997']) };
    if (kind === 'fingerprint') {
      await worker.notifyFingerprintPending(h.env, config, '555', { id: -1001, title: '测试群' }, { id: 1, type: 'keyword', value: '测试词' });
    } else {
      await worker.notifySpamForApproval(h.env, config, { id: -1001, title: '测试群' }, '555', '测试内容', '998');
    }
    assert.deepEqual(h.calls.map(c => String(c.body.chat_id)), ['999']);
    assert.ok(h.calls[0].body.reply_markup.inline_keyboard.length > 0);
  });
}
test('Missing primary owner never falls back to deputies', async () => {
  const h = makeHarness();
  await worker.notifyAdReport(h.env, { primaryOwner: '', ownerIds: new Set(['998']) }, { id: -1001 }, '998', '555', '测试者', '测试内容', true);
  assert.equal(h.calls.length, 0);
});

test('Telegram webhook authentication is unchanged', async () => {
  const h = makeHarness('ad');
  const response = await worker.default.fetch(new Request('https://beta.test/', { method: 'POST', body: JSON.stringify({ message: report(998) }) }), h.env);
  assert.equal(response.status, 401);
  assert.equal(h.aiCalls.length, 0);
  assert.equal(h.calls.length, 0);
});
