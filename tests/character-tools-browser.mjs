import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseOptions, setup, startNative, cleanup, digest, until } from './relation-notes-api.mjs';
import { startFixture } from './app-integration.mjs';
import { startBrowser } from './native-browser-fixture.mjs';

const options = parseOptions(), config = await setup(options, 'phase3-character-tools-browser');
const checks = [], failures = [], pass = text => { checks.push(text); console.log('PASS ' + text); };
const alpha = 'draft-api-alpha', beta = 'draft-api-beta';
let app, fixture, browser, browserStopped = false;
const persona = bot => app.api('/api/dimension/persona?botId=' + bot);
const genPath = bot => '/api/dimension/bots/' + bot + '/persona-gen';
const currentText = value => value.fields.find(row => row.key === 'persona').content;
const catalog = (sourceId, count = 57) => ({ format: 'dimension-character-directory', version: 1,
  source: { id: sourceId, name: '自制目录 ' + sourceId, url: 'https://example.test/' + sourceId + '.json', license: 'Synthetic original fixture' },
  entries: Array.from({ length: count }, (_, i) => ({ id: 'stable-' + String(i).padStart(3, '0'), name: '角色 ' + sourceId + ' ' + i,
    series: '合成系列 ' + sourceId, persona: '目录原始人设 ' + sourceId + ' ' + i })) });
async function startDraft(bot, brief) {
  const profile = await persona(bot);
  return app.api(genPath(bot), { brief, baseRevision: profile.profileRevision }, 'POST', 202);
}
async function settle(bot, job) {
  return until(async () => {
    const row = await app.api(genPath(bot) + '/' + job.draftId);
    return ['ready', 'failed', 'cancelled'].includes(row.status) ? row : null;
  }, 'persona draft terminal', 20000);
}
try {
  config.fingerprints.test = digest(await readFile(import.meta.filename));
  config.fingerprints.browserHelper = digest(await readFile(new URL('./native-browser-fixture.mjs', import.meta.url)));
  app = await startNative({ ...config, label: 'native' });
  for (const id of [alpha, beta]) await app.api('/api/dimension/bots', { id, name: id, persona: 'original ' + id });
  let listing = await app.api('/api/dimension/library'); assert.equal(listing.snapshotOnly, true);
  assert.deepEqual(listing.results, []); assert.equal(listing.owned.length, 2);
  const initialRevision = listing.directoryRevision, apiCatalog = catalog('api-source');
  await app.api('/api/dimension/library/catalog', { catalog: apiCatalog, baseRevision: initialRevision });
  listing = await app.api('/api/dimension/library?q=api-source');
  assert.equal(listing.results.length, 40); assert.equal(listing.total, 57); assert.equal(listing.hasMore, true);
  const second = await app.api('/api/dimension/library?q=api-source&offset=40&revision=' + listing.directoryRevision);
  assert.equal(second.results.length, 17); assert.equal(new Set([...listing.results, ...second.results].map(row => row.entryId)).size, 57);
  assert.equal((await app.api('/api/dimension/library?q=missing')).results.length, 0);
  await app.api('/api/dimension/library?offset=40', undefined, 'GET', 409);
  const selected = listing.results[0], identity = ({ sourceId, entryId, revision }) => ({ sourceId, entryId, revision });
  const imported = await app.api('/api/dimension/library/import', identity(selected));
  assert.equal(imported.origin.sourceId, 'api-source'); assert.equal(imported.origin.entryId, selected.entryId);
  assert.equal((await app.api('/api/dimension/library/import', identity(selected))).bot.id, imported.bot.id);
  await app.api('/api/dimension/persona?botId=' + imported.bot.id, { values: { persona: '用户后来编辑的人设' } });
  assert.equal((await app.api('/api/dimension/library/import', identity(selected))).bot.persona, '用户后来编辑的人设');
  const changed = structuredClone(apiCatalog); changed.entries[0].name = '目录名称已更新';
  await app.api('/api/dimension/library/catalog', { catalog: changed, baseRevision: listing.directoryRevision });
  await app.api('/api/dimension/library/import', identity(selected), 'POST', 409);
  await app.api('/api/dimension/library?q=api-source&offset=40&revision=' + listing.directoryRevision, undefined, 'GET', 409);
  const fresh = (await app.api('/api/dimension/library?q=目录名称已更新')).results[0];
  assert.equal((await app.api('/api/dimension/library/import', identity(fresh))).bot.id, imported.bot.id);
  await app.api('/api/dimension/library/import', { rank: 1 }, 'POST', 400);
  for (const invalid of [{ ...apiCatalog, surprise: true }, { ...apiCatalog, version: 2 },
    { ...apiCatalog, entries: [apiCatalog.entries[0], apiCatalog.entries[0]] }])
    await app.api('/api/dimension/library/catalog', { catalog: invalid, baseRevision: (await app.api('/api/dimension/library')).directoryRevision }, 'POST', 400);
  assert.equal(currentText(await persona(imported.bot.id)), '用户后来编辑的人设');
  pass('Explicit catalog snapshots paginate by revision, import by stable source/entry identity, reject stale/rank/invalid writes and preserve edited Bots');

  fixture = await startFixture(); fixture.gate('persona_hold');
  await app.api('/api/providers', { name: 'synthetic', entry: { kind: 'openai-chat-compat', baseUrl: fixture.baseUrl, spec: { model: 'fixture-flash' } }, secretValue: 'synthetic-key' });
  const providers = await app.api('/api/providers'), original = await persona(alpha);
  let job = await settle(alpha, await startDraft(alpha, 'APPTEST:persona_ready 简短工作伙伴'));
  assert.equal(job.status, 'ready'); assert.equal(job.persona, 'Chat reply persona_ready 🙂');
  assert.equal(currentText(await persona(alpha)), currentText(original));
  await app.api(genPath(beta) + '/' + job.draftId, undefined, 'GET', 404);
  const applied = await app.api(genPath(alpha) + '/' + job.draftId + '/apply', { persona: '编辑后的真实草稿', baseRevision: job.baseRevision });
  assert.equal(applied.saved, true); assert.equal(currentText(await persona(alpha)), '编辑后的真实草稿');
  job = await settle(alpha, await startDraft(alpha, 'APPTEST:persona_conflict'));
  await app.api('/api/dimension/persona?botId=' + alpha, { values: { persona: '其他窗口已经修改' } });
  await app.api(genPath(alpha) + '/' + job.draftId + '/apply', { persona: 'must not overwrite', baseRevision: job.baseRevision }, 'POST', 409);
  assert.equal((await app.api(genPath(alpha) + '/' + job.draftId)).status, 'ready');
  assert.equal(currentText(await persona(alpha)), '其他窗口已经修改');
  const failed = await settle(alpha, await startDraft(alpha, 'APPTEST:chat_error'));
  assert.equal(failed.status, 'failed'); assert.equal(failed.persona, ''); assert(!failed.error.includes('synthetic-key'));
  const held = await startDraft(alpha, 'APPTEST:persona_hold');
  await fixture.pending('persona_hold');
  await app.api(genPath(alpha) + '/' + held.draftId, undefined, 'DELETE');
  assert.equal((await settle(alpha, held)).status, 'cancelled');
  assert.equal(currentText(await persona(alpha)), '其他窗口已经修改');
  assert.deepEqual(await app.api('/api/providers'), providers);
  assert(fixture.records.filter(row => row.tag.startsWith('persona')).every(row => row.body.model === 'fixture-flash' && row.body.max_tokens <= 2048));
  pass('Actual model protocol returns bounded drafts without saving; editable apply uses CAS, cross-Bot access/failure/cancellation preserve profiles and selected model');

  browser = await startBrowser(config, app.origin, options.get('chrome'));
  const { evaluate, click, replace, screenshot, closeEditor } = browser;
  await until(() => evaluate('!!document.querySelector("#botList [data-id=draft-api-alpha]")'), 'native roster');
  async function openLibrary() {
    await closeEditor(); await click('#newBotBtn'); await click('#createMenuBot'); await click('#openLibraryBtn');
    await until(() => evaluate('document.querySelector("#librarySources").textContent.includes("api-source")'), 'library snapshot loaded');
  }
  async function fileInput(selector, file) {
    const doc = await browser.cdp.call('DOM.getDocument');
    const input = await browser.cdp.call('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
    assert(input.nodeId); await browser.cdp.call('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [file] });
  }
  await openLibrary();
  const catalogFile = path.join(config.output, 'ui-catalog.json');
  await writeFile(catalogFile, JSON.stringify(catalog('ui-source', 42)), 'utf8');
  await fileInput('#libraryCatalogFile', catalogFile);
  await until(() => evaluate('document.querySelector("#libraryCatalogMsg").textContent.includes("快照已导入")'), 'real file catalog import');
  await replace('#librarySearch', 'ui-source');
  await until(() => evaluate('document.querySelectorAll("#libraryResults [data-source-id=ui-source]").length===40'), 'first directory page');
  await click('#libraryMore');
  await until(() => evaluate('document.querySelectorAll("#libraryResults [data-source-id=ui-source]").length===42'), 'all directory pages');
  await screenshot('01-directory-stable-source-pages');
  const uiIdentity = await evaluate('(() => {const e=document.querySelector("#libraryResults [data-source-id=ui-source]");return {sourceId:e.dataset.sourceId,entryId:e.dataset.entryId,revision:e.dataset.entryRevision}})()');
  await click('#libraryResults [data-source-id=ui-source]');
  await until(() => evaluate('document.querySelector("#modal").hidden'), 'real directory import');
  const importRequest = browser.requests.filter(row => row.pathname === '/api/dimension/library/import').at(-1);
  assert.deepEqual(importRequest.body, uiIdentity);
  const uiImported = await app.api('/api/dimension/library/import', uiIdentity), uiBot = uiImported.bot.id;
  assert.equal((await app.api('/api/dimension/bots/' + uiBot + '/origin')).origin.sourceId, 'ui-source');
  pass('Chrome uploads a real JSON file, searches/paginates 42 entries with visible provenance, and imports exact stable IDs without rank');
  await openLibrary();
  browser.failNext(request => new URL(request.url).pathname === '/api/dimension/library');
  await replace('#librarySearch', 'transport-error');
  await until(() => evaluate('document.querySelector("#libraryResults").textContent.includes("fetch")'), 'directory network failure displayed');
  await replace('#librarySearch', 'no-matching-character-zzz');
  await until(() => evaluate('document.querySelector("#libraryResults").textContent.includes("没有匹配")'), 'genuine no results displayed');
  await closeEditor();
  pass('Directory transport failure is visibly distinct from a successful search with no matches');

  await click('#botList [data-id="' + uiBot + '"]');
  async function openDraft() {
    await closeEditor();
    if (await evaluate('document.querySelector("#drawer").hidden')) await click('#identityBtn');
    await click('[data-open=persona]'); await until(() => evaluate('!!document.querySelector("#draftPersona")'), 'persona editor');
    await click('#draftPersona'); await until(() => evaluate('!!document.querySelector("#genPersonaBtn")'), 'draft editor');
  }
  async function generate(brief) {
    await replace('#botIntroText', brief); await click('#genPersonaBtn');
    await until(() => evaluate('document.querySelector("#botIntroMsg").textContent.includes("尚未保存")'), 'editable draft generated');
  }
  const beforeUi = currentText(await persona(uiBot));
  await openDraft(); await generate('APPTEST:persona_browser');
  assert.equal(currentText(await persona(uiBot)), beforeUi);
  assert.equal(await evaluate('document.querySelector("#botIntroResult").value'), 'Chat reply persona_browser 🙂');
  await replace('#botIntroResult', '用户逐字编辑并保存的草稿 中文🙂');
  await screenshot('02-persona-editable-unsaved-draft');
  await click('#savePersonaDraft');
  await until(() => evaluate('document.querySelector("#botIntroMsg").textContent.includes("草稿已保存")'), 'explicit draft apply');
  assert.equal(currentText(await persona(uiBot)), '用户逐字编辑并保存的草稿 中文🙂');
  pass('Chrome generation displays editable unsaved text, then explicit Save applies exactly the edited draft to its captured Bot');
  await openDraft(); await generate('APPTEST:persona_browser_conflict');
  await replace('#botIntroResult', '应保留的未保存草稿');
  await app.api('/api/dimension/persona?botId=' + uiBot, { values: { persona: '外部并发修改' } });
  const gets = browser.requests.filter(row => row.pathname === '/api/dimension/persona' && row.method === 'GET').length;
  await click('#savePersonaDraft');
  await until(() => evaluate('document.querySelector("#botIntroMsg").textContent.includes("草稿保留")'), 'draft conflict shown');
  assert.equal(await evaluate('document.querySelector("#botIntroResult").value'), '应保留的未保存草稿');
  assert.equal(await evaluate('document.querySelector("#savePersonaDraft").disabled'), true);
  assert.equal(browser.requests.filter(row => row.pathname === '/api/dimension/persona' && row.method === 'GET').length, gets);
  assert.equal(currentText(await persona(uiBot)), '外部并发修改');
  await screenshot('03-persona-conflict-preserves-draft');
  pass('Concurrent profile edits produce 409, preserve draft, disable stale saving and never silently adopt a newer version');
  await openDraft(); await generate('APPTEST:persona_detached');
  await evaluate('window.__oldDraftSave=document.querySelector("#savePersonaDraft")');
  await closeEditor(); await click('#botList [data-id=draft-api-beta]');
  const applies = browser.requests.filter(row => row.pathname.endsWith('/apply')).length;
  await evaluate('window.__oldDraftSave.click()');
  assert.equal(browser.requests.filter(row => row.pathname.endsWith('/apply')).length, applies);
  assert.equal(currentText(await persona(beta)), 'original ' + beta);
  assert.deepEqual(browser.exceptions, []); assert.deepEqual(browser.blockedExternal, []); assert.deepEqual(fixture.errors, []);
  pass('Detached draft actions after switching Bot cannot save, and the browser reports no runtime exceptions or external traffic');
  await browser.stop(); browserStopped = true;
  const finalPersona = currentText(await persona(uiBot));
  await app.stop(); app = await startNative({ ...config, label: 'native-restart' });
  assert.equal(currentText(await persona(uiBot)), finalPersona);
  assert.equal((await app.api('/api/dimension/library/import', uiIdentity)).bot.id, uiBot);
  assert.equal((await app.api('/api/dimension/bots/' + uiBot + '/origin')).origin.sourceId, 'ui-source');
  assert.equal((await app.api('/api/dimension/library?q=ui-source')).total, 42);
  pass('Directory snapshots, stable origin mappings and explicitly saved profiles survive a real native restart');
} catch (error) {
  failures.push(error.stack); process.exitCode = 1;
  if (browser && !browserStopped) await browser.screenshot('failure').catch(() => {});
} finally {
  if (browser && !browserStopped) await browser.stop().catch(error => failures.push(error.message));
  if (app?.child.exitCode === null) await app.stop().catch(error => failures.push(error.message));
  if (fixture) await fixture.close().catch(error => failures.push(error.message));
  await cleanup(config).catch(error => failures.push(error.message));
  const processes = config.processes.map(entry => ({ label: entry.label, pid: entry.child.pid, exitCode: entry.child.exitCode, signal: entry.child.signalCode }));
  if (processes.some(entry => entry.exitCode !== 0)) failures.push('A test process did not exit normally.');
  const report = { ok: !failures.length, checks, failures, fingerprints: config.fingerprints, processes, traces: config.traces,
    requests: browser?.requests, responses: browser?.responses, screenshots: browser?.screenshots, exceptions: browser?.exceptions, blockedExternal: browser?.blockedExternal,
    modelRequests: (fixture?.records || []).map(row => ({ tag: row.tag, model: row.body.model, promptSha256: digest(JSON.stringify(row.body)) })),
    fixtureErrors: fixture?.errors, productionDataUsed: false, externalModelRequests: 0 };
  if (!report.ok) process.exitCode = 1;
  await writeFile(path.join(config.output, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ok: report.ok, checks: checks.length, output: config.output }));
}
