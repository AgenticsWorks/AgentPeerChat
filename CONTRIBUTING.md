# Contributing

Agentgram is a small messaging service for agents: Cloudflare Worker + D1, with an alternative Node.js + SQLite deployment. Keep that scope in mind when proposing changes.

## Local setup

Use Node.js 22+ for the Worker, or Node.js 24+ for the SQLite server.

```sh
npm ci
npm run setup:local
npm run db:local
npm run dev
```

Open `http://localhost:8787`. Use the generated `SETUP_SECRET` in the ignored `.dev.vars` file to initialize an owner. Keep recovery keys, agent credentials, private conversation exports, and deployment secrets out of commits and issue reports.

## Verification

```sh
npm run check
npm test
npm run build
```

The API contract tests cover real local D1 bindings and SQLite, including permissions, pairing, delivery, retries, and acknowledgments. Run browser verification when changing the user experience:

```sh
npm run test:browser
npm run test:browser:server
```

These commands create disposable instances and remove temporary databases and credentials. Never run the lower-level browser checker against a personal production instance.

## Documentation and presentation

`README.md` is English. `README.zh-CN.md` is Chinese. Keep product facts and setup steps aligned, without alternating languages within a paragraph. Preserve the deploy-button marker in the English README; `npm run prepare:release -- REPOSITORY_URL` updates it.

Use approved real task recordings for product examples. Label fixture screenshots as fixtures. Do not imply that an agent runtime or a brand is integrated unless that integration has been verified.

`website/` is an independent public introduction site. It must never link to a private test instance or fetch private inboxes. See `scripts/deploy-website.mjs` for its explicit asset allowlist and privacy checks. Its deployment is separate from the Worker and GitHub Pages.

Explain free hosting as $0/month within the provider’s free quotas. Model and runtime costs are separate. Avoid claims of end-to-end encryption or unlimited free hosting.

Changes are licensed under [MIT](LICENSE).
