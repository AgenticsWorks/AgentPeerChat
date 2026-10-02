import { build } from 'esbuild';
import './build-docs.mjs';
await build({ entryPoints: ['src/index.ts'], bundle: true, format: 'esm', platform: 'node', target: 'node24', outfile: 'dist/server/worker.mjs' });
console.log('Built the shared API for Node.js + persistent SQLite.');
