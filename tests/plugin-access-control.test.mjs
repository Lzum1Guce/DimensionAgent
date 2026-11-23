import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handleRequest } from '../runtime/plugin-host-guard.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(project, 'outputs', 'plugin-access-control');
await mkdir(outputRoot, { recursive: true });
const work = await mkdtemp(path.join(outputRoot, 'run-')), dataDir = path.join(work, 'data');
const delegate = path.join(project, 'tests', 'fixtures', 'plugin-guard-delegate.mjs');
const guard = path.join(project, 'runtime', 'plugin-host-guard.mjs');
const secret = 'fixture-secret-only', checks = [], transcript = [];
let success = false;
const call = async (action, args = {}) => {
  const response = await handleRequest({ action, dataDir, pluginHost: delegate, ...args });
  transcript.push(response); return response;
};
const ok = async (action, args = {}) => { const response = await call(action, args); assert.equal(response.ok, true, `${action}: ${JSON.stringify(response)}`); return response; };
const reject = async (action, args, code) => { const response = await call(action, args); assert.equal(response.ok, false, `${action}: ${JSON.stringify(response)}`); assert.equal(response.error.code, code, JSON.stringify(response)); return response; };
const check = name => { checks.push(name); console.log('PASS ' + name); };
async function packageVersion(directory, { name = 'fixture-guarded-echo', version = '1.0.0', permissions = ['process:execute'], failUpdate = false, auth } = {}) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, version, license: 'MIT', permissions, failUpdate, auth, extraTool: true, fixture: { server: 'server.mjs' } }));
  await writeFile(path.join(directory, 'server.mjs'), `import {createInterface} from 'node:readline';import {appendFileSync,mkdirSync} from 'node:fs';import {join} from 'node:path';
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;
if(m.method==='initialize')send(m.id,{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'guarded-fixture',version:'1'}});
else if(m.method==='tools/call'){
 const args=m.params.arguments||{};if(args.delay)await new Promise(r=>setTimeout(r,args.delay));
 mkdirSync(process.env.PLUGIN_DATA_DIR,{recursive:true});appendFileSync(join(process.env.PLUGIN_DATA_DIR,'calls.log'),JSON.stringify({event:'call',text:args.text==='error'?'redacted-error':args.text})+'\\n');
 if(args.text==='error')send(m.id,{isError:true,content:[{type:'text',text:'upstream '+process.env.FIXTURE_SECRET}]});
 else send(m.id,{content:[{type:'text',text:'echo: '+args.text}],structuredContent:{text:'echo: '+args.text}});
}else send(m.id,{});
}`);
}
function cli(request) {
  return new Promise((resolve, rejectResult) => {
    const child = spawn(process.execPath, [guard], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    child.on('error', rejectResult); child.on('exit', code => {
      try { assert.equal(code, 0); assert.equal(stderr, ''); assert.equal(stdout.trim().split(/\r?\n/).length, 1); const value = JSON.parse(stdout); transcript.push(value); resolve(value); }
      catch (error) { rejectResult(error); }
    }); child.stdin.end(JSON.stringify(request) + '\n');
  });
}

try {
  const v1 = path.join(work, 'v1'); await packageVersion(v1);
  const inspection = (await ok('package.inspect', { path: v1 })).inspection;
  const installed = (await ok('package.install', { planId: inspection.planId })).plugin;
  const pluginId = installed.id;
  assert.equal(installed.installed, true); assert.equal(installed.enabled, false); assert.equal(installed.auth.state, 'not-required'); assert.deepEqual(installed.scopes, []);
  assert.equal(installed.manifest.version, '1.0.0'); assert.equal(installed.source.type, 'local-directory'); assert(installed.permissionFingerprint);
  const status = await ok('status'); assert.deepEqual(status.sources, []); assert.deepEqual(status.capabilities, ['synthetic-delegate']);
  check('Install, login and enable are distinct; source, exact version and permissions are returned');

  const enabled = await ok('plugin.enable', { pluginId, scope: { type: 'bot', botId: 'bot-a' } });
  const toolName = enabled.tools[0].name;
  const oldRunCreatedAt = new Date().toISOString();
  const oldContext = { botId: 'bot-a', runId: 'run-old', runCreatedAt: oldRunCreatedAt };
  assert.equal((await ok('tools.list', oldContext)).tools.length, 2, 'The first run snapshot includes the full plugin tool set');
  await reject('tools.call', { botId: 'bot-b', runId: 'run-b', runCreatedAt: new Date().toISOString(), name: toolName, args: { text: 'cross-bot' } }, 'PLUGIN_SCOPE_DENIED');
  assert.equal((await ok('tools.call', { ...oldContext, name: toolName, args: { text: 'first' } })).text, 'echo: first');
  check('Real guard → delegate → MCP stdio call succeeds only in the authorized Bot and Work scope');

  await ok('plugin.disable', { pluginId });
  await reject('tools.call', { ...oldContext, name: toolName, args: { text: 'disabled' } }, 'PLUGIN_DISABLED');
  await ok('plugin.enable', { pluginId, scope: { type: 'bot', botId: 'bot-a' } });
  await ok('plugin.enable', { pluginId, scope: { type: 'bot', botId: 'bot-b' } });
  await ok('plugin.disable', { pluginId, scope: { type: 'bot', botId: 'bot-a' } });
  await reject('tools.call', { ...oldContext, name: toolName, args: { text: 'scope-disabled' } }, 'PLUGIN_SCOPE_DENIED');
  assert.equal((await ok('tools.call', { botId: 'bot-b', runId: 'run-b', runCreatedAt: new Date().toISOString(), name: toolName, args: { text: 'other-scope' } })).text, 'echo: other-scope');
  check('Disable rejects subsequent calls; disabling one Bot does not disable another authorized Bot');

  await ok('plugin.enable', { pluginId, scope: { type: 'bot', botId: 'bot-a' } });
  const slow = call('tools.call', { ...oldContext, name: toolName, args: { text: 'in-flight', delay: 250 } });
  await new Promise(resolve => setTimeout(resolve, 40));
  await ok('plugin.disable', { pluginId, scope: { type: 'bot', botId: 'bot-a' } });
  assert.equal((await slow).text, 'echo: in-flight');
  await reject('tools.call', { ...oldContext, name: toolName, args: { text: 'after-concurrent-disable' } }, 'PLUGIN_SCOPE_DENIED');
  await ok('plugin.enable', { pluginId, scope: { type: 'bot', botId: 'bot-a' } });
  check('Disable waits for an already dispatched call but cannot be overtaken by a new call');

  const failedDir = path.join(work, 'failed-update'); await packageVersion(failedDir, { version: '1.1.0', failUpdate: true });
  const failedPlan = (await ok('package.inspect', { path: failedDir })).inspection;
  await reject('package.update', { pluginId, planId: failedPlan.planId }, 'UPDATE_FAILED');
  assert.equal((await ok('plugin.list')).plugins.find(item => item.id === pluginId).manifest.version, '1.0.0');
  assert.equal((await ok('tools.call', { ...oldContext, name: toolName, args: { text: 'fallback' } })).text, 'echo: fallback');
  check('Failed version update leaves the previous installed version callable and preserves grants');

  const v2 = path.join(work, 'v2'); await packageVersion(v2, { version: '2.0.0', permissions: ['process:execute', 'network:https://example.test'] });
  const v2Plan = (await ok('package.inspect', { path: v2 })).inspection;
  await ok('package.update', { pluginId, planId: v2Plan.planId });
  const widened = (await ok('plugin.list')).plugins.find(item => item.id === pluginId);
  assert.equal(widened.manifest.version, '2.0.0'); assert.equal(widened.permissionReconfirmationRequired, true); assert.equal(widened.enabled, false); assert.equal(widened.scopes.length, 0);
  await reject('plugin.enable', { pluginId, scope: { type: 'bot', botId: 'bot-b' } }, 'PERMISSION_CONFIRMATION_REQUIRED');
  await reject('tools.call', { ...oldContext, name: toolName, args: { text: 'unconfirmed-widening' } }, 'PLUGIN_SCOPE_DENIED');
  const approved = widened.permissions.map(item => item.id);
  const reenabled = await ok('plugin.enable', { pluginId, scope: { type: 'bot', botId: 'bot-a' }, permissionFingerprint: widened.permissionFingerprint, approvedPermissions: approved });
  assert.equal(reenabled.plugin.enabled, true);
  await reject('tools.call', { ...oldContext, name: toolName, args: { text: 'old-run-widening' } }, 'RUN_PERMISSION_SNAPSHOT');
  const newContext = { botId: 'bot-a', runId: 'run-new', runCreatedAt: new Date().toISOString() };
  assert.equal((await ok('tools.call', { ...newContext, name: toolName, args: { text: 'new-run' } })).text, 'echo: new-run');
  check('Permission widening requires full reconfirmation and never expands an old Work task snapshot');

  const reopened = await cli({ action: 'tools.call', dataDir, pluginHost: delegate, ...newContext, name: toolName, args: { text: 'reopened' } });
  assert.equal(reopened.ok, true, JSON.stringify(reopened)); assert.equal(reopened.text, 'echo: reopened');
  const persisted = (await ok('plugin.list')).plugins.find(item => item.id === pluginId);
  assert.equal(persisted.enabled, true); assert.equal(persisted.scopes[0].botId, 'bot-a'); assert.equal(persisted.permissionReconfirmationRequired, false);
  check('Fresh guard processes preserve enabled scopes, permission state and actual invocation behavior');

  const redacted = await ok('tools.call', { ...newContext, name: toolName, args: { text: 'error' } });
  assert.equal(redacted.isError, true); assert(!JSON.stringify(redacted).includes(secret));
  const exported = await ok('plugin.export'); assert(!JSON.stringify(exported).includes(secret)); assert.equal(exported.secretsIncluded, false);
  const guardState = await readFile(path.join(dataDir, 'plugins', 'access-control', 'state.json'), 'utf8'); assert(!guardState.includes(secret));
  check('Configured secrets stay out of guard state, errors, process responses and metadata export');

  const adaptationId = 'adapt-fixture', adaptationRun = 'run-adapter';
  await ok('adaptation.prepare', { adaptationId, botId: 'bot-a' });
  await ok('adaptation.bind', { adaptationId, runId: adaptationRun, botId: 'bot-a' });
  await ok('adaptation.prepare', { adaptationId: 'adapt-pending', botId: 'bot-a' });
  const dataPath = path.join(dataDir, 'plugins', 'plugin-data', pluginId);
  assert.equal((await stat(dataPath)).isDirectory(), true);
  const removed = await ok('plugin.remove', { pluginId }); assert.equal(removed.dataRetained, true); assert.equal(removed.dataDeleted, false);
  await reject('tools.call', { ...newContext, name: toolName, args: { text: 'after-remove' } }, 'PLUGIN_NOT_INSTALLED');
  await reject('adaptation.install', { adaptationId, runId: adaptationRun, botId: 'bot-a' }, 'ADAPTATION_REVOKED');
  await reject('adaptation.bind', { adaptationId: 'adapt-pending', runId: 'run-late-adapter', botId: 'bot-a' }, 'ADAPTATION_REVOKED');
  assert.equal((await stat(dataPath)).isDirectory(), true);
  assert.equal((await ok('plugin.list')).retainedData.some(item => item.pluginId === pluginId), true);
  await reject('plugin.data.delete', { pluginId: 'not-uninstalled' }, 'PLUGIN_STILL_INSTALLED');
  await ok('plugin.data.delete', { pluginId });
  await assert.rejects(stat(dataPath));
  await reject('tools.call', { ...newContext, name: toolName, args: { text: 'after-data-delete' } }, 'PLUGIN_NOT_INSTALLED');
  check('Uninstall revokes adaptation and future calls but retains data; explicit data deletion is separate');

  const authDir = path.join(work, 'auth-plugin');
  await packageVersion(authDir, { name: 'fixture-auth-echo', version: '1.0.0', auth: { state: 'logged-out', required: true, canLogin: true, canLogout: true } });
  const authPlan = (await ok('package.inspect', { path: authDir })).inspection;
  const authPlugin = (await ok('package.install', { planId: authPlan.planId })).plugin;
  await reject('plugin.enable', { pluginId: authPlugin.id, scope: { type: 'bot', botId: 'bot-a' } }, 'AUTH_REQUIRED');
  await ok('auth.login', { pluginId: authPlugin.id });
  assert.equal((await ok('plugin.list')).plugins.find(item => item.id === authPlugin.id).enabled, false);
  await ok('plugin.enable', { pluginId: authPlugin.id, scope: { type: 'bot', botId: 'bot-a' } });
  assert.equal((await ok('tools.call', { botId: 'bot-a', runId: 'run-auth', runCreatedAt: new Date().toISOString(), name: toolName, args: { text: 'authenticated' } })).text, 'echo: authenticated');
  await ok('auth.logout', { pluginId: authPlugin.id });
  const loggedOut = (await ok('plugin.list')).plugins.find(item => item.id === authPlugin.id);
  assert.equal(loggedOut.auth.state, 'logged-out'); assert.equal(loggedOut.enabled, false);
  await reject('tools.call', { botId: 'bot-a', runId: 'run-auth', runCreatedAt: new Date().toISOString(), name: toolName, args: { text: 'logged-out' } }, 'PLUGIN_DISABLED');
  check('Login does not enable a plugin; logout revokes scopes and blocks later calls');

  assert(!JSON.stringify(transcript).includes(secret));
  success = true;
} catch (error) {
  console.error(error.stack); process.exitCode = 1;
} finally {
  const report = { success, passed: checks.length, total: checks.length + (success ? 0 : 1), checks, fixtureDirectory: work, realThirdPartyPackagesInstalled: false, realAccountsUsed: false, externalNetworkUsed: false, note: 'Synthetic delegate performs real MCP stdio calls. The original plugin host is absent from this source copy and was not replaced.' };
  const serialized = JSON.stringify(report, null, 2); assert(!serialized.includes(secret));
  await writeFile(path.join(outputRoot, 'result.json'), serialized);
  console.log(JSON.stringify({ success, checks: checks.length, report: path.join(outputRoot, 'result.json') }));
}
