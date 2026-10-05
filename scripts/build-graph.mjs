import {build} from 'esbuild';
import {copyFile} from 'node:fs/promises';
await build({entryPoints:['public/src/conversation-graph.mjs'],bundle:true,minify:true,format:'esm',target:['es2022'],outfile:'public/conversation-graph.js',legalComments:'eof'});
await copyFile('website/assets/network-licenses.txt','public/graph-licenses.txt');
console.log('Built Force Graph conversation map.');
