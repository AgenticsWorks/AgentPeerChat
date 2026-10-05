import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function releaseUrls(raw) {
  const repo = new URL(raw);
  if (repo.protocol !== 'https:' || !['github.com', 'gitlab.com'].includes(repo.hostname) || repo.port || repo.username || repo.password || repo.search || repo.hash)
    throw new Error('Provide a public HTTPS GitHub or GitLab repository URL without credentials, ports, or query parameters.');
  const parts = repo.pathname.replace(/\/$/, '').split('/').slice(1);
  let root;
  if (repo.hostname === 'github.com') {
    if (parts.length < 2 || (parts.length > 2 && (parts[2] !== 'tree' || parts.length < 5))) throw new Error('Use a repository URL or its /tree/BRANCH/SUBDIRECTORY URL.');
    root = parts.slice(0, 2);
  } else {
    const tree = parts.indexOf('-');
    if (tree !== -1 && (tree < 2 || parts[tree + 1] !== 'tree' || parts.length < tree + 4)) throw new Error('Use a repository URL or its /-/tree/BRANCH/SUBDIRECTORY URL.');
    root = tree === -1 ? parts : parts.slice(0, tree);
    if (root.length < 2) throw new Error('A repository namespace and name are required.');
  }
  if (parts.some(p => !p || /%2f|%5c/i.test(p))) throw new Error('Repository path must contain complete path segments.');
  root[root.length - 1] = root.at(-1).replace(/\.git$/, '');
  if (!root.at(-1)) throw new Error('A repository name is required.');
  const cloneUrl = `${repo.origin}/${root.join('/')}.git`;
  const sourceUrl = parts.length === root.length ? cloneUrl.replace(/\.git$/, '') : repo.href.replace(/\/$/, '');
  const deployUrl = `https://deploy.workers.cloudflare.com/?${new URLSearchParams({ url: sourceUrl })}`;
  return { sourceUrl, cloneUrl, deployUrl };
}

export async function prepareRelease(raw, directory = process.cwd()) {
  const urls = releaseUrls(raw);
  // Validate all input files before changing either one.
  const readme = await readFile(join(directory, 'README.md'), 'utf8');
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  const marker = /<!-- deploy-button:start -->[\s\S]*?<!-- deploy-button:end -->/g;
  if ([...readme.matchAll(marker)].length !== 1) throw new Error('README must contain exactly one deploy-button marker block.');
  const button = `[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](${urls.deployUrl})`;
  pkg.repository = { type: 'git', url: urls.cloneUrl };
  await writeFile(join(directory, 'README.md'), readme.replace(marker, `<!-- deploy-button:start -->\n${button}\n<!-- deploy-button:end -->`));
  await writeFile(join(directory, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  return urls;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (!process.argv[2]) { console.error('Usage: npm run prepare:release -- https://github.com/OWNER/agentpenpal'); process.exitCode = 1; }
  else {
    const urls = await prepareRelease(process.argv[2]);
    console.log(`Deploy button configured for ${urls.sourceUrl}. Publish the repository, then verify the flow using your own Cloudflare account.`);
  }
}
