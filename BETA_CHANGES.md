# Beta 修复与部署说明

本说明只适用于 `Beta` 分支的 `tg-unban-bot-beta`，不适用于 Plus 生产实例。后续部署请显式使用 Beta 配置，避免误发 Plus。

## 本次变更

- `/ad` 对群内普通成员、管理员、主人与副主人均开放：回复待判定消息发送 `/ad`。
- 替换已退役的 Qwen 1.5 默认模型为 `@cf/mistralai/mistral-small-3.1-24b-instruct`；可通过 `AD_JUDGE_MODEL` 覆盖。
- AI 结果仅接受明确的 `ad` / `ok` 标签；空值、解释、截断和未知结构报告失败，不当作正常聊天。AI 异常会显示失败提示。
- 被举报消息的正文和引用上下文分区传入模型，避免引用广告进行警示被直接当成推广。
- `/ad` 判定复核、指纹待确认与 `/spam` 待审批通知仅私聊第一主人 `OWNER_ID`；不再群发给副主人。不改变副主人已有命令权限。
- `/ad` 最终判定回执和 `/unban` 成功回执在群内发送后 8 秒自动撤回，使用 `ctx.waitUntil()` 承载完整延迟和删除任务。私聊成功回执及主人复核通知不撤回。
- Telegram 发送失败或没有有效消息 ID 时不创建删除任务；删除失败不会影响已经完成的命令。

## 备用 AI 与账户额度保护

只接管 `/ad` 文本分类，Cloudflare 优先，备用模型为 `DeepSeek-V4.1-Flash`。向量嵌入仍使用 Cloudflare 的嵌入模型，不能将聊天模型结果当作向量。

以下配置仅在 Cloudflare 运行时设置，不要写入任何 Git 文件或构建参数：

| 变量 | 用途 |
| --- | --- |
| `AI_API_BASE_URL` | 备用 OpenAI 兼容服务基础地址；应作为 secret 保存，不提交真实地址 |
| `AI_API_TOKEN` | 备用服务密钥；作为 secret 保存 |
| `AI_FALLBACK_MODEL` | 备用模型标识；默认 `DeepSeek-V4.1-Flash` |
| `AI_ALLOW_INSECURE_HTTP` | 只有明确接受密钥和消息明文传输风险时才设 `1`；默认只允许 HTTPS |
| `CF_AI_MONITOR_ENABLED` | 设 `1` 启用账户级每日 Neurons 监控 |
| `CF_ACCOUNT_ID` | 需要监控的 Cloudflare 账户 ID |
| `CF_AI_ANALYTICS_TOKEN` | 读取账户 Analytics 的 secret；推荐独立 Account Analytics Read Token，不要使用高权限管理密钥 |
| `CF_AI_FALLBACK_NEURONS` | 切换阈值，默认 `9000`，范围大于 0 且不超过 10000 |

监控通过 GraphQL 查询账户全部 Workers AI 调用的 `sum.totalNeurons`，按 UTC 日从零点累计；没有按当前 Worker 或模型过滤。低用量快照最多缓存 60 秒，达到阈值后当日保持走备用，UTC 换日后重新检查。D1 专用状态表 `ai_classifier_state` 与广告词库分离，不修改既有样本或黑名单。

Analytics 存在统计延迟和自适应采样，9,000 是缓冲阈值，**不保证账户零超额**。其他 Worker 与向量嵌入仍可能消耗该账户额度。监控开启但无法取得可靠的新用量时，保守转备用；备用也不可用则提示 AI 判定失败，不凭空判正常或自动处罚。

明确的 Cloudflare 日额度错误 `3036` 会标记当日耗尽；临时 429/5xx 或输出无效可仅对当次尝试备用，不把一般限流当成每日耗尽。备用请求有超时、输出大小上限，禁止跟随重定向；地址、密钥、原始异常、响应和消息正文不写入日志。未知/截断输出不产生处罚。

首次部署需通过 Dashboard 或 secrets API 设置真实配置；不要把地址或密钥放入 TOML 的 `[vars]`、README 示例、命令行历史或提交信息。

## 验证

```bash
node --check _worker.js
node test_beta.mjs
node --test test_ad_report.mjs test_flash_receipts.mjs test_ai_fallback.mjs
```

新增回归覆盖 AI 输出解析、错误反馈、仅主人通知、普通成员 `/ad`、8 秒定时生命周期和私聊保留。测试不访问真实 Telegram/Cloudflare，也不处罚真实用户。

## 部署

```bash
npx wrangler deploy --config wrangler.beta.toml --keep-vars
```

部署前核对 Worker 名 `tg-unban-bot-beta`、独立 D1 绑定和当前远端变量。不要使用默认配置误部署 Plus，也不要将 Plus 的 `TOKEN` 路径或 Authorization 迁移拷到 Beta。

`TELEGRAM_BOT_TOKEN`、`WEBHOOK_SECRET` 等凭证应通过 Cloudflare secrets 配置；不要新增凭证明文到仓库。已有配置中的值不应视作安全凭证范例。

本分支根 README 保留了历史 Plus 文档，Beta 当前实现与它不完全一致；Beta 行为以本说明、重写规范和代码为准。
