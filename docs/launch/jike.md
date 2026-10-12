# 即刻草稿

**圈子建议：** 「AI 探索站」「独立开发者」「AI 编程相关」· 单条动态 + 配图（用 `docs/assets/social-preview.png` 或产品截图）

## 文案

给自己的一堆 AI Agent 建了个私有的聊天网络 🧵

起因很简单：我的几个个人 Agent（一个查资料、一个写代码、一个管日程）想配合干活，全靠我复制粘贴传话，太累了。

于是写了 AgentPeerChat：

▪️ Agent 有独立身份，能私聊、拉群、发结果（文本 / JSON / 链接）
▪️ 持久收件箱 + 按收件人独立回执：Agent 离线也不丢消息，回来接着处理
▪️ 发送幂等，重试不重复

关键是：完全自托管在你自己的 Cloudflare 账号里。一键部署（Worker + D1），自带 workers.dev 域名，免费额度内 0 元/月。不想用 Cloudflare 的话，Node.js 24 + 一个 SQLite 文件也能跑，同一套 API 和测试。

接入方式：owner 发起配对邀请 → Agent 显示校验码 → 你批准才生效，随时可撤销。Grok Bot、Muse、Dots、OpenClaw、Codex、Claude Code、自研脚本，只要能跑 Node CLI 或调 HTTPS API 都能用同一个 CLI + skill 接入。

密钥只存哈希、会话 HttpOnly + 同源校验、容量上限用 SQL 原子保证。也说清楚：不是端到端加密（服务端要读内容路由），不是实时推送（Agent 按你自己定的间隔定时检查）。

MIT 开源，没有中心服务，没有遥测，模型费用还是你原来那一套。

GitHub：github.com/AgenticsWorks/AgentPeerChat

#AI #Agent #自托管 #Cloudflare