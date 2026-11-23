// Cloudflare-only observation control plane. No D1 binding or Telegram webhook here.
import { ADMIN_HTML, LOGIN_HTML, ADMIN_HEADERS } from './admin-page.mjs';
import { authenticatedBearer, validSession, handleLogin, loginPage, htmlPage, sameOrigin, clearCookie } from './auth.mjs';
import { ProtocolError, readJson, json, validateMessageInput, validateDictionaryInput, validVector, MAX_DICTIONARY_BYTES } from './protocol.mjs';
import { READ_LIMIT, WRITE_LIMIT, MAX_THRESHOLD, MAX_USAGE_AGE, utcDay, parseD1Usage, mergeUsage, eligibleAccounts, availability, usageRatio } from './quota.mjs';

export const RUNTIME_REVISION = 'pool-login-labels-v4';
export const REFRESH_MS = 60_000;
export const SYNC_MS = 600_000;
export const DICTIONARY_MAX_AGE = 86_400_000;
export const MAX_QUEUE = 1000;
export const CONTENT_DEDUPE_MS = 30 * 86_400_000;
const NOTICE_SEED_VERSION = 'content-fields-v3';
const NOTICE_SEED_PAGE = 200;
const LEASE_MS = 240_000;
const RESERVE_READ = 10, RESERVE_WRITE = 2;
const ACTIVE = ['processing', 'notifying', 'notify_pending', 'review', 'sync_pending', 'notification_uncertain'];
const object = x => x && typeof x === 'object' && !Array.isArray(x);
const escape = x => String(x ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const positiveId = x => Number.isSafeInteger(x) && x > 0;
const finiteNonNegative = x => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const NOTICE_KINDS = ['candidate', 'fingerprint', 'semantic', 'normal'];
const RULE_FIELDS = Object.freeze({ text: '正文', quote: '引用', card_name: '名片名字', name: '姓名', username: '用户名', bio: '简介' });
function ruleMetadata(result) {
  const kind = NOTICE_KINDS.includes(result?.kind) ? result.kind : 'candidate';
  const reason = ['ai_ad', 'structure', 'ai_unavailable', 'legacy_review', 'manual_spam', 'blacklisted'].includes(result?.reason)
    ? result.reason : result?.reason === '主动 /spam 举报' ? 'manual_spam' : 'unknown';
  const value = { kind, reason };
  if (Object.hasOwn(RULE_FIELDS, result?.matched_field)) value.matched_field = result.matched_field;
  // A candidate carrying hit-like fields is still a candidate, never a semantic
  // or fingerprint match. Persist only small validated classification metadata.
  if (kind === 'fingerprint' && positiveId(result?.fingerprint_id)) value.fingerprint_id = result.fingerprint_id;
  if (kind === 'semantic') {
    if (positiveId(result?.sample_id)) value.sample_id = result.sample_id;
    if (finiteNonNegative(result?.similarity) && result.similarity <= 1) value.similarity = result.similarity;
  }
  return value;
}
function savedRule(row) {
  try {
    const value = JSON.parse(row?.result || 'null')?.classification;
    return object(value) && NOTICE_KINDS.includes(value.kind) ? ruleMetadata(value) : null;
  } catch { return null; }
}
export function describeRule(result) {
  const rule = ruleMetadata(result);
  const field = RULE_FIELDS[rule.matched_field];
  const scope = field ? '（' + field + '）' : '';
  if (rule.kind === 'fingerprint') return '指纹命中' + (rule.fingerprint_id ? ' #' + rule.fingerprint_id : '') + scope;
  if (rule.kind === 'semantic') return 'AI 语义命中' + (rule.sample_id ? '（样本 #' + rule.sample_id + '）' : '')
    + (rule.similarity !== undefined ? '，相似度 ' + (rule.similarity * 100).toFixed(1) + '%' : '') + scope;
  if (rule.kind === 'normal' || rule.reason === 'blacklisted') return rule.reason === 'blacklisted' ? '黑名单用户，静默跳过' : '无需复核，静默跳过';
  if (rule.reason === 'ai_ad') return 'AI 文本判定广告：指纹/语义未命中，经 AI 文本判定（非语义或指纹命中）' + scope;
  if (rule.reason === 'structure') return '结构规则命中，待人工复核' + scope;
  if (rule.reason === 'ai_unavailable') return 'AI 不可用，待人工复核' + scope;
  if (rule.reason === 'manual_spam') return '主动 /spam 举报，待人工复核' + scope;
  if (rule.reason === 'legacy_review') return '历史观察复核，原分类规则未记录' + scope;
  // Never echo free-form provider reasons or invent a missing historic verdict.
  return '分类规则未记录，待人工复核' + scope;
}
export async function digest(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('');
}
function safeFailure(error) {
  if (error instanceof ProtocolError) return error.error;
  if (Number.isSafeInteger(error?.status)) return 'http_' + error.status;
  const text = String(error?.message || '');
  const known = [
    [/illegal invocation/i, 'illegal_invocation'],
    [/redirect.*(mode|error)|invalid redirect/i, 'redirect_option'],
    [/TextDecoder|fatal.*option/i, 'text_decoder_option'],
    [/invalid.*(signal|abort)|AbortSignal/i, 'abort_signal_option'],
    [/fetch failed|network|connection|DNS|TLS/i, 'network_unavailable'],
    [/body.*(locked|used)|stream.*(locked|closed)/i, 'body_stream_state'],
    [/read.?only|immutable/i, 'immutable_value'],
    [/disallowed operation|operation not permitted/i, 'operation_not_permitted'],
  ];
  for (const [pattern, code] of known) if (pattern.test(text)) return code;
  if (['TimeoutError', 'AbortError', 'TypeError', 'ReferenceError'].includes(error?.name)) return error.name;
  return 'upstream_unavailable';
}
async function fetchJson(url, options = {}, ms = 15000, maximum = MAX_DICTIONARY_BYTES) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(url, { ...options, headers: { 'User-Agent': 'tg-observe-pool/1.0', ...options.headers }, redirect: 'manual', signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel();
      const error = new Error('upstream_unavailable'); error.status = response.status; throw error;
    }
    return await readJson(response, maximum);
  } finally { clearTimeout(timer); }
}
export function accountConfig(env) {
  let rows; try { rows = JSON.parse(env.POOL_ACCOUNTS || '[]'); } catch { throw new Error('invalid_pool_config'); }
  if (!Array.isArray(rows) || !rows.length || rows.length > 8) throw new Error('invalid_pool_config');
  const seen = new Set();
  return rows.map((row, index) => {
    if (!object(row) || !/^[-a-zA-Z0-9_]{1,32}$/.test(row.alias) || seen.has(row.alias) || !/^[a-f0-9]{32}$/i.test(row.accountId)) throw new Error('invalid_pool_config');
    const url = new URL(row.url);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.workers.dev') || url.username || url['pass' + 'word'] || url.search || url.hash || url.pathname !== '/') throw new Error('invalid_pool_url');
    if (!/^\w{1,64}$/.test(row.nodeTokenEnv) || !/^\w{1,64}$/.test(row.analyticsTokenEnv) || !env[row.nodeTokenEnv] || !env[row.analyticsTokenEnv]) throw new Error('missing_pool_secret');
    seen.add(row.alias);
    return { ...row, url: url.origin, index, enabled: true, readLimit: READ_LIMIT, writeLimit: WRITE_LIMIT, rowsRead: null, rowsWritten: null,
      observedAt: null, day: null, version: null, error: null, localReads: 0, localWrites: 0, cooldownUntil: 0, lastDispatch: 0 };
  });
}

export class ObservePool {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.sql = ctx.storage.sql;
    this.refreshing = null; this.syncing = null; this.flushing = null;
    this.pending = new Set(); this.activeApprovals = new Set(); this.reserved = new Map();
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec('CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
      this.sql.exec(`CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY,event_key TEXT UNIQUE NOT NULL,message TEXT NOT NULL,
        status TEXT NOT NULL,evidence TEXT,kind TEXT,reason TEXT,node TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
        telegram_mid INTEGER,result TEXT)`);
      this.sql.exec('CREATE INDEX IF NOT EXISTS events_status_time ON events(status,updated_at)');
      this.sql.exec('CREATE TABLE IF NOT EXISTS notice_keys (hash TEXT PRIMARY KEY,event_id TEXT NOT NULL,created_at INTEGER NOT NULL)');
      this.sql.exec('CREATE INDEX IF NOT EXISTS notice_keys_time ON notice_keys(created_at)');
      this.sql.exec('CREATE TABLE IF NOT EXISTS blocked_users (user_id TEXT PRIMARY KEY,created_at INTEGER NOT NULL)');
      this.sql.exec('CREATE TABLE IF NOT EXISTS hits (sample_id INTEGER PRIMARY KEY,total INTEGER NOT NULL,synced INTEGER NOT NULL DEFAULT 0)');
      this.sql.exec('CREATE TABLE IF NOT EXISTS hit_batches (id TEXT PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL)');
      this.sql.exec('CREATE TABLE IF NOT EXISTS auth_attempts (key TEXT PRIMARY KEY,time INTEGER NOT NULL,count INTEGER NOT NULL)');
      this.accounts = accountConfig(env).map(a => ({ ...a, ...this.get('account:' + a.alias, {}) }));
      const stored = this.get('config', {});
      this.config = { mode: ['balanced', 'failover'].includes(stored.mode) ? stored.mode : 'balanced',
        threshold: Number.isFinite(stored.threshold) && stored.threshold >= 0.1 ? Math.min(MAX_THRESHOLD, stored.threshold) : MAX_THRESHOLD,
        manualPaused: stored.manualPaused === true };
      this.dictionary = this.get('dictionary', null); this.version = this.get('dictionary_version', '');
      this.groups = this.get('observe_groups', []); this.syncedAt = this.get('synced_at', 0);
      this.dictionaryEpoch = this.get('dictionary_epoch', 0);
      // Seed content claims from already sent reviews so upgrading does not
      // push the backlog's identical messages again under new message IDs.
      if (this.get('notice_claims_seeded', '') !== NOTICE_SEED_VERSION) await this.seedNoticeClaims();
      // Once this revision is adopted, reschedule maintenance and expose its
      // marker so deployment checks do not mistake deferred old code for new.
      if (this.get('runtime_revision', '') !== RUNTIME_REVISION) {
        this.put('runtime_revision', RUNTIME_REVISION);
        await ctx.storage.setAlarm(Date.now() + 1000);
      } else if (!await ctx.storage.getAlarm()) await ctx.storage.setAlarm(Date.now() + 1000);
    });
  }
  get(key, fallback) {
    const row = this.sql.exec('SELECT value FROM state WHERE key=?', key).toArray()[0];
    try { return row ? JSON.parse(row.value) : fallback; } catch { return fallback; }
  }
  put(key, value) { this.sql.exec('INSERT INTO state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value)); }
  saveAccount(a) {
    this.put('account:' + a.alias, { enabled: a.enabled, rowsRead: a.rowsRead, rowsWritten: a.rowsWritten, readLimit: a.readLimit, writeLimit: a.writeLimit,
      observedAt: a.observedAt, day: a.day, version: a.version, error: a.error, localReads: a.localReads, localWrites: a.localWrites,
      cooldownUntil: a.cooldownUntil, lastDispatch: a.lastDispatch });
  }
  selected() {
    const projected = this.accounts.map(a => ({ ...a, localReads: (a.localReads || 0) + (this.reserved.get(a.alias) || 0) * RESERVE_READ,
      localWrites: (a.localWrites || 0) + (this.reserved.get(a.alias) || 0) * RESERVE_WRITE }));
    return eligibleAccounts(projected, this.version, this.config).map(a => this.accounts.find(item => item.alias === a.alias));
  }
  queued() { return Number(this.sql.exec('SELECT COUNT(*) n FROM events WHERE status IN (' + ACTIVE.map(() => '?').join(',') + ')', ...ACTIVE).toArray()[0].n); }
  pauseReason() {
    if (this.config.manualPaused) return 'manual_pause';
    if (!this.dictionary || !this.version || Date.now() - this.syncedAt < 0 || Date.now() - this.syncedAt > DICTIONARY_MAX_AGE) return 'dictionary_unavailable';
    if (!this.selected().length) return 'all_accounts_unavailable';
    if (this.queued() >= MAX_QUEUE) return 'queue_full';
    return null;
  }
  status() { const reason = this.pauseReason(); return { ok: true, observe_allowed: !reason, reason: reason || 'ready', checked_at: Date.now(), retry_after: 60 }; }
  async refresh(force = false) {
    if (this.refreshing) return this.refreshing;
    if (!force && this.accounts.every(a => a.observedAt && Date.now() - a.observedAt >= 0 && Date.now() - a.observedAt < REFRESH_MS && a.day === utcDay())) return;
    this.refreshing = (async () => {
      for (const account of this.accounts) {
        const day = utcDay();
        try {
          const data = await fetchJson('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.env[account.analyticsTokenEnv] },
            body: JSON.stringify({ query: 'query($a:string!,$d:Date!){viewer{accounts(filter:{accountTag:$a}){d1AnalyticsAdaptiveGroups(limit:1,filter:{date_geq:$d,date_leq:$d}){sum{rowsRead rowsWritten}}}}}', variables: { a: account.accountId, d: day } }) }, 10000, 65536);
          const usage = parseD1Usage(data);
          if (!usage || day !== utcDay()) throw new Error('usage_unknown');
          Object.assign(account, mergeUsage(account, usage)); this.put('usage_error:' + account.alias, null);
        } catch (error) { account.error = 'usage_unknown'; this.put('usage_error:' + account.alias, safeFailure(error)); }
        this.saveAccount(account);
      }
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  sourceUsageAllowed() {
    const source = this.accounts.find(a => a.alias === this.env.SOURCE_ALIAS);
    if (!source || source.error || source.day !== utcDay() || !Number.isFinite(source.observedAt)
        || Date.now() - source.observedAt < 0 || Date.now() - source.observedAt > MAX_USAGE_AGE) return false;
    const ratio = usageRatio(source);
    return ratio !== null && ratio < this.config.threshold;
  }
  invalidateDictionary() {
    this.dictionaryEpoch += 1;
    this.syncedAt = Math.min(this.syncedAt, Date.now() - SYNC_MS - 1);
    this.put('dictionary_epoch', this.dictionaryEpoch);
    this.put('synced_at', this.syncedAt);
  }
  async source(path, body) {
    if (!this.env.BETA_URL || !this.env.BETA_CONTROL_TOKEN) throw new Error('beta_unconfigured');
    const url = new URL(this.env.BETA_URL);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.workers.dev') || url.username || url['pass' + 'word'] || url.search || url.hash || url.pathname !== '/') throw new Error('invalid_beta_url');
    // Charge a conservative source budget before awaiting any network work. This
    // closes the concurrent-approval gap and persists uncertain request cost.
    const source = this.accounts.find(a => a.alias === this.env.SOURCE_ALIAS);
    if (!this.sourceUsageAllowed()) throw new Error('source_quota_paused');
    const sampleCount = this.dictionary?.samples?.length || 256;
    const fingerprintCount = this.dictionary?.fingerprints?.length || 64;
    const budget = path === '/api/pool/dictionary'
      ? { rowsRead: 52_000, rowsWritten: 0 } // seven bounded source tables, including blacklist, cap+1 overflow and schema margin
      : path === '/api/pool/hits'
        ? { rowsRead: Math.max(256, sampleCount + fingerprintCount * 4), rowsWritten: (body?.hits?.length || 0) * 4 + 100 }
        : ['/api/pool/legacy-report', '/api/pool/user-status'].includes(path)
          ? { rowsRead: 4, rowsWritten: 0 }
          : { rowsRead: Math.max(512, sampleCount * 6 + fingerprintCount * 4), rowsWritten: 100 };
    const projected = { ...source, localReads: (source.localReads || 0) + budget.rowsRead,
      localWrites: (source.localWrites || 0) + budget.rowsWritten };
    if (usageRatio(projected) >= this.config.threshold) throw new Error('source_budget_reserved');
    this.addMetrics(source, budget); this.saveAccount(source);
    return fetchJson(url.origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.env.BETA_CONTROL_TOKEN },
      body: body === undefined ? undefined : JSON.stringify(body) }, 20000, MAX_DICTIONARY_BYTES);
  }
  async sync(force = false) {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      if (force || Date.now() - this.syncedAt > SYNC_MS || !this.dictionary) {
        // Source reads also stop at the protected limit. Neither bootstrap nor
        // a manual sync button may turn unknown usage into a quota bypass.
        if (!this.sourceUsageAllowed()) {
          this.put('sync_error', 'source_quota_paused');
        } else {
          try {
            const epoch = this.dictionaryEpoch;
            const snapshot = await this.source('/api/pool/dictionary');
            if (snapshot.ok !== true || !object(snapshot.data) || !Array.isArray(snapshot.data.samples) || !Array.isArray(snapshot.observe_groups)
                || snapshot.observe_groups.length > 1000 || snapshot.observe_groups.some(id => typeof id !== 'string' || !/^-[1-9]\d{1,15}$/.test(id))) throw new Error('dictionary_unavailable');
            snapshot.data.samples = snapshot.data.samples.map(s => ({ ...s, count: 0, embedding: validVector(s.embedding) ? s.embedding.map(x => Math.round(x * 1e6) / 1e6) : null }));
            const validated = validateDictionaryInput({ version: await digest(JSON.stringify(snapshot.data)), data: snapshot.data });
            if (!validated.ok) throw new Error('dictionary_invalid');
            const version = await digest(JSON.stringify(validated.data));
            if (new TextEncoder().encode(JSON.stringify({ version, data: validated.data })).length > MAX_DICTIONARY_BYTES) throw new Error('dictionary_too_large');
            if (epoch !== this.dictionaryEpoch) throw new Error('dictionary_changed_during_sync');
            this.dictionary = validated.data; this.version = version; this.groups = [...new Set(snapshot.observe_groups)]; this.syncedAt = Date.now();
            this.ctx.storage.transactionSync(() => {
              this.put('dictionary', this.dictionary); this.put('dictionary_version', this.version); this.put('observe_groups', this.groups);
              this.put('synced_at', this.syncedAt); this.put('sync_error', null); this.put('sync_diagnostic', null);
              if (Array.isArray(this.dictionary.blacklist)) {
                this.sql.exec('DELETE FROM blocked_users');
                for (const userId of this.dictionary.blacklist) this.sql.exec('INSERT INTO blocked_users(user_id,created_at) VALUES (?,?)', userId, Date.now());
              }
            });
          } catch (error) { this.put('sync_error', 'source_unavailable'); this.put('sync_diagnostic', safeFailure(error)); }
        }
      }
      if (!this.dictionary) return;
      const version = this.version, dictionary = this.dictionary;
      for (const a of this.accounts) {
        if (!a.enabled || a.version === version || availability({ ...a, version }, version, this.config.threshold)) continue;
        try {
          const response = await fetchJson(a.url + '/dictionary', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.env[a.nodeTokenEnv] }, body: JSON.stringify({ version, data: dictionary }) }, 20000, 65536);
          if (response.ok !== true || response.version !== version) throw new Error('sync_failed');
          a.version = version; a.cooldownUntil = 0; this.addMetrics(a, response.metrics);
        } catch { a.cooldownUntil = Date.now() + REFRESH_MS; }
        this.saveAccount(a);
      }
    })().finally(() => { this.syncing = null; });
    return this.syncing;
  }
  addMetrics(a, metrics, fallback = false) {
    a.localReads = (a.localReads || 0) + (finiteNonNegative(metrics?.rowsRead) ? metrics.rowsRead : fallback ? RESERVE_READ : 0);
    a.localWrites = (a.localWrites || 0) + (finiteNonNegative(metrics?.rowsWritten) ? metrics.rowsWritten : fallback ? RESERVE_WRITE : 0);
  }
  state() {
    const now = Date.now();
    const count = statuses => Number(this.sql.exec('SELECT COUNT(*) n FROM events WHERE status IN (' + statuses.map(() => '?').join(',') + ')', ...statuses).toArray()[0].n);
    return { ok: true, data: { paused: !!this.pauseReason(), reason: this.pauseReason() || 'ready', mode: this.config.mode, threshold: this.config.threshold,
      utcDay: utcDay(), runtimeRevision: RUNTIME_REVISION, version: this.version, syncedAt: this.syncedAt, syncError: this.get('sync_error', null), syncDiagnostic: this.get('sync_diagnostic', null),
      accounts: this.accounts.map(a => ({ alias: a.alias, enabled: a.enabled, rowsRead: a.rowsRead, rowsWritten: a.rowsWritten, readLimit: a.readLimit, writeLimit: a.writeLimit,
        percent: usageRatio(a), localReads: a.localReads, localWrites: a.localWrites, lastDispatch: a.lastDispatch, diagnostic: this.get('usage_error:' + a.alias, null), day: a.day, observedAt: a.observedAt,
        fresh: a.day === utcDay() && Number.isFinite(a.observedAt) && now - a.observedAt >= 0 && now - a.observedAt <= MAX_USAGE_AGE,
        eligible: !availability(a, this.version, this.config.threshold), error: availability(a, this.version, this.config.threshold), cooldownUntil: a.cooldownUntil })),
      queue: { pending: count(['processing', 'retry', 'notify_pending', 'sync_pending']), reviews: count(['review']), uncertain: count(['notifying', 'notification_uncertain']) } } };
  }
  async tg(method, body) {
    if (!this.env.BOT_TOKEN) throw new Error('telegram_unconfigured');
    return fetchJson('https://api.telegram.org/bot' + this.env.BOT_TOKEN + '/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 12000, 65536);
  }
  event(id) { return this.sql.exec('SELECT * FROM events WHERE id=?', id).toArray()[0]; }
  async seedNoticeClaims() {
    let progress = this.get('notice_seed_cursor', null);
    if (progress?.version !== NOTICE_SEED_VERSION) progress = { version: NOTICE_SEED_VERSION, since: Date.now() - CONTENT_DEDUPE_MS, time: 0, id: '' };
    for (;;) {
      const rows = this.sql.exec("SELECT id,message,evidence,kind,created_at FROM events WHERE status IN ('review','approved','notification_uncertain','notifying') AND created_at>=? AND (created_at>? OR (created_at=? AND id>?)) ORDER BY created_at,id LIMIT ?", progress.since, progress.time, progress.time, progress.id, NOTICE_SEED_PAGE).toArray();
      if (!rows.length) break;
      const claims = await Promise.all(rows.map(async row => {
        try { return { hash: await this.noticeHash(JSON.parse(row.message), { evidence: row.evidence, matched_field: row.kind }), id: row.id, time: row.created_at }; }
        catch { return null; }
      }));
      const last = rows[rows.length - 1];
      progress = { ...progress, time: last.created_at, id: last.id };
      this.ctx.storage.transactionSync(() => {
        for (const claim of claims.filter(Boolean)) this.sql.exec('INSERT OR IGNORE INTO notice_keys(hash,event_id,created_at) VALUES (?,?,?)', claim.hash, claim.id, claim.time);
        this.put('notice_seed_cursor', progress);
      });
    }
    this.put('notice_claims_seeded', NOTICE_SEED_VERSION);
  }
  knownBlocked(userId) {
    return (this.dictionary?.blacklist || []).includes(userId)
      || Boolean(this.sql.exec('SELECT 1 x FROM blocked_users WHERE user_id=?', userId).toArray()[0]);
  }
  async noticeHash(message, result) {
    const field = result?.matched_field || 'text';
    const supplied = field === 'card_name' ? message.contact_name || result?.evidence : message[field] || result?.evidence;
    // Exact, full-field content hash: keep links/handles/emoji, unlike semantic
    // normalization, and never dedupe by a 700/2000-character preview prefix.
    const content = String(supplied || '').normalize('NFKC').trim();
    if (!content) return digest(JSON.stringify(['id_report', message.user_id, field]));
    const parts = [message.text || '', message.quote || '', message.contact_name || ''].map(value => String(value).normalize('NFKC').trim());
    return digest(JSON.stringify(['content', ...parts, ...(parts.some(Boolean) ? [] : [content])]));
  }
  async notify(id, message, result) {
    // Descriptions are display-only; even a direct caller cannot turn a known
    // semantic/fingerprint/normal verdict into a new Telegram review.
    if (NOTICE_KINDS.includes(result?.kind) && result.kind !== 'candidate') return;
    const remembered = savedRule(this.event(id));
    const classification = ruleMetadata(NOTICE_KINDS.includes(result?.kind) ? result : remembered || result);
    if (classification.kind !== 'candidate') return;
    this.sql.exec("UPDATE events SET result=? WHERE id=? AND status IN ('notifying','notify_pending')", JSON.stringify({ classification }), id);
    if (this.config.manualPaused || !this.selected().length) {
      this.sql.exec("UPDATE events SET status='notify_pending',reason='observation_paused',updated_at=? WHERE id=? AND status IN ('notifying','notify_pending')", Date.now(), id);
      return;
    }
    if (this.knownBlocked(message.user_id)) {
      this.sql.exec("UPDATE events SET status='ignored',reason='blacklisted',updated_at=? WHERE id=? AND status IN ('notifying','notify_pending')", Date.now(), id);
      return;
    }
    // A stale pool snapshot must not send a fresh alert for an already banned
    // user. One indexed read only for candidates; known semantic hits stay local.
    let current;
    try {
      current = await this.source('/api/pool/user-status', { user_id: message.user_id });
      if (current.ok !== true || typeof current.blacklisted !== 'boolean') throw new Error('invalid_user_status');
    } catch {
      this.sql.exec("UPDATE events SET status='notify_pending',reason='blacklist_check_pending',updated_at=? WHERE id=? AND status IN ('notifying','notify_pending')", Date.now(), id);
      return;
    }
    if (this.config.manualPaused || !this.selected().length) {
      this.sql.exec("UPDATE events SET status='notify_pending',reason='observation_paused',updated_at=? WHERE id=? AND status IN ('notifying','notify_pending')", Date.now(), id);
      return;
    }
    if (current.blacklisted || this.knownBlocked(message.user_id)) {
      this.sql.exec('INSERT INTO blocked_users(user_id,created_at) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET created_at=excluded.created_at', message.user_id, Date.now());
      this.sql.exec("UPDATE events SET status='ignored',reason='blacklisted',updated_at=? WHERE id=? AND status IN ('notifying','notify_pending')", Date.now(), id);
      return;
    }
    const hash = await this.noticeHash(message, result);
    const previous = this.sql.exec('SELECT event_id FROM notice_keys WHERE hash=? AND created_at>=?', hash, Date.now() - CONTENT_DEDUPE_MS).toArray()[0];
    const stored = this.event(id);
    if (!stored || !['notifying', 'notify_pending'].includes(stored.status)) return;
    if (previous) {
      this.sql.exec("UPDATE events SET status='ignored',reason='duplicate_content',updated_at=? WHERE id=? AND status IN ('notifying','notify_pending')", Date.now(), id);
      return;
    }
    // Persist the send claim before Telegram await, across concurrent events,
    // nodes and restarts. Uncertain delivery is never sent again blindly.
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('INSERT INTO notice_keys(hash,event_id,created_at) VALUES (?,?,?) ON CONFLICT(hash) DO UPDATE SET event_id=excluded.event_id,created_at=excluded.created_at', hash, id, Date.now());
      this.sql.exec("UPDATE events SET status='notifying',updated_at=? WHERE id=? AND status IN ('notifying','notify_pending')", Date.now(), id);
    });
    const owner = String(this.env.OWNER_ID || '');
    if (!/^[1-9]\d{0,15}$/.test(owner)) throw new Error('owner_unconfigured');
    // Mark before dispatch; loss of the send response is never silently retried.
    const preview = String(result.evidence || '').slice(0, 700);
    try {
      const response = await this.tg('sendMessage', { chat_id: owner, parse_mode: 'HTML', text: '👀 观察池待复核\n\n👤 用户 <code>' + escape(message.user_id) + '</code>（' + escape([message.first_name, message.last_name].filter(Boolean).join(' ')) + '）\n📍 ' + escape(message.chat_title || message.chat_id) + '\n🎯 ' + escape(describeRule(classification)) + '\n📄 <code>' + escape(preview || '（按 ID 举报，无正文）') + '</code>\n\n确认后保存样本并在主群/授权群封禁；不操作观察来源群。',
        reply_markup: { inline_keyboard: [[{ text: '✅ 是广告，抓样本并封禁', callback_data: 'op:save:' + id }, { text: '🚫 误判，放行', callback_data: 'op:dismiss:' + id }]] } });
      if (response.ok !== true || !positiveId(response.result?.message_id)) throw new Error('notification_uncertain');
      this.sql.exec("UPDATE events SET status='review',telegram_mid=?,updated_at=? WHERE id=? AND status='notifying'", response.result.message_id, Date.now(), id);
    } catch { this.sql.exec("UPDATE events SET status='notification_uncertain',reason='notification_uncertain',updated_at=? WHERE id=? AND status='notifying'", Date.now(), id); }
  }
  async manualTargets(message, parentId) {
    const command = message.text.trim().match(/^\/spam(?:@[A-Za-z0-9_]+)?(?:\s+(.*))?$/is);
    if (!command) return null;
    const arg = (command[1] || '').trim();
    let targets;
    if (arg) {
      const parts = arg.split(/[,，]/).map(x => x.trim());
      if (parts.length > 20 || parts.some(x => !/^[1-9]\d{0,15}$/.test(x))) throw new ProtocolError(400, 'invalid_spam_targets');
      targets = [...new Set(parts)];
    } else targets = message.reply ? [message.reply.user_id] : [];
    const subject = targets.length === 1 && message.reply?.user_id === targets[0] ? message.reply : null;
    return Promise.all(targets.map(async userId => {
      const childId = (await digest(parentId + ':' + userId)).slice(0, 24);
      const childMessage = { ...message, user_id: userId, text: subject?.text || '', quote: subject?.quote || '', contact_name: subject?.contact_name || '', first_name: subject?.first_name || '', last_name: subject?.last_name || '', username: subject?.username || '' };
      delete childMessage.reply;
      const field = subject?.text ? 'text' : subject?.quote ? 'quote' : subject?.contact_name ? 'card_name' : 'text';
      const evidence = subject ? (field === 'card_name' ? subject.contact_name : subject[field]) : '';
      return { id: childId, message: childMessage, result: { kind: 'candidate', reason: '主动 /spam 举报', evidence, matched_field: field } };
    }));
  }
  async ingest(input) {
    const validated = validateMessageInput(input); if (!validated.ok) return json(400, { ok: false, error: validated.error });
    const message = validated.message;
    if (!this.groups.includes(message.chat_id)) return json(403, { ok: false, error: 'group_not_allowed' });
    const key = message.chat_id + ':' + message.message_id, id = (await digest(key)).slice(0, 24);
    let existing = this.event(id);
    if (existing && !['processing', 'retry'].includes(existing.status)) return json(200, { ok: true, accepted: true, event_id: id, status: 'duplicate' });
    const manual = await this.manualTargets(message, id);
    if (!manual && this.knownBlocked(message.user_id)) {
      this.sql.exec("INSERT INTO events(id,event_key,message,status,reason,created_at,updated_at) VALUES (?,?,?,'ignored','blacklisted',?,?) ON CONFLICT(id) DO UPDATE SET status='ignored',reason='blacklisted',updated_at=excluded.updated_at", id, key, JSON.stringify(message), Date.now(), Date.now());
      return json(200, { ok: true, accepted: true, event_id: id, status: 'blacklisted' });
    }
    await this.refresh();
    if (this.pauseReason()) return json(503, { ok: false, paused: true, error: this.pauseReason(), retryAfter: 60 });
    if (this.pending.has(id)) return json(409, { ok: false, error: 'busy' });
    existing = this.event(id);
    if (existing && !['processing', 'retry'].includes(existing.status)) return json(200, { ok: true, accepted: true, event_id: id, status: 'duplicate' });
    if (existing?.status === 'processing' && Date.now() - existing.updated_at < LEASE_MS) return json(409, { ok: false, error: 'busy' });
    if (this.queued() + (manual?.length || 1) > MAX_QUEUE) return json(503, { ok: false, paused: true, error: 'queue_full', retryAfter: 60 });
    this.pending.add(id);
    this.sql.exec("INSERT INTO events(id,event_key,message,status,created_at,updated_at) VALUES (?,?,?,'processing',?,?) ON CONFLICT(id) DO UPDATE SET status='processing',updated_at=excluded.updated_at", id, key, JSON.stringify(message), Date.now(), Date.now());
    try {
      if (manual) {
        for (const child of manual) {
          if (this.event(child.id)) continue;
          this.sql.exec("INSERT INTO events(id,event_key,message,status,evidence,kind,reason,created_at,updated_at) VALUES (?,?,?,'notifying',?,?,?,?,?)", child.id, key + ':' + child.message.user_id, JSON.stringify(child.message), String(child.result.evidence || '').slice(0, 2000), child.result.matched_field, child.result.reason, Date.now(), Date.now());
          await this.notify(child.id, child.message, child.result);
        }
        this.sql.exec("UPDATE events SET status='ignored',updated_at=? WHERE id=?", Date.now(), id);
        return json(200, { ok: true, accepted: true, event_id: id, status: 'command' });
      }
      let result = null, accountUsed = '';
      const version = this.version;
      for (const candidate of this.selected()) {
        if (this.config.manualPaused || version !== this.version) break;
        if (!this.selected().some(a => a.alias === candidate.alias)) continue;
        this.reserved.set(candidate.alias, (this.reserved.get(candidate.alias) || 0) + 1);
        candidate.lastDispatch = Date.now();
        try {
          const classificationMessage = { ...message }; delete classificationMessage.reply;
          const response = await fetchJson(candidate.url + '/classify', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.env[candidate.nodeTokenEnv] }, body: JSON.stringify({ version, message: classificationMessage }) }, 20000, 65536);
          if (response.ok !== true || response.version !== version || version !== this.version || !['fingerprint', 'semantic', 'normal', 'candidate'].includes(response.kind)
              || !finiteNonNegative(response.metrics?.rowsRead) || !finiteNonNegative(response.metrics?.rowsWritten)
              || (response.kind === 'semantic' && !positiveId(response.sample_id))
              || (response.evidence != null && (typeof response.evidence !== 'string' || response.evidence.length > 2000))) throw new Error('invalid_node_response');
          this.addMetrics(candidate, response.metrics); candidate.cooldownUntil = 0; result = response; accountUsed = candidate.alias;
        } catch (error) {
          this.addMetrics(candidate, null, true);
          candidate.cooldownUntil = Date.now() + REFRESH_MS;
          // A cold/recreated node may have lost its snapshot. Invalidate the local
          // sync marker so the next maintenance pass re-uploads the same version.
          if (error?.status === 409) candidate.version = null;
        }
        finally { this.reserved.set(candidate.alias, Math.max(0, (this.reserved.get(candidate.alias) || 1) - 1)); }
        // Local accounting persists for crash recovery; monitor also includes other databases.
        this.saveAccount(candidate);
        if (result) break;
      }
      if (!result) { this.sql.exec("UPDATE events SET status='retry',updated_at=? WHERE id=?", Date.now(), id); return json(503, { ok: false, paused: true, error: 'no_node_ready', retryAfter: 60 }); }
      this.ctx.storage.transactionSync(() => {
        this.sql.exec('UPDATE events SET status=?,evidence=?,kind=?,reason=?,node=?,updated_at=? WHERE id=?', result.kind === 'candidate' ? 'notifying' : 'ignored', String(result.evidence || '').slice(0, 2000), result.matched_field || 'text', result.reason || result.kind, accountUsed, Date.now(), id);
        if (result.kind === 'semantic') this.sql.exec('INSERT INTO hits(sample_id,total,synced) VALUES (?,1,0) ON CONFLICT(sample_id) DO UPDATE SET total=total+1', result.sample_id);
      });
      if (result.kind === 'candidate') await this.notify(id, message, result);
      return json(200, { ok: true, accepted: true, event_id: id, status: result.kind });
    } catch (error) {
      if (this.event(id)?.status === 'processing') this.sql.exec("UPDATE events SET status='retry',updated_at=? WHERE id=?", Date.now(), id);
      throw error;
    } finally { this.pending.delete(id); }
  }
  async resultNotice(event, text) {
    if (!positiveId(event.telegram_mid)) return;
    let edited;
    try { edited = await this.tg('editMessageText', { chat_id: this.env.OWNER_ID, message_id: event.telegram_mid, parse_mode: 'HTML', text, reply_markup: { inline_keyboard: [] } }); } catch {}
    if (edited?.ok !== true) await this.tg('sendMessage', { chat_id: this.env.OWNER_ID, parse_mode: 'HTML', text }).catch(() => null);
  }
  async review(body) {
    const callback = body?.callback; if (!object(callback)) return json(400, { ok: false, error: 'invalid_callback' });
    const match = String(callback.data || '').match(/^op:(save|dismiss):([a-f0-9]{24})$/);
    if (!match || typeof callback.id !== 'string' || callback.id.length > 256 || String(callback.from?.id) !== String(this.env.OWNER_ID)
        || callback.message?.chat?.type !== 'private' || String(callback.message.chat.id) !== String(this.env.OWNER_ID) || !positiveId(callback.message.message_id)) return json(403, { ok: false, error: 'owner_required' });
    const [, action, id] = match, event = this.event(id);
    const answer = text => this.tg('answerCallbackQuery', { callback_query_id: callback.id, text }).catch(() => null);
    if (!event) { await answer('记录不存在'); return json(200, { ok: true }); }
    if (!['review', 'notification_uncertain'].includes(event.status) || (event.telegram_mid && event.telegram_mid !== callback.message.message_id)) { await answer('该记录正在处理或已处理'); return json(200, { ok: true }); }
    this.sql.exec('UPDATE events SET status=?,telegram_mid=COALESCE(telegram_mid,?),updated_at=? WHERE id=?', action === 'save' ? 'sync_pending' : 'dismissed', callback.message.message_id, Date.now(), id);
    await answer(action === 'save' ? '已收到，正在同步样本和封禁结果' : '已放行');
    if (action === 'dismiss') { await this.resultNotice(this.event(id), '🚫 已放行，不保存样本或处罚。'); return json(200, { ok: true }); }
    await this.applyApproval(id); return json(200, { ok: true });
  }
  async legacyReview(body) {
    const callback = body?.callback;
    const match = String(callback?.data || '').match(/^o:(save|dismiss):([1-9]\d{0,15})$/);
    if (!object(callback) || !match || !positiveId(Number(match[2])) || typeof callback.id !== 'string' || callback.id.length > 256
        || String(callback.from?.id) !== String(this.env.OWNER_ID) || callback.message?.chat?.type !== 'private'
        || String(callback.message.chat.id) !== String(this.env.OWNER_ID) || !positiveId(callback.message.message_id)) return json(403, { ok: false, error: 'owner_required' });
    const [, action, legacyId] = match;
    const id = (await digest('legacy:' + this.env.BETA_URL + ':' + legacyId)).slice(0, 24);
    let event = this.event(id);
    if (!event) {
      let message = { chat_id: 'legacy', chat_title: '历史观察复核', message_id: Number(legacyId), user_id: '', text: '' };
      if (action === 'save') {
        await this.refresh();
        if (!this.sourceUsageAllowed()) {
          await this.tg('answerCallbackQuery', { callback_query_id: callback.id, text: '源账号额度不足或用量未知，未处罚；稍后重试', show_alert: true }).catch(() => null);
          return json(200, { ok: true, paused: true });
        }
        const response = await this.source('/api/pool/legacy-report', { report_id: Number(legacyId) });
        const report = response?.report;
        if (response?.ok !== true || !report || report.status !== 'open') {
          await this.tg('answerCallbackQuery', { callback_query_id: callback.id, text: '历史记录不存在、处理中或已处理', show_alert: true }).catch(() => null);
          return json(200, { ok: true });
        }
        if (!/^[1-9]\d{0,15}$/.test(report.user_id || '') || typeof report.body_text !== 'string' || report.body_text.length > 2000) throw new Error('invalid_legacy_report');
        message.user_id = report.user_id;
        message.text = report.body_text === '(通过 /spam 举报，无正文)' ? '' : report.body_text;
      }
      this.sql.exec("INSERT INTO events(id,event_key,message,status,evidence,kind,reason,created_at,updated_at,telegram_mid) VALUES (?,?,?,'review',?,'text','legacy_review',?,?,?) ON CONFLICT(id) DO NOTHING",
        id, 'legacy:' + legacyId, JSON.stringify(message), message.text, Date.now(), Date.now(), callback.message.message_id);
      event = this.event(id);
    }
    return await this.review({ callback: { ...callback, data: 'op:' + action + ':' + id } });
  }
  async applyApproval(id) {
    if (this.activeApprovals.has(id)) return;
    const event = this.event(id); if (!event || event.status !== 'sync_pending') return;
    this.activeApprovals.add(id);
    this.sql.exec('UPDATE events SET updated_at=? WHERE id=?', Date.now(), id);
    try {
      if (!this.sourceUsageAllowed()) throw new Error('source_quota_paused');
      const message = JSON.parse(event.message);
      const result = await this.source('/api/pool/action', { id, user_id: message.user_id, sample: { text: event.evidence || '', kind: ['text', 'quote', 'card_name'].includes(event.kind) ? event.kind : 'text' } });
      if (result.ok !== true || typeof result.summary !== 'string' || result.summary.length > 1500) throw new Error('action_failed');
      this.sql.exec("UPDATE events SET status='approved',result=?,updated_at=? WHERE id=? AND status='sync_pending'", JSON.stringify(result), Date.now(), id);
      if (result.blacklisted === true) this.sql.exec('INSERT INTO blocked_users(user_id,created_at) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET created_at=excluded.created_at', message.user_id, Date.now());
      await this.resultNotice(this.event(id), '✅ 观察复核已确认\n用户 <code>' + escape(message.user_id) + '</code>\n' + escape(result.summary));
      this.invalidateDictionary();
    } catch {
      if (this.event(id)?.status === 'sync_pending') {
        this.sql.exec("UPDATE events SET reason='approval_sync_pending',updated_at=? WHERE id=? AND status='sync_pending'", Date.now(), id);
        if (event.reason !== 'approval_sync_pending') await this.resultNotice(this.event(id), '⚠️ 已确认，Beta 同步暂不可用。保留待同步任务，未声称保存或封禁成功。');
      }
    } finally { this.activeApprovals.delete(id); }
  }
  async flushHits() {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      if (!this.sourceUsageAllowed()) return;
      let batch = this.sql.exec("SELECT id,payload FROM hit_batches WHERE status='pending' LIMIT 1").toArray()[0];
      if (!batch) {
        const rows = this.sql.exec('SELECT sample_id,MIN(total-synced,10000) count FROM hits WHERE total>synced LIMIT 50').toArray();
        if (!rows.length) return;
        batch = { id: crypto.randomUUID().replaceAll('-', ''), payload: JSON.stringify(rows) };
        this.sql.exec("INSERT INTO hit_batches(id,payload,status) VALUES (?,?,'pending')", batch.id, batch.payload);
      }
      try {
        const result = await this.source('/api/pool/hits', { id: batch.id, hits: JSON.parse(batch.payload) });
        if (result.ok !== true) return;
        this.ctx.storage.transactionSync(() => {
          const current = this.sql.exec('SELECT status FROM hit_batches WHERE id=?', batch.id).toArray()[0];
          if (current?.status !== 'pending') return;
          for (const hit of JSON.parse(batch.payload)) this.sql.exec('UPDATE hits SET synced=MIN(total,synced+?) WHERE sample_id=?', hit.count, hit.sample_id);
          this.sql.exec("UPDATE hit_batches SET status='done' WHERE id=?", batch.id);
        });
      } catch {}
    })().finally(() => { this.flushing = null; });
    return this.flushing;
  }
  async alarm() {
    try {
      await this.refresh(true); await this.sync();
      const approvals = this.sql.exec("SELECT id FROM events WHERE status='sync_pending' AND updated_at<? LIMIT 3", Date.now() - REFRESH_MS).toArray();
      for (const e of approvals) await this.applyApproval(e.id);
      if (Date.now() - this.get('last_hit_sync', 0) > SYNC_MS) { await this.flushHits(); this.put('last_hit_sync', Date.now()); }
      const notices = this.sql.exec("SELECT id,message,evidence,kind,reason,result FROM events WHERE status='notify_pending' AND updated_at<? ORDER BY updated_at LIMIT 3", Date.now() - REFRESH_MS).toArray();
      for (const notice of notices) await this.notify(notice.id, JSON.parse(notice.message), {
        ...(savedRule(notice) || { kind: 'candidate', reason: 'unknown', matched_field: notice.kind }), evidence: notice.evidence
      });
      this.sql.exec("UPDATE events SET status='notification_uncertain',reason='notification_uncertain',updated_at=? WHERE status='notifying' AND updated_at<?", Date.now(), Date.now() - LEASE_MS);
      this.sql.exec('DELETE FROM notice_keys WHERE hash IN (SELECT hash FROM notice_keys WHERE created_at<? ORDER BY created_at LIMIT 200)', Date.now() - CONTENT_DEDUPE_MS);
      this.sql.exec("DELETE FROM events WHERE id IN (SELECT id FROM events WHERE status IN ('ignored','approved','dismissed') AND updated_at<? ORDER BY updated_at LIMIT 200)", Date.now() - 7 * 86400000);
      this.sql.exec('DELETE FROM auth_attempts WHERE key IN (SELECT key FROM auth_attempts WHERE time<? LIMIT 100)', Date.now() - 3600_000);
    } catch { this.put('alarm_error', 'maintenance_unavailable'); }
    finally { await this.ctx.storage.setAlarm(Date.now() + REFRESH_MS); }
  }
  unresolved() {
    const rows = this.sql.exec("SELECT id,event_key,status,created_at,message FROM events WHERE status='notification_uncertain' ORDER BY updated_at LIMIT 20").toArray();
    const total = Number(this.sql.exec("SELECT COUNT(*) n FROM events WHERE status='notification_uncertain'").toArray()[0].n);
    return { ok: true, total, items: rows.map(row => {
      let message; try { message = JSON.parse(row.message); } catch { message = {}; }
      return { id: row.id, event_key: row.event_key, status: row.status, created_at: row.created_at,
        summary: String(message.chat_title || message.chat_id || '') + ' · 用户 ' + String(message.user_id || '') };
    }) };
  }
  async loginAttempt(key) {
    const now = Date.now(), keys = ['global', String(key || 'global').slice(0, 80)];
    for (const item of new Set(keys)) {
      const row = this.sql.exec('SELECT time,count FROM auth_attempts WHERE key=?', item).toArray()[0];
      if (row && now - row.time >= 0 && now - row.time < REFRESH_MS && row.count >= (item === 'global' ? 60 : 8)) return false;
    }
    for (const item of new Set(keys)) this.sql.exec(`INSERT INTO auth_attempts(key,time,count) VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET
      time=CASE WHEN ?-auth_attempts.time>=60000 THEN excluded.time ELSE auth_attempts.time END,
      count=CASE WHEN ?-auth_attempts.time>=60000 THEN 1 ELSE auth_attempts.count+1 END`, item, now, now, now);
    return true;
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    try {
      if (path === '/status' && request.method === 'GET') return json(200, this.status());
      if (path === '/state' && request.method === 'GET') return json(200, this.state());
      if (path === '/reviews' && request.method === 'GET') return json(200, this.unresolved());
      if (request.method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });
      if (path === '/login-attempt') return json(200, { allowed: await this.loginAttempt((await readJson(request, 4096)).key) });
      if (path === '/ingest') return await this.ingest(await readJson(request));
      if (path === '/review') return await this.review(await readJson(request));
      if (path === '/legacy-review') return await this.legacyReview(await readJson(request));
      if (path.startsWith('/control/')) {
        const command = path.slice('/control/'.length), body = await readJson(request, 8192);
        if (command === 'pause') this.config.manualPaused = true;
        else if (command === 'resume') this.config.manualPaused = false;
        else if (command === 'refresh') await this.refresh(true);
        else if (command === 'sync') { await this.refresh(true); await this.sync(true); }
        else if (command === 'resolve') {
          if (!object(body) || !/^[a-f0-9]{24}$/.test(body.id || '') || body.action !== 'dismiss') return json(400, { ok: false, error: 'invalid_resolution' });
          this.sql.exec("UPDATE events SET status='dismissed',updated_at=? WHERE id=? AND status='notification_uncertain'", Date.now(), body.id);
        }
        else if (command === 'config') {
          if (!object(body) || !['balanced', 'failover'].includes(body.mode) || !Number.isFinite(body.threshold) || body.threshold < 0.1 || body.threshold > MAX_THRESHOLD || !Array.isArray(body.accounts) || body.accounts.length !== this.accounts.length) return json(400, { ok: false, error: 'invalid_config' });
          const seen = new Set();
          for (const item of body.accounts) { const a = this.accounts.find(a => a.alias === item.alias); if (!a || seen.has(item.alias) || typeof item.enabled !== 'boolean') return json(400, { ok: false, error: 'invalid_config' }); seen.add(item.alias); }
          this.config.mode = body.mode; this.config.threshold = body.threshold;
          for (const item of body.accounts) { const a = this.accounts.find(a => a.alias === item.alias); a.enabled = item.enabled; this.saveAccount(a); }
        } else return json(404, { ok: false, error: 'not_found' });
        this.put('config', this.config); return json(200, { ok: true });
      }
      return json(404, { ok: false, error: 'not_found' });
    } catch (error) { return json(error instanceof ProtocolError ? error.status : 503, { ok: false, error: error instanceof ProtocolError ? error.error : 'controller_unavailable' }); }
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const forward = (target, body) => env.POOL.get(env.POOL.idFromName('primary')).fetch(new Request('https://pool.internal' + target, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }));
    try {
      if (path === '/health' && request.method === 'GET') return new Response('OK');
      if (path === '/login') {
        if (request.method === 'GET') return await loginPage(request, env, LOGIN_HTML, ADMIN_HEADERS);
        if (request.method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });
        return await handleLogin(request, env, async () => { const key = await digest(request.headers.get('CF-Connecting-IP') || 'global'); return (await (await forward('/login-attempt', { key })).json()).allowed === true; });
      }
      if (path === '/api/collector/status' || path === '/api/ingest') {
        if (!authenticatedBearer(request, env.COLLECTOR_TOKEN)) return json(401, { ok: false, error: 'unauthorized' });
        if (path === '/api/collector/status') return request.method === 'GET' ? await forward('/status') : json(405, { ok: false, error: 'method_not_allowed' });
        if (request.method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });
        const response = await forward('/ingest', await readJson(request));
        const headers = new Headers(response.headers); if (response.status === 503) headers.set('Retry-After', '60');
        return new Response(response.body, { status: response.status, headers });
      }
      if (path === '/api/beta/review' || path === '/api/beta/ingest' || path === '/api/beta/legacy-review') {
        if (!authenticatedBearer(request, env.BETA_CONTROL_TOKEN)) return json(401, { ok: false, error: 'unauthorized' });
        if (request.method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });
        const target = path === '/api/beta/legacy-review' ? '/legacy-review' : path === '/api/beta/review' ? '/review' : '/ingest';
        return await forward(target, await readJson(request));
      }
      if (!await validSession(request, env)) return path === '/' ? new Response(null, { status: 303, headers: { Location: '/login', 'Cache-Control': 'no-store' } }) : json(401, { ok: false, error: 'login_required' });
      if (path === '/' && request.method === 'GET') return htmlPage(ADMIN_HTML, ADMIN_HEADERS);
      if (path === '/api/admin/state' && request.method === 'GET') return await forward('/state');
      if (path === '/api/admin/reviews' && request.method === 'GET') return await forward('/reviews');
      if (path === '/logout' || path.startsWith('/api/admin/control/')) {
        if (request.method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });
        if (!sameOrigin(request) || request.headers.get('X-Control-Action') !== '1') return json(403, { ok: false, error: 'origin_rejected' });
        if (path === '/logout') return new Response(null, { status: 204, headers: { 'Set-Cookie': clearCookie } });
        return await forward('/control/' + path.slice('/api/admin/control/'.length), await readJson(request, 8192));
      }
      return json(404, { ok: false, error: 'not_found' });
    } catch (error) { return json(error instanceof ProtocolError ? error.status : 503, { ok: false, error: error instanceof ProtocolError ? error.error : 'controller_unavailable' }); }
  }
};
