import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseOptions, setup, startNative, cleanup, memoryRoute, digest, until } from './relation-notes-api.mjs';
import { rawImport, excluded } from './archive-export-api.mjs';
import { startBrowser } from './native-browser-fixture.mjs';

const options = parseOptions(), config = await setup(options, 'phase3-mid-memory-browser');
const checks = [], failures = [], pass = name => { checks.push(name); console.log('PASS ' + name); };
const day = 86400000, alpha = 'mid-api-alpha', beta = 'mid-api-beta', uiBot = 'mid-browser';
let app, browser;
const route = bot => memoryRoute(bot);
const post = (bot, body, status = 200) => app.api(route(bot), { ...body, botId: bot }, 'POST', status);
const row = (result, id) => result.mid.find(item => item.id === id);
const byText = (result, text) => result.mid.find(item => item.text === text);
const card = id => '#midMemoryEntries [data-id="' + id + '"]';
async function seedExpired(bot) {
  const b = (await app.api('/api/dimension/bootstrap')).bots.find(item => item.id === bot);
  return rawImport(app, { format: 'dimension-conversation-archive', version: 3, coverage: 'conversation-and-group-data',
    excludedTypes: [...excluded], bots: [{ id: b.id, name: b.name, persona: b.persona, inChat: b.chat, inWork: b.work }],
    groups: [], conversations: [], memories: [], midMemories: [{ id: '9007199254740993', botId: bot, groupId: '',
      text: '已过期的评审提醒：原文保留', sourceActor: 'user', revision: '7', createdAtMs: '1000', updatedAtMs: '2000',
      expiresAtMs: '86401000', strength: 3 }] }, 'synthetic-mid-expired-' + bot);
}
try {
  config.fingerprints.test = digest(await readFile(import.meta.filename));
  config.fingerprints.browserHelper = digest(await readFile(new URL('./native-browser-fixture.mjs', import.meta.url)));
  app = await startNative({ ...config, label: 'native' });
  for (const id of [alpha, beta, uiBot]) await app.api('/api/dimension/bots', { id, name: id, persona: '合成人设 ' + id });
  const first = await app.api(route(alpha));
  assert.equal(first.midMemoryVersion, 1); assert.equal(first.midDefaultDays, 7); assert.deepEqual(first.mid, []);
  const before = Date.now();
  let result = await post(alpha, { action: 'add-mid', text: '  精确保留正文 🌱  ' });
  const created = byText(result, '  精确保留正文 🌱  '); assert(created);
  assert.equal(created.revision, '1'); assert.equal(created.sourceActor, 'user'); assert.equal(created.strength, 1);
  assert.equal(BigInt(created.expiresAtMs) - BigInt(created.createdAtMs), BigInt(7 * day));
  assert(Number(created.createdAtMs) >= before && Number(created.createdAtMs) <= Date.now());
  assert.equal(created.expired, false); assert.deepEqual(result.entries, []); assert.deepEqual(result.candidates, []);
  pass('Native empty mid editor contract, exact user text, server clock, explicit source and default seven-day expiry');
  for (const body of [
    { action: 'add-mid', text: 'x', days: 0 }, { action: 'add-mid', text: 'x', days: 31 },
    { action: 'add-mid', text: 'x', days: '7' }, { action: 'add-mid', text: 'x', days: 1.5 },
    { action: 'add-mid', text: 'x', nowMs: '1' }, { action: 'add-mid', text: 'x', sourceActor: 'bot' },
    { action: 'add-mid', text: ' ' }, { action: 'add-mid', text: 'x'.repeat(16385) },
    { action: 'save-mid', mid: [{ id: created.id, text: 'unversioned' }] },
    { action: 'reinforce-mid', id: created.id },
  ]) await post(alpha, body, 400);
  await app.api(route(alpha), { action: 'add-mid', text: 'missing explicit Bot' }, 'POST', 400);
  await post(beta, { action: 'save-mid', mid: [{ id: created.id, revision: '1', text: 'other Bot' }] }, 404);
  await app.api(route(alpha) + '&groupId=synthetic-group', { action: 'reinforce-mid', botId: alpha, id: created.id, revision: '1' }, 'POST', 404);
  assert.deepEqual((await app.api(route(beta))).mid, []);
  pass('Invalid duration/clock/source/text/unversioned edits and cross-Bot/group mutations reject without changes');
  result = await post(alpha, { action: 'save-mid', mid: [{ id: created.id, revision: '1', text: '修改正文而不续期' }] });
  let edited = row(result, created.id);
  assert.equal(edited.revision, '2'); assert.equal(edited.expiresAtMs, created.expiresAtMs); assert.equal(edited.strength, 1);
  result = await post(alpha, { action: 'save-mid', mid: [{ id: created.id, revision: '2', text: edited.text }] });
  assert.equal(row(result, created.id).revision, '2');
  const companion = byText(await post(alpha, { action: 'add-mid', text: 'companion' }), 'companion');
  await post(alpha, { action: 'save-mid', mid: [{ id: companion.id, revision: '1', text: 'must roll back' }, { id: created.id, revision: '1', text: 'stale' }] }, 409);
  assert.equal(row(await app.api(route(alpha)), companion.id).text, 'companion');
  result = await post(alpha, { action: 'reinforce-mid', id: created.id, revision: '2', days: 1 });
  edited = row(result, created.id);
  assert.equal(edited.revision, '3'); assert.equal(edited.strength, 2);
  assert.equal(BigInt(edited.expiresAtMs) - BigInt(created.expiresAtMs), BigInt(day));
  await post(alpha, { action: 'save-mid', mid: [{ id: companion.id, revision: '1', text: '' }] });
  assert(!row(await app.api(route(alpha)), companion.id));
  pass('Edits preserve expiry, no-op preserves revision, stale batches roll back atomically, and explicit reinforcement/deletion work');
  await seedExpired(alpha);
  let expired = byText(await app.api(route(alpha)), '已过期的评审提醒：原文保留');
  assert.equal(expired.expired, true); assert.equal(expired.expiresAtMs, '86401000'); assert.equal(expired.revision, '7');
  result = await post(alpha, { action: 'save-mid', mid: [{ id: expired.id, revision: '7', text: '已过期原文仍可编辑' }] });
  expired = row(result, expired.id); assert.equal(expired.expired, true); assert.equal(expired.expiresAtMs, '86401000');
  const archive = await app.api('/api/native/archive/export', {}, 'POST');
  assert.equal(archive.archive.version, 3);
  const archived = archive.archive.midMemories.find(item => item.botId === alpha && item.text === expired.text);
  assert.equal(archived.expiresAtMs, expired.expiresAtMs); assert.equal(archived.revision, expired.revision);
  assert.equal(archive.counts.midMemories, archive.archive.midMemories.length);
  pass('Expired records remain visible and editable, and real user archive export retains original times and revisions');
  const retained = (await app.api(route(alpha))).mid;
  await app.stop(); app = await startNative({ ...config, label: 'native-restart' });
  assert.deepEqual((await app.api(route(alpha))).mid, retained);
  pass('Typed mid records, expired originals and metadata survive a real native restart');

  await app.api('/api/dimension/bots/' + uiBot + '/activate', {});
  browser = await startBrowser(config, app.origin, options.get('chrome'));
  const { evaluate, click, replace, openMemory, screenshot, closeEditor } = browser;
  await until(() => evaluate('!!document.querySelector("#botList [data-id=mid-browser]")'), 'real native Bot list');
  await click('#botList [data-id=mid-browser]');
  await until(() => evaluate('!document.querySelector("#identityBtn").hidden'), 'explicitly selected Bot');
  await openMemory();
  assert.equal(await evaluate('document.querySelector("#newMidDays").value'), '7');
  assert.equal(await evaluate('document.querySelector("#newMidDays").options.length'), 30);
  assert.match(await evaluate('document.querySelector("#midMemorySection").textContent'), /还没有中期记忆/);
  const html = '</textarea><img id="midInjected" src="x" onerror="window.__midXss=1"> 中期中文🙂';
  await replace('#newMidMemory', html); await click('#addMidMemory');
  await until(() => evaluate('document.querySelector("#midMemoryMsg").textContent.includes("已新增")'), 'new mid saved');
  let uiRow = byText(await app.api(route(uiBot)), html); assert(uiRow);
  assert.equal(await evaluate('!!document.querySelector("#midInjected")||!!window.__midXss'), false);
  assert.equal(await evaluate('document.querySelector("#newMidMemory").value'), '');
  await screenshot('01-mid-created');
  pass('Real Chrome creates an initial mid note with visible seven-day default and renders literal HTML safely');

  await replace(card(uiRow.id) + ' textarea', '中期草稿保持独立');
  await replace('#newMemory', '长期候选单独保存');
  const beforeMidPosts = browser.requests.filter(item => item.body?.action === 'save-mid').length;
  await click('#saveMemory'); await until(() => evaluate('document.querySelector("#memoryMsg").textContent.includes("已保存")'), 'ordinary save');
  assert.equal(browser.requests.filter(item => item.body?.action === 'save-mid').length, beforeMidPosts);
  assert.equal(row(await app.api(route(uiBot)), uiRow.id).text, html);
  assert.equal(await evaluate('document.querySelector(' + JSON.stringify(card(uiRow.id) + ' textarea') + ').value'), '中期草稿保持独立');
  await replace('[data-rel=contacts]', '关系草稿保持独立');
  await click('#saveMidMemory'); await until(() => evaluate('document.querySelector("#midMemoryMsg").textContent.includes("正文已保存")'), 'mid save');
  let updated = row(await app.api(route(uiBot)), uiRow.id);
  assert.equal(updated.expiresAtMs, uiRow.expiresAtMs); assert.equal(updated.revision, '2');
  assert.equal(await evaluate('document.querySelector("[data-rel=contacts]").value'), '关系草稿保持独立');
  const saveRequest = browser.requests.filter(item => item.body?.action === 'save-mid').at(-1).body;
  assert.deepEqual(saveRequest.mid, [{ id: uiRow.id, revision: '1', text: '中期草稿保持独立' }]);
  pass('Long-term save leaves mid drafts untouched; independent mid save sends captured revision and preserves relation draft and expiry');

  await seedExpired(uiBot); await openMemory();
  const uiExpired = byText(await app.api(route(uiBot)), '已过期的评审提醒：原文保留');
  assert.match(await evaluate('document.querySelector(' + JSON.stringify(card(uiExpired.id)) + ').textContent'), /已过期.*不参与召回/);
  await replace(card(uiRow.id) + ' textarea', '另一条未保存草稿');
  await click(card(uiExpired.id) + ' [data-mid-extend]');
  await until(() => evaluate('document.querySelector("#midMemoryMsg").textContent.includes("有效期已延长")'), 'expired note extended');
  updated = row(await app.api(route(uiBot)), uiExpired.id);
  assert.equal(updated.expired, false); assert.equal(updated.strength, 4); assert.equal(updated.revision, '8');
  assert.equal(await evaluate('document.querySelector(' + JSON.stringify(card(uiRow.id) + ' textarea') + ').value'), '另一条未保存草稿');
  await screenshot('02-expired-note-extended');
  pass('Expired original is visibly marked and explicit extension restores active status while another mid draft remains unchanged');

  const base = row(await app.api(route(uiBot)), uiRow.id);
  await post(uiBot, { action: 'save-mid', mid: [{ id: base.id, revision: base.revision, text: '另一个窗口的修改' }] });
  const beforeGets = browser.requests.filter(item => item.pathname === '/api/dimension/memory' && item.method === 'GET').length;
  await click('#saveMidMemory'); await until(() => evaluate('document.querySelector("#midMemoryMsg").textContent.includes("草稿已保留")'), 'mid stale editor');
  assert.equal(await evaluate('document.querySelector(' + JSON.stringify(card(uiRow.id) + ' textarea') + ').value'), '另一条未保存草稿');
  assert.equal(await evaluate('document.querySelector("#saveMidMemory").disabled'), true);
  assert.equal(browser.requests.filter(item => item.pathname === '/api/dimension/memory' && item.method === 'GET').length, beforeGets);
  assert.equal(row(await app.api(route(uiBot)), uiRow.id).text, '另一个窗口的修改');
  await screenshot('03-mid-conflict-keeps-draft');
  pass('Concurrent edits return 409, retain exact draft, disable stale writes and never fetch a replacement revision');
  await closeEditor(); await openMemory();
  await replace(card(uiRow.id) + ' textarea', ''); await click('#saveMidMemory');
  await until(() => evaluate('document.querySelector("#midMemoryMsg").textContent.includes("正文已保存")'), 'explicit mid delete');
  assert(!row(await app.api(route(uiBot)), uiRow.id));
  assert.deepEqual(await app.api('/api/providers'), []); assert.deepEqual(browser.exceptions, []); assert.deepEqual(browser.blockedExternal, []);
  pass('Clearing one row explicitly deletes it; no runtime exceptions, external requests or configured model providers');
} catch (error) {
  failures.push(error.stack); process.exitCode = 1;
  if (browser) await browser.screenshot('failure').catch(() => {});
} finally {
  if (browser) await browser.stop().catch(error => failures.push(error.message));
  if (app?.child.exitCode === null) await app.stop().catch(error => failures.push(error.message));
  await cleanup(config).catch(error => failures.push(error.message));
  const processes = config.processes.map(entry => ({ label: entry.label, pid: entry.child.pid, exitCode: entry.child.exitCode, signal: entry.child.signalCode }));
  if (processes.some(entry => entry.exitCode !== 0)) failures.push('A test process did not exit normally.');
  const report = { ok: !failures.length, checks, failures, fingerprints: config.fingerprints, processes,
    traces: config.traces, requests: browser?.requests, responses: browser?.responses, exceptions: browser?.exceptions,
    blockedExternal: browser?.blockedExternal, screenshots: browser?.screenshots, productionDataUsed: false, modelRequests: 0 };
  if (!report.ok) process.exitCode = 1;
  await writeFile(path.join(config.output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, checks: checks.length, output: config.output }));
}
