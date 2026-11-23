# Cloudflare 观察任务池

后台入口：<https://tg-observe-manager.7star-acc.workers.dev/>

仅分布观察任务；Beta 保留唯一 Telegram webhook、原群管理和权威样本/黑名单 D1。Plus 不参与部署。VPS 只保留原 Telethon 只读采集服务，没有安装后台、域名或 Tunnel。

## 运行组件

- [controller-worker.js](<controller-worker.js>)：SQLite Durable Object 中央状态、全局事件去重、账户 Analytics 监测、调度、主人复核和低频命中计数写回。
- [node-worker.js](<node-worker.js>)：只读分类节点，两账户各用独立 D1 字典快照。无 Telegram Bot Token，不发消息、不做封禁。
- [admin-page.mjs](<admin-page.mjs>)：后台页面，签名 HttpOnly/Secure Cookie 登录；只手动刷新，无浏览器端 Cloudflare Token。
- [quota.mjs](<quota.mjs>)：按 UTC 当日、账户全部 D1 的读/写量保护；统计未知、过期或不同日不派发。
- [protocol.mjs](<protocol.mjs>)：消息和字典严格类型、大小、版本及向量验证。快照传输上限 1,800,000 字节，避免超过 D1 单行上限。
- [采集器说明](<../collector/README.md>)：队列最多 1000，初始回溯最多 100，最多 20 次投递/分钟，暂停时保留队列和游标。

## 额度保护

免费档保护基准为每天 5,000,000 行读取 / 100,000 行写入；任一达到 80% 排除该观察账号。所有节点不可用时，状态端返回 `observe_allowed:false`，入库返回 503、`paused:true`、`Retry-After:60`。

Analytics 每分钟刷新，并非实时精确账单；结合持久本地计量与源端请求预算预留。源字典每次预留七表（包含黑名单）最大合法读预算 52,000 行，接近上限时不强行同步。判断正常群管理可用性仍取决于 CF77 的共享额度，观察分流不能保证其不被其他任务耗尽。

确认任务在源账号用量未知、过期或额度不足时保留待同步，不虚报保存/封禁完成。已有指纹/语义命中只累计中央计数、不发复核。新通知用 `op:` 全局 ID；旧 `o:` 通知只读原记录迁入中央状态，再经同一源额度守门和实时白名单/主人保护执行。

字典快照由 Beta 的 D1 事务读取生成，并包含只读黑名单 ID 与按样本类型隔离的完整语义变体。节点版本不同不能分类；节点丢失快照的 409 会使同步标记失效并在冷却后补同步。未知 AI 结果只给主人复核，不自动惩罚。

观察通知发送前再次索引查询 Beta 黑名单，检查失败则保留待通知任务，不盲推。完全相同的正文/引用/名片内容跨用户、群、节点只推送一次，内容键保留 30 天并跨重启持久化；升级时从现有已发送复核记录初始化去重键。已有指纹、完整样本/变体或 AI 向量语义命中始终不推送，语义累计计数仍保留。后续确认回执保存每个群的具体失败原因，而非只显示失败数量。

## 后台操作

- **负载均衡**：优先低用量健康账号；**顺序故障转移**：按配置账号顺序使用。
- 单账号启停、手动暂停/恢复、刷新用量、同步字典。
- “通知状态不确定”只支持查看与放弃；不盲重发，不自动保存样本或处罚。
- 后台密码使用独立 runtime secret `ADMIN_PASSWORD`，不输入 Cloudflare API Token。运行时凭证不写入 Git。
- 登录页提供 10 分钟有效的签名表单校验值与独立 HttpOnly/Secure/SameSite Cookie；浏览器省略 `Origin` 或发出 `Origin: null` 时，仍须校验该值。真正的跨站来源、过期或伪造表单一律拒绝；不把禁用同源保护作为登录兼容办法。
- 复核通知不直接显示内部 `ai_ad` 代码，准确区分「AI 文本判定广告」「结构规则命中」「AI 不可用，待人工复核」。指纹和 AI 语义匹配仍静默跳过；AI 文本分类不能冒称语义/指纹命中。延期通知保存原始分类类型，恢复时不丢失标签。

## 维护部署

部署配置显式绑定账号与专用资源：

```bash
npx wrangler deploy --config pool/wrangler.cf77-node.toml --keep-vars
npx wrangler deploy --config pool/wrangler.7star-node.toml --keep-vars
npx wrangler deploy --config pool/wrangler.manager.toml --keep-vars
```

分别使用对应账户凭证。首次部署须先设置配置注释中的独立 secrets；现有部署须保留原值。部署前读回 Worker 名、账号、D1 ID、当前活动版本与绑定，拒绝覆盖无关 Worker。

后台配置使用 SQLite Durable Object 的 `pool-v1` migration；代码更新采用 immediate strategy。不得删除 namespace、重置 Telegram session 或清空采集队列来处理部署失败。

## 无网测试

```bash
node --test pool/test_controller.mjs pool/test_quota_auth.mjs pool/test_node.mjs pool/test_admin_page.mjs test_pool_beta.mjs
node test_beta.mjs
python3 -m unittest discover -s collector -p 'test_*.py'
```

测试使用真实内存 SQLite 和假 Telegram/Cloudflare，不会处罚真实用户。覆盖读或写 80%、未知/陈旧用量、UTC 换日、源预算并发、字典版本、旧/新复核去重、异常通知、登录同源验证和采集暂停恢复。
