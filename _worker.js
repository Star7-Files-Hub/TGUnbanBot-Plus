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
function loadConfig(env) {
	return {
		ownerIds: new Set(String(env.OWNER_IDS || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean)),
		groupIds: new Set(String(env.GROUP_IDS || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean)),
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

function isPrimaryOwner(userId, config) { return config.ownerIds.has(String(userId)); }

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
	['ad_allowlist', `CREATE TABLE IF NOT EXISTS ad_allowlist (
		dimension TEXT, value TEXT, hit_count INTEGER DEFAULT 0, created_at INTEGER,
		PRIMARY KEY(dimension, value))`],
	['ad_exempt_keywords', `CREATE TABLE IF NOT EXISTS ad_exempt_keywords (word TEXT PRIMARY KEY)`],
	['ad_domain_whitelist', `CREATE TABLE IF NOT EXISTS ad_domain_whitelist (domain TEXT PRIMARY KEY)`],
	['ad_ban_scope', `CREATE TABLE IF NOT EXISTS ad_ban_scope (
		user_id TEXT, chat_id TEXT, reason TEXT, created_at INTEGER,
		PRIMARY KEY(user_id, chat_id))`]
];

async function adDetectionReady(env) {
	if (!env?.DB) return false;
	for (const [, sql] of SCHEMA_STATEMENTS) {
		await env.DB.prepare(sql).run();
	}
	return true;
}

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
	const config = loadConfig(env);

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
	if (!chat || !from || from.is_bot) return null;
	const config = loadConfig(env);
	if (!isConfiguredGroup(chat.id, config)) return null;
	const userId = String(from.id);

	if (await isUserWhitelisted(env, userId)) return null;
	if (isPrimaryOwner(userId, config)) return null;
	if (await isGroupAdmin(env, chat.id, userId)) return null;

	const text = String(message.text ?? message.caption ?? '').trim();
	if (/^\/(addword|delword|words|addsample|adstats|whitelist|allowlist|ignore|exempt|rescreen|warmup)/i.test(text)) return null;

	const contactName = getContactName(message);
	const quotedText = getQuotedText(message);
	const bodyText = [text || contactName, quotedText].filter(Boolean).join('\n').trim();
	if (!bodyText) return null;

	await adDetectionReady(env);

	const normalized = normalizeAdText(bodyText);

	const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
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
	const structureKill = solicit && biz;

	const semantic = await matchAdSemantic(env, bodyText, config);

	if (structureKill || semantic.hit) {
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

async function notifyFingerprintPending(env, config, userId, chat, fingerprint) {
	const ownerId = [...config.ownerIds][0];
	if (!ownerId) return;
	const kb = {
		inline_keyboard: [[
			{ text: '✅ 确认指纹并全群封禁', callback_data: `c:fp:${fingerprint.id}:confirm:${userId}` },
			{ text: '🚫 误报，忽略', callback_data: `c:fp:${fingerprint.id}:ignore:${userId}` }
		]]
	};
	await sendMessage(env, ownerId,
		`👤 新成员 <code>${userId}</code> 在群「${chat?.title || chat?.id || ''}」命中待确认指纹：\n\n` +
		`<code>${fingerprint.value || fingerprint.norm_value}</code>\n\n` +
		`已先禁言当前群。确认后该指纹下次再遇将自动全群封禁。`, { reply_markup: kb });
}

// =============================================================================
// 10. 进群筛查（R7）：用户名 + 名片指纹命中 → 禁言 + 待确认；confirmed → 全群封禁
// =============================================================================
async function handleNewChatMembers(env, message) {
	const chat = message?.chat;
	const members = message?.new_chat_members;
	if (!chat || !Array.isArray(members) || !members.length) return;
	const config = loadConfig(env);
	if (!isConfiguredGroup(chat.id, config)) return;
	await adDetectionReady(env);

	for (const m of members) {
		if (m.is_bot) continue;
		const userId = String(m.id);
		if (await isUserWhitelisted(env, userId)) continue;
		if (isPrimaryOwner(userId, config)) continue;
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
	const config = loadConfig(env);
	const isOwner = isPrimaryOwner(from?.id, config);

	switch (command) {
		case 'ban': return handleBan(env, message, arg, config, isOwner);
		case 'spam': return handleSpam(env, message, arg, config, isOwner);
		case 'unban': return handleUnban(env, message, arg, config, isOwner);
		case 'check': return handleCheck(env, message, arg, config);
		case 'pending': return handlePending(env, message, config, isOwner);
		case 'add_whitelist': return handleAddWhitelist(env, message, arg, config, isOwner);
		case 'del_whitelist': return handleDelWhitelist(env, message, arg, config, isOwner);
		case 'whitelist_users': return handleListWhitelist(env, message, config, isOwner);
		case 'help': return sendMessage(env, chat.id, renderHelp(isOwner));
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
		await notifySpamForApproval(env, config, chat, targetId, adText, message.from.id);
		return sendMessage(env, chat.id, '已上报主人审核，待确认后处理。');
	}

	await addBlacklist(env, targetId, 'spam', arg, message.from.id);
	const result = await banAllGroups(env, targetId, config, 'spam');
	await learnFingerprints(env, [
		{ type: 'keyword', value: adText },
		{ type: 'username', value: replied.from?.username ? '@' + replied.from.username : '' },
		...(contactName ? [{ type: 'card_name', value: contactName }] : [])
	], { source: 'spam' });
	await addAdSample(env, adText, { source: 'spam', computeEmbedding: true });
	return sendMessage(env, chat.id, `🎬 /spam 已加黑名单并全群封禁 <code>${targetId}</code>\n${renderBanAllReceipt(result)}`);
}

async function notifySpamForApproval(env, config, chat, targetId, adText, reporterId) {
	const ownerId = [...config.ownerIds][0];
	if (!ownerId) return;
	const kb = { inline_keyboard: [[{ text: '✅ 确认并全群封禁', callback_data: `c:spam:${targetId}` }]] };
	await sendMessage(env, ownerId,
		`⚠️ 群管理员 <code>${reporterId}</code> 在「${chat?.title || chat?.id || ''}」用 /spam 上报：\n\n` +
		`🎯 目标：<code>${targetId}</code>\n📄 内容：<code>${(adText || '(空)').slice(0, 300)}</code>\n\n` +
		`只有你能确认全群封禁。`, { reply_markup: kb });
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
	const lines = open.map((h) => `#${h.id} 用户<code>${h.user_id}</code> 指纹<code>${h.fingerprint_value}</code>`);
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

async function resolveTargetId(env, message, arg) {
	if (/^-?\d+$/.test(String(arg || '').trim())) return String(arg.trim());
	const replied = message?.reply_to_message;
	if (replied?.from?.id) return String(replied.from.id);
	return '';
}

function renderHelp(isOwner) {
	const lines = [
		'<b>TGUnbanBot-Plus Beta</b>',
		'/ban <ID> — 封禁（主人=全群；群管理员=仅当前群）',
		'/spam — 回复广告消息举报（主人=全群；群管理员=上报待确认）',
		'/unban <ID> — 解除黑名单并全群解封（仅主人）',
		'/check [ID] — 查看黑名单/封禁台账',
		'/pending — 查看待确认指纹命中（仅主人）'
	];
	if (isOwner) {
		lines.push(
			'/add_whitelist <ID> — 加入用户白名单（仅私聊）',
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
	const config = loadConfig(env);
	if (!isPrimaryOwner(from?.id, config)) {
		await tgCall(env, 'answerCallbackQuery', { callback_query_id: callback.id, text: '只有主人可操作', show_alert: true });
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
		await editMessageText(env, callback.message?.chat?.id, callback.message?.message_id,
			`✅ 已确认，用户 <code>${userId}</code> 已加黑并全群封禁。\n${renderBanAllReceipt(result)}`).catch(() => {});
		await tgCall(env, 'answerCallbackQuery', { callback_query_id: callback.id });
		return;
	}

	await tgCall(env, 'answerCallbackQuery', { callback_query_id: callback.id, text: '未知操作' });
}

// =============================================================================
// 15. 入口
// =============================================================================
async function handleUpdate(env, update) {
	if (update?.message) {
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
	normalizeAdText, stripEmoji, toHalfWidth, keywordSignature, matchAnyPattern,
	loadConfig, isConfiguredGroup, isPrimaryOwner, isUserWhitelisted, invalidateUserWhitelist,
	tgCall, sendMessage, restrictMember, banMember,
	adDetectionReady, addAdSample, matchAdSemantic, embedText, cosineSimilarity,
	matchFingerprints, learnFingerprints, confirmFingerprint, retireFingerprint,
	muteInCurrentGroup, banAllGroups, renderBanAllReceipt,
	getContactName, getQuotedText, detectAdOnMessage, handleNewChatMembers,
	isGroupAdmin, isBlacklisted, addBlacklist, removeBlacklist,
	handleCommand, handleCallback, resolveTargetId
};
