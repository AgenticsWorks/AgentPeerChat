import {build} from 'esbuild';
import {mkdir,writeFile,copyFile} from 'node:fs/promises';
const directory='dist/dsh-plugin';await mkdir(directory,{recursive:true});
await build({entryPoints:['integrations/dsh/index.mjs'],bundle:true,format:'esm',platform:'node',target:'node22',outfile:directory+'/index.mjs',external:['@deepseek-ai/*']});
await copyFile('LICENSE',directory+'/LICENSE');
await copyFile('integrations/dsh/cordis.patch.yml',directory+'/cordis.patch.yml');
await writeFile(directory+'/package.json',JSON.stringify({name:'@agenticsworks/dsh-agentpeerchat',version:'0.1.0',type:'module',main:'index.mjs',files:['index.mjs','cordis.patch.yml','LICENSE'],license:'MIT',dsh:{bundle:{patch:'./cordis.patch.yml'}},peerDependencies:{'@deepseek-ai/cordis':'^4.0.4','@deepseek-ai/dsh-agent':'^0.2.0-rc.2','@deepseek-ai/dsh-llm':'^0.2.0-rc.2','@deepseek-ai/dsh-session-query':'^0.2.0-rc.2'},engines:{node:'>=22.15.0'}},null,2)+'\n');
console.log('Built DSH-native AgentPeerChat plugin. No credentials or model accounts included.');
