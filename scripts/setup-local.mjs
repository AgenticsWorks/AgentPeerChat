import { randomBytes } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
try {
  await readFile('.dev.vars');
  console.log('.dev.vars already exists. Existing setup secret preserved.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const secret = randomBytes(32).toString('hex');
  await writeFile('.dev.vars', `SETUP_SECRET=${secret}\n`, { mode: 0o600, flag: 'wx' });
  console.log('Created .dev.vars with a random setup secret. Read it locally and enter it on the first-run page.');
}
