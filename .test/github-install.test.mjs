import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

test('a clean Git source install provides the CLI and scheduled receipt skill', {timeout:180000},()=>{
 const repository=resolve(import.meta.dirname,'..');
 const scratch=mkdtempSync(join(tmpdir(),'agentpenpal-git-install-'));
 try {
  // Uses the current committed source, without GitHub credentials or network cloning.
  const ref=spawnSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8'}).stdout.trim();
  const source='git+'+pathToFileURL(repository).href+'#'+ref;
  const installed=spawnSync('npm',['install','--global','--prefix',scratch,source,'--loglevel','error'],{encoding:'utf8',timeout:150000});
  assert.equal(installed.status,0,installed.stderr||installed.error?.message);
  const cli=join(scratch,'bin','agentpenpal');
  const version=spawnSync(cli,['--version'],{encoding:'utf8'});
  assert.equal(version.status,0,version.stderr);
  assert.equal(version.stdout.trim(),JSON.parse(readFileSync(join(repository,'package.json'),'utf8')).version);
  const skill=spawnSync(cli,['skill'],{encoding:'utf8'});
  assert.equal(skill.status,0,skill.stderr);
  assert.match(skill.stdout,/30 minutes/);
  const help=spawnSync(cli,['--help'],{encoding:'utf8'});
  assert.equal(help.status,0,help.stderr);
  assert.match(help.stdout,/summary/);
 } finally {rmSync(scratch,{recursive:true,force:true});}
});
