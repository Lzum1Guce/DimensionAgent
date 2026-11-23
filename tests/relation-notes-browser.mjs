// Real native API suite plus real Chrome interactions. No application API mocks.
// One detached old editor click exercises the stale-view guard after switching.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseOptions, setup, startNative, exerciseApi, assertRestart, cleanup, seedBots, keys, titles, emptyValues,
  valuesOf, assertOverview, saveRelations, memoryRoute, personaRoute, htmlText, bodyPrefix, digest, until } from './relation-notes-api.mjs';
import { rawImport, excluded } from './archive-export-api.mjs';

const options = parseOptions(), config = await setup(options, 'phase3-relation-browser');
const chromePath = options.get('chrome') || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = path.join(config.output, 'chrome-profile');
const checks = [], failures = [], requests = [], responses = [], exceptions = [], blockedExternal = [], screenshots = [];
const pass = name => { checks.push(name); console.log('PASS ' + name); };
let app, chrome, cdp, browserCdp;

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
async function escape() {
  await cdp.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
}
async function replace(selector, text) {
  await click(selector);
  await cdp.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  await cdp.call('Input.insertText', { text });
  assert.equal(await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).value`), text);
}
async function closeEditor() {
  if (await cdp.evaluate('!document.querySelector("#modal").hidden')) {
    await click('#modal [data-close]'); await until(() => cdp.evaluate('document.querySelector("#modal").hidden'), 'editor closed');
  }
}
async function selectBot(id) {
  await closeEditor();
  if (await cdp.evaluate('!document.querySelector("#drawer").hidden')) { await escape(); await until(() => cdp.evaluate('document.querySelector("#drawer").hidden'), 'drawer closed'); }
  await click('#botList [data-id="' + id + '"]');
  await until(() => cdp.evaluate('document.querySelector("#drawerTitle").textContent.includes(' + JSON.stringify(id) + ')'), 'selected ' + id);
}
async function openEditor(kind = 'memory') {
  await closeEditor();
  if (await cdp.evaluate('document.querySelector("#drawer").hidden')) await click('#identityBtn');
  await click('[data-open="' + kind + '"]');
  await until(() => cdp.evaluate('!!document.querySelector(' + JSON.stringify(kind === 'memory' ? '#saveRelations' : '#savePersona') + ')'), kind + ' editor');
}
async function mode(value) {
  await closeEditor();
  if (await cdp.evaluate('!document.querySelector("#drawer").hidden')) { await escape(); await until(() => cdp.evaluate('document.querySelector("#drawer").hidden'), 'drawer closed'); }
  if (await cdp.evaluate('document.querySelector("#modeSwitch").textContent.trim().toLowerCase()') !== value) await click('#modeSwitch');
  await until(() => cdp.evaluate('document.querySelector("#modeSwitch").textContent.trim().toLowerCase()===' + JSON.stringify(value)), value + ' mode');
}
async function visibleBots() {
  return cdp.evaluate('Array.from(document.querySelectorAll("#botList [data-id],#pinnedBots [data-id]")).filter(el=>el.getBoundingClientRect().height>0).map(el=>el.dataset.id).sort()');
}
async function expectBots(ids, label) {
  const expected = [...ids].sort();
  await until(async () => JSON.stringify(await visibleBots()) === JSON.stringify(expected), label);
}
async function form() {
  return cdp.evaluate(`Array.from(document.querySelectorAll('#modal textarea[data-rel]')).map(el=>({key:el.dataset.rel,title:document.querySelector('label[for="'+el.id+'"]').textContent,description:document.getElementById(el.getAttribute('aria-describedby')).textContent,placeholder:el.placeholder,value:el.value}))`);
}
async function screenshot(name) {
  const result = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(config.output, name + '.png'); await writeFile(file, Buffer.from(result.data, 'base64')); screenshots.push(file);
}
function relationRequests() { return requests.filter(row => row.pathname === '/api/dimension/memory' && row.action === 'save-relations'); }
function personaWrites() { return requests.filter(row => row.pathname === '/api/dimension/persona' && row.method === 'POST'); }
async function relationResponse(before, status = 200) {
  const request = await until(() => relationRequests()[before], 'relation POST');
  const response = await until(() => responses.find(row => row.id === request.id), 'relation response');
  assert.equal(response.status, status);
  await until(() => cdp.evaluate(status === 409 ? 'document.querySelector("#relationMsg").textContent.includes("重新打开")' : 'document.querySelector("#relationMsg").textContent.includes("已保存")'), 'relation status');
  return request;
}

try {
  config.fingerprints.browserTest = digest(await readFile(import.meta.filename));
  app = await startNative({ ...config, label: 'native' });
  const apiState = await exerciseApi(app, pass);
  await app.stop(); app = await startNative({ ...config, label: 'native-restart' }); await assertRestart(app, apiState, pass);
  const { ids, personas } = await seedBots(app, 'relation-browser');
  assert.equal((await app.api('/api/dimension/bootstrap')).features.persistentBotRosters, true);
  const workOnly = 'relation-browser-work-only', pooled = 'relation-browser-pool';
  await app.api('/api/dimension/bots', { id: workOnly, name: '合成关系 ' + workOnly, persona: bodyPrefix + 'work only', mode: 'work' });
  await app.api('/api/dimension/bots', { id: pooled, name: '合成关系 ' + pooled, persona: bodyPrefix + 'pooled', mode: 'chat' });
  await app.api('/api/dimension/bots/' + pooled + '/roster', { mode: 'chat', present: false }, 'PATCH');
  await app.api('/api/dimension/bots/' + ids.alpha + '/roster', { mode: 'work', present: true }, 'PATCH');
  const rosterSnapshot = (await app.api('/api/dimension/bootstrap')).bots;
  const expectedChat = rosterSnapshot.filter(bot => bot.chat).map(bot => bot.id), expectedWork = rosterSnapshot.filter(bot => bot.work).map(bot => bot.id);
  assert(!expectedChat.includes(workOnly) && !expectedChat.includes(pooled) && expectedWork.includes(workOnly));
  const seededBot = rosterSnapshot.find(bot => bot.id === ids.alpha), chatHistory = bodyPrefix + 'CHAT_HISTORY_TO_KEEP', workHistory = bodyPrefix + 'WORK_HISTORY_TO_DELETE';
  await rawImport(app, { format: 'dimension-conversation-archive', version: 2, coverage: 'conversation-and-group-data',
    excludedTypes: [...excluded], groups: [],
    bots: [{ id: seededBot.id, name: seededBot.name, persona: seededBot.persona, inChat: seededBot.chat, inWork: seededBot.work }],
    conversations: ['chat', 'work'].map((mode, index) => ({ botId: ids.alpha, groupId: '', mode, messages: [{ id: String(index + 1), actor: 'user', text: index ? workHistory : chatHistory, createdAtMs: '0' }] })), memories: [],
  }, 'synthetic-relation-roster-history');
  const topic = bodyPrefix + 'UE5 Unreal Engine 虚幻 Dimension 3 用户明确保存的记忆';
  let memory = await app.api(memoryRoute(ids.alpha), { action: 'add', botId: ids.alpha, text: topic });
  await app.api(memoryRoute(ids.alpha), { action: 'review', botId: ids.alpha, candidateId: memory.candidates.find(item => item.text === topic).id, reviewAction: 'confirm' });
  await app.api(memoryRoute(ids.alpha), { action: 'add', botId: ids.alpha, text: topic + ' 待确认' });
  await app.api('/api/dimension/bots/' + ids.alpha + '/activate', {}, 'POST');
  await mkdir(profile, { recursive: true });
  const child = spawn(chromePath, ['--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--window-size=1440,1300', '--force-device-scale-factor=1', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--disable-default-apps', '--disable-extensions', '--disable-client-side-phishing-detection',
    '--disable-breakpad', '--disable-features=OptimizationHints,MediaRouter', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost', 'about:blank'],
    { cwd: config.output, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TEMP: path.join(config.output, 'temp'), TMP: path.join(config.output, 'temp') } });
  chrome = { label: 'chrome', child, stdout: '', stderr: '' }; config.processes.push(chrome);
  child.stdout.on('data', bytes => { chrome.stdout += bytes; }); child.stderr.on('data', bytes => { chrome.stderr += bytes; }); child.on('error', error => { chrome.error = error; });
  const port = await until(async () => { if (chrome.error) throw Object.assign(chrome.error, { fatal: true }); return Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }, 'Chrome debugging port');
  const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(), page = pages.find(value => value.type === 'page'); assert(page);
  const browser = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json();
  cdp = await Cdp.connect(page.webSocketDebuggerUrl); browserCdp = await Cdp.connect(browser.webSocketDebuggerUrl);
  cdp.on('Runtime.exceptionThrown', value => exceptions.push(value.exceptionDetails.exception?.description || value.exceptionDetails.text));
  cdp.on('Network.requestWillBeSent', value => {
    const url = new URL(value.request.url), row = { id: value.requestId, pathname: url.pathname, queryBotId: url.searchParams.get('botId'), queryMode: url.searchParams.get('mode'), method: value.request.method };
    if (value.request.postData && (['/api/dimension/memory', '/api/dimension/persona', '/api/dimension/bots'].includes(url.pathname) || url.pathname.endsWith('/roster'))) {
      const body = JSON.parse(value.request.postData);
      row.action = body.action; row.botId = body.botId; row.baseRevision = body.baseRevision;
      row.mode = body.mode; row.present = body.present;
      row.valueKeys = Object.keys(body.values || {}); row.valuesSha256 = digest(JSON.stringify(body.values || {}));
      if (body.action === 'save-entries') row.entries = (body.entries || []).map(item => ({ id: item.id, revision: item.revision, fields: Object.keys(item).sort() }));
    }
    requests.push(row);
  });
  cdp.on('Network.responseReceived', value => responses.push({ id: value.requestId, pathname: new URL(value.response.url).pathname, status: value.response.status }));
  cdp.on('Fetch.requestPaused', async value => {
    const url = new URL(value.request.url);
    if (['http:', 'https:'].includes(url.protocol) && !['127.0.0.1', 'localhost'].includes(url.hostname)) {
      blockedExternal.push(url.origin); await cdp.call('Fetch.failRequest', { requestId: value.requestId, errorReason: 'BlockedByClient' });
    } else await cdp.call('Fetch.continueRequest', { requestId: value.requestId });
  });
  await cdp.call('Runtime.enable'); await cdp.call('Network.enable'); await cdp.call('Page.enable'); await cdp.call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await cdp.call('Page.navigate', { url: app.origin + '/dimension-ui/' });
  await until(() => cdp.evaluate('!!document.querySelector("#botList [data-id=' + ids.alpha + ']")'), 'real native Bot list');
  await expectBots(expectedChat, 'fresh Chat roster from native flags');
  await mode('work'); await expectBots(expectedWork, 'independent Work roster from native flags');
  await selectBot(workOnly);
  await click('#botList [data-id="' + workOnly + '"]', 'right'); await click('#botContextMenu [data-action=recall]');
  await expectBots(expectedWork.filter(id => id !== workOnly), 'Work Bot recalled through PATCH');
  await until(() => cdp.evaluate('document.querySelector("#identityBtn").hidden&&!!document.querySelector("#transcript .conversation-welcome")'), 'recalled current Work selection cleared');
  let workRecord = (await app.api('/api/dimension/bootstrap')).bots.find(bot => bot.id === workOnly);
  assert.equal(workRecord.work, false); assert.equal(workRecord.chat, false);
  await click('#newBotBtn'); await click('#createMenuBot'); await click('#botPoolList [data-pool-id="' + workOnly + '"]');
  await closeEditor(); await expectBots(expectedWork, 'Work Bot restored from real pool through PATCH');
  workRecord = (await app.api('/api/dimension/bootstrap')).bots.find(bot => bot.id === workOnly);
  assert.equal(workRecord.work, true); assert.equal(workRecord.chat, false);
  assert(requests.some(row => row.pathname.endsWith('/' + workOnly + '/roster') && row.method === 'PATCH' && row.mode === 'work' && row.present === false));
  assert(requests.some(row => row.pathname.endsWith('/' + workOnly + '/roster') && row.method === 'PATCH' && row.mode === 'work' && row.present === true));
  pass('Fresh Chrome uses native Chat/Work rosters; recalling the current Bot clears selection and real pool restoration persists one mode without revealing the whole library');

  await click('#botList [data-id="' + workOnly + '"]', 'right'); await click('#botContextMenu [data-action=hide]');
  await expectBots(expectedWork.filter(id => id !== workOnly), 'local hidden preference');
  const beforeReload = responses.length; await cdp.call('Page.reload', { ignoreCache: true });
  await until(() => responses.slice(beforeReload).some(row => row.pathname === '/api/dimension/bootstrap' && row.status === 200), 'roster reload');
  await expectBots(expectedWork.filter(id => id !== workOnly), 'hidden preference survives authoritative roster refresh');
  assert.equal((await app.api('/api/dimension/bootstrap')).bots.find(bot => bot.id === workOnly).work, true);
  await click('#searchBotBtn'); await replace('#sidebarSearchInput', workOnly);
  await click('#botList [data-id="' + workOnly + '"]', 'right'); await click('#botContextMenu [data-action=hide]');
  await click('#sidebarSearchClear'); await escape();
  await expectBots(expectedWork, 'explicit unhide keeps native roster');
  await mode('chat'); await expectBots(expectedChat, 'Chat unchanged by Work roster actions');
  pass('Native roster refresh preserves local hide preferences, supports explicit unhide and keeps modes isolated');

  await selectBot(ids.alpha); await openEditor();
  let fields = await form(); assert.deepEqual(fields.map(item => item.key), keys); assert.deepEqual(fields.map(item => item.title), titles);
  assert(fields.every(item => item.value === '' && item.placeholder && item.description));
  assert.match(fields[1].description, /逐步.*不预设/); assert.match(fields[2].description, /本应用.*Bot.*人类/); assert.match(fields[3].description, /其他 Agent 平台/);
  assert(await cdp.evaluate('Array.from(document.querySelectorAll("#memoryEntries textarea")).some(el=>el.value.includes("UE5"))'));
  assert(await cdp.evaluate('document.querySelector("#memoryCandidates").textContent.includes("虚幻")'));
  await cdp.evaluate('document.querySelector("[data-rel=user-profile]").scrollIntoView({block:"start"})'); await screenshot('01-four-semantic-fields');
  pass('Real Chrome displays four empty correctly explained fields and does not hide UE5/Unreal/Dimension memories');

  const expected = { 'user-profile': htmlText, 'user-relationship': '从真实合成对话逐步了解', contacts: '本应用 Bot beta；跨平台人类联系人', 'external-bots': '其他 Agent 平台中的合成 Bot' };
  for (const [key, value] of Object.entries(expected)) await replace('[data-rel="' + key + '"]', value);
  const beforePersona = personaWrites().length, beforeSave = relationRequests().length;
  await app.api('/api/dimension/bots/' + ids.beta + '/activate', {}, 'POST'); // Another client changes backend selection while this editor stays on alpha.
  await click('#saveRelations'); const firstWrite = await relationResponse(beforeSave);
  assert.equal(firstWrite.botId, ids.alpha); assert.equal(firstWrite.queryBotId, ids.alpha); assert.deepEqual(firstWrite.valueKeys, keys);
  assert.equal(personaWrites().length, beforePersona); assertOverview(await app.api(memoryRoute(ids.alpha)), expected);
  assertOverview(await app.api(memoryRoute(ids.beta)), emptyValues());
  assert.equal((await app.api(personaRoute(ids.alpha))).fields[0].content, personas[ids.alpha]);
  pass('Relationship save sends an explicit captured Bot ID and never writes persona, even when backend selection changes');

  const firstRevision = (await app.api(memoryRoute(ids.alpha))).overview.relationRevision;
  expected.contacts += '；第二次保存'; await replace('[data-rel=contacts]', expected.contacts);
  const beforeAgain = relationRequests().length; await click('#saveRelations');
  const secondWrite = await relationResponse(beforeAgain); assert.equal(secondWrite.baseRevision, firstRevision);
  assertOverview(await app.api(memoryRoute(ids.alpha)), expected);
  await closeEditor(); await openEditor(); fields = await form(); assert.deepEqual(Object.fromEntries(fields.map(item => [item.key, item.value])), expected);
  assert.equal(await cdp.evaluate('Boolean(document.querySelector("#relationInjected")||window.__relationXss)'), false);
  pass('Successful saves adopt the returned relation revision; HTML-shaped text survives reopening without element or script injection');

  await replace('[data-rel=user-relationship]', '尚未保存的关系草稿');
  await replace('#newMemory', bodyPrefix + '新增普通记忆');
  const relationCount = relationRequests().length, personaCount = personaWrites().length;
  await click('#saveMemory'); await until(() => cdp.evaluate('document.querySelector("#memoryMsg").textContent.includes("已保存")'), 'ordinary memory saved');
  assert.equal(relationRequests().length, relationCount); assert.equal(personaWrites().length, personaCount);
  assertOverview(await app.api(memoryRoute(ids.alpha)), expected);
  assert.equal(await cdp.evaluate('document.querySelector("[data-rel=user-relationship]").value'), '尚未保存的关系草稿');
  pass('Ordinary memory saves leave relation drafts and persisted relation/persona content separate');

  const latest = assertOverview(await app.api(memoryRoute(ids.alpha))), concurrent = { ...expected, 'user-profile': '另一个窗口保存的资料' };
  await saveRelations(app, ids.alpha, concurrent, latest.overview.relationRevision);
  const beforeConflict = relationRequests().length, beforeReads = requests.filter(row => row.pathname === '/api/dimension/memory' && row.method === 'GET').length;
  await click('#saveRelations'); await relationResponse(beforeConflict, 409);
  assert.equal(await cdp.evaluate('document.querySelector("#saveRelations").disabled'), true);
  assert.equal(await cdp.evaluate('document.querySelector("[data-rel=user-relationship]").value'), '尚未保存的关系草稿');
  await cdp.evaluate('document.querySelector("#saveRelations").click()');
  assert.equal(relationRequests().length, beforeConflict + 1);
  assert.equal(requests.filter(row => row.pathname === '/api/dimension/memory' && row.method === 'GET').length, beforeReads);
  assertOverview(await app.api(memoryRoute(ids.alpha)), concurrent);
  await screenshot('02-stale-editor-requires-reopen');
  pass('A real 409 keeps the draft, disables stale retry and asks to reopen without fetching a newer revision to force an overwrite');

  await closeEditor(); await openEditor();
  assert.deepEqual(Object.fromEntries((await form()).map(item => [item.key, item.value])), concurrent);
  await cdp.evaluate('window.__detachedRelationSave=document.querySelector("#saveRelations")');
  await selectBot(ids.beta);
  const beforeDetached = relationRequests().length; await cdp.evaluate('window.__detachedRelationSave.click();delete window.__detachedRelationSave');
  await openEditor(); assert((await form()).every(item => item.value === ''));
  assert.equal(relationRequests().length, beforeDetached); assertOverview(await app.api(memoryRoute(ids.beta)), emptyValues());
  pass('Switching Bots invalidates the old editor; a detached old save handler cannot write into the new Bot');

  await selectBot(ids.alpha); await openEditor('persona');
  assert.deepEqual(await cdp.evaluate('Array.from(document.querySelectorAll("#modal textarea[data-key]")).map(el=>el.dataset.key)'), ['persona']);
  const personaText = bodyPrefix + '浏览器明确修改的人设'; await replace('#persona-persona', personaText);
  await click('#savePersona'); await until(() => cdp.evaluate('document.querySelector("#personaMsg").textContent.includes("已保存")'), 'persona saved');
  const personaWrite = personaWrites().at(-1); assert.equal(personaWrite.queryBotId, ids.alpha); assert.deepEqual(personaWrite.valueKeys, ['persona']);
  assert.equal((await app.api(personaRoute(ids.alpha))).fields[0].content, personaText); assertOverview(await app.api(memoryRoute(ids.alpha)), concurrent);
  await mode('work'); await expectBots(expectedWork, 'Work roster before scoped deletion');
  await click('#botList [data-id="' + ids.alpha + '"]', 'right'); await click('#botContextMenu [data-action=delete]');
  await until(() => cdp.evaluate('document.querySelector("#paperPromptTitle")?.textContent.includes("Work")'), 'Work deletion confirmation');
  await click('#paperPromptOk'); await expectBots(expectedWork.filter(id => id !== ids.alpha), 'Work-only deletion result');
  assert(requests.some(row => row.pathname === '/api/dimension/bots/' + ids.alpha && row.method === 'DELETE' && row.queryMode === 'work'));
  const afterDelete = (await app.api('/api/dimension/bootstrap')).bots.find(bot => bot.id === ids.alpha);
  assert.equal(afterDelete.work, false); assert.equal(afterDelete.chat, true); assert.equal(afterDelete.persona, personaText);
  assert(!JSON.stringify(await app.api('/api/dimension/bots/' + ids.alpha + '/history?mode=work')).includes(workHistory));
  assert(JSON.stringify(await app.api('/api/dimension/bots/' + ids.alpha + '/history?mode=chat')).includes(chatHistory));
  assertOverview(await app.api(memoryRoute(ids.alpha)), concurrent);
  await mode('chat'); await expectBots(expectedChat, 'Chat roster retained after Work deletion');
  pass('Real Work deletion uses the mode parameter, clears only Work history and preserves Chat, library identity, persona and notes');

  const pager = 'relation-browser-paging';
  await app.api('/api/dimension/bots', { id: pager, name: pager, persona: bodyPrefix + 'paging persona' });
  const pageText = index => bodyPrefix + 'PAGING_RECORD_' + index;
  await rawImport(app, { format: 'dimension-conversation-archive', version: 2, coverage: 'conversation-and-group-data', excludedTypes: [...excluded], groups: [],
    bots: [{ id: pager, name: pager, persona: bodyPrefix + 'paging persona', inChat: true, inWork: false }], conversations: [],
    memories: Array.from({ length: 404 }, (_, index) => ({ id: String(10000 + index), botId: pager, groupId: '', text: pageText(index),
      state: index >= 237 ? 'rejected' : index % 4 === 0 ? 'candidate' : 'confirmed', revision: '1', sourceActor: 'user' })),
  }, 'synthetic-memory-paging');
  const allPageRows = async () => {
    const rows = []; let before = '';
    for (;;) {
      const page = await app.api(memoryRoute(pager) + '&limit=100' + (before ? '&before=' + before : ''));
      rows.push(...page.entries.map(row => ({ ...row, state: 'confirmed' })), ...page.candidates.map(row => ({ ...row, state: 'candidate' })));
      if (!page.hasMore) return rows;
      before = page.before;
    }
  };
  const pagingOriginal = await allPageRows(); assert.equal(pagingOriginal.length, 237);
  const pageRow = index => pagingOriginal.find(row => row.text === pageText(index));
  const cardSelector = id => '#memoryEntries .memory-card[data-id="' + id + '"] textarea';
  const visibleMemoryCount = () => cdp.evaluate('document.querySelectorAll("#memoryEntries .memory-card,#memoryCandidates .memory-card").length');
  await cdp.call('Page.reload'); await until(() => cdp.evaluate('!!document.querySelector("#botList [data-id=' + pager + ']")'), 'new paging Bot from native roster');
  await selectBot(pager); await openEditor();
  assert.equal(await visibleMemoryCount(), 100);
  await replace(cardSelector(pageRow(235).id), pageText(235) + ' 未保存草稿');
  await replace('[data-rel=contacts]', '翻页期间保留的关系草稿');
  await click('#loadMoreMemory'); await until(async () => await visibleMemoryCount() === 200, 'second memory page');
  assert.equal(await cdp.evaluate('document.querySelector(' + JSON.stringify(cardSelector(pageRow(235).id)) + ').value'), pageText(235) + ' 未保存草稿');
  assert.equal(await cdp.evaluate('document.querySelector("[data-rel=contacts]").value'), '翻页期间保留的关系草稿');
  pass('Memory pagination reaches 200 records past rejected rows while preserving unsaved ordinary and relationship drafts');

  await replace(cardSelector(pageRow(41).id), pageText(41) + ' 显式更新旧页');
  await replace(cardSelector(pageRow(42).id), '');
  await click('#saveMemory'); await until(() => cdp.evaluate('document.querySelector("#memoryMsg").textContent.includes("已保存")'), 'explicit paged memory save');
  const pageSave = requests.filter(row => row.action === 'save-entries').at(-1);
  assert.deepEqual(pageSave.entries.map(row => row.id).sort(), [235, 41, 42].map(index => pageRow(index).id).sort());
  for (const entry of pageSave.entries) assert.deepEqual(entry.fields, ['id', 'revision', 'text']);
  let rowsAfter = await allPageRows();
  assert.equal(rowsAfter.length, 236); assert(!rowsAfter.some(row => row.id === pageRow(42).id));
  assert.deepEqual(rowsAfter.find(row => row.id === pageRow(1).id), pageRow(1), 'Unloaded oldest record unchanged');
  assert.equal(rowsAfter.find(row => row.id === pageRow(41).id).state, 'candidate');
  assert.equal(await visibleMemoryCount(), 199, 'Saved first-page response must retain already loaded second-page records');
  await click('#loadMoreMemory'); await until(async () => await visibleMemoryCount() === 236, 'complete paged memory collection');
  assert.equal(await cdp.evaluate('document.querySelector("#loadMoreMemory").hidden'), true);
  const loadedIds = await cdp.evaluate('Array.from(document.querySelectorAll("#memoryEntries .memory-card,#memoryCandidates .memory-card")).map(el=>el.dataset.id)');
  assert.equal(new Set(loadedIds).size, 236);
  await click('#memoryCandidates [data-id="' + pageRow(0).id + '"] [data-review=confirm]');
  await until(() => cdp.evaluate('!!document.querySelector(' + JSON.stringify(cardSelector(pageRow(0).id)) + ')'), 'old-page candidate confirmation');
  assert.equal(await visibleMemoryCount(), 236);
  assert.equal(await cdp.evaluate('document.querySelector("[data-rel=contacts]").value'), '翻页期间保留的关系草稿');
  await cdp.evaluate('document.querySelector("#memoryPageStatus").scrollIntoView({block:"center"})');
  await screenshot('03-memory-all-pages');
  pass('Paged saves send only three explicit revisions, preserve unloaded rows and all loaded pages, and can review the oldest candidate');

  const oldest = (await allPageRows()).find(row => row.id === pageRow(1).id);
  await replace(cardSelector(oldest.id), '应保留的旧页冲突草稿');
  await app.api(memoryRoute(pager), { action: 'save-entries', botId: pager, entries: [{ id: oldest.id, revision: oldest.revision, text: '另一个窗口的旧页修改' }] });
  const beforeMemoryGet = requests.filter(row => row.pathname === '/api/dimension/memory' && row.method === 'GET').length;
  await click('#saveMemory'); await until(() => cdp.evaluate('document.querySelector("#memoryMsg").textContent.includes("重新打开")'), 'paged revision conflict');
  assert.equal(await cdp.evaluate('document.querySelector(' + JSON.stringify(cardSelector(oldest.id)) + ').value'), '应保留的旧页冲突草稿');
  assert.equal(await cdp.evaluate('document.querySelector("#saveMemory").disabled'), true);
  assert.equal(requests.filter(row => row.pathname === '/api/dimension/memory' && row.method === 'GET').length, beforeMemoryGet);
  assert.equal((await allPageRows()).find(row => row.id === oldest.id).text, '另一个窗口的旧页修改');
  pass('An old-page revision conflict preserves its draft, disables stale saving and never fetches a new revision to force overwrite');
  assert.equal(exceptions.length, 0, exceptions.join('\n')); assert.deepEqual(await app.api('/api/providers'), []);
  pass('Real Chrome persona editing sends only persona and leaves all relationship fields unchanged, without runtime exceptions or model access');
} catch (error) {
  failures.push(error.stack); process.exitCode = 1;
  if (cdp?.socket.readyState === WebSocket.OPEN) await screenshot('failure').catch(() => {});
}
finally {
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
        'Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "chrome.exe" -and $_.CommandLine -and $_.CommandLine.Contains($env:DIMENSION_RELATION_CHROME_PROFILE) } | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'],
      { cwd: config.output, windowsHide: true, timeout: 15000, env: { ...process.env, DIMENSION_RELATION_CHROME_PROFILE: profile } });
      if (result.stdout.trim()) { const value = JSON.parse(result.stdout); residualChrome = Array.isArray(value) ? value : [value]; }
      if (residualChrome.length) failures.push('Test Chrome profile still has running processes.');
    } catch (error) { failures.push('Could not verify test Chrome process cleanup: ' + error.message); }
  }
  const processes = config.processes.map(entry => ({ label: entry.label, pid: entry.child.pid, exitCode: entry.child.exitCode, signal: entry.child.signalCode }));
  if (processes.some(entry => entry.exitCode !== 0)) failures.push('A test process did not exit normally.');
  const report = { ok: failures.length === 0 && exceptions.length === 0, checks, failures, exceptions, requests, responses, blockedExternal, screenshots,
    fingerprints: config.fingerprints, processes, residualChrome, productionDataUsed: false, modelRequests: 0, scope: 'New synthetic native database, real Chrome with an isolated L: profile, actual APIs and one detached-editor stale-click injection.' };
  if (!report.ok) process.exitCode = 1;
  await writeFile(path.join(config.output, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ok: report.ok, checks: checks.length, output: config.output }));
}
