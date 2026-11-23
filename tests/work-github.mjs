import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { startNative } from './archive-export-api.mjs';

const [exe, root] = process.argv.slice(2);
assert(exe && path.isAbsolute(root));
await mkdir(root, {recursive:true});
const output = await mkdtemp(path.join(root, 'github-'));
const project = path.join(output, "owner's project");
await mkdir(project);
await mkdir(path.join(output, 'temp'));
process.env.GH_CONFIG_DIR = path.join(output, 'gh');
delete process.env.GH_TOKEN;
delete process.env.GITHUB_TOKEN;
const git = (...args) => execFileSync('git', ['-C',project,...args], {windowsHide:true,stdio:'pipe'});
git('init','--quiet');
git('remote','add','origin','git@github.com:fixture/repo.git');
const mockRoot = process.env.GH_TEST_PROGRAMFILES;
if (mockRoot) process.env.PATH = path.join(mockRoot,'GitHub CLI') + path.delimiter + process.env.PATH;
const app = await startNative({label:'github-work',executable:path.resolve(exe),ui:path.resolve('ui'),data:path.join(output,'data'),output});
try {
  const botId = 'github-probe', url = '/api/dimension/work/github?botId=' + botId;
  await app.api('/api/dimension/bots',{id:botId,name:'GH test'});
  await app.api('/api/dimension/work/settings',{botId,workspaceMode:'windows_native',projectCwd:project},'PATCH');
  const windows = await app.api(url);
  assert.equal(windows.environment,'Windows');
  assert.equal(windows.repository,'fixture/repo',JSON.stringify(windows));
  if (mockRoot) {
    assert.equal(windows.account,'fixture-user',JSON.stringify(windows));
    assert.equal(windows.permission,'WRITE');
    assert.equal(windows.state,'connected');
  } else {
    assert.equal(windows.account,'');
    assert(['unverified','missing'].includes(windows.state));
  }
  git('remote','set-url','origin','https://example-user:SYNTHETIC-PRIVATE@github.com/fixture/repo.git');
  const filtered=await app.api(url);
  assert.equal(filtered.repository,'');
  assert(!JSON.stringify(filtered).includes('SYNTHETIC'));
  await app.api('/api/dimension/work/settings',{botId,workspaceMode:'sandbox_checkout'},'PATCH');
  const sandbox=await app.api(url);
  assert.equal(sandbox.environment,'WSL 沙盒');
  assert.equal(sandbox.state,'awaitingWorkspace');
  assert.equal(sandbox.loginAvailable,false);
  await assert.rejects(app.api('/api/dimension/work/github/login',{botId},'POST'));
  console.log('PASS Windows repository, isolated account, filtered remote, sandbox state and login boundary');
} finally { await app.stop(); }
