# TGUnbanBot-Plus Beta 重构规格书

> 分支：`Beta`（基于 Dev `53531ec` 切出）。只重构、不部署。
> 原则：**参考 Dev，不照抄**。Dev 是 17k 行的单文件历史累积，本重构从零写一份干净实现，
> 只保留产品语义（命令面、检测口径、AI 语义、指纹、用户白名单），代码全部重写。

## 0. 一句话目标

在 Cloudflare Workers（D1 + Workers AI）上重写一个「只禁言当前群、只有主人能全群封禁」的
广告治理 bot：查杀广告 → 存 AI 语义 → 同类语义自动合并不占库 → 进群命中待确认 → 确认后同指纹自动全群封禁。

## 1. 需求清单（用户原话拆解）

| # | 需求 | 落地 |
|---|---|---|
| R1 | 查杀广告，尽量不误杀 | 结构判据「招揽∧行业」两类同现才定罪 + 指纹命中 + AI 语义命中；豁免词/白名单/管理员豁免 |
| R2 | 保存 AI 语义 | 每条例定罪/人工确认的素材写入语义样本库（向量） |
| R3 | 自动合并同类语义，不多文本占库 | 去混淆归一化 + 关键词签名 + 向量余弦相似度，相似即合并计数，不新增行 |
| R4 | 默认只禁言当前群 | 自动处置一律 `restrictChatMember` 当前群 |
| R5 | 人工 /spam 或主人点「全群封禁」按钮才全群封禁 | 全群封禁只有两个入口：主人 /spam、主人确认按钮 |
| R6 | 全群封禁回执只显示「x 个群成功」，失败才显示原因 | 成功不逐群列出，失败列 `群:原因` |
| R7 | 进群时检测用户名 + 名片指纹；命中即禁言待主人确认；同指纹再遇自动封禁 | 指纹带状态机 `pending/confirmed`；进群命中 → 禁言 + 待确认；确认后命中 → 全群封禁 |
| R8 | 群管理员 /ban 只封当前群 | 权限分级 |
| R9 | /spam 推送主人，确认后全群封禁；除主人外任何群管理员无法用 /spam 全群封禁 | 群管理员 /spam → 封本群 + 清扫消息 + 通知主人待确认；主人确认 → 全群封禁 + 全群清扫 |
| R10 | 纯本地数据库，不接 GKY | 只用 D1 |
| R11 | env 只配一个主人 + 一个主群；其余授权群与副主人走命令 | `OWNER_ID`/`GROUP_ID` 单值；`ad_owners`/`ad_groups` 由 `/add_owner` `/add_group` 维护 |
| R12 | 群成员 `/ad`：AI 判定引用消息，广告则禁言 + 删除引用消息并推主人 | 仅当前群 AI 判定；主人点「全群封禁」按钮才全群封禁 |

## 2. 技术栈与边界

- 运行时：Cloudflare Workers，ES Module 入口 `export default { fetch, scheduled }`。
- 存储：**仅 D1**（本地库），表结构见 §5。不使用任何外部库（GKY 不接）。
- AI：Workers AI 嵌入模型 `@cf/baai/bge-m3`（1024 维，与 Dev 同维度，便于将来迁移存量样本）。
- 队列：不依赖 BULK_QUEUE；全群封禁用 `mapWithConcurrency` 串行带并发上限执行。
- 单文件 `_worker.js`：保留单文件形态（与 wrangler.toml、离线测试 harness 兼容），
  但内部按清晰分区重写，不做 17k 行堆叠。

## 3. 模块划分（_worker.js 内部分区）

```
0 常量/阈值             # 分数阈值、合并阈值、并发上限
1 文本工具              # normalizeAdText 去混淆归一化 / stripEmoji / sha256 / 去 @
2 词表与判据            # 招揽动词 / 业务关键词 / 弱动词 / 豁免词 / 招揽&行业正则（全新编写）
3 D1 schema             # adDetectionReady 建表
4 权限与白名单          # isPrimaryOwner / isGroupAdmin / isUserWhitelisted / allowlist
5 检测管线              # detectAdOnMessage：归一化→结构判据→指纹→AI→评分
6 AI 语义层             # addAdSample（自动合并）/ matchAdSemantic / embedding
7 指纹库                # matchFingerprint / learnFingerprint / confirmFingerprint / retireFingerprint
8 进群筛查              # handleNewChatMembers：用户名+名片指纹命中→禁言+待确认
9 处置                  # muteInCurrentGroup / banAllGroups（回执简化）
10 命令路由             # /ad /ban /spam /unban /check /pending + 白名单/放行/词库/群与副主人管理/统计
11 消息台账与清扫       # recordMessage / sweepUserMessages（/spam、/ad 删除某人消息）
12 入口                 # fetch（webhook）/ scheduled（补向量、过期清理）
```

## 4. 关键设计决策

### 4.1 检测口径（R1，尽量不误杀）

- 结构判据「招揽 ∧ 行业」两类同现才定罪：任一单类只加分不定罪。
- 指纹命中：`confirmed` 指纹命中即定罪；`pending` 指纹命中 → 禁言当前群 + 通知主人确认（与进群同款流程）。
- AI 语义命中：归一化文本的向量余弦相似度 ≥ 阈值（默认 0.78）即定罪。
- 豁免链（判定前早退）：bot 自身 / 非配置群 / 用户白名单 / 主人 / 群管理员 / 误判放行库 / 豁免词。
- **名片消息**：`text/caption` 为空时取名片显示名（first+last），照常参与判定。

### 4.2 语义自动合并（R2/R3）—— 本重构核心增量

三级合并，逐级短路：

1. **完全一致**：`norm_hash`（去混淆归一化后 sha256）已存在 → `count+1`、更新 `updated_at`，不新增行。
2. **关键词签名一致**：`signature` = 归一化文本里命中的广告关键词集合（排序拼接）。
   签名相同 → 视为同款变体 → 合并到已有代表文本，`count+1`，变体追加进 `variants`（上限 8 条）。
3. **向量近邻**：调用 bge-m3 算嵌入，与「同签名桶」外的最近样本比较余弦相似度 ≥ `MERGE_THRESHOLD`（0.85）→ 合并。
   为避免全表比：只比最近 128 条同维度样本；比对前先用签名桶缩小候选。

合并语义：一行 = 一个语义簇。`sample_text` 保留**最短非空**的那条作为代表；`count` = 命中次数；
`variants` 存变体原文（受限），`signature` 存关键词签名，便于低成本聚类。

> 用户给的样本（好橡木=好项目、17·p·m.ax=17pmax、日赚2900+/日搞1w/日赚3800）
> 经 `normalizeAdText` 后去点号/emoji/空白，再由签名（赚钱/日入/日赚…）+ 向量相似度归并。

### 4.3 指纹确认状态机（R7）

- 指纹表每行带 `status`：`pending`（待确认）/ `confirmed`（已确认）/ `retired`（已废弃）。
- **进群/发消息命中 `confirmed`** → 全群封禁。
- **命中 `pending`** → 只禁言当前群 + 写 `ad_join_hits(open)` + 私聊主人：
  「新成员 @xxx 命中待确认指纹『…』」附两个按钮：`[确认指纹并全群封禁]` `[误报，忽略]`。
- 主人点确认 → 该指纹 `status='confirmed'` + 对该用户执行全群封禁 + 关闭对应 hit。
- 主人点忽略 → 指纹 `status='retired'`（不再参与判定），该用户解除禁言。
- 只有**主人在确认流里**能改指纹状态；任何群管理员不能。

### 4.4 权限模型（R4/R5/R8/R9）

| 操作 | 主人 | 群管理员（配置群） |
|---|---|---|
| `/ban <uid>` | 黑名单 + **全群封禁** | 黑名单? 否 —— 只**当前群封禁**（不进全局黑名单） |
| `/spam`（回复某消息） | 黑名单 + **全群封禁** + 学语义/指纹 | **不封**；仅推送主人「待确认」，附全群封禁按钮 |
| 检测自动处置 | 不适用 | 只**禁言当前群**（restrictChatMember） |
| 进群命中 confirmed | 全群封禁 | 全群封禁（这是系统确认过的自动行为） |
| 进群命中 pending | 禁言 + 通知主人确认 | 同左 |

- 「全群封禁按钮」= 主人确认流里的 inline button，以及 /spam 推送里的确认按钮。
- **除主人外无人可触发全群封禁**：群管理员 /spam 只是「上报」，全群封禁必须主人确认。

### 4.5 全群封禁回执（R6）

```
✅ 已全群封禁：成功 12 个群
⚠️ 失败 2 个群：
  - 群名A：bot 不是管理员
  - 群名B：Too Many Requests
```
成功群**不逐条列出**；失败群才列 `群名:原因`。

### 4.6 进群筛查细节（R7）

`handleNewChatMembers`：
1. 对每个新成员取三个候选指纹：`username`（@handle）、昵称（first+last）、名片显示名（若消息带 contact）。
2. 每个候选 → `matchFingerprint(type, norm_value)`。
3. 命中 `confirmed` → `banAllGroups`。
4. 命中 `pending` → `muteInCurrentGroup` + `ad_join_hits(open)` + 通知主人（带确认/忽略按钮）。
5. 无命中 → 不动作。

## 5. D1 表结构（全新，精简）

```sql
CREATE TABLE IF NOT EXISTS blacklist (
  user_id TEXT PRIMARY KEY, reason TEXT, note TEXT, by TEXT, created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS ad_samples (          -- AI 语义簇（自动合并）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  norm_hash TEXT UNIQUE,                         -- 归一化文本 hash
  sample_text TEXT,                              -- 代表文本（最短一条）
  signature TEXT,                                -- 关键词签名（排序拼接，聚类桶）
  variants TEXT DEFAULT '[]',                    -- 变体 JSON 数组（上限 8）
  count INTEGER DEFAULT 1,                       -- 合并计数
  embedding TEXT, dimension INTEGER,             -- 向量（懒加载）
  source TEXT, created_at INTEGER, updated_at INTEGER);

CREATE TABLE IF NOT EXISTS ad_fingerprints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT, value TEXT, norm_value TEXT,        -- type: username/name/card_name/keyword/bio/domain
  weight REAL DEFAULT 0.8,
  status TEXT DEFAULT 'pending',                 -- pending/confirmed/retired
  hit_count INTEGER DEFAULT 0, fp_count INTEGER DEFAULT 0,
  source TEXT, confirmed_by TEXT,
  created_at INTEGER, updated_at INTEGER,
  UNIQUE(type, norm_value));

CREATE TABLE IF NOT EXISTS ad_join_hits (        -- 进群/消息命中待确认记录
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT, chat_id TEXT,
  fingerprint_id INTEGER, fingerprint_value TEXT,
  action TEXT, status TEXT DEFAULT 'open',       -- open/confirmed/dismissed
  created_at INTEGER);

CREATE TABLE IF NOT EXISTS ad_user_whitelist (   -- 用户白名单（高于黑名单，完全豁免）
  user_id TEXT PRIMARY KEY, note TEXT, added_by TEXT, created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS ad_allowlist (        -- 误判放行库 /ignore
  dimension TEXT, value TEXT, hit_count INTEGER DEFAULT 0, created_at INTEGER,
  PRIMARY KEY(dimension, value));

CREATE TABLE IF NOT EXISTS ad_exempt_keywords (word TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS ad_domain_whitelist (domain TEXT PRIMARY KEY);

CREATE TABLE IF NOT EXISTS ad_ban_scope (        -- 全群封禁台账（只记封禁，不记禁言）
  user_id TEXT, chat_id TEXT, reason TEXT, created_at INTEGER,
  PRIMARY KEY(user_id, chat_id));
```

## 6. 阈值常量（初值，可 env 覆盖）

```
AD_SCORE_THRESHOLD = 7          # 评分定罪线
AD_OBSERVE_SCORE = 5            # 观察线（禁言兜底可调）
AD_AI_SIMILARITY = 0.78         # AI 语义定罪
AD_MERGE_SIMILARITY = 0.85      # 语义合并阈值（高于定罪线，宁可少合不误合）
AD_MERGE_CANDIDATE_LIMIT = 128  # 向量近邻比对数
AD_EMBEDDING_MODEL = '@cf/baai/bge-m3'
AD_EMBEDDING_DIM = 1024
BAN_ALL_GROUPS_CONCURRENCY = 3
```

## 7. 命令面（Beta v0.1）

- 治理：`/ban` `/spam` `/unban` `/check` `/pending`
- 白名单：`/add_whitelist` `/del_whitelist` `/whitelist_users`
- 放行/词库：`/ignore` `/allowlist` `/addword` `/delword` `/words` `/addsample`
- 统计/帮助：`/adstats` `/help`

## 8. 验收标准

1. 广告正文/名片广告被自动禁言（仅当前群），正常聊天不误杀。
2. 同一语义的多个变体只占一行样本（count 递增），不新增行。
3. 进群命中 pending 指纹 → 禁言 + 主人收到确认按钮；确认后同指纹再进群 → 全群封禁。
4. 群管理员 /ban 只封当前群；群管理员 /spam 不封，只推主人；主人确认后全群封禁。
5. 全群封禁回执只显示成功群数，失败才列原因。
6. 全部流程覆盖离线测试（node:sqlite mock）。
