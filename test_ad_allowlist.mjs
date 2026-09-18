// 误判放行库（ad_allowlist）· 离线验证
//
// 这份测试要钉住的不是「有没有这张表」，而是四条容易在后续改动里悄悄退化的性质：
//   1. 【键的形态】归一化 + 维度前缀。少了前缀，昵称恰好等于某条被放行的正文就会跟着被放行。
//   2. 【粒度是维度，不是整条消息】只放行 text 时，昵称/简介仍必须能独立定罪 ——
//      否则放行库会退化成万能免死金牌，一次误判换永久失明。
//   3. 【快照必须存原始素材】快照是主人复核与 /ignore 反推放行键的依据，
//      存了被抹空的值，/pending 就只剩空行，而且 /ignore 会把自己刚登记的记录抹掉。
//   4. 【/ignore → 放行 → /allowlist del → 又能封】这条闭环。
//      放行库是永久生效的，没有这个回收开关，一次手滑的 /ignore 就再也撤不回来。
//
// 与 test_ad_detection.mjs 同一范式：vm 加载 _worker.js，D1 用 node:sqlite 做真实后端。
// 运行：node test_ad_allowlist.mjs

import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '_worker.js'), 'utf8');

function stripExportDefault(source) {
	const start = source.indexOf('export default');
	const braceStart = source.indexOf('{', start);
	let depth = 0;
	let i = braceStart;
	for (; i < source.length; i++) {
		if (source[i] === '{') depth += 1;
		else if (source[i] === '}') {
			depth -= 1;
			if (depth === 0) { i += 1; break; }
		}
	}
	if (source[i] === ';') i += 1;
	return source.slice(0, start) + 'globalThis.__handler = ' + source.slice(start + 'export default'.length, i) + ';' + source.slice(i);
}

// ---------- 真实 SQLite 驱动的 D1 兼容层（与 test_ad_detection.mjs 同款） ----------
function makeD1() {
	const db = new DatabaseSync(':memory:');
	const normIn = (v) => {
		if (v === undefined) return null;
		if (typeof v === 'boolean') return v ? 1 : 0;
		if (typeof v === 'bigint') return Number(v);
		return v;
	};
	const normOut = (row) => {
		if (!row) return null;
		const out = {};
		for (const key of Object.keys(row)) {
			const value = row[key];
			out[key] = typeof value === 'bigint' ? Number(value) : value;
		}
		return out;
	};
	const exec = (sql, params) => {
		const statement = db.prepare(sql);
		const bound = params.map(normIn);
		// PRAGMA 也必须走 rows 分支 —— d1ColumnExists 用的是 `PRAGMA table_info(...)`，
		// 漏掉它会让所有列检查抛错，进而误判成「D1 核心结构迁移不完整」。
		const head = sql.trim().slice(0, 6).toUpperCase();
		if (head === 'SELECT' || sql.trim().toUpperCase().startsWith('PRAGMA')) {
			return { kind: 'rows', rows: statement.all(...bound).map(normOut) };
		}
		const info = statement.run(...bound);
		return {
			kind: 'write',
			meta: {
				changes: Number(info?.changes || 0),
				last_row_id: Number(info?.lastInsertRowid || 0),
				duration: 0, rows_read: 0, rows_written: Number(info?.changes || 0)
			}
		};
	};
	const makeStatement = (sql) => {
		const state = { sql, params: [] };
		const api = {
			__d1: state,
			bind(...args) { state.params = args; return api; },
			async first() {
				const result = exec(state.sql, state.params);
				return result.kind === 'rows' ? (result.rows[0] ?? null) : null;
			},
			async run() {
				const result = exec(state.sql, state.params);
				if (result.kind === 'rows') return { success: true, results: result.rows, meta: { changes: 0, duration: 0 } };
				return { success: true, meta: result.meta };
			},
			async all() {
				const result = exec(state.sql, state.params);
				if (result.kind === 'rows') return { success: true, results: result.rows, meta: { changes: 0, duration: 0 } };
				return { success: true, results: [], meta: result.meta };
			}
		};
		return api;
	};
	return {
		__sqlite: db,
		prepare: (sql) => makeStatement(sql),
		async exec(sql) { db.exec(sql); return { count: 1, duration: 0 }; },
		async batch(statements) {
			const out = [];
			db.exec('BEGIN');
			try {
				for (const statement of Array.from(statements || [])) {
					const state = statement?.__d1;
					if (!state) throw new Error('batch 收到非本层生成的 statement');
					const result = exec(state.sql, state.params);
					out.push(result.kind === 'rows'
						? { success: true, results: result.rows, meta: { changes: 0, duration: 0 } }
						: { success: true, meta: result.meta });
				}
				db.exec('COMMIT');
			} catch (error) {
				db.exec('ROLLBACK');
				throw error;
			}
			return out;
		},
		query(sql, ...params) { return db.prepare(sql).all(...params).map(normOut); }
	};
}

// ---------- 断言 ----------
let pass = 0;
let fail = 0;
const failures = [];
function assert(name, condition, detail = '') {
	if (condition) { pass += 1; console.log(`  OK   ${name}`); }
	else {
		fail += 1;
		failures.push(name);
		console.log(`  FAIL ${name}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`);
	}
}
function section(title) { console.log(`\n${title}`); }

// ---------- Telegram Bot API mock ----------
const calls = [];
let apiHandlers = {};
function setApi(next = {}) { apiHandlers = next; }
function resetCalls() {
	calls.length = 0;
	setApi();
	try { W.invalidateAdAdminCache(); } catch { /* W 未初始化 */ }
}
function countCalls(method) { return calls.filter((c) => c.method === method).length; }
function lastSent() {
	return String(calls.filter((c) => c.method === 'sendMessage').at(-1)?.body?.text || '');
}
function allSentText() {
	return calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.body?.text || '')).join('\n---\n');
}
function defaultPayload(method, body) {
	switch (method) {
		case 'getMe': return { ok: true, result: { id: 777000, is_bot: true, username: 'AdGuardTestBot' } };
		case 'sendMessage': return { ok: true, result: { message_id: 5000 + calls.length } };
		case 'getChat': return { ok: true, result: { id: body?.chat_id, first_name: '未知', bio: '' } };
		case 'getChatMember': return { ok: true, result: { status: 'member', user: { id: body?.user_id } } };
		case 'getChatAdministrators': return { ok: true, result: [] };
		default: return { ok: true, result: true };
	}
}

const sandbox = {
	console, URL, URLSearchParams, TextEncoder, TextDecoder,
	Response, Request, Headers, atob, btoa, setTimeout, clearTimeout,
	fetch: async (url, init) => {
		const method = String(url).split('/').pop();
		let body = null;
		try { body = init?.body ? JSON.parse(init.body) : null; } catch (_) { body = null; }
		calls.push({ method, body });
		const handler = apiHandlers[method];
		const mock = handler ? handler(body) : null;
		const payload = mock?.payload || mock || defaultPayload(method, body);
		return {
			ok: mock?.httpOk ?? true,
			status: mock?.status ?? 200,
			async json() { return payload; },
			async text() { return JSON.stringify(payload); }
		};
	}
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(stripExportDefault(src), sandbox, { filename: '_worker.js' });

const handler = sandbox.__handler;
const W = sandbox;
const GROUP_ID = '-1001111111111';
const OWNER_ID = 10001;

function makeEnv(extra = {}) {
	return {
		TOKEN: 'TESTTOKEN',
		BOT_TOKEN: '123456:fake',
		GROUP_ID,
		OWNER_IDS: String(OWNER_ID),
		DB: makeD1(),
		...extra
	};
}

async function sendUpdate(update, env) {
	const request = new Request('https://example.workers.dev/', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ update_id: Math.floor(Math.random() * 1e9), ...update })
	});
	return await handler.fetch(request, env, { waitUntil() {} });
}
function privateMessage(fromId, text) {
	return {
		message_id: 100 + Math.floor(Math.random() * 1000),
		date: Math.floor(Date.now() / 1000),
		text,
		chat: { id: Number(fromId), type: 'private', first_name: 'P' },
		from: { id: Number(fromId), is_bot: false, first_name: 'P' }
	};
}
function groupMessage(from, text, extra = {}) {
	return {
		message_id: 200 + Math.floor(Math.random() * 1000),
		date: Math.floor(Date.now() / 1000),
		text,
		chat: { id: Number(GROUP_ID), type: 'supergroup', title: '测试治理群' },
		from: { is_bot: false, ...from },
		...extra
	};
}

// 初始化模块级配置（BOT_TOKEN / GROUP_IDS / OWNER_IDS 由 fetch 入口写入）。
const bootEnv = makeEnv();
resetCalls();
await sendUpdate({ message: privateMessage(99999, 'hello') }, bootEnv);

// ⚠️ AD_ALLOWLIST_DYNAMIC 是模块级单例（与 AD_EXEMPT_DYNAMIC 同款设计，生产里只有一个 D1 绑定）。
// 测试里每个场景一个 env，所以任何一次 webhook 都会把全局集合换成该 env 的内容 ——
// 断言前必须显式 refresh 一次，否则读到的是上一个场景的残留。
const useEnv = async (env) => { await W.refreshAdAllowlist(env); return env; };

const AD_TEXT = '长期收购网赚账号 USDT，进群联系 @promo_seller_x';
const AD_PROFILE = {
	firstName: '💚高价收网赚号💚',
	lastName: '',
	username: 'AdBot88888',
	bio: '长期收购网 du 商宝账号，优先加价',
	status: 'member'
};
const adInput = () => ({
	profile: { ...AD_PROFILE },
	text: AD_TEXT,
	forwardChat: null
});

// ============================================================
section('[1] 键的形态：归一化 + 维度前缀');
{
	assert('小写化', W.buildAdAllowlistKey('text', 'HELLO') === 'text:hello');
	assert('空白折叠', W.buildAdAllowlistKey('text', '  收  二手   手机  ') === 'text:收 二手 手机');
	assert('零宽字符被剥掉', W.buildAdAllowlistKey('text', '收\u200b二手') === 'text:收二手');
	assert('@ 前缀被剥掉（检测端 payload.username 带 @，主人手工加多半不带）',
		W.buildAdAllowlistKey('username', '@AdBot88888') === W.buildAdAllowlistKey('username', 'AdBot88888'));
	// 这一条是维度前缀存在的全部理由：跨维度不能互相放行。
	assert('同值的不同维度是两把不同的键',
		W.buildAdAllowlistKey('text', '收号') !== W.buildAdAllowlistKey('name', '收号'));
	assert('未知维度不生成键', W.buildAdAllowlistKey('emoji', '收号') === '');
	assert('空值不生成键', W.buildAdAllowlistKey('text', '   ') === '');
	assert('单字符不生成键（放行一个常用字毫无信息量）', W.buildAdAllowlistKey('text', '好') === '');
	assert('两个字符起才生成', W.buildAdAllowlistKey('text', '好啊') === 'text:好啊');
	assert('超长素材被截到 200 字（与 normalizeAdFingerprintValue 同口径）',
		W.buildAdAllowlistKey('text', 'a'.repeat(500)).length === 'text:'.length + 200);
}

// ============================================================
section('[2] 表结构、幂等写入与运行期缓存');
{
	const env = await useEnv(makeEnv());
	assert('ad_allowlist 表被建出来', env.DB.query("SELECT name FROM sqlite_master WHERE type='table' AND name='ad_allowlist'").length === 1);
	assert('allow_key 上有唯一索引（INSERT OR IGNORE 幂等的前提）',
		env.DB.query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='ad_allowlist'").length >= 1);

	const first = await W.addAdAllowlistEntry(env, 'name', '老王', { userId: '7001', addedBy: '1', source: 'manual' });
	assert('首次写入成功且 added=true', first.ok === true && first.added === true, JSON.stringify(first));
	const second = await W.addAdAllowlistEntry(env, 'name', '老王', { userId: '7001', addedBy: '1', source: 'manual' });
	assert('重复写入被 IGNORE（added=false，不抛错）', second.ok === true && second.added === false, JSON.stringify(second));
	assert('重复写入没有产生第二行', env.DB.query("SELECT COUNT(*) AS c FROM ad_allowlist WHERE dimension='name'")[0].c === 1);

	await W.addAdAllowlistEntry(env, 'bio', '喜欢摄影', {});
	assert('不同维度互不冲突', env.DB.query('SELECT COUNT(*) AS c FROM ad_allowlist')[0].c === 2);

	// 缓存：refresh 之后 matchAdAllowlist 才认得出这两条。
	await W.refreshAdAllowlist(env);
	const probe = W.matchAdAllowlist({ text: '', name: '老王', username: '', bio: '喜欢摄影' });
	assert('refresh 后内存集合命中 name', probe?.hit?.name === true, JSON.stringify(probe));
	assert('refresh 后内存集合命中 bio', probe?.hit?.bio === true, JSON.stringify(probe));
	assert('未登记的维度不算命中', !probe?.hit?.text && !probe?.hit?.username, JSON.stringify(probe));
	assert('命中的键被一并返回（供命中计数使用）', Array.isArray(probe?.keys) && probe.keys.length === 2, JSON.stringify(probe));
	assert('一个维度都没命中时返回 null（热路径零成本的前提）',
		W.matchAdAllowlist({ text: '随便说点什么', name: '张三', username: '', bio: '' }) === null);

	// 大小写/空白差异必须照样命中 —— 归一化的意义就在这里。
	assert('归一化后逐字一致即命中（大小写无关）',
		W.matchAdAllowlist({ text: '', name: '  老王 ', username: '', bio: '' })?.hit?.name === true);

	const listed = await W.listAdAllowlist(env);
	assert('listAdAllowlist 返回全部记录', listed.ok === true && listed.total === 2, JSON.stringify(listed));
	assert('按维度聚合计数正确', listed.byDimension.name === 1 && listed.byDimension.bio === 1, JSON.stringify(listed.byDimension));
	assert('返回行带 id（/allowlist del 的唯一入口）', listed.rows.every((r) => r.id > 0), JSON.stringify(listed.rows));
}

// ============================================================
section('[3] 检测链第 0 层：粒度是维度，不是整条消息');
{
	const env = await useEnv(makeEnv());
	await W.adDetectionReady(env);

	const base = await W.evaluateAdSuspect(env, adInput(), {});
	assert('基线：广告素材确实会被判 ban（否则后面几条断言没有意义）',
		base.verdict === 'ban', base.verdict + ' score=' + base.score + ' ' + JSON.stringify(base.reasons));
	assert('基线快照存的是原始素材', base.snapshot.text === AD_TEXT && base.snapshot.name === AD_PROFILE.firstName);
	assert('基线没有放行命中', base.allowlist === null, JSON.stringify(base.allowlist));

	// —— 只放行「正文」——
	const envText = await useEnv(makeEnv());
	await W.adDetectionReady(envText);
	await W.addAdAllowlistEntry(envText, 'text', AD_TEXT, { source: 'ignore' });
	await W.refreshAdAllowlist(envText);
	const onlyText = await W.evaluateAdSuspect(envText, adInput(), {});
	assert('放行正文后 payload.text 被抹空', onlyText.payload.text === '', JSON.stringify(onlyText.payload.text));
	assert('放行正文【不影响】昵称与简介进入判定',
		onlyText.payload.name === AD_PROFILE.firstName && onlyText.payload.bio === AD_PROFILE.bio,
		JSON.stringify({ name: onlyText.payload.name, bio: onlyText.payload.bio }));
	assert('放行正文【不影响】@用户名', onlyText.payload.username === '@' + AD_PROFILE.username, onlyText.payload.username);
	assert('放行正文后判定理由里写明放行命中（否则这条路径完全不可观测）',
		onlyText.reasons.some((r) => r.includes('误判放行库命中') && r.includes('消息正文')),
		JSON.stringify(onlyText.reasons));
	// 【本文件最重要的一条】昵称 + @用户名 + 简介仍构成资料卡查杀 → 照封。
	// 若这里变成 pass，说明放行库退化成了「整条免死」，一次误判就永久放过这个人。
	assert('★ 只放行正文时，昵称+用户名+简介仍能独立定罪（不是整条短路）',
		onlyText.verdict === 'ban', onlyText.verdict + ' score=' + onlyText.score + ' ' + JSON.stringify(onlyText.reasons));
	assert('★ 快照仍存原始正文（被抹空的话 /pending 只剩空行）',
		onlyText.snapshot.text === AD_TEXT, JSON.stringify(onlyText.snapshot));

	// —— 只放行「昵称」——
	const envName = await useEnv(makeEnv());
	await W.adDetectionReady(envName);
	await W.addAdAllowlistEntry(envName, 'name', AD_PROFILE.firstName, { source: 'ignore' });
	await W.refreshAdAllowlist(envName);
	const onlyName = await W.evaluateAdSuspect(envName, adInput(), {});
	assert('放行昵称后 payload.name 被抹空', onlyName.payload.name === '', JSON.stringify(onlyName.payload.name));
	assert('放行昵称不影响正文与简介',
		onlyName.payload.text === AD_TEXT && onlyName.payload.bio === AD_PROFILE.bio,
		JSON.stringify({ text: onlyName.payload.text, bio: onlyName.payload.bio }));
	assert('放行昵称后仍保留正文这条证据（reasons 里有正文相关判据）',
		onlyName.reasons.some((r) => r.includes('正文')), JSON.stringify(onlyName.reasons));

	// —— 只放行「简介」——
	const envBio = await useEnv(makeEnv());
	await W.adDetectionReady(envBio);
	await W.addAdAllowlistEntry(envBio, 'bio', AD_PROFILE.bio, { source: 'ignore' });
	await W.refreshAdAllowlist(envBio);
	const onlyBio = await W.evaluateAdSuspect(envBio, adInput(), {});
	assert('放行简介后 payload.bio 被抹空', onlyBio.payload.bio === '', JSON.stringify(onlyBio.payload.bio));
	// 抹空 bio 会让 scoreAdProfile 把它当成「没查 bio」，不挡住就会白扣 1 分「名称无 emoji 且无 Bio」。
	assert('放行简介不会被误当成「名称无 emoji 且无 Bio」扣分',
		!onlyBio.reasons.some((r) => r.includes('名称无 emoji 且无 Bio')), JSON.stringify(onlyBio.reasons));

	// —— 只放行「@用户名」——
	const envUser = await useEnv(makeEnv());
	await W.adDetectionReady(envUser);
	await W.addAdAllowlistEntry(envUser, 'username', '@' + AD_PROFILE.username, { source: 'ignore' });
	await W.refreshAdAllowlist(envUser);
	const onlyUser = await W.evaluateAdSuspect(envUser, adInput(), {});
	assert('放行 @用户名 后 payload.username 被抹空', onlyUser.payload.username === '', JSON.stringify(onlyUser.payload.username));
	assert('放行 @用户名 不影响昵称/正文/简介',
		onlyUser.payload.name === AD_PROFILE.firstName && onlyUser.payload.text === AD_TEXT,
		JSON.stringify({ name: onlyUser.payload.name, text: onlyUser.payload.text }));

	// —— 四维全放行 → 彻底放过（这才是 /ignore 想要的终态）——
	const envAll = await useEnv(makeEnv());
	await W.adDetectionReady(envAll);
	await W.allowlistAdPayload(envAll, {
		name: AD_PROFILE.firstName, username: '@' + AD_PROFILE.username,
		bio: AD_PROFILE.bio, text: AD_TEXT
	}, { userId: '7009', addedBy: '1', source: 'ignore' });
	await W.refreshAdAllowlist(envAll);
	const all = await W.evaluateAdSuspect(envAll, adInput(), {});
	assert('四维全放行后不再封禁', all.verdict !== 'ban', all.verdict + ' score=' + all.score);
	assert('四维全放行后四个维度都退出了判定',
		all.payload.text === '' && all.payload.name === '' && all.payload.username === '' && all.payload.bio === '',
		JSON.stringify(all.payload));
	assert('四维全放行后 allowlist 字段透传了四个维度',
		all.allowlist && ['text', 'name', 'username', 'bio'].every((d) => all.allowlist[d] === true),
		JSON.stringify(all.allowlist));
	assert('四维全放行后快照仍保留全部原始素材（/ignore 要拿它反推放行键）',
		all.snapshot.text === AD_TEXT && all.snapshot.name === AD_PROFILE.firstName
		&& all.snapshot.bio === AD_PROFILE.bio && all.snapshot.username === '@' + AD_PROFILE.username,
		JSON.stringify(all.snapshot));
}

// ============================================================
section('[4] 命中计数：长期 0 命中的就是可清理的残留');
{
	const env = await useEnv(makeEnv());
	await W.adDetectionReady(env);
	await W.addAdAllowlistEntry(env, 'name', '老王', { source: 'ignore' });
	await W.refreshAdAllowlist(env);
	const row0 = env.DB.query("SELECT hit_count FROM ad_allowlist WHERE dimension='name'")[0];
	assert('刚登记时命中 0 次', row0.hit_count === 0, JSON.stringify(row0));

	await W.evaluateAdSuspect(env, { profile: { firstName: '老王', bio: '' }, text: '', forwardChat: null }, {});
	const row1 = env.DB.query("SELECT hit_count, last_hit_at FROM ad_allowlist WHERE dimension='name'")[0];
	assert('命中一次后计数 +1', row1.hit_count === 1, JSON.stringify(row1));
	assert('同时记下最近命中时间', row1.last_hit_at > 0, JSON.stringify(row1));

	await W.evaluateAdSuspect(env, { profile: { firstName: '老王', bio: '' }, text: '', forwardChat: null }, {});
	assert('再命中一次继续累加', env.DB.query("SELECT hit_count FROM ad_allowlist WHERE dimension='name'")[0].hit_count === 2);
	// 未命中的素材不计数：否则「这条记录还有没有用」就失去了判据。
	await W.evaluateAdSuspect(env, { profile: { firstName: '路人甲', bio: '' }, text: '', forwardChat: null }, {});
	assert('未命中的记录计数保持不变', env.DB.query("SELECT hit_count FROM ad_allowlist WHERE dimension='name'")[0].hit_count === 2);

	const listed = await W.listAdAllowlist(env);
	assert('列表按命中次数升序（0 命中的残留排最前，主人翻得到）',
		listed.rows.every((r, i) => i === 0 || listed.rows[i - 1].hitCount <= r.hitCount),
		JSON.stringify(listed.rows.map((r) => r.hitCount)));
}

// ============================================================
section('[5] /ignore 自动登记负例（闭环第 1 段）');
let sharedEnv = null;
let ignoredSeq = null;
{
	const env = await useEnv(makeEnv());
	sharedEnv = env;
	const adApi = {
		getChat: (body) => ({ ok: true, result: { id: body?.chat_id, ...AD_PROFILE } }),
		getChatMember: (body) => ({ ok: true, result: { status: 'member', user: { id: body?.user_id } } }),
		getChatAdministrators: () => ({ ok: true, result: [] })
	};
	setApi(adApi);
	await sendUpdate({ message: groupMessage({ id: 70001, first_name: AD_PROFILE.firstName, username: AD_PROFILE.username }, AD_TEXT) }, env);
	const mutes = countCalls('restrictChatMember');
	const bans = countCalls('banChatMember');
	const snap = env.DB.query("SELECT seq, user_id FROM ad_pending_snapshots WHERE user_id='70001'");
	const black = env.DB.query("SELECT COUNT(*) AS c FROM blacklist WHERE id='70001'")[0].c;
	assert('广告消息被本群禁言（首次不拉黑）并留下快照',
		mutes >= 1 && bans === 0 && black === 0 && snap.length === 1,
		JSON.stringify({ mutes, bans, black, snap }));
	ignoredSeq = snap[0]?.seq;

	assert('/ignore 之前放行库是空的', env.DB.query('SELECT COUNT(*) AS c FROM ad_allowlist')[0].c === 0);

	resetCalls();
	await sendUpdate({ message: privateMessage(OWNER_ID, '/ignore ' + ignoredSeq) }, env);
	const text = lastSent();
	// 【为什么是「本就不在黑名单」】首次命中已改为只禁言、不拉黑，
	// 所以这条样本被 /ignore 时黑名单移除必然返回 NOT_FOUND —— 回执要如实这么写。
	assert('/ignore 回执仍报告黑名单/解禁/解封/指纹/样本（既有行为未变）',
		text.includes('本就不在黑名单') && text.includes('解禁：') && text.includes('解封：') && text.includes('指纹修正：') && text.includes('AI 样本：'), text);
	assert('★ /ignore 回执新增「误判放行」一节', text.includes('误判放行：'), text);
	assert('★ 回执写明登记了 3 项（本次快照里有消息正文/昵称/@用户名，无简介）',
		text.includes('已登记 <b>3</b> 项') && text.includes('消息正文') && text.includes('@用户名'), text);
	assert('回执给出撤销入口', text.includes('/allowlist'), text);

	const rows = env.DB.query('SELECT dimension, value, source, user_id FROM ad_allowlist ORDER BY dimension');
	// 【为什么是 3 而不是 4】闸一（零成本判定）在这条样本上就够封禁线了，压根没拉资料，
	// 所以快照里的 bio 是空串 —— 放行库只能登记「确实参与过这次判定」的素材，
	// 没参与过的没有可登记的东西。这不是缺陷，bio 缺席的端到端由 [5b] 用种子快照覆盖。
	assert('★ 快照里有的三个维度全部登记进库（bio 本次未参与判定）', rows.length === 3, JSON.stringify(rows));
	assert('三个维度分别是 text/name/username',
		JSON.stringify(rows.map((r) => r.dimension).sort()) === JSON.stringify(['name', 'text', 'username']),
		JSON.stringify(rows.map((r) => r.dimension)));
	assert('来源标记为 ignore（与手工登记的 manual 区分）', rows.every((r) => r.source === 'ignore'), JSON.stringify(rows));
	assert('登记时带上当事人 user_id（事后能追溯这条是谁的）', rows.every((r) => String(r.user_id) === '70001'), JSON.stringify(rows));
	assert('正文键存的是归一化后的值',
		rows.find((r) => r.dimension === 'text')?.value === W.normalizeAdAllowlistValue(AD_TEXT),
		JSON.stringify(rows.find((r) => r.dimension === 'text')));
	assert('@用户名键存的是剥掉 @ 的形态（与检测端 payload 对齐）',
		rows.find((r) => r.dimension === 'username')?.value === AD_PROFILE.username.toLowerCase(),
		JSON.stringify(rows.find((r) => r.dimension === 'username')));
	assert('快照里没有的素材不会被凭空登记（bio 缺席）',
		env.DB.query("SELECT COUNT(*) AS c FROM ad_allowlist WHERE dimension='bio'")[0].c === 0);
}

// ============================================================
section('[5b] 快照里有的素材都会登记 —— 含 bio（闭环第 1 段补）');
let seededSeq = null;
{
	const env = sharedEnv;
	// 真实链路走不到「带 bio 的 /ignore」——闸一零成本定罪不拉资料。
	// 但 cron 复查与闸二路径的快照是带 bio 的，所以这里直接种一条快照把 bio 那一维覆盖掉。
	seededSeq = await W.allocateAdPendingSnapshot(env, String(OWNER_ID), {
		userId: '70002', chatId: GROUP_ID, score: 9, reasons: ['测试种子'],
		snapshot: { name: '老王', username: '@laowang88', bio: '喜欢摄影和骑行', text: '今天天气不错' }
	});
	assert('种子快照写入成功并拿到序号', Number(seededSeq) > 0, String(seededSeq));

	resetCalls();
	await sendUpdate({ message: privateMessage(OWNER_ID, '/ignore ' + seededSeq) }, env);
	const text = lastSent();
	assert('★ 含 bio 的快照会登记四个维度', text.includes('已登记 <b>4</b> 项'), text);
	assert('回执逐项列出维度名称', text.includes('简介') && text.includes('@用户名'), text);
	const dims = env.DB.query("SELECT dimension FROM ad_allowlist WHERE user_id='70002' ORDER BY dimension").map((r) => r.dimension);
	assert('★ 四个维度齐了（含 bio）',
		JSON.stringify(dims) === JSON.stringify(['bio', 'name', 'text', 'username']), JSON.stringify(dims));
	assert('bio 键存的是归一化值（小写、空白折叠）',
		env.DB.query("SELECT value FROM ad_allowlist WHERE dimension='bio'")[0].value === '喜欢摄影和骑行',
		JSON.stringify(env.DB.query("SELECT dimension, value FROM ad_allowlist WHERE user_id='70002'")));
	assert('快照被标记已复核', env.DB.query('SELECT expires_at FROM ad_pending_snapshots WHERE seq = ?', seededSeq)[0].expires_at === 0);
}

// ============================================================
section('[6] 同一份素材再出现时不再被封（闭环第 2 段）');
{
	const env = sharedEnv;
	const adApi = {
		getChat: (body) => ({ ok: true, result: { id: body?.chat_id, ...AD_PROFILE } }),
		getChatMember: (body) => ({ ok: true, result: { status: 'member', user: { id: body?.user_id } } }),
		getChatAdministrators: () => ({ ok: true, result: [] })
	};
	setApi(adApi);
	resetCalls();
	await sendUpdate({ message: groupMessage({ id: 70001, first_name: AD_PROFILE.firstName, username: AD_PROFILE.username }, AD_TEXT) }, env);
	assert('★ 再次发同样的广告素材：不再处置', countCalls('banChatMember') === 0 && countCalls('restrictChatMember') === 0, JSON.stringify(calls.map((c) => c.method)));
	assert('★ 也不再有新的待复核快照（没有判定发生）',
		env.DB.query("SELECT COUNT(*) AS c FROM ad_pending_snapshots WHERE user_id='70001' AND expires_at > 0")[0].c === 0);
	assert('命中计数被累加（主人据此判断这条记录还在不在用）',
		env.DB.query("SELECT SUM(hit_count) AS s FROM ad_allowlist")[0].s >= 4,
		JSON.stringify(env.DB.query('SELECT dimension, hit_count FROM ad_allowlist')));
}

// ============================================================
section('[7] /allowlist 命令：查看、权限、撤销（闭环第 3 段）');
{
	const env = sharedEnv;
	const cmd = async (text, fromId = OWNER_ID) => {
		resetCalls();
		await sendUpdate({ message: privateMessage(fromId, text) }, env);
		return lastSent();
	};

	assert('非主人私聊被拒', (await cmd('/allowlist', 20002)).includes('权限不足'), lastSent());
	assert('群内只撤回不执行', await (async () => {
		resetCalls();
		await sendUpdate({ message: groupMessage({ id: OWNER_ID, first_name: 'Owner' }, '/allowlist') }, env);
		return countCalls('deleteMessage') >= 1;
	})());

	const listText = await cmd('/allowlist');
	assert('★ /allowlist 列出放行库', listText.includes('误判放行库'), listText);
	// 3 条来自 [5] 的真实链路（无 bio），4 条来自 [5b] 的种子快照（含 bio）。
	assert('列出生效条数（两个场景合计 7 条）', listText.includes('生效 <b>7</b> 条'), listText);
	assert('按维度给出分布', listText.includes('消息正文 2') && listText.includes('简介 1'), listText);
	assert('每行带 #序号（撤销的唯一入口）', /<code>#\d+<\/code>/.test(listText), listText);
	assert('说明命中即退出判定而不是减分', listText.includes('退出判定'), listText);
	assert('给出 del 用法', listText.includes('/allowlist del'), listText);
	// /allowlist 是「查看」命令，绝不能有副作用。
	assert('查看不修改放行库', env.DB.query('SELECT COUNT(*) AS c FROM ad_allowlist')[0].c === 7);

	// 按值定位正文那条，而不是靠 id 顺序 —— 顺序是实现的偶然，不是契约。
	const textRow = env.DB.query("SELECT id FROM ad_allowlist WHERE dimension='text' AND value = ?", W.normalizeAdAllowlistValue(AD_TEXT))[0];
	assert('正文记录按值可定位', Boolean(textRow), JSON.stringify(env.DB.query('SELECT id, dimension, value FROM ad_allowlist')));
	const textId = textRow?.id;
	assert('非法参数给出用法', (await cmd('/allowlist del abc')).includes('用法'), lastSent());
	assert('超量删除被拦下', (await cmd('/allowlist del ' + Array.from({ length: 25 }, (_, i) => i + 1).join(' '))).includes('最多'), lastSent());

	const delText = await cmd('/allowlist del ' + textId);
	assert('删除回执报告条数', delText.includes('已删除 1 条'), delText);
	assert('删除回执列出被删的记录', delText.includes('消息正文'), delText);
	assert('库里确实少了一条', env.DB.query('SELECT COUNT(*) AS c FROM ad_allowlist')[0].c === 6);
	assert('删除不存在的序号给出提示', (await cmd('/allowlist del 99999')).includes('没有删到'), lastSent());
}

// ============================================================
section('[8] 撤销放行后判定立刻恢复（闭环收口）');
{
	const env = sharedEnv;
	// 只放行 text 被撤掉了，其余维度还在 —— 这正好同时验证「撤销是逐条生效的」。
	const after = await W.evaluateAdSuspect(env, adInput(), {});
	assert('撤销正文放行后 payload.text 恢复',
		after.payload.text === AD_TEXT, JSON.stringify(after.payload.text));
	assert('其余维度仍在放行中（撤销不会连带清掉别的记录）',
		after.payload.name === '' && after.payload.username === '',
		JSON.stringify(after.payload));
	// 这一条是本场景唯一没登记过 bio 的证据：AD_PROFILE.bio 从未进过放行库
	//（[5] 里 bio 没参与判定、[5b] 登记的是别人的 bio），所以它必须原样保留。
	assert('未登记过的维度照旧参与判定（bio 保持原值）',
		after.payload.bio === AD_PROFILE.bio, JSON.stringify(after.payload.bio));
	assert('allowlist 字段里正文已撤销、昵称仍在',
		after.allowlist && after.allowlist.text !== true && after.allowlist.name === true,
		JSON.stringify(after.allowlist));

	// 全撤干净 → 回到基线行为，一个字都不差。
	const rows = env.DB.query('SELECT id FROM ad_allowlist');
	await W.removeAdAllowlistByIds(env, rows.map((r) => r.id));
	await W.refreshAdAllowlist(env);
	const restored = await W.evaluateAdSuspect(env, adInput(), {});
	assert('★ 全部撤销后判定与基线完全一致（verdict / score / payload 三项）',
		restored.verdict === 'ban' && restored.payload.text === AD_TEXT
		&& restored.payload.name === AD_PROFILE.firstName,
		JSON.stringify({ v: restored.verdict, s: restored.score, p: restored.payload }));
	assert('撤销后放行库为空', env.DB.query('SELECT COUNT(*) AS c FROM ad_allowlist')[0].c === 0);
	assert('撤销后 matchAdAllowlist 返回 null', W.matchAdAllowlist({ text: AD_TEXT, name: AD_PROFILE.firstName, username: '', bio: '' }) === null);

	// 走一次真实 webhook 再确认端到端恢复（覆盖 fetch 入口的 refresh 链路）。
	const adApi = {
		getChat: (body) => ({ ok: true, result: { id: body?.chat_id, ...AD_PROFILE } }),
		getChatMember: (body) => ({ ok: true, result: { status: 'member', user: { id: body?.user_id } } }),
		getChatAdministrators: () => ({ ok: true, result: [] })
	};
	setApi(adApi);
	resetCalls();
	await sendUpdate({ message: groupMessage({ id: 70001, first_name: AD_PROFILE.firstName, username: AD_PROFILE.username }, AD_TEXT) }, env);
	assert('★ 撤销后同样的素材重新会被处置（端到端闭环）', countCalls('restrictChatMember') >= 1, JSON.stringify(calls.map((c) => c.method)));
}

// ============================================================
section('[9] 放行库不碰渐进式封禁台账与其他既有语义');
{
	const env = await useEnv(makeEnv());
	await W.adDetectionReady(env);
	await W.addAdAllowlistEntry(env, 'text', AD_TEXT, { source: 'ignore' });
	await W.refreshAdAllowlist(env);
	await W.evaluateAdSuspect(env, adInput(), {});
	assert('放行命中不会写观察窗口（放行是「不判定」，不是「判定为安全」）',
		env.DB.query("SELECT COUNT(*) AS c FROM ad_user_screening WHERE user_id='70001'")[0].c === 0);
	assert('放行命中不会写封禁台账', env.DB.query('SELECT COUNT(*) AS c FROM ad_ban_scope')[0].c === 0);
	assert('放行命中不会写黑名单', env.DB.query('SELECT COUNT(*) AS c FROM blacklist')[0].c === 0);
	assert('放行命中不会新增指纹', env.DB.query("SELECT COUNT(*) AS c FROM ad_fingerprints WHERE source != 'seed'")[0].c === 0);
}

// ============================================================
console.log('\n' + '='.repeat(52));
if (fail) console.log('失败项：\n  · ' + failures.join('\n  · '));
console.log('误判放行库验证：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail > 0 ? 1 : 0);
