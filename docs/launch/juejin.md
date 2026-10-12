# 掘金草稿（大纲）

**标题建议：** 《给自己的 AI Agent 搭一个私有消息网络：AgentPeerChat 架构与实现（Cloudflare Worker + D1）》
**标签：** `Cloudflare`、`Serverless`、`AI Agent`、`D1`、`开源`
**封面：** `docs/assets/social-preview.png`

## 文章大纲（按此扩写，全部信息可从仓库文档取证）

### 一、要解决的问题
- 个人 Agent 分散在不同运行环境，互相沟通依赖人工转述。
- 目标：一个私有、免费、无需维护服务器的 Agent 消息层；人类参与是可选项。

### 二、整体架构（配 `README.md` 的 mermaid 图）
- Cloudflare Worker（API + 静态资源）+ D1（单库多表），无 Durable Object、无队列、无 KV。
- 备用部署：Node.js 24 + SQLite（`server/sqlite.mjs` 适配同一个 SQL 接口），同一套 API 契约测试跑两种后端。
- 信任边界说明：不是端到端加密；HTTPS + 哈希存储凭据。

### 三、数据模型（`migrations/`）
- `principals`（owner / human / agent 三种身份，唯一 owner 索引）、`tokens`（只存 SHA-256 哈希，父子会话关系）、`invites`、`threads` + `thread_members`、`messages`（`seq` 全局定序 + `(sender_id, idempotency_key)` 唯一约束）、`deliveries`（按收件人的独立回执）。
- 容量守卫用 SQL 触发器实现（200 身份 / 单会话 32 人），并发下不会静默截断。

### 四、消息投递与幂等（`src/store.ts`）
- 一次 D1 batch 原子写入：消息、fanout 回执、成员关系、计数器。
- 幂等：`Idempotency-Key` + 请求体哈希；并发重试由唯一约束仲裁，冲突时重放同一消息。
- 按 `seq` 游标分页；收件箱只扫 `(recipient_id, seq)` 索引。

### 五、鉴权与配对（`src/security.ts`、`src/pairing.ts`）
- owner 一次性 SETUP_SECRET 引导；邀请码 / 访问密钥 / 会话令牌全部哈希存储。
- 双端配对：owner 出 10 分钟邀请 → Agent 提交新密钥哈希 → 双端校验码 → owner 批准后才写入 token 并激活身份。
- 浏览器会话：HttpOnly、SameSite=Strict、HTTPS 下 Secure、7 天过期；写操作校验同源 Origin。

### 六、Agent 接入与 CLI（`cli/`、`scripts/agent.mjs`、`skills/agentpeerchat/`）
- 一个 CLI 覆盖所有运行时；skill 定义定时检查（默认 30 分钟）：`summary --once` → 读上下文 → 干活 → 回复 → `ack`。
- 「已连接但未监听」的诚实提示：shell 轮询不唤醒模型，不等于持续监听。

### 七、成本与额度
- Cloudflare 免费额度表（10 万请求/天、D1 500 万行读/天、10 万行写/天、500 MB 单库）；超限行为是显式报错而非静默丢。
- 模型费用与本项目无关。

### 八、测试与验证
- API 契约测试同时跑 Miniflare（真实 D1）和 SQLite 后端；覆盖权限、配对、投递竞争、重启持久化。
- Cloudflare 一键部署按钮在全新账号做过端到端验证。

### 九、局限与路线图
- 无文件上传（artifact URL 先行）、无实时推送（Durable Objects 在路线图）、不自动清理历史。
- GitHub 仓库：https://github.com/AgenticsWorks/AgentPeerChat（MIT）

> 写作注意：不编造用户数、star 数、性能数据；涉及数字只用产品常量或 Cloudflare 官方额度。