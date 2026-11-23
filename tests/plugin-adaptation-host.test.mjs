import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { handleRequest } from '../runtime/plugin-host.mjs';
import { createBrowserMarketFixture } from './plugin-host.test.mjs';

const project=path.resolve(import.meta.dirname,'..');
const outputRoot=path.join(project,'outputs','plugin-adaptation');
await mkdir(outputRoot,{recursive:true});
const out=await mkdtemp(path.join(outputRoot,'host-')), dataDir=path.join(out,'data'), pkg=path.join(out,'original-package');
await mkdir(pkg,{recursive:true});
const checks=[];
const originalFiles={
 'package.json':JSON.stringify({name:'fixture-cordis-echo',version:'1.2.3',license:'MIT',main:'index.js'}),
 'index.js':'// Synthetic upstream runtime. No code may execute during preparation or installation.\nexport const echo = text => text;\n',
 'LICENSE':'MIT synthetic fixture license\nCopyright 2026 fixture\n'
};
for(const [name,value]of Object.entries(originalFiles))await writeFile(path.join(pkg,name),value);
const raw=(action,args={})=>handleRequest({action,dataDir,...args});
const ok=async(action,args={})=>{const r=await raw(action,args);assert.equal(r.ok,true,JSON.stringify(r));return r;};
const rejects=async(action,args,code)=>{const r=await raw(action,args);assert.equal(r.ok,false,JSON.stringify(r));assert.equal(r.error.code,code,JSON.stringify(r));};
const check=name=>{checks.push(name);console.log('PASS '+name);};
let success=false;
try {
 const inspection=(await ok('package.inspect',{path:pkg})).inspection;
 assert.equal(inspection.classification.supported,false);
 await rejects('package.install',{planId:inspection.planId},'UNSUPPORTED_PLUGIN');
 const identity={adaptationId:'adapt-'+'1'.repeat(32),botId:'fixture-bot'};
 const prepared=(await ok('adaptation.prepare',{...identity,planId:inspection.planId,workspace:path.join(out,'not-allowed')})).adaptation;
 const workspace=prepared.workspace,candidate=path.join(workspace,'adapted');
 assert(workspace.startsWith(path.join(dataDir,'plugins','adaptation-workspaces')));
 for(const [name,value]of Object.entries(originalFiles)){
  assert.equal(await readFile(path.join(workspace,'original',name),'utf8'),value);
  assert.equal(await readFile(path.join(candidate,'upstream',name),'utf8'),value);
 }
 assert.match(await readFile(path.join(workspace,'TASK.md'),'utf8'),/覆盖报告是作者声明/);
 const again=(await ok('adaptation.prepare',{...identity,planId:inspection.planId})).adaptation;
 assert.equal(again.workspace,workspace);
 check('Exact original package/license/source snapshot copied; original remains un-installable; preparation is idempotent');
 const bound={...identity,runId:'run-fixture-adapter'};
 await ok('adaptation.bind',bound);
 await rejects('adaptation.bind',{...identity,runId:'run-other'},'ADAPTATION_SCOPE');
 await rejects('adaptation.inspect',{...bound,botId:'other-bot'},'ADAPTATION_SCOPE');
 await rejects('adaptation.inspect',{...bound,runId:'run-other'},'ADAPTATION_SCOPE');
 check('Bot and native Work bindings reject cross-task reuse');

 const manifest={...prepared.adapter,type:'module',dsh:{bundle:{patch:'bundle.yml'}}};
 const server='// A valid MCP implementation would be tested in the sandbox; never execute at install.\nthrow Error("INSTALL_EXECUTION_IS_FORBIDDEN");\n';
 const bundle=command=>JSON.stringify([{insert:[{name:'@deepseek-ai/dsh-mcp-client',config:{serverName:'adapted_echo',transport:'stdio',command,args:['server.mjs']}}]}]);
 await writeFile(path.join(candidate,'package.json'),JSON.stringify(manifest));
 await writeFile(path.join(candidate,'bundle.yml'),bundle('node'));
 await writeFile(path.join(candidate,'server.mjs'),server);
 const coverage={status:'incomplete',sourceFingerprint:prepared.original.fingerprint,capabilities:[{name:'Echo',implementation:['server.mjs'],testEvidence:[]}],missingCapabilities:['Not implemented yet']};
 await writeFile(path.join(candidate,'ADAPTATION.json'),JSON.stringify(coverage));
 await rejects('adaptation.inspect',bound,'ADAPTATION_INCOMPLETE');
 coverage.status='ready';coverage.missingCapabilities=[];
 await writeFile(path.join(candidate,'ADAPTATION.json'),JSON.stringify(coverage));

 await writeFile(path.join(candidate,'bundle.yml'),bundle('cmd.exe'));
 await rejects('adaptation.inspect',bound,'ADAPTATION_EXECUTION_SCOPE');
 await writeFile(path.join(candidate,'bundle.yml'),bundle('node'));
 await writeFile(path.join(candidate,'upstream','LICENSE'),'tampered');
 await rejects('adaptation.inspect',bound,'ADAPTATION_PROVENANCE');
 await writeFile(path.join(candidate,'upstream','LICENSE'),originalFiles.LICENSE);
 check('Unresolved capability reports, host commands and altered upstream/license files are rejected');

 const verified=(await ok('adaptation.inspect',bound)).inspection;
 await rejects('package.install',{planId:verified.planId},'ADAPTATION_SCOPE');
 await rejects('adaptation.install',{...bound,planId:inspection.planId},'ADAPTATION_SCOPE');
 await writeFile(path.join(candidate,'server.mjs'),server+'// changed after inspection\n');
 await rejects('adaptation.install',{...bound,planId:verified.planId},'PACKAGE_CHANGED');
 const refreshed=(await ok('adaptation.inspect',bound)).inspection;
 await rejects('adaptation.install',{...bound,planId:verified.planId},'ADAPTATION_SCOPE');
 const installed=await ok('adaptation.install',{...bound,planId:refreshed.planId});
 assert.equal(installed.plugin.enabled,false);
 assert.equal(installed.plugin.adaptation.functionalVerification,'not-verified');
 assert.equal(installed.plugin.adaptation.capabilityReport,'author-declared');
 assert.match(installed.verificationScope,/not been verified/);
 const repeat=await ok('adaptation.install',{...bound,planId:refreshed.planId});
 assert.equal(repeat.plugin.id,installed.plugin.id);
 assert.equal((await ok('plugin.list')).plugins.length,1);
 assert.equal((await ok('tools.list')).tools.length,0);
 check('Plans are task-bound and invalidated by changes; exact adapter installs disabled without executing its code');
 check('Installation does not upgrade self-authored coverage into functional verification; retries do not duplicate installation');

 const skillManifest={...prepared.adapter};
 await writeFile(path.join(candidate,'package.json'),JSON.stringify(skillManifest));
 await writeFile(path.join(candidate,'SKILL.md'),'---\nname: synthetic-description\ndescription: Only describes the original capability.\n---\nThis is not an implementation.\n');
 await rejects('adaptation.inspect',bound,'ADAPTATION_INCOMPLETE');
 check('Skill-only description cannot replace the original runtime capability');
 const newInspection=(await ok('package.inspect',{path:pkg})).inspection;
 await writeFile(path.join(pkg,'index.js'),originalFiles['index.js']+'// changed\n');
 await rejects('adaptation.prepare',{adaptationId:'adapt-'+'2'.repeat(32),botId:'fixture-bot',planId:newInspection.planId},'PACKAGE_CHANGED');
 check('Original mutation after inspection fails before creating a Work assignment');
 const market=await createBrowserMarketFixture(path.join(out,'synthetic-market'));
 try {
  const source=(await ok('source.add',{url:market.indexUrl})).source;
  const npmPlan=(await ok('package.inspect',{sourceId:source.id,name:market.unsupportedName,version:'1.0.0'})).inspection;
  const npmBinding={adaptationId:'adapt-'+'3'.repeat(32),botId:'fixture-bot',runId:'run-npm-fixture'};
  const material=(await ok('adaptation.prepare',{...npmBinding,planId:npmPlan.planId})).adaptation;
  await ok('adaptation.bind',npmBinding);
  const expected=market.archives.get('/tar/'+market.unsupportedName+'-1.0.0.tgz');
  assert.deepEqual(await readFile(path.join(material.workspace,'original-package.tgz')),expected);
  const npmCandidate=path.join(material.workspace,'adapted');
  assert.deepEqual(await readFile(path.join(npmCandidate,'upstream-package.tgz')),expected);
  await writeFile(path.join(npmCandidate,'package.json'),JSON.stringify({...material.adapter,dsh:{bundle:{patch:'bundle.yml'}}}));
  await writeFile(path.join(npmCandidate,'bundle.yml'),bundle('node'));
  await writeFile(path.join(npmCandidate,'server.mjs'),server);
  await writeFile(path.join(npmCandidate,'upstream-package.tgz'),'not the original archive');
  await rejects('adaptation.inspect',npmBinding,'ADAPTATION_PROVENANCE');
  check('Exact SHA-512-checked npm archive is retained byte-for-byte; archive replacement prevents adaptation installation');
 }finally{await market.close();}
 success=true;
} finally {
 await writeFile(path.join(out,'result.json'),JSON.stringify({success,checks,scope:'Synthetic package only; no real market, provider, account or desktop access.'},null,2));
 console.log(JSON.stringify({success,checks:checks.length,output:out}));
}

