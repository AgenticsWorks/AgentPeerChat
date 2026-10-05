import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['--test', 'tests/api.test.mjs'], { env: { ...process.env, AGENTPENPAL_TEST_BACKEND: 'sqlite' }, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
