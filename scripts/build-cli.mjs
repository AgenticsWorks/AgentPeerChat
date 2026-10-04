import {mkdir,readFile,writeFile,copyFile,chmod} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
// Resolve the repository root from this file so preparation works from any working directory.
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const directory=join(root,'dist','cli');await mkdir(directory,{recursive:true});
const entries=[['cli/agentgram.mjs','agentgram'],['scripts/agent.mjs','client'],['scripts/install.mjs','install'],['scripts/pairing-client.mjs','pairing-client']];
// `prepare` runs during a Git source install where devDependencies (including esbuild) are absent.
// Every CLI entry point imports only Node built-ins, so `--copy` packages the sources verbatim and
// the release bundle keeps esbuild for the published tarball.
const copyOnly=process.argv.includes('--copy');
if(copyOnly){
 for(const [source,name] of entries)await copyFile(join(root,source),join(directory,name+'.mjs'));
}else{
 const {build}=await import('esbuild');
 for(const [source,name] of entries){
  await build({entryPoints:[join(root,source)],bundle:true,format:'esm',platform:'node',target:'node22',outfile:join(directory,name+'.mjs')});
 }
}
await copyFile(join(root,'skills/agentgram/SKILL.md'),join(directory,'SKILL.md'));await copyFile(join(root,'LICENSE'),join(directory,'LICENSE'));await chmod(join(directory,'agentgram.mjs'),0o755);
const version=JSON.parse(await readFile(join(root,'package.json'),'utf8')).version;
await writeFile(join(directory,'package.json'),JSON.stringify({name:'@agenticsworks/agentgram',version,type:'module',description:'A single CLI and skill for agent-to-agent communication.',license:'MIT',engines:{node:'>=22'},bin:{agentgram:'./agentgram.mjs'},files:['*.mjs','SKILL.md','LICENSE'],repository:{type:'git',url:'https://github.com/AgenticsWorks/Agentgram.git'}},null,2)+'\n');
if(copyOnly){console.log(`Prepared Agentgram CLI ${version} in dist/cli from source; no build dependencies required.`);}
else{
 const result=spawnSync('npm',['pack','--json','--pack-destination',join(root,'dist')],{cwd:directory,encoding:'utf8'});if(result.status!==0)throw new Error(result.stderr);
 const packed=JSON.parse(result.stdout)[0];await copyFile(join(root,'dist',packed.filename),join(root,'dist','agentgram-cli.tgz'));await copyFile(join(root,'dist','agentgram-cli.tgz'),join(root,'public','agentgram-cli.tgz'));await copyFile(join(root,'skills/agentgram/SKILL.md'),join(root,'public','agentgram-skill.md'));
 console.log(`Built Agentgram CLI ${version}: dist/agentgram-cli.tgz (includes the skill; no runtime npm dependencies).`);
}
