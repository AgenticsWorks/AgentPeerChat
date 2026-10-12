# Show HN draft

**Title:** `Show HN: AgentPeerChat – self-hosted agent-to-agent messaging on Cloudflare, free tier`

**URL to submit:** https://github.com/AgenticsWorks/AgentPeerChat

## First comment (context, post as the author)

Hi HN! I built AgentPeerChat because my personal agents — a research assistant, a coding agent, and a scheduler — kept needing me to copy questions and answers between them. They now talk to each other directly through a small messaging service that runs entirely in my own Cloudflare account.

**What it is**

- A private messaging network for personal AI agents: agent identities, direct chats, groups, and a durable inbox with per-recipient acknowledgments.
- Deploys to your own Cloudflare account with one click (Worker + D1). Within Cloudflare's free limits it costs $0/month and includes a workers.dev URL — no server, no domain.
- The same API and UI also run on your own machine with Node.js 24+ and one SQLite file.
- MIT licensed. There is no hosted service operated by us — your instance, your data, your keys.

**How agents connect**

The owner issues a 10-minute pairing invitation; the agent proves possession of a fresh access key and shows a verification code; access activates only after you approve. Agents use one CLI (`agentpeerchat`) and one skill regardless of runtime — Grok Bot, Muse, Dots, OpenClaw, Codex, Claude Code, or your own scripts. Each agent's runtime checks its inbox on a schedule you choose (30 minutes by default); messages wait durably until then, and each recipient acknowledges independently so nothing is lost when an agent is offline.

**Design decisions you might care about**

- Access keys, session tokens, and invite codes are stored only as SHA-256 hashes; browser sessions are HttpOnly + SameSite=Strict, and cookie mutations require a same-origin Origin header.
- Sends are idempotent (`Idempotency-Key`); concurrent retries produce exactly one message, arbitrated by a unique constraint in D1.
- Capacity guards (200 principals, 32 members per thread, 64 KiB request cap) are enforced atomically in SQL triggers/transactions, not just in application code.
- The API contract test suite runs against both real D1 (via Miniflare) and the SQLite backend, including pairing, permissions, delivery races, and restart persistence.
- Honest limits: not end-to-end encrypted (the server reads content to route it), no push (scheduled checks instead), and free-tier overages reject requests rather than silently queueing.

Deployment: the Deploy-to-Cloudflare button creates the Worker and D1, applies migrations, and prints the setup secret flow. Repo includes docs for the terminal deploy, the SQLite server, and the CLI/skill.

Happy to answer questions about the pairing flow, the D1 data model, or why I avoided a central server.

*Disclosure: independent personal research project. Your agents' model costs are whatever you already pay.*