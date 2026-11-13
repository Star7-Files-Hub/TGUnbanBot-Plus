// Beta 重构版核心流程离线测试。
// 覆盖验收点：语义自动合并（R2/R3）、进群指纹命中确认（R7）、权限分级（R4/R5/R9）、
// 全群封禁回执（R6）、/ad AI 判定（群成员）。
// 运行：node test_beta.mjs

import { DatabaseSync } from 'node:sqlite';
import handler, {
	adDetectionReady, addAdSample, matchAdSemantic, normalizeAdText,
	learnFingerprints, loadConfig, isOwner, isPrimaryOwner,
	handleNewChatMembers, handleCommand, handleCallback,
	banAllGroups, renderBanAllReceipt, judgeAdWithAI,
	invalidateOwners, invalidateGroups, invalidateUserWhitelist, invalidateAdminCache,
	resetSchemaState
} from './_worker.js';

// ---------- D1 兼容层（node:sqlite） ----------
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
		for (const key of Object.keys(row)) out[key] = typeof row[key] === 'bigint' ? Number(row[key]) : row[key];
		return out;
	};
	const exec = (sql, params) => {
		const statement = db.prepare(sql);
		const bound = params.map(normIn);
		const upper = sql.trim().slice(0, 6).toUpperCase();
		if (upper === 'SELECT' || sql.trim().toUpperCase().startsWith('PRAGMA')) {
			return { kind: 'rows', rows: statement.all(...bound).map(normOut) };
		}
		const info = statement.run(...bound);
		return { kind: 'write', meta: { changes: Number(info?.changes || 0), last_row_id: Number(info?.lastInsertRowid || 0) } };
	};
	const makeStatement = (sql) => {
		const state = { sql, params: [] };
		const api = {
			bind(...args) { state.params = args; return api; },
			async first() {
				const r = exec(state.sql, state.params);
				return r.kind === 'rows' ? (r.rows[0] ?? null) : null;
			},
			async run() {
				const r = exec(state.sql, state.params);
				if (r.kind === 'rows') return { success: true, results: r.rows };
				return { success: true, meta: r.meta };
			},
			async all() {
				const r = exec(state.sql, state.params);
				if (r.kind === 'rows') return { success: true, results: r.rows };
				return { success: true, results: [] };
			}
		};
		return api;
	};
	return { __sqlite: db, prepare: (sql) => makeStatement(sql), query: (sql, ...p) => db.prepare(sql).all(...p).map(normOut) };
}

// ---------- 断言 ----------
let pass = 0, fail = 0;
const failures = [];
function assert(name, condition, detail = '') {
	if (condition) { pass += 1; console.log(`  OK   ${name}`); }
	else { fail += 1; failures.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); }
}
function section(title) { console.log(`\n${title}`); }

// ---------- 常量 ----------
const MAIN_GROUP = '-1001111111111';
const GROUP2 = '-1002222222222';
const OWNER = '10001';
const DEPUTY = '10002';
const ADMIN = '30001';
const MEMBER = '40001';

// ---------- 确定性伪向量（字符袋）：相似文本共享字符 → 余弦高 ----------
function charBagEmbed(text) {
	const dim = 128 + 20902;
	const v = new Array(dim).fill(0);
	for (const ch of String(text || '')) {
		const code = ch.codePointAt(0);
		let idx;
		if (code >= 0x4e00 && code <= 0x9fff) idx = 128 + (code - 0x4e00);
		else idx = code % 128;
		if (idx >= 0 && idx < dim) v[idx] += 1;
	}
	return v;
}

function makeEnv(overrides = {}) {
	const db = makeD1();
	const tgCalls = [];
	const tgMock = {};
	for (const method of ['sendMessage', 'editMessageText', 'restrictChatMember', 'banChatMember', 'unbanChatMember', 'deleteMessage', 'getChatMember', 'answerCallbackQuery']) {
		tgMock[method] = (body) => {
			tgCalls.push({ method, body });
			const override = overrides.tg?.[method];
			if (override) return override(body);
			if (method === 'getChatMember') return { ok: true, result: { status: 'member', user: { id: body.user_id } } };
			return { ok: true, result: { message_id: 1 } };
		};
	}
	const ai = {
		calls: 0,
		async run(model, input) {
			ai.calls += 1;
			const text = String(input?.text ?? input?.messages?.at(-1)?.content ?? '');
			return { data: [charBagEmbed(text)] };
		}
	};
	const env = {
		OWNER_ID: OWNER,
		GROUP_ID: MAIN_GROUP,
		DB: db,
		AI: ai,
		__tgMock: tgMock,
		__aiJudgeMock: async (text) => (overrides.judge ? overrides.judge(text) : { isAd: true }),
		...(overrides.env || {})
	};
	return { env, db, tgCalls, ai };
}

function resetState() {
	invalidateOwners();
	invalidateGroups();
	invalidateUserWhitelist();
	invalidateAdminCache();
	resetSchemaState();   // schema 现在是模块级缓存，换新 DB 前必须重置
}

function countMethod(calls, method) { return calls.filter((c) => c.method === method).length; }
function ownerMessage(calls, owner = OWNER) {
	return calls.find((c) => c.method === 'sendMessage' && String(c.body.chat_id) === owner);
}

// =============================================================================
section('A. AI 语义样本自动合并（R2/R3）');
{
	resetState();
	const { env, db } = makeEnv();
	await adDetectionReady(env);

	const r1 = await addAdSample(env, '日赚2900+ 加V', { source: 'spam', computeEmbedding: true });
	const r2 = await addAdSample(env, '日赚2900+ 加V', { source: 'spam', computeEmbedding: true });
	assert('tier1 完全一致 → 只加计数', r1.added === true && r2.merged === true && r2.tier === 1);
	let rows = await db.prepare('SELECT COUNT(*) AS c FROM ad_samples').first();
	assert('语义簇只有 1 行（不重复占库）', Number(rows.c) === 1);
	let row = await db.prepare('SELECT count FROM ad_samples').first();
	assert('计数为 2', Number(row.count) === 2);

	const r3 = await addAdSample(env, '出售 usdt', { source: 'auto' });
	const r4 = await addAdSample(env, '出售usdt一枚', { source: 'auto' });
	assert('tier2 签名一致（变体词不同）→ 合并', r4.merged === true && r4.tier === 2);
	rows = await db.prepare('SELECT COUNT(*) AS c FROM ad_samples').first();
	assert('共 2 个语义簇', Number(rows.c) === 2);

	const r5 = await addAdSample(env, '缺米的兄弟看过来哦', { source: 'auto', computeEmbedding: true });
	const r6 = await addAdSample(env, '缺米的兄弟看过来啦', { source: 'auto', computeEmbedding: true });
	assert('tier3 无关键词、向量近邻 → 合并', r6.merged === true && r6.tier === 3);
	const merged = await db.prepare('SELECT variants, count FROM ad_samples WHERE sample_text = ?').bind('缺米的兄弟看过来哦').first();
	assert('变体已记录、计数为 2', JSON.parse(merged.variants).length >= 1 && Number(merged.count) === 2);

	const hit = await matchAdSemantic(env, '缺米的兄弟看过来咯', { aiSimilarity: 0.78, aiEnabled: true });
	assert('AI 语义命中同簇变体', hit.hit === true);
}

// =============================================================================
section('B. 进群指纹命中 → 待确认 → 确认后同指纹自动全群封禁（R7）');
{
	resetState();
	const { env, db, tgCalls } = makeEnv();
	await adDetectionReady(env);
	await db.prepare('INSERT INTO ad_groups (chat_id, added_by, created_at) VALUES (?, ?, ?)').bind(GROUP2, OWNER, 1).run();
	invalidateGroups();

	await learnFingerprints(env, [{ type: 'name', value: '专业收号' }], { source: 'auto' });
	await handleNewChatMembers(env, {
		chat: { id: MAIN_GROUP, title: '主群', type: 'supergroup' },
		new_chat_members: [{ id: '50001', is_bot: false, first_name: '专业收号' }]
	});
	assert('pending 命中 → 只禁言当前群', countMethod(tgCalls, 'restrictChatMember') === 1);
	assert('pending 命中 → 不全群封禁', countMethod(tgCalls, 'banChatMember') === 0);
	const openHits = await db.prepare("SELECT * FROM ad_join_hits WHERE status = 'open'").all();
	assert('生成 open 待确认记录', openHits.results.length === 1);
	const fpId = openHits.results[0].fingerprint_id;
	const notify = ownerMessage(tgCalls);
	assert('推送给主人待确认', Boolean(notify));
	assert('带确认/忽略按钮', JSON.stringify(notify?.body?.reply_markup || '').includes(`c:fp:${fpId}:confirm`) && JSON.stringify(notify?.body?.reply_markup || '').includes('ignore'));

	await handleCallback(env, {
		id: 'cb1', data: `c:fp:${fpId}:confirm:50001`,
		from: { id: OWNER },
		message: { chat: { id: OWNER }, message_id: 9001 }
	});
	const fps = await db.prepare('SELECT status FROM ad_fingerprints WHERE id = ?').bind(fpId).first();
	assert('主人确认后指纹 = confirmed', fps.status === 'confirmed');
	assert('确认时全群封禁 2 群', countMethod(tgCalls, 'banChatMember') === 2);

	const before = countMethod(tgCalls, 'banChatMember');
	await handleNewChatMembers(env, {
		chat: { id: MAIN_GROUP, title: '主群', type: 'supergroup' },
		new_chat_members: [{ id: '50002', is_bot: false, first_name: '专业收号' }]
	});
	assert('下次同指纹进群 → 自动全群封禁', countMethod(tgCalls, 'banChatMember') === before + 2);
}

// =============================================================================
section('C. 权限分级（R4/R5/R9 + 副主人/授权群命令）');
{
	// C1 群管理员 /ban 只封当前群
	resetState();
	const c1 = makeEnv({ tg: { getChatMember: () => ({ ok: true, result: { status: 'administrator', user: { id: ADMIN } } }) } });
	await adDetectionReady(c1.env);
	await handleCommand(c1.env, { text: '/ban 41001', chat: { id: MAIN_GROUP, type: 'supergroup' }, from: { id: ADMIN, first_name: '管理员' } });
	assert('群管理员 /ban 只封当前群', countMethod(c1.tgCalls, 'banChatMember') === 1 && c1.tgCalls.filter((c) => c.method === 'banChatMember').every((c) => String(c.body.chat_id) === MAIN_GROUP));
	const bl1 = await c1.db.prepare('SELECT 1 AS x FROM blacklist WHERE user_id = ?').bind('41001').first();
	assert('群管理员 /ban 不进黑名单', !bl1);

	// C2 群管理员 /spam → 封本群 + 清扫 + 上报；主人确认才全群封禁
	resetState();
	const c2 = makeEnv({ tg: { getChatMember: () => ({ ok: true, result: { status: 'administrator', user: { id: ADMIN } } }) } });
	await adDetectionReady(c2.env);
	await c2.db.prepare('INSERT INTO ad_groups (chat_id, added_by, created_at) VALUES (?, ?, ?)').bind(GROUP2, OWNER, 1).run();
	invalidateGroups();
	await handleCommand(c2.env, {
		text: '/spam',
		chat: { id: MAIN_GROUP, title: '主群', type: 'supergroup' },
		from: { id: ADMIN, first_name: '管理员' },
		reply_to_message: { message_id: 7001, from: { id: '41002', username: 'adman', first_name: '广告哥' }, text: '日赚2900 加V' }
	});
	assert('群管理员 /spam 封本群（1 次）', countMethod(c2.tgCalls, 'banChatMember') === 1);
	assert('群管理员 /spam 删除引用消息', countMethod(c2.tgCalls, 'deleteMessage') >= 1);
	const approval = ownerMessage(c2.tgCalls);
	assert('推主人确认（含 c:spam 按钮）', Boolean(approval) && JSON.stringify(approval?.body?.reply_markup || '').includes('c:spam:41002'));
	await handleCallback(c2.env, { id: 'cb2', data: 'c:spam:41002', from: { id: OWNER }, message: { chat: { id: OWNER }, message_id: 9002 } });
	assert('主人确认后全群封禁（累计 3 = 本群1 + 全群2）', countMethod(c2.tgCalls, 'banChatMember') === 3);
	const bl2 = await c2.db.prepare('SELECT 1 AS x FROM blacklist WHERE user_id = ?').bind('41002').first();
	assert('确认后进黑名单', Boolean(bl2));

	// C3 非管理员 /spam 被拒
	resetState();
	const c3 = makeEnv();
	await adDetectionReady(c3.env);
	await handleCommand(c3.env, {
		text: '/spam',
		chat: { id: MAIN_GROUP, type: 'supergroup' },
		from: { id: MEMBER, first_name: '路人' },
		reply_to_message: { message_id: 7100, from: { id: '41003' }, text: '广告' }
	});
	assert('非管理员 /spam 被拒（不封禁）', countMethod(c3.tgCalls, 'banChatMember') === 0);

	// C4 主人 /spam 直接全群封禁 + 学习
	resetState();
	const c4 = makeEnv();
	await adDetectionReady(c4.env);
	await c4.db.prepare('INSERT INTO ad_groups (chat_id, added_by, created_at) VALUES (?, ?, ?)').bind(GROUP2, OWNER, 1).run();
	invalidateGroups();
	await handleCommand(c4.env, {
		text: '/spam',
		chat: { id: MAIN_GROUP, type: 'supergroup' },
		from: { id: OWNER, first_name: '主人' },
		reply_to_message: { message_id: 7200, from: { id: '41004', username: 'adman2' }, text: '收购账号 日结' }
	});
	assert('主人 /spam 全群封禁 2 群', countMethod(c4.tgCalls, 'banChatMember') === 2);
	const fpCount = await c4.db.prepare('SELECT COUNT(*) AS c FROM ad_fingerprints').first();
	assert('主人 /spam 学习指纹', Number(fpCount.c) >= 1);
	const sampleCount = await c4.db.prepare('SELECT COUNT(*) AS c FROM ad_samples').first();
	assert('主人 /spam 保存语义样本', Number(sampleCount.c) >= 1);

	// C5 副主人与授权群：仅主人可管理
	resetState();
	const c5 = makeEnv();
	await adDetectionReady(c5.env);
	await handleCommand(c5.env, { text: '/add_owner 10002', chat: { id: OWNER, type: 'private' }, from: { id: OWNER, first_name: '主人' } });
	invalidateOwners();
	const cfgA = await loadConfig(c5.env);
	assert('主人可加副主人', isOwner(DEPUTY, cfgA) && !isPrimaryOwner(DEPUTY, cfgA));
	await handleCommand(c5.env, { text: '/add_owner 10003', chat: { id: DEPUTY, type: 'private' }, from: { id: DEPUTY, first_name: '副主人' } });
	const owners = await c5.db.prepare('SELECT COUNT(*) AS c FROM ad_owners').first();
	assert('副主人不能加副主人', Number(owners.c) === 1);
	await handleCommand(c5.env, { text: `/add_group ${GROUP2}`, chat: { id: OWNER, type: 'private' }, from: { id: OWNER, first_name: '主人' } });
	invalidateGroups();
	const cfgB = await loadConfig(c5.env);
	assert('主人可加授权群（主群 + 授权群生效）', cfgB.groupIds.has(MAIN_GROUP) && cfgB.groupIds.has(GROUP2));
}

// =============================================================================
section('D. 全群封禁回执（R6）');
{
	resetState();
	const d1 = makeEnv({ tg: { banChatMember: (body) => (String(body.chat_id) === GROUP2 ? { ok: false, description: '用户不是群成员' } : { ok: true, result: true }) } });
	await adDetectionReady(d1.env);
	await d1.db.prepare('INSERT INTO ad_groups (chat_id, added_by, created_at) VALUES (?, ?, ?)').bind(GROUP2, OWNER, 1).run();
	invalidateGroups();
	const cfg1 = await loadConfig(d1.env);
	const res1 = await banAllGroups(d1.env, '42001', cfg1, 'test');
	const receipt1 = renderBanAllReceipt(res1);
	assert('成功只报数量', res1.okCount === 1 && receipt1.includes('成功 1 个群'));
	assert('失败才列原因', receipt1.includes(GROUP2) && receipt1.includes('用户不是群成员'));

	resetState();
	const d2 = makeEnv();
	await adDetectionReady(d2.env);
	const cfg2 = await loadConfig(d2.env);
	const res2 = await banAllGroups(d2.env, '42002', cfg2, 'test');
	const receipt2 = renderBanAllReceipt(res2);
	assert('全部成功 → 只报数量、无失败段', res2.okCount === 1 && receipt2.includes('成功 1 个群') && !receipt2.includes('失败'));
}

// =============================================================================
section('E. /ad 群成员 AI 判定 + 推主人（新需求）');
{
	resetState();
	const e1 = makeEnv({ judge: async () => ({ isAd: true }) });
	await adDetectionReady(e1.env);
	await handleCommand(e1.env, {
		text: '/ad',
		chat: { id: MAIN_GROUP, title: '主群', type: 'supergroup' },
		from: { id: MEMBER, first_name: '路人' },
		reply_to_message: { message_id: 7300, from: { id: '43001', first_name: '广告狗', username: 'adog' }, text: '外围面交 日结' }
	});
	assert('判定广告 → 禁言当前群', countMethod(e1.tgCalls, 'restrictChatMember') === 1);
	assert('判定广告 → 删除引用消息', countMethod(e1.tgCalls, 'deleteMessage') >= 1);
	const report = ownerMessage(e1.tgCalls);
	assert('推主人：含正文 + 被举报人名', Boolean(report) && String(report.body.text).includes('外围面交 日结') && String(report.body.text).includes('广告狗'));
	assert('带全群封禁按钮', JSON.stringify(report?.body?.reply_markup || '').includes('c:spam:43001'));
	assert('判定广告 → 不自动全群封禁', countMethod(e1.tgCalls, 'banChatMember') === 0);

	await e1.db.prepare('INSERT INTO ad_groups (chat_id, added_by, created_at) VALUES (?, ?, ?)').bind(GROUP2, OWNER, 1).run();
	invalidateGroups();
	await handleCallback(e1.env, { id: 'cb3', data: 'c:spam:43001', from: { id: OWNER }, message: { chat: { id: OWNER }, message_id: 9003 } });
	assert('主人点按钮才全群封禁（2 群）', countMethod(e1.tgCalls, 'banChatMember') === 2);

	resetState();
	const e2 = makeEnv({ judge: async () => ({ isAd: false }) });
	await adDetectionReady(e2.env);
	await handleCommand(e2.env, {
		text: '/ad',
		chat: { id: MAIN_GROUP, type: 'supergroup' },
		from: { id: MEMBER, first_name: '路人' },
		reply_to_message: { message_id: 7400, from: { id: '43002', first_name: '正常人' }, text: '你好啊' }
	});
	assert('判定非广告 → 不禁言不删', countMethod(e2.tgCalls, 'restrictChatMember') === 0 && countMethod(e2.tgCalls, 'deleteMessage') === 0);
	const report2 = ownerMessage(e2.tgCalls);
	assert('非广告也推主人复核（含正文+人名）', Boolean(report2) && String(report2.body.text).includes('非广告') && String(report2.body.text).includes('正常人'));
}

// =============================================================================
section('F. /ad 判定解析（not_ad / 中文否定不误判）');
{
	async function runJudge(responseText) {
		const base = makeEnv();
		const e = { ...base.env, __aiJudgeMock: undefined };
		e.AI = { async run() { return { response: responseText }; } };
		return judgeAdWithAI(e, '随便发一条消息');
	}
	assert('输出 ad → 判广告', (await runJudge('ad')).isAd === true);
	assert('输出 广告 → 判广告', (await runJudge('广告')).isAd === true);
	assert('输出 not_ad → 不判广告', (await runJudge('not_ad')).isAd === false);
	assert('输出 不是广告 → 不判广告', (await runJudge('不是广告')).isAd === false);
	assert('输出 正常 → 不判广告', (await runJudge('正常')).isAd === false);
}

// =============================================================================
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (failures.length) {
	console.log('失败项：');
	for (const f of failures) console.log('  - ' + f);
	process.exit(1);
}
process.exit(0);
