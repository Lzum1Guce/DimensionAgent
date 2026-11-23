import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const originalHost = process.argv.includes('--original-host');
const outputRoot = path.join(project, 'outputs', originalHost ? 'plugin-original-guard-concurrency' : 'plugin-access-control-concurrency'); await mkdir(outputRoot, { recursive: true });
const work = await mkdtemp(path.join(outputRoot, 'run-')), dataDir = path.join(work, 'data'), pkg = path.join(work, 'package');
const delegate = originalHost ? path.join(project, 'runtime', 'plugin-host.mjs') : path.join(project, 'tests', 'fixtures', 'plugin-guard-delegate.mjs'), guard = path.join(project, 'runtime', 'plugin-host-guard.mjs');
const children = new Set(), checks = []; let success = false, pluginId, toolName, parallelElapsedMs = 0, maxActive = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function cli(action, args = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [guard], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); children.add(child);
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    const timer = setTimeout(() => { child.kill(); reject(new Error(action + ' timeout')); }, 20000);
    child.on('error', error => { clearTimeout(timer); children.delete(child); reject(error); });
    child.on('exit', code => { clearTimeout(timer); children.delete(child); try { assert.equal(code, 0); assert.equal(stderr, ''); resolve(JSON.parse(stdout)); } catch (error) { reject(error); } });
    child.stdin.end(JSON.stringify({ action, dataDir, pluginHost: delegate, ...args }) + '\n');
  });
}
async function ok(action, args = {}) { const response = await cli(action, args); assert.equal(response.ok, true, `${action}: ${JSON.stringify(response)}`); return response; }
const check = name => { checks.push(name); console.log('PASS ' + name); };
async function events() {
  const root = originalHost ? work : path.join(dataDir, 'plugins', 'plugin-data', pluginId), rows = [];
  for (const name of await readdir(root).catch(() => [])) if (name.endsWith('.json')) rows.push(JSON.parse(await readFile(path.join(root, name), 'utf8')));
  return rows;
}
async function until(fn, label) { const end = Date.now() + 10000; while (Date.now() < end) { if (await fn()) return; await sleep(25); } throw new Error('Timeout: ' + label); }
try {
  await mkdir(pkg, { recursive: true });
  await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: 'fixture-guarded-echo', version: '1.0.0', license: 'MIT', permissions: ['process:execute'], ...(originalHost ? { dsh: { bundle: { patch: 'bundle.yml' } } } : { fixture: { server: 'server.mjs' } }) }));
  if (originalHost) await writeFile(path.join(pkg, 'bundle.yml'), JSON.stringify([{ insert: [{ id: 'fixture', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'fixture', transport: 'stdio', command: process.execPath, args: ['server.mjs'] } }] }]));
  await writeFile(path.join(pkg, 'server.mjs'), `import {createInterface} from 'node:readline';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
const echoSchema={type:'object',properties:{text:{type:'string'},callId:{type:'string'},delay:{type:'integer'}},required:['text','callId'],additionalProperties:false};
for await(const line of createInterface({input:process.stdin})){
 const m=JSON.parse(line);if(m.id===undefined)continue;
 if(m.method==='initialize')send(m.id,{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'rw-fixture',version:'1'}});
 else if(m.method==='tools/list')send(m.id,{tools:[{name:'echo',description:'Read/write lock concurrency fixture',inputSchema:echoSchema}]});
 else if(m.method==='tools/call'){
  const a=m.params.arguments||{},startedAt=Date.now(),root=process.env.PLUGIN_DATA_DIR||process.env.DIMENSION_WORKSPACE;
  mkdirSync(root,{recursive:true});const file=join(root,a.callId+'.json');
  writeFileSync(file,JSON.stringify({callId:a.callId,text:a.text,start:startedAt,pid:process.pid}));
  await new Promise(r=>setTimeout(r,a.delay||0));
  writeFileSync(file,JSON.stringify({callId:a.callId,text:a.text,start:startedAt,end:Date.now(),pid:process.pid}));
  send(m.id,{content:[{type:'text',text:'echo: '+a.text}]});
 }else send(m.id,{});
}`);
  const plan = (await ok('package.inspect', { path: pkg })).inspection;
  pluginId = (await ok('package.install', { planId: plan.planId })).plugin.id;
  const enabled = await ok('plugin.enable', { pluginId, scope: { type: 'bot', botId: 'bot-a' } }); toolName = enabled.tools[0].name;
  const context = { botId: 'bot-a', runId: 'run-parallel', runCreatedAt: new Date().toISOString(), workspace: work };

  const started = Date.now(), count = 4, delay = 900;
  const parallel = await Promise.all(Array.from({ length: count }, (_, index) => ok('tools.call', { ...context, name: toolName, args: { text: `parallel-${index}`, callId: `parallel-${index}`, delay } })));
  parallelElapsedMs = Date.now() - started;
  assert(parallel.every((response, index) => response.text === `echo: parallel-${index}`));
  const completed = await events();
  // Compute overlap directly from intervals, independent of process scheduling.
  for (const row of completed.filter(item => item.callId?.startsWith('parallel-'))) maxActive = Math.max(maxActive, completed.filter(item => item.callId?.startsWith('parallel-') && item.start <= row.start && item.end >= row.start).length);
  assert(maxActive >= 3, `Expected at least three overlapping calls, got ${maxActive}`);
  assert(parallelElapsedMs < count * delay, `Calls were serialized: ${parallelElapsedMs}ms >= ${count * delay}ms`);
  check(`Four real MCP calls overlap (maxActive=${maxActive}, elapsed=${parallelElapsedMs}ms, serial budget=${count * delay}ms)`);

  const slow = ok('tools.call', { ...context, name: toolName, args: { text: 'already-dispatched', callId: 'already-dispatched', delay: 2000 } });
  await until(async () => (await events()).some(item => item.callId === 'already-dispatched'), 'slow MCP start');
  const statusStarted = Date.now();
  const status = await Promise.race([ok('plugin.list'), sleep(2500).then(() => { throw new Error('Read blocked behind actual invocation'); })]);
  const statusElapsed = Date.now() - statusStarted;
  assert.equal(status.plugins[0].enabled, true);
  assert(statusElapsed < 1500, `Status read appears blocked behind the 2000ms invocation: ${statusElapsed}ms`);
  check(`Ordinary status reads remain available during actual calls (${statusElapsed}ms < 1500ms)`);

  let disableSettled = false;
  const disabling = ok('plugin.disable', { pluginId }).then(value => { disableSettled = true; return value; });
  const writerIntents = path.join(dataDir, 'plugins', 'access-control', 'invocation', 'writers');
  await until(async () => (await readdir(writerIntents).catch(() => [])).some(name => name.endsWith('.json')), 'writer intent visible');
  const blocked = cli('tools.call', { ...context, name: toolName, args: { text: 'must-not-enter', callId: 'must-not-enter', delay: 10 } });
  await sleep(100); assert.equal(disableSettled, false, 'Disable returned before the dispatched call finished');
  assert.equal((await slow).text, 'echo: already-dispatched');
  await disabling; const rejected = await blocked; assert.equal(rejected.ok, false); assert.equal(rejected.error.code, 'PLUGIN_DISABLED', JSON.stringify(rejected));
  assert(!(await events()).some(item => item.callId === 'must-not-enter'), 'A new call entered MCP after writer intent');
  check('Writer intent blocks new calls; exclusive disable waits for but does not cancel the dispatched call');
  success = true;
} catch (error) { console.error(error.stack); process.exitCode = 1; }
finally {
  for (const child of children) if (child.exitCode === null) child.kill();
  const report = { success, checks, parallelElapsedMs, maxActive, fixtureDirectory: work, host: originalHost ? 'restored-original' : 'synthetic-delegate', originalHostRecovered: originalHost, realThirdPartyPackagesInstalled: false, realAccountsUsed: false, externalNetworkUsed: false };
  await writeFile(path.join(outputRoot, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ success, checks: checks.length, parallelElapsedMs, maxActive, report: path.join(outputRoot, 'result.json') }));
}
