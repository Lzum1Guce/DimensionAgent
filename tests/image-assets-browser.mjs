// Original synthetic image bytes, actual native HTTP, actual Chrome file inputs.
// No production files, API mocks, provider fixture, model requests or fixed ports.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { setup, parseOptions, startNative, cleanup, digest, until } from './relation-notes-api.mjs';
import { rawImport, excluded } from './archive-export-api.mjs';

const options = parseOptions(), config = await setup(options, 'phase3-image-browser');
const checks = [], failures = [], traces = [], requests = [], exceptions = [], blockedExternal = [], screenshots = [];
const pass = text => { checks.push(text); console.log('PASS ' + text); };
const profile = path.join(config.output, 'chrome-profile');
const fixtureSource = await readFile(path.join(import.meta.dirname, 'image_assets_test.cpp'), 'utf8');
const fixture = name => Buffer.from(fixtureSource.match(new RegExp('const auto ' + name + ' = unbase64\\("([^"]+)"\\)'))[1], 'base64');
const png = fixture('png'), jpeg = fixture('jpeg'), gif = fixture('gif'), webp = fixture('webp_lossless');
const owner = 'image-browser-owner', other = 'image-browser-other';
const botAvatar = id => '/api/dimension/bots/' + id + '/avatar';
const groupAvatar = id => '/api/dimension/groups/' + id + '/avatar';
let app, chrome, cdp, browserCdp;

async function binary(route, { method = 'GET', body, mime, status = 200, headers = {} } = {}) {
  const response = await fetch(app.origin + route, { method, body, headers: { ...(mime ? { 'content-type': mime } : {}), ...headers } });
  const bytes = Buffer.from(await response.arrayBuffer());
  const result = { status: response.status, bytes, type: response.headers.get('content-type'), etag: response.headers.get('etag') };
  if (result.type?.includes('json')) result.value = JSON.parse(bytes.toString('utf8'));
  traces.push({ route, method, status: result.status, bytes: bytes.length, sha256: digest(bytes), type: result.type });
  assert.equal(result.status, status, method + ' ' + route + ': ' + (result.value?.error || 'unexpected status'));
  return result;
}
function largePng(size) {
  const payload = Buffer.alloc(size - png.length - 12, 97); Buffer.from('Comment\0').copy(payload);
  const tag = Buffer.from('tEXt'), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(payload.length); let crc = 0xffffffff;
  for (const value of Buffer.concat([tag, payload])) {
    crc ^= value;
    for (let i = 0; i < 8; ++i) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([png.subarray(0, 33), length, tag, payload, checksum, png.subarray(33)]);
}
class Cdp {
  constructor(socket) {
    this.socket = socket; this.sequence = 0; this.pending = new Map(); this.listeners = new Map();
    socket.addEventListener('message', event => {
      const value = JSON.parse(event.data);
      if (value.id) {
        const item = this.pending.get(value.id); if (!item) return;
        this.pending.delete(value.id); clearTimeout(item.timer);
        if (value.error) item.reject(Error(JSON.stringify(value.error))); else item.resolve(value.result);
      } else for (const handler of this.listeners.get(value.method) || []) Promise.resolve(handler(value.params)).catch(error => exceptions.push(error.message));
    });
    socket.addEventListener('close', () => { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(Error('CDP closed')); } this.pending.clear(); });
  }
  static async connect(url) { const socket = new WebSocket(url); await once(socket, 'open'); return new Cdp(socket); }
  on(method, handler) { const list = this.listeners.get(method) || []; list.push(handler); this.listeners.set(method, list); }
  call(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 15000);
      this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
}
async function click(selector, button = 'left') {
  let previous;
  const point = await until(async () => {
    const current = await cdp.evaluate(`(() => {const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.hidden||el.disabled)return null;el.scrollIntoView({block:'center',inline:'nearest'});const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,top=document.elementFromPoint(x,y);return r.width>0&&r.height>0&&top&&(top===el||el.contains(top))?{x,y}:null})()`);
    const stable = current && previous && Math.abs(current.x - previous.x) < 0.5 && Math.abs(current.y - previous.y) < 0.5;
    previous = current; return stable ? current : null;
  }, 'clickable ' + selector);
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button, clickCount: 1, ...point });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button, clickCount: 1, ...point });
}
async function closeModal() {
  if (await cdp.evaluate('!document.querySelector("#modal").hidden')) {
    await click('#modal [data-close]'); await until(() => cdp.evaluate('document.querySelector("#modal").hidden'), 'modal closed');
  }
}
async function selectBot(id) {
  await closeModal(); await click('#botList [data-id="' + id + '"]');
  await until(() => cdp.evaluate('document.querySelector("#drawerTitle").textContent.includes(' + JSON.stringify(id) + ')'), 'selected ' + id);
}
async function inputFile(selector, file) {
  const document = await cdp.call('DOM.getDocument');
  const { nodeId } = await cdp.call('DOM.querySelector', { nodeId: document.root.nodeId, selector }); assert(nodeId);
  await cdp.call('DOM.setFileInputFiles', { nodeId, files: [file] });
}
async function screenshot(name) {
  const result = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(config.output, name + '.png'); await writeFile(file, Buffer.from(result.data, 'base64')); screenshots.push(file);
}
const statusHas = (selector, text) => cdp.evaluate('document.querySelector(' + JSON.stringify(selector) + ')?.textContent.includes(' + JSON.stringify(text) + ')');

try {
  config.fingerprints.browserTest = digest(await readFile(import.meta.filename)); config.fingerprints.imageFixture = digest(fixtureSource);
  config.fingerprints.stickersUi = digest(await readFile(path.join(config.ui, 'stickers.js')));
  app = await startNative({ ...config, label: 'native' });
  for (const id of [owner, other]) await app.api('/api/dimension/bots', { id, name: id, persona: 'SYNTH_IMAGE_PERSONA_' + id });
  const group = (await app.api('/api/dimension/groups', { name: '合成图片群', members: [owner, other], ownerId: owner })).group;
  for (const [bytes, mime] of [[png, 'image/png'], [jpeg, 'image/jpeg'], [gif, 'image/gif'], [webp, 'image/webp']]) {
    const saved = (await binary(botAvatar(owner), { method: 'POST', body: bytes, mime })).value;
    assert.equal(saved.hasAvatar, true); assert.equal(saved.bot.avatarRevision, digest(bytes));
    const read = await binary(botAvatar(owner)); assert.deepEqual(read.bytes, bytes); assert.equal(read.type, mime);
    const cached = await binary(botAvatar(owner), { headers: { 'if-none-match': read.etag }, status: 304 }); assert.equal(cached.bytes.length, 0);
  }
  await binary(groupAvatar(group.id), { method: 'POST', body: gif, mime: 'image/gif' });
  assert.equal((await app.api('/api/dimension/groups')).groups.find(row => row.id === group.id).hasAvatar, true);
  assert.equal((await app.api('/api/dimension/bootstrap')).bots.find(row => row.id === other).hasAvatar, false);
  pass('All four image formats round-trip unchanged with real MIME, ETag and independent Bot/group avatar flags');

  const before = (await binary(botAvatar(owner))).bytes;
  await binary(botAvatar(owner), { method: 'POST', body: '<svg/>', mime: 'image/png', status: 415 });
  await binary(botAvatar(owner), { method: 'POST', body: png, mime: 'image/jpeg', status: 415 });
  await binary(botAvatar(owner), { method: 'POST', body: png.subarray(0, -1), mime: 'image/png', status: 400 });
  await binary(botAvatar('missing-identity'), { method: 'POST', body: png, mime: 'image/png', status: 404 });
  assert.deepEqual((await binary(botAvatar(owner))).bytes, before);
  pass('Bad bytes, MIME mismatch, truncation and unknown owners reject before replacing an existing avatar');

  const large = largePng(8 * 1024 * 1024);
  await binary(botAvatar(owner), { method: 'POST', body: large, mime: 'image/png' });
  assert.equal(digest((await binary(botAvatar(owner))).bytes), digest(large));
  const colonGroup = 'synthetic:image-scope';
  await rawImport(app, { format: 'dimension-conversation-archive', version: 2, coverage: 'conversation-and-group-data', excludedTypes: [...excluded],
    bots: [{ id: owner, name: owner, persona: 'SYNTH_IMAGE_PERSONA_' + owner, inChat: true, inWork: false }], conversations: [], memories: [],
    groups: [{ id: colonGroup, name: '合成冒号身份群', ownerId: owner, admins: [], members: [owner], historyMembers: [owner],
      inChat: true, inWork: true, deleted: false, seal: { shape: 'round-seal', color: 'persimmon' }, revision: '1' }],
  }, 'synthetic-image-colon-group');
  await binary(groupAvatar(encodeURIComponent(colonGroup)), { method: 'POST', body: large, mime: 'image/png' });
  assert.equal(digest((await binary(groupAvatar(encodeURIComponent(colonGroup)))).bytes), digest(large));
  await binary(groupAvatar(encodeURIComponent(colonGroup)), { method: 'POST', body: png, mime: 'image/png' });
  await binary(botAvatar(owner), { method: 'POST', body: Buffer.alloc(8 * 1024 * 1024 + 1), mime: 'image/png', status: 413 });
  await binary('/api/dimension/persona?botId=' + owner, { method: 'POST', body: Buffer.alloc(4 * 1024 * 1024 + 1), mime: 'application/json', status: 413 });
  await binary('/api/dimension/bots/avatar', { method: 'POST', body: Buffer.alloc(4 * 1024 * 1024 + 1), mime: 'image/png', status: 413 });
  assert.equal(digest((await binary(botAvatar(owner))).bytes), digest(large));
  await binary(botAvatar(owner), { method: 'POST', body: png, mime: 'image/png' });
  pass('Exactly 8 MiB is accepted only on explicit image upload routes; excess and ordinary JSON routes retain their smaller limits');

  const stickerRows = [];
  for (const [bytes, mime] of [[png, 'image/png'], [jpeg, 'image/jpeg'], [gif, 'image/gif'], [webp, 'image/webp']]) {
    const name = mime === 'image/gif' ? '共享动图 <img id="imageInjected" src=x>' : '合成 ' + mime;
    const row = (await binary('/api/dimension/stickers?name=' + encodeURIComponent(name), { method: 'POST', body: bytes, mime })).value.sticker;
    assert.match(row.id, /^[0-9a-f]{32}$/); assert.equal(row.name, name);
    assert.deepEqual((await binary('/api/dimension/stickers/' + row.id + '/content')).bytes, bytes); stickerRows.push(row);
  }
  assert.equal(stickerRows[2].frames, 2); assert.equal(stickerRows[2].animated, true);
  assert.equal((await app.api('/api/dimension/stickers')).stickers.length, 4);
  await binary('/api/dimension/stickers/%2e%2e%5coutside/content', { status: 400 });
  await binary('/api/dimension/stickers?name=bad', { method: 'POST', body: '<svg/>', mime: 'image/gif', status: 415 });
  assert.equal((await app.api('/api/dimension/stickers')).stickers.length, 4);
  pass('The shared sticker library preserves original GIF animation, literal names and opaque IDs while rejecting traversal and invalid uploads');

  await binary(botAvatar(owner), { method: 'DELETE' });
  assert.equal((await app.api('/api/dimension/bootstrap')).bots.find(row => row.id === owner).hasAvatar, false);
  assert.equal((await app.api('/api/dimension/persona?botId=' + owner)).fields[0].content, 'SYNTH_IMAGE_PERSONA_' + owner);
  assert.deepEqual((await binary(groupAvatar(group.id))).bytes, gif);
  assert.equal((await app.api('/api/dimension/stickers')).stickers.length, 4);
  await binary(botAvatar(owner), { status: 404 });
  await binary(botAvatar(owner), { method: 'POST', body: png, mime: 'image/png' });
  await binary('/api/dimension/stickers/' + stickerRows[0].id, { method: 'DELETE' });
  await binary('/api/dimension/stickers/' + stickerRows[0].id + '/content', { status: 404 });
  pass('Avatar and sticker deletion affects only the selected asset and leaves persona, group avatars and other library entries intact');

  await rawImport(app, { format: 'dimension-conversation-archive', version: 2, coverage: 'conversation-and-group-data', excludedTypes: [...excluded], groups: [],
    bots: [{ id: owner, name: owner, persona: 'SYNTH_IMAGE_PERSONA_' + owner, inChat: true, inWork: false }], memories: [],
    conversations: [{ botId: owner, groupId: '', mode: 'chat', messages: [{ id: '7000', actor: 'user', text: '[sticker:' + stickerRows[2].id + ']', createdAtMs: '0' }] }],
  }, 'synthetic-image-history');
  await app.stop(); app = await startNative({ ...config, label: 'native-restart' });
  assert.deepEqual((await binary(botAvatar(owner))).bytes, png); assert.deepEqual((await binary(groupAvatar(group.id))).bytes, gif);
  assert.deepEqual((await binary('/api/dimension/stickers/' + stickerRows[2].id + '/content')).bytes, gif);
  assert.equal((await app.api('/api/dimension/stickers')).stickers.length, 3);
  pass('Avatar metadata, raw image bytes, animated stickers and deletions survive a real native process restart');

  const files = {};
  await mkdir(path.join(config.output, 'downloads'), { recursive: true });
  for (const [name, bytes] of [['synthetic.png', png], ['synthetic.webp', webp], ['shared.gif', gif], ['broken.png', Buffer.from('not a PNG')]]) {
    files[name] = path.join(config.output, 'downloads', name); await writeFile(files[name], bytes);
  }
  await mkdir(profile, { recursive: true });
  const child = spawn(options.get('chrome') || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--window-size=1440,1100', '--force-device-scale-factor=1', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--disable-default-apps', '--disable-extensions', '--disable-client-side-phishing-detection',
    '--disable-breakpad', '--disable-features=OptimizationHints,MediaRouter', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost', 'about:blank'],
  { cwd: config.output, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TEMP: path.join(config.output, 'temp'), TMP: path.join(config.output, 'temp') } });
  chrome = { label: 'chrome', child, stdout: '', stderr: '' }; config.processes.push(chrome);
  child.stdout.on('data', bytes => { chrome.stdout += bytes; }); child.stderr.on('data', bytes => { chrome.stderr += bytes; }); child.on('error', error => { chrome.error = error; });
  const port = await until(async () => { if (chrome.error) throw Object.assign(chrome.error, { fatal: true }); return Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }, 'Chrome port');
  const page = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(row => row.type === 'page');
  const browser = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json();
  cdp = await Cdp.connect(page.webSocketDebuggerUrl); browserCdp = await Cdp.connect(browser.webSocketDebuggerUrl);
  cdp.on('Runtime.exceptionThrown', value => exceptions.push(value.exceptionDetails.exception?.description || value.exceptionDetails.text));
  cdp.on('Network.responseReceived', value => requests.push({ path: new URL(value.response.url).pathname, status: value.response.status }));
  cdp.on('Fetch.requestPaused', async value => {
    const url = new URL(value.request.url);
    if (['http:', 'https:'].includes(url.protocol) && !['127.0.0.1', 'localhost'].includes(url.hostname)) {
      blockedExternal.push(url.origin); await cdp.call('Fetch.failRequest', { requestId: value.requestId, errorReason: 'BlockedByClient' });
    } else await cdp.call('Fetch.continueRequest', { requestId: value.requestId });
  });
  await cdp.call('Runtime.enable'); await cdp.call('Network.enable'); await cdp.call('Page.enable'); await cdp.call('DOM.enable');
  await cdp.call('Fetch.enable', { patterns: [{ urlPattern: '*' }] }); await cdp.call('Page.navigate', { url: app.origin + '/dimension-ui/' });
  await until(() => cdp.evaluate('!!document.querySelector("#botList [data-id=' + owner + ']")'), 'native Bot list');
  await selectBot(owner);
  await until(() => cdp.evaluate('!!document.querySelector("#transcript img.chat-sticker")?.naturalWidth'), 'real sticker history image');
  await click('#botList [data-id="' + owner + '"]', 'right'); await click('#botContextMenu [data-action=avatar]');
  await inputFile('#avatarFileInput', files['synthetic.webp']); await until(() => statusHas('#editSealMsg', '头像已更新'), 'avatar upload success');
  assert.deepEqual((await binary(botAvatar(owner))).bytes, webp);
  assert((await cdp.evaluate('document.querySelector("#editSealPreview img").src')).includes(digest(webp)));
  await inputFile('#avatarFileInput', files['broken.png']); await until(() => statusHas('#editSealMsg', '只支持'), 'real upload failure message');
  assert.deepEqual((await binary(botAvatar(owner))).bytes, webp);
  assert.equal(await cdp.evaluate('document.querySelector("#resetAvatarBtn").hidden'), false);
  await screenshot('01-avatar-failure-keeps-image');
  await click('#resetAvatarBtn'); await until(() => statusHas('#editSealMsg', '已恢复默认头像'), 'avatar deletion success');
  assert.equal(await cdp.evaluate('!!document.querySelector("#editSealPreview img")'), false);
  await binary(botAvatar(owner), { status: 404 });
  pass('Chrome uploads a real file, updates the avatar version, displays server rejection without changing the image, and deletes it successfully');

  await closeModal(); await click('#groupList [data-group-id="' + group.id + '"]', 'right');
  await inputFile('#gsAvatarInput', files['synthetic.png']); await until(() => statusHas('#gsMsg', '群头像已更新'), 'group upload');
  assert.deepEqual((await binary(groupAvatar(group.id))).bytes, png);
  await app.api('/api/dimension/groups/' + group.id, {}, 'DELETE');
  await click('#gsResetAvatar'); await until(() => statusHas('#gsMsg', '群不存在'), 'real group deletion failure');
  assert.equal(await cdp.evaluate('document.querySelector("#gsResetAvatar").hidden'), false);
  assert.equal(await statusHas('#gsMsg', '已恢复纸印'), false);
  pass('Group avatar upload works and a real 404 during deletion remains an error instead of claiming success');

  await selectBot(owner); await click('#chatStickerBtn');
  await until(() => cdp.evaluate('document.querySelectorAll(".sticker-grid img").length===3'), 'persisted shared sticker picker');
  assert.equal(await cdp.evaluate('!!document.querySelector("#imageInjected")'), false);
  await inputFile('.sticker-dialog input[type=file]', files['shared.gif']);
  await until(() => cdp.evaluate('document.querySelectorAll(".sticker-grid img").length===4'), 'sticker upload');
  const uploaded = (await app.api('/api/dimension/stickers')).stickers.find(row => row.name === 'shared'); assert(uploaded?.animated);
  await inputFile('.sticker-dialog input[type=file]', files['broken.png']);
  await until(() => statusHas('.sticker-dialog [role=status]', '只支持'), 'invalid sticker visible error');
  assert.equal((await app.api('/api/dimension/stickers')).stickers.length, 4);
  await click('.sticker-grid button:has(img[src*="' + uploaded.id + '"])');
  await until(() => cdp.evaluate('!!document.querySelector("#chatStickerDraft img")?.naturalWidth'), 'selected sticker draft');
  await selectBot(other); await click('#chatStickerBtn');
  await until(() => cdp.evaluate('!!document.querySelector(' + JSON.stringify('.sticker-grid img[src*="' + uploaded.id + '"]') + ')'), 'cross-Bot shared sticker');
  await click('.sticker-grid > div:has(img[src*="' + stickerRows[2].id + '"]) .sticker-remove');
  await until(() => cdp.evaluate('!document.querySelector(' + JSON.stringify('.sticker-grid img[src*="' + stickerRows[2].id + '"]') + ')'), 'sticker removed in picker');
  await click('.sticker-dialog .close'); await cdp.call('Page.reload');
  await until(() => cdp.evaluate('!!document.querySelector("#botList [data-id=' + owner + ']")'), 'reloaded Bot list');
  await selectBot(owner); await until(() => statusHas('#transcript', '[表情暂不可用]'), 'deleted history sticker placeholder');
  await screenshot('02-deleted-sticker-history-placeholder');
  pass('The real sticker picker uploads GIF, reports failed uploads, selects it, shares it across Bots and shows a history placeholder after deletion');

  await closeModal(); await click('#newBotBtn'); await click('#createMenuBot');
  await click('#newBotName'); await cdp.call('Input.insertText', { text: 'image-create-failure' });
  await inputFile('#newBotAvatarInput', files['broken.png']); await click('#confirmNewBot');
  await until(() => statusHas('#botIntroMsg', 'Bot 已创建，头像上传失败'), 'new Bot partial-success explanation');
  const created = (await app.api('/api/dimension/bootstrap')).bots.find(row => row.name === 'image-create-failure');
  assert(created); assert.equal(created.hasAvatar, false);
  await screenshot('03-created-bot-avatar-error');
  pass('A failed optional avatar upload after Bot creation is shown explicitly and never sets a false avatar flag');
  assert.deepEqual(await app.api('/api/providers'), []); assert.deepEqual(exceptions, []); assert.deepEqual(blockedExternal, []);
} catch (error) {
  failures.push(error.stack + (error.cause ? '\nCAUSE: ' + (error.cause.stack || String(error.cause)) : '')); process.exitCode = 1;
  if (cdp?.socket.readyState === WebSocket.OPEN) await screenshot('failure').catch(() => {});
} finally {
  if (chrome?.child.exitCode === null) {
    await browserCdp?.call('Browser.close').catch(() => {});
    await until(() => chrome.child.exitCode !== null, 'Chrome shutdown', 10000).catch(error => failures.push(error.message));
  }
  if (app?.child.exitCode === null) await app.stop().catch(error => failures.push(error.message));
  cdp?.socket.close(); browserCdp?.socket.close();
  await cleanup(config).catch(error => failures.push(error.message));
  let residualChrome = [];
  if (chrome) {
    try {
      const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "chrome.exe" -and $_.CommandLine -and $_.CommandLine.Contains($env:DIMENSION_IMAGE_CHROME_PROFILE) } | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'],
      { cwd: config.output, windowsHide: true, timeout: 15000, env: { ...process.env, DIMENSION_IMAGE_CHROME_PROFILE: profile } });
      if (result.stdout.trim()) { const value = JSON.parse(result.stdout); residualChrome = Array.isArray(value) ? value : [value]; }
      if (residualChrome.length) failures.push('Chrome profile still has running processes.');
    } catch (error) { failures.push('Could not verify Chrome cleanup: ' + error.message); }
  }
  const processes = config.processes.map(entry => ({ label: entry.label, pid: entry.child.pid, exitCode: entry.child.exitCode, signal: entry.child.signalCode }));
  if (processes.some(entry => entry.exitCode !== 0)) failures.push('A test process did not exit normally.');
  const report = { ok: !failures.length && !exceptions.length, checks, failures, exceptions, traces, requests, screenshots,
    fingerprints: config.fingerprints, processes, residualChrome, blockedExternal, productionDataUsed: false, modelRequests: 0,
    scope: 'Original 2x2 image fixtures, a fresh synthetic database and actual native HTTP/Chrome file uploads; one group deleted by a second real API client to verify failure reporting.' };
  if (!report.ok) process.exitCode = 1;
  await writeFile(path.join(config.output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, checks: checks.length, output: config.output }));
}
