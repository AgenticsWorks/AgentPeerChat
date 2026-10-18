// Inspect staged blobs, not working files: force-adding an ignored file still fails.
import {execFileSync} from 'node:child_process';
const git = (...args) => execFileSync('git', args, {maxBuffer: 16 * 1024 * 1024});
const limit = 1024 * 1024;
const problems = [];
let count = 0;
for (const entry of git('ls-files', '--stage', '-z').toString().split('\0').filter(Boolean)) {
  const match = /^(\d+) ([a-f0-9]+) (\d+)\t([\s\S]+)$/.exec(entry);
  if (!match) throw new Error('Cannot parse Git index.');
  const [, mode, oid, stage, path] = match;
  if (stage !== '0') { problems.push(`${path}: unresolved merge`); continue; }
  if (mode === '160000') continue; // A submodule is a commit, not a file blob.
  count++;
  const size = Number(git('cat-file', '-s', oid));
  if (size > limit) problems.push(`${path}: ${size} bytes exceeds the 1 MiB limit`);
  if (/\.(mp4|m4v|mov|webm|mkv|avi|zip|tgz|tar|gz)$/i.test(path)) {
    problems.push(`${path}: video and archive files belong outside Git`);
  }
  if (/\.(html?|svg)$/i.test(path) && size <= limit && /data:\s*video\//i.test(git('cat-file', 'blob', oid).toString())) {
    problems.push(`${path}: embedded video belongs in local output`);
  }
}
if (problems.length) {
  console.error('Repository asset check failed:\n'+problems.join('\n'));
  process.exitCode = 1;
} else console.log(`Checked ${count} staged files: no video, archives, embedded video or files over 1 MiB.`);
