import { readFile, writeFile } from 'node:fs/promises';
const raw = process.argv[2];
if (!raw) { console.error('Usage: npm run prepare:release -- https://github.com/OWNER/agent-gram'); process.exit(1); }
const repo = new URL(raw);
if (repo.protocol !== 'https:' || !['github.com', 'gitlab.com'].includes(repo.hostname) || repo.username || repo.password || repo.search || repo.hash)
  throw new Error('Provide a public HTTPS GitHub or GitLab repository URL without credentials or query parameters.');
const deployUrl = `https://deploy.workers.cloudflare.com/?${new URLSearchParams({ url: repo.href.replace(/\/$/, '') })}`;
const button = `[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](${deployUrl})`;
const readme = await readFile('README.md', 'utf8');
await writeFile('README.md', readme.replace(/<!-- deploy-button:start -->[\s\S]*?<!-- deploy-button:end -->/,
  `<!-- deploy-button:start -->\n${button}\n<!-- deploy-button:end -->`));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
pkg.repository = { type: 'git', url: repo.href.replace(/\/$/, '') + '.git' };
await writeFile('package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log(`Deploy button configured for ${repo.href}. Publish the repository, then verify the flow using your own Cloudflare account.`);
