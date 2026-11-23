// Real retained app UI, native API, local plugin host and headless Chrome.
// All identities, packages and model responses are synthetic and isolated.
// This tests creation/navigation only, not adaptation functionality.
import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startNative, parseOptions, digest, until } from './archive-export-api.mjs';
import { startFixture } from './app-integration.mjs';
import { startBrowser } from './native-browser-fixture.mjs';

const project = path.resolve(import.meta.dirname, '..'), options = parseOptions();
const output = path.join(project, 'outputs/plugin-adaptation/navigation', String(Date.now()));
await mkdir(path.join(output, 'temp'), { recursive: true });
const sourceBinary = path.resolve(options.get('exe') || path.join(project, 'outputs/build/DImensionagent-native.exe'));
const binary = path.join(output, 'test-native.exe'); await copyFile(sourceBinary, binary);
const ui = path.join(project, 'ui'), data = path.join(output, 'data'), pkg = path.join(output, 'synthetic-package');
await mkdir(pkg); await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: 'navigation-fixture-original', version: '1.0.0', license: 'MIT', main: 'index.js' }));
await writeFile(path.join(pkg, 'LICENSE'), 'MIT synthetic navigation fixture\n');
await writeFile(path.join(pkg, 'index.js'), 'export const echo = value => value;\n');
const processes = [], traces = [], checks = [], failures = [], evidence = [];
const alpha = 'navigation-alpha', beta = 'navigation-beta';
const fingerprints = { native: digest(await readFile(binary)), app: digest(await readFile(path.join(ui, 'app.js'))),
  work: digest(await readFile(path.join(ui, 'work-session-ui.js'))), plugin: digest(await readFile(path.join(ui, 'plugin-market-ui.js'))) };
const pass = label => { checks.push(label); console.log('PASS ' + label); };
let app, fixture, browser, runId, groupId;
async function complete(id) {
  return until(async () => {
    const value = await app.api('/api/dimension/work/runs/' + id + '?view=1');
    if (['failed', 'cancelled', 'interrupted'].includes(value.status)) throw Object.assign(Error(JSON.stringify(value)), { fatal: true });
    return value.status === 'completed' && !value.executing ? value : null;
  }, 'completed synthetic navigation task', 25000);
}
try {
  fixture = await startFixture();
  app = await startNative({ label: 'native', executable: binary, ui, data, output, processes, traces,
    extraArgs: ['--node', process.execPath, '--plugin-host', path.join(project, 'runtime/plugin-host.mjs')] });
  for (const [id, name] of [[alpha, '薇尔莉特'], [beta, '芙莉莲']]) {
    await app.api('/api/dimension/bots', { id, name, persona: 'Synthetic navigation fixture' });
    await app.api('/api/dimension/bots/' + id + '/roster', { mode: 'work', present: true }, 'PATCH');
  }
  await app.api('/api/providers', { name: 'synthetic', entry: { kind: 'openai-chat-compat', baseUrl: fixture.baseUrl, spec: { model: 'fixture-flash' } }, secretValue: 'synthetic-key' });
  groupId = (await app.api('/api/dimension/groups', { name: '合成跳转群', ownerId: alpha, members: [alpha, beta] })).group.id;
  await app.api('/api/dimension/groups/' + groupId + '/roster', { mode: 'work', present: true }, 'POST');
  const groupRun = (await app.api('/api/dimension/work/runs', { botId: alpha, groupId, text: 'APPTEST:navigation_group', requestId: 'navigation-group' })).run.id;
  await complete(groupRun);
  browser = await startBrowser({ output, processes }, app.origin, options.get('chrome'));
  const { evaluate, click, replace } = browser;
  await until(() => evaluate('!!document.querySelector("#botList [data-id=navigation-beta]")'), 'Chat roster');
  await click('#botList [data-id=navigation-beta]');
  await until(() => evaluate('document.querySelector("#botList [data-id=navigation-beta]").classList.contains("active")'), 'beta selected');
  await click('#sharedPluginsBtn');
  await until(() => evaluate('!!document.querySelector(".capability-dialog[open] .pm-local-form")'), 'real local plugin inspector');
  await click('.pm-local > summary'); await replace('.pm-local-form [name=path]', pkg); await click('.pm-local-form button');
  await until(() => evaluate('!!document.querySelector(".pm-adapt-install")'), 'unsupported local package inspected');
  await click('.pm-adapt-install');
  await until(() => evaluate('!document.querySelector(".pm-adaptation-bot").disabled'), 'real Work Bot choices');
  await evaluate('(()=>{const select=document.querySelector(".pm-adaptation-bot");select.value="navigation-alpha";select.dispatchEvent(new Event("change",{bubbles:true}))})()');
  await click('.pm-adaptation-start');
  await until(() => evaluate('!!document.querySelector(".pm-adaptation-open")'), 'real adaptation task created');
  runId = (await app.api('/api/dimension/work/sessions?botId=' + alpha + '&limit=50')).runs.find(row => !row.groupId)?.id; assert(runId);
  await complete(runId);
  // Keep the real creation dialog open while moving its task off the first page.
  for (let i = 0; i < 7; i++) {
    const id = (await app.api('/api/dimension/work/runs', { botId: alpha, text: 'APPTEST:navigation_later_' + i, deliveryMode: 'queue', requestId: 'navigation-later-' + i })).run.id;
    await complete(id);
  }
  assert(!(await app.api('/api/dimension/work/sessions?botId=' + alpha + '&limit=5')).runs.some(row => row.id === runId));
  const target = '.work-run[data-run-id="' + runId + '"]';
  async function focused(label) {
    await until(() => evaluate('document.activeElement?.dataset.runId===' + JSON.stringify(runId)), label + ' focused old task');
    assert.equal(await evaluate('document.querySelectorAll(' + JSON.stringify(target) + ').length'), 1);
    assert.equal(await evaluate('document.querySelector("#modeSwitch").textContent.trim().toLowerCase()'), 'work');
    assert.equal(await evaluate('document.querySelector(".capability-dialog").open'), false);
    await until(() => evaluate('document.querySelectorAll("#transcript > .work-legacy").length===1'), label + ' opened Work');
    const snapshot = await evaluate('({errors:[...document.querySelectorAll("#transcript .bubble")].map(n=>n.textContent).filter(t=>/工作记录暂时无法加载|aborted|AbortError/i.test(t)),cards:document.querySelectorAll("#transcript > .work-run").length,legacy:document.querySelectorAll("#transcript > .work-legacy").length,top:document.querySelector(' + JSON.stringify(target) + ').getBoundingClientRect().top,transcriptTop:document.querySelector("#transcript").getBoundingClientRect().top})');
    evidence.push({ label, ...snapshot }); assert.deepEqual(snapshot.errors, [], label + ' should not add abort errors');
    assert(snapshot.top >= snapshot.transcriptTop - 2 && snapshot.top < snapshot.transcriptTop + 120, label + ' remains positioned after legacy/async loading');
  }
  await click('.pm-adaptation-open'); await focused('cross-mode');
  pass('Actual plugin create/open button closes its dialog, changes Chat to Work, activates the selected Bot and reveals the exact older-than-first-page run');
  await browser.screenshot('01-plugin-to-old-task');

  await evaluate('document.querySelector("#transcript").scrollTop=document.querySelector("#transcript").scrollHeight');
  await click('#sharedPluginsBtn'); await until(() => evaluate('!!document.querySelector(".capability-dialog[open] .pm-adaptation-open")'), 'retained real adaptation button');
  await click('.pm-adaptation-open'); await focused('same-open-bot');
  pass('Repeated navigation to the already open Bot resets the view cleanly and focuses the old task once');

  await click('#groupList [data-group-id="' + groupId + '"]');
  await until(() => evaluate('!!document.querySelector(' + JSON.stringify('.work-run[data-run-id="' + groupRun + '"]') + ')'), 'Work group with cached solo cards');
  await click('#sharedPluginsBtn'); await until(() => evaluate('!!document.querySelector(".capability-dialog[open] .pm-adaptation-open")'), 'plugin reopened from group');
  await click('.pm-adaptation-open');
  try { await focused('from-work-group-cache'); pass('Returning from Work group cache mounts one solo task view and keeps focus without competing opens'); }
  catch (error) { failures.push(error.stack); console.error(error.stack); }

  await click('#modeSwitch'); await until(() => evaluate('document.querySelector("#modeSwitch").textContent.trim().toLowerCase()==="chat"'), 'Chat mode restored');
  await click('#sharedPluginsBtn'); await until(() => evaluate('!!document.querySelector(".capability-dialog[open] .pm-adaptation-open")'), 'plugin reopened from Chat');
  await click('.pm-adaptation-open');
  try { await focused('cross-mode-cached-selection'); pass('A later cross-mode jump ignores stale saved selection and keeps the requested old task focused'); }
  catch (error) { failures.push(error.stack); console.error(error.stack); }

  assert.deepEqual(browser.exceptions, []); assert.deepEqual(browser.blockedExternal, []); assert.deepEqual(fixture.errors, []);
} catch (error) { failures.push(error.stack); console.error(error.stack); }
finally {
  if (browser) await browser.stop().catch(error => failures.push(error.stack));
  if (app?.child.exitCode === null) await app.stop().catch(error => failures.push(error.stack));
  if (fixture) await fixture.close();
  for (const entry of processes) await writeFile(path.join(output, entry.label + '.log'), entry.stdout + '\nSTDERR\n' + entry.stderr);
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: failures.length === 0, checks, failures, evidence, fingerprints,
    appAfter: digest(await readFile(path.join(ui, 'app.js'))), traces, browserRequests: browser?.requests || [], screenshots: browser?.screenshots || [],
    productionDataUsed: false, scope: 'Real app/plugin creation/navigation; synthetic model does not establish adaptation functionality' }, null, 2));
  console.log('REPORT ' + path.join(output, 'report.json')); if (failures.length) process.exitCode = 1;
}
