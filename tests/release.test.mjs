import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseUrls, prepareRelease } from '../scripts/prepare-release.mjs';

test('release URLs preserve deployment subdirectories while clone metadata points to the repository', () => {
  const cases = [
    ['https://github.com/team/agent-gram', 'https://github.com/team/agent-gram.git', 'https://github.com/team/agent-gram'],
    ['https://github.com/team/agent-gram.git/', 'https://github.com/team/agent-gram.git', 'https://github.com/team/agent-gram'],
    ['https://github.com/team/tools/tree/main/agent-gram', 'https://github.com/team/tools.git', 'https://github.com/team/tools/tree/main/agent-gram'],
    ['https://gitlab.com/team/subteam/agent-gram', 'https://gitlab.com/team/subteam/agent-gram.git', 'https://gitlab.com/team/subteam/agent-gram'],
    ['https://gitlab.com/team/subteam/tools/-/tree/main/agent-gram', 'https://gitlab.com/team/subteam/tools.git', 'https://gitlab.com/team/subteam/tools/-/tree/main/agent-gram']
  ];
  for (const [input, cloneUrl, sourceUrl] of cases) {
    const result = releaseUrls(input);
    assert.equal(result.cloneUrl, cloneUrl);
    assert.equal(new URL(result.deployUrl).searchParams.get('url'), sourceUrl);
  }
});

test('incomplete and credential-bearing deployment targets are rejected', () => {
  for (const url of ['https://github.com', 'https://github.com/team', 'https://github.com/team/repo/issues/1', 'https://github.com/team/repo/tree/main', 'https://gitlab.com/team', 'https://gitlab.com/team/repo/-/tree/main', 'https://github.com:1234/team/repo', 'http://github.com/team/repo', 'https://user:secret@github.com/team/repo', 'https://github.com/team/repo?token=value', 'https://example.com/team/repo']) {
    assert.throws(() => releaseUrls(url), undefined, url);
  }
});

test('release preparation produces the official button and repeat runs replace it without duplicating .git', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentgram-release-'));
  try {
    await writeFile(join(directory, 'README.md'), '# Agent Gram\n<!-- deploy-button:start -->\npending\n<!-- deploy-button:end -->\n');
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'agent-gram' }));
    await prepareRelease('https://github.com/team/tools/tree/main/agent-gram', directory);
    const urls = await prepareRelease('https://github.com/team/agent-gram.git', directory);
    const readme = await readFile(join(directory, 'README.md'), 'utf8');
    assert.equal(readme.split('https://deploy.workers.cloudflare.com/button').length - 1, 1);
    assert.ok(readme.includes(urls.deployUrl));
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    assert.equal(pkg.repository.url, 'https://github.com/team/agent-gram.git');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('invalid README markers or package JSON do not partially rewrite release files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentgram-release-'));
  try {
    for (const [readme, pkg] of [['# No deploy marker\n', '{"name":"agent-gram"}'], ['<!-- deploy-button:start --><!-- deploy-button:end -->', '{invalid']]) {
      await writeFile(join(directory, 'README.md'), readme);
      await writeFile(join(directory, 'package.json'), pkg);
      await assert.rejects(() => prepareRelease('https://github.com/team/agent-gram', directory));
      assert.equal(await readFile(join(directory, 'README.md'), 'utf8'), readme);
      assert.equal(await readFile(join(directory, 'package.json'), 'utf8'), pkg);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
