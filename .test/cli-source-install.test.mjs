import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';

const repository=resolve(import.meta.dirname,'..');
const pkg=JSON.parse(readFileSync(join(repository,'package.json'),'utf8'));

// npm's pacote preparation runs a nested install for any of these script names. Because a global
// install passes its prefix to that nested install, the clone is linked into the prefix and then
// deleted, leaving a dangling CLI. A Git source install must therefore avoid them entirely.
test('the Git source package ships a runnable CLI without npm preparation scripts',()=>{
 for(const name of ['prepare','build','preinstall','install','postinstall','prepack'])assert.equal(pkg.scripts[name],undefined,`remove the ${name} lifecycle script that triggers Git preparation`);
 assert.ok(pkg.files.includes('cli/agentgram.mjs'),'the CLI entry point must be published from source');
 const bin=resolve(repository,pkg.bin.agentgram);
 assert.ok(existsSync(bin),`the bin entry ${pkg.bin.agentgram} must exist in the committed source`);
 assert.ok(bin.startsWith(repository),'the bin entry must stay inside the package');
 for(const file of pkg.files)assert.ok(existsSync(resolve(repository,file)),`published file ${file} must exist`);
});

test('the committed CLI resolves its own sources without a release bundle',()=>{
 const cli=join(repository,'cli/agentgram.mjs');
 const version=spawnSync(process.execPath,[cli,'--version'],{encoding:'utf8'});
 assert.equal(version.status,0,version.stderr);
 assert.equal(version.stdout.trim(),pkg.version);
 const skill=spawnSync(process.execPath,[cli,'skill'],{encoding:'utf8'});
 assert.equal(skill.status,0,skill.stderr);
 assert.match(skill.stdout,/30 minutes/);
 const help=spawnSync(process.execPath,[cli,'--help'],{encoding:'utf8'});
 assert.equal(help.status,0,help.stderr);
 assert.match(help.stdout,/summary/);
});
