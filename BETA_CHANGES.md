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

## 验证

```bash
node --check _worker.js
node test_beta.mjs
node --test test_ad_report.mjs test_flash_receipts.mjs
```

新增回归覆盖 AI 输出解析、错误反馈、仅主人通知、普通成员 `/ad`、8 秒定时生命周期和私聊保留。测试不访问真实 Telegram/Cloudflare，也不处罚真实用户。

## 部署

```bash
npx wrangler deploy --config wrangler.beta.toml --keep-vars
```

部署前核对 Worker 名 `tg-unban-bot-beta`、独立 D1 绑定和当前远端变量。不要使用默认配置误部署 Plus，也不要将 Plus 的 `TOKEN` 路径或 Authorization 迁移拷到 Beta。

`TELEGRAM_BOT_TOKEN`、`WEBHOOK_SECRET` 等凭证应通过 Cloudflare secrets 配置；不要新增凭证明文到仓库。已有配置中的值不应视作安全凭证范例。

本分支根 README 保留了历史 Plus 文档，Beta 当前实现与它不完全一致；Beta 行为以本说明、重写规范和代码为准。
