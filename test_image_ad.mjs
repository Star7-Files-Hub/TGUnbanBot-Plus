// Image-ad detection regressions: synthetic image model, no real network.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const source = fs.readFileSync(new URL('./_worker.js', import.meta.url), 'utf8');
const worker = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

const GROUP = '-1001', OWNER = '999', TARGET = '555';
const phrase = '高价收购实名号四件套，长期招代理';

function harness({ imageResponse = phrase, enabled = '1' } = {}) {
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
    OWNER_ID: OWNER, GROUP_ID: GROUP, DB: db, TELEGRAM_BOT_TOKEN: 'TOKEN-NOT-REAL',
    AI: {
      async run(model, options) {
        calls.push({ method: 'AI.run', model, options });
        if (String(model).includes('bge-m3')) {
          const seed = JSON.stringify(options?.text || '');
          let h = 0; for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
          return { data: [[(h % 997) / 997, ((h >> 3) % 991) / 991, ((h >> 5) % 983) / 983]] };
        }
        return { response: imageResponse };
      },
    },
    __tgMock: Object.fromEntries(['sendMessage', 'restrictChatMember', 'banChatMember', 'deleteMessage', 'getFile'].map(method => [method, async body => {
      calls.push({ method, body });
      if (method === 'getFile') return { ok: true, result: { file_path: 'photos/ad.jpg' } };
      return { ok: true, result: true };
    }])),
  };
  return { env, sqlite, calls };
}
const photoMsg = () => ({
  message_id: 9,
  chat: { id: GROUP, type: 'supergroup', title: '测试群' },
  from: { id: TARGET, first_name: '广告号', username: 'seller', is_bot: false },
  photo: [{ file_id: 'small' }, { file_id: 'big' }],
});

test('image detection is disabled by default', async () => {
  const h = harness({ enabled: '0' });
  await worker.adDetectionReady(h.env);
  const result = await worker.detectImageAd(h.env, photoMsg());
  assert.equal(result, null);
  assert.equal(h.calls.filter(c => c.method === 'AI.run').length, 0);
});

test('image detection runs extracted text through moderation when enabled', async () => {
  const h = harness();
  await worker.adDetectionReady(h.env);
  h.sqlite.prepare("INSERT INTO bot_settings (key, value, updated_at) VALUES ('image_ad_detect', '1', 1)").run();
  const prior = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
  try {
    const result = await worker.detectImageAd(h.env, photoMsg());
    assert.equal(result.action, 'mute');
    assert.ok(h.calls.some(c => c.method === 'restrictChatMember'));
    assert.ok(h.calls.some(c => c.method === 'getFile'));
  } finally { globalThis.fetch = prior; }
});

test('images with caption skip the image model', async () => {
  const h = harness();
  await worker.adDetectionReady(h.env);
  const result = await worker.detectImageAd(h.env, { ...photoMsg(), caption: '出售账号' });
  assert.equal(result, null);
  assert.equal(h.calls.filter(c => c.method === 'AI.run').length, 0);
});
