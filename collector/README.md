# Telegram 只读样本采集器

这是一个独立的 Python/Telethon 用户客户端，仅监听 **`-1001971423490`**。它不把所有消息当成广告；只将可读取的文本/引用/联系人名字交给鉴权接收端，由接收端做指纹/语义筛选和主人复核。

支持两种传输模式：新多账户 pool 控制器 **`/api/ingest`**（含全局配额暂停门），以及旧 Beta **`/api/observe/ingest`**（仅为兼容原服务）。升级只需替换接收 URL 与 collector 专用 Bearer token；原 Telegram 会话文件、队列和游标不变，**不需要重新登录**。

本目录提供源码、无网单元测试与服务模板。现有采集服务升级时只替换源码和回传配置，保留授权会话、队列与游标；不会部署 VPS 后台。Collector 不读取或管理账户池凭证，也不拥有管理面板权限。

## 权限与运行边界

- 必须使用一个已获准访问目标群的 Telegram 用户账号。`API ID / API Hash` 只是应用身份，不授予群访问权。
- **不会自动加入群、发消息、回复、删除、禁言、踢人或修改群。** 只读 dialogs、群资料、`get_messages` 和 `iter_messages`。
- 非目标群消息直接忽略。目标群 ID 是代码常量，不接受环境变量扩展为批量群列表。
- 未授权的长驻进程退出码 **3**，不会偷偷调用 `.start()` 或申请短信/Telegram 验证码。
- 无法读取目标群退出码 **4**，不会尝试加入或绕过权限。
- 正常/广告文本都不是由采集器定罪；它输出中没有 `is_ad` 字段。可见文字之外不做 OCR、图片识别或简介推测。
- 当前接收端只接受真实 Telegram User ID。匿名群/频道身份、不支持的来源按 `unsupported_skip` 计数跳过，不伪造用户 ID。将来需独立 sender_chat 协议，不能把频道 ID 写进用户黑名单。
- 支持普通文本以及带用户 ID 的 `/spam` 命令转发；仅回复形式 `/spam` 暂不支持二级 reply 序列化，明确按 `unsupported_skip` 跳过，不推断被举报用户。

## 文件

- [collector.py](<collector.py>)：入口、配置、SQLite 有界队列、HTTP 发送器和只读扫描。
- [test_collector.py](<test_collector.py>)：stdlib unittest，假 Telegram/HTTP 客户端，不联网。
- [requirements.txt](<requirements.txt>)：固定 `Telethon==1.42.0`，QR PNG 用 `qrcode[pypng]==8.0`、`pypng==0.20220715.0`，不需要 Pillow。父代理需实际核验这些版本后再安装。
- [tg-sample-collector.service](<tg-sample-collector.service>)：独立非 root 服务用户与资源限制。

## 环境变量

| 变量 | 用途 / 默认值 |
|---|---|
| `TG_API_ID` | Telegram 应用 ID，正整数 |
| `TG_API_HASH` | Telegram 应用 hash，32 个十六进制字符；不放命令行 |
| `OBSERVE_INGEST_URL` | 完整 HTTPS URL，严格路径仅允许 `/api/ingest`（pool）或 `/api/observe/ingest`（旧入口）；禁止用户信息、query、fragment 和末尾 `/` |
| `OBSERVE_INGEST_TOKEN` | **collector 专用** HTTP Bearer token，只调用入库和状态端点；不放 URL / 命令行，不使用池账户/管理 token |
| 派生 `CONTROL_STATUS_URL` | pool 模式自动使用接收 URL 同 origin 的 `/api/collector/status`；无需配置，不接受环境变量改成其他 origin；旧模式不调用此端点 |
| `COLLECTOR_DATA_DIR` | 默认 `/var/lib/tg-sample-collector`，绝对路径，权限 0700 |
| `COLLECTOR_PER_MINUTE` | 默认 **20**，允许 1–20；所有 HTTP 尝试（包括重试）都占频率 |
| `COLLECTOR_HISTORY_LIMIT` | 首次启动最近 **100** 条，允许 0–100；0 显式选择只从启动后监听 |
| `COLLECTOR_MAX_SPOOL` | 默认/最大 **1000**，允许 1–1000 |
| `COLLECTOR_POLL_SECONDS` | 无事件时补扫周期，默认 **30**，允许 10–300 秒 |

授权/`--check` 只需要 TG 配置与本机 data dir，不要求 ingest token。常驻采集则要求全部必要配置。

服务从 **`/etc/tg-sample-collector.env`** 读取变量。部署方创建此私有文件并设为 `root:root 0600`；systemd 负责读取后传给非 root 进程。真实配置不得写入 Git、README 或公开日志。

## Pool 控制与暂停协议

Pool 模式由**一个后台 control loop**用 collector Bearer 发出 `GET /api/collector/status`。Scanner 和 Dispatcher 共享同一个 `PauseGate`，它们只检查内存快照，**不会各自请求状态、分类端点或账户 API**。

控制端返回（`checked_at` 是 Unix **毫秒**，重试间隔是**秒**）：

```json
{
  "ok": true,
  "observe_allowed": false,
  "reason": "all_accounts_paused",
  "checked_at": 1800000000000,
  "retry_after": 60
}
```

- 允许状态最多缓存 **60 秒**；刷新进行中不会继续使用过期许可。
- `checked_at` 超过 **300 秒**、严重超前（超过 5 秒）、状态缺字段/类型错误、HTTP 401/403/异常/非 JSON 均按**未知并暂停**处理。只接受真正的 JSON boolean，不接受 `1` / `"true"`。
- `observe_allowed=false`（如账户池达到 80% 的配额门）时保持服务活着，只进行状态刷新/本地等待；不扫描 Telegram 历史、不取发送人、不新增队列、不推进 cursor、不派发 `/api/ingest`，也不调用 `/classify`。传输已在途时无法撤回，但不会开始后续扫描/发送。
- 启动时 pool 默认为暂停，直到获得新鲜的允许状态才做目标群解析/历史扫描。已授权 Telegram 连接可保持在线，`NewMessage` 不会在暂停期间触发数据扫描；恢复后按原 cursor 追上消息。
- 暂停/未知等待间隔 **3–60 秒**，不是忙轮询。`retry_after` 小于 3 秒按 3 秒处理，长间隔期间状态最多每 60 秒检查一次。
- 入库端 HTTP **429/503** 返回 `{ "ok":false, "paused":true, "retryAfter":60 }`（或 `Retry-After`）时，保留当前队列项并立即共享暂停两条数据路径。下次控制状态和重试窗口均允许才恢复。
- Collector 不做池账户轮换、不接触管理 token，配额判断来自控制器的缓存；旧 URL 模式没有此全局 gate，升级时必须改到 `/api/ingest` 才享有暂停协议。

## 首次授权与检查

先停止常驻服务；不要两个进程同时用同一个 SQLite session 登录。只有用户明确选择授权入口时才申请登录。

父代理在服务用户身份、安全加载 EnvironmentFile 后执行：

```sh
/opt/tg-sample-collector/venv/bin/python /opt/tg-sample-collector/collector.py --login-qr
```

- 使用 Telethon `qr_login()`；本机输出仅为保护文件路径。
- PNG 位于 `/var/lib/tg-sample-collector/login-qr.png`，文件 0600，目录 0700。**PNG 内含 `tg://login` 身份令牌，等同临时登录凭证；只能在可信的本机会话展示，不公开上传/写公开日志。**
- 每轮等待至登录令牌自然过期（通常十几秒），未扫到会自动重建同一路径 PNG 并重新打印文本二维码，最多 2 轮。父代理/用户需在令牌过期前扫描最新二维码；旧二维码过期即不可用。
- 若 Telegram 返回 `SessionPasswordNeededError`，采集器通过本机隐藏提示输入两步验证密码完成授权；不能假定手机扫码已代替客户端的 2FA。完成后不输出 token、账号、手机号或会话内容。
- `--login-qr` 只授权，不立即采集/回传。

备用授权入口：

```sh
/opt/tg-sample-collector/venv/bin/python /opt/tg-sample-collector/collector.py --login-phone
```

需要交互终端；手机号、验证码、2FA 密码都用 `getpass`，不从 CLI 参数读取，避免进入 shell 历史。

授权后检查：

```sh
/opt/tg-sample-collector/venv/bin/python /opt/tg-sample-collector/collector.py --check
```

`--check` 仅查授权、解析目标实体并读取至多 1 条消息证明可读，不写 spool、不回传消息；成功输出 `authorized_target_readable`。不会自行申请验证码或加入群。

> 群的数字 ID 不包含 access hash。代码优先从账号 dialogs 找目标，其次尝试已缓存的 `get_entity`。若群不在该账号可见范围，由用户在 Telegram 官方客户端先安排访问，然后再 `--check`。

## 数据与吞吐

SQLite session：`/var/lib/tg-sample-collector/telegram.session`。SQLite spool：同目录 `spool.sqlite3`，均保护为 0600。目录只允许服务用户写入；只读源码位于 `/opt/tg-sample-collector`。

- 首次只取最近最多 100 条，排序后由旧到新入队；之后从已提交 cursor 向前补扫，单次最多 100 条。不是全历史无限扫。
- `NewMessage` 事件仅唤醒扫描器，不保存所有事件对象；突发消息合并，避免大量协程/内存堆积。
- 每条入队和历史 cursor 在**同一个 SQLite 事务**提交。队列满 1000 时明确记录 `spool_full`，暂停读入，**不越过未保存的消息游标**；发送腾出空间后再从原游标重读。
- 去重键 `(chat_id,message_id)`；cursor 防止已经送出的历史再入队。重复事件/重启不会自行增加接口请求。
- 单 dispatcher / 单 HTTP 并发；`collector.lock` 的文件锁阻止两个常驻采集进程并行发送。
- 发送超时 **20 秒**，HTTP **200 不等于成功**。只有读到有效 JSON 接收回执才删除队列项；原始 HTML 200、空内容、未知结构、截断/超大响应一律保留并重试。
- 新 pool 入口要求 `{ "ok":true, "accepted":true, "event_id":"非空全局事件ID" }`。旧路径才兼容 `{ "ok":true, "status":"observe|pass|duplicate|command" }`，在 `/api/ingest` 不接受旧结构。`accepted:false` 即使带旧 `status` 也不接受。
- JSON 响应采用**有界读取，最大 64 KiB**，拒绝重复键、非有限数值和非对象响应。响应内消息、token、自由文本原因和原异常都不写日志。
- HTTP 429 遵从 `Retry-After`（秒/HTTP 日期），503/429 `paused:true` 优先读取 JSON `retryAfter`（秒）；其他失败指数退避 5 秒起、最多 900 秒。拒绝跟随重定向，不把 Authorization 转发到别的地址。
- Telethon `FloodWait` 显式暂停相应时间，不绕限制；其他 Telegram 读错误退避 30 秒，不跳游标。
- 这是**至少一次**投递：请求被接收但回包丢失时会重试，因此父代理的接收端也必须按 `(chat_id,message_id)` 幂等，不能再次通知/计数/处罚。
- sender/正文暂时读取失败保留原 cursor，待重试。纯服务/媒体无可采文本、自己发言可明确跳过，不当成广告。

回传 JSON：

```json
{
  "chat_id": "-1001971423490",
  "chat_title": "观察群",
  "message_id": 123,
  "user_id": "456",
  "first_name": "示例名字",
  "last_name": "",
  "username": "example_user",
  "is_bot": false,
  "text": "可见消息正文",
  "quote": "仅实际能取得的 quote_text",
  "contact_name": "联系人名片名字"
}
```

`quote` / `contact_name` 仅有值时带上。正文/引用最多 4000 字符，名字/群名/名片最多 256，用户名最多 64。不回传 phone、API ID/hash、session、用户会话令牌、媒体文件或图片 bytes。

## 升级与部署模板

现有服务升级只更换源码与环境文件内 `OBSERVE_INGEST_URL` / `OBSERVE_INGEST_TOKEN`；前者改为控制器 origin 的 `/api/ingest`，后者为 collector 专用 token。**不修改 Telegram session、API 配置、spool.sqlite3、cursor，不重新登录，不清空队列。** 先验证状态端协议与入库回执，再由部署方重启服务。

建议 `/opt/tg-sample-collector` 放只读源码/venv，创建系统用户 `tg-sample-collector`（无登录 shell）和私有 state dir；在 VPS 安装 Python venv 能力后安装固定 requirements。全新实例先验证接收端鉴权，再单独授权/`--check`，最后安装 unit。

服务模板：

```ini
User=tg-sample-collector
EnvironmentFile=/etc/tg-sample-collector.env
StateDirectory=tg-sample-collector
StateDirectoryMode=0700
MemoryHigh=128M
MemoryMax=192M
CPUQuota=25%
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/tg-sample-collector
```

完整模板另包含低调度优先级、35 秒停止超时、只允许网络/本地 Unix sockets、无 capability。退出 2/3/4 不自动重启以免重复未授权操作。服务恢复/安装命令由父代理在核验 VPS 环境后执行，不能关闭现有防护。

## 无网验证

从仓库根运行：

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s collector -p 'test_*.py' -v
```

测试不需要 Telethon/qrcode、实际账户配置、凭证、VPS、网络账户或网络连接。覆盖字段限长/不支持 actor 跳过、白名单、授权前退出、bootstrap 100、满队列不越游标、SQLite 持久去重、单 sender 并发、严格 JSON receipt、HTML 200/64 KiB 边界、503/429 暂停重试、状态 stale/未知/未授权、单 status-fetch loop、暂停 scanner+sender 并保留队列/cursor、恢复追扫、FloodWait 退避及权限。本次不修改登录授权逻辑。
