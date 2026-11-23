// Frozen Win32 host + native backend, real hidden WebView2 and isolated data.
// CDP targets only this process. No production paths, host input or model calls.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, cp, copyFile, readFile, readdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { Cdp } from './native-browser-fixture.mjs';
import { parseOptions, until, canonical, digest } from './archive-export-api.mjs';
import { assertPackage as assertBotPackage, fields as botFields } from './bot-archive-fixture.mjs';

const project = path.resolve(import.meta.dirname, '..'), options = parseOptions();
const release = path.resolve(options.get('release') || path.join(project, 'outputs/release-candidate'));
const source = path.resolve(options.get('source') || path.join(project, 'outputs/task-handoff/2a9cd48b-1794744767259'));
const output = path.resolve(options.get('output') || path.join(project, 'outputs/native-export-downloads', String(Date.now())));
const expected = { host: 'a04fe44f9cb63e72444f8cedf1db1ec9c3da045e0540a64e5f9020cb659bff2e',
  native: '2a9cd48b57541da468d794be0ebcf62a629c2d458682113bde59e39564d57a45',
  manifest: '593ac12632dcc2e4f16c4a5c226ce903cb0ff23d0754b69520259e8573303859' };
for (const file of [source, output, release]) assert.match(file, /^L:[\\/]/i);
assert(path.relative(path.join(project, 'outputs'), source) && !path.relative(path.join(project, 'outputs'), source).startsWith('..'));
await mkdir(path.join(output, 'temp'), { recursive: true });
const host = path.join(output, 'DImensionagent-native-export-test.exe'), backend = path.join(output, 'DImensionagent-native.exe');
const data = path.join(output, 'data'), sourceData = path.join(source, 'data'), downloadsPath = path.join(output, 'downloads');
await mkdir(downloadsPath, { recursive: true });
const fingerprints = {}, checks = [], failures = [], downloads = [], responses = [], requests = [], exceptions = [], modelRequests = [], sourceHashes = [];
let child, cdp, browserCdp, ended, stderr = '', origin, ok = false, hostPid, rewritten = 0;
const execFileAsync = promisify(execFile), pass = text => { checks.push(text); console.log('PASS ' + text); };
const trap = http.createServer((req, res) => { modelRequests.push({ method: req.method, path: new URL(req.url, 'http://fixture').pathname }); res.writeHead(503); res.end('Synthetic provider must not be called'); });
await new Promise(resolve => trap.listen(0, '127.0.0.1', resolve));
const trapUrl = 'http://127.0.0.1:' + trap.address().port + '/v1';
async function runDigest() {
  const rows = [], root = path.join(data, 'work-runs/runs');
  async function walk(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      assert(!entry.isSymbolicLink()); const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(file);
      else rows.push([path.relative(root, file), digest(await readFile(file))]);
    }
  }
  await walk(root); rows.sort((a, b) => a[0].localeCompare(b[0])); return digest(canonical(rows));
}
async function quit() {
  if (child && child.exitCode === null) {
    await execFileAsync(host, ['--quit'], { cwd: output, windowsHide: true, timeout: 15000 });
    await until(() => child.exitCode !== null, 'owned native host orderly exit', 20000);
  }
}
try {
  const files = { host: path.join(release, 'DImensionagent.exe'), native: path.join(release, 'native/DImensionagent-native.exe'),
    manifest: path.join(release, 'package-manifest.json') };
  for (const [key, file] of Object.entries(files)) { fingerprints[key] = digest(await readFile(file)); assert.equal(fingerprints[key], expected[key]); }
  fingerprints.test = digest(await readFile(import.meta.filename));
  for (const name of ['app.js', 'work-session-ui.js', 'bot-archive-ui.js', 'index.html', 'styles.css'])
    fingerprints['ui/' + name] = digest(await readFile(path.join(release, 'ui', name)));
  await copyFile(files.host, host); await copyFile(files.native, backend);
  await copyFile(path.join(release, 'runtime/webview2/WebView2Loader.dll'), path.join(output, 'WebView2Loader.dll'));
  const prior = JSON.parse(await readFile(path.join(source, 'result.json'), 'utf8'));
  assert(prior.ok && prior.fingerprints.native === expected.native, 'Source is the completed synthetic handoff fixture');
  const originalPackage = JSON.parse(await readFile(path.join(source, 'api-original-metadata.json'), 'utf8'));
  const runId = originalPackage.task.sourceRunId, bot = originalPackage.task.sourceBotId;
  assert.equal(bot, 'handoff-alpha');
  const originalInputs = originalPackage.task.requirements.map(value => value.text), originalAnswer = originalPackage.task.result;
  await cp(sourceData, data, { recursive: true, filter: file => !path.relative(sourceData, file).split(path.sep).includes('desktop-data') });
  // Rebase only owned synthetic persisted paths in this clone. Completed runs
  // do not restart; provider URLs go to a zero-call detector rather than a model.
  function rebase(value, key = '') {
    if (typeof value === 'string') {
      if (key === 'baseUrl') return trapUrl;
      return value.replaceAll(sourceData, data).replaceAll(sourceData.replaceAll('\\', '/'), data.replaceAll('\\', '/'));
    }
    if (Array.isArray(value)) return value.map(item => rebase(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebase(item, key)]));
    return value;
  }
  async function rebaseTree(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      assert(!entry.isSymbolicLink()); const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await rebaseTree(file);
      else if (/\.jsonl?$/.test(entry.name)) {
        const raw = await readFile(file, 'utf8'); sourceHashes.push({ relative: path.relative(data, file), sha256: digest(raw) });
        let next;
        if (entry.name.endsWith('.jsonl')) next = raw.split('\n').map(line => line.trim() ? JSON.stringify(rebase(JSON.parse(line))) : line).join('\n');
        else next = JSON.stringify(rebase(JSON.parse(raw)));
        if (next !== raw) { await writeFile(file, next); rewritten++; }
      }
    }
  }
  await rebaseTree(data);
  const settingsPath = path.join(data, 'settings.json');
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  settings.providers = {}; settings.activeProvider = '';
  await writeFile(settingsPath, JSON.stringify(settings));
  const runDirectories = await readdir(path.join(data, 'work-runs/runs'));
  for (const id of runDirectories) {
    const snapshot = JSON.parse(await readFile(path.join(data, 'work-runs/runs', id, 'snapshot.json'), 'utf8'));
    assert(snapshot.terminal && snapshot.status === 'completed', 'Only completed synthetic tasks may be cloned');
  }
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const debugPort = probe.address().port; await new Promise(resolve => probe.close(resolve));
  await writeFile(path.join(output, 'native-client.json'), JSON.stringify({
    backend, ui: path.join(release, 'ui'), data, loader: 'WebView2Loader.dll', debugPort,
  }));
  child = spawn(host, ['--background'], { cwd: output, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TEMP: path.join(output, 'temp'), TMP: path.join(output, 'temp') } });
  hostPid = child.pid; child.stdout.resume(); child.stderr.on('data', bytes => stderr += bytes);
  ended = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
  const page = await until(async () => {
    if (child.exitCode !== null) throw Object.assign(Error('Test host exited: ' + stderr), { fatal: true });
    const pages = await fetch('http://127.0.0.1:' + debugPort + '/json/list').then(value => value.json());
    return pages.find(value => value.type === 'page' && value.url.includes('/dimension-ui/'));
  }, 'hidden real native WebView2');
  origin = new URL(page.url).origin;
  cdp = await Cdp.connect(page.webSocketDebuggerUrl, exceptions);
  const version = await fetch('http://127.0.0.1:' + debugPort + '/json/version').then(value => value.json());
  fingerprints.webviewBrowser = version.Browser;
  browserCdp = await Cdp.connect(version.webSocketDebuggerUrl, exceptions);
  cdp.on('Runtime.exceptionThrown', value => exceptions.push(value.exceptionDetails.exception?.description || value.exceptionDetails.text));
  cdp.on('Network.requestWillBeSent', value => requests.push({ id: value.requestId, method: value.request.method, path: new URL(value.request.url).pathname }));
  cdp.on('Network.responseReceived', value => responses.push({ id: value.requestId, path: new URL(value.response.url).pathname, status: value.response.status }));
  browserCdp.on('Browser.downloadWillBegin', value => downloads.push({ guid: value.guid, suggestedFilename: value.suggestedFilename, state: 'started', scheme: new URL(value.url).protocol }));
  browserCdp.on('Browser.downloadProgress', value => {
    const entry = downloads.find(item => item.guid === value.guid);
    if (entry) Object.assign(entry, { state: value.state, receivedBytes: value.receivedBytes, totalBytes: value.totalBytes });
  });
  await cdp.call('Runtime.enable'); await cdp.call('Page.enable'); await cdp.call('Network.enable');
  await browserCdp.call('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: downloadsPath, eventsEnabled: true });
  const evaluate = expression => cdp.evaluate(expression);
  async function click(selector) {
    await until(() => evaluate('(()=>{const n=document.querySelector(' + JSON.stringify(selector) + ');return !!n&&!n.hidden&&!n.disabled})()'), 'clickable ' + selector);
    const result = await cdp.call('Runtime.evaluate', { expression: 'document.querySelector(' + JSON.stringify(selector) + ').click()', userGesture: true, awaitPromise: true, returnByValue: true });
    assert(!result.exceptionDetails, 'UI click must execute without exceptions');
  }
  const open = selector => evaluate('!!document.querySelector(' + JSON.stringify(selector) + ')?.open');
  async function screenshot(name) {
    const shot = await cdp.call('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(output, name + '.png'), Buffer.from(shot.data, 'base64'));
  }
  async function downloaded(oldCount, route) {
    const entry = await until(() => {
      const entry = downloads.slice(oldCount).find(item => item.state === 'completed' || item.state === 'canceled');
      if (entry?.state === 'canceled') throw Object.assign(Error('Real native download was canceled'), { fatal: true });
      return entry;
    }, 'actual native file download', 15000);
    assert.equal(entry.scheme, 'blob:');
    const file = path.join(downloadsPath, entry.guid), bytes = await readFile(file);
    assert(bytes.length > 0); assert.equal(bytes.length, entry.receivedBytes);
    const response = await until(() => responses.findLast(item => item.path === route && item.status === 200), 'native export HTTP response');
    const wire = await cdp.call('Network.getResponseBody', { requestId: response.id });
    assert.deepEqual(bytes, Buffer.from(wire.body, wire.base64Encoded ? 'base64' : 'utf8'), 'Downloaded file equals the native HTTP response exactly');
    Object.assign(entry, { file, sha256: digest(bytes), bytes: bytes.length });
    return { entry, bytes, value: JSON.parse(bytes.toString('utf8')) };
  }
  await until(() => evaluate('document.querySelector("#modeSwitch")?.dataset.bound==="1"&&!!window.chrome?.webview&&!!document.querySelector("#botList [data-id=handoff-alpha]")'), 'native bridge and populated roster');
  const api = async route => { const response = await fetch(origin + route); assert(response.ok); return response.json(); };
  const before = await runDigest();
  assert.equal((await api('/api/dimension/work/runs/' + runId)).status, 'completed');
  assert.deepEqual(modelRequests, []);
  pass('Frozen host/backend/UI run in a hidden real WebView2 using only completed cloned synthetic data and a fresh desktop binding');
  await click('#botList [data-id="' + bot + '"]');
  await click('#identityBtn'); await click('#botArchiveBtn');
  await until(() => open('#botArchiveDialog'), 'native Bot archive dialog');
  await until(() => evaluate('!document.querySelector("#botArchiveExport").disabled'), 'archive capabilities ready');
  const wanted = ['name', 'persona', 'workHistory'];
  for (const field of botFields) {
    const selector = '#botArchive-export-' + field;
    if (await evaluate('document.querySelector(' + JSON.stringify(selector) + ').checked') !== wanted.includes(field)) await click(selector);
  }
  const botDownloadCount = downloads.length; await click('#botArchiveExport');
  const botDownload = await downloaded(botDownloadCount, '/api/native/bot-archive/export');
  const botPackage = assertBotPackage(botDownload.value, wanted, botDownload.bytes.toString('utf8'));
  assert.equal(botDownload.entry.suggestedFilename, 'DimensionAgent-bot.json');
  for (const text of [...originalInputs, originalAnswer]) assert(botPackage.data.workHistory.some(item => item.text === text));
  assert.equal(botPackage.data.name, bot);
  await screenshot('01-native-bot-export-downloaded'); await click('#botArchiveClose');
  await until(async () => !await open('#botArchiveDialog'), 'Bot dialog closes after download');
  if (await evaluate('!document.querySelector("#drawer").hidden')) await click('#identityBtn');
  pass('Actual native Bot blob download reaches the specified folder and preserves the selected fields, original Work input, supplement and answer');
  if (await evaluate('document.querySelector("#modeSwitch").textContent.trim().toLowerCase()!=="work"')) await click('#modeSwitch');
  await click('#botList [data-id="' + bot + '"]');
  const exportButton = '.work-run[data-run-id="' + runId + '"] [data-action="handoff"]';
  await click(exportButton); await until(() => open('.task-handoff'), 'native task handoff dialog');
  await click('.task-handoff input[name=includeFiles]');
  await screenshot('02-native-task-export-dialog');
  const taskDownloadCount = downloads.length; await click('.task-handoff-download');
  const taskDownload = await downloaded(taskDownloadCount, '/api/dimension/work/runs/' + runId + '/handoff');
  assert.match(taskDownload.entry.suggestedFilename, /^dimension-task-[a-f0-9]{16}\.json$/);
  const { contentSha256, ...unsigned } = taskDownload.value;
  assert.equal(contentSha256, digest(canonical(unsigned))); assert.equal(taskDownload.value.format, 'dimension-task-handoff');
  assert.deepEqual(taskDownload.value.task.requirements.map(item => item.text), originalInputs);
  assert.equal(taskDownload.value.task.result, originalAnswer); assert.equal(taskDownload.value.automaticResume, false);
  assert.equal(taskDownload.value.attachments.includedCount, 1);
  const attachment = taskDownload.value.artifacts.find(item => item.included);
  const sourceBytes = await readFile(path.join(data, 'workspaces', runId, 'deliveries/handoff_ui.txt'));
  assert.equal(attachment.sha256, digest(sourceBytes)); assert.deepEqual(Buffer.from(attachment.data, 'base64'), sourceBytes);
  await until(() => evaluate('!document.querySelector(".task-handoff")'), 'successful native task export closes');
  await click(exportButton); await click('.task-handoff .work-preview-close');
  await until(() => evaluate('!document.querySelector(".task-handoff")'), 'native task dialog reopens and cancels');
  assert.equal(await evaluate('location.origin'), origin); await screenshot('03-native-exports-closed');
  assert.equal(await runDigest(), before, 'Export does not mutate completed runs or receipts');
  assert.deepEqual(modelRequests, []); assert.deepEqual(exceptions, []);
  assert(!requests.some(item => item.method === 'POST' && (/\/work\/runs$/.test(item.path) || /\/(resume|cancel)$/.test(item.path))));
  pass('Actual native task blob download contains exact file bytes and checksum; dialog close/reopen/cancel works without navigation, task mutation or model calls');
  await quit(); assert.equal(await ended, 0);
  cdp.socket.close(); browserCdp.socket.close(); cdp = browserCdp = null;
  const inventory = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:DIMENSION_NATIVE_EXPORT_DATA) } | Select-Object ProcessId,Name | ConvertTo-Json -Compress'],
    { cwd: output, windowsHide: true, env: { ...process.env, DIMENSION_NATIVE_EXPORT_DATA: data } });
  assert.equal(inventory.stdout.trim(), '', 'No owned native backend or WebView2 remains');
  for (const [key, file] of Object.entries(files)) assert.equal(digest(await readFile(file)), fingerprints[key], 'Frozen release unchanged');
  pass('Explicit quit exits the test host and clears its backend/WebView2 children; frozen host/native/manifest remain unchanged');
  ok = true;
} catch (error) {
  failures.push(String(error.stack || error)); console.error(failures.at(-1));
} finally {
  await quit().catch(error => failures.push('Owned host cleanup: ' + error.message));
  cdp?.socket.close(); browserCdp?.socket.close();
  await new Promise(resolve => trap.close(resolve));
  ok &&= failures.length === 0;
  await writeFile(path.join(output, 'result.json'), JSON.stringify({
    ok, checks, failures, fingerprints, downloads, modelRequests, exceptions, requests, hostPid,
    hostExitCode: child?.exitCode, rewrittenSyntheticJsonFiles: rewritten,
    syntheticSource: source, desktopDataBindingCloned: false, clonedProvidersRemoved: true,
    productionReadOrModified: false, frozenSourceOrUiEdited: false, globalWindowsInputUsed: false, stderr,
  }, null, 2));
  console.log('RESULT ' + output); if (!ok) process.exitCode = 1;
}
