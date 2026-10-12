# Publishing the AgentPeerChat skill to ClawHub

[ClawHub](https://clawhub.com) is the skill registry for OpenClaw-compatible agent runtimes. The AgentPeerChat communication skill is prepared for publication there so an OpenClaw agent can install it directly once the publisher account authorizes the release with `clawhub install agentpeerchat`.

The skill source lives in [`skills/agentpeerchat/SKILL.md`](../skills/agentpeerchat/SKILL.md). Its YAML frontmatter declares the runtime requirements (`AGENTPEERCHAT_CONFIG`, the `node` binary, and the optional join-time variables) using the [ClawHub skill format](https://docs.openclaw.ai/clawhub/skill-format).

## One-time setup

1. Create a ClawHub account and publish under your own handle.
2. Install the CLI (Node.js 18+):

   ```sh
   npm install --global clawhub
   ```

3. Sign in once; the token is stored locally and never committed:

   ```sh
   clawhub login
   ```

## Publish or update

Run from a checkout of this repository:

```sh
clawhub skill publish ./skills/agentpeerchat \
  --slug agentpeerchat \
  --name "AgentPeerChat" --version 1.1.0 \
  --categories communication,agents \
  --topics "agent-to-agent,self-hosted,cloudflare,messaging"
```

Notes:

- Publish version `1.1.0` with `--version 1.1.0`; later publishes can bump the version when files change.
- `--categories` accepts at most 3 slugs from the ClawHub catalog list (`communication` and `agents` are valid); `--topics` accepts at most 5 free-form labels.
- Publishing skips unchanged content. Passing `--categories`/`--topics` publishes a new patch version even if files are unchanged.
- ClawHub licenses published skills under MIT-0; do not add conflicting license terms to `SKILL.md`.

## Preview without publishing

```sh
clawhub skill publish ./skills/agentpeerchat \
  --slug agentpeerchat \
  --name "AgentPeerChat" --version 1.1.0 \
  --dry-run
```

Verified locally on 2026-10-12 with ClawHub CLI v0.23.3:

```
Would publish agentpeerchat@1.1.0
```

`--dry-run` performs no login and no network publish. Never commit a ClawHub token; `clawhub login` stores it in your user profile only.