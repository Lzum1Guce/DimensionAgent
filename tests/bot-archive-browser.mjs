// Real Chrome downloads and file inputs against real native routes. No host input.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseOptions, until, rawImport, body, canonical, digest } from './archive-export-api.mjs';
import { startFixture } from './app-integration.mjs';
import { Cdp, startBrowser } from './native-browser-fixture.mjs';
import { setup, launch, seed, snapshot, unchanged, fields, contentFields, defaultFields, marker, prefix, png, binary,
  route, exportBot, assertPackage, cleanup, report } from './bot-archive-fixture.mjs';

const options = parseOptions(), config = await setup(options, 'bot-archive-browser');
const checks = [], failures = [], downloads = [];
const pass = text => { checks.push(text); console.log('PASS ' + text); };
let app, browser, downloadCdp, fixture;
const injected = '</p><img id="archiveInjected" src="x" onerror="window.__botXss=1"> 归档文字🙂';
try {
  app = await launch(config, 'native');
  const sample = await seed(app, 'browser-capsule'), owner = sample.ids.owner;
  const pages = { ...sample.archive, bots: sample.archive.bots.filter(item => item.id === owner), groups: [], memories: [],
    conversations: [{ botId: owner, groupId: '', mode: 'work', messages: Array.from({ length: 43 }, (_, index) => ({
      id: String(9007199254745000n + BigInt(index)), actor: index % 2 ? 'user' : 'bot', text: index === 22 ? injected : 'CAPSULE_WORK_PAGE_' + String(index).padStart(2, '0'), createdAtMs: String(1700000001000 + index) })) }] };
  await rawImport(app, pages, 'synthetic-browser-work-pages');
  fixture = await startFixture();
  await app.api('/api/providers', { name: 'synthetic', entry: { kind: 'openai-chat-compat', baseUrl: fixture.baseUrl, spec: { model: 'fixture-flash' } }, secretValue: 'synthetic-key' });
  const initial = 'APPTEST:bot_archive_browser\n归档原要求：实际 Work 回合。', supplement = 'RELEASE\n补充要求：保留中文🙂。', answer = 'Verified delivery bot_archive_browser';
  fixture.gate('bot_archive_browser');
  const start = await app.api('/api/dimension/work/runs', { botId: owner, text: initial, requestId: 'browser-original' });
  await fixture.pending('bot_archive_browser');
  assert.equal((await app.api('/api/dimension/work/runs', { botId: owner, text: supplement, requestId: 'browser-supplement' })).run.id, start.run.id);
  await until(async () => { const run = await app.api('/api/dimension/work/runs/' + start.run.id); return run.terminal && !run.executing && run.status === 'completed'; }, 'real Work round');
  const fullApi = await exportBot(app, owner, fields), smallApi = await exportBot(app, owner, ['name', 'persona']);
  assert.equal(fullApi.package.counts.workHistory, 47);
  const smallFile = path.join(config.output, 'profile-only.json'); await writeFile(smallFile, smallApi.text);
  await app.api('/api/dimension/bots/' + owner + '/activate', {});
  browser = await startBrowser(config, app.origin, options.get('chrome'));
  const { cdp, evaluate, click, screenshot } = browser;
  await until(() => evaluate('!!document.querySelector("#botList [data-id=' + owner + ']")'), 'Bot list');
  await click('#botList [data-id="' + owner + '"]');
  await until(() => evaluate('!document.querySelector("#identityBtn").hidden'), 'selected Bot');

  const downloadDirectory = path.join(config.output, 'downloads'); await mkdir(downloadDirectory, { recursive: true });
  const port = Number((await readFile(path.join(config.output, 'chrome-profile/DevToolsActivePort'), 'utf8')).split('\n')[0]);
  const version = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json();
  downloadCdp = await Cdp.connect(version.webSocketDebuggerUrl, browser.exceptions);
  downloadCdp.on('Browser.downloadWillBegin', value => downloads.push({ guid: value.guid, suggestedFilename: value.suggestedFilename, state: 'started' }));
  downloadCdp.on('Browser.downloadProgress', value => { const row = downloads.find(item => item.guid === value.guid); if (row) Object.assign(row, { state: value.state, receivedBytes: value.receivedBytes }); });
  await downloadCdp.call('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: downloadDirectory, eventsEnabled: true });
  const isOpen = id => evaluate('document.querySelector("#' + id + '").open');
  const text = id => evaluate('document.querySelector("#' + id + '").textContent');
  const disabled = id => evaluate('document.querySelector("#' + id + '").disabled');
  const selection = kind => evaluate('[...document.querySelectorAll("#botArchive' + (kind === 'export' ? 'Export' : 'Import') + 'Fields input:checked")].map(item=>item.dataset.field)');
  async function setSelection(kind, wanted) {
    for (const field of fields) {
      const selector = '#botArchive-' + kind + '-' + field;
      if (await evaluate('document.querySelector(' + JSON.stringify(selector) + ').checked') !== wanted.includes(field)) await click(selector);
    }
  }
  async function fileInput(file) {
    await until(async () => !await disabled('botArchiveFile'), 'file input ready after any cancellation');
    const root = await cdp.call('DOM.getDocument');
    const { nodeId } = await cdp.call('DOM.querySelector', { nodeId: root.root.nodeId, selector: '#botArchiveFile' });
    await cdp.call('DOM.setFileInputFiles', { nodeId, files: [file] });
    await until(() => evaluate('!document.querySelector("#botArchiveImportChoices").hidden && !document.querySelector("#botArchiveFile").disabled'), 'archive inventory loaded');
  }
  async function openImport(recovery = false) {
    if (await isOpen('botArchiveDialog')) await click('#botArchiveClose');
    if (await evaluate('!document.querySelector("#modal").hidden')) await browser.closeEditor();
    await click('#conversationArchiveBtn');
    await until(() => isOpen('conversationArchiveDialog'), 'global archive');
    await click('#archiveImportBot');
    await until(async () => await isOpen('botArchiveDialog') && (recovery || !await disabled('botArchiveFile')), 'Bot import enabled');
  }
  async function downloaded(wanted) {
    const oldCount = downloads.length;
    await click('#botArchiveExport');
    const entry = await until(() => downloads.slice(oldCount).find(item => item.state === 'completed'), 'real Chrome download');
    const file = path.join(downloadDirectory, entry.guid), bytes = await readFile(file), raw = bytes.toString('utf8');
    const value = assertPackage(JSON.parse(raw), wanted, raw);
    Object.assign(entry, { file, bytes: bytes.length, sha256: digest(bytes), fields: value.fields, counts: value.counts });
    assert.equal(entry.suggestedFilename, 'DimensionAgent-bot.json');
    await until(() => evaluate('!document.querySelector("#botArchiveExportResult").hidden'), 'export counts');
    assert((await text('botArchiveExportResult')).includes(bytes.length.toLocaleString()));
    return { file, value, raw };
  }
  assert.equal((await text('conversationArchiveBtn')).trim(), '归档');
  await click('#conversationArchiveBtn'); await until(() => isOpen('conversationArchiveDialog'), 'renamed archive dialog');
  assert.equal(await evaluate('document.querySelector("#conversationArchiveDialog h2").textContent'), '归档');
  assert.equal((await text('archiveExport')).trim(), '导出全部归档');
  await screenshot('01-global-archive'); await click('#archiveClose');
  await click('#identityBtn'); await click('#botArchiveBtn');
  await until(async () => await isOpen('botArchiveDialog') && !await disabled('botArchiveExport'), 'Bot export ready');
  assert.deepEqual(await selection('export'), defaultFields);
  assert((await text('botArchiveLimits')).includes('16,769,024'));
  await screenshot('02-default-export');
  await setSelection('export', ['name', 'persona']);
  const small = await downloaded(['name', 'persona']);
  for (const secret of [body('PRIVATE_CONFIRMED'), marker.relation, marker.mid, png.toString('base64'), owner]) assert(!small.raw.includes(secret));
  await setSelection('export', fields); const full = await downloaded(fields);
  assert.equal(full.value.packageSha256, fullApi.package.packageSha256);
  pass('Renamed global archive retains full export; Bot drawer defaults exclude ID/histories/avatar, and actual Chrome downloads contain only selected fields with exact displayed bytes/counts');

  await openImport();
  const beforeCancel = await snapshot(config, app, 'before-browser-preview');
  await fileInput(full.file);
  assert.deepEqual(await selection('import'), []); assert(await disabled('botArchiveCommit'));
  assert.equal(await evaluate('document.querySelectorAll("#botArchiveImportFields input:disabled").length'), 0);
  const inventoryText = await text('botArchiveDialog');
  for (const secret of [prefix, 'SYNTH_EXPORT_BODY_', png.toString('base64'), injected, owner]) assert(!inventoryText.includes(secret));
  await setSelection('import', ['persona', 'longTermMemory']); await click('#botArchivePrepare');
  await until(async () => !await disabled('botArchiveCommit'), 'explicit selected preview');
  assert.equal(await evaluate('document.querySelectorAll("#botArchiveCounts li").length'), 2);
  await screenshot('03-selective-import-preview');
  await unchanged(config, app, beforeCancel, 'browser-preview-no-write');
  await click('#botArchiveCancel'); await until(() => evaluate('document.querySelector("#botArchiveImportChoices").hidden'), 'cancel reset');
  await unchanged(config, app, beforeCancel, 'browser-cancel-no-write');
  pass('File picker starts with no selected fields; count-only preview requires explicit choices; cancelling leaves the complete synthetic database unchanged');

  await fileInput(full.file); await setSelection('import', ['name', 'id']); await click('#botArchivePrepare');
  await until(() => text('botArchiveConflicts').then(value => value.includes('已被使用')), 'existing-ID warning');
  assert(await disabled('botArchiveCommit')); assert((await text('botArchiveTarget')).includes(owner));
  await screenshot('04-id-conflict');
  await unchanged(config, app, beforeCancel, 'browser-id-conflict-no-write');
  await click('#botArchiveCancel');
  await fileInput(smallFile);
  for (const field of fields.filter(key => !['name', 'persona'].includes(key))) assert(await disabled('botArchive-import-' + field));
  assert((await text('botArchiveImportFields')).includes('归档未包含')); await click('#botArchiveClose');
  pass('Retain-ID conflict disables confirmation without writes, and fields absent from a profile-only archive are visibly disabled');

  await openImport(); await fileInput(full.file); await click('#botArchiveSelectAll');
  assert.deepEqual(await selection('import'), contentFields); assert.equal(await evaluate('document.querySelector("#botArchive-import-id").checked'), false);
  await click('#botArchivePrepare'); await until(async () => !await disabled('botArchiveCommit'), 'all content preview');
  await click('#botArchive-import-avatar'); assert(await disabled('botArchiveCommit'));
  assert((await text('botArchiveTarget')).includes('选择已改变'));
  await click('#botArchive-import-avatar'); await click('#botArchivePrepare'); await until(async () => !await disabled('botArchiveCommit'), 'renewed selection preview');
  const importedId = (await text('botArchiveTarget')).match(/import-[0-9a-f]{32}/)?.[0]; assert(importedId);
  await screenshot('05-full-import-preview');
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate('document.querySelector("#botArchiveDialog").scrollTop=0');
  const layout = await evaluate('(()=>{const d=document.querySelector("#botArchiveDialog"),r=d.getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth,columns:getComputedStyle(document.querySelector("#botArchiveImportFields")).gridTemplateColumns,scroll:d.scrollWidth,client:d.clientWidth}})()');
  assert(layout.left >= 0 && layout.right <= layout.width && layout.scroll <= layout.client + 1);
  assert.equal(layout.columns.split(' ').length, 1); await screenshot('06-mobile-import');
  await cdp.call('Emulation.clearDeviceMetricsOverride');
  pass('Select-all keeps original ID opt-in, changing choices invalidates confirmation, and the narrow layout stays within the viewport');

  const modelCallsBeforeImport = fixture.records.length;
  // Let the real commit complete, then simulate losing that response to the UI.
  await evaluate('window.__archiveOriginalFetch=window.fetch;window.__archiveDropCommit=true;window.fetch=async function(...args){const response=await window.__archiveOriginalFetch.apply(this,args);if(window.__archiveDropCommit&&String(args[0]).endsWith("/api/native/bot-archive/commit")){window.__archiveDropCommit=false;await response.arrayBuffer();throw new TypeError("Synthetic lost commit response")}return response}');
  await click('#botArchiveCommit');
  await until(() => text('botArchiveCommit').then(value => value === '核对导入结果'), 'uncertain commit recovery');
  assert(await disabled('botArchiveFile')); assert(await disabled('botArchiveCancel'));
  assert((await app.api('/api/dimension/library')).owned.some(item => item.id === importedId));
  await screenshot('07-retry-import-result');
  await click('#botArchiveClose'); await openImport(true);
  assert.equal(await text('botArchiveCommit'), '核对导入结果');
  await click('#botArchiveCommit');
  await until(() => evaluate('!document.querySelector("#botArchiveImportDone").hidden'), 'same-token commit recovered');
  assert((await text('botArchiveImportDone')).includes(importedId));
  const commits = browser.requests.filter(item => item.pathname === route + '/commit');
  assert.equal(commits.length, 2); assert.equal(commits[0].body.token, commits[1].body.token);
  assert.equal((await app.api('/api/dimension/library')).owned.filter(item => item.id === importedId).length, 1);
  assert.equal(fixture.records.length, modelCallsBeforeImport);
  await evaluate('window.fetch=window.__archiveOriginalFetch');
  assert.deepEqual((await app.api('/api/dimension/work/sessions?botId=' + importedId)).runs, []);
  const copied = await exportBot(app, importedId, contentFields);
  for (const textValue of [initial, supplement, answer, injected]) assert(copied.package.data.workHistory.some(row => row.text === textValue));
  assert.equal(digest((await binary(app, '/api/dimension/bots/' + importedId + '/avatar')).bytes), digest(png));
  await screenshot('08-import-complete'); await click('#botArchiveClose');
  pass('A lost response after real commit keeps the same token across close/reopen; result-check retries idempotently, creates one Bot and starts no model request or runnable task');

  if (await evaluate('!document.querySelector("#drawer").hidden')) await click('#identityBtn');
  await click('#newBotBtn'); await click('#createMenuBot'); await click('#openLibraryBtn');
  await until(() => evaluate('!!document.querySelector("[data-bot-archive-export=' + importedId + ']")'), 'imported library entry');
  assert.equal(await disabled('libraryImportBotArchive'), false);
  assert.equal(await evaluate('document.querySelector("[data-bot-archive-export=' + owner + ']").disabled'), false);
  await screenshot('09-library-imported-bot');
  await click('[data-bot-id="' + importedId + '"]');
  await until(() => evaluate('document.querySelector("#modal").hidden'), 'library Bot selected');
  await click('#botList [data-id="' + importedId + '"]');
  await click('#identityBtn'); await click('#archivedWorkBtn');
  await until(() => evaluate('document.querySelectorAll("#archivedWorkMessages article").length===40'), 'archived Work page');
  assert.equal(await evaluate('document.querySelector("#archivedWorkMore").hidden'), false);
  const firstPageText = await text('archivedWorkMessages');
  for (const value of [initial, supplement, answer, injected]) assert(firstPageText.includes(value));
  assert.equal(await evaluate('!!document.querySelector("#archiveInjected")||!!window.__botXss'), false);
  assert.equal(await evaluate('document.querySelectorAll("#archivedWorkDialog input,#archivedWorkDialog textarea,[data-resume]").length'), 0);
  await evaluate('document.querySelector("#archivedWorkDialog").scrollTop=0'); await screenshot('10-archived-work-first-page');
  await click('#archivedWorkMore');
  await until(() => evaluate('document.querySelectorAll("#archivedWorkMessages article").length===47'), 'older Work page');
  assert.equal(await evaluate('document.querySelector("#archivedWorkMore").hidden'), true);
  const displayed = await evaluate('[...document.querySelectorAll("#archivedWorkMessages article>p")].map(item=>item.textContent)');
  assert.deepEqual(displayed, full.value.data.workHistory.map(row => row.text));
  assert.equal(new Set(await evaluate('[...document.querySelectorAll("#archivedWorkMessages article")].map(item=>item.dataset.messageId)')).size, 47);
  await evaluate('document.querySelector("#archivedWorkDialog").scrollTop=0'); await screenshot('11-archived-work-all-pages');
  await evaluate('document.querySelector("#archivedWorkDialog").scrollTop=1e7');
  const closePosition = await evaluate('(()=>{const d=document.querySelector("#archivedWorkDialog").getBoundingClientRect(),r=document.querySelector("#archivedWorkClose").getBoundingClientRect();return r.top>=d.top&&r.bottom<=d.bottom})()');
  assert(closePosition, 'Work archive close remains visible at the bottom'); await screenshot('12-archived-work-bottom-close');
  await click('#archivedWorkClose');
  pass('Library provides import and per-Bot export even for active roster entries; imported Work text is readable in safe plain-text pages with exact order, no duplicate rows and no resume controls');

  const malformed = path.join(config.output, 'duplicate-package.json');
  await writeFile(malformed, full.raw.replace('"format":"dimension-bot-archive"', '"format":"dimension-bot-archive","format":"dimension-bot-archive"'));
  await openImport();
  const root = await cdp.call('DOM.getDocument'), node = await cdp.call('DOM.querySelector', { nodeId: root.root.nodeId, selector: '#botArchiveFile' });
  await cdp.call('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [malformed] });
  await until(async () => !await disabled('botArchiveFile') && (await text('botArchiveStatus')).length > 0, 'malformed JSON rejected');
  assert(await disabled('botArchiveCommit')); assert.equal(await evaluate('document.querySelector("#botArchiveImportChoices").hidden'), true);
  assert.match(await text('botArchiveStatus'), /归档格式或内容无效/);
  assert(browser.responses.some(item => item.pathname === route + '/stage' && item.status === 400));
  await click('#botArchiveClose');
  const beforeExit = await snapshot(config, app, 'before-escape-and-backdrop');
  await openImport(); await fileInput(smallFile); await setSelection('import', ['persona']); await click('#botArchivePrepare');
  await until(async () => !await disabled('botArchiveCommit'), 'escape preview ready');
  await evaluate('document.querySelector("#botArchiveDialog").scrollTop=1e7');
  assert(await evaluate('(()=>{const d=document.querySelector("#botArchiveDialog").getBoundingClientRect(),r=document.querySelector("#botArchiveClose").getBoundingClientRect();return r.top>=d.top&&r.bottom<=d.bottom})()'));
  const escapeDeletes = browser.requests.filter(item => item.pathname.startsWith(route + '/stage/') && item.method === 'DELETE').length;
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await until(async () => !await isOpen('botArchiveDialog'), 'escape closes native dialog');
  await until(() => browser.requests.filter(item => item.pathname.startsWith(route + '/stage/') && item.method === 'DELETE').length > escapeDeletes, 'escape discards stage');
  await openImport(); await fileInput(smallFile); await setSelection('import', ['persona']); await click('#botArchivePrepare');
  await until(async () => !await disabled('botArchiveCommit'), 'backdrop preview ready');
  const backdropDeletes = browser.requests.filter(item => item.pathname.startsWith(route + '/stage/') && item.method === 'DELETE').length;
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: 5, y: 5 });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: 5, y: 5 });
  await until(async () => !await isOpen('botArchiveDialog'), 'backdrop closes native dialog');
  await until(() => browser.requests.filter(item => item.pathname.startsWith(route + '/stage/') && item.method === 'DELETE').length > backdropDeletes, 'backdrop discards stage');
  await unchanged(config, app, beforeExit, 'escape-and-backdrop-no-write');
  pass('Close stays visible while scrolled; Escape and backdrop each close the preview, discard its token and leave the database unchanged');
  assert.equal(browser.exceptions.length, 0, JSON.stringify(browser.exceptions));
  assert.equal(browser.blockedExternal.length, 0); assert.deepEqual(fixture.errors, []);
  assert(!browser.requests.some(item => /chat\/completions|\/resume$/.test(item.pathname)));
  pass('Malformed duplicate-key JSON reaches strict native validation and cannot confirm; Chrome completes without script exceptions, external requests or task execution');
} catch (error) { failures.push(error.stack); console.error(error.stack); await browser?.screenshot('failure').catch(() => {}); }
finally {
  downloadCdp?.socket.close();
  await browser?.stop().catch(error => failures.push(error.stack));
  await cleanup(config, failures);
  await fixture?.close().catch(error => failures.push(error.stack));
  const safeRequests = (browser?.requests || []).map(item => ({ pathname: item.pathname.replace(/\/stage\/[a-f0-9]{32}/, '/stage/:token'), method: item.method,
    ...(item.pathname === route + '/stage' ? { selectedFields: item.body?.fields, preserveId: item.body?.preserveId } : {}),
    ...(item.pathname === route + '/export' ? { fields: item.body?.fields } : {}) }));
  await report(config, checks, failures, { downloads, screenshots: browser?.screenshots || [], exceptions: browser?.exceptions || [], blockedExternal: browser?.blockedExternal || [], requests: safeRequests,
    responses: (browser?.responses || []).map(item => ({ pathname: item.pathname.replace(/\/stage\/[a-f0-9]{32}/, '/stage/:token'), status: item.status })), fixtureErrors: fixture?.errors || [] });
}

