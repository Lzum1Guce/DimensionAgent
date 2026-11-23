// Real native Work tasks, original synthetic model and isolated headless Chrome.
// Downloads are read back from disk and matched to the actual HTTP response.
import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonical, digest, parseOptions, startNative, until } from './archive-export-api.mjs';
import { startFixture } from './app-integration.mjs';
import { startBrowser } from './native-browser-fixture.mjs';

const options = parseOptions(), project = path.resolve(import.meta.dirname, '..');
const output = path.resolve(options.get('output') || path.join(project, 'outputs/task-handoff', String(Date.now())));
const executable = path.resolve(options.get('exe') || path.join(project, 'outputs/build/DImensionagent-native.exe'));
const ui = path.resolve(options.get('ui') || path.join(project, 'ui'));
assert(path.isAbsolute(output) && output !== path.parse(output).root, 'All isolated outputs stay in a non-root test directory');
await mkdir(path.join(output, 'temp'), { recursive: true });
const testBinary = path.join(output, 'test-native.exe');
const fingerprints = { native: digest(await readFile(executable)), test: digest(await readFile(import.meta.filename)),
  workUi: digest(await readFile(path.join(ui, 'work-session-ui.js'))), appUi: digest(await readFile(path.join(ui, 'app.js'))),
  modelFixture: digest(await readFile(path.join(project, 'tests/app-integration.mjs'))) };
if (options.has('expected-sha')) assert.equal(fingerprints.native, options.get('expected-sha').toLowerCase());
await copyFile(executable, testBinary); assert.equal(digest(await readFile(testBinary)), fingerprints.native);
const data = path.join(output, 'data'), checks = [], failures = [], processes = [], traces = [], exports = [];
const alpha = 'handoff-alpha', worker = 'handoff-worker', coordinator = 'handoff-coordinator';
const initial = 'APPTEST:handoff_ui\n原始请求：生成可核验的 UTF-8 文件。';
const supplement = 'RELEASE\n补充要求：保留中文与表情，完成后交付。';
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const within = file => { const relative = path.relative(output, file); assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); };
let fixture, app, browser, runId, groupId, groupRun, ok = false, temporarilyMoved = null;
async function getRun(id) { return app.api('/api/dimension/work/runs/' + id); }
async function complete(id) {
  const run = await until(async () => { const value = await getRun(id); return value.terminal && !value.executing ? value : null; }, 'completed synthetic Work', 25000);
  assert.equal(run.status, 'completed', JSON.stringify({ status: run.status, error: run.error }));
  return run;
}
async function treeDigest(folder) {
  const entries = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name); within(file); assert(!entry.isSymbolicLink());
      if (entry.isDirectory()) await walk(file);
      else entries.push([path.relative(folder, file).replaceAll('\\', '/'), digest(await readFile(file))]);
    }
  }
  await walk(folder); entries.sort((a, b) => a[0].localeCompare(b[0]));
  return digest(canonical(entries));
}
async function executionState() {
  return { modelCalls: fixture.records.length, work: await treeDigest(path.join(data, 'work-runs', 'runs')) };
}
function validate(bytes, expectedFiles) {
  const value = JSON.parse(bytes.toString('utf8')), { contentSha256, ...unsigned } = value;
  assert.equal(value.format, 'dimension-task-handoff'); assert.equal(value.version, 1);
  assert.equal(contentSha256, digest(canonical(unsigned)), 'Canonical full-package checksum');
  assert.equal(value.purpose, 'task-reference-material'); assert.equal(value.automaticResume, false);
  assert.equal(value.executable, false); assert.equal(value.requiresNewUserTask, true); assert.equal(value.containsToolReceipts, false);
  assert.equal(value.snapshotOnly, true); assert.equal(value.filesCapturedSeparately, true);
  assert.equal(value.attachments.contentsNotAutomaticallyAnonymized, true);
  assert(value.readmeMarkdown.includes('new task') && value.readmeMarkdown.includes('do not resume or replay'));
  const text = bytes.toString('utf8');
  for (const forbidden of ['synthetic-key', 'THINKING_ONLY_', 'discardable-', testBinary, output, data, 'tool_started',
    'tool_results', 'execution_outcome_known', 'protectedKey', 'baseUrl'])
    assert(!text.includes(forbidden), 'Export must omit private execution/configuration material');
  function inspect(node) {
    if (typeof node === 'string') assert(!/[A-Za-z]:[\\/]/.test(node), 'No absolute Windows host paths');
    if (!node || typeof node !== 'object') return;
    for (const [key, item] of Object.entries(node)) {
      assert(!['messages', 'tools', 'requests', 'receipts', 'events', 'arguments', 'toolCallId', 'provider', 'browserAccount', 'root', 'relative'].includes(key), 'No private structured field: ' + key);
      inspect(item);
    }
  }
  inspect(value);
  let count = 0, total = 0;
  for (const file of value.artifacts) {
    if (file.included) {
      assert(expectedFiles.has(file.name), 'Only actually declared source artifacts');
      const actual = Buffer.from(file.data, 'base64'), original = expectedFiles.get(file.name);
      assert.deepEqual(actual, original, 'Every attachment byte matches the actual file');
      assert.equal(file.sha256, digest(original)); assert.equal(file.bytes, String(original.length));
      assert.equal(file.encoding, 'base64'); count++; total += actual.length;
    } else {
      assert.equal(file.sha256, null); assert(!('data' in file) && !('bytes' in file));
    }
  }
  assert.equal(value.attachments.includedCount, count); assert.equal(value.attachments.totalBytes, String(total));
  return value;
}
async function expectedArtifacts(id) {
  const listed = (await app.api('/api/dimension/work/tasks/' + id + '/artifacts')).files;
  const values = new Map();
  for (const file of listed) { within(file.path); assert(file.available); values.set(file.name, await readFile(file.path)); }
  return { listed, values };
}
async function apiExport(id, includeFiles, expectedFiles, label) {
  const response = await app.response('/api/dimension/work/runs/' + id + '/handoff', { includeFiles });
  assert.equal(response.status, 200, response.text);
  assert.match(response.headers['content-disposition'], /^attachment; filename="dimension-task-[a-f0-9]{16}\.json"$/);
  assert.match(response.headers['cache-control'], /no-store/);
  const bytes = Buffer.from(response.text, 'utf8'), value = validate(bytes, expectedFiles);
  const file = path.join(output, label + '.json'); await writeFile(file, bytes);
  exports.push({ label, file, sha256: digest(bytes), contentSha256: value.contentSha256, includedCount: value.attachments.includedCount });
  return value;
}
try {
  fixture = await startFixture({ groupPlan: [
    { id: 'draft', botId: worker, text: 'APPTEST:group_handoff_a', dependencies: [] },
    { id: 'review', botId: worker, text: 'APPTEST:group_handoff_b', dependencies: ['draft'] },
  ] });
  app = await startNative({ label: 'handoff', executable: testBinary, ui, data, output, processes, traces });
  assert.equal((await app.api('/api/dimension/bootstrap')).features.taskHandoff, true);
  for (const id of [alpha, worker, coordinator]) {
    await app.api('/api/dimension/bots', { id, name: id, persona: 'Synthetic task handoff fixture' });
    await app.api('/api/dimension/work/settings', { botId: id, cliEngine: 'builtin' }, 'PATCH');
    await app.api('/api/dimension/bots/' + id + '/roster', { mode: 'work', present: true }, 'PATCH');
  }
  await app.api('/api/providers', { name: 'synthetic', entry: { kind: 'openai-chat-compat', baseUrl: fixture.baseUrl,
    spec: { model: 'fixture-flash' } }, secretValue: 'synthetic-key' });
  browser = await startBrowser({ output, processes }, app.origin, options.get('chrome'));
  const { evaluate, click, replace, cdp } = browser;
  await until(() => evaluate('!!document.querySelector("#botList [data-id=handoff-alpha]")'), 'bootstrap and populated Chat roster');
  await click('#botList [data-id="' + alpha + '"]');
  if (await evaluate('document.querySelector("#modeSwitch").textContent.trim().toLowerCase()!=="work"')) await click('[data-shell-target="work"]');
  await until(() => evaluate('document.querySelector("#modeSwitch").textContent.trim().toLowerCase()==="work"'), 'Work mode');
  await until(() => evaluate('!!document.querySelector(".work-new-thread-stage")'), 'Work composer');
  fixture.gate('handoff_ui');
  await replace('#composerInput', initial); await click('#sendBtn'); await fixture.pending('handoff_ui');
  runId = (await app.api('/api/dimension/work/sessions?botId=' + alpha)).runs.find(row => row.text === initial)?.id;
  assert(runId);
  await replace('#composerInput', supplement); await click('#sendBtn');
  const run = await complete(runId);
  const initialPackage = await apiExport(runId, false, new Map(), 'api-original-metadata');
  assert.deepEqual(initialPackage.task.requirements.map(item => item.text), [initial, supplement]);
  assert.deepEqual(initialPackage.task.requirements.map(item => item.kind), ['original', 'supplement']);
  assert.equal(initialPackage.task.status, 'completed');
  assert.equal(initialPackage.task.result, 'Verified delivery handoff_ui');
  const sourceFiles = await expectedArtifacts(runId); assert.equal(sourceFiles.values.size, 1);
  assert.deepEqual([...sourceFiles.values.values()][0], Buffer.from(fixture.textFor('handoff_ui')));
  assert(run.events.some(event => event.kind === 'tool' && event.tool?.name === 'write_file'));
  pass('Real Chrome creates a Work task, submits a supplement and receives a verified UTF-8 artifact; export preserves both requests and final status');

  const selector = '.work-run[data-run-id="' + runId + '"] [data-action="handoff"]';
  await until(() => evaluate('!!document.querySelector(' + JSON.stringify(selector) + ')'), 'task export button');
  async function open() {
    await click(selector); await until(() => evaluate('!!document.querySelector(".task-handoff[open]")'), 'handoff dialog open');
    assert.equal(await evaluate('document.querySelector(".task-handoff input[name=includeFiles]").checked'), false);
    const wording = await evaluate('document.querySelector(".task-handoff").textContent');
    for (const term of ['新任务资料', '不会自动恢复执行', '8 MiB', '16 MiB', '32', '分享前请检查']) assert(wording.includes(term));
  }
  async function escape() {
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  }
  const beforeCancel = await executionState(), exportRequests = () => browser.requests.filter(row => row.pathname.endsWith('/handoff'));
  const beforeRequestCount = exportRequests().length;
  await open(); await browser.screenshot('01-task-handoff-dialog');
  await click('.task-handoff .work-preview-close');
  await until(() => evaluate('!document.querySelector(".task-handoff")'), 'cancel removes dialog');
  await open(); await escape(); await until(() => evaluate('!document.querySelector(".task-handoff")'), 'Escape removes dialog');
  await open();
  const point = await evaluate('(()=>{const r=document.querySelector(".task-handoff").getBoundingClientRect();return {x:Math.max(1,r.x-8),y:Math.max(1,r.y-8)}})()');
  for (const type of ['mousePressed', 'mouseReleased']) await cdp.call('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
  await until(() => evaluate('!document.querySelector(".task-handoff")'), 'backdrop removes dialog');
  assert.equal(exportRequests().length, beforeRequestCount); assert.deepEqual(await executionState(), beforeCancel);
  pass('Default file opt-out, reference-only wording, Cancel, Escape and backdrop are visible and cause no request or task mutation');

  async function download(label, includeFiles, alreadyOpen = false) {
    const folder = path.join(output, 'downloads', label); await mkdir(folder, { recursive: true });
    await cdp.call('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: folder });
    if (!alreadyOpen) await open();
    if (await evaluate('document.querySelector(".task-handoff input[name=includeFiles]").checked') !== includeFiles)
      await click('.task-handoff input[name=includeFiles]');
    const responseStart = browser.responses.length;
    await click('.task-handoff-download');
    const file = await until(async () => {
      const names = await readdir(folder);
      const name = names.find(name => /^dimension-task-[a-f0-9]{16}\.json$/.test(name));
      return name && !names.some(name => name.endsWith('.crdownload')) ? path.join(folder, name) : null;
    }, 'real Chrome JSON download');
    const bytes = await readFile(file), value = validate(bytes, sourceFiles.values);
    const response = await until(() => browser.responses.slice(responseStart).find(row => row.pathname.endsWith('/handoff') && row.status === 200), 'actual export HTTP response');
    const wire = await cdp.call('Network.getResponseBody', { requestId: response.id });
    const responseBytes = Buffer.from(wire.body, wire.base64Encoded ? 'base64' : 'utf8');
    assert.deepEqual(bytes, responseBytes, 'Saved download is byte-for-byte the native response');
    assert.equal(exportRequests().at(-1).body.includeFiles, includeFiles);
    await until(() => evaluate('!document.querySelector(".task-handoff")'), 'successful download closes dialog');
    exports.push({ label, file, sha256: digest(bytes), contentSha256: value.contentSha256, includedCount: value.attachments.includedCount });
    return value;
  }
  const beforeExports = await executionState();
  const metadata = await download('browser-metadata', false);
  assert.equal(metadata.attachments.requested, false); assert.equal(metadata.artifacts.length, 1);
  assert.equal(metadata.artifacts[0].declaredBytes, String([...sourceFiles.values.values()][0].length));
  const full = await download('browser-files', true);
  assert.equal(full.attachments.requested, true); assert.equal(full.attachments.includedCount, 1);
  assert.deepEqual(full.task.requirements.map(item => item.text), [initial, supplement]);
  assert.deepEqual(await executionState(), beforeExports);
  pass('Metadata and explicitly selected file packages download through real Chrome; saved response, base64 bytes and SHA-256 match exactly without new execution');

  const original = sourceFiles.listed[0].path, moved = original + '.handoff-test-moved'; within(original); within(moved);
  await rename(original, moved); temporarilyMoved = { original, moved };
  await open(); await click('.task-handoff input[name=includeFiles]'); await click('.task-handoff-download');
  await until(() => evaluate('!document.querySelector(".task-handoff-status").hidden&&!document.querySelector(".task-handoff-download").disabled'), 'file failure message with retry');
  assert.match(await evaluate('document.querySelector(".task-handoff-status").textContent'), /缺失|无法读取/);
  assert.equal(browser.responses.filter(row => row.pathname.endsWith('/handoff')).at(-1).status, 409);
  await browser.screenshot('02-task-handoff-file-failure');
  const missingMetadata = await download('browser-missing-metadata', false, true);
  assert.equal(missingMetadata.artifacts[0].included, false); assert.equal(missingMetadata.artifacts[0].availableAtSnapshot, false);
  await rename(moved, original); temporarilyMoved = null;
  assert.deepEqual(await readFile(original), sourceFiles.values.get(sourceFiles.listed[0].name));
  assert.deepEqual(await executionState(), beforeExports);
  pass('A genuinely missing artifact rejects the file package, displays a retryable error and permits metadata-only download without losing task or file bytes');

  const route = '/api/dimension/work/runs/' + runId + '/handoff';
  for (const body of [{}, { includeFiles: 'true' }, { includeFiles: false, path: original }]) await app.api(route, body, 'POST', 400);
  await app.api(route, undefined, 'GET', 405);
  assert.equal((await app.response(route, { includeFiles: false }, 'POST', { origin: 'https://untrusted.example' })).status, 403);
  const missing = await app.response('/api/dimension/work/runs/nonexistent-handoff/handoff', { includeFiles: false });
  assert([400, 404].includes(missing.status));
  assert.deepEqual(await executionState(), beforeExports);
  pass('Export rejects wrong methods, malformed options, caller-supplied paths, foreign origins and missing tasks without creating work');

  groupId = (await app.api('/api/dimension/groups', { name: 'Synthetic handoff group', ownerId: coordinator, members: [coordinator, worker] })).group.id;
  await app.api('/api/dimension/groups/' + groupId + '/roster', { mode: 'work', present: true }, 'POST');
  groupRun = (await app.api('/api/dimension/work/runs', { botId: coordinator, groupId, text: 'APPTEST:group_coordinator', requestId: 'handoff-group-original' })).run.id;
  await complete(groupRun);
  const groupSupplement = 'APPTEST:group_coordinator\n补充要求：导出时保留真实依赖关系。';
  await app.api('/api/dimension/work/runs/' + groupRun + '/resume', { text: groupSupplement, requestId: 'handoff-group-supplement' });
  await complete(groupRun);
  const groupFiles = await expectedArtifacts(groupRun), beforeGroupExport = await executionState();
  const groupPackage = await apiExport(groupRun, true, groupFiles.values, 'api-group-files');
  assert.deepEqual(groupPackage.task.requirements.map(item => item.text), ['APPTEST:group_coordinator', groupSupplement]);
  assert.equal(groupPackage.children.length, 2); assert.equal(groupPackage.artifacts.filter(file => file.included).length, 2);
  const draft = groupPackage.children.find(child => child.key.endsWith(':draft'));
  const review = groupPackage.children.find(child => child.key.endsWith(':review'));
  assert(draft && review); assert(draft.dependenciesKnown && review.dependenciesKnown);
  assert.equal(draft.job, (await getRun(draft.runId)).text);
  const reviewText = (await getRun(review.runId)).text;
  // Dependent jobs receive the result and artifact references without conversation or tool history.
  const dependency = JSON.parse(reviewText.split("已完成的依赖：")[1].split("\n")[0]);
  assert.deepEqual(Object.keys(dependency).sort(), ["answer", "artifacts", "id", "status"]);
  assert(reviewText.includes(draft.runId) && review.job.includes(draft.runId));
  assert(review.job.includes('"status":"completed"'));
  assert(draft.job.startsWith('APPTEST:group_handoff_a') && review.job.startsWith('APPTEST:group_handoff_b'));
  assert(reviewText.startsWith('APPTEST:group_handoff_b\n已完成的依赖：'));
  assert.deepEqual(draft.dependsOn, []); assert.deepEqual(review.dependsOn, [draft.key]);
  assert(draft.key.endsWith(':draft') && review.key.endsWith(':review'));
  assert.equal(draft.status, 'completed'); assert.equal(review.status, 'completed');
  assert.equal(groupPackage.task.status, 'completed');
  assert.equal(groupPackage.task.latestDecision.text, groupSupplement);
  assert.equal(groupPackage.task.artifactIds.length, 2); assert.deepEqual(groupPackage.task.unresolvedItems, []);
  assert.deepEqual(await executionState(), beforeGroupExport);
  pass('Group export preserves original and supplementary requirements, actual child summaries, delegation-scoped dependency keys and exact child files');

  await app.stop();
  app = await startNative({ label: 'handoff-restart', executable: testBinary, ui, data, output, processes, traces });
  const restarted = await apiExport(groupRun, false, new Map(), 'api-group-after-restart');
  assert.deepEqual(restarted.children, groupPackage.children);
  assert.deepEqual(restarted.task.requirements, groupPackage.task.requirements);
  assert.equal((await getRun(groupRun)).status, 'completed');
  pass('Child dependencies and all task requirements remain exportable after native restart');
  assert.deepEqual(fixture.errors, []); assert.deepEqual(browser.exceptions, []);
  await browser.stop(); browser = null; await app.stop();
  assert(processes.every(entry => entry.child.exitCode === 0), 'All isolated native and Chrome processes exit normally');
  ok = true;
} catch (error) {
  failures.push(String(error.stack || error).replaceAll('synthetic-key', '[synthetic credential]'));
  console.error(failures.at(-1));
} finally {
  if (temporarilyMoved) await rename(temporarilyMoved.moved, temporarilyMoved.original).catch(error => failures.push('Synthetic fixture restore failed: ' + error.code));
  if (browser) await browser.stop().catch(error => failures.push('Chrome cleanup: ' + error.message));
  if (app) await app.stop().catch(error => failures.push('Native cleanup: ' + error.message));
  if (fixture) await fixture.close();
  ok &&= failures.length === 0;
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ ok, checks, failures, fingerprints, exports, traces,
    processExits: processes.map(entry => ({ label: entry.label, pid: entry.child.pid, exitCode: entry.child.exitCode })),
    modelErrors: fixture?.errors ?? [], browserErrors: browser?.exceptions ?? [] }, null, 2));
  console.log('RESULT ' + output); if (!ok) process.exitCode = 1;
}
