// 严格模式契约 · 离线验证
//
// 【为什么必须有这个测试】
// Cloudflare Workers 的 `_worker.js` 是 ES Module，运行时是【严格模式】。
// 严格模式下给一个「未声明的标识符」赋值会立刻抛 ReferenceError，
// 而在非严格模式（普通 <script> / vm.runInContext 默认）下，同样的代码
// 会【静默创建一个全局变量】，什么都不报。
//
// 后果就是：本地测试全绿、wrangler deploy 成功，线上第一个请求直接 500。
// 2026-09-18 真实踩过一次 —— 合并上游 PROFILE_LOOKUP_GROUPS 时漏了
// `let PROFILE_LOOKUP_GROUPS = [];` 这行声明，只有赋值和使用两处，
// 952 条测试全过，部署后 GET / 返回 `PROFILE_LOOKUP_GROUPS is not defined`。
//
// 所以本测试做两件事：
//   1. 用【严格模式】加载 _worker.js —— 顶层作用域里的漏声明会被当场抓住；
//   2. 主动调用几个配置入口函数 —— 函数体里的漏声明要执行到那一行才会抛，
//      光加载不够，必须真的把配置路径跑一遍。
//
// 注意：这里刻意【不】mock 出 PROFILE_LOOKUP_GROUPS 之类的全局变量，
// 否则就等于把要检测的问题给补上了。
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync('_worker.js', 'utf8');

let pass = 0;
let fail = 0;
function check(label, cond, extra) {
	if (cond) { pass += 1; console.log('  ✅ ' + label + (extra ? '  ' + extra : '')); }
	else { fail += 1; console.log('  ❌ ' + label + (extra ? '  ' + extra : '')); }
}

// 与其它测试同款的沙箱；fetch 一律返回成功，避免网络行为干扰
const sandbox = {
	console, URL, URLSearchParams, TextEncoder, TextDecoder, Response, Request, Headers,
	atob, btoa, setTimeout, clearTimeout, setInterval, clearInterval,
	fetch: async () => ({
		ok: true,
		status: 200,
		json: async () => ({ ok: true, result: true }),
		text: async () => JSON.stringify({ ok: true, result: true })
	})
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// 关键点一：把 "use strict" 顶到脚本最前面，让整个模块以严格模式求值。
// export default 要改写成赋值，否则脚本语法不合法（和上游测试同样处理）。
const strictSource = '"use strict";\n' + src.replace(/export\s+default\s*/, 'globalThis.__handler = ');

console.log('\n=== 1. 严格模式加载 _worker.js ===');
let loadError = null;
try {
	vm.runInContext(strictSource, sandbox, { filename: '_worker.js' });
} catch (e) {
	loadError = e;
}
check('顶层作用域没有未声明赋值（严格模式加载通过）',
	loadError === null,
	loadError ? `→ ${loadError.constructor.name}: ${loadError.message}` : '');

if (loadError) {
	console.log('\n（加载就失败，后续用例无法继续，直接判定整体不通过）');
	console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
	process.exit(1);
}

console.log('\n=== 2. 调用配置入口（触发函数体内的赋值路径）===');

// applyRuntimeConfig：把 loadRequiredConfig 的产物灌进各顶层运行时变量。
// 这一步是线上「每个请求」都会走的路径，漏声明在这里必然爆。
const fullConfig = {
	TOKEN: '123:ABC',
	BOT_TOKEN: '123:ABC',
	GROUP_ID: '-100111',
	GROUP_IDS: ['-100111'],
	ENV_GROUP_IDS: ['-100111'],
	DYNAMIC_GROUP_IDS: [],
	SUPER_ADMINS: [],
	OWNER_IDS: [],
	STATIC_USER_PROFILES: {},
	PROFILE_LOOKUP_GROUPS: [],
	AD_PROTECTED_USERNAMES: [],
	AD_EXEMPT_DYNAMIC: [],
	MSG_CACHE_SIZE: 50,
	FLASH_MESSAGE_TTL_MS: 3000,
	BLACKLIST_PAGE_LIMIT: 10,
	BLACKLIST_REASON_LABELS: {},
	GKY_BANLIST_ENDPOINT: '',
	SELF_UNBAN_KEYWORD: '',
	START_WELCOME: '',
	SELF_UNBAN_PROMPT: '',
	SELF_UNBAN_APPROVED: '',
	SELF_UNBAN_APPROVED_NOLINK: '',
	SELF_UNBAN_CONTACT_GROUP: ''
};

let cfgError = null;
try {
	sandbox.applyRuntimeConfig(fullConfig);
} catch (e) {
	cfgError = e;
}
check('applyRuntimeConfig 在严格模式下不抛错',
	cfgError === null,
	cfgError ? `→ ${cfgError.constructor.name}: ${cfgError.message}` : '');

// loadRequiredConfig：从 env 解析出全部配置。PROFILE_LOOKUP_GROUPS 的解析就在里面。
let loadCfgError = null;
let loadedCfg = null;
try {
	loadedCfg = sandbox.loadRequiredConfig({
		TOKEN: '123:ABC',
		BOT_TOKEN: '123:ABC',
		GROUP_ID: '-100111',
		OWNER_ID: '1',
		ADMIN_IDS: '',
		STATIC_USER_PROFILES: '{}'
	});
} catch (e) {
	loadCfgError = e;
}
check('loadRequiredConfig 在严格模式下不抛错',
	loadCfgError === null,
	loadCfgError ? `→ ${loadCfgError.constructor.name}: ${loadCfgError.message}` : '');

check('loadRequiredConfig 产出了 PROFILE_LOOKUP_GROUPS 字段',
	loadedCfg !== null && Object.prototype.hasOwnProperty.call(loadedCfg, 'PROFILE_LOOKUP_GROUPS'),
	loadedCfg ? `→ ${JSON.stringify(loadedCfg.PROFILE_LOOKUP_GROUPS)}` : '');

console.log('\n=== 3. 反向自检：本测试确实能抓到漏声明 ===');
// 造一个「未声明就赋值」的片段，确认严格模式下会抛 —— 否则这个测试是空转的。
// ⚠️ 判据必须用 e.name 而不是 `e instanceof ReferenceError`：
// 沙箱是独立的 realm，它的 ReferenceError 与主 realm 的不是同一个构造器，
// instanceof 会恒为 false，导致自检永远"失败"（这个坑本测试第一版就踩过）。
let probeThrew = false;
let probeName = '';
try {
	vm.runInContext('"use strict";\nTHIS_IDENTIFIER_IS_INTENTIONALLY_UNDECLARED = 1;', vm.createContext({}), {});
} catch (e) {
	probeThrew = true;
	probeName = e.name;
}
check('严格模式确实会拦住未声明赋值（测试有效性自检）',
	probeThrew && probeName === 'ReferenceError',
	probeThrew ? `→ 抛出 ${probeName}` : '→ 居然没抛，本测试无效');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
