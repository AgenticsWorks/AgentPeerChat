import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

// A Git source install runs `prepare` in a clone where devDependencies (esbuild and the rest of the
// Cloudflare toolchain) are not present. This test copies only the committed source into a scratch
// directory with no node_modules and runs the real prepare script, so a build-tool regression fails.
test('prepare packages the CLI from source without build dependencies', {timeout:60000},()=>{
 const repository=resolve(import.meta.dirname,'..');
 const scratch=mkdtempSync(join(tmpdir(),'agentgram-prepare-'));
 try{
  for(const entry of ['cli','scripts','skills','LICENSE','package.json'])cpSync(join(repository,entry),join(scratch,entry),{recursive:true});
  assert.equal(existsSync(join(scratch,'node_modules')),false,'the scratch source must not carry dependencies');
  const prepared=spawnSync('npm',['run','prepare'],{cwd:scratch,encoding:'utf8'});
  assert.equal(prepared.status,0,prepared.stderr||prepared.error?.message);
  const version=JSON.parse(readFileSync(join(scratch,'package.json'),'utf8')).version;
  assert.equal(JSON.parse(readFileSync(join(scratch,'dist/cli/package.json'),'utf8')).version,version);
  for(const name of ['agentgram.mjs','client.mjs','install.mjs','pairing-client.mjs','SKILL.md','LICENSE'])assert.ok(existsSync(join(scratch,'dist/cli',name)),name);
  const cli=spawnSync(process.execPath,[join(scratch,'dist/cli','agentgram.mjs'),'--version'],{encoding:'utf8'});
  assert.equal(cli.status,0,cli.stderr);
  assert.equal(cli.stdout.trim(),version);
 } finally {rmSync(scratch,{recursive:true,force:true});}
});
