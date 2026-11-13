// =============================================================================
// TGUnbanBot-Plus — Beta 重构版（从零重写，参考 Dev 不照抄）
//
// 目标：查杀广告 → 存 AI 语义 → 同类语义自动合并 → 进群命中待确认 → 确认后同指纹自动全群封禁。
// 原则：
//   · 默认只禁言当前群；只有主人 /spam 或主人点「全群封禁」按钮才全群封禁。
//   · 群管理员 /ban 只封当前群；群管理员 /spam 只上报主人、不能触发全群封禁。
//   · 纯本地 D1，不接 GKY。
// 架构见 REWRITE_SPEC.md。
// =============================================================================

// =============================================================================
// 0. 常量与阈值（可用 env 覆盖）
// =============================================================================
const DEFAULT_SCORE_THRESHOLD = 7;          // 评分定罪线
const DEFAULT_OBSERVE_SCORE = 5;            // 观察线
const DEFAULT_AI_SIMILARITY = 0.78;         // AI 语义定罪阈值
const DEFAULT_MERGE_SIMILARITY = 0.85;      // 语义合并阈值（高于定罪线：宁可少合、不误合）
const MERGE_CANDIDATE_LIMIT = 128;          // 向量近邻最多比对条数
const MERGE_VARIANTS_MAX = 8;               // 每个语义簇最多保留的变体数
const AD_EMBEDDING_MODEL = '@cf/baai/bge-m3';
const AD_EMBEDDING_DIM = 1024;
const BAN_ALL_CONCURRENCY = 3;              // 全群封禁并发上限
const MIN_SAMPLE_LEN = 4;                   // 语义样本最短长度
const FINGERPRINT_MIN_LEN = 2;              // 指纹最短长度

const TG_ROOT = 'https://api.telegram.org/bot';

// =============================================================================
// 1. 文本工具：去混淆归一化是「自动合并同类语义」的地基。
// =============================================================================
function stripEmoji(text) {
	return String(text || '').replace(/\p{Extended_Pictographic}/gu, ' ');
}

function toHalfWidth(text) {
	return String(text || '').replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
}

// 去混淆归一化：小写、去 emoji、去空白、去拆词分隔符、标点折叠。
function normalizeAdText(text) {
	let s = toHalfWidth(String(text || '')).toLowerCase();
	s = stripEmoji(s);
	s = s.replace(/[.·,、_\-]/g, '');
	s = s.replace(/\s+/g, '');
	s = s.replace(/[^\p{L}\p{N}@:+]+/gu, ' ');
	return s.replace(/\s+/g, ' ').trim();
}

// 提取文本里命中的广告关键词集合（排序后拼接成签名桶）。
function keywordSignature(text, trade, biz, weak) {
	const src = String(text || '').toLowerCase();
	const hits = [];
	for (const w of [...trade, ...biz, ...weak]) {
		const needle = String(w).toLowerCase();
		if (needle && src.includes(needle)) hits.push(needle);
	}
	return [...new Set(hits)].sort().join('|');
}

function countKeywordHits(text, keywords) {
	const src = String(text || '').toLowerCase();
	const hits = [];
	for (const w of keywords) {
		const needle = String(w).toLowerCase();
		if (needle && src.includes(needle)) hits.push(w);
	}
	return hits;
}

function stripMentionsAndLinks(text) {
	return String(text || '')
		.replace(/@[A-Za-z0-9_]{5,}/g, ' ')
		.replace(/https?:\/\/\S+/g, ' ')
		.replace(/t\.me\/\S+/g, ' ');
}

async function sha256Hex(text) {
	const data = new TextEncoder().encode(String(text));
	const digest = await crypto.subtle.digest('SHA-256', data);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function nowSeconds() { return Math.floor(Date.now() / 1000); }

// 用户内容进 HTML（<code> 等）前必须转义，否则 sendMessage(parse_mode=HTML) 会 400。
function escapeHtml(value) {
	return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// =============================================================================
// 2. 词表与判据（全新编写，参考用户提供的真实样本）
// =============================================================================
const TRADE_VERBS = [
	'收购', '出售', '出租', '转让', '批发', '代收', '代付', '代发', '接单', '收单',
	'招募', '招人', '招代理', '招下级', '招下家',
	'日结', '秒结', '当天结', '工资日结', '一组一结', '走量', '面交', '当面交易', '快递面交',
	'加V', '加微', '加薇', '免费领', '注册即送', '点击了解', '详解了解',
	'包吃住', '包住', '安排住宿', '车接车送', '日赚', '日入', '月入', '日搞'
];

const BUSINESS_KEYWORDS = [
	'usdt', '泰达', 'u商', 'du商', '网赚', '菠菜', '博彩', '棋牌', '彩票', '时时彩',
	'老账号', '四件套', '卡料', '料子', '跑分', '洗钱', '洗白', '出黑', '换汇',
	'代练', '刷单', '刷量', '刷礼物',
	'约炮', '约啪', '探花', '楼凤', '外围', '上门', '上门服务', '快餐', '包夜', '空降',
	'裸聊', '视频裸', '福利姬', '资源群',
	'假钞', '假币', '渠道正品', '全新未激活', '拍收款码', '拍私家车',
	'收益', '躺赚', '暴利', '风口项目', '好项目', '稳赚', '包赚', '无风险', '零风险'
];

const WEAK_VERBS = ['咨询', '详聊', '有需要', '进群联系', '兼职', '一单', '单价', '代理', '招聘', '小白可教', '有无经验'];

const EXEMPT_KEYWORDS = [
	'官方', '客服', '机器人', '开源', 'github', 'gitlab', '文档', '通知', '订阅', '备份',
	'监控', '签到', '翻译', '下载', '论坛', '博客', 'vless', 'vmess', 'trojan', 'shadowsocks',
	'clash', 'xray', 'sing-box', 'wireguard', 'openvpn', 'tls', '指纹', '设备指纹'
];

const SOLICIT_PATTERNS = [
	/(大量|大批|高价|长期|专业|诚[心意]|急|现金|全国|低价)\s*[收购](?!集|藏|录|纳|听|拾|割|尾|支|入|盘)/,
	/[收购]\s*[回]?\s*(号|账号|帐号|账户|卡|料|币|u\b|U\b)/,
	/(出售|出租|转让|批发|代办|代开|承接|承兑|包出|面交|快递面交)/,
	/(招|收)\s*(代理|下级|下家|车手|水军|学员|渠道)/,
	/(回收|求购|收购)/,
	/(日赚|日搞|日入|月入)\s*\d+[kKwW＋+]?/
];

const BIZ_PATTERNS = [
	/(网赌|赌博|博彩|菠菜|棋牌|彩票|六合|时时彩)/,
	/(输钱号|亏损号|老账号|实名号|四件套|卡料|跑分|黑产)/,
	/(网赚|搞钱|赚钱|日入|月入|躺赚|暴利|日赚|日搞)/,
	/(usdt|泰达|u商|du商|虚拟币|换汇|跑币)/i,
	/[收出接放]\s*(u|U)\b/, /\b(u|U)\s*[商币源]/,
	/(假钞|假币|渠道正品|全新未激活|拍收款码|拍私家车|刷礼物)/,
	/(探花|楼凤|外围|上门服务|裸聊|福利姬|约啪|约炮|快餐|包夜)/
];

function matchAnyPattern(patterns, text) {
	return patterns.some((re) => { re.lastIndex = 0; return re.test(text); });
}

// =============================================================================
// 3. 配置加载与权限
// =============================================================================
const CONFIG_TTL = 30;   // 主人/授权群缓存 30s，多 isolate 下命令新增最多 30s 后全局可见
let ownerSetCache = null;
let ownerSetExp = 0;
let groupSetCache = null;
let groupSetExp = 0;

// 主人：仅 env.OWNER_ID 一个（单主）。副主人：/add_owner 存 D1。
// 授权群：env.GROUP_ID 一个主群 + /add_group 存 D1。
async function loadOwners(env) {
	const now = nowSeconds();
	if (ownerSetCache && now < ownerSetExp) return ownerSetCache;
	const set = new Set();
	const primary = String(env.OWNER_ID || (env.OWNER_IDS || '').split(/[,，]/)[0] || '').trim();
	if (primary) set.add(primary);
	try {
		const rows = await env.DB.prepare('SELECT user_id FROM ad_owners').all();
		for (const r of rows.results || []) set.add(String(r.user_id));
	} catch (_) {}
	ownerSetCache = set;
	ownerSetExp = now + CONFIG_TTL;
	return set;
}
async function loadGroups(env) {
	const now = nowSeconds();
	if (groupSetCache && now < groupSetExp) return groupSetCache;
	const set = new Set();
	const main = String(env.GROUP_ID || (env.GROUP_IDS || '').split(/[,，]/)[0] || '').trim();
	if (main) set.add(main);
	try {
		const rows = await env.DB.prepare('SELECT chat_id FROM ad_groups').all();
		for (const r of rows.results || []) set.add(String(r.chat_id));
	} catch (_) {}
	groupSetCache = set;
	groupSetExp = now + CONFIG_TTL;
	return set;
}
function invalidateOwners() { ownerSetCache = null; ownerSetExp = 0; }
function invalidateGroups() { groupSetCache = null; groupSetExp = 0; }

async function loadConfig(env) {
	return {
		primaryOwner: String(env.OWNER_ID || (env.OWNER_IDS || '').split(/[,，]/)[0] || '').trim(),
		primaryGroup: String(env.GROUP_ID || (env.GROUP_IDS || '').split(/[,，]/)[0] || '').trim(),
		ownerIds: await loadOwners(env),
		groupIds: await loadGroups(env),
		scoreThreshold: Number(env.AD_SCORE_THRESHOLD || DEFAULT_SCORE_THRESHOLD),
		observeScore: Number(env.AD_OBSERVE_SCORE || DEFAULT_OBSERVE_SCORE),
		aiSimilarity: Number(env.AD_AI_SIMILARITY || DEFAULT_AI_SIMILARITY),
		mergeSimilarity: Number(env.AD_MERGE_SIMILARITY || DEFAULT_MERGE_SIMILARITY),
		aiEnabled: String(env.AI_ENABLED || '1') !== '0'
	};
}

function isConfiguredGroup(chatId, config) {
	const id = String(chatId || '').replace(/^-100/, '').replace(/^100/, '');
	return config.groupIds.has(id) || config.groupIds.has(String(chatId));
}

// 主人（唯一，env 配置）
function isPrimaryOwner(userId, config) {
	return String(userId) === String(config.primaryOwner || '');
}
// 主人 + 副主人（都算「主人」）
function isOwner(userId, config) {
	return config.ownerIds.has(String(userId));
}

// 用户白名单（高于黑名单，完全豁免）：内存缓存 + D1。
let userWhitelistCache = new Set();
let userWhitelistLoaded = false;
async function isUserWhitelisted(env, userId) {
	const id = String(userId);
	if (!userWhitelistLoaded) {
		userWhitelistCache = new Set();
		const rows = await env.DB.prepare('SELECT user_id FROM ad_user_whitelist').all();
		for (const r of rows.results || []) userWhitelistCache.add(String(r.user_id));
		userWhitelistLoaded = true;
	}
	return userWhitelistCache.has(id);
}
function invalidateUserWhitelist() { userWhitelistLoaded = false; }

// =============================================================================
// 4. Telegram 传输层（env.__tgMock 供离线测试注入）
// =============================================================================
async function tgCall(env, method, body) {
	if (env.__tgMock && env.__tgMock[method]) return await env.__tgMock[method](body || {});
	const token = env.TELEGRAM_BOT_TOKEN;
	const res = await fetch(`${TG_ROOT}${token}/${method}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body || {})
	});
	return await res.json();
}
async function sendMessage(env, chatId, text, extra = {}) {
	return tgCall(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
}
async function editMessageText(env, chatId, messageId, text, extra = {}) {
	return tgCall(env, 'editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...extra });
}
async function restrictMember(env, chatId, userId) {
	return tgCall(env, 'restrictChatMember', { chat_id: chatId, user_id: userId, permissions: { can_send_messages: false, can_send_media_messages: false, can_send_other_messages: false, can_add_web_page_previews: false } });
}
async function banMember(env, chatId, userId) {
	return tgCall(env, 'banChatMember', { chat_id: chatId, user_id: userId });
}
async function unbanMember(env, chatId, userId) {
	return tgCall(env, 'unbanChatMember', { chat_id: chatId, user_id: userId, only_if_banned: true }).catch(() => null);
}

// =============================================================================
// 5. D1 表结构
// =============================================================================
const SCHEMA_STATEMENTS = [
	['blacklist', `CREATE TABLE IF NOT EXISTS blacklist (
		user_id TEXT PRIMARY KEY, reason TEXT, note TEXT, by TEXT, created_at INTEGER NOT NULL)`],
	['ad_samples', `CREATE TABLE IF NOT EXISTS ad_samples (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		norm_hash TEXT UNIQUE,
		sample_text TEXT, signature TEXT,
		variants TEXT DEFAULT '[]', count INTEGER DEFAULT 1,
		embedding TEXT, dimension INTEGER,
		source TEXT, created_at INTEGER, updated_at INTEGER)`],
	['ad_fingerprints', `CREATE TABLE IF NOT EXISTS ad_fingerprints (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		type TEXT, value TEXT, norm_value TEXT,
		weight REAL DEFAULT 0.8,
		status TEXT DEFAULT 'pending',
		hit_count INTEGER DEFAULT 0, fp_count INTEGER DEFAULT 0,
		source TEXT, confirmed_by TEXT,
		created_at INTEGER, updated_at INTEGER,
		UNIQUE(type, norm_value))`],
	['ad_join_hits', `CREATE TABLE IF NOT EXISTS ad_join_hits (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id TEXT, chat_id TEXT,
		fingerprint_id INTEGER, fingerprint_value TEXT,
		action TEXT, status TEXT DEFAULT 'open',
		created_at INTEGER)`],
	['ad_user_whitelist', `CREATE TABLE IF NOT EXISTS ad_user_whitelist (
		user_id TEXT PRIMARY KEY, note TEXT, added_by TEXT, created_at INTEGER NOT NULL)`],
	['ad_owners', `CREATE TABLE IF NOT EXISTS ad_owners (
		user_id TEXT PRIMARY KEY, note TEXT, added_by TEXT, created_at INTEGER NOT NULL)`],
	['ad_groups', `CREATE TABLE IF NOT EXISTS ad_groups (
		chat_id TEXT PRIMARY KEY, title TEXT, added_by TEXT, created_at INTEGER NOT NULL)`],
	['moderation_messages', `CREATE TABLE IF NOT EXISTS moderation_messages (
		mid INTEGER, chat_id TEXT, from_id TEXT, created_at INTEGER,
		PRIMARY KEY(chat_id, mid))`],
	['ad_allowlist', `CREATE TABLE IF NOT EXISTS ad_allowlist (
		dimension TEXT, value TEXT, hit_count INTEGER DEFAULT 0, created_at INTEGER,
		PRIMARY KEY(dimension, value))`],
	['ad_exempt_keywords', `CREATE TABLE IF NOT EXISTS ad_exempt_keywords (word TEXT PRIMARY KEY)`],
	['ad_domain_whitelist', `CREATE TABLE IF NOT EXISTS ad_domain_whitelist (domain TEXT PRIMARY KEY)`],
	['ad_ban_scope', `CREATE TABLE IF NOT EXISTS ad_ban_scope (
		user_id TEXT, chat_id TEXT, reason TEXT, created_at INTEGER,
		PRIMARY KEY(user_id, chat_id))`]
];

// schema 按 isolate 只建一次（env 每个请求都是新对象，不能挂在 env 上）。
// 13 条 DDL 合并成一次 exec，冷启动从 13 次往返降到 1 次（/start 慢的主因之一）。
const SCHEMA_SQL = SCHEMA_STATEMENTS.map(([, sql]) => sql).join(';');
let schemaReady = false;
let schemaInit = null;
async function adDetectionReady(env) {
	if (!env?.DB) return false;
	if (!schemaReady) {
		if (!schemaInit) {
			schemaInit = (async () => {
				await env.DB.exec(SCHEMA_SQL);
				schemaReady = true;
				return true;
			})();
		}
		await schemaInit;
	}
	return true;
}
function resetSchemaState() { schemaReady = false; schemaInit = null; }

// =============================================================================
// 6. AI 语义层：保存 + 自动合并（R2/R3 核心增量）
// =============================================================================
async function embedText(env, text) {
	if (env.__aiMock) {
		const res = await env.__aiMock.run(AD_EMBEDDING_MODEL, { text });
		const vec = res?.data?.[0] || res?.data || res?.result;
		return Array.isArray(vec) ? vec : null;
	}
	if (!env.AI) return null;
	const res = await env.AI.run(AD_EMBEDDING_MODEL, { text });
	const vec = res?.data?.[0] || res?.data || res?.result;
	return Array.isArray(vec) ? vec : null;
}

function cosineSimilarity(a, b) {
	if (!a || !b || a.length !== b.length) return 0;
	let dot = 0, na = 0, nb = 0;
	for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
	const denom = Math.sqrt(na) * Math.sqrt(nb);
	return denom === 0 ? 0 : dot / denom;
}

// 三级合并的入口。返回 { added, merged, tier, sampleId }。
async function addAdSample(env, rawText, options = {}) {
	const normalized = normalizeAdText(rawText);
	const stripped = stripMentionsAndLinks(normalized).trim();
	if (stripped.length < MIN_SAMPLE_LEN) {
		return { ok: false, reason: 'too_short' };
	}
	const source = String(options.source || 'auto');
	const hash = await sha256Hex(normalized);
	const now = nowSeconds();
	const config = await loadConfig(env);

	// 第 1 级：归一化文本完全一致 → 只加计数。
	const existingByHash = await env.DB.prepare('SELECT id, count FROM ad_samples WHERE norm_hash = ?').bind(hash).first();
	if (existingByHash) {
		await env.DB.prepare('UPDATE ad_samples SET count = count + 1, updated_at = ? WHERE id = ?').bind(now, existingByHash.id).run();
		return { ok: true, added: false, merged: true, sampleId: existingByHash.id, tier: 1 };
	}

	const sig = keywordSignature(normalized, TRADE_VERBS, BUSINESS_KEYWORDS, WEAK_VERBS);

	// 第 2 级：关键词签名一致 → 同款变体合并。
	if (sig) {
		const sameSig = await env.DB.prepare('SELECT id, sample_text, variants, count FROM ad_samples WHERE signature = ? ORDER BY updated_at DESC LIMIT 1').bind(sig).first();
		if (sameSig) {
			await mergeVariant(env, sameSig, normalized, now);
			return { ok: true, added: false, merged: true, sampleId: sameSig.id, tier: 2 };
		}
	}

	// 第 3 级：向量近邻相似度合并。
	let embedding = null;
	if (options.computeEmbedding !== false) {
		try { embedding = await embedText(env, normalized); } catch (_) { embedding = null; }
	}
	if (embedding) {
		const candidates = await env.DB.prepare(
			'SELECT id, sample_text, variants, count, embedding FROM ad_samples WHERE embedding IS NOT NULL ORDER BY updated_at DESC LIMIT ?'
		).bind(MERGE_CANDIDATE_LIMIT).all();
		let best = { id: null, sim: 0 };
		for (const c of candidates.results || []) {
			let vec = null;
			try { vec = JSON.parse(c.embedding); } catch (_) { continue; }
			const sim = cosineSimilarity(embedding, vec);
			if (sim > best.sim) best = { id: c.id, sim };
			if (sim >= config.mergeSimilarity) break;
		}
		if (best.id && best.sim >= config.mergeSimilarity) {
			const row = await env.DB.prepare('SELECT id, variants FROM ad_samples WHERE id = ?').bind(best.id).first();
			await mergeVariant(env, row, normalized, now);
			return { ok: true, added: false, merged: true, sampleId: best.id, tier: 3, sim: best.sim };
		}
	}

	// 插入新语义簇。
	await env.DB.prepare(
		`INSERT INTO ad_samples (norm_hash, sample_text, signature, variants, count, embedding, dimension, source, created_at, updated_at)
		 VALUES (?, ?, ?, '[]', 1, ?, ?, ?, ?, ?)`
	).bind(hash, String(rawText).slice(0, 500), sig, embedding ? JSON.stringify(embedding) : null, embedding ? embedding.length : null, source, now, now).run();
	return { ok: true, added: true, merged: false, tier: 0 };
}

async function mergeVariant(env, row, normalized, now) {
	let variants = [];
	try { variants = JSON.parse(row.variants || '[]'); } catch (_) { variants = []; }
	if (!variants.includes(normalized)) {
		variants.push(normalized.slice(0, 200));
		if (variants.length > MERGE_VARIANTS_MAX) variants = variants.slice(-MERGE_VARIANTS_MAX);
	}
	await env.DB.prepare(
		'UPDATE ad_samples SET variants = ?, count = count + 1, updated_at = ? WHERE id = ?'
	).bind(JSON.stringify(variants), now, row.id).run();
}

// AI 语义命中判定：当前文本 vs 已存样本向量。
async function matchAdSemantic(env, text, config) {
	if (!config.aiEnabled) return { hit: false };
	const normalized = normalizeAdText(text);
	if (normalized.length < MIN_SAMPLE_LEN) return { hit: false };
	const hash = await sha256Hex(normalized);
	const exact = await env.DB.prepare('SELECT id, count FROM ad_samples WHERE norm_hash = ?').bind(hash).first();
	if (exact) return { hit: true, sampleId: exact.id, similarity: 1, exact: true };

	// 还没有任何带向量的样本时，embedding 无比较对象，跳过昂贵的 AI 调用。
	const hasSample = await env.DB.prepare(
		'SELECT 1 AS x FROM ad_samples WHERE embedding IS NOT NULL LIMIT 1'
	).first();
	if (!hasSample) return { hit: false };

	const vec = await embedText(env, normalized).catch(() => null);
	if (!vec) return { hit: false };
	const candidates = await env.DB.prepare(
		'SELECT id, embedding FROM ad_samples WHERE embedding IS NOT NULL ORDER BY updated_at DESC LIMIT ?'
	).bind(MERGE_CANDIDATE_LIMIT).all();
	for (const c of candidates.results || []) {
		let stored = null;
		try { stored = JSON.parse(c.embedding); } catch (_) { continue; }
		const sim = cosineSimilarity(vec, stored);
		if (sim >= config.aiSimilarity) return { hit: true, sampleId: c.id, similarity: sim };
	}
	return { hit: false };
}

// =============================================================================
// 7. 指纹库：待确认 → 已确认 → 下次命中自动全群封禁（R7）
// =============================================================================
function normalizeFingerprintValue(value) {
	return normalizeAdText(value).slice(0, 200);
}

async function matchFingerprints(env, candidates) {
	const hits = [];
	for (const c of candidates || []) {
		const norm = normalizeFingerprintValue(c.value);
		if (norm.length < FINGERPRINT_MIN_LEN) continue;
		const row = await env.DB.prepare(
			'SELECT * FROM ad_fingerprints WHERE type = ? AND norm_value = ? AND status != ?'
		).bind(c.type || 'keyword', norm, 'retired').first();
		if (row) hits.push(row);
	}
	return hits;
}

async function learnFingerprints(env, candidates, options = {}) {
	const source = String(options.source || 'auto');
	let learned = 0;
	for (const c of candidates || []) {
		const norm = normalizeFingerprintValue(c.value);
		if (norm.length < FINGERPRINT_MIN_LEN) continue;
		const existing = await env.DB.prepare(
			'SELECT id FROM ad_fingerprints WHERE type = ? AND norm_value = ?'
		).bind(c.type || 'keyword', norm).first();
		if (existing) {
			await env.DB.prepare(
				'UPDATE ad_fingerprints SET hit_count = hit_count + 1, updated_at = ? WHERE id = ?'
			).bind(nowSeconds(), existing.id).run();
			continue;
		}
		await env.DB.prepare(
			`INSERT INTO ad_fingerprints (type, value, norm_value, weight, status, source, created_at, updated_at)
			 VALUES (?, ?, ?, 0.8, 'pending', ?, ?, ?)`
		).bind(c.type || 'keyword', String(c.value).slice(0, 200), norm, source, nowSeconds(), nowSeconds()).run();
		learned++;
	}
	return { learned };
}

async function confirmFingerprint(env, fingerprintId, by) {
	await env.DB.prepare(
		"UPDATE ad_fingerprints SET status = 'confirmed', confirmed_by = ?, updated_at = ? WHERE id = ?"
	).bind(String(by), nowSeconds(), fingerprintId).run();
}

async function retireFingerprint(env, fingerprintId) {
	await env.DB.prepare(
		"UPDATE ad_fingerprints SET status = 'retired', updated_at = ? WHERE id = ?"
	).bind(nowSeconds(), fingerprintId).run();
}

// =============================================================================
// 8. 处置：默认禁言当前群；全群封禁仅主人触发；回执简化（R4/R5/R6）
// =============================================================================
async function muteInCurrentGroup(env, chatId, userId) {
	const res = await restrictMember(env, chatId, userId).catch((e) => ({ ok: false, error: String(e) }));
	return res?.ok === true;
}

async function banAllGroups(env, userId, config, reason = '') {
	const failures = [];
	let okCount = 0;
	const groupIds = [...config.groupIds];
	for (let i = 0; i < groupIds.length; i += BAN_ALL_CONCURRENCY) {
		const batch = groupIds.slice(i, i + BAN_ALL_CONCURRENCY);
		const results = await Promise.all(batch.map(async (gid) => {
			try {
				const res = await banMember(env, gid, userId);
				if (res?.ok === true) { await recordBanScope(env, userId, gid, reason); return { ok: true }; }
				return { ok: false, gid, error: res?.description || 'ban 未成功' };
			} catch (e) {
				return { ok: false, gid, error: String(e?.message || e) };
			}
		}));
		for (const r of results) {
			if (r.ok) okCount++;
			else failures.push({ gid: r.gid, error: r.error });
		}
	}
	return { okCount, failures };
}

function renderBanAllReceipt(result) {
	const lines = [];
	if (result.failures.length === 0) {
		lines.push(`✅ 已全群封禁：成功 ${result.okCount} 个群`);
	} else {
		lines.push(`✅ 已全群封禁：成功 ${result.okCount} 个群`);
		lines.push(`⚠️ 失败 ${result.failures.length} 个群：`);
		for (const f of result.failures) {
			lines.push(`  - ${f.gid}：${f.error}`);
		}
	}
	return lines.join('\n');
}

// =============================================================================
// 9. 检测管线：结构判据 → 指纹 → AI 语义（R1，尽量不误杀）
// =============================================================================
function getContactName(message) {
	if (!message?.contact) return '';
	return [message.contact.first_name, message.contact.last_name].filter(Boolean).join(' ').trim();
}
function getQuotedText(message) {
	const ext = message?.external_reply || null;
	const reply = message?.reply_to_message || null;
	return [message?.quote?.text, ext?.text, ext?.caption, reply?.text, reply?.caption].filter(Boolean).join('\n').trim();
}

async function detectAdOnMessage(env, message) {
	const chat = message?.chat;
	const from = message?.from;
	if (!chat || !from) return null;
	// 只跳过自家 bot；广告 bot 发的广告照查（只处置不回复，避免触发其自动回复）。
	if (from.is_bot && env.BOT_ID && String(from.id) === String(env.BOT_ID)) return null;
	const config = await loadConfig(env);
	if (!isConfiguredGroup(chat.id, config)) return null;
	const userId = String(from.id);

	if (await isUserWhitelisted(env, userId)) return null;
	if (isOwner(userId, config)) return null;
	if (await isGroupAdmin(env, chat.id, userId)) return null;

	const text = String(message.text ?? message.caption ?? '').trim();
	// 所有命令文本都不进检测（避免 /start 等未知命令触发指纹/AI 查询拖慢响应）。
	if (text.startsWith('/')) return null;

	const contactName = getContactName(message);
	const quotedText = getQuotedText(message);
	const bodyText = [text || contactName, quotedText].filter(Boolean).join('\n').trim();
	if (!bodyText) return null;

	await adDetectionReady(env);

	const normalized = normalizeAdText(bodyText);
	const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();

	// 误判放行库（主人 /ignore 过）→ 直接放行。
	if (await matchAllowlist(env, { text: normalized, name, username: from.username })) {
		return { action: 'pass', allowlist: true };
	}

	const candidates = [
		{ type: 'username', value: from.username ? '@' + from.username : '' },
		{ type: 'name', value: name },
		...(contactName ? [{ type: 'card_name', value: contactName }] : []),
		{ type: 'keyword', value: normalized }
	];
	const fpHits = await matchFingerprints(env, candidates);
	const confirmedHit = fpHits.find((h) => h.status === 'confirmed');
	const pendingHit = fpHits.find((h) => h.status === 'pending');

	if (confirmedHit) {
		await banAllGroups(env, userId, config, 'fingerprint:' + confirmedHit.norm_value);
		return { action: 'ban_all', reason: 'fingerprint_confirmed', fingerprint: confirmedHit };
	}
	if (pendingHit) {
		await muteInCurrentGroup(env, chat.id, userId);
		await openJoinHit(env, userId, chat.id, pendingHit, 'message');
		await notifyFingerprintPending(env, config, userId, chat, pendingHit);
		return { action: 'mute', reason: 'fingerprint_pending', fingerprint: pendingHit };
	}

	const solicit = matchAnyPattern(SOLICIT_PATTERNS, normalized);
	const biz = matchAnyPattern(BIZ_PATTERNS, normalized);
	// 豁免词命中且无强交易动词 → 不按结构定罪（技术群误杀防护）。
	const exemptHits = countKeywordHits(normalized, EXEMPT_KEYWORDS);
	const tradeHits = countKeywordHits(normalized, TRADE_VERBS);
	const structureKill = solicit && biz && !(exemptHits.length > 0 && tradeHits.length === 0);

	const semantic = await matchAdSemantic(env, bodyText, config);

	if (structureKill || semantic.hit) {
		if (from.is_bot) {
			// bot 发的广告：restrict 对 bot 无效，直接封当前群 + 清扫它发的消息。
			await banMember(env, chat.id, userId).catch(() => null);
			await sweepUserMessages(env, chat.id, userId, [message.message_id]);
			await learnFingerprints(env, candidates, { source: 'auto' });
			await addAdSample(env, bodyText, { source: 'auto' });
			return { action: 'ban', reason: structureKill ? 'structure' : 'ai', bot: true, semantic };
		}
		await muteInCurrentGroup(env, chat.id, userId);
		await learnFingerprints(env, candidates, { source: 'auto' });
		await addAdSample(env, bodyText, { source: 'auto' });
		return { action: 'mute', reason: structureKill ? 'structure' : 'ai', semantic };
	}

	return { action: 'pass' };
}

async function openJoinHit(env, userId, chatId, fingerprint, action) {
	await env.DB.prepare(
		`INSERT INTO ad_join_hits (user_id, chat_id, fingerprint_id, fingerprint_value, action, status, created_at)
		 VALUES (?, ?, ?, ?, ?, 'open', ?)`
	).bind(String(userId), String(chatId), fingerprint.id, fingerprint.norm_value, action, nowSeconds()).run();
}

async function notifyOwners(env, config, text, extra = {}) {
	for (const oid of config.ownerIds) {
		await sendMessage(env, oid, text, extra).catch(() => {});
	}
}

async function notifyFingerprintPending(env, config, userId, chat, fingerprint) {
	const kb = {
		inline_keyboard: [[
			{ text: '✅ 确认指纹并全群封禁', callback_data: `c:fp:${fingerprint.id}:confirm:${userId}` },
			{ text: '🚫 误报，忽略', callback_data: `c:fp:${fingerprint.id}:ignore:${userId}` }
		]]
	};
	await notifyOwners(env, config,
		`👤 命中待确认指纹（<code>${escapeHtml(fingerprint.type || 'keyword')}</code>）：\n\n` +
		`<code>${escapeHtml(fingerprint.value || fingerprint.norm_value)}</code>\n\n` +
		`用户 <code>${userId}</code> · 群「${escapeHtml(chat?.title || chat?.id || '')}」\n` +
		`已先禁言当前群。确认后该指纹下次再遇将自动全群封禁。`, { reply_markup: kb });
}

// =============================================================================
// 10. 进群筛查（R7）：用户名 + 名片指纹命中 → 禁言 + 待确认；confirmed → 全群封禁
// =============================================================================
async function handleNewChatMembers(env, message) {
	const chat = message?.chat;
	const members = message?.new_chat_members;
	if (!chat || !Array.isArray(members) || !members.length) return;
	const config = await loadConfig(env);
	if (!isConfiguredGroup(chat.id, config)) return;
	await adDetectionReady(env);

	for (const m of members) {
		if (m.is_bot) continue;
		const userId = String(m.id);
		if (await isUserWhitelisted(env, userId)) continue;
		if (isOwner(userId, config)) continue;
		const name = [m.first_name, m.last_name].filter(Boolean).join(' ').trim();
		const candidates = [
			{ type: 'username', value: m.username ? '@' + m.username : '' },
			{ type: 'name', value: name }
		];
		const hits = await matchFingerprints(env, candidates);
		const confirmed = hits.find((h) => h.status === 'confirmed');
		const pending = hits.find((h) => h.status === 'pending');
		if (confirmed) {
			await banAllGroups(env, userId, config, 'join_fingerprint:' + confirmed.norm_value);
		} else if (pending) {
			await muteInCurrentGroup(env, chat.id, userId);
			await openJoinHit(env, userId, chat.id, pending, 'join');
			await notifyFingerprintPending(env, config, userId, chat, pending);
		}
	}
}

// =============================================================================
// 11. 群管理员判断
// =============================================================================
let adminCache = new Map();
async function isGroupAdmin(env, chatId, userId) {
	const key = `${chatId}:${userId}`;
	const cached = adminCache.get(key);
	if (cached && cached.exp > nowSeconds()) return cached.val;
	try {
		const res = await tgCall(env, 'getChatMember', { chat_id: chatId, user_id: userId });
		const val = ['creator', 'administrator'].includes(res?.result?.status);
		adminCache.set(key, { val, exp: nowSeconds() + 300 });
		return val;
	} catch (_) {
		return false;
	}
}
function invalidateAdminCache() { adminCache = new Map(); }

// =============================================================================
// 12. 黑名单与封禁台账
// =============================================================================
async function isBlacklisted(env, userId) {
	const row = await env.DB.prepare('SELECT 1 AS x FROM blacklist WHERE user_id = ?').bind(String(userId)).first();
	return Boolean(row);
}
async function addBlacklist(env, userId, reason, note, by) {
	await env.DB.prepare(
		'INSERT OR REPLACE INTO blacklist (user_id, reason, note, by, created_at) VALUES (?, ?, ?, ?, ?)'
	).bind(String(userId), reason, note || null, String(by || ''), nowSeconds()).run();
}
async function removeBlacklist(env, userId) {
	await env.DB.prepare('DELETE FROM blacklist WHERE user_id = ?').bind(String(userId)).run();
}
async function recordBanScope(env, userId, chatId, reason) {
	await env.DB.prepare(
		'INSERT OR REPLACE INTO ad_ban_scope (user_id, chat_id, reason, created_at) VALUES (?, ?, ?, ?)'
	).bind(String(userId), String(chatId), reason, nowSeconds()).run();
}

// 误判放行库：主人 /ignore 过的人/文本/用户名，检测时直接放行。
async function matchAllowlist(env, dims = {}) {
	const checks = [
		['text', dims.text],
		['name', dims.name],
		['username', String(dims.username || '').replace(/^@/, '').toLowerCase()]
	];
	for (const [dim, raw] of checks) {
		const value = dim === 'username' ? raw : normalizeAdText(raw);
		if (!value || value.length < 2) continue;
		const row = await env.DB.prepare(
			'SELECT 1 AS x FROM ad_allowlist WHERE dimension = ? AND value = ?'
		).bind(dim, value).first();
		if (row) return true;
	}
	return false;
}

// 消息台账：记录配置群内每条消息，/spam、/ad 清扫时按用户批量删除。
async function recordMessage(env, message) {
	const chat = message?.chat, from = message?.from;
	if (!chat || !from || !message.message_id) return;
	if (chat.type !== 'group' && chat.type !== 'supergroup') return;
	const config = await loadConfig(env);
	if (!isConfiguredGroup(chat.id, config)) return;
	await env.DB.prepare(
		'INSERT OR IGNORE INTO moderation_messages (mid, chat_id, from_id, created_at) VALUES (?, ?, ?, ?)'
	).bind(message.message_id, String(chat.id), String(from.id), nowSeconds()).run();
}

// 清扫某人在某群的全部已记录消息（含额外 message_id）。
async function sweepUserMessages(env, chatId, userId, extraIds = []) {
	const ids = new Set((extraIds || []).map((x) => String(x)).filter(Boolean));
	const rows = await env.DB.prepare(
		'SELECT mid FROM moderation_messages WHERE chat_id = ? AND from_id = ?'
	).bind(String(chatId), String(userId)).all();
	for (const r of rows.results || []) ids.add(String(r.mid));
	let deleted = 0, failed = 0;
	for (const mid of ids) {
		const res = await tgCall(env, 'deleteMessage', { chat_id: chatId, message_id: Number(mid) }).catch(() => null);
		if (res?.ok === true) {
			deleted++;
			await env.DB.prepare('DELETE FROM moderation_messages WHERE chat_id = ? AND mid = ?').bind(String(chatId), mid).run();
		} else {
			failed++;
		}
	}
	return { deleted, failed };
}

async function sweepUserMessagesAllGroups(env, userId, config, extraMid, extraChatId) {
	let deleted = 0, failed = 0;
	for (const gid of config.groupIds) {
		const extra = String(gid) === String(extraChatId) ? [extraMid] : [];
		const r = await sweepUserMessages(env, gid, userId, extra);
		deleted += r.deleted;
		failed += r.failed;
	}
	return { deleted, failed };
}

// =============================================================================
// 13. 命令路由
// =============================================================================
const COMMAND_RE = /^\/([a-z_]+)(?:@[A-Za-z0-9_]+)?(?:\s+(.*))?$/is;

async function handleCommand(env, message) {
	const text = String(message?.text || '').trim();
	const m = text.match(COMMAND_RE);
	if (!m) return false;
	const command = m[1].toLowerCase();
	const arg = (m[2] || '').trim();
	const chat = message.chat;
	const from = message.from;
	const config = await loadConfig(env);
	const isAnyOwner = isOwner(from?.id, config);
	const isPrimary = isPrimaryOwner(from?.id, config);

	switch (command) {
		case 'ad': return handleAd(env, message, config);
		case 'ban': return handleBan(env, message, arg, config, isAnyOwner);
		case 'spam': return handleSpam(env, message, arg, config, isAnyOwner);
		case 'unban': return handleUnban(env, message, arg, config, isAnyOwner);
		case 'check': return handleCheck(env, message, arg, config);
		case 'pending': return handlePending(env, message, config, isAnyOwner);
		case 'add_whitelist': return handleAddWhitelist(env, message, arg, config, isPrimary);
		case 'del_whitelist': return handleDelWhitelist(env, message, arg, config, isPrimary);
		case 'whitelist_users': return handleListWhitelist(env, message, config, isPrimary);
		case 'add_owner': return handleAddOwner(env, message, arg, config, isPrimary);
		case 'del_owner': return handleDelOwner(env, message, arg, config, isPrimary);
		case 'owners': return handleOwners(env, message, config, isAnyOwner);
		case 'add_group': return handleAddGroup(env, message, arg, config, isPrimary);
		case 'del_group': return handleDelGroup(env, message, arg, config, isPrimary);
		case 'groups': return handleGroups(env, message, config, isAnyOwner);
		case 'addword': return handleAddWord(env, message, arg, config, isPrimary);
		case 'delword': return handleDelWord(env, message, arg, config, isPrimary);
		case 'words': return handleWords(env, message, config, isAnyOwner);
		case 'addsample': return handleAddSample(env, message, arg, config, isPrimary);
		case 'adstats': return handleAdStats(env, message, config, isAnyOwner);
		case 'ignore': return handleIgnore(env, message, config, isAnyOwner);
		case 'allowlist': return handleAllowlist(env, message, config, isAnyOwner);
		case 'start': return sendMessage(env, chat.id, renderHelp(isAnyOwner));
		case 'help': return sendMessage(env, chat.id, renderHelp(isAnyOwner));
		default: return false;
	}
}

async function handleBan(env, message, arg, config, isOwner) {
	const chat = message.chat;
	const targetId = await resolveTargetId(env, message, arg);
	if (!targetId) return sendMessage(env, chat.id, '用法：/ban <用户ID>（或回复一条消息）');
	if (!isOwner) {
		const admin = await isGroupAdmin(env, chat.id, message.from.id);
		if (!admin) return sendMessage(env, chat.id, '只有群管理员或主人可以 /ban');
		const res = await banMember(env, chat.id, targetId);
		await recordBanScope(env, targetId, chat.id, 'group_admin_ban');
		return sendMessage(env, chat.id, res?.ok ? `✅ 已在本群封禁 <code>${targetId}</code>` : `⚠️ 封禁失败：${res?.description || res?.error || ''}`);
	}
	await addBlacklist(env, targetId, 'manual', arg, message.from.id);
	const result = await banAllGroups(env, targetId, config, 'manual');
	return sendMessage(env, chat.id, `🎯 已加黑名单并全群封禁 <code>${targetId}</code>\n${renderBanAllReceipt(result)}`);
}

async function handleSpam(env, message, arg, config, isOwner) {
	const chat = message.chat;
	const replied = message.reply_to_message;
	if (!replied) return sendMessage(env, chat.id, '用法：回复一条广告消息后发送 /spam');
	const targetId = String(replied.from?.id || '');
	if (!targetId) return sendMessage(env, chat.id, '无法确定目标用户');
	const contactName = getContactName(replied);
	const adText = [replied.text, replied.caption, contactName, getQuotedText(replied)].filter(Boolean).join('\n').trim();

	if (!isOwner) {
		const admin = await isGroupAdmin(env, chat.id, message.from.id);
		if (!admin) return sendMessage(env, chat.id, '只有群管理员或主人可以 /spam');
		// 群管理员：只封禁当前群 + 清扫此人当前群全部消息；全群封禁留给主人确认。
		const banRes = await banMember(env, chat.id, targetId).catch((e) => ({ ok: false, description: String(e?.message || e) }));
		await recordBanScope(env, targetId, chat.id, 'group_admin_spam');
		const sweep = await sweepUserMessages(env, chat.id, targetId, [replied.message_id]);
		await notifySpamForApproval(env, config, chat, targetId, adText, message.from.id);
		const lines = [`✅ 已在本群封禁 <code>${targetId}</code> 并清扫消息 ${sweep.deleted} 条`];
		if (sweep.failed > 0) lines.push(`⚠️ ${sweep.failed} 条清扫失败`);
		if (!banRes?.ok) lines.push(`⚠️ 封禁失败：${banRes?.description || ''}`);
		lines.push('已上报主人，待确认后全群封禁。');
		return sendMessage(env, chat.id, lines.join('\n'));
	}

	// 主人：黑名单 + 全群封禁 + 全群清扫 + 学习语义/指纹。
	await addBlacklist(env, targetId, 'spam', arg, message.from.id);
	const result = await banAllGroups(env, targetId, config, 'spam');
	const sweep = await sweepUserMessagesAllGroups(env, targetId, config, replied.message_id, chat.id);
	await learnFingerprints(env, [
		{ type: 'keyword', value: adText },
		{ type: 'username', value: replied.from?.username ? '@' + replied.from.username : '' },
		...(contactName ? [{ type: 'card_name', value: contactName }] : [])
	], { source: 'spam' });
	await addAdSample(env, adText, { source: 'spam', computeEmbedding: true });
	const lines = [`🎬 /spam 已加黑名单并全群封禁 <code>${targetId}</code>`];
	lines.push(renderBanAllReceipt(result));
	lines.push(`🧹 已清扫消息 ${sweep.deleted} 条${sweep.failed > 0 ? `，${sweep.failed} 条失败` : ''}`);
	return sendMessage(env, chat.id, lines.join('\n'));
}

async function notifySpamForApproval(env, config, chat, targetId, adText, reporterId) {
	const kb = { inline_keyboard: [[{ text: '✅ 确认并全群封禁 + 清扫消息', callback_data: `c:spam:${targetId}` }]] };
	await notifyOwners(env, config,
		`⚠️ 群管理员 <code>${reporterId}</code> 在「${escapeHtml(chat?.title || chat?.id || '')}」用 /spam 上报：\n\n` +
		`🎯 目标：<code>${targetId}</code>\n📄 内容：<code>${escapeHtml((adText || '(空)').slice(0, 300))}</code>\n\n` +
		`本群已封禁并清扫该用户消息。只有主人确认后才全群封禁。`, { reply_markup: kb });
}

async function handleUnban(env, message, arg, config, isOwner) {
	const chat = message.chat;
	const targetId = await resolveTargetId(env, message, arg);
	if (!targetId) return sendMessage(env, chat.id, '用法：/unban <用户ID>（或回复一条消息）');
	if (!isOwner) return sendMessage(env, chat.id, '只有主人可以 /unban');
	await removeBlacklist(env, targetId);
	let ok = 0;
	for (const gid of config.groupIds) {
		const res = await unbanMember(env, gid, targetId);
		if (res?.ok === true) ok++;
	}
	await env.DB.prepare('DELETE FROM ad_ban_scope WHERE user_id = ?').bind(targetId).run();
	return sendMessage(env, chat.id, `✅ 已解除黑名单 <code>${targetId}</code>，已解封 ${ok} 个群`);
}

async function handleCheck(env, message, arg, config) {
	const targetId = await resolveTargetId(env, message, arg) || String(message.from?.id || '');
	const black = await isBlacklisted(env, targetId);
	const rows = await env.DB.prepare('SELECT chat_id, reason FROM ad_ban_scope WHERE user_id = ?').bind(targetId).all();
	const scopes = rows.results || [];
	const whitelisted = await isUserWhitelisted(env, targetId);
	const lines = [
		`👤 <code>${targetId}</code>`,
		`黑名单：${black ? '是' : '否'}`,
		`用户白名单：${whitelisted ? '是（完全豁免）' : '否'}`,
		`封禁台账：${scopes.length} 条`,
		...scopes.slice(0, 10).map((s) => `  - ${s.chat_id}：${s.reason}`)
	];
	return sendMessage(env, message.chat.id, lines.join('\n'));
}

async function handlePending(env, message, config, isOwner) {
	if (!isOwner) return sendMessage(env, message.chat.id, '只有主人可以查看待确认');
	const rows = await env.DB.prepare(
		"SELECT * FROM ad_join_hits WHERE status = 'open' ORDER BY id DESC LIMIT 20"
	).all();
	const open = rows.results || [];
	if (!open.length) return sendMessage(env, message.chat.id, '没有待确认的命中。');
	const lines = open.map((h) => `#${h.id} 用户<code>${h.user_id}</code> 指纹<code>${escapeHtml(h.fingerprint_value)}</code>`);
	return sendMessage(env, message.chat.id, '待确认命中：\n' + lines.join('\n'));
}

async function handleAddWhitelist(env, message, arg, config, isOwner) {
	if (!isOwner || message.chat?.type !== 'private') return sendMessage(env, message.chat.id, '仅主人在私聊可用');
	const targetId = await resolveTargetId(env, message, arg);
	if (!targetId) return sendMessage(env, message.chat.id, '用法：/add_whitelist <用户ID>（或回复一条消息）');
	await env.DB.prepare(
		'INSERT OR REPLACE INTO ad_user_whitelist (user_id, note, added_by, created_at) VALUES (?, ?, ?, ?)'
	).bind(targetId, arg, String(message.from.id), nowSeconds()).run();
	invalidateUserWhitelist();
	await removeBlacklist(env, targetId);
	return sendMessage(env, message.chat.id, `✅ 已加入用户白名单 <code>${targetId}</code>（高于黑名单，完全豁免）`);
}
async function handleDelWhitelist(env, message, arg, config, isOwner) {
	if (!isOwner || message.chat?.type !== 'private') return sendMessage(env, message.chat.id, '仅主人在私聊可用');
	const targetId = await resolveTargetId(env, message, arg);
	if (!targetId) return sendMessage(env, message.chat.id, '用法：/del_whitelist <用户ID>');
	await env.DB.prepare('DELETE FROM ad_user_whitelist WHERE user_id = ?').bind(targetId).run();
	invalidateUserWhitelist();
	return sendMessage(env, message.chat.id, `✅ 已移出用户白名单 <code>${targetId}</code>`);
}
async function handleListWhitelist(env, message, config, isOwner) {
	if (!isOwner || message.chat?.type !== 'private') return sendMessage(env, message.chat.id, '仅主人在私聊可用');
	const rows = await env.DB.prepare('SELECT user_id, note, created_at FROM ad_user_whitelist ORDER BY created_at DESC').all();
	const list = rows.results || [];
	if (!list.length) return sendMessage(env, message.chat.id, '用户白名单为空。');
	return sendMessage(env, message.chat.id, '用户白名单：\n' + list.map((r) => `<code>${r.user_id}</code> ${r.note || ''}`).join('\n'));
}

// =============================================================================
// 13b. /ad：群成员回复消息 → AI 判定广告 → 禁言 + 删除引用消息 + 推主人
// =============================================================================
async function judgeAdWithAI(env, text) {
	if (!env.AI) return { isAd: false, error: 'no_ai' };
	if (env.__aiJudgeMock) return await env.__aiJudgeMock(text);
	const model = String(env.AD_JUDGE_MODEL || '@cf/qwen/qwen1.5-7b-chat-awq');
	const res = await env.AI.run(model, {
		messages: [
			{ role: 'system', content: '你是群聊广告判定器。只输出一个词：ad 或 ok。' },
			{ role: 'user', content: `判断这条消息是不是广告/诈骗/引流（含谐音、拆字、emoji、变体）。是广告回复 ad，否则回复 ok。\n消息：${String(text).slice(0, 800)}` }
		],
		max_tokens: 8
	});
	const raw = String(res?.response || res?.result?.response || res?.result || '');
	const out = raw.toLowerCase();
	// 只认明确的 ad/广告，排除 not_ad / 不是广告 / 正常 / ok 这类带否定或放行的输出。
	const isAd = /ad|广告/.test(out) && !/ok|not|不是|非广告|正常|无广告|没有广告/.test(out);
	return { isAd };
}

async function handleAd(env, message, config) {
	const chat = message.chat;
	if (chat?.type !== 'group' && chat?.type !== 'supergroup') {
		return sendMessage(env, chat.id, '请在群里回复一条消息后发送 /ad');
	}
	const replied = message.reply_to_message;
	if (!replied) return sendMessage(env, chat.id, '用法：回复一条消息后发送 /ad，让 AI 判定广告');
	const targetId = String(replied.from?.id || '');
	const targetName = [replied.from?.first_name, replied.from?.last_name].filter(Boolean).join(' ').trim() || targetId;
	const adText = [replied.text, replied.caption, getContactName(replied)].filter(Boolean).join('\n').trim();
	if (!adText) return sendMessage(env, chat.id, '引用的消息没有可判定的正文');

	const verdict = await judgeAdWithAI(env, adText);
	if (verdict.error) return sendMessage(env, chat.id, 'AI 判定失败，请稍后再试或改用 /spam 上报');

	if (verdict.isAd) {
		const targetIsBot = Boolean(replied.from?.is_bot);
		// bot 发的广告没法 restrict，直接封禁 + 清扫，避免「广告 bot 又回一条」。
		if (targetIsBot) await banMember(env, chat.id, targetId).catch(() => null);
		else await muteInCurrentGroup(env, chat.id, targetId);
		const sweep = await sweepUserMessages(env, chat.id, targetId, [replied.message_id]);
		await notifyAdReport(env, config, chat, message.from.id, targetId, targetName, adText, true);
		const actionText = targetIsBot ? '已封禁' : '已禁言';
		const lines = [`🤖 AI 判定为广告：${actionText} <code>${escapeHtml(targetName)}</code> 并删除引用消息 ${sweep.deleted} 条`];
		if (sweep.failed > 0) lines.push(`⚠️ ${sweep.failed} 条清扫失败`);
		lines.push('已推送主人。');
		return sendMessage(env, chat.id, lines.join('\n'));
	}
	await notifyAdReport(env, config, chat, message.from.id, targetId, targetName, adText, false);
	return sendMessage(env, chat.id, '🤖 AI 判定：不是广告（已推送主人复核）。');
}

async function notifyAdReport(env, config, chat, reporterId, targetId, targetName, adText, isAd) {
	const kb = isAd
		? { inline_keyboard: [[{ text: '✅ 确认并全群封禁 + 清扫消息', callback_data: `c:spam:${targetId}` }]] }
		: undefined;
	await notifyOwners(env, config,
		`📢 群成员 <code>${reporterId}</code> 在「${escapeHtml(chat?.title || chat?.id || '')}」用 /ad 举报：\n\n` +
		`🎯 被举报人：<code>${escapeHtml(targetName)}</code>（<code>${targetId}</code>）\n` +
		`🤖 AI 判定：${isAd ? '广告 ✅' : '非广告 🚫'}\n` +
		`📄 正文：<code>${escapeHtml((adText || '(空)').slice(0, 300))}</code>`, { reply_markup: kb });
}

// =============================================================================
// 13c. 主人/副主人管理命令
// =============================================================================
async function addFingerprintManual(env, value, type, by) {
	const norm = normalizeFingerprintValue(value);
	if (norm.length < FINGERPRINT_MIN_LEN) return { ok: false, reason: 'too_short' };
	const existing = await env.DB.prepare('SELECT id FROM ad_fingerprints WHERE type = ? AND norm_value = ?').bind(type, norm).first();
	if (existing) {
		await env.DB.prepare("UPDATE ad_fingerprints SET status = 'confirmed', confirmed_by = ?, updated_at = ? WHERE id = ?")
			.bind(String(by || ''), nowSeconds(), existing.id).run();
		return { ok: true, existed: true };
	}
	await env.DB.prepare(
		`INSERT INTO ad_fingerprints (type, value, norm_value, weight, status, source, confirmed_by, created_at, updated_at)
		 VALUES (?, ?, ?, 0.8, 'confirmed', 'manual', ?, ?, ?)`
	).bind(type, String(value).slice(0, 200), norm, String(by || ''), nowSeconds(), nowSeconds()).run();
	return { ok: true, added: true };
}

async function removeFingerprint(env, value, type) {
	const norm = normalizeFingerprintValue(value);
	await env.DB.prepare('DELETE FROM ad_fingerprints WHERE type = ? AND (value = ? OR norm_value = ?)')
		.bind(type, String(value).slice(0, 200), norm).run();
}

async function handleAddWord(env, message, arg, config, isPrimary) {
	if (!isPrimary || message.chat?.type !== 'private') return sendMessage(env, message.chat.id, '仅主人在私聊可用');
	if (!arg) return sendMessage(env, message.chat.id, '用法：/addword <广告词>');
	const r = await addFingerprintManual(env, arg, 'keyword', message.from.id);
	return sendMessage(env, message.chat.id, r.existed ? `⚠️ 指纹已存在，已确认为可用：<code>${escapeHtml(arg)}</code>` : `✅ 已加指纹并直接确认：<code>${escapeHtml(arg)}</code>`);
}
async function handleDelWord(env, message, arg, config, isPrimary) {
	if (!isPrimary) return sendMessage(env, message.chat.id, '仅主人可用');
	if (!arg) return sendMessage(env, message.chat.id, '用法：/delword <广告词>');
	await removeFingerprint(env, arg, 'keyword');
	return sendMessage(env, message.chat.id, `✅ 已删除指纹：<code>${escapeHtml(arg)}</code>`);
}
async function handleWords(env, message, config, isOwner) {
	if (!isOwner) return sendMessage(env, message.chat.id, '仅主人可用');
	const rows = await env.DB.prepare('SELECT type, value, status, hit_count FROM ad_fingerprints ORDER BY updated_at DESC LIMIT 50').all();
	const list = rows.results || [];
	if (!list.length) return sendMessage(env, message.chat.id, '指纹库为空。');
	return sendMessage(env, message.chat.id, '指纹库：\n' + list.map((r) => `<code>${escapeHtml(r.value)}</code> [${r.type}/${r.status}]×${r.hit_count}`).join('\n'));
}
async function handleAddSample(env, message, arg, config, isPrimary) {
	if (!isPrimary || message.chat?.type !== 'private') return sendMessage(env, message.chat.id, '仅主人在私聊可用');
	if (!arg) return sendMessage(env, message.chat.id, '用法：/addsample <广告文本>');
	const r = await addAdSample(env, arg, { source: 'manual', computeEmbedding: true });
	return sendMessage(env, message.chat.id, r.merged ? `🧠 已合并进语义簇 #${r.sampleId}（第 ${r.tier} 级）` : '🧠 已新增语义样本');
}
async function handleAdStats(env, message, config, isOwner) {
	if (!isOwner) return sendMessage(env, message.chat.id, '仅主人可用');
	const black = await env.DB.prepare('SELECT COUNT(*) AS c FROM blacklist').first();
	const samples = await env.DB.prepare('SELECT COUNT(*) AS c FROM ad_samples').first();
	const fps = await env.DB.prepare('SELECT COUNT(*) AS c FROM ad_fingerprints').first();
	const pendingFps = await env.DB.prepare("SELECT COUNT(*) AS c FROM ad_fingerprints WHERE status = 'pending'").first();
	const groups = await env.DB.prepare('SELECT COUNT(*) AS c FROM ad_groups').first();
	return sendMessage(env, message.chat.id,
		`📊 黑名单 ${black.c} · 语义簇 ${samples.c} · 指纹 ${fps.c}（待确认 ${pendingFps.c}）· 授权群 ${groups.c}`);
}
async function handleIgnore(env, message, config, isOwner) {
	if (!isOwner) return sendMessage(env, message.chat.id, '仅主人可用');
	const replied = message.reply_to_message;
	if (!replied) return sendMessage(env, message.chat.id, '用法：回复一条消息后发送 /ignore');
	const text = String(replied.text || replied.caption || '').trim();
	const name = [replied.from?.first_name, replied.from?.last_name].filter(Boolean).join(' ').trim();
	const username = String(replied.from?.username || '').replace(/^@/, '').toLowerCase();
	let added = 0;
	const entries = [];
	if (text) entries.push(['text', text]);
	if (name) entries.push(['name', name]);
	if (username) entries.push(['username', username]);
	for (const [dim, raw] of entries) {
		const value = dim === 'username' ? username : normalizeAdText(raw);
		if (!value) continue;
		await env.DB.prepare('INSERT OR IGNORE INTO ad_allowlist (dimension, value, hit_count, created_at) VALUES (?, ?, 0, ?)')
			.bind(dim, value, nowSeconds()).run();
		added++;
	}
	return sendMessage(env, message.chat.id, `✅ 已加入误判放行库 ${added} 条`);
}
async function handleAllowlist(env, message, config, isOwner) {
	if (!isOwner) return sendMessage(env, message.chat.id, '仅主人可用');
	const rows = await env.DB.prepare('SELECT dimension, value, hit_count FROM ad_allowlist ORDER BY dimension, value LIMIT 50').all();
	const list = rows.results || [];
	if (!list.length) return sendMessage(env, message.chat.id, '误判放行库为空。');
	return sendMessage(env, message.chat.id, '误判放行库：\n' + list.map((r) => `<code>${r.dimension}:${escapeHtml(r.value)}</code>`).join('\n'));
}
async function handleAddGroup(env, message, arg, config, isPrimary) {
	if (!isPrimary || message.chat?.type !== 'private') return sendMessage(env, message.chat.id, '仅主人在私聊可用');
	const gid = String(arg || '').trim();
	if (!/^-?\d+$/.test(gid)) return sendMessage(env, message.chat.id, '用法：/add_group <群ID>');
	await env.DB.prepare('INSERT OR REPLACE INTO ad_groups (chat_id, added_by, created_at) VALUES (?, ?, ?)')
		.bind(gid, String(message.from.id), nowSeconds()).run();
	invalidateGroups();
	return sendMessage(env, message.chat.id, `✅ 已授权群 <code>${gid}</code>`);
}
async function handleDelGroup(env, message, arg, config, isPrimary) {
	if (!isPrimary) return sendMessage(env, message.chat.id, '仅主人可用');
	const gid = String(arg || '').trim();
	if (!gid) return sendMessage(env, message.chat.id, '用法：/del_group <群ID>');
	await env.DB.prepare('DELETE FROM ad_groups WHERE chat_id = ?').bind(gid).run();
	invalidateGroups();
	return sendMessage(env, message.chat.id, `✅ 已移除授权群 <code>${gid}</code>`);
}
async function handleGroups(env, message, config, isOwner) {
	if (!isOwner) return sendMessage(env, message.chat.id, '仅主人可用');
	const rows = await env.DB.prepare('SELECT chat_id FROM ad_groups ORDER BY created_at').all();
	const list = rows.results || [];
	const lines = [config.primaryGroup ? `主群：<code>${config.primaryGroup}</code>` : '（未配置主群）'];
	for (const r of list) lines.push(`授权群：<code>${r.chat_id}</code>`);
	return sendMessage(env, message.chat.id, lines.join('\n'));
}
async function handleAddOwner(env, message, arg, config, isPrimary) {
	if (!isPrimary || message.chat?.type !== 'private') return sendMessage(env, message.chat.id, '仅主人在私聊可用');
	const uid = String(arg || '').trim();
	if (!/^-?\d+$/.test(uid)) return sendMessage(env, message.chat.id, '用法：/add_owner <用户ID>');
	await env.DB.prepare('INSERT OR REPLACE INTO ad_owners (user_id, added_by, created_at) VALUES (?, ?, ?)')
		.bind(uid, String(message.from.id), nowSeconds()).run();
	invalidateOwners();
	return sendMessage(env, message.chat.id, `✅ 已设副主人 <code>${uid}</code>`);
}
async function handleDelOwner(env, message, arg, config, isPrimary) {
	if (!isPrimary) return sendMessage(env, message.chat.id, '仅主人可用');
	const uid = String(arg || '').trim();
	if (!uid) return sendMessage(env, message.chat.id, '用法：/del_owner <用户ID>');
	if (uid === config.primaryOwner) return sendMessage(env, message.chat.id, '不能删除主主人');
	await env.DB.prepare('DELETE FROM ad_owners WHERE user_id = ?').bind(uid).run();
	invalidateOwners();
	return sendMessage(env, message.chat.id, `✅ 已移除副主人 <code>${uid}</code>`);
}
async function handleOwners(env, message, config, isOwner) {
	if (!isOwner) return sendMessage(env, message.chat.id, '仅主人可用');
	const rows = await env.DB.prepare('SELECT user_id FROM ad_owners ORDER BY created_at').all();
	const list = rows.results || [];
	const lines = [config.primaryOwner ? `主人：<code>${config.primaryOwner}</code>` : '（未配置主人）'];
	for (const r of list) lines.push(`副主人：<code>${r.user_id}</code>`);
	return sendMessage(env, message.chat.id, lines.join('\n'));
}

async function resolveTargetId(env, message, arg) {
	if (/^-?\d+$/.test(String(arg || '').trim())) return String(arg.trim());
	const replied = message?.reply_to_message;
	if (replied?.from?.id) return String(replied.from.id);
	return '';
}

function renderHelp(isOwner) {
	const lines = [
		'<b>TGUnbanBot-Plus Beta</b>',
		'/ad — 回复消息让 AI 判定广告（群成员可用，命中即删+禁言并推主人）',
		'/ban <ID> — 封禁（主人=全群；群管理员=仅当前群）',
		'/spam — 回复广告消息（主人=全群+清扫；群管理员=封本群+清扫并上报）',
		'/unban <ID> — 解除黑名单并全群解封（仅主人）',
		'/check [ID] — 查看黑名单/封禁台账',
		'/pending — 查看待确认指纹命中（仅主人）'
	];
	if (isOwner) {
		lines.push(
			'/add_group <ID> — 授权群（仅主人私聊）',
			'/del_group <ID> — 移除授权群',
			'/groups — 列出主群与授权群',
			'/add_owner <ID> — 设副主人（仅主人私聊）',
			'/del_owner <ID> — 移除副主人',
			'/owners — 列出主人/副主人',
			'/addword <词> — 加指纹并直接确认（仅主人私聊）',
			'/delword <词> — 删指纹',
			'/words — 列指纹库',
			'/addsample <文本> — 手工加语义样本（仅主人私聊）',
			'/adstats — 统计',
			'/ignore — 回复消息加入误判放行库',
			'/allowlist — 列放行库',
			'/add_whitelist <ID> — 用户白名单（仅主人私聊）',
			'/del_whitelist <ID> — 移出用户白名单',
			'/whitelist_users — 列出用户白名单'
		);
	}
	return lines.join('\n');
}

// =============================================================================
// 14. 回调：指纹确认/忽略、/spam 上报确认
// =============================================================================
async function handleCallback(env, callback) {
	const data = String(callback?.data || '');
	const from = callback?.from;
	const config = await loadConfig(env);
	if (!isOwner(from?.id, config)) {
		await tgCall(env, 'answerCallbackQuery', { callback_query_id: callback.id, text: '只有主人或副主人可操作', show_alert: true });
		return;
	}
	await adDetectionReady(env);

	let m = data.match(/^c:fp:(\d+):(confirm|ignore):(\d+)$/);
	if (m) {
		const fpId = Number(m[1]);
		const action = m[2];
		const userId = m[3];
		if (action === 'confirm') {
			await confirmFingerprint(env, fpId, from.id);
			const result = await banAllGroups(env, userId, config, 'fp_confirm');
			await env.DB.prepare("UPDATE ad_join_hits SET status = 'confirmed' WHERE fingerprint_id = ? AND user_id = ? AND status = 'open'")
				.bind(fpId, userId).run();
			await editMessageText(env, callback.message?.chat?.id, callback.message?.message_id,
				`✅ 指纹已确认，用户 <code>${userId}</code> 已全群封禁。\n${renderBanAllReceipt(result)}`).catch(() => {});
		} else {
			await retireFingerprint(env, fpId);
			await env.DB.prepare("UPDATE ad_join_hits SET status = 'dismissed' WHERE fingerprint_id = ? AND user_id = ? AND status = 'open'")
				.bind(fpId, userId).run();
			await editMessageText(env, callback.message?.chat?.id, callback.message?.message_id,
				`🚫 已忽略，指纹停用，用户 <code>${userId}</code> 不再因此被处置。`).catch(() => {});
		}
		await tgCall(env, 'answerCallbackQuery', { callback_query_id: callback.id });
		return;
	}

	m = data.match(/^c:spam:(\d+)$/);
	if (m) {
		const userId = m[1];
		await addBlacklist(env, userId, 'spam', 'owner_confirm', from.id);
		const result = await banAllGroups(env, userId, config, 'spam_confirm');
		const sweep = await sweepUserMessagesAllGroups(env, userId, config, null, null);
		const sweepNote = sweep.failed > 0 ? `\n⚠️ ${sweep.failed} 条清扫失败` : '';
		await editMessageText(env, callback.message?.chat?.id, callback.message?.message_id,
			`✅ 已确认，用户 <code>${userId}</code> 已加黑并全群封禁。\n${renderBanAllReceipt(result)}` +
			`\n🧹 已清扫消息 ${sweep.deleted} 条${sweepNote}`).catch(() => {});
		await tgCall(env, 'answerCallbackQuery', { callback_query_id: callback.id });
		return;
	}

	await tgCall(env, 'answerCallbackQuery', { callback_query_id: callback.id, text: '未知操作' });
}

// =============================================================================
// 15. 入口
// =============================================================================
async function handleUpdate(env, update) {
	await adDetectionReady(env);
	if (update?.message) {
		await recordMessage(env, update.message);
		if (Array.isArray(update.message.new_chat_members) && update.message.new_chat_members.length) {
			await handleNewChatMembers(env, update.message);
			return;
		}
		if (await handleCommand(env, update.message)) return;
		await detectAdOnMessage(env, update.message);
	} else if (update?.callback_query) {
		await handleCallback(env, update.callback_query);
	}
}

async function scheduled(env) {
	await adDetectionReady(env);
	// 消息台账只保留 48h，防膨胀。
	await env.DB.prepare('DELETE FROM moderation_messages WHERE created_at < ?').bind(nowSeconds() - 172800).run();
	const rows = await env.DB.prepare('SELECT id, sample_text FROM ad_samples WHERE embedding IS NULL ORDER BY id ASC LIMIT 50').all();
	for (const r of rows.results || []) {
		try {
			const vec = await embedText(env, r.sample_text);
			if (vec) {
				await env.DB.prepare('UPDATE ad_samples SET embedding = ?, dimension = ? WHERE id = ?')
					.bind(JSON.stringify(vec), vec.length, r.id).run();
			}
		} catch (_) {}
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (request.method === 'GET' && url.pathname === '/health') {
			return new Response('OK', { status: 200 });
		}
		if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
		const secret = env.WEBHOOK_SECRET;
		if (secret && request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== secret) {
			return new Response('Unauthorized', { status: 401 });
		}
		try {
			const update = await request.json();
			await handleUpdate(env, update);
		} catch (error) {
			console.error('handleUpdate 失败:', error);
		}
		return new Response('OK', { status: 200 });
	},
	async scheduled(controller, env) {
		await scheduled(env);
	}
};

// 供离线测试 import 的内部函数（Workers 只消费 default，命名导出无副作用）。
export {
	normalizeAdText, stripEmoji, toHalfWidth, keywordSignature, countKeywordHits, matchAnyPattern,
	loadConfig, isConfiguredGroup, isPrimaryOwner, isOwner, invalidateOwners, invalidateGroups,
	isUserWhitelisted, invalidateUserWhitelist,
	tgCall, sendMessage, restrictMember, banMember,
	adDetectionReady, resetSchemaState, addAdSample, matchAdSemantic, embedText, cosineSimilarity,
	matchFingerprints, learnFingerprints, confirmFingerprint, retireFingerprint,
	muteInCurrentGroup, banAllGroups, renderBanAllReceipt,
	getContactName, getQuotedText, detectAdOnMessage, handleNewChatMembers,
	isGroupAdmin, invalidateAdminCache, isBlacklisted, addBlacklist, removeBlacklist,
	matchAllowlist, recordMessage, sweepUserMessages, sweepUserMessagesAllGroups,
	judgeAdWithAI, handleAd, notifyAdReport,
	handleCommand, handleCallback, handleUpdate, resolveTargetId
};
