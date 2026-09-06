// 广告检测 v2 离线端到端测试。
// 与 test_export.mjs / test_leavegroup.mjs 同一范式：vm 加载 _worker.js 的 default export，
// 全部 Telegram Bot API 走 fetch mock；D1 用 node:sqlite 做真实 SQLite 后端，
// 保证 ON CONFLICT / AUTOINCREMENT / UNIQUE 索引 / batch 这些语义与线上 D1 一致。
// 运行：node test_ad_detection.mjs

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

// ---------- 真实 SQLite 驱动的 D1 兼容层 ----------
// D1 用到的 API 面（全文件 grep 确认）：prepare().bind().first()/run()/all()、DB.exec()、DB.batch()。
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
		const upper = sql.trim().slice(0, 6).toUpperCase();
		if (upper === 'SELECT' || sql.trim().toUpperCase().startsWith('PRAGMA')) {
			const rows = statement.all(...bound).map(normOut);
			return { kind: 'rows', rows };
		}
		const info = statement.run(...bound);
		return {
			kind: 'write',
			meta: {
				changes: Number(info?.changes || 0),
				last_row_id: Number(info?.lastInsertRowid || 0),
				duration: 0,
				rows_read: 0,
				rows_written: Number(info?.changes || 0)
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
				if (result.kind === 'rows') return result.rows[0] ?? null;
				return null;
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
		async exec(sql) {
			db.exec(sql);
			return { count: 1, duration: 0 };
		},
		async batch(statements) {
			const list = Array.from(statements || []);
			const out = [];
			db.exec('BEGIN');
			try {
				for (const statement of list) {
					const state = statement?.__d1;
					if (!state) throw new Error('batch 收到非本层生成的 statement');
					const result = exec(state.sql, state.params);
					if (result.kind === 'rows') out.push({ success: true, results: result.rows, meta: { changes: 0, duration: 0 } });
					else out.push({ success: true, meta: result.meta });
				}
				db.exec('COMMIT');
			} catch (error) {
				db.exec('ROLLBACK');
				throw error;
			}
			return out;
		},
		query(sql, ...params) {
			return db.prepare(sql).all(...params).map(normOut);
		}
	};
}

// ---------- 断言 ----------
let pass = 0;
let fail = 0;
const failures = [];

function assert(name, condition, detail = '') {
	if (condition) {
		pass += 1;
		console.log(`  OK   ${name}`);
	} else {
		fail += 1;
		failures.push(name);
		console.log(`  FAIL ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`);
	}
}

function section(title) {
	console.log(`\n${title}`);
}

// ---------- Telegram Bot API mock ----------
const calls = [];
let apiHandlers = {};

function setApi(next = {}) {
	apiHandlers = next;
}

function resetCalls() {
	calls.length = 0;
	setApi();
}

function countCalls(method) {
	return calls.filter((c) => c.method === method).length;
}

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

// 伪 Workers AI：把文本映射成确定性向量，方便断言相似度分支。
// 「广告样本」共用同一向量，正常文本用正交向量，余弦相似度可控。
function makeFakeAI(mapper) {
	return {
		calls: 0,
		async run(model, input) {
			this.calls += 1;
			const text = String(input?.text?.[0] ?? '');
			const vector = mapper(text);
			return { data: [vector] };
		}
	};
}

function adVector(text) {
	const isAd = /收购|网赚|USDT|代理|洗急|稳宝|辣妞|风口|高价收|日结/.test(text);
	const base = new Array(768).fill(0);
	if (isAd) { base[0] = 1; base[1] = 0.5; } else { base[2] = 1; base[3] = 0.5; }
	return base;
}

// ---------- webhook 驱动 ----------
// 收集本次请求里 ctx.waitUntil 收到的后台任务。sendFlashMessage 的延时撤回就挂在这上面，
// 空实现的 waitUntil 会让「闪屏是否真被撤回」这类断言永远测不到（曾因此漏掉一个
// ctx 传 null 导致闪屏永久残留的缺陷），所以这里必须真实收集。
let pendingWaits = [];
function resetWaits() { pendingWaits = []; }
// 跑完所有后台任务。sendFlashMessage 内部先 setTimeout(ttlMs) 再删消息，
// 用假定时器会牵连产品代码，这里直接 await 真实 promise —— 测试里 ttl 最长 8 秒，
// 故只在需要验证撤回的断言前调用，普通用例不必等。
async function flushWaits() {
	const tasks = pendingWaits;
	pendingWaits = [];
	await Promise.allSettled(tasks);
}
async function sendUpdate(update, env) {
	const request = new Request('https://example.workers.dev/', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ update_id: Math.floor(Math.random() * 1e9), ...update })
	});
	const response = await handler.fetch(request, env, {
		waitUntil(promise) { pendingWaits.push(Promise.resolve(promise).catch(() => {})); }
	});
	return response;
}

function privateMessage(fromId, text) {
	return {
		message_id: 100 + Math.floor(Math.random() * 1000),
		date: Math.floor(Date.now() / 1000),
		text,
		chat: { id: fromId, type: 'private', first_name: 'Owner' },
		from: { id: fromId, is_bot: false, first_name: 'Owner' }
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

function joinMessage(members) {
	return {
		message_id: 300 + Math.floor(Math.random() * 1000),
		date: Math.floor(Date.now() / 1000),
		chat: { id: Number(GROUP_ID), type: 'supergroup', title: '测试治理群' },
		from: { id: members[0].id, is_bot: false, first_name: members[0].first_name || '新人' },
		new_chat_members: members.map((m) => ({ is_bot: false, ...m }))
	};
}

// 初始化模块级配置（BOT_TOKEN / GROUP_IDS / OWNER_IDS 由 fetch 入口的 applyConfig 写入）。
// 后面的纯函数单测依赖这些全局变量，所以必须先跑一次真实 webhook。
const bootEnv = makeEnv();
resetCalls();
await sendUpdate({ message: privateMessage(99999, 'hello') }, bootEnv);

const W = sandbox;										// worker 内部顶层函数（vm 脚本的函数声明会挂到全局）

section('[1] 结构化评分层（纯函数，零网络）');
{
	const adProfile = W.scoreAdProfile({
		firstName: '💚高价收网赚号💚',
		bio: '长期收购网 du 商宝账号，老账号优先加价'
	});
	assert('广告号资料得分 >= 封禁阈值 7', adProfile.score >= 7, JSON.stringify(adProfile));
	assert('广告号命中对称 emoji', adProfile.reasons.some((r) => r.includes('对称 emoji')), JSON.stringify(adProfile.reasons));
	assert('广告号命中交易动词', adProfile.tradeHits.length > 0, JSON.stringify(adProfile.tradeHits));
	assert('广告号命中业务关键词', adProfile.businessHits.length > 0, JSON.stringify(adProfile.businessHits));

	const normal = W.scoreAdProfile({ firstName: '张三', bio: '' });
	assert('普通用户资料得分为 0', normal.score === 0, JSON.stringify(normal));

	const tech = W.scoreAdProfile({ firstName: 'Alice Dev', bio: '开源 bot 双向机器人 github.com/alice' });
	assert('技术用户被豁免词压到 0 分', tech.score === 0, JSON.stringify(tech));
	assert('技术用户白名单域名不计分', !tech.reasons.some((r) => r.includes('引流链接')), JSON.stringify(tech.reasons));

	const restricted = W.scoreAdProfile({ firstName: '路人', bio: '有需要私聊', status: 'restricted' });
	assert('restricted 状态 +5', restricted.reasons.some((r) => r.startsWith('+5')), JSON.stringify(restricted.reasons));

	const adText = W.scoreAdMessageText('长期收购网赚账号 USDT 秒结不拖欠');
	assert('广告正文得分 >= 4', adText.score >= 4, JSON.stringify(adText));
	const chatText = W.scoreAdMessageText('大家好，今天天气不错，一起吃饭吗');
	assert('正常聊天正文得分为 0', chatText.score === 0, JSON.stringify(chatText));

	const forwardAd = W.scoreAdForwardChat({ title: '💚高价收网赚号💚', username: 'aaa_channel' });
	assert('广告频道转发判定为广告来源', forwardAd.isAd === true, JSON.stringify(forwardAd));
	const forwardNormal = W.scoreAdForwardChat({ title: 'Cloudflare 官方公告', username: 'cf_news' });
	assert('正常频道转发不判定为广告来源', forwardNormal.isAd === false, JSON.stringify(forwardNormal));

	assert('adTextHash 同文本稳定', W.adTextHash('测试文本') === W.adTextHash('测试文本'));
	assert('adTextHash 不同文本不同', W.adTextHash('测试文本A') !== W.adTextHash('测试文本B'));
	assert('adTextHash 输出 16 位 hex', /^[0-9a-f]{16}$/.test(W.adTextHash('x')), W.adTextHash('x'));

	assert('域名归一化剥协议端口路径', W.normalizeAdDomain('https://Example.COM:8080/a/b?c=1') === 'example.com', W.normalizeAdDomain('https://Example.COM:8080/a/b?c=1'));
	assert('域名归一化保留通配写法', W.normalizeAdDomain('*.Example.com') === '*.example.com');
	assert('提取域名', W.extractAdDomains('看 github.com/x 和 evil-shop.top').includes('evil-shop.top'), JSON.stringify(W.extractAdDomains('看 github.com/x 和 evil-shop.top')));

	assert('对称 emoji 名称重复段落检测', W.hasAdRepeatedSegment('收购账号,收购账号') === true);
	assert('普通句子无重复段落', W.hasAdRepeatedSegment('今天天气不错，出门走走') === false);

	assert('回复学习：肯定词', W.classifyAdReplyIntent('这是广告') === 'positive');
	assert('回复学习：否定词优先于肯定词', W.classifyAdReplyIntent('不是广告') === 'negative');
	assert('回复学习：误封也算否定', W.classifyAdReplyIntent('误封了') === 'negative');
	assert('回复学习：无关短句不触发', W.classifyAdReplyIntent('好的收到') === '');
	assert('回复学习：超 20 字不触发', W.classifyAdReplyIntent('这条消息我看了半天觉得应该算是广告吧你怎么看') === '', W.classifyAdReplyIntent('这条消息我看了半天觉得应该算是广告吧你怎么看'));
	assert('回复学习：空文本不触发', W.classifyAdReplyIntent('') === '');
	// 默认自助解封确认句正好 20 字，不超过长度闸门，含「误封」会被判为 negative。
	// 实际不冲突：该句是私聊自助解封流程，而回复学习要求「配置群 + 引用消息 + 管理层身份」三条同时成立。
	assert('回复学习：默认自助解封句长度正好 20 字', '我不是广告狗，我是误封的，希望可以解封。'.length === 20);
	assert('回复学习：自助解封句被判为 negative（仅在群内引用场景才会走到）', W.classifyAdReplyIntent('我不是广告狗，我是误封的，希望可以解封。') === 'negative');
}

section('[2] 配置解析（空串把阈值顶成 0 的陷阱）');
{
	const empty = W.loadAdDetectionConfig({ AD_SCORE_THRESHOLD: '', AD_OBSERVATION_SCORE: '   ' });
	assert('空串回落默认封禁阈值 7', empty.scoreThreshold === 7, JSON.stringify(empty));
	assert('空白串回落默认观察阈值 5', empty.observationScore === 5, JSON.stringify(empty));
	const bad = W.loadAdDetectionConfig({ AD_SCORE_THRESHOLD: 'abc', AD_AI_SIMILARITY_THRESHOLD: '9' });
	assert('非数字回落默认', bad.scoreThreshold === 7, JSON.stringify(bad));
	assert('超范围相似度回落默认 0.78', bad.aiSimilarityThreshold === 0.78, JSON.stringify(bad));
	const zero = W.loadAdDetectionConfig({ AD_SCORE_THRESHOLD: '0' });
	assert('阈值 0 低于下限被拒', zero.scoreThreshold === 7, JSON.stringify(zero));
	const ok = W.loadAdDetectionConfig({ AD_SCORE_THRESHOLD: '12', AD_OBSERVATION_HOURS: '48' });
	assert('合法值生效', ok.scoreThreshold === 12 && ok.observationHours === 48, JSON.stringify(ok));
	assert('无 AI 绑定时 aiEnabled=false', ok.aiEnabled === false);
	assert('有 AI 绑定时 aiEnabled=true', W.loadAdDetectionConfig({ AI: { run() {} } }).aiEnabled === true);
}

section('[3] D1 建表、种子与降级');
{
	const env = makeEnv();
	assert('adDetectionReady 首次建表成功', (await W.adDetectionReady(env)) === true);
	const tables = env.DB.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map((r) => r.name);
	for (const table of ['ad_fingerprints', 'ad_user_screening', 'ad_sample_embeddings', 'ad_domain_whitelist', 'ad_pending_snapshots', 'ad_confirm_tokens']) {
		assert(`表 ${table} 已建立`, tables.includes(table), JSON.stringify(tables));
	}
	assert('核心表 blacklist 仍在（未破坏既有结构）', tables.includes('blacklist'), JSON.stringify(tables));
	const seededDomains = env.DB.query('SELECT COUNT(*) AS c FROM ad_domain_whitelist')[0].c;
	assert('域名白名单种子已写入', seededDomains >= 40, String(seededDomains));
	const seededSamples = env.DB.query('SELECT COUNT(*) AS c FROM ad_sample_embeddings')[0].c;
	assert('AI 样本种子已写入 10 条', seededSamples === 10, String(seededSamples));
	assert('样本向量初始为空（懒加载）', env.DB.query('SELECT COUNT(*) AS c FROM ad_sample_embeddings WHERE embedding IS NULL')[0].c === 10);
	assert('二次调用直接命中缓存', (await W.adDetectionReady(env)) === true);

	assert('未绑定 D1 时整套检测静默跳过', (await W.adDetectionReady({})) === false);
	const whitelist = await W.loadAdDomainWhitelist(env);
	assert('白名单命中裸域', W.isAdDomainWhitelisted('github.com', whitelist) === true);
	assert('白名单命中子域', W.isAdDomainWhitelisted('gist.github.com', whitelist) === true);
	assert('白名单不误命中广告域', W.isAdDomainWhitelisted('evil-shop.top', whitelist) === false);
}

section('[4] 指纹库读写与误报回滚');
{
	const env = makeEnv();
	await W.adDetectionReady(env);
	const payload = {
		name: '💚高价收网赚号💚',
		username: '@ad_seller_001',
		bio: '长期收购网 du 商宝账号，老账号优先加价，进群联系 @promo_channel_x 或 evil-shop.top',
		text: '',
		domains: []
	};
	const learned = await W.learnAdFingerprints(env, payload, { source: 'auto', createdBy: 'system' });
	assert('自动学习成功', learned.ok === true && learned.learned > 0, JSON.stringify(learned));
	const rows = env.DB.query('SELECT type, value FROM ad_fingerprints ORDER BY id');
	assert('学到 keyword 类指纹', rows.some((r) => r.type === 'keyword'), JSON.stringify(rows));
	assert('学到 bio 类指纹', rows.some((r) => r.type === 'bio'), JSON.stringify(rows));
	assert('学到 bio 内 @引流账号（username 类）', rows.some((r) => r.type === 'username' && r.value === '@promo_channel_x'), JSON.stringify(rows));
	assert('学到非白名单域名（domain 类）', rows.some((r) => r.type === 'domain' && r.value === 'evil-shop.top'), JSON.stringify(rows));
	// 广告号自身的 username 也入库：广告团伙常把同一批 @handle 在换名换简介后反复启用，
	// 而 markAdFingerprintFalsePositive 的 haystack 本就含 payload.username（回滚侧一直认这一维度），
	// 学习侧不入库会让两边不对称，因此这里要求自身 username 与资料里的引流账号都落库。
	assert('广告号自身 username 被学成指纹', rows.some((r) => r.type === 'username' && r.value === '@ad_seller_001'), JSON.stringify(rows));

	const noVerb = await W.learnAdFingerprints(env, { name: '张三', bio: '个人简介', text: '' }, { source: 'auto' });
	assert('无交易动词的载荷拒绝自动学习', noVerb.learned === 0 && noVerb.reason === 'no_trade_verb', JSON.stringify(noVerb));

	const matched = await W.matchAdFingerprints(env, payload, {});
	assert('指纹库能命中同一广告', matched.hits.length > 0, JSON.stringify(matched.hits?.slice(0, 3)));
	assert('命中后计分为正', matched.score > 0, String(matched.score));
	const clean = await W.matchAdFingerprints(env, { name: '李四', username: '', bio: '喜欢摄影', text: '', domains: [] }, {});
	assert('正常资料不命中指纹', clean.hits.length === 0, JSON.stringify(clean.hits));

	const fpBefore = env.DB.query("SELECT confidence FROM ad_fingerprints WHERE type='bio'")[0].confidence;
	await W.markAdFingerprintFalsePositive(env, payload);
	const fpAfter = env.DB.query("SELECT confidence FROM ad_fingerprints WHERE type='bio'")[0].confidence;
	assert('标记误报后置信度下降', fpAfter < fpBefore, `${fpBefore} -> ${fpAfter}`);

	const added = await W.addAdFingerprint(env, 'evil-shop.top', { createdBy: String(OWNER_ID) });
	assert('/addword 底层新增成功', added.ok === true, JSON.stringify(added));
	assert('/addword 自动推断为 domain 类型', added.type === 'domain', JSON.stringify(added));
	const listed = await W.listAdFingerprints(env, { limit: 50, offset: 0 });
	assert('列表返回总数', listed.total >= 4, JSON.stringify({ total: listed.total }));
	const removed = await W.removeAdFingerprint(env, 'evil-shop.top');
	assert('删除指纹成功', removed.ok === true, JSON.stringify(removed));
	assert('删除后库内不再有该域名', env.DB.query("SELECT COUNT(*) AS c FROM ad_fingerprints WHERE value='evil-shop.top'")[0].c === 0);
}

section('[5] AI 语义层三分支（硬命中 / 软加分 / 未绑定降级）');
{
	// 样本种子全部是广告文本，伪 AI 把它们映射到同一个「广告向量」；
	// 待检文本命中同一批关键词即得到余弦 1.0，从而稳定触发硬命中分支。
	const suspect = { profile: { firstName: '路人甲', bio: '洗急两分钟一单', status: 'member' }, text: '', forwardChat: null };

	const envNoAi = makeEnv();
	await W.adDetectionReady(envNoAi);
	const noAi = await W.evaluateAdSuspect(envNoAi, suspect, {});
	assert('无 AI 绑定：该样本结构化得分仅 2 分', noAi.score === 2, JSON.stringify(noAi.reasons));
	assert('无 AI 绑定：verdict 不是 ban（降级不误封）', noAi.verdict !== 'ban', JSON.stringify(noAi));
	assert('无 AI 绑定：相似度恒为 0', noAi.aiSimilarity === 0, String(noAi.aiSimilarity));

	const envAi = makeEnv({ AI: makeFakeAI(adVector) });
	await W.adDetectionReady(envAi);
	const hard = await W.evaluateAdSuspect(envAi, suspect, {});
	assert('AI 硬命中：verdict = ban', hard.verdict === 'ban', JSON.stringify(hard));
	assert('AI 硬命中：判定层标记为 ai', hard.layer === 'ai', hard.layer);
	assert('AI 硬命中：相似度 >= 阈值 0.78', hard.aiSimilarity >= 0.78, String(hard.aiSimilarity));
	assert('AI 硬命中：判定依据写明相似度', hard.reasons.some((r) => r.includes('AI 语义相似度')), JSON.stringify(hard.reasons));
	assert('AI 硬命中：回带命中样本原文', typeof hard.aiSample === 'string' && hard.aiSample.length > 0, String(hard.aiSample));
	assert('AI 硬命中：得分低于阈值也照样定罪（hardHit 优先）', hard.score < 7, String(hard.score));
	assert('样本向量已被懒加载写入 D1', envAi.DB.query('SELECT COUNT(*) AS c FROM ad_sample_embeddings WHERE embedding IS NOT NULL')[0].c >= 8);

	// 软加分：探针向量 [1, 0.2, 0.8] 与广告向量 [1, 0.5] 的余弦 ≈ 0.759，落在 [0.65, 0.78)。
	const softProbe = { profile: { firstName: '弱相似探针', bio: '有需要', status: 'member' }, text: '', forwardChat: null };
	const softMapper = (text) => {
		const vector = new Array(768).fill(0);
		if (text.includes('弱相似探针')) { vector[0] = 1; vector[1] = 0.2; vector[2] = 0.8; return vector; }
		vector[0] = 1; vector[1] = 0.5;
		return vector;
	};
	const envSoftBase = makeEnv();
	await W.adDetectionReady(envSoftBase);
	const softBase = await W.evaluateAdSuspect(envSoftBase, softProbe, {});
	const envSoft = makeEnv({ AI: makeFakeAI(softMapper) });
	await W.adDetectionReady(envSoft);
	const soft = await W.evaluateAdSuspect(envSoft, softProbe, {});
	assert('AI 软加分：相似度落在 [0.65, 0.78)', soft.aiSimilarity >= 0.65 && soft.aiSimilarity < 0.78, String(soft.aiSimilarity));
	assert('AI 软加分：只加 2 分不定罪', soft.score === softBase.score + 2, `${softBase.score} -> ${soft.score}`);
	assert('AI 软加分：判定层不升级为 ai', soft.layer !== 'ai', soft.layer);
	assert('AI 软加分：verdict 不是 ban', soft.verdict !== 'ban', JSON.stringify(soft));
	assert('AI 软加分：判定依据写明弱相似', soft.reasons.some((r) => r.includes('AI 语义弱相似')), JSON.stringify(soft.reasons));

	// 正常用户即便走完 AI 层也不该被判广告：伪 AI 给正交向量，余弦为 0。
	const envClean = makeEnv({ AI: makeFakeAI(adVector) });
	await W.adDetectionReady(envClean);
	const clean = await W.evaluateAdSuspect(envClean, { profile: { firstName: '李四', bio: '喜欢摄影和骑行', status: 'member' }, text: '', forwardChat: null }, {});
	assert('正常用户：AI 层相似度为 0', clean.aiSimilarity === 0, String(clean.aiSimilarity));
	assert('正常用户：verdict = pass', clean.verdict === 'pass', JSON.stringify(clean));

	// 语义文本过短（< 6 字）直接跳过 AI，节省推理预算。
	const envShort = makeEnv({ AI: makeFakeAI(adVector) });
	await W.adDetectionReady(envShort);
	const aiBefore = envShort.AI.calls;
	await W.evaluateAdSuspect(envShort, { profile: { firstName: '洗急', bio: '', status: 'member' }, text: '', forwardChat: null }, {});
	assert('语义文本过短时不调用 AI', envShort.AI.calls === aiBefore, `${aiBefore} -> ${envShort.AI.calls}`);
}

section('[6] 入群检测端到端（webhook → 封禁 → 快照 → 私聊通知）');
{
	const ownerNoticeText = () => calls
		.filter((c) => c.method === 'sendMessage' && String(c.body?.chat_id) === String(OWNER_ID))
		.map((c) => String(c.body?.text || '')).join('\n');

	const env = makeEnv();
	resetCalls();
	setApi({
		getChat: (body) => ({ ok: true, result: { id: body?.chat_id, first_name: '💚高价收网赚号💚', bio: '长期收购网 du 商宝账号，老账号优先加价' } }),
		getChatMember: (body) => ({ ok: true, result: { status: 'member', user: { id: body?.user_id } } }),
		getChatAdministrators: () => ({ ok: true, result: [] })
	});
	await sendUpdate({ message: joinMessage([{ id: 50001, first_name: '💚高价收网赚号💚' }]) }, env);
	assert('广告号进群：触发全群封禁', countCalls('banChatMember') >= 1, JSON.stringify(calls.map((c) => c.method)));
	assert('广告号进群：写入黑名单', env.DB.query("SELECT id, reason FROM blacklist WHERE id = '50001'").length === 1, JSON.stringify(env.DB.query('SELECT id, reason FROM blacklist')));
	assert('广告号进群：黑名单 reason = ad_auto', env.DB.query("SELECT reason FROM blacklist WHERE id = '50001'")[0]?.reason === 'ad_auto');
	assert('广告号进群：生成待确认快照 seq=1', env.DB.query('SELECT seq, user_id FROM ad_pending_snapshots')[0]?.seq === 1, JSON.stringify(env.DB.query('SELECT seq, user_id FROM ad_pending_snapshots')));
	assert('广告号进群：快照绑定该用户', env.DB.query('SELECT user_id FROM ad_pending_snapshots')[0]?.user_id === '50001');
	assert('广告号进群：自动学入指纹', env.DB.query('SELECT COUNT(*) AS c FROM ad_fingerprints')[0].c > 0);
	assert('广告号进群：观察窗口不留残留', env.DB.query('SELECT COUNT(*) AS c FROM ad_user_screening')[0].c === 0);
	assert('私聊通知发给第一主人', ownerNoticeText().length > 0, JSON.stringify(calls.filter((c) => c.method === 'sendMessage').map((c) => c.body?.chat_id)));
	assert('通知含标题「广告号自动封禁」', ownerNoticeText().includes('广告号自动封禁'), ownerNoticeText());
	assert('通知含 /confirm 1', ownerNoticeText().includes('/confirm 1'), ownerNoticeText());
	assert('通知含 /ignore 1', ownerNoticeText().includes('/ignore 1'), ownerNoticeText());
	assert('通知含判定层与得分', ownerNoticeText().includes('判定层：') && ownerNoticeText().includes('得分：'), ownerNoticeText());
	assert('通知含来源群标题', ownerNoticeText().includes('测试治理群'), ownerNoticeText());
	assert('通知含封禁结果统计', ownerNoticeText().includes('封禁结果：'), ownerNoticeText());

	// 正常新人：零封禁、零快照，且既有进群逻辑照旧。
	const env2 = makeEnv();
	resetCalls();
	setApi({
		getChat: (body) => ({ ok: true, result: { id: body?.chat_id, first_name: '张三', bio: '' } }),
		getChatMember: (body) => ({ ok: true, result: { status: 'member', user: { id: body?.user_id } } })
	});
	await sendUpdate({ message: joinMessage([{ id: 50002, first_name: '张三' }]) }, env2);
	assert('正常新人：不触发封禁', countCalls('banChatMember') === 0, JSON.stringify(calls.map((c) => c.method)));
	assert('正常新人：不进黑名单', env2.DB.query('SELECT COUNT(*) AS c FROM blacklist')[0].c === 0);
	assert('正常新人：不生成快照', env2.DB.query('SELECT COUNT(*) AS c FROM ad_pending_snapshots')[0].c === 0);
	assert('正常新人：不进观察窗口', env2.DB.query('SELECT COUNT(*) AS c FROM ad_user_screening')[0].c === 0);

	// 主人本人进群：连资料都不拉，彻底豁免。
	const env3 = makeEnv();
	resetCalls();
	await sendUpdate({ message: joinMessage([{ id: OWNER_ID, first_name: '💚高价收网赚号💚' }]) }, env3);
	assert('主人进群：不拉取资料', countCalls('getChat') === 0, JSON.stringify(calls.map((c) => c.method)));
	assert('主人进群：不触发封禁', countCalls('banChatMember') === 0);

	// 群管理员进群：getChatAdministrators 认定为管理员后直接跳过。
	const env4 = makeEnv();
	resetCalls();
	setApi({
		getChatAdministrators: () => ({ ok: true, result: [{ user: { id: 50003, is_bot: false }, status: 'administrator' }] }),
		getChat: (body) => ({ ok: true, result: { id: body?.chat_id, first_name: '💚高价收网赚号💚', bio: '长期收购网赚账号' } })
	});
	await sendUpdate({ message: joinMessage([{ id: 50003, first_name: '💚高价收网赚号💚' }]) }, env4);
	assert('管理员进群：不触发封禁', countCalls('banChatMember') === 0, JSON.stringify(calls.map((c) => c.method)));
	assert('管理员进群：不进黑名单', env4.DB.query('SELECT COUNT(*) AS c FROM blacklist')[0].c === 0);

	// 机器人进群：交给既有 handleNewChatMemberBots，广告层不插手。
	const env5 = makeEnv();
	resetCalls();
	await sendUpdate({ message: joinMessage([{ id: 50004, is_bot: true, first_name: 'SomeBot' }]) }, env5);
	assert('bot 进群：广告层不拉资料', countCalls('getChat') === 0, JSON.stringify(calls.map((c) => c.method)));
	assert('bot 进群：不进黑名单', env5.DB.query('SELECT COUNT(*) AS c FROM blacklist')[0].c === 0);
}

section('[7] 消息检测端到端（零成本预筛 → 三层判定 → 观察累加）');
{
	const ownerNoticeText = () => calls
		.filter((c) => c.method === 'sendMessage' && String(c.body?.chat_id) === String(OWNER_ID))
		.map((c) => String(c.body?.text || '')).join('\n');
	const AD_TEXT = '长期收购网赚账号 USDT，进群联系 @promo_seller_x';
	const plainProfile = {
		getChat: (body) => ({ ok: true, result: { id: body?.chat_id, first_name: '路人', bio: '' } }),
		getChatMember: (body) => ({ ok: true, result: { status: 'member', user: { id: body?.user_id } } })
	};
	const adProfile = {
		getChat: (body) => ({ ok: true, result: { id: body?.chat_id, first_name: '💚高价收网赚号💚', bio: '长期收购网 du 商宝账号，优先加价' } }),
		getChatMember: (body) => ({ ok: true, result: { status: 'member', user: { id: body?.user_id } } })
	};

	// 正常聊天：quickScore = 0，直接零成本退出，一个子请求都不发。
	const env1 = makeEnv();
	resetCalls();
	setApi(plainProfile);
	await sendUpdate({ message: groupMessage({ id: 60001, first_name: '张三' }, '大家好，今天天气不错，一起吃饭吗') }, env1);
	assert('正常聊天：不拉取用户资料（零成本退出）', countCalls('getChat') === 0, JSON.stringify(calls.map((c) => c.method)));
	assert('正常聊天：不查管理员', countCalls('getChatAdministrators') === 0, JSON.stringify(calls.map((c) => c.method)));
	assert('正常聊天：不触发封禁', countCalls('banChatMember') === 0);
	assert('正常聊天：不写观察窗口', env1.DB.query('SELECT COUNT(*) AS c FROM ad_user_screening')[0].c === 0);

	// 广告正文 + 广告资料：合计远超阈值，即时封禁并推快照。
	const env2 = makeEnv();
	resetCalls();
	setApi(adProfile);
	await sendUpdate({ message: groupMessage({ id: 60002, first_name: '💚高价收网赚号💚' }, AD_TEXT) }, env2);
	assert('广告消息：拉取用户资料', countCalls('getChat') >= 1, JSON.stringify(calls.map((c) => c.method)));
	assert('广告消息：触发全群封禁', countCalls('banChatMember') >= 1, JSON.stringify(calls.map((c) => c.method)));
	assert('广告消息：删除触发消息', countCalls('deleteMessage') >= 1, JSON.stringify(calls.map((c) => c.method)));
	assert('广告消息：写入黑名单', env2.DB.query("SELECT COUNT(*) AS c FROM blacklist WHERE id = '60002'")[0].c === 1);
	assert('广告消息：生成快照', env2.DB.query('SELECT COUNT(*) AS c FROM ad_pending_snapshots')[0].c === 1);
	assert('广告消息：通知含消息正文', ownerNoticeText().includes('长期收购网赚账号'), ownerNoticeText());

	// 中间分数：只写观察窗口，不封禁。
	const env3 = makeEnv();
	resetCalls();
	setApi(plainProfile);
	await sendUpdate({ message: groupMessage({ id: 60003, first_name: '路人' }, AD_TEXT) }, env3);
	assert('中间分数：不封禁', countCalls('banChatMember') === 0, JSON.stringify(calls.map((c) => c.method)));
	assert('中间分数：不进黑名单', env3.DB.query('SELECT COUNT(*) AS c FROM blacklist')[0].c === 0);
	const observed = env3.DB.query('SELECT user_id, score, layer FROM ad_user_screening');
	assert('中间分数：写入观察窗口', observed.length === 1 && observed[0].user_id === '60003', JSON.stringify(observed));
	assert('中间分数：观察分为 6（正文 2+2+2）', observed[0]?.score === 6, JSON.stringify(observed));
	assert('中间分数：不推私聊快照', env3.DB.query('SELECT COUNT(*) AS c FROM ad_pending_snapshots')[0].c === 0);

	// 观察窗口历史分累加：本条正文只有 3 分，叠加历史 4 分正好到 7 分封禁线。
	const env4 = makeEnv();
	await W.adDetectionReady(env4);
	await W.upsertAdScreening(env4, '60004', {
		chatId: GROUP_ID, score: 4, reasons: ['测试预置历史分'], snapshot: { name: '青山落日' }, layer: 'score'
	}, W.loadAdDetectionConfig(env4));
	assert('历史分预置成功', env4.DB.query("SELECT score FROM ad_user_screening WHERE user_id = '60004'")[0]?.score === 4);
	resetCalls();
	setApi(plainProfile);
	await sendUpdate({ message: groupMessage({ id: 60004, first_name: '路人' }, '💚青山落日💚') }, env4);
	assert('历史分累加：触发封禁', countCalls('banChatMember') >= 1, JSON.stringify(calls.map((c) => c.method)));
	assert('历史分累加：判定依据写明历史分', ownerNoticeText().includes('观察窗口历史分'), ownerNoticeText());
	assert('历史分累加：最终得分 7', ownerNoticeText().includes('得分：<b>7</b>'), ownerNoticeText());
	assert('历史分累加：处置后清空观察记录', env4.DB.query('SELECT COUNT(*) AS c FROM ad_user_screening')[0].c === 0);

	// 转发广告频道：无正文也能命中，转发来源单独计分。
	const env5 = makeEnv();
	resetCalls();
	setApi(adProfile);
	await sendUpdate({
		message: groupMessage({ id: 60005, first_name: '搬运工' }, undefined, {
			text: undefined,
			caption: '进群联系 @promo_channel_x',
			forward_from_chat: { id: -1009999, type: 'channel', title: '💚高价收网赚号💚', username: 'aaa_channel' }
		})
	}, env5);
	assert('转发广告频道：触发封禁', countCalls('banChatMember') >= 1, JSON.stringify(calls.map((c) => c.method)));
	assert('转发广告频道：通知含转发来源', ownerNoticeText().includes('转发来源：'), ownerNoticeText());

	// slash 命令一律跳过检测，避免和既有命令分发抢消息。
	// 这里先手动建表：detectAdOnMessage 在 isTelegramSlashCommand 处就早退了，
	// 根本走不到 adDetectionReady，不预建表则下面的「零写入」断言无表可查。
	const env6 = makeEnv();
	await W.adDetectionReady(env6);
	resetCalls();
	setApi(adProfile);
	await sendUpdate({ message: groupMessage({ id: 60006, first_name: '路人' }, '/notacommand ' + AD_TEXT) }, env6);
	assert('slash 命令：不触发封禁', countCalls('banChatMember') === 0, JSON.stringify(calls.map((c) => c.method)));
	assert('slash 命令：不进黑名单', env6.DB.query('SELECT COUNT(*) AS c FROM blacklist')[0].c === 0);
	assert('slash 命令：不写观察窗口', env6.DB.query('SELECT COUNT(*) AS c FROM ad_user_screening')[0].c === 0);

	// 群管理员发同样的文本：鉴权通过即跳过，连资料都不拉。
	const env7 = makeEnv();
	resetCalls();
	setApi({
		...adProfile,
		getChatAdministrators: () => ({ ok: true, result: [{ user: { id: 60007, is_bot: false }, status: 'administrator' }] })
	});
	await sendUpdate({ message: groupMessage({ id: 60007, first_name: '群管' }, AD_TEXT) }, env7);
	assert('群管理员：不拉资料', countCalls('getChat') === 0, JSON.stringify(calls.map((c) => c.method)));
	assert('群管理员：不触发封禁', countCalls('banChatMember') === 0);

	// 主人在群里发广告样本文本（测试用）：isPrivilegedManager 直接豁免。
	const env8 = makeEnv();
	resetCalls();
	setApi(adProfile);
	await sendUpdate({ message: groupMessage({ id: OWNER_ID, first_name: 'Owner' }, AD_TEXT) }, env8);
	assert('主人豁免：不触发封禁', countCalls('banChatMember') === 0, JSON.stringify(calls.map((c) => c.method)));
	assert('主人豁免：不查管理员', countCalls('getChatAdministrators') === 0);

	// 非配置群：广告检测完全不介入（同样预建表，否则无表可查）。
	const env9 = makeEnv();
	await W.adDetectionReady(env9);
	resetCalls();
	setApi(adProfile);
	const outsider = groupMessage({ id: 60009, first_name: '路人' }, AD_TEXT);
	outsider.chat = { id: -1002222222222, type: 'supergroup', title: '陌生群' };
	await sendUpdate({ message: outsider }, env9);
	assert('非配置群：不触发封禁', countCalls('banChatMember') === 0, JSON.stringify(calls.map((c) => c.method)));
	assert('非配置群：不写任何检测数据', env9.DB.query('SELECT COUNT(*) AS c FROM ad_user_screening')[0].c === 0);
}

section('[8] 命令层端到端（权限、快照闭环、指纹与样本维护）');
{
	const adProfileApi = {
		getChat: (body) => ({ ok: true, result: { id: body?.chat_id, first_name: '💚高价收网赚号💚', bio: '长期收购网 du 商宝账号，老账号优先加价' } }),
		getChatMember: (body) => ({ ok: true, result: { status: 'member', user: { id: body?.user_id } } }),
		getChatAdministrators: () => ({ ok: true, result: [] })
	};
	const runAdBan = async (env, userId) => {
		setApi(adProfileApi);
		await sendUpdate({ message: joinMessage([{ id: userId, first_name: '💚高价收网赚号💚' }]) }, env);
	};
	const cmd = async (env, text, fromId = OWNER_ID) => {
		resetCalls();
		await sendUpdate({ message: privateMessage(fromId, text) }, env);
		return lastSent();
	};

	// 权限闸门：非第一主人私聊被拒，群内只撤命令不回权限提示。
	// 预建表的原因同上：权限不足时命令在 isPrimaryOwner 处就 return 了，不会碰 D1。
	const envAuth = makeEnv();
	await W.adDetectionReady(envAuth);
	assert('非主人私聊 /pending 被拒', (await cmd(envAuth, '/pending', 20002)).includes('权限不足'), lastSent());
	assert('非主人私聊 /addword 被拒', (await cmd(envAuth, '/addword 收U秒结', 20002)).includes('仅限第一主人私聊'), lastSent());
	assert('非主人被拒时不落库', envAuth.DB.query('SELECT COUNT(*) AS c FROM ad_fingerprints')[0].c === 0);
	resetCalls();
	await sendUpdate({ message: groupMessage({ id: OWNER_ID, first_name: 'Owner' }, '/addword 群内不该执行') }, envAuth);
	assert('群内广告命令被撤回', countCalls('deleteMessage') >= 1, JSON.stringify(calls.map((c) => c.method)));
	assert('群内广告命令引导去私聊', allSentText().includes('请在私聊中使用'), allSentText());
	assert('群内广告命令不执行写入', envAuth.DB.query('SELECT COUNT(*) AS c FROM ad_fingerprints')[0].c === 0);

	// 未绑定 D1：命令直接给出明确提示，不抛异常。
	const envNoDb = { TOKEN: 'TESTTOKEN', BOT_TOKEN: '123456:fake', GROUP_ID, OWNER_IDS: String(OWNER_ID) };
	assert('未绑定 D1 时命令提示未绑定', (await cmd(envNoDb, '/adstats')).includes('未绑定 D1'), lastSent());

	// /pending 空库
	const env = makeEnv();
	assert('/pending 空库提示', (await cmd(env, '/pending')).includes('当前没有待确认的广告判定记录'), lastSent());

	// 触发一次自动封禁 → /pending 列出 #1
	await runAdBan(env, 70001);
	const pendingText = await cmd(env, '/pending');
	assert('/pending 列出序号 #1', pendingText.includes('#1'), pendingText);
	assert('/pending 列出用户 ID', pendingText.includes('70001'), pendingText);
	assert('/pending 列出名称', pendingText.includes('高价收网赚号'), pendingText);
	assert('/pending 给出确认与回滚入口', pendingText.includes('/confirm 序号') && pendingText.includes('/ignore 序号'), pendingText);
	assert('/pending 20 越界参数被裁到上限内', (await cmd(env, '/pending 999')).includes('#1'), lastSent());

	// /confirm 1 → 学指纹 + 加样本 + 销毁快照
	const samplesBefore = env.DB.query('SELECT COUNT(*) AS c FROM ad_sample_embeddings')[0].c;
	const confirmText = await cmd(env, '/confirm 1');
	assert('/confirm 回执标题正确', confirmText.includes('已确认为广告'), confirmText);
	assert('/confirm 学入指纹', confirmText.includes('已学入'), confirmText);
	// 这份现场资料的「名称 + bio」拼起来正好等于内置种子第一条，text_hash 去重命中，
	// 回执给「语义样本已存在」而不是新增，属预期行为（下面另用一份新文本验证新增路径）。
	assert('/confirm 命中样本去重', confirmText.includes('语义样本已存在'), confirmText);
	assert('/confirm 去重时样本库不增长', env.DB.query('SELECT COUNT(*) AS c FROM ad_sample_embeddings')[0].c === samplesBefore);
	assert('/confirm 后快照被销毁', env.DB.query('SELECT COUNT(*) AS c FROM ad_pending_snapshots')[0].c === 0);
	// learnAdFingerprints 的 ON CONFLICT 只累加 match_count，不覆盖 source：
	// 入群阶段已按 auto 学入的指纹，/confirm 不会把来源提权成 manual，这是实现的既定行为。
	assert('/confirm 累加已有指纹命中数', env.DB.query('SELECT COUNT(*) AS c FROM ad_fingerprints WHERE match_count >= 1')[0].c > 0, JSON.stringify(env.DB.query('SELECT type, value, match_count, source FROM ad_fingerprints ORDER BY id LIMIT 8')));
	assert('/confirm 后用户仍在黑名单', env.DB.query("SELECT COUNT(*) AS c FROM blacklist WHERE id = '70001'")[0].c === 1);
	assert('/confirm 不存在的序号给出提示', (await cmd(env, '/confirm 9')).includes('不存在或已过期'), lastSent());
	assert('/confirm 无参给出用法', (await cmd(env, '/confirm')).includes('用法'), lastSent());

	// 换一份不在种子库里的现场文本（bio 沿用已入库指纹，保证照样被判定为广告），
	// 验证 /confirm 的样本新增路径真的能落库。
	setApi({
		getChat: (body) => ({ ok: true, result: { id: body?.chat_id, first_name: '资源对接小助手', bio: '长期收购网 du 商宝账号，老账号优先加价' } }),
		getChatMember: (body) => ({ ok: true, result: { status: 'member', user: { id: body?.user_id } } }),
		getChatAdministrators: () => ({ ok: true, result: [] })
	});
	await sendUpdate({ message: joinMessage([{ id: 70003, first_name: '资源对接小助手' }]) }, env);
	const freshBefore = env.DB.query('SELECT COUNT(*) AS c FROM ad_sample_embeddings')[0].c;
	const freshConfirm = await cmd(env, '/confirm 1');
	assert('/confirm 新文本新增语义样本', freshConfirm.includes('已新增 1 条语义样本'), freshConfirm);
	assert('/confirm 新文本后样本库 +1', env.DB.query('SELECT COUNT(*) AS c FROM ad_sample_embeddings')[0].c === freshBefore + 1);
	assert('/confirm 新样本 source 记为 confirm', env.DB.query("SELECT COUNT(*) AS c FROM ad_sample_embeddings WHERE source = 'confirm'")[0].c === 1, JSON.stringify(env.DB.query('SELECT source, sample_text FROM ad_sample_embeddings ORDER BY id DESC LIMIT 2')));
	assert('/confirm 新样本向量留空待懒加载', env.DB.query("SELECT COUNT(*) AS c FROM ad_sample_embeddings WHERE embedding IS NULL")[0].c >= 1);

	// /ignore → 解黑 + 全群解封 + 指纹误判修正
	await runAdBan(env, 70002);
	assert('第二次封禁重新分配 seq=1', env.DB.query('SELECT seq FROM ad_pending_snapshots')[0]?.seq === 1, JSON.stringify(env.DB.query('SELECT seq, user_id FROM ad_pending_snapshots')));
	assert('第二次封禁已入黑名单', env.DB.query("SELECT COUNT(*) AS c FROM blacklist WHERE id = '70002'")[0].c === 1);
	const fpConfBefore = env.DB.query("SELECT confidence FROM ad_fingerprints WHERE type = 'bio' ORDER BY id LIMIT 1")[0]?.confidence;
	const ignoreText = await cmd(env, '/ignore 1');
	assert('/ignore 回执标题正确', ignoreText.includes('已按误判回滚'), ignoreText);
	assert('/ignore 调用全群解封', countCalls('unbanChatMember') >= 1, JSON.stringify(calls.map((c) => c.method)));
	assert('/ignore 移出黑名单', env.DB.query("SELECT COUNT(*) AS c FROM blacklist WHERE id = '70002'")[0].c === 0);
	assert('/ignore 回执写明黑名单已移除', ignoreText.includes('已移除'), ignoreText);
	assert('/ignore 标记指纹误判', ignoreText.includes('指纹修正：'), ignoreText);
	const fpConfAfter = env.DB.query("SELECT confidence FROM ad_fingerprints WHERE type = 'bio' ORDER BY id LIMIT 1")[0]?.confidence;
	assert('/ignore 后指纹置信度下降', fpConfAfter < fpConfBefore, `${fpConfBefore} -> ${fpConfAfter}`);
	assert('/ignore 后快照被销毁', env.DB.query('SELECT COUNT(*) AS c FROM ad_pending_snapshots')[0].c === 0);
	assert('/ignore 后观察记录被清', env.DB.query("SELECT COUNT(*) AS c FROM ad_user_screening WHERE user_id = '70002'")[0].c === 0);
	assert('/ignore 不存在的序号给出提示', (await cmd(env, '/ignore 8')).includes('不存在或已过期'), lastSent());
}

section('[9] 指纹与样本维护命令（addword / words / delword / addsample / clearsamples）');
{
	const cmd = async (env, text) => {
		resetCalls();
		await sendUpdate({ message: privateMessage(OWNER_ID, text) }, env);
		return lastSent();
	};
	const cmdAll = async (env, text) => {
		resetCalls();
		await sendUpdate({ message: privateMessage(OWNER_ID, text) }, env);
		return allSentText();
	};
	const countFp = (env, where = '') => env.DB.query('SELECT COUNT(*) AS c FROM ad_fingerprints' + (where ? ' WHERE ' + where : ''))[0].c;
	const countSample = (env) => env.DB.query('SELECT COUNT(*) AS c FROM ad_sample_embeddings')[0].c;

	const env = makeEnv();
	await W.adDetectionReady(env);

	// /addword：无参给用法；末位参数是合法类型时按类型建，否则按值形态推断。
	assert('/addword 无参给出用法', (await cmd(env, '/addword')).includes('用法'), lastSent());
	assert('/addword 值太短被拒', (await cmd(env, '/addword A')).includes('值太短'), lastSent());
	assert('/addword 显式类型添加成功', (await cmd(env, '/addword 收U秒结 keyword')).includes('指纹已添加'), lastSent());
	assert('/addword 显式类型落库为 keyword', env.DB.query("SELECT type FROM ad_fingerprints WHERE value = '收U秒结'")[0]?.type === 'keyword', JSON.stringify(env.DB.query('SELECT type, value, source FROM ad_fingerprints')));
	assert('/addword 同值重复提示已更新', (await cmd(env, '/addword 收U秒结 keyword')).includes('指纹已更新'), lastSent());
	assert('/addword 同值重复不产生第二行', countFp(env, "value = '收U秒结'") === 1);
	assert('/addword 自动推断 username', (await cmd(env, '/addword @promo_seller_x')).includes('类型：username'), lastSent());
	assert('/addword 自动推断 domain', (await cmd(env, '/addword AD-Example.com')).includes('类型：domain'), lastSent());
	assert('/addword domain 值被归一化为小写', countFp(env, "type = 'domain' AND value = 'ad-example.com'") === 1, JSON.stringify(env.DB.query("SELECT type, value FROM ad_fingerprints WHERE type = 'domain'")));
	assert('/addword 手动指纹一律记为 manual', countFp(env, "source = 'manual'") === 3, JSON.stringify(env.DB.query('SELECT value, source FROM ad_fingerprints')));
	assert('/addword 手动指纹权重与置信度为 1', env.DB.query("SELECT weight, confidence FROM ad_fingerprints WHERE value = '收U秒结'")[0]?.confidence === 1);

	// /words：按命中次数倒序分页，空库与非空库两种回执。
	const wordsText = await cmdAll(env, '/words');
	assert('/words 回执标题正确', wordsText.includes('指纹库'), wordsText);
	assert('/words 统计总条数', wordsText.includes('共 <b>3</b> 条'), wordsText);
	assert('/words 展示指纹值', wordsText.includes('收U秒结') && wordsText.includes('@promo_seller_x'), wordsText);
	assert('/words 展示来源', wordsText.includes('来源 manual'), wordsText);
	assert('/words 越界页码给出最大页码提示', (await cmdAll(env, '/words 99')).includes('该页没有数据'), allSentText());
	const envEmptyWords = makeEnv();
	await W.adDetectionReady(envEmptyWords);
	assert('/words 空库给出引导', (await cmdAll(envEmptyWords, '/words')).includes('当前为空'), allSentText());

	// /delword：按值删除，跨类型一并清掉。
	assert('/delword 无参给出用法', (await cmd(env, '/delword')).includes('用法'), lastSent());
	assert('/delword 删除存在的指纹', (await cmd(env, '/delword 收U秒结')).includes('已删除'), lastSent());
	assert('/delword 删除后该值消失', countFp(env, "value = '收U秒结'") === 0);
	assert('/delword 不影响其它指纹', countFp(env) === 2, JSON.stringify(env.DB.query('SELECT type, value FROM ad_fingerprints')));
	assert('/delword 删除不存在的值有提示', (await cmd(env, '/delword 根本没有这个词')).includes('指纹库中没有'), lastSent());

	// /addsample：只写文本，向量留给检测时懒加载补齐。
	const sampleBase = countSample(env);
	assert('内置种子样本已就位', sampleBase === 10, String(sampleBase));
	assert('/addsample 无参给出用法', (await cmd(env, '/addsample')).includes('用法'), lastSent());
	assert('/addsample 文本太短被拒', (await cmd(env, '/addsample 收U')).includes('样本太短'), lastSent());
	const NEW_SAMPLE = '招代理日结佣金 秒结不拖欠 全新样本文本';
	assert('/addsample 添加成功', (await cmd(env, '/addsample ' + NEW_SAMPLE)).includes('样本已添加'), lastSent());
	assert('/addsample 后样本库 +1', countSample(env) === sampleBase + 1);
	assert('/addsample 落库来源为 manual', env.DB.query("SELECT COUNT(*) AS c FROM ad_sample_embeddings WHERE source = 'manual'")[0].c === 1);
	assert('/addsample 向量留空待懒加载', env.DB.query('SELECT embedding FROM ad_sample_embeddings ORDER BY id DESC LIMIT 1')[0]?.embedding === null);
	assert('/addsample 重复文本提示已存在', (await cmd(env, '/addsample ' + NEW_SAMPLE)).includes('样本已存在'), lastSent());
	assert('/addsample 重复文本不再增长', countSample(env) === sampleBase + 1);

	// /clearsamples：破坏性操作走 D1 一次性令牌二次确认（纯 D1 环境用 expires_at + 读取即删替代 KV TTL）。
	const clearPrompt = await cmd(env, '/clearsamples');
	assert('/clearsamples 先要求二次确认', clearPrompt.includes('确认清空语义样本库'), clearPrompt);
	assert('/clearsamples 提示写明当前条数', clearPrompt.includes('共 <b>' + (sampleBase + 1) + '</b> 条样本'), clearPrompt);
	const tokenMatch = clearPrompt.match(/<code>\/clearsamples ([^<\s]+)<\/code>/);
	assert('/clearsamples 提示里带确认令牌', Boolean(tokenMatch), clearPrompt);
	const token = tokenMatch ? tokenMatch[1] : 'deadbeefdeadbeef';
	assert('/clearsamples 令牌为 16 位小写 hex', /^[0-9a-f]{16}$/.test(token), token);
	assert('/clearsamples 令牌已入 D1 令牌表', env.DB.query('SELECT COUNT(*) AS c FROM ad_confirm_tokens')[0].c === 1);
	assert('/clearsamples 未确认前样本仍在', countSample(env) === sampleBase + 1);
	const clearDone = await cmd(env, '/clearsamples ' + token);
	assert('/clearsamples 令牌确认后清空', clearDone.includes('样本库已清空'), clearDone);
	assert('/clearsamples 回执写明删除条数', clearDone.includes('删除 <b>' + (sampleBase + 1) + '</b> 条样本'), clearDone);
	assert('/clearsamples 后样本表为空', countSample(env) === 0);
	assert('/clearsamples 令牌用后即焚', env.DB.query('SELECT COUNT(*) AS c FROM ad_confirm_tokens')[0].c === 0);
	assert('/clearsamples 同一令牌不能复用', (await cmd(env, '/clearsamples ' + token)).includes('令牌无效'), lastSent());
	assert('/clearsamples 空库时直接提示无需清理', (await cmd(env, '/clearsamples')).includes('样本库已经是空的'), lastSent());
	assert('/clearsamples 空库时不签发令牌', env.DB.query('SELECT COUNT(*) AS c FROM ad_confirm_tokens')[0].c === 0);
}

section('[10] 状态、白名单与观察窗口复判（adstats / whitelist / rescreen）');
{
	const adProfileApi = {
		getChat: (body) => ({ ok: true, result: { id: body?.chat_id, first_name: '💚高价收网赚号💚', bio: '长期收购网 du 商宝账号，老账号优先加价' } }),
		getChatMember: (body) => ({ ok: true, result: { status: 'member', user: { id: body?.user_id } } }),
		getChatAdministrators: () => ({ ok: true, result: [] })
	};
	const cmd = async (env, text) => {
		resetCalls();
		await sendUpdate({ message: privateMessage(OWNER_ID, text) }, env);
		return lastSent();
	};
	const cmdAll = async (env, text) => {
		resetCalls();
		await sendUpdate({ message: privateMessage(OWNER_ID, text) }, env);
		return allSentText();
	};
	// resetCalls() 内部会 setApi() 把 mock 处理器清空，所以「先 setApi 再发命令」的写法
	// 会让命令执行时拿到默认空资料。凡是命令自身要回查 Telegram 资料的场景都必须用这个版本：
	// 先清计数，再装 mock，最后发命令。
	const cmdApi = async (env, text, api) => {
		resetCalls();
		setApi(api);
		await sendUpdate({ message: privateMessage(OWNER_ID, text) }, env);
		return allSentText();
	};

	const env = makeEnv();
	await W.adDetectionReady(env);

	// /adstats：一屏看全。未绑 AI 时必须明确写出降级，否则运维会误以为三层都在跑。
	const statsText = await cmdAll(env, '/adstats');
	assert('/adstats 回执标题正确', statsText.includes('广告检测状态'), statsText);
	assert('/adstats 展示封禁阈值', statsText.includes('封禁阈值：<b>7</b>'), statsText);
	assert('/adstats 展示观察阈值', statsText.includes('观察阈值：<b>5</b>'), statsText);
	assert('/adstats 未绑 AI 时标注降级', statsText.includes('未绑定，降级为评分 + 指纹两层'), statsText);
	assert('/adstats 统计语义样本与种子', statsText.includes('语义样本') && statsText.includes('共 <b>10</b> 条'), statsText);
	assert('/adstats 统计观察窗口人数', statsText.includes('观察窗口') && statsText.includes('窗口内 <b>0</b> 人'), statsText);
	assert('/adstats 统计待确认快照', statsText.includes('待确认快照') && statsText.includes('<b>0</b> 条'), statsText);
	assert('/adstats 统计域名白名单', statsText.includes('域名白名单') && statsText.includes('内置种子'), statsText);
	const envAi = makeEnv({ AI: { async run() { return { data: [new Array(768).fill(0)] }; } } });
	await W.adDetectionReady(envAi);
	const statsAi = await cmdAll(envAi, '/adstats');
	assert('/adstats 绑定 AI 时标注已绑定', statsAi.includes('已绑定'), statsAi);
	assert('/adstats 绑定 AI 时写出模型名', statsAi.includes('bge-base-zh'), statsAi);

	// /whitelist：建表时就把 50 条内置种子写进 D1，所以默认列出的是「D1 自定义 50 条」；
	// 只有把表清空后才回落到内存里的种子集合。
	const wlList = await cmdAll(env, '/whitelist');
	assert('/whitelist 缺省子命令等于 list', wlList.includes('域名白名单'), wlList);
	assert('/whitelist 建表即写入 50 条种子', wlList.includes('D1 自定义（50 条）'), wlList);
	assert('/whitelist 生效集合与 D1 表一致', wlList.includes('生效 <b>50</b> 条'), wlList);
	assert('/whitelist 展示种子域名', wlList.includes('github.com'), wlList);
	assert('/whitelist add 无参给出用法', (await cmd(env, '/whitelist add')).includes('用法'), lastSent());
	assert('/whitelist del 无参给出用法', (await cmd(env, '/whitelist del')).includes('用法'), lastSent());
	assert('/whitelist 非法子命令给出用法', (await cmd(env, '/whitelist foo')).includes('用法'), lastSent());
	assert('/whitelist add 成功', (await cmd(env, '/whitelist add My-Shop.Example')).includes('已加入白名单'), lastSent());
	assert('/whitelist add 落库并归一化为小写', env.DB.query("SELECT COUNT(*) AS c FROM ad_domain_whitelist WHERE domain = 'my-shop.example'")[0].c === 1, JSON.stringify(env.DB.query("SELECT domain FROM ad_domain_whitelist WHERE domain LIKE '%shop%'")));
	assert('/whitelist add 重复提示已在白名单', (await cmd(env, '/whitelist add my-shop.example')).includes('已在白名单中'), lastSent());
	assert('/whitelist add 重复不产生第二行', env.DB.query('SELECT COUNT(*) AS c FROM ad_domain_whitelist')[0].c === 51);
	const wlAfterAdd = await cmdAll(env, '/whitelist list');
	// 列表查询固定 LIMIT 50，51 条时只能列出 50 条；总量看「生效」那一行，不看列表标题里的数字。
	assert('/whitelist list 生效数反映真实总量', wlAfterAdd.includes('生效 <b>51</b> 条'), wlAfterAdd);
	assert('/whitelist list 列表截断在 50 条', wlAfterAdd.includes('D1 自定义（50 条）'), wlAfterAdd);
	assert('/whitelist add 非法域名被拒', (await cmd(env, '/whitelist add 不是域名')).includes('域名不合法'), lastSent());
	assert('/whitelist del 移除成功', (await cmd(env, '/whitelist del my-shop.example')).includes('已从白名单移除'), lastSent());
	assert('/whitelist del 后只剩种子', env.DB.query('SELECT COUNT(*) AS c FROM ad_domain_whitelist')[0].c === 50);
	assert('/whitelist del 不存在的域名有提示', (await cmd(env, '/whitelist del never-added.example')).includes('白名单中没有该域名'), lastSent());
	// 把表清空，验证「删到空不会导致所有链接都判广告」的回落分支。
	env.DB.__sqlite.exec('DELETE FROM ad_domain_whitelist');
	const wlEmpty = await cmdAll(env, '/whitelist list');
	assert('/whitelist 表清空后说明回落内置种子', wlEmpty.includes('D1 自定义：无'), wlEmpty);
	assert('/whitelist 表清空后提示切换语义', wlEmpty.includes('内置种子不再自动合并'), wlEmpty);
	// 表里只有一条时不会被 LIMIT 50 截断，这里才能验证「新增域名确实会出现在列表里」。
	await cmd(env, '/whitelist add Only-One.Example');
	const wlOne = await cmdAll(env, '/whitelist list');
	assert('/whitelist list 展示新增域名', wlOne.includes('D1 自定义（1 条）') && wlOne.includes('only-one.example'), wlOne);

	// /rescreen：拿当前指纹库把观察窗口里的人再筛一遍。空窗口要能直接返回，不能报错。
	const envRs = makeEnv();
	await W.adDetectionReady(envRs);
	assert('/rescreen 空窗口给出提示', (await cmd(envRs, '/rescreen')).includes('观察窗口内没有待复判的用户'), lastSent());

	// 先制造一次自动封禁，把 bio 类指纹（权重 0.8，单条即定罪）学进库。
	setApi(adProfileApi);
	await sendUpdate({ message: joinMessage([{ id: 70009, first_name: '💚高价收网赚号💚' }]) }, envRs);
	assert('复判前置：指纹已由自动学习入库', envRs.DB.query("SELECT COUNT(*) AS c FROM ad_fingerprints WHERE type = 'bio'")[0].c >= 1, JSON.stringify(envRs.DB.query('SELECT type, value FROM ad_fingerprints')));

	// 预置一条观察窗口记录：得分 6 不到封禁线，但资料会命中刚学到的 bio 指纹。
	const rsConfig = W.loadAdDetectionConfig(envRs);
	await W.upsertAdScreening(envRs, '70004', {
		chatId: GROUP_ID,
		score: 6,
		reasons: ['测试预置观察记录'],
		snapshot: { name: '待复判用户', text: '长期收购网赚账号 USDT' },
		layer: 'score'
	}, rsConfig);
	assert('复判前置：观察窗口有 1 人', envRs.DB.query('SELECT COUNT(*) AS c FROM ad_user_screening')[0].c === 1);

	const rsText = await cmdApi(envRs, '/rescreen', adProfileApi);
	assert('/rescreen 回执标题正确', rsText.includes('观察窗口复判完成'), rsText);
	assert('/rescreen 统计本次处理人数', rsText.includes('本次处理 <b>1</b> 人'), rsText);
	assert('/rescreen 命中指纹后判定封禁', rsText.includes('判定为广告并封禁：<b>1</b>'), rsText);
	assert('/rescreen 列出被封用户', rsText.includes('70004'), rsText);
	assert('/rescreen 引导用 /pending 复核', rsText.includes('/pending'), rsText);
	assert('/rescreen 封禁后移出观察窗口', envRs.DB.query("SELECT COUNT(*) AS c FROM ad_user_screening WHERE user_id = '70004'")[0].c === 0);
	assert('/rescreen 封禁写入黑名单', envRs.DB.query("SELECT COUNT(*) AS c FROM blacklist WHERE id = '70004'")[0].c === 1);
	assert('/rescreen 封禁生成待确认快照', envRs.DB.query("SELECT COUNT(*) AS c FROM ad_pending_snapshots WHERE user_id = '70004'")[0].c === 1, JSON.stringify(envRs.DB.query('SELECT seq, user_id FROM ad_pending_snapshots')));
	assert('/rescreen 调用了全群封禁', countCalls('banChatMember') >= 1, JSON.stringify(calls.map((c) => c.method)));

	// 已在黑名单的人不重复处置：复判时直接解除观察。
	await W.upsertAdScreening(envRs, '70009', {
		chatId: GROUP_ID, score: 6, reasons: ['已封禁用户'], snapshot: { name: '已封禁用户' }, layer: 'score'
	}, rsConfig);
	const rsAgain = await cmdApi(envRs, '/rescreen', adProfileApi);
	assert('/rescreen 已封禁用户直接解除观察', rsAgain.includes('解除观察：<b>1</b>'), rsAgain);
	assert('/rescreen 解除观察后记录清零', envRs.DB.query("SELECT COUNT(*) AS c FROM ad_user_screening WHERE user_id = '70009'")[0].c === 0);

	// 主人/管理员误入观察窗口时，复判必须无条件放行。
	await W.upsertAdScreening(envRs, String(OWNER_ID), {
		chatId: GROUP_ID, score: 9, reasons: ['误入观察窗口'], snapshot: { name: 'Owner' }, layer: 'score'
	}, rsConfig);
	const rsOwner = await cmdApi(envRs, '/rescreen', adProfileApi);
	assert('/rescreen 主人不会被复判封禁', !rsOwner.includes('判定为广告并封禁：<b>1</b>'), rsOwner);
	assert('/rescreen 主人被移出观察窗口', envRs.DB.query("SELECT COUNT(*) AS c FROM ad_user_screening WHERE user_id = '" + OWNER_ID + "'")[0].c === 0);
	assert('/rescreen 主人未被写入黑名单', envRs.DB.query("SELECT COUNT(*) AS c FROM blacklist WHERE id = '" + OWNER_ID + "'")[0].c === 0);

	// 数量参数超过硬上限时要被裁到 30，回执里必须写清实际上限，避免运维以为真按 999 跑。
	await W.upsertAdScreening(envRs, '70011', {
		chatId: GROUP_ID, score: 6, reasons: ['验证上限裁剪'], snapshot: { name: '普通用户', text: '大家早上好' }, layer: 'score'
	}, rsConfig);
	const rsLimit = await cmdApi(envRs, '/rescreen 999', {
		getChat: (body) => ({ ok: true, result: { id: body?.chat_id, first_name: '普通用户', bio: '' } }),
		getChatMember: (body) => ({ ok: true, result: { status: 'member', user: { id: body?.user_id } } })
	});
	assert('/rescreen 数量参数被裁到上限 30', rsLimit.includes('（上限 30）'), rsLimit);
	assert('/rescreen 干净资料不会误封', rsLimit.includes('判定为广告并封禁：<b>0</b>'), rsLimit);
	assert('/rescreen 空窗口再次给出提示', (await cmd(envRs, '/rescreen')).includes('观察窗口内没有待复判的用户'), lastSent());
}

section('[11] 回归：既有功能不被广告层吞掉');
{
	const env = makeEnv();
	await W.adDetectionReady(env);

	// 正常聊天：零成本预筛必须在拉资料之前就放行，所以 getChat 调用数应为 0。
	resetCalls();
	setApi({ getChatAdministrators: () => ({ ok: true, result: [] }) });
	await sendUpdate({ message: groupMessage({ id: 71001, first_name: '普通群友' }, '大家早上好，今天天气不错') }, env);
	assert('普通群聊不封禁', countCalls('banChatMember') === 0, JSON.stringify(calls.map((c) => c.method)));
	assert('普通群聊不禁言', countCalls('restrictChatMember') === 0, JSON.stringify(calls.map((c) => c.method)));
	assert('普通群聊不删消息', countCalls('deleteMessage') === 0, JSON.stringify(calls.map((c) => c.method)));
	assert('普通群聊零成本预筛生效（不拉资料）', countCalls('getChat') === 0, JSON.stringify(calls.map((c) => c.method)));
	assert('普通群聊不进观察窗口', env.DB.query("SELECT COUNT(*) AS c FROM ad_user_screening WHERE user_id = '71001'")[0].c === 0);
	assert('普通群聊不写黑名单', env.DB.query("SELECT COUNT(*) AS c FROM blacklist WHERE id = '71001'")[0].c === 0);

	// 频道自动转发（绑定频道的消息同步）必须原样放行，否则群公告会被当广告删掉。
	resetCalls();
	await sendUpdate({
		message: groupMessage({ id: 777000, first_name: 'Channel' }, '📢 高价收网赚号 长期收购账号 加微信联系', {
			is_automatic_forward: true,
			sender_chat: { id: -1009999999999, type: 'channel', title: '绑定频道' }
		})
	}, env);
	assert('频道自动转发不封禁', countCalls('banChatMember') === 0, JSON.stringify(calls.map((c) => c.method)));
	assert('频道自动转发不删消息', countCalls('deleteMessage') === 0, JSON.stringify(calls.map((c) => c.method)));
	assert('频道自动转发不进观察窗口', env.DB.query('SELECT COUNT(*) AS c FROM ad_user_screening')[0].c === 0, JSON.stringify(env.DB.query('SELECT user_id FROM ad_user_screening')));

	// 主人/管理员即便发了标准广告文案也不处置：管理豁免优先于三层判定。
	resetCalls();
	await sendUpdate({ message: groupMessage({ id: OWNER_ID, first_name: 'Owner' }, '高价收网赚号 长期收购网 du 商宝账号 USDT 日结') }, env);
	assert('主人发广告文案不被封禁', countCalls('banChatMember') === 0, JSON.stringify(calls.map((c) => c.method)));
	assert('主人发广告文案不进观察窗口', env.DB.query("SELECT COUNT(*) AS c FROM ad_user_screening WHERE user_id = '" + OWNER_ID + "'")[0].c === 0);
	assert('主人发广告文案不写黑名单', env.DB.query("SELECT COUNT(*) AS c FROM blacklist WHERE id = '" + OWNER_ID + "'")[0].c === 0);

	// bot 入群：广告层不处置 bot，后续的机器人风控链路必须照常接手。
	// 这里 getChatMember 必须回 member —— 回 administrator 会命中风控自身的管理员豁免，看不出接手效果。
	resetCalls();
	setApi({
		getMe: () => ({ ok: true, result: { id: 777000, is_bot: true, username: 'AdGuardTestBot' } }),
		getChat: (body) => ({ ok: true, result: { id: body?.chat_id, first_name: '推广机器人' } }),
		getChatMember: (body) => ({ ok: true, result: { status: 'member', user: { id: body?.user_id, is_bot: true } } }),
		getChatAdministrators: () => ({ ok: true, result: [] }),
		restrictChatMember: () => ({ ok: true, result: true })
	});
	await sendUpdate({ message: joinMessage([{ id: 71002, first_name: '推广机器人', is_bot: true, username: 'promo_bot' }]) }, env);
	assert('bot 入群不被广告层写黑名单', env.DB.query("SELECT COUNT(*) AS c FROM blacklist WHERE id = '71002'")[0].c === 0);
	assert('bot 入群交给机器人风控禁言', countCalls('restrictChatMember') >= 1, JSON.stringify(calls.map((c) => c.method)));

	// 私聊普通文本（非命令）不能被广告命令层截住，也不该触发任何处置。
	resetCalls();
	setApi({ getChatMember: (body) => ({ ok: true, result: { status: 'member', user: { id: body?.user_id } } }) });
	await sendUpdate({ message: privateMessage(71003, '你好，我想申请解封') }, env);
	assert('私聊普通文本不被封禁', countCalls('banChatMember') === 0, JSON.stringify(calls.map((c) => c.method)));
	assert('私聊普通文本不进观察窗口', env.DB.query("SELECT COUNT(*) AS c FROM ad_user_screening WHERE user_id = '71003'")[0].c === 0);
	assert('私聊普通文本不触发任何处置动作', countCalls('restrictChatMember') === 0 && countCalls('deleteMessage') === 0, JSON.stringify(calls.map((c) => c.method)));

	// 核心表与广告表共存：广告建表不能影响既有 schema 版本，也不能挤掉核心 5 表。
	// ad_votes / ad_vote_allowlist 属投票功能的按需建表，本文件不触发投票流程，故不在必存清单里。
	assert('核心表 schema 版本保持 6', Number(env.DB.query('SELECT version FROM schema_meta WHERE id = 1')[0]?.version) === 6, JSON.stringify(env.DB.query('SELECT * FROM schema_meta')));
	const tables = env.DB.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
	for (const t of ['schema_meta', 'blacklist', 'moderation_messages', 'batch_jobs', 'dynamic_groups', 'ad_fingerprints', 'ad_user_screening', 'ad_sample_embeddings', 'ad_domain_whitelist', 'ad_pending_snapshots', 'ad_confirm_tokens']) {
		assert('表存在：' + t, tables.includes(t), JSON.stringify(tables));
	}
	assert('投票表未被广告建表提前创建', !tables.includes('ad_votes'), JSON.stringify(tables));
}



section('[12] 修复项专项：manual 提权 / 自身 username / 回复学习词表');
{
	const env12 = makeEnv();
	await W.adDetectionReady(env12);

	// —— A1：/confirm 的 manual 提权真正生效 ——
	// 旧实现的 ON CONFLICT 不写 source，已 auto 入库的指纹经 /confirm 后仍是 auto，
	// 拿不到退役豁免（markAdFingerprintFalsePositive 的 DELETE 带 source != 'manual'）。
	const payloadA = { name: '💚高价收U💚', username: '@fp_seller_777', bio: '长期收购账号 老号加价', text: '', domains: [] };
	const payloadB = { name: '🌟诚信兑换铺🌟', username: '', bio: '专业收购游戏点卡 全天在线', text: '', domains: [] };

	const autoA = await W.learnAdFingerprints(env12, payloadA, { source: 'auto' });
	assert('A1 前置：auto 学习成功', autoA.ok === true && autoA.learned > 0, JSON.stringify(autoA));
	assert('A1 前置：首次入库 source 为 auto', env12.DB.query("SELECT COUNT(*) AS c FROM ad_fingerprints WHERE source = 'auto'")[0].c > 0, JSON.stringify(env12.DB.query('SELECT value, source FROM ad_fingerprints')));

	await W.learnAdFingerprints(env12, payloadA, { source: 'manual', createdBy: String(OWNER_ID) });
	assert('A1 manual 学习把已有指纹提权为 manual', env12.DB.query("SELECT COUNT(*) AS c FROM ad_fingerprints WHERE source = 'auto'")[0].c === 0, JSON.stringify(env12.DB.query('SELECT value, source FROM ad_fingerprints')));
	assert('A1 提权后 manual 指纹存在', env12.DB.query("SELECT COUNT(*) AS c FROM ad_fingerprints WHERE source = 'manual'")[0].c > 0);
	assert('A1 提权累加命中数而非重复插行', env12.DB.query('SELECT COUNT(*) AS c FROM ad_fingerprints')[0].c === autoA.learned, JSON.stringify(env12.DB.query('SELECT value, source, match_count FROM ad_fingerprints')));

	// 反向必须禁止：auto 再学一遍不能把主人确认过的 manual 打回 auto。
	await W.learnAdFingerprints(env12, payloadA, { source: 'auto' });
	assert('A1 auto 不会把 manual 降权', env12.DB.query("SELECT COUNT(*) AS c FROM ad_fingerprints WHERE source = 'auto'")[0].c === 0, JSON.stringify(env12.DB.query('SELECT value, source FROM ad_fingerprints')));

	// 对照组：纯 auto 指纹在同样的误判次数下必须被退役，证明豁免确实来自 source。
	const autoB = await W.learnAdFingerprints(env12, payloadB, { source: 'auto' });
	assert('A1 对照组：auto 指纹入库', autoB.ok === true && env12.DB.query("SELECT COUNT(*) AS c FROM ad_fingerprints WHERE source = 'auto'")[0].c > 0, JSON.stringify(autoB));
	const manualBefore = env12.DB.query("SELECT COUNT(*) AS c FROM ad_fingerprints WHERE source = 'manual'")[0].c;
	for (let i = 0; i < 5; i += 1) {
		await W.markAdFingerprintFalsePositive(env12, payloadA);
		await W.markAdFingerprintFalsePositive(env12, payloadB);
	}
	assert('A1 manual 指纹扛过 5 次误判不被退役', env12.DB.query("SELECT COUNT(*) AS c FROM ad_fingerprints WHERE source = 'manual'")[0].c === manualBefore, JSON.stringify(env12.DB.query('SELECT value, source, match_count, false_positive_count, confidence FROM ad_fingerprints')));
	assert('A1 对照组 auto 指纹被退役清空', env12.DB.query("SELECT COUNT(*) AS c FROM ad_fingerprints WHERE source = 'auto'")[0].c === 0, JSON.stringify(env12.DB.query('SELECT value, source, confidence FROM ad_fingerprints')));

	// —— B1：账号自身 username 入库与边界 ——
	assert('B1 自身 username 已入库', env12.DB.query("SELECT COUNT(*) AS c FROM ad_fingerprints WHERE type = 'username' AND value = '@fp_seller_777'")[0].c === 1, JSON.stringify(env12.DB.query("SELECT type, value FROM ad_fingerprints WHERE type = 'username'")));
	const candNoAt = W.extractAdFingerprintCandidates({ name: '收U代理', username: 'no_at_prefix_ok', bio: '', text: '' }, new Set());
	assert('B1 不带 @ 前缀的 username 也归一化入库', candNoAt.some((c) => c.type === 'username' && c.value === '@no_at_prefix_ok'), JSON.stringify(candNoAt));
	const candBad = W.extractAdFingerprintCandidates({ name: '收U代理', username: '@ab', bio: '', text: '' }, new Set());
	assert('B1 过短 username 不入库', !candBad.some((c) => c.type === 'username'), JSON.stringify(candBad));
	const candIllegal = W.extractAdFingerprintCandidates({ name: '收U代理', username: '@有中文的名字', bio: '', text: '' }, new Set());
	assert('B1 非法字符 username 不入库', !candIllegal.some((c) => c.type === 'username'), JSON.stringify(candIllegal));
	const candBoth = W.extractAdFingerprintCandidates({ name: '收U代理', username: '@self_handle_x', bio: '请联系 @other_handle_y 详谈', text: '' }, new Set());
	assert('B1 自身与提及的 username 同时入库', (
		candBoth.some((c) => c.type === 'username' && c.value === '@self_handle_x') &&
		candBoth.some((c) => c.type === 'username' && c.value === '@other_handle_y')
	), JSON.stringify(candBoth));
	const candDup = W.extractAdFingerprintCandidates({ name: '收U代理', username: '@same_handle_z', bio: '联系 @same_handle_z', text: '' }, new Set());
	assert('B1 自身与提及重复时只留一条', candDup.filter((c) => c.type === 'username').length === 1, JSON.stringify(candDup));

	// —— C1：回复学习词表不再裸子串误判 ——
	// 这些是旧词表（含单字「封」、子串 'ad'、'学习'）会误判成封禁指令的正常回复。
	assert('C1 「学习了」不触发', W.classifyAdReplyIntent('学习了') === '', W.classifyAdReplyIntent('学习了'));
	assert('C1 「学习一下」不触发', W.classifyAdReplyIntent('学习一下') === '');
	assert('C1 already done 不触发', W.classifyAdReplyIntent('already done') === '', W.classifyAdReplyIntent('already done'));
	assert('C1 「封面不错」不触发', W.classifyAdReplyIntent('封面不错') === '', W.classifyAdReplyIntent('封面不错'));
	assert('C1 「密封好了」不触发', W.classifyAdReplyIntent('密封好了') === '');
	assert('C1 download 不触发', W.classifyAdReplyIntent('download 完成') === '');
	assert('C1 bad road 不触发', W.classifyAdReplyIntent('bad road ahead') === '');
	assert('C1 admin 不触发', W.classifyAdReplyIntent('admin 已处理') === '');
	assert('C1 ready 不触发', W.classifyAdReplyIntent('ready') === '');
	// 真正的封禁意图仍要判为 positive。
	assert('C1 「这是广告」仍触发', W.classifyAdReplyIntent('这是广告') === 'positive');
	assert('C1 「封了他」触发', W.classifyAdReplyIntent('封了他') === 'positive');
	assert('C1 「该封」触发', W.classifyAdReplyIntent('该封') === 'positive');
	assert('C1 「封禁吧」触发', W.classifyAdReplyIntent('封禁吧') === 'positive');
	assert('C1 「垃圾消息」触发', W.classifyAdReplyIntent('垃圾消息') === 'positive');
	assert('C1 英文 spam 触发', W.classifyAdReplyIntent('this is spam') === 'positive');
	assert('C1 spammer 触发', W.classifyAdReplyIntent('spammer') === 'positive');
	// 否定词必须永远优先：这些短句都含新触发词的子串。
	assert('C1 「不要封」判为 negative', W.classifyAdReplyIntent('不要封') === 'negative');
	assert('C1 「不该封」判为 negative', W.classifyAdReplyIntent('不该封') === 'negative');
	assert('C1 「取消封禁」判为 negative', W.classifyAdReplyIntent('取消封禁') === 'negative');
	assert('C1 「不是垃圾」判为 negative', W.classifyAdReplyIntent('不是垃圾') === 'negative');
	assert('C1 「误封了」判为 negative', W.classifyAdReplyIntent('误封了') === 'negative');
	assert('C1 not spam 判为 negative', W.classifyAdReplyIntent('not spam') === 'negative', W.classifyAdReplyIntent('not spam'));
	assert('C1 超 20 字仍不触发', W.classifyAdReplyIntent('这条消息我看了半天觉得应该算是广告吧你怎么看') === '');
}

section('[13] 回复学习端到端（管理层回复即判定，误触发必须为零）');
{
	const env13 = makeEnv();
	await W.adDetectionReady(env13);

	// getChat 按 id 分流：只有 72002 / 72006 是广告资料，其余一律干净资料，
	// 避免非管理员场景下「发送者自己」被消息层判成广告，污染断言。
	const replyApi = {
		getChat: (body) => {
			const id = String(body?.chat_id);
			if (id === '72002' || id === '72006') {
				return { ok: true, result: { id, first_name: '💚高价收网赚号💚', bio: '长期收购网 du 商宝账号 USDT 日结', username: 'ad_reply_target' } };
			}
			return { ok: true, result: { id, first_name: '普通成员', bio: '' } };
		},
		getChatMember: (body) => ({ ok: true, result: { status: 'member', user: { id: body?.user_id } } }),
		getChatAdministrators: () => ({ ok: true, result: [] }),
		banChatMember: () => ({ ok: true, result: true }),
		unbanChatMember: () => ({ ok: true, result: true }),
		deleteMessage: () => ({ ok: true, result: true })
	};

	function replyMsg(fromId, text, targetId, targetText = '长期收购网赚账号 USDT 日结 秒到') {
		return groupMessage({ id: fromId, first_name: fromId === OWNER_ID ? 'Owner' : '普通群友' }, text, {
			reply_to_message: {
				message_id: 555,
				date: Math.floor(Date.now() / 1000),
				chat: { id: Number(GROUP_ID), type: 'supergroup', title: '测试治理群' },
				from: { id: targetId, is_bot: false, first_name: '💚高价收网赚号💚', username: 'ad_reply_target' },
				text: targetText
			}
		});
	}

	const sendReply = async (fromId, text, targetId, targetText) => {
		resetCalls();
		setApi(replyApi);
		await sendUpdate({ message: replyMsg(fromId, text, targetId, targetText) }, env13);
		return allSentText();
	};

	// 场景 1：管理层回复「这是广告」→ 强制判定为广告并走完整处置链。
	const p1 = await sendReply(OWNER_ID, '这是广告', 72002);
	assert('回复学习 positive：被举报者入黑名单', env13.DB.query("SELECT COUNT(*) AS c FROM blacklist WHERE id = '72002'")[0].c === 1, JSON.stringify(env13.DB.query('SELECT id FROM blacklist')));
	assert('回复学习 positive：执行了全群封禁', countCalls('banChatMember') >= 1, JSON.stringify(calls.map((c) => c.method)));
	assert('回复学习 positive：删了被举报消息与操作消息', countCalls('deleteMessage') >= 2, JSON.stringify(calls.map((c) => c.method)));
	assert('回复学习 positive：学入了指纹', env13.DB.query('SELECT COUNT(*) AS c FROM ad_fingerprints')[0].c > 0);
	assert('回复学习 positive：指纹记为 manual', env13.DB.query("SELECT COUNT(*) AS c FROM ad_fingerprints WHERE source = 'manual'")[0].c > 0, JSON.stringify(env13.DB.query('SELECT value, source FROM ad_fingerprints')));
	assert('回复学习 positive：追加了 reply 来源语义样本', env13.DB.query("SELECT COUNT(*) AS c FROM ad_sample_embeddings WHERE source = 'reply'")[0].c === 1, JSON.stringify(env13.DB.query("SELECT source FROM ad_sample_embeddings WHERE source != 'seed'")));
	assert('回复学习 positive：群内有处置回执', p1.includes('已按广告处置 72002'), p1);
	// 处置回执必须是「闪屏」：sendFlashMessage 靠 ctx.waitUntil 注册延时撤回，
	// 调用方给 ctx 传 null 时撤回逻辑根本不会注册，回执会永久留在群里
	// （内含被处置者 TGID 与内部指纹计数，不该长期公开展示）。这里断言后台任务确实被注册。
	assert('回复学习 positive：回执注册了延时撤回任务', pendingWaits.length >= 1, '待执行后台任务数 ' + pendingWaits.length);
	const deleteBeforeFlush = countCalls('deleteMessage');
	await flushWaits();
	assert('回复学习 positive：回执被自动撤回', countCalls('deleteMessage') > deleteBeforeFlush, '撤回前 ' + deleteBeforeFlush + ' 次，撤回后 ' + countCalls('deleteMessage') + ' 次');

	// 场景 2：同一管理层回复「不是广告」→ 纠错回滚，解黑 + 全群解封。
	const p2 = await sendReply(OWNER_ID, '不是广告', 72002);
	assert('回复学习 negative：已移出黑名单', env13.DB.query("SELECT COUNT(*) AS c FROM blacklist WHERE id = '72002'")[0].c === 0, JSON.stringify(env13.DB.query('SELECT id FROM blacklist')));
	assert('回复学习 negative：执行了解封', countCalls('unbanChatMember') >= 1, JSON.stringify(calls.map((c) => c.method)));
	assert('回复学习 negative：未再次封禁', countCalls('banChatMember') === 0, JSON.stringify(calls.map((c) => c.method)));
	assert('回复学习 negative：给命中指纹记了误判', env13.DB.query('SELECT COUNT(*) AS c FROM ad_fingerprints WHERE false_positive_count > 0')[0].c > 0, JSON.stringify(env13.DB.query('SELECT value, false_positive_count FROM ad_fingerprints')));
	assert('回复学习 negative：群内有回滚回执', p2.length > 0, p2);

	// 场景 3：旧词表会误封的正常回复，现在必须一条都不处置。
	for (const [text, label] of [['学习了', '学习了'], ['already done', 'already done'], ['封面不错', '封面不错'], ['download 完成', 'download 完成'], ['admin 已看', 'admin 已看']]) {
		await sendReply(OWNER_ID, text, 72003, '大家早上好');
		assert('回复学习不误触发：' + label + ' 不封禁', countCalls('banChatMember') === 0, JSON.stringify(calls.map((c) => c.method)));
		assert('回复学习不误触发：' + label + ' 不入黑名单', env13.DB.query("SELECT COUNT(*) AS c FROM blacklist WHERE id = '72003'")[0].c === 0);
	}

	// 场景 4：非管理层说「封了他」不生效，避免普通成员借回复越权处置。
	await sendReply(72004, '封了他', 72005, '大家早上好');
	assert('回复学习：非管理层无权处置', env13.DB.query("SELECT COUNT(*) AS c FROM blacklist WHERE id = '72005'")[0].c === 0, JSON.stringify(env13.DB.query('SELECT id FROM blacklist')));
	assert('回复学习：非管理层不触发封禁', countCalls('banChatMember') === 0, JSON.stringify(calls.map((c) => c.method)));

	// 场景 5：目标是管理层时必须拒绝，且给出明确提示。
	const p5 = await sendReply(OWNER_ID, '这是广告', OWNER_ID, '长期收购网赚账号 USDT');
	assert('回复学习：目标是管理层时被拒', p5.includes('目标是管理层'), p5);
	assert('回复学习：管理层目标未入黑名单', env13.DB.query("SELECT COUNT(*) AS c FROM blacklist WHERE id = '" + OWNER_ID + "'")[0].c === 0);
	assert('回复学习：管理层目标未被封禁', countCalls('banChatMember') === 0, JSON.stringify(calls.map((c) => c.method)));

	// 场景 6：超 20 字的长评论不进回复学习，交回原流程。
	await sendReply(OWNER_ID, '这条消息我看了半天觉得应该算是广告吧你怎么看', 72006);
	assert('回复学习：超 20 字不触发处置', env13.DB.query("SELECT COUNT(*) AS c FROM blacklist WHERE id = '72006'")[0].c === 0, JSON.stringify(env13.DB.query('SELECT id FROM blacklist')));

	// 场景 7：普通成员发申诉句（含「广告」「解封」这些词）绝不能被任何一层判成广告。
	// 这类文本命中的是否定词表，而否定分支要求操作者是管理层，所以普通成员发出后一路放行到
	// 消息层，由零成本预筛判定通过。这是「解封正常用户会不会反被封禁」的直接回归点。
	resetCalls();
	setApi(replyApi);
	await sendUpdate({ message: groupMessage({ id: 72007, first_name: '申诉用户' }, '我不是广告，请帮我解封') }, env13);
	assert('申诉句：普通成员不被封禁', countCalls('banChatMember') === 0, JSON.stringify(calls.map((c) => c.method)));
	assert('申诉句：普通成员未入黑名单', env13.DB.query("SELECT COUNT(*) AS c FROM blacklist WHERE id = '72007'")[0].c === 0, JSON.stringify(env13.DB.query('SELECT id FROM blacklist')));
	assert('申诉句：普通成员未进观察窗口', env13.DB.query("SELECT COUNT(*) AS c FROM ad_user_screening WHERE user_id = '72007'")[0].c === 0);

	// 管理层用同样的话回复某人时走否定分支：只解封，绝不封禁。
	await sendReply(OWNER_ID, '不是广告，解封', 72008, '大家早上好');
	assert('申诉句：管理层回复时不封禁', countCalls('banChatMember') === 0, JSON.stringify(calls.map((c) => c.method)));
	assert('申诉句：管理层回复时目标未入黑名单', env13.DB.query("SELECT COUNT(*) AS c FROM blacklist WHERE id = '72008'")[0].c === 0);
	assert('申诉句：管理层回复时执行的是解封', countCalls('unbanChatMember') >= 1, JSON.stringify(calls.map((c) => c.method)));
}

console.log('');
console.log('='.repeat(60));
console.log(`广告检测测试汇总：通过 ${pass} 条，失败 ${fail} 条`);
if (failures.length) {
	console.log('失败清单：');
	for (const name of failures) console.log('  - ' + name);
}
console.log('='.repeat(60));
process.exitCode = fail > 0 ? 1 : 0;
