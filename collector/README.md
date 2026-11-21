# Telegram 只读样本采集器

这是一个独立的 Python/Telethon 用户客户端，仅监听 **`-1001971423490`**。它不把所有消息当成广告；只将可读取的文本/引用/联系人名字交给 Beta 的鉴权接收端，由接收端做指纹/语义筛选和主人复核。

**本子目录只提供源码、单元测试与服务模板。未接触凭证、Telegram 账户、VPS 或执行部署。** 父代理负责核验依赖、配置接收端、首次授权及部署。现有 Bot API 逻辑不在本子目录修改。

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
| `OBSERVE_INGEST_URL` | 完整 HTTPS URL，路径须为 `/api/observe/ingest` |
| `OBSERVE_INGEST_TOKEN` | HTTP Bearer 密钥；不放 URL / 命令行 |
| `COLLECTOR_DATA_DIR` | 默认 `/var/lib/tg-sample-collector`，绝对路径，权限 0700 |
| `COLLECTOR_PER_MINUTE` | 默认 **20**，允许 1–20；所有 HTTP 尝试（包括重试）都占频率 |
| `COLLECTOR_HISTORY_LIMIT` | 首次启动最近 **100** 条，允许 0–100；0 显式选择只从启动后监听 |
| `COLLECTOR_MAX_SPOOL` | 默认/最大 **1000**，允许 1–1000 |
| `COLLECTOR_POLL_SECONDS` | 无事件时补扫周期，默认 **30**，允许 10–300 秒 |

授权/`--check` 只需要 TG 配置与本机 data dir，不要求 ingest token。常驻采集则要求全部必要配置。

服务从 **`/etc/tg-sample-collector.env`** 读取变量。父代理创建此私有文件并设为 `root:root 0600`；systemd 负责读取后传给非 root 进程。真实配置不得写入 Git、README 或公开日志。

## 首次授权与检查

先停止常驻服务；不要两个进程同时用同一个 SQLite session 登录。只有用户明确选择授权入口时才申请登录。

父代理在服务用户身份、安全加载 EnvironmentFile 后执行：

```sh
/opt/tg-sample-collector/venv/bin/python /opt/tg-sample-collector/collector.py --login-qr
```

- 使用 Telethon `qr_login()`；本机输出仅为保护文件路径。
- PNG 位于 `/var/lib/tg-sample-collector/login-qr.png`，文件 0600，目录 0700。**PNG 内含 `tg://login` 身份令牌，等同临时登录凭证；只能在可信的本机会话展示，不公开上传/写公开日志。**
- 每轮等待最多 240 秒；过期后同一路径重新生成 PNG，最多 2 轮。父代理需要重新读取更新后的 PNG；旧 PNG 过期即不可用。
- 二维码登录时，两步验证密码在**手机端**输入，不提供给采集器。完成时输出 `AUTHORIZED` 类别，不输出 token、账号、手机号或会话内容。
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
- 发送超时 **20 秒**，只接受 HTTP **200**，其他状态保留队列项；不读/打印响应正文。
- HTTP 429 遵从 `Retry-After`（秒/HTTP 日期），其他失败指数退避 5 秒起、最多 900 秒。拒绝跟随重定向，不把 Authorization 转发到别的地址。
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

## 部署模板（由父代理执行，本次未执行）

建议 `/opt/tg-sample-collector` 放只读源码/venv，创建系统用户 `tg-sample-collector`（无登录 shell）和私有 state dir；在 VPS 安装 Python venv 能力后安装固定 requirements。先部署并验证 Beta 接收端鉴权，再授权/`--check`，最后安装 unit。

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

测试不需要 Telethon/qrcode、实际 API ID/hash、凭证、VPS、网络账户或网络连接。覆盖字段限长/不支持 actor 跳过、白名单、授权前退出、bootstrap 100、满队列不越游标、SQLite 持久去重、单 sender 并发、HTTP 429/20 秒超时参数、失败保留、FloodWait 退避及权限。
