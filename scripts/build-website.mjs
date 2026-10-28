import {build} from 'esbuild';
import {readFile,writeFile,copyFile} from 'node:fs/promises';
import {dirname} from 'node:path';
for (const name of ['locales.js','profile-locales.js','receiving-locales.js']) await copyFile('public/'+name,'website/'+name);
// The marketing site ships no chat UI, so its i18n module must not import the app-only
// chat translations (website/chat-locales.js is not part of the published file set).
const appI18n=await readFile('public/i18n.js','utf8');
const siteI18n=appI18n.replace("import {chatTranslations} from './chat-locales.js';\n",'').replace(',...chatTranslations}','}');
if(siteI18n===appI18n||siteI18n.includes('chatTranslations'))throw new Error('public/i18n.js changed shape: update the website i18n copy in scripts/build-website.mjs.');
await writeFile('website/i18n.js',siteI18n);
const result=await build({entryPoints:['website/src/network.mjs'],bundle:true,minify:true,format:'esm',target:['es2022'],outfile:'website/network.js',legalComments:'eof',metafile:true});
// Preserve every dependency's license alongside the self-hosted distribution.
const packages=new Map();
for(const input of Object.keys(result.metafile.inputs).filter(path=>path.startsWith('node_modules/'))){
 let directory=dirname(input);
 while(directory.startsWith('node_modules/')){
  try{const info=JSON.parse(await readFile(directory+'/package.json','utf8'));if(info.name){packages.set(directory,info);break;}}catch{}
  directory=dirname(directory);
 }
}
const notices=[];
for(const [directory,info] of packages){
 let license;for(const file of ['LICENSE','LICENSE.md','LICENSE.txt']){try{license=await readFile(directory+'/'+file,'utf8');break;}catch{}}
 if(!license&&info.name==='bezier-js')license=(await readFile(directory+'/src/bezier.js','utf8')).split('*/')[0]+'*/';
 if(!license)throw new Error('Missing bundled dependency license: '+info.name);
 notices.push(info.name+' '+info.version+'\n'+license);
}
await writeFile('website/assets/network-licenses.txt',notices.join('\n\n---------------------\n\n'));
console.log('Built self-hosted Force Graph visualization; retained '+packages.size+' dependency licenses.');
