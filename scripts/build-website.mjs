import {build} from 'esbuild';
import {readFile,writeFile,copyFile} from 'node:fs/promises';
import {dirname} from 'node:path';
for (const name of ['i18n.js','locales.js']) await copyFile('public/'+name,'website/'+name);
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
