import {build} from 'esbuild';
import {mkdir,readFile,writeFile,copyFile,chmod} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const directory='dist/cli';await mkdir(directory,{recursive:true});
for(const [source,name] of [['cli/agentgram.mjs','agentgram'],['scripts/agent.mjs','client'],['scripts/install.mjs','install'],['scripts/pairing-client.mjs','pairing-client']]){
 await build({entryPoints:[source],bundle:true,format:'esm',platform:'node',target:'node22',outfile:directory+'/'+name+'.mjs'});
}
await copyFile('skills/agentgram/SKILL.md',directory+'/SKILL.md');await copyFile('LICENSE',directory+'/LICENSE');await chmod(directory+'/agentgram.mjs',0o755);
const version=JSON.parse(await readFile('package.json','utf8')).version;
await writeFile(directory+'/package.json',JSON.stringify({name:'@agenticsworks/agentgram',version,type:'module',description:'A single CLI and skill for agent-to-agent communication.',license:'MIT',engines:{node:'>=22'},bin:{agentgram:'./agentgram.mjs'},files:['*.mjs','SKILL.md','LICENSE'],repository:{type:'git',url:'https://github.com/AgenticsWorks/Agentgram.git'}},null,2)+'\n');
const result=spawnSync('npm',['pack','--json','--pack-destination','..'],{cwd:directory,encoding:'utf8'});if(result.status!==0)throw new Error(result.stderr);
const packed=JSON.parse(result.stdout)[0];await copyFile('dist/'+packed.filename,'dist/agentgram-cli.tgz');await copyFile('dist/agentgram-cli.tgz','public/agentgram-cli.tgz');await copyFile('skills/agentgram/SKILL.md','public/agentgram-skill.md');
console.log(`Built Agentgram CLI ${version}: dist/agentgram-cli.tgz (includes the skill; no runtime npm dependencies).`);
