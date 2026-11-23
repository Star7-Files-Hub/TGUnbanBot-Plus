// Pure-template and actual delivered-script regressions. No browser/network/credentials.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { ADMIN_HTML, LOGIN_HTML, ADMIN_HEADERS, CSP_NONCE_PLACEHOLDER } from './admin-page.mjs';

const SCRIPT = ADMIN_HTML.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)?.[1];
const CSS = ADMIN_HTML.match(/<style\b[^>]*>([\s\S]*?)<\/style>/)?.[1];
assert.ok(SCRIPT); assert.ok(CSS);
const cssRule = (selector, source = CSS) => {
  const rule = [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(match => match[1].trim().split(',').includes(selector));
  assert.ok(rule, 'Delivered CSS selector: ' + selector);
  return rule[2];
};
const IDS = [...ADMIN_HTML.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
const PASSWORD_FIELD = 'pass' + 'word';

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.listeners = new Map();
    this.disabled = false;
    this.checked = false;
    this.hidden = false;
    this.value = '';
  }
  set innerHTML(_) { throw new Error('Untrusted API content must never use HTML assignment'); }
  get innerHTML() { throw new Error('DOM rendering must not use innerHTML'); }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text || ''; }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, fn) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(fn); this.listeners.set(name, listeners);
  }
  async emit(name) {
    const event = { preventDefault() { this.prevented = true; }, target: this };
    await Promise.all((this.listeners.get(name) || []).map(fn => fn(event)));
    return event;
  }
}
const text = node => [node.textContent, ...node.children.map(text)].filter(Boolean).join(' ');
const childrenOfTag = (node, tag) => [node, ...node.children.flatMap(child => childrenOfTag(child, tag))].filter(item => item.tagName === tag.toUpperCase());
const state = () => ({
  paused: false, reason: null, mode: 'balanced', threshold: 0.8,
  utcDay: '2026-11-22', version: 'dictionary-v4',
  accounts: [
    { alias: 'CF77', enabled: true, rowsRead: 1200000, rowsWritten: 41000, readLimit: 5000000, writeLimit: 100000, percent: 0.41, day: '2026-11-22', observedAt: 1795303200000, fresh: true, eligible: true, cooldownUntil: null, cooldown: false, error: null },
    { alias: '7Star', enabled: false, rowsRead: 4050000, rowsWritten: 99000, readLimit: 5000000, writeLimit: 100000, percent: 0.99, day: '2026-11-22', observedAt: 1795303200000, fresh: false, eligible: false, cooldownUntil: 1795303500000, error: 'usage_over_threshold' },
  ],
  queue: { pending: 12, reviews: 3, uncertain: 2 },
});
const fourAccountState = () => {
  const data = state();
  data.accounts = [
    { ...data.accounts[0], alias: '1536267368', priority: 0 },
    { ...data.accounts[0], alias: 'KF', priority: 0, rowsRead: null, rowsWritten: null, percent: null, observedAt: null, fresh: null, eligible: null, error: '读取快照失败；请手动刷新确认。' },
    { ...data.accounts[0], alias: '7Star', priority: 1 },
    { ...data.accounts[1], alias: 'CF77', priority: 2 },
  ];
  return data;
};
const copy = value => JSON.parse(JSON.stringify(value));
function harness({ data = state(), fetchImpl, confirm = true, reviews = [] } = {}) {
  const nodes = new Map(IDS.map(id => [id, new Element()]));
  const calls = [], redirects = [], confirmations = [];
  let current = copy(data);
  const context = vm.createContext({
    document: {
      getElementById(id) { assert.ok(nodes.has(id), 'Declared DOM ID: ' + id); return nodes.get(id); },
      createElement(tag) { return new Element(tag); },
    },
    window: {
      location: { assign(path) { redirects.push(path); } },
      confirm(message) { confirmations.push(message); return confirm; },
    },
    fetch: async (path, options = {}) => {
      calls.push({ path, options });
      if (fetchImpl) return fetchImpl(path, options, current);
      if (path === '/api/admin/state') return Response.json({ ok: true, data: current });
      if (path === '/api/admin/reviews') return Response.json({ ok: true, items: reviews, total: reviews.length });
      if (path === '/api/admin/control/resolve') {
        const input = JSON.parse(options.body);
        current.queue.uncertain = Math.max(0, current.queue.uncertain - 1);
        const entry = reviews.find(item => item.id === input.id);
        if (entry && input.action === 'dismiss') entry.status = 'dismissed';
      }
      if (path === '/logout') return new Response(null, { status: 204 });
      if (path === '/api/admin/control/config') {
        const input = JSON.parse(options.body);
        current = { ...current, mode: input.mode, threshold: input.threshold, accounts: current.accounts.map(account => ({ ...account, enabled: input.accounts.find(item => item.alias === account.alias)?.enabled })) };
      }
      if (path === '/api/admin/control/pause') current.paused = true;
      if (path === '/api/admin/control/resume') current.paused = false;
      return Response.json({ ok: true });
    },
    setTimeout() { throw new Error('No timers or hidden automatic polling'); },
    setInterval() { throw new Error('No hidden automatic polling'); },
  });
  vm.runInContext(SCRIPT, context);
  const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
  return { nodes, calls, redirects, confirmations, settle, async click(id) { await nodes.get(id).emit('click'); await settle(); }, async submit() { await nodes.get('config-form').emit('submit'); await settle(); } };
}

test('templates export pure strings with a same-response nonce contract and no credentials in storage', () => {
  assert.equal(typeof ADMIN_HTML, 'string'); assert.equal(typeof LOGIN_HTML, 'string');
  assert.match(ADMIN_HTML, /<html lang="zh-CN">/);
  assert.match(ADMIN_HTML, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(ADMIN_HTML, /@media\(max-width:720px\)/);
  assert.match(ADMIN_HTML, /threshold[\s\S]*max="80"/);
  assert.ok(ADMIN_HTML.includes(CSP_NONCE_PLACEHOLDER));
  assert.ok(LOGIN_HTML.includes(CSP_NONCE_PLACEHOLDER));
  assert.ok(ADMIN_HEADERS['Content-Security-Policy'].includes("script-src 'nonce-" + CSP_NONCE_PLACEHOLDER + "'"));
  assert.equal(ADMIN_HEADERS['Cache-Control'], 'no-store');
  assert.match(ADMIN_HEADERS['Content-Security-Policy'], /form-action 'self'/);
  assert.match(ADMIN_HEADERS['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.doesNotMatch(SCRIPT, /localStorage|sessionStorage|document\.cookie|innerHTML|outerHTML|insertAdjacentHTML|eval\(/);
  assert.doesNotMatch(ADMIN_HTML + LOGIN_HTML, /CLOUDFLARE_API_TOKEN|TELEGRAM_BOT_TOKEN|OBSERVE_INGEST_TOKEN|AI_API_TOKEN/);
  assert.equal(new Set(IDS).size, IDS.length, 'No duplicate IDs');
});
// This DOM has no layout engine. Test the delivered CSS cascade contract, not fictitious pixel heights.
test('four-card grid stretches equal desktop rows and overrides adjacent-panel margins with higher specificity', () => {
  const grid = cssRule('.grid');
  assert.match(grid, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(grid, /grid-auto-rows:1fr/);
  assert.match(grid, /align-items:stretch/);
  assert.match(cssRule('.panel+.panel'), /margin-top:18px/);
  assert.match(cssRule('.grid>.panel'), /margin-block:0/);
  assert.match(cssRule('.grid>.panel.account-card'), /margin-block:0/);
  const specificity = selector => (selector.match(/\.[\w-]+/g) || []).length;
  assert.ok(specificity('.grid>.panel.account-card') > specificity('.panel+.panel'), 'The account override wins even if the sibling rule is moved later');
  assert.match(cssRule('.account-card'), /display:flex;flex-direction:column;min-width:0/);
  assert.match(cssRule('.account-card>*'), /flex-shrink:0/);
  assert.match(cssRule('.account-card .details'), /flex-grow:1;align-content:start;min-height:/);
  assert.match(cssRule('.account-error-slot'), /min-height:/);
  const mobile = CSS.slice(CSS.indexOf('@media(max-width:720px)'));
  assert.match(cssRule('.grid', mobile), /grid-template-columns:1fr;grid-auto-rows:auto/);
  for (const selector of ['.account-card', '.account-card>*', '.account-card .details', '.account-error-slot', '.account-error', '.account-title']) {
    assert.doesNotMatch(cssRule(selector), /(?:^|;)\s*(?:height|max-height)\s*:|overflow(?:-x|-y)?\s*:\s*(?:hidden|clip)|line-clamp|text-overflow/, selector + ' must grow with its content');
  }
});
test('long aliases, status badges and usage headings wrap without clipping or fixed card height', () => {
  assert.match(cssRule('.account-top'), /align-items:flex-start/);
  assert.match(cssRule('.account-top'), /flex-wrap:wrap/);
  assert.match(cssRule('.account-title'), /min-width:0/);
  assert.match(cssRule('.account-title'), /overflow-wrap:anywhere/);
  assert.match(cssRule('.toggle-label'), /flex:0 0 auto/);
  assert.match(cssRule('.account-badges'), /flex-wrap:wrap/);
  assert.match(cssRule('.account-badges'), /align-content:flex-start;min-height:/);
  assert.match(cssRule('.usage-heading'), /align-items:baseline/);
  assert.match(cssRule('.usage-heading'), /flex-wrap:wrap/);
  assert.match(cssRule('.details dd'), /overflow-wrap:anywhere/);
  assert.match(cssRule('.account-error'), /overflow-wrap:anywhere/);
});
test('account-pool scheduling copy describes priority and source usage without hardcoded two-account scope', () => {
  assert.match(ADMIN_HTML, /账号池内各账号独立计算 D1/);
  assert.doesNotMatch(ADMIN_HTML, /CF77 与 7Star/);
  assert.match(ADMIN_HTML, /优先使用[^<]*非主控观察账号；相同优先级内按用量选择/);
  assert.match(ADMIN_HTML, /相同优先级内按既定顺序故障转移/);
  assert.match(ADMIN_HTML, /不代表主控或源账号零用量[^<]*源数据写回仍可能占用额度/);
});
test('login is a native same-origin form with a real password field and no script', () => {
  assert.match(LOGIN_HTML, /<form method="post" action="\/login" enctype="application\/x-www-form-urlencoded">/);
  assert.ok(LOGIN_HTML.includes('name="' + PASSWORD_FIELD + '"'));
  assert.ok(LOGIN_HTML.includes('type="' + PASSWORD_FIELD + '"'));
  assert.ok(LOGIN_HTML.includes('autocomplete="current-' + PASSWORD_FIELD + '"'));
  assert.match(LOGIN_HTML, /<input type="hidden" name="csrf" value="__LOGIN_CSRF__">/);
  const passwordInput = LOGIN_HTML.match(new RegExp('<input[^>]*name="' + PASSWORD_FIELD + '"[^>]*>'))?.[0];
  assert.ok(passwordInput); assert.doesNotMatch(passwordInput, /value=/);
  assert.doesNotMatch(LOGIN_HTML, /<script|\/api\/|localStorage/);
  assert.equal(ADMIN_HEADERS['Referrer-Policy'], 'same-origin');
});
test('initial state fetch uses same-origin cookies, shows individual read/write percentages and counts', async () => {
  const h = harness(); await h.settle();
  assert.deepEqual(h.calls.map(call => call.path), ['/api/admin/state']);
  assert.equal(h.calls[0].options.credentials, 'same-origin');
  assert.equal(h.calls[0].options.cache, 'no-store');
  assert.equal(h.nodes.get('task-status').textContent, '允许观察');
  const cards = h.nodes.get('accounts').children;
  assert.equal(cards.length, 2);
  assert.match(text(cards[0]), /CF77[\s\S]*24\.0%[\s\S]*41\.0%/);
  assert.match(text(cards[0]), /1,200,000 \/ 5,000,000 行/);
  assert.match(text(cards[1]), /81\.0%[\s\S]*99\.0%/);
  assert.match(text(cards[1]), /80% 自动暂停[\s\S]*不可调度[\s\S]*快照过期[\s\S]*usage_over_threshold/);
  assert.match(text(cards[0]), /新鲜快照[\s\S]*未冷却/);
  assert.equal(h.nodes.get('queue-pending').textContent, '12');
  assert.equal(h.nodes.get('queue-reviews').textContent, '3');
  assert.equal(h.nodes.get('queue-uncertain').textContent, '2');
  assert.match(h.nodes.get('progress').textContent, /不自动轮询/);
  assert.equal(h.nodes.get('pause').disabled, false);
  assert.equal(h.nodes.get('resume').disabled, true);
});
test('four account cards keep complete controls, priority labels, read/write status and error placeholders', async () => {
  const data = fourAccountState();
  const h = harness({ data }); await h.settle();
  const cards = h.nodes.get('accounts').children;
  assert.equal(cards.length, 4);
  assert.deepEqual(cards.map(card => card.className), Array(4).fill('panel account-card'));
  assert.deepEqual(cards.map(card => childrenOfTag(card, 'h3')[0].textContent), data.accounts.map(account => account.alias));
  assert.deepEqual(cards.map(card => card.attributes['aria-label']), data.accounts.map(account => account.alias + '用量'));
  assert.deepEqual(cards.map(card => text(card.children.find(child => child.className === 'account-badges'))), [
    '优先观察 80% 自动暂停 综合占用 41.0% 可调度',
    '优先观察 80% 自动暂停 综合占用未知 资格未知',
    '主控备用 80% 自动暂停 综合占用 41.0% 可调度',
    '主机器人兜底 80% 自动暂停 综合占用 99.0% 不可调度',
  ]);
  const toggles = childrenOfTag(h.nodes.get('accounts'), 'input');
  assert.equal(toggles.length, 4);
  assert.deepEqual(toggles.map(input => input.attributes['aria-label']), data.accounts.map(account => '启用账号 ' + account.alias));
  assert.deepEqual(toggles.map(input => input.checked), data.accounts.map(account => account.enabled));
  assert.ok(toggles.every(input => input.type === 'checkbox' && !input.disabled));
  for (const card of cards) {
    assert.equal(childrenOfTag(card, 'progress').length, 2);
    assert.equal(childrenOfTag(card, 'dt').length, 4);
    assert.equal(childrenOfTag(card, 'dd').length, 4);
    const slot = card.children.find(child => child.className === 'account-error-slot');
    assert.ok(slot && !slot.hidden, 'Every card reserves a visible, content-growing error area');
  }
  assert.equal(cards[0].children.at(-1).children.length, 0);
  assert.equal(cards[2].children.at(-1).children.length, 0);
  assert.match(text(cards[1]), /读取[\s\S]*未知[\s\S]*写入[\s\S]*未知[\s\S]*读取快照失败/);
  assert.match(text(cards[3]), /81\.0%[\s\S]*99\.0%[\s\S]*快照过期[\s\S]*usage_over_threshold/);
  assert.equal(cards[1].children.at(-1).children[0].hidden, false);
});
test('priority badges follow numeric server fields only, never guessed from an account alias', async () => {
  const data = fourAccountState();
  data.accounts[0].priority = 2; data.accounts[1].priority = 1;
  data.accounts[2].priority = 0; delete data.accounts[3].priority;
  const h = harness({ data }); await h.settle();
  const priority = card => text(card.children.find(child => child.className === 'account-badges')).match(/优先观察|主控备用|主机器人兜底/)?.[0];
  assert.deepEqual(h.nodes.get('accounts').children.map(priority), ['主机器人兜底', '主控备用', '优先观察', undefined]);
  for (const invalid of [undefined, null, '0', '1', '2', false, true, -1, 3, 1.5, {}, []]) {
    const invalidData = fourAccountState();
    invalidData.accounts.forEach(account => { account.priority = invalid; });
    const unknown = harness({ data: invalidData }); await unknown.settle();
    assert.doesNotMatch(text(unknown.nodes.get('accounts')), /优先观察|主控备用|主机器人兜底/, 'Invalid priority must not look like a real role');
  }
});
test('complete long aliases and multiline errors remain literal text without truncation or HTML interpretation', async () => {
  const data = fourAccountState();
  const alias = '1536267368-' + 'very-long-alias-'.repeat(8) + '<img src=x onerror="alert(1)">';
  const error = '完整后台说明\n' + '诊断内容 '.repeat(100) + '</script><script>alert(1)</script>';
  data.accounts[0].alias = alias; data.accounts[0].error = error;
  const h = harness({ data }); await h.settle();
  const card = h.nodes.get('accounts').children[0];
  assert.equal(childrenOfTag(card, 'h3')[0].textContent, alias);
  assert.equal(card.attributes['aria-label'], alias + '用量');
  assert.equal(childrenOfTag(card, 'input')[0].attributes['aria-label'], '启用账号 ' + alias);
  assert.equal(card.children.at(-1).children[0].textContent, '后台说明：' + error);
  assert.equal(childrenOfTag(card, 'img').length, 0);
  assert.equal(childrenOfTag(card, 'script').length, 0);
});
test('four-account state never renders credential fields or schedules automatic refresh', async () => {
  const data = fourAccountState();
  const secret = 'fixture-secret-never-display';
  data.token = secret; data.credentials = { token: secret };
  data.accounts.forEach(account => {
    account.token = secret; account.apiToken = secret; account.credentials = { token: secret };
  });
  const h = harness({ data }); await h.settle(); await h.settle();
  assert.deepEqual(h.calls.map(call => call.path), ['/api/admin/state']);
  assert.doesNotMatch(text(h.nodes.get('accounts')), new RegExp(secret));
  assert.ok([...h.nodes.values()].every(node => !text(node).includes(secret)));
  assert.doesNotMatch(SCRIPT, /setInterval|setTimeout|requestAnimationFrame|EventSource|WebSocket/);
  h.calls.length = 0;
  await h.click('snapshot-refresh');
  assert.deepEqual(h.calls.map(call => call.path), ['/api/admin/state']);
  assert.equal(h.calls[0].options.credentials, 'same-origin');
  assert.equal(h.calls[0].options.cache, 'no-store');
  assert.equal(h.nodes.get('accounts').children.length, 4);
});
test('unknown/missing quota values are unknown, never displayed as zero or real-time data', async () => {
  const data = state();
  data.accounts[0] = { alias: 'CF77', enabled: true, rowsRead: null, rowsWritten: null, readLimit: 5000000, writeLimit: 0, observedAt: null, day: null, eligible: null, percent: null };
  data.queue = {};
  const h = harness({ data }); await h.settle();
  const content = text(h.nodes.get('accounts').children[0]);
  assert.match(content, /读取[\s\S]*未知[\s\S]*写入[\s\S]*未知/);
  assert.match(content, /新鲜度[\s\S]*未知[\s\S]*冷却状态[\s\S]*未知/);
  assert.equal(h.nodes.get('queue-pending').textContent, '未知');
  assert.equal(h.nodes.get('queue-uncertain').textContent, '未知');
  assert.match(h.nodes.get('reason').textContent, /不代表采集进程实时在线/);
});
test('zero cooldown deadline means no cooldown; percent protocol is a 0..1 ratio', async () => {
  const data = state();
  data.accounts[0].cooldownUntil = 0;
  delete data.accounts[0].cooldown;
  const h = harness({ data }); await h.settle();
  const content = text(h.nodes.get('accounts').children[0]);
  assert.match(content, /综合占用 41\.0%/);
  assert.match(content, /冷却状态 未冷却/);
  assert.doesNotMatch(content, /1970/);
});
test('all API-provided text is textContent, including malicious aliases/reasons/version', async () => {
  const data = state(); const attack = '<img src=x onerror="alert(1)">';
  data.reason = attack; data.version = '</script><script>alert(1)</script>';
  data.accounts[0].alias = attack; data.accounts[0].error = attack;
  const h = harness({ data }); await h.settle();
  assert.ok(h.nodes.get('reason').textContent.includes(attack));
  assert.equal(h.nodes.get('dictionary-version').textContent, data.version);
  assert.ok(text(h.nodes.get('accounts')).includes(attack));
  assert.equal(childrenOfTag(h.nodes.get('accounts'), 'img').length, 0);
  assert.equal(childrenOfTag(h.nodes.get('accounts'), 'script').length, 0);
});
for (const action of ['refresh', 'sync', 'pause', 'resume']) {
  test(action + ' requests use JSON, X-Control-Action, same-origin cookies, and then read a snapshot', async () => {
    const data = state(); if (action === 'resume') data.paused = true;
    const h = harness({ data }); await h.settle(); h.calls.length = 0;
    await h.click(action);
    assert.deepEqual(h.calls.map(call => call.path), ['/api/admin/control/' + action, '/api/admin/state']);
    const options = h.calls[0].options;
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.equal(options.headers['X-Control-Action'], '1');
    assert.deepEqual(JSON.parse(options.body), {});
    assert.match(h.nodes.get('notice').textContent, /请求已受理/);
    assert.doesNotMatch(h.nodes.get('notice').textContent, /同步完成|已实时刷新|已恢复观察/);
  });
}
test('save config sends raw bounded threshold, mode and enable checkboxes, not provider API keys', async () => {
  const h = harness(); await h.settle(); h.calls.length = 0;
  h.nodes.get('mode-balanced').checked = false;
  h.nodes.get('mode-failover').checked = true;
  h.nodes.get('threshold').value = '75';
  const toggles = childrenOfTag(h.nodes.get('accounts'), 'input');
  toggles[0].checked = false; toggles[1].checked = true;
  await h.submit();
  const post = h.calls.find(call => call.path === '/api/admin/control/config');
  assert.ok(post);
  assert.deepEqual(JSON.parse(post.options.body), { mode: 'failover', threshold: 0.75, accounts: [{ alias: 'CF77', enabled: false }, { alias: '7Star', enabled: true }] });
  assert.equal(post.options.headers['X-Control-Action'], '1');
  assert.equal(h.nodes.get('threshold').value, '75');
});
for (const mode of ['balanced', 'failover']) {
  test('four-account ' + mode + ' config saves every alias and checkbox with the existing secure JSON protocol', async () => {
    const data = fourAccountState();
    data.accounts.forEach(account => { account.token = 'fixture-secret-never-submit'; });
    const h = harness({ data }); await h.settle(); h.calls.length = 0;
    h.nodes.get('mode-balanced').checked = mode === 'balanced';
    h.nodes.get('mode-failover').checked = mode === 'failover';
    h.nodes.get('threshold').value = '75';
    const enabled = [false, true, false, true];
    const toggles = childrenOfTag(h.nodes.get('accounts'), 'input');
    for (const [index, toggle] of toggles.entries()) {
      toggle.checked = enabled[index]; await toggle.emit('change');
    }
    assert.match(h.nodes.get('config-status').textContent, /未保存修改/);
    await h.submit();
    assert.deepEqual(h.calls.map(call => call.path), ['/api/admin/control/config', '/api/admin/state']);
    const options = h.calls[0].options;
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.equal(options.headers['X-Control-Action'], '1');
    assert.deepEqual(JSON.parse(options.body), {
      mode, threshold: 0.75,
      accounts: data.accounts.map((account, index) => ({ alias: account.alias, enabled: enabled[index] })),
    });
    assert.doesNotMatch(options.body, /priority|role|token|credential|fixture-secret/);
    assert.equal(h.nodes.get('accounts').children.length, 4);
    assert.deepEqual(childrenOfTag(h.nodes.get('accounts'), 'input').map(input => input.checked), enabled);
    assert.equal(h.nodes.get('threshold').value, '75');
  });
}
test('an unknown fourth account enable state blocks incomplete config rather than omitting that alias', async () => {
  const data = fourAccountState(); delete data.accounts[3].enabled;
  const h = harness({ data }); await h.settle(); h.calls.length = 0;
  const toggles = childrenOfTag(h.nodes.get('accounts'), 'input');
  assert.equal(toggles.length, 4);
  assert.equal(toggles[3].disabled, true);
  await h.submit();
  assert.equal(h.calls.length, 0);
  assert.match(h.nodes.get('notice').textContent, /账号配置不完整/);
});
test('missing account config cannot be saved as an empty accidental disable list', async () => {
  const data = state(); data.accounts = [];
  const h = harness({ data }); await h.settle(); h.calls.length = 0;
  await h.submit();
  assert.equal(h.calls.length, 0);
  assert.match(h.nodes.get('notice').textContent, /账号配置不完整/);
});
for (const threshold of ['81', '95', '0', '-1', '', 'not-a-number']) {
  test('threshold validation rejects ' + JSON.stringify(threshold) + ' without sending a mutation', async () => {
    const h = harness(); await h.settle(); h.calls.length = 0;
    h.nodes.get('threshold').value = threshold;
    await h.submit();
    assert.equal(h.calls.length, 0);
    assert.match(h.nodes.get('notice').textContent, /1%–80%/);
  });
}
test('busy request prevents duplicate mutations and displays in-progress, not pretend completion', async () => {
  let resolvePost;
  const h = harness({ fetchImpl(path, options, current) {
    if (path === '/api/admin/state') return Response.json({ ok: true, data: current });
    return new Promise(resolve => { resolvePost = resolve; });
  } });
  await h.settle(); h.calls.length = 0;
  const pending = h.nodes.get('sync').emit('click'); await h.settle();
  assert.match(h.nodes.get('progress').textContent, /正在提交/);
  assert.equal(h.nodes.get('sync').disabled, true);
  await h.nodes.get('sync').emit('click');
  assert.equal(h.calls.length, 1);
  resolvePost(Response.json({ ok: true })); await pending; await h.settle();
  assert.equal(h.calls.length, 2);
});
test('failed mutation shows failure and never reports accepted or completed', async () => {
  const h = harness({ fetchImpl(path, options, current) {
    return path === '/api/admin/state' ? Response.json({ ok: true, data: current }) : Response.json({ ok: false }, { status: 503 });
  } });
  await h.settle(); h.calls.length = 0; await h.click('refresh');
  assert.equal(h.calls.length, 1);
  assert.match(h.nodes.get('notice').textContent, /HTTP 503/);
  assert.doesNotMatch(h.nodes.get('notice').textContent, /请求已受理|已完成/);
});
test('accepted mutation with failed state refresh does not encourage duplicate submission', async () => {
  let reads = 0;
  const h = harness({ fetchImpl(path, options, current) {
    if (path === '/api/admin/state') return ++reads === 1 ? Response.json({ ok: true, data: current }) : Response.json({ ok: false }, { status: 500 });
    return Response.json({ ok: true });
  } });
  await h.settle(); await h.click('sync');
  assert.match(h.nodes.get('notice').textContent, /操作已受理.*读取失败.*请勿盲目重复提交/);
});
test('unauthenticated state redirects to /login instead of displaying quota as zero', async () => {
  const h = harness({ fetchImpl() { return Response.json({ ok: false }, { status: 401 }); } });
  await h.settle(); assert.deepEqual(h.redirects, ['/login']);
  assert.equal(h.nodes.get('save-config').disabled, true);
  assert.match(h.nodes.get('notice').textContent, /会话已失效/);
});
test('logout posts to same-origin server with action header, no token in DOM storage', async () => {
  const h = harness(); await h.settle(); h.calls.length = 0;
  await h.click('logout');
  assert.equal(h.calls[0].path, '/logout');
  assert.equal(h.calls[0].options.method, 'POST');
  assert.equal(h.calls[0].options.headers['X-Control-Action'], '1');
  assert.equal(h.calls[0].options.credentials, 'same-origin');
  assert.deepEqual(h.redirects, ['/login']);
});
const uncertainReview = (index = 1) => ({ id: index.toString(16).padStart(24, '0'), event_key: 'chat:message:' + index, status: 'notification_uncertain', created_at: 1795303200000, summary: '未确认送达的候选消息 ' + index });
test('uncertain notifications are fetched only on request and rendered at most 20 as text', async () => {
  const reviews = Array.from({ length: 25 }, (_, index) => uncertainReview(index + 1));
  reviews[0].summary = '<img src=x onerror="alert(1)">';
  reviews[0].event_key = '</script><script>alert(1)</script>';
  const h = harness({ reviews }); await h.settle();
  assert.deepEqual(h.calls.map(call => call.path), ['/api/admin/state']);
  h.calls.length = 0;
  await h.click('load-uncertain-reviews');
  assert.deepEqual(h.calls.map(call => call.path), ['/api/admin/reviews']);
  assert.equal(h.calls[0].options.credentials, 'same-origin');
  assert.equal(h.calls[0].options.cache, 'no-store');
  const list = h.nodes.get('uncertain-reviews');
  assert.equal(list.children.length, 20);
  assert.equal(childrenOfTag(list, 'button').length, 20);
  assert.match(text(list), /<img src=x onerror="alert\(1\)">/);
  assert.equal(childrenOfTag(list, 'img').length, 0);
  assert.equal(childrenOfTag(list, 'script').length, 0);
  assert.match(h.nodes.get('uncertain-reviews-status').textContent, /展示 20 条 · 共 25 条/);
});
test('discard uncertain notice requires confirmation and posts only dismiss then reads state, not notifications', async () => {
  const review = uncertainReview();
  const h = harness({ reviews: [review] }); await h.settle();
  await h.click('load-uncertain-reviews'); h.calls.length = 0;
  const button = childrenOfTag(h.nodes.get('uncertain-reviews'), 'button')[0];
  assert.equal(button.textContent, '放弃此条待核查通知');
  await button.emit('click'); await h.settle();
  assert.equal(h.confirmations.length, 1);
  assert.match(h.confirmations[0], /不会保存样本.*不会封禁用户.*不会重新发送/);
  assert.deepEqual(h.calls.map(call => call.path), ['/api/admin/control/resolve', '/api/admin/state']);
  const options = h.calls[0].options;
  assert.equal(options.method, 'POST');
  assert.equal(options.credentials, 'same-origin');
  assert.equal(options.headers['X-Control-Action'], '1');
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(options.body), { id: review.id, action: 'dismiss' });
  assert.equal(button.disabled, true);
  assert.match(button.textContent, /已提交放弃/);
  assert.match(h.nodes.get('notice').textContent, /仅标记为 dismissed.*不保存样本.*不封禁用户.*不重新发送/);
  await button.emit('click'); await h.settle();
  assert.equal(h.calls.length, 2, 'No double dismiss or automatic resend');
});
test('declined discard confirmation never submits or mutates the list', async () => {
  const h = harness({ reviews: [uncertainReview()], confirm: false }); await h.settle();
  await h.click('load-uncertain-reviews'); h.calls.length = 0;
  const button = childrenOfTag(h.nodes.get('uncertain-reviews'), 'button')[0];
  await button.emit('click'); await h.settle();
  assert.equal(h.calls.length, 0);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, '放弃此条待核查通知');
});
test('known delivered, malformed ID or other review status does not expose a discard action', async () => {
  const h = harness({ reviews: [{ ...uncertainReview(1), status: 'sent' }, { ...uncertainReview(2), id: '<script>bad</script>' }, { ...uncertainReview(3), status: 'dismissed' }] });
  await h.settle(); await h.click('load-uncertain-reviews');
  const list = h.nodes.get('uncertain-reviews');
  assert.equal(list.children.length, 3);
  assert.equal(childrenOfTag(list, 'button').length, 0);
  assert.equal(childrenOfTag(list, 'script').length, 0);
});
test('failed discard request does not claim the notification is dismissed', async () => {
  const review = uncertainReview();
  const h = harness({ fetchImpl(path, options, current) {
    if (path === '/api/admin/state') return Response.json({ ok: true, data: current });
    if (path === '/api/admin/reviews') return Response.json({ ok: true, items: [review], total: 1 });
    return Response.json({ ok: false }, { status: 503 });
  } });
  await h.settle(); await h.click('load-uncertain-reviews'); h.calls.length = 0;
  const button = childrenOfTag(h.nodes.get('uncertain-reviews'), 'button')[0];
  await button.emit('click'); await h.settle();
  assert.deepEqual(h.calls.map(call => call.path), ['/api/admin/control/resolve']);
  assert.equal(button.textContent, '放弃此条待核查通知');
  assert.equal(button.disabled, false);
  assert.match(h.nodes.get('notice').textContent, /没有确认该通知已被放弃/);
  assert.doesNotMatch(h.nodes.get('notice').textContent, /请求已受理/);
});
test('accepted discard followed by state failure cannot be silently resubmitted', async () => {
  let reads = 0;
  const review = uncertainReview();
  const h = harness({ fetchImpl(path, options, current) {
    if (path === '/api/admin/state') return ++reads === 1 ? Response.json({ ok: true, data: current }) : Response.json({ ok: false }, { status: 500 });
    if (path === '/api/admin/reviews') return Response.json({ ok: true, items: [review], total: 1 });
    return Response.json({ ok: true });
  } });
  await h.settle(); await h.click('load-uncertain-reviews');
  const button = childrenOfTag(h.nodes.get('uncertain-reviews'), 'button')[0];
  await button.emit('click'); await h.settle();
  assert.equal(button.disabled, true);
  assert.match(h.nodes.get('notice').textContent, /放弃请求已受理.*读取失败.*请勿盲目重复提交/);
});
test('malformed notification response never displays a false empty-list success', async () => {
  const h = harness({ fetchImpl(path, options, current) {
    if (path === '/api/admin/state') return Response.json({ ok: true, data: current });
    return Response.json({ ok: true, total: 999 });
  } });
  await h.settle(); await h.click('load-uncertain-reviews');
  assert.match(h.nodes.get('notice').textContent, /列表结构无效/);
  assert.match(h.nodes.get('uncertain-reviews-status').textContent, /读取失败/);
});

test('dirty config is not silently discarded by a refresh when user declines', async () => {
  const h = harness({ confirm: false }); await h.settle(); h.calls.length = 0;
  h.nodes.get('threshold').value = '70'; await h.nodes.get('threshold').emit('change');
  await h.click('snapshot-refresh');
  assert.equal(h.confirmations.length, 1);
  assert.equal(h.calls.length, 0);
  assert.equal(h.nodes.get('threshold').value, '70');
});
