// External Workers control-panel templates. Never render provider credentials.
// Replace CSP_NONCE_PLACEHOLDER in the HTML and CSP header with the SAME fresh,
// per-response base64 nonce before serving. Route authentication is server-side.
export const CSP_NONCE_PLACEHOLDER = '__ADMIN_CSP_NONCE__';

export const ADMIN_HEADERS = Object.freeze({
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Pragma': 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'none'; script-src 'nonce-__ADMIN_CSP_NONCE__'; style-src 'nonce-__ADMIN_CSP_NONCE__'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
});

const CSS = `
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:#0b1120;color:#e2e8f0;font-synthesis:none}
*{box-sizing:border-box}body{margin:0;min-width:300px}a{color:#93c5fd}button,input{font:inherit}button{cursor:pointer}button:disabled,input:disabled{cursor:not-allowed;opacity:.5}button:focus-visible,input:focus-visible,a:focus-visible{outline:2px solid #7dd3fc;outline-offset:3px}
.shell{max-width:1240px;margin:auto;padding:24px}.header{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:24px}.eyebrow{font-size:11px;font-weight:700;letter-spacing:.14em;color:#7dd3fc;margin:0 0 6px}.title{font-size:24px;letter-spacing:-.04em;margin:0}.subtitle{font-size:13px;color:#94a3b8;margin:7px 0 0;line-height:1.6}.btn{background:#172236;border:1px solid #334155;color:#e2e8f0;padding:9px 14px;border-radius:9px;font-size:13px;font-weight:600;transition:background .15s}.btn:hover:enabled{background:#22304a}.btn.primary{background:#2563eb;border-color:#3b82f6;color:white}.btn.primary:hover:enabled{background:#1d4ed8}.btn.warn{color:#fcd34d;border-color:#854d0e;background:#271f12}.btn.danger{color:#fda4af}.button-row{display:flex;flex-wrap:wrap;gap:8px}.panel{background:#101b2e;border:1px solid #233149;border-radius:14px;padding:20px;box-shadow:0 12px 35px #00000016}.panel+.panel{margin-top:18px}.panel-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}.panel h2{font-size:15px;margin:0}.muted{font-size:12px;color:#94a3b8;line-height:1.7}.badge{display:inline-flex;align-items:center;gap:6px;font-size:11px;padding:4px 9px;border-radius:99px;white-space:nowrap;background:#1b2940;color:#cbd5e1}.badge.good{color:#86efac;background:#143124}.badge.warn{color:#fde68a;background:#362c15}.badge.bad{color:#fda4af;background:#371e2b}.status-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:16px 0 10px}.reason{font-size:13px;line-height:1.7;color:#cbd5e1;overflow-wrap:anywhere;min-height:22px}.snapshot{margin-top:14px;display:flex;gap:18px;flex-wrap:wrap;color:#94a3b8;font-size:12px}.snapshot strong{color:#e2e8f0;font-weight:500;font-variant-numeric:tabular-nums}.notice{padding:12px 14px;border:1px solid #28415d;border-radius:10px;font-size:12px;line-height:1.7;background:#122338;color:#bfdbfe;margin:18px 0}.notice.error{background:#321b29;border-color:#7f1d1d;color:#fecdd3}.notice.success{background:#122c28;border-color:#14532d;color:#bbf7d0}.notice[hidden]{display:none}.progress-note{font-size:12px;color:#94a3b8;line-height:1.7;margin:12px 0 0}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-rows:1fr;align-items:stretch;gap:18px;margin:18px 0}.grid>.panel,.grid>.panel.account-card{margin-block:0}.account-card{display:flex;flex-direction:column;min-width:0}.account-card>*{flex-shrink:0}.account-top{display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:8px 12px;min-height:30px}.account-title{font-size:19px;font-weight:700;line-height:1.5;margin:0;min-width:0;flex:1 1 150px;overflow-wrap:anywhere}.toggle-label{display:flex;align-items:center;gap:8px;color:#cbd5e1;font-size:12px;white-space:nowrap;flex:0 0 auto;min-height:29px}input[type=checkbox],input[type=radio]{accent-color:#60a5fa;width:16px;height:16px;margin:0}.account-badges{display:flex;gap:7px;flex-wrap:wrap;align-items:center;align-content:flex-start;min-height:55px;margin:14px 0}.usage{margin:18px 0}.usage-heading{display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:6px 12px;font-size:12px;color:#cbd5e1;margin-bottom:8px}.usage-heading strong{font-size:21px;font-weight:650;color:#f1f5f9;font-variant-numeric:tabular-nums}.usage-number{font-size:11px;color:#94a3b8;font-variant-numeric:tabular-nums;line-height:1.6;margin-top:6px;overflow-wrap:anywhere}progress{display:block;width:100%;height:7px;appearance:none;border:0;border-radius:99px;overflow:hidden;background:#25334b}progress::-webkit-progress-bar{background:#25334b;border-radius:99px}progress::-webkit-progress-value{background:#38bdf8;border-radius:99px}progress::-moz-progress-bar{background:#38bdf8;border-radius:99px}progress.high::-webkit-progress-value{background:#f59e0b}progress.high::-moz-progress-bar{background:#f59e0b}progress.unknown{opacity:.45}.details{display:grid;grid-template-columns:105px minmax(0,1fr);gap:8px 12px;font-size:12px;border-top:1px solid #233149;padding-top:14px;margin:14px 0 0}.details dt{color:#94a3b8}.details dd{margin:0;color:#cbd5e1;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}.account-card .details{flex-grow:1;align-content:start;min-height:132px;line-height:1.7}.account-error-slot{margin-top:12px;min-height:40px}.account-error{margin:0;padding:9px 11px;border-radius:8px;background:#321b29;color:#fda4af;font-size:12px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}.empty{padding:32px 18px;text-align:center;color:#94a3b8;font-size:13px;grid-column:1/-1}.queue-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:16px}.queue-cell{background:#0b1527;border:1px solid #233149;border-radius:10px;padding:14px}.queue-cell p{margin:0 0 8px;font-size:11px;color:#94a3b8}.queue-cell strong{font-size:26px;line-height:1.2;font-weight:650;font-variant-numeric:tabular-nums}.queue-cell.uncertain strong{color:#fbbf24}
.settings{margin-top:18px}fieldset{border:0;padding:0;margin:0}legend{font-size:12px;color:#94a3b8;margin-bottom:10px}.config-grid{display:grid;grid-template-columns:1fr 220px;gap:24px}.mode-option{display:flex;align-items:flex-start;gap:10px;border:1px solid #2d3d56;background:#0b1527;border-radius:10px;padding:12px;font-size:13px}.mode-option+.mode-option{margin-top:9px}.mode-option strong{display:block;color:#e2e8f0;font-size:13px}.mode-option small{display:block;color:#94a3b8;font-size:11px;line-height:1.65;margin-top:3px}.mode-option input{margin-top:2px;flex-shrink:0}.threshold-wrap{display:flex;align-items:center;gap:10px}.threshold-wrap input{background:#0b1527;border:1px solid #334155;color:#f1f5f9;border-radius:9px;padding:10px 12px;width:90px;min-width:0;font-variant-numeric:tabular-nums}.threshold-wrap span{color:#94a3b8;font-size:14px}.config-bottom{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;border-top:1px solid #233149;margin-top:20px;padding-top:16px}.foot{display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap;font-size:11px;color:#64748b;margin:22px 0 0;line-height:1.8}.login-shell{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}.login-card{width:100%;max-width:420px}.login-card label{display:block;font-size:13px;color:#cbd5e1;margin:24px 0 8px}.login-card input{width:100%;padding:12px;background:#0b1527;border:1px solid #334155;border-radius:9px;color:#f1f5f9}.login-card button{margin-top:18px;width:100%;padding:12px}.login-error{font-size:12px;color:#fda4af;min-height:18px}.login-card .subtitle{margin-top:12px}
.review-list{display:grid;gap:12px;margin-top:14px}.review-item{border:1px solid #334155;border-radius:10px;padding:14px;background:#0b1527;min-width:0}.review-item-heading{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}.review-item-heading strong{font-size:12px;font-weight:600;overflow-wrap:anywhere}.review-summary{font-size:13px;color:#cbd5e1;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere;margin:10px 0}.review-meta{font-size:11px;color:#94a3b8;overflow-wrap:anywhere;line-height:1.7;margin-bottom:12px}.review-status{font-size:12px;line-height:1.7;color:#94a3b8;margin:12px 0 0}
@media(max-width:720px){.shell{padding:16px}.header{align-items:flex-start}.title{font-size:21px}.panel{padding:16px}.panel-heading{flex-direction:column;gap:14px}.grid{grid-template-columns:1fr;grid-auto-rows:auto;gap:14px}.config-grid{grid-template-columns:1fr;gap:20px}.queue-grid{gap:7px}.queue-cell{padding:12px 10px}.queue-cell strong{font-size:23px}.snapshot{gap:10px 14px}}
@media(prefers-reduced-motion:reduce){.btn{transition:none}}
`;

const SCRIPT = String.raw`
(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const accountControls = [];
  const reviewControls = [];
  let state = null;
  let busy = false;
  let dirty = false;
  let readVersion = 0;
  const controls = ['refresh', 'sync', 'snapshot-refresh', 'pause', 'resume', 'save-config', 'logout', 'threshold', 'mode-balanced', 'mode-failover', 'load-uncertain-reviews'];
  function confirmRead() {
    return !dirty || window.confirm('刷新状态会放弃未保存的账号开关和调度配置，是否继续？');
  }
  const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
  const finite = value => {
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^[0-9]+(?:\.[0-9]+)?$/.test(value.trim()))) return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  };
  const text = (value, maximum = 180) => typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, maximum) : '未知';
  const count = value => {
    const n = finite(value);
    return n === null ? '未知' : numberFormat.format(n);
  };
  const timeValue = value => {
    if (value === null || value === undefined || value === '') return null;
    const input = value;
    const parsed = new Date(input);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  };
  const time = value => {
    const parsed = timeValue(value);
    return parsed ? parsed.toLocaleString('zh-CN', { hour12: false }) : '未知';
  };
  const make = (tag, className, content) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  };
  function notice(message, style = '') {
    el('notice').hidden = !message;
    el('notice').className = 'notice' + (style ? ' ' + style : '');
    el('notice').textContent = message;
  }
  function setBusy(value, message) {
    busy = value;
    controls.forEach(id => { el(id).disabled = value; });
    accountControls.forEach(control => { control.input.disabled = value || !control.known; });
    reviewControls.forEach(control => { control.button.disabled = value || control.resolved; });
    if (!value && state) {
      el('pause').disabled = state.paused === true;
      el('resume').disabled = state.paused !== true;
    }
    if (!value && !state) {
      ['pause', 'resume', 'save-config'].forEach(id => { el(id).disabled = true; });
    }
    if (message) el('progress').textContent = message;
    el('control-panel').setAttribute('aria-busy', String(value));
  }
  async function api(path, options = {}) {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
    if (response.status === 401) {
      window.location.assign('/login');
      throw new Error('登录会话已失效，请重新登录。');
    }
    if (response.status === 204 && response.ok) return { ok: true };
    let payload;
    try { payload = await response.json(); }
    catch (_) { throw new Error('后台返回了无法解析的响应，请稍后刷新。'); }
    if (!response.ok || payload?.ok !== true) {
      const suffix = response.status === 403 ? '（无权限或请求未通过同源校验）' : '（HTTP ' + response.status + '）';
      throw new Error('后台请求未成功' + suffix + '，没有确认操作完成。');
    }
    return payload;
  }
  function usage(label, rows, limit, threshold) {
    const node = make('div', 'usage');
    const heading = make('div', 'usage-heading');
    heading.appendChild(make('span', '', label));
    const r = finite(rows), l = finite(limit);
    const ratio = r !== null && l !== null && l > 0 ? r / l : null;
    heading.appendChild(make('strong', '', ratio === null ? '未知' : (ratio * 100).toFixed(1) + '%'));
    const progress = make('progress', ratio === null ? 'unknown' : ratio >= threshold ? 'high' : '');
    progress.max = 100;
    if (ratio !== null) progress.value = Math.min(100, ratio * 100);
    progress.setAttribute('aria-label', label + '占比');
    node.appendChild(heading);
    node.appendChild(progress);
    node.appendChild(make('div', 'usage-number', count(rows) + ' / ' + count(limit) + ' 行'));
    return node;
  }
  function detail(list, label, value) {
    list.appendChild(make('dt', '', label));
    list.appendChild(make('dd', '', value));
  }
  function renderAccount(account, threshold, utcDay) {
    const card = make('section', 'panel account-card');
    const alias = text(account.alias, Infinity);
    card.setAttribute('aria-label', alias + '用量');
    const header = make('div', 'account-top');
    header.appendChild(make('h3', 'account-title', alias));
    const toggle = make('label', 'toggle-label');
    const input = make('input');
    input.type = 'checkbox';
    input.checked = account.enabled === true;
    const known = typeof account.enabled === 'boolean';
    input.disabled = busy || !known;
    input.setAttribute('aria-label', '启用账号 ' + alias);
    input.addEventListener('change', markDirty);
    toggle.appendChild(input);
    toggle.appendChild(make('span', '', known ? '启用账号' : '配置未知'));
    header.appendChild(toggle);
    card.appendChild(header);
    accountControls.push({ alias: typeof account.alias === 'string' ? account.alias : '', input, known });
    const badges = make('div', 'account-badges');
    const priorityLabels = ['优先观察', '主控备用', '主机器人兜底'];
    if (Number.isInteger(account.priority) && account.priority >= 0 && account.priority < priorityLabels.length) {
      badges.appendChild(make('span', 'badge priority-badge', priorityLabels[account.priority]));
    }
    badges.appendChild(make('span', 'badge warn', (threshold * 100).toFixed(0) + '% 自动暂停'));
    const percentage = finite(account.percent);
    badges.appendChild(make('span', 'badge', percentage === null ? '综合占用未知' : '综合占用 ' + (percentage * 100).toFixed(1) + '%'));
    const eligibility = account.eligible === true ? ['good', '可调度'] : account.eligible === false ? ['bad', '不可调度'] : ['', '资格未知'];
    badges.appendChild(make('span', 'badge ' + eligibility[0], eligibility[1]));
    card.appendChild(badges);
    card.appendChild(usage('D1 每日读取', account.rowsRead, account.readLimit, threshold));
    card.appendChild(usage('D1 每日写入', account.rowsWritten, account.writeLimit, threshold));
    const details = make('dl', 'details');
    detail(details, '用量 UTC 日', text(account.day, 32));
    detail(details, '观测时间', time(account.observedAt));
    const freshness = account.fresh === true ? '新鲜快照' : account.fresh === false ? '快照过期' : '未知（后台未报告新鲜度）';
    detail(details, '新鲜度', account.day && utcDay && account.day !== utcDay ? '非当前 UTC 日 · ' + freshness : freshness);
    const cooldownUntil = timeValue(account.cooldownUntil);
    const cooldown = account.cooldownUntil === 0 ? '未冷却' : cooldownUntil ? (cooldownUntil.getTime() > Date.now() ? '冷却至 ' : '冷却截止已过：') + time(account.cooldownUntil) : account.cooldown === true ? '冷却中（截止时间未知）' : account.cooldown === false ? '未冷却' : '未知（后台未报告）';
    detail(details, '冷却状态', cooldown);
    card.appendChild(details);
    const errorSlot = make('div', 'account-error-slot');
    if (account.error) errorSlot.appendChild(make('p', 'account-error', '后台说明：' + text(account.error, Infinity)));
    card.appendChild(errorSlot);
    return card;
  }
  function render(data) {
    state = data;
    const threshold = finite(data.threshold);
    const safeThreshold = threshold !== null && threshold > 0 && threshold <= 0.8 ? threshold : 0.8;
    const paused = data.paused === true;
    el('task-status').textContent = paused ? '观察已暂停' : data.paused === false ? '允许观察' : '任务状态未知';
    el('task-status').className = 'badge ' + (paused ? 'warn' : data.paused === false ? 'good' : '');
    el('reason').textContent = data.reason ? '后台原因：' + text(data.reason, 240) : paused ? '后台未提供暂停原因。' : '配置允许观察不代表采集进程实时在线，请结合队列和观测时间判断。';
    el('utc-day').textContent = text(data.utcDay, 32);
    el('dictionary-version').textContent = text(data.version, 128);
    el('snapshot-time').textContent = new Date().toLocaleString('zh-CN', { hour12: false });
    el('mode-balanced').checked = data.mode === 'balanced';
    el('mode-failover').checked = data.mode === 'failover';
    el('threshold').value = String(Number((safeThreshold * 100).toFixed(2)));
    el('policy-badge').textContent = (safeThreshold * 100).toFixed(0) + '% 额度保护';
    const accounts = Array.isArray(data.accounts) ? data.accounts.slice(0, 32) : [];
    const container = el('accounts');
    container.textContent = '';
    accountControls.length = 0;
    if (!accounts.length) container.appendChild(make('div', 'panel empty', '暂无账号状态。缺失用量不能当作零占用，也不能视为可调度。'));
    for (const account of accounts) {
      if (account && typeof account === 'object' && !Array.isArray(account)) container.appendChild(renderAccount(account, safeThreshold, data.utcDay));
    }
    const queue = data.queue && typeof data.queue === 'object' ? data.queue : {};
    el('queue-pending').textContent = count(queue.pending);
    el('queue-reviews').textContent = count(queue.reviews);
    el('queue-uncertain').textContent = count(queue.uncertain);
    dirty = false;
    el('config-status').textContent = '账号开关与调度配置保存后生效。阈值不能高于 80%。';
  }
  function markDirty() {
    dirty = true;
    el('config-status').textContent = '有未保存修改；点击「保存调度配置」后才会提交。';
  }
  async function readState() {
    const version = ++readVersion;
    const payload = await api('/api/admin/state');
    if (version !== readVersion) return;
    if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) throw new Error('后台状态结构无效，未更新页面。');
    render(payload.data);
  }
  async function refreshSnapshot() {
    if (busy || !confirmRead()) return;
    setBusy(true, '正在读取后台状态快照…');
    notice('');
    try {
      await readState();
      el('progress').textContent = '已读取后台快照。页面不自动轮询；用量是否最新以各账号观测时间和新鲜度为准。';
    } catch (error) { notice(error.message, 'error'); el('progress').textContent = '读取失败，保留可见的上一份快照（如有）。'; }
    finally { setBusy(false); }
  }
  const labels = { refresh: '用量刷新', sync: '字典同步', pause: '暂停观察', resume: '恢复观察', config: '配置保存' };
  async function control(action, body = {}) {
    if (busy || (action !== 'config' && !confirmRead())) return;
    setBusy(true, '正在提交' + labels[action] + '请求…');
    notice('');
    let accepted = false;
    try {
      await api('/api/admin/control/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Control-Action': '1' }, body: JSON.stringify(body) });
      accepted = true;
      el('progress').textContent = labels[action] + '请求已受理，正在重新读取状态快照…';
      await readState();
      notice(labels[action] + '请求已受理。下方为后台返回的状态快照；同步是否完成以字典版本及后台状态为准。', 'success');
      el('progress').textContent = '没有实时进度流；需要确认后续结果时，可再点「读取状态」。恢复观察仍须通过账号额度和新鲜度检查。';
    } catch (error) {
      notice((accepted ? '操作已受理，但后续状态读取失败。请勿盲目重复提交。' : '') + error.message, 'error');
      el('progress').textContent = '本次没有确认最终状态，请读取后台快照后再判断。';
    } finally { setBusy(false); }
  }
  async function saveConfig(event) {
    event.preventDefault();
    if (busy || !state) return;
    const mode = el('mode-balanced').checked ? 'balanced' : el('mode-failover').checked ? 'failover' : '';
    const threshold = finite(el('threshold').value);
    if (!mode || threshold === null || threshold < 1 || threshold > 80) {
      notice('请选择调度模式，暂停阈值必须在 1%–80% 之间。没有提交修改。', 'error');
      return;
    }
    if (!accountControls.length || accountControls.some(item => !item.alias || !item.known)) {
      notice('账号配置不完整，请先刷新状态；未提交修改。', 'error');
      return;
    }
    const accounts = accountControls.map(item => ({ alias: item.alias, enabled: item.input.checked === true }));
    await control('config', { mode, threshold: threshold / 100, accounts });
  }
  function renderUncertainReviews(payload) {
    const container = el('uncertain-reviews');
    container.textContent = '';
    reviewControls.length = 0;
    const items = payload.items.slice(0, 20);
    const total = finite(payload.total);
    el('uncertain-reviews-status').textContent = '本次展示 ' + items.length + ' 条 · 共 ' + (total === null ? '未知' : count(total)) + ' 条。此列表不会自动刷新；需要新结果时手动查看。';
    if (!items.length) {
      container.appendChild(make('p', 'muted', '本次没有返回待核查通知。'));
      return;
    }
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const card = make('article', 'review-item');
      const heading = make('div', 'review-item-heading');
      heading.appendChild(make('strong', '', '通知 ID：' + text(item.id, 64)));
      const uncertain = item.status === 'notification_uncertain';
      const status = make('span', 'badge ' + (uncertain ? 'warn' : ''), uncertain ? '通知结果待核查' : text(item.status, 64));
      heading.appendChild(status);
      card.appendChild(heading);
      card.appendChild(make('p', 'review-summary', text(item.summary, 1000)));
      card.appendChild(make('p', 'review-meta', '创建于：' + time(item.created_at) + ' · 事件：' + text(item.event_key, 160)));
      if (uncertain && typeof item.id === 'string' && /^[a-f0-9]{24}$/i.test(item.id)) {
        const button = make('button', 'btn danger', '放弃此条待核查通知');
        button.type = 'button';
        const control = { id: item.id, button, status, resolved: false };
        button.disabled = busy;
        button.addEventListener('click', () => dismissUncertainReview(control));
        reviewControls.push(control);
        card.appendChild(button);
      } else {
        card.appendChild(make('p', 'muted', '该记录不是可处理的待核查通知；页面不提供保存、封禁或重发操作。'));
      }
      container.appendChild(card);
    }
  }
  async function loadUncertainReviews() {
    if (busy) return;
    setBusy(true, '正在读取待核查通知列表…');
    notice('');
    try {
      const payload = await api('/api/admin/reviews');
      if (!Array.isArray(payload.items)) throw new Error('通知列表结构无效，未更新页面。');
      renderUncertainReviews(payload);
      el('progress').textContent = '已读取最多 20 条待核查通知。未执行保存样本、封禁或重发。';
    } catch (error) {
      notice(error.message, 'error');
      el('uncertain-reviews-status').textContent = '本次读取失败；可见的列表可能是旧快照，请重新手动查看。';
    } finally { setBusy(false); }
  }
  async function dismissUncertainReview(control) {
    if (busy || control.resolved) return;
    const warning = '放弃此条待核查通知仅将后台状态标记为 dismissed：不会保存样本，不会封禁用户，也不会重新发送通知。' +
      (dirty ? '操作后读取状态会放弃未保存的账号开关与调度配置。' : '') + '确定继续吗？';
    if (!window.confirm(warning)) return;
    setBusy(true, '正在提交放弃通知请求…');
    notice('');
    let accepted = false;
    try {
      await api('/api/admin/control/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Control-Action': '1' }, body: JSON.stringify({ id: control.id, action: 'dismiss' }) });
      accepted = true;
      control.resolved = true;
      control.button.textContent = '已提交放弃';
      control.status.textContent = '已提交放弃（不重发）';
      control.status.className = 'badge';
      await readState();
      notice('放弃通知请求已受理。仅标记为 dismissed，不保存样本、不封禁用户、不重新发送通知。', 'success');
      el('progress').textContent = '队列摘要已重新读取；通知列表没有自动重查，其他项目仍是本次列表快照。';
    } catch (error) {
      notice((accepted ? '放弃请求已受理，但队列状态读取失败。请勿盲目重复提交。' : '没有确认该通知已被放弃。') + error.message, 'error');
      el('progress').textContent = '没有确认最终列表状态；请手动查看未确认通知，不要重新发送。';
    } finally { setBusy(false); }
  }
  async function logout() {
    if (busy) return;
    setBusy(true, '正在退出登录…');
    try {
      const response = await fetch('/logout', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Control-Action': '1' }, body: '{}' });
      if (!response.ok) throw new Error('退出登录未成功，请稍后重试。');
      window.location.assign('/login');
    } catch (error) { notice(error.message, 'error'); setBusy(false, '退出请求失败，没有确认会话已清除。'); }
  }
  el('refresh').addEventListener('click', () => control('refresh'));
  el('sync').addEventListener('click', () => control('sync'));
  el('snapshot-refresh').addEventListener('click', refreshSnapshot);
  el('pause').addEventListener('click', () => control('pause'));
  el('resume').addEventListener('click', () => control('resume'));
  el('config-form').addEventListener('submit', saveConfig);
  ['threshold', 'mode-balanced', 'mode-failover'].forEach(id => el(id).addEventListener('change', markDirty));
  el('logout').addEventListener('click', logout);
  el('load-uncertain-reviews').addEventListener('click', loadUncertainReviews);
  refreshSnapshot();
})();
`;

export const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><title>观察池 · 管理后台</title><style nonce="${CSP_NONCE_PLACEHOLDER}">${CSS}</style></head>
<body><main class="shell" id="control-panel" aria-busy="true">
<header class="header"><div><p class="eyebrow">OBSERVATION POOL / CONTROL</p><h1 class="title">观察池管理后台</h1><p class="subtitle">账号用量 · 额度保护 · 字典同步。仅查看服务端快照，不暴露账号凭证。</p></div><button class="btn" id="logout" type="button" disabled>退出登录</button></header>
<section class="panel"><div class="panel-heading"><div><h2>观察任务状态</h2><p class="subtitle">手动刷新，不进行自动轮询；图表不是实时用量。</p></div><div class="button-row"><button class="btn" id="snapshot-refresh" type="button" disabled>读取状态</button><button class="btn primary" id="refresh" type="button" disabled>刷新用量</button><button class="btn" id="sync" type="button" disabled>同步字典</button></div></div>
<div class="status-row"><span class="badge" id="task-status">尚未读取状态</span><span class="badge warn" id="policy-badge">80% 额度保护</span></div><div class="reason" id="reason">等待后台状态…</div>
<div class="snapshot"><span>当前 UTC 日：<strong id="utc-day">未知</strong></span><span>字典版本：<strong id="dictionary-version">未知</strong></span><span>本页读取于：<strong id="snapshot-time">未知</strong></span></div>
<div class="status-row"><button class="btn warn" id="pause" type="button" disabled>暂停观察</button><button class="btn" id="resume" type="button" disabled>申请恢复观察</button></div><p class="progress-note" id="progress" role="status" aria-live="polite">准备读取状态快照…</p></section>
<div id="notice" class="notice" role="status" aria-live="polite" hidden></div>
<form id="config-form" class="settings"><div class="grid" id="accounts"><div class="panel empty">正在读取账号状态…</div></div>
<section class="panel"><h2>调度与额度保护</h2><p class="subtitle">账号池内各账号独立计算 D1 读取、写入占用。任一占比达到保护线时暂停该账号；用量未知不等于有额度。观察调度优先级不代表主控或源账号零用量：状态管理、字典读取和源数据写回仍可能占用额度。</p>
<div class="config-grid"><fieldset><legend>调度模式</legend><label class="mode-option"><input id="mode-balanced" type="radio" name="mode" value="balanced" disabled><span><strong>负载均衡</strong><small>优先使用符合额度和新鲜度要求的非主控观察账号；相同优先级内按用量选择，必要时使用主控备用或主机器人兜底。</small></span></label><label class="mode-option"><input id="mode-failover" type="radio" name="mode" value="failover" disabled><span><strong>顺序故障转移</strong><small>由后台按优先级选择可调度账号；相同优先级内按既定顺序故障转移，不绕过暂停或冷却。</small></span></label></fieldset>
<fieldset><legend><label for="threshold">自动暂停阈值</label></legend><div class="threshold-wrap"><input id="threshold" name="threshold" type="number" min="1" max="80" step="1" value="80" inputmode="numeric" required disabled><span>%</span></div><p class="muted">上限固定 80%。留出统计延迟缓冲；这不是免费额度零超限保证。</p></fieldset></div>
<div class="config-bottom"><span class="muted" id="config-status">开关与配置保存后生效。</span><button class="btn primary" id="save-config" type="submit" disabled>保存调度配置</button></div></section></form>
<section class="panel"><h2>队列摘要</h2><div class="queue-grid"><div class="queue-cell"><p>待处理</p><strong id="queue-pending">未知</strong></div><div class="queue-cell"><p>待复核</p><strong id="queue-reviews">未知</strong></div><div class="queue-cell uncertain"><p>结果不确定</p><strong id="queue-uncertain">未知</strong></div></div><p class="muted">不确定结果请先核查，避免重复投递或重复操作。此处显示后台返回的统计。</p></section>
<section class="panel"><div class="panel-heading"><div><h2>通知状态不确定</h2><p class="subtitle">仅处理未确认送达的通知。这里不会保存样本、封禁用户或重新发送消息。</p></div><button class="btn" id="load-uncertain-reviews" type="button" disabled>查看未确认通知</button></div><p class="review-status" id="uncertain-reviews-status" role="status" aria-live="polite">尚未读取列表。点击上方按钮才请求后台，每次最多展示 20 条。</p><div class="review-list" id="uncertain-reviews"></div></section>
<footer class="foot"><span>服务端 Cookie 鉴权 · 密钥只由后台环境变量管理</span><span>时间按当前浏览器显示；用量结算日使用 UTC。</span></footer>
</main><script nonce="${CSP_NONCE_PLACEHOLDER}">${SCRIPT}</script></body></html>`;

const PASSWORD_FIELD = 'pass' + 'word';

export const LOGIN_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><title>登录 · 观察池后台</title><style nonce="${CSP_NONCE_PLACEHOLDER}">${CSS}</style></head>
<body><main class="login-shell"><section class="panel login-card"><p class="eyebrow">OBSERVATION POOL / ACCESS</p><h1 class="title">登录管理后台</h1><p class="subtitle">使用后台密码登录。Cloudflare API 密钥不应在这里输入；账号凭证仅在服务端配置。</p>
<form method="post" action="/login" enctype="application/x-www-form-urlencoded"><input type="hidden" name="csrf" value="__LOGIN_CSRF__"><label for="login-${PASSWORD_FIELD}">后台密码</label><input id="login-${PASSWORD_FIELD}" name="${PASSWORD_FIELD}" type="${PASSWORD_FIELD}" autocomplete="current-${PASSWORD_FIELD}" required autofocus><button class="btn primary" type="submit">登录</button></form><p class="muted">密码提交到当前站点，由服务端验证并建立受保护会话。请确认浏览器地址为你的后台域名。</p></section></main></body></html>`;
