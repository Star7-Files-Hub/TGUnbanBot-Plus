// Execute the actual delivered panel script with a minimal DOM; no browser/network dependencies.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./_worker.js', import.meta.url), 'utf8');
const worker = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const html = await (await worker.default.fetch(new Request('https://panel.invalid/'), {})).text();
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script);
class Element {
  constructor() { this.children = []; this.attributes = {}; this.style = {}; this.value = ''; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text || ''; }
  appendChild(child) { this.children.push(child); }
  setAttribute(key, value) { this.attributes[key] = value; }
}
function harness(fetchImpl) {
  const nodes = new Map(Array.from(html.matchAll(/id="([^"]+)"/g), match => [match[1], new Element()]));
  const calls = [];
  const pending = [];
  const context = vm.createContext({
    document: {
      getElementById(id) { assert.ok(nodes.has(id), 'HTML must declare ' + id); return nodes.get(id); },
      createElement() { return new Element(); },
    },
    async fetch(path) {
      calls.push(path);
      const promise = Promise.resolve(fetchImpl(path));
      pending.push(promise);
      return promise;
    },
  });
  vm.runInContext(script, context);
  return {
    nodes, context, calls,
    async flush() { await Promise.all(pending); await new Promise(resolve => setImmediate(resolve)); },
  };
}
const fp = { value: '群发推广', type: 'keyword', status: 'confirmed', hit_count: 4, source: 'manual' };
const sample = { id: 42, sample_text: '<img src=x onerror=alert(1)>广告样本', kind: 'card_name', count: 2, source: 'manual' };
function fixture(path) {
  const url = new URL(path, 'https://panel.invalid');
  assert.equal(url.searchParams.get('limit'), '20');
  const samples = url.pathname === '/api/samples';
  return Response.json({ ok: true, total: samples ? 21 : 1, items: [samples ? sample : url.pathname === '/api/fingerprints' ? fp : { user_id: '123', reason: 'spam', created_at: 1 }] });
}
test('panel loads blacklist from its correct URL and exposes a semantic-library tab', async () => {
  const h = harness(fixture); await h.flush();
  assert.ok(h.calls.includes('/api/blacklist?limit=20&offset=0'));
  assert.ok(h.calls.includes('/api/fingerprints?limit=20&offset=0'));
  assert.equal(h.nodes.get('bl-tbody').children[0].children[0].textContent, '123');
  assert.match(html, /grid-template-columns:1fr 1fr/);
  assert.match(html, /role="tab"[^>]*.*AI 语义库/);
});
test('semantic tab loads samples, renders text safely, paginates 20, and resets on switching', async () => {
  const h = harness(fixture); await h.flush();
  await h.context.switchLibrary('samples');
  assert.equal(h.calls.at(-1), '/api/samples?limit=20&offset=0');
  assert.equal(h.nodes.get('library-title').textContent, 'AI 语义库');
  assert.equal(h.nodes.get('library-samples').attributes['aria-selected'], 'true');
  const cells = h.nodes.get('fp-tbody').children[0].children;
  assert.equal(cells[0].textContent, sample.sample_text);
  assert.equal(cells[0].title, sample.sample_text);
  assert.equal(cells[1].textContent, 'card_name');
  assert.equal(cells[2].textContent, '42');
  assert.equal(cells[3].textContent, '2');
  assert.equal(h.nodes.get('fp-next').disabled, false);
  h.context.move('fp', 1); await h.flush();
  assert.equal(h.calls.at(-1), '/api/samples?limit=20&offset=20');
  assert.equal(h.nodes.get('fp-next').disabled, true);
  await h.context.switchLibrary('fingerprints');
  assert.equal(h.calls.at(-1), '/api/fingerprints?limit=20&offset=0');
  assert.equal(h.nodes.get('fp-tbody').children[0].children[0].textContent, fp.value);
});
test('a delayed fingerprint response cannot overwrite the semantic tab', async () => {
  let resolveFingerprint;
  const h = harness(path => path.startsWith('/api/fingerprints')
    ? new Promise(resolve => { resolveFingerprint = resolve; }) : fixture(path));
  await h.context.switchLibrary('samples');
  resolveFingerprint(Response.json({ ok: true, total: 1, items: [fp] }));
  await h.flush();
  assert.equal(h.nodes.get('fp-tbody').children.length, 1);
  assert.equal(h.nodes.get('fp-tbody').children[0].children[0].textContent, sample.sample_text);
  assert.equal(h.nodes.get('library-title').textContent, 'AI 语义库');
});
