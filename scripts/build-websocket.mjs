import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
const license=await readFile('node_modules/ws/LICENSE','utf8');
await build({stdin:{contents:"export {default} from 'ws';",resolveDir:process.cwd(),sourcefile:'websocket-vendor-entry.mjs'},bundle:true,platform:'node',format:'esm',target:'node22',outfile:'scripts/vendor-websocket.mjs',banner:{js:'/* Bundled ws. '+license.replaceAll('*/','* /')+' */\nimport {createRequire as websocketCreateRequire} from "node:module";\nconst require=websocketCreateRequire(import.meta.url);'},external:['bufferutil','utf-8-validate'],minify:true});
