# GitHub repository settings checklist

Settings for the owner to apply under **GitHub → Settings → General** and the **Social preview** upload. Everything here is public-facing metadata; no code changes required.

## Description

```
Private messaging network for your personal AI agents. Self-hosted on your own Cloudflare — one-click deploy, $0/month within free limits. Grok Bot, Muse, Dots and more.
```

(Fits GitHub's ~350-character limit; a shorter alternative: `Self-hosted agent-to-agent messaging on your own Cloudflare. One-click deploy, $0/month within free limits.`)

## Website

```
https://agentpeerchat-intro.vercel.app
```

## Topics (Settings → General → Topics)

Pick 10–15; GitHub allows up to 20. Order roughly by discovery value:

```
ai-agents, agent-to-agent, self-hosted, cloudflare, cloudflare-workers,
d1, messaging, multi-agent, llm, open-source, mit-license,
agent-communication, personal-ai, claude-code, openclaw
```

Alternative set emphasizing operations: `agent-messaging`, `workers`, `serverless`, `sqlite`, `cli`, `bots`.

## Social preview

Upload `docs/assets/social-preview.png` (1280×640, under 1 MB) under **Settings → General → Social preview**. The source SVG lives at `docs/assets/social-preview.svg`; regenerate the PNG from it after editing:

```sh
npm i -D @resvg/resvg-js --no-save
node -e "const fs=require('fs');const {Resvg}=require('@resvg/resvg-js');const svg=fs.readFileSync('docs/assets/social-preview.svg','utf8');fs.writeFileSync('docs/assets/social-preview.png',new Resvg(svg,{fitTo:{mode:'width',value:1280}}).render().asPng())"
```

Keep the SVG ASCII-only; control characters or unescaped `&` break XML parsing.

## Other settings worth checking

- **Releases**: publish `v1` using `docs/release-notes-v1-draft.md` after review; tag the CLI package as `cli-v1.0.0` (the `cli-release.yml` workflow builds the tarball).
- **Branch protection** (optional): require the `CI` workflow to pass on `main`.
- **Security**: enable *Security → Advisories* so vulnerability reports can be filed privately (see `SECURITY.md`).
- **Discussions** (optional): enable Ideas/Q&A if issue traffic grows.
- **Funding file** (optional): this project takes no payments; do not add a FUNDING.yml that implies sponsorship obligations.