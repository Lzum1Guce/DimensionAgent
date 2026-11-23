// Actual native API, loopback model fixture, and isolated Chrome. Network
// failures are transport failures; no application responses are mocked.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseOptions, setup, startNative, cleanup, digest, until } from './relation-notes-api.mjs';
import { rawImport, excluded } from './archive-export-api.mjs';
import { startFixture } from './app-integration.mjs';
import { startBrowser } from './native-browser-fixture.mjs';

const options = parseOptions(), config = await setup(options, 'phase3-message-context-browser');
const checks = [], failures = [], pass = text => { checks.push(text); console.log('PASS ' + text); };
const alpha = 'quote-alpha', beta = 'quote-beta', gamma = 'quote-gamma', group = 'quote-source-group', targetGroup = 'quote-target-group', privateTarget = 'quote-private-target';
const privateText = '私有原文 </textarea><img id="quoteInjected" onerror="window.__quoteXss=1"> 中文🙂';
const firstGroup = '群聊第一条原文', secondGroup = '群聊第二条原文';
let app, fixture, browser, browserStopped = false;
const history = bot => app.api('/api/dimension/bots/' + bot + '/history?limit=99');
const groupHistory = id => app.api('/api/dimension/groups/' + id + '?limit=99&mode=discuss');
const completed = async id => until(async () => {
  const row = await app.api('/api/dimension/work/runs/' + id + '?view=1');
  if (['failed', 'cancelled', 'interrupted'].includes(row.status)) throw Object.assign(Error(JSON.stringify(row)), { fatal: true });
  return row.status === 'completed' ? row : null;
}, 'completed native Work ' + id, 25000);
try {
  for (const file of ['app.js', 'work-session-ui.js', 'message-context-ui.js', 'message-actions.css'])
    config.fingerprints[file] = digest(await readFile(path.join(config.ui, file)));
  config.fingerprints.test = digest(await readFile(import.meta.filename));
  app = await startNative({ ...config, label: 'native' });
  const bot = id => ({ id, name: id, persona: '合成人设 ' + id, inChat: true, inWork: true });
  const g = (id, member) => ({ id, name: id, ownerId: member, admins: [], members: [member], historyMembers: [member],
    inChat: true, inWork: true, deleted: false, revision: '1', seal: { shape: 'round-seal', color: 'persimmon' } });
  await rawImport(app, { format: 'dimension-conversation-archive', version: 3, coverage: 'conversation-and-group-data',
    excludedTypes: [...excluded], bots: [bot(alpha), bot(beta), bot(gamma)], groups: [g(group, alpha), g(targetGroup, beta), g(privateTarget, gamma)],
    conversations: [
      { botId: alpha, groupId: '', mode: 'chat', messages: [{ id: '1', actor: 'user', text: privateText, createdAtMs: '1000' }] },
      { botId: alpha, groupId: group, mode: 'chat', messages: [
        { id: '2', actor: 'user', text: firstGroup, createdAtMs: '2000' }, { id: '3', actor: 'bot', text: secondGroup, createdAtMs: '3000' }] }],
    memories: [], midMemories: [{ id: '1', botId: alpha, groupId: '', text: 'EXPIRED_MID_MUST_NOT_RECALL',
      revision: '1', sourceActor: 'user', createdAtMs: '1000', updatedAtMs: '1000', expiresAtMs: '2000', strength: 1 }] }, 'synthetic-context-ui');
  const mid = (botId, groupId, text) => app.api('/api/dimension/memory', { action: 'add-mid', botId, groupId, text });
  await mid(alpha, '', 'ACTIVE_PRIVATE_MID_REFERENCE'); await mid(alpha, group, 'ACTIVE_GROUP_MID_REFERENCE');
  fixture = await startFixture();
  await app.api('/api/providers', { name: 'synthetic', entry: { kind: 'openai-chat-compat', baseUrl: fixture.baseUrl, spec: { model: 'fixture-flash' } }, secretValue: 'synthetic-key' });
  const privateSource = (await history(alpha)).messages.find(row => row.text === privateText);
  const groupSources = (await groupHistory(group)).messages.filter(row => [firstGroup, secondGroup].includes(row.text));
  assert(privateSource.sourceRef); assert.equal(groupSources.length, 2);
  browser = await startBrowser(config, app.origin, options.get('chrome'));
  const { evaluate, click, replace, screenshot } = browser;
  const menu = action => '.message-action-menu [data-message-action="' + action + '"]';
  const quote = async selector => { await click(selector, 'right'); await click(menu('quote')); };
  const key = async (value, code, modifiers = 0) => {
    await browser.cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: value, code: value, windowsVirtualKeyCode: code, modifiers });
    await browser.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: value, code: value, windowsVirtualKeyCode: code, modifiers });
  };
  const wsFrames = [];
  browser.cdp.on('Network.webSocketFrameSent', event => { try { wsFrames.push(JSON.parse(event.response.payloadData)); } catch {} });
  await until(() => evaluate('!!document.querySelector("#botList [data-id=quote-alpha]")'), 'Chat roster');
  await click('#botList [data-id=quote-alpha]');
  const privateSelector = '.bubble[data-message-id="' + privateSource.messageId + '"]';
  await until(() => evaluate('!!document.querySelector(' + JSON.stringify(privateSelector) + ')?.messageSource?.sourceRef'), 'private source');
  assert.equal(await evaluate('document.querySelectorAll(".message-quote-action").length'), 0);
  await click(privateSelector, 'right');
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".message-action-menu button")].map(node=>node.textContent)'), ['引用', '复制', '删除', '转发']);
  assert.equal(await evaluate('(()=>{const r=document.querySelector(".message-action-menu").getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()'), true);
  await screenshot('00-private-context-menu');
  await key('Escape', 27); assert.equal(await evaluate('!!document.querySelector(".message-action-menu")'), false);
  await key('F10', 121, 8); await until(() => evaluate('!!document.querySelector(".message-action-menu")'), 'keyboard context menu');
  await key('Escape', 27);
  await browser.cdp.call('Browser.grantPermissions', { origin: app.origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  await click(privateSelector, 'right'); await click(menu('copy'));
  assert.equal(await evaluate('navigator.clipboard.readText()'), privateText);
  await quote(privateSelector);
  assert.match(await evaluate('document.querySelector("#groupQuoteBar").textContent'), /私有原文/);
  await replace('#composerInput', 'APPTEST:quote_private ACTIVE_PRIVATE_MID_REFERENCE'); await click('#sendBtn');
  const privateQuoted = await until(async () => (await history(alpha)).messages.find(row => row.text.startsWith('APPTEST:quote_private')), 'saved private quote');
  assert.equal(privateQuoted.context.kind, 'quote'); assert.equal(privateQuoted.context.sources[0].messageId, privateSource.messageId);
  assert.equal(privateQuoted.context.sources[0].text, privateText);
  const frame = wsFrames.find(row => row.text?.startsWith('APPTEST:quote_private')); assert(frame);
  assert.deepEqual(frame.quote, privateSource.sourceRef);
  const privatePrompt = await until(() => fixture.records.find(row => row.tag === 'quote_private'), 'private model request');
  const system = privatePrompt.body.messages.filter(row => row.role === 'system').map(row => row.content).join('\n');
  assert(system.includes('ACTIVE_PRIVATE_MID_REFERENCE')); assert(!system.includes('EXPIRED_MID_MUST_NOT_RECALL'));
  assert(!system.includes('ACTIVE_GROUP_MID_REFERENCE'));
  await until(() => evaluate('!!document.querySelector(' + JSON.stringify('.bubble[data-message-id="' + privateQuoted.messageId + '"] .message-context') + ')'), 'rendered source snapshot');
  await click('.bubble[data-message-id="' + privateQuoted.messageId + '"] .message-context summary');
  assert.equal(await evaluate('!!document.querySelector("#quoteInjected")||!!window.__quoteXss'), false);
  await screenshot('01-private-quote-source');
  pass('Chat quote submits exact backend sourceRef, persists safe source snapshot, and recalls only active private mid memory');

  await click('#groupList [data-group-id="' + group + '"]');
  const sourceSelector = '.gmsg[data-message-id="' + groupSources[0].messageId + '"]';
  await until(() => evaluate('!!document.querySelector(' + JSON.stringify(sourceSelector) + ')'), 'group source');
  await quote(sourceSelector + ' .gmsg-bubble');
  await replace('#composerInput', 'APPTEST:group_quote ACTIVE_GROUP_MID_REFERENCE'); await click('#sendBtn');
  const groupQuoted = await until(async () => (await groupHistory(group)).messages.find(row => row.text.startsWith('APPTEST:group_quote')), 'group quote saved');
  assert.equal(groupQuoted.context.sources[0].messageId, groupSources[0].messageId);
  const groupPost = browser.requests.find(row => row.pathname.endsWith('/' + group + '/say') && row.body?.text?.startsWith('APPTEST:group_quote'));
  assert.deepEqual(groupPost.body.quote, groupSources[0].sourceRef); assert.equal(typeof groupPost.body.requestId, 'string');
  await until(async () => !(await groupHistory(group)).chatting, 'group quote model finished');
  const groupPrompt = fixture.records.find(row => row.tag === 'group_quote');
  const groupSystem = groupPrompt.body.messages.filter(row => row.role === 'system').map(row => row.content).join('\n');
  assert(groupSystem.includes('ACTIVE_GROUP_MID_REFERENCE')); assert(!groupSystem.includes('ACTIVE_PRIVATE_MID_REFERENCE'));
  pass('Group quote preserves source identity and stable requestId with exact group mid recall scope');

  async function selectGroupRows() {
    await click(sourceSelector, 'right'); await click('.group-ctx-item:last-child');
    for (const item of groupSources) await click('.gmsg[data-message-id="' + item.messageId + '"] .gmsg-bubble');
    await click('#groupSelectBar [data-act=forward]');
  }
  await selectGroupRows();
  const beforeForwardModels = fixture.records.length;
  browser.failNext(request => request.url.endsWith('/' + beta + '/forward'));
  await click('.forward-target[data-kind=bot][data-id="' + beta + '"]');
  await until(() => evaluate('document.querySelector("#forwardMsg").textContent !== "转发中…"'), 'transport failure visible');
  await click('.forward-target[data-kind=bot][data-id="' + beta + '"]');
  await until(() => evaluate('document.querySelector("#modal").hidden'), 'forward retry committed');
  const forwards = browser.requests.filter(row => row.pathname.endsWith('/' + beta + '/forward'));
  assert.equal(forwards.length, 2); assert.equal(forwards[0].body.requestId, forwards[1].body.requestId);
  assert.deepEqual(Object.keys(forwards[1].body).sort(), ['messageIds', 'requestId', 'sourceGroupId', 'sourceMode']);
  assert.deepEqual(forwards[1].body.messageIds, groupSources.map(row => row.messageId));
  const forwarded = (await history(beta)).messages.filter(row => row.context?.kind === 'forward');
  assert.equal(forwarded.length, 1); assert.equal(forwarded[0].actor, 'system');
  assert.deepEqual(forwarded[0].context.sources.map(row => row.text), groupSources.map(row => row.text));
  assert.equal(fixture.records.length, beforeForwardModels);
  await selectGroupRows(); await click('.forward-target[data-kind=group][data-id="' + targetGroup + '"]');
  await until(() => evaluate('document.querySelector("#modal").hidden'), 'group forward committed');
  assert.equal((await groupHistory(targetGroup)).messages.filter(row => row.context?.kind === 'forward').length, 1);
  assert.equal(fixture.records.length, beforeForwardModels);
  await click('#botList [data-id=quote-beta]');
  await until(() => evaluate('!!document.querySelector(".bubble .message-context")'), 'forward rendered in target Bot');
  await click('.bubble .message-context summary'); await screenshot('02-forward-source-snapshots');
  pass('Two selected messages forward by ordered native IDs to Bot and group, with idempotent transport retry and no model/Work launch');

  await click('#botList [data-id=quote-alpha]');
  await until(() => evaluate('!!document.querySelector(' + JSON.stringify(privateSelector) + ')'), 'private source for forwarding');
  const beforePrivateForward = fixture.records.length;
  for (const [kind, target] of [['bot', gamma], ['group', privateTarget]]) {
    await click(privateSelector, 'right'); await click(menu('forward'));
    await click('.forward-target[data-kind=' + kind + '][data-id="' + target + '"]');
    await until(() => evaluate('document.querySelector("#modal").hidden'), 'private forwarding saved');
  }
  const privateForward = (await history(gamma)).messages.find(row => row.context?.kind === 'forward');
  assert.equal(privateForward.context.sources[0].text, privateText);
  assert.equal(privateForward.context.sources[0].botId, alpha);
  assert.equal(privateForward.context.sources[0].groupId, '');
  assert.equal((await groupHistory(privateTarget)).messages.find(row => row.context?.kind === 'forward').context.sources[0].text, privateText);
  assert.equal(fixture.records.length, beforePrivateForward);
  pass('Right-click copy preserves exact text; keyboard and Escape work; private Chat forwards to another Bot and group without triggering work');

  await click(privateSelector, 'right'); await click(menu('delete'));
  await click('[data-cancel-delete]'); assert((await history(alpha)).messages.some(row => row.messageId === privateSource.messageId));
  await click(privateSelector, 'right'); await click(menu('delete'));
  browser.failNext(request => request.method === 'DELETE' && request.url.includes('/messages/'));
  await click('[data-confirm-delete]');
  await until(() => evaluate('document.querySelector(".message-delete-dialog [role=status]").textContent !== "正在删除…"'), 'delete error retained for retry');
  assert((await history(alpha)).messages.some(row => row.messageId === privateSource.messageId));
  await click('[data-confirm-delete]');
  await until(() => evaluate('document.querySelector("#modal").hidden'), 'private deletion committed');
  assert.equal(await evaluate('!!document.querySelector(' + JSON.stringify(privateSelector) + ')'), false);
  assert(!(await history(alpha)).messages.some(row => row.messageId === privateSource.messageId));
  assert.equal((await history(alpha)).messages.find(row => row.messageId === privateQuoted.messageId).context.sources[0].text, privateText);
  await click('#groupList [data-group-id="' + group + '"]');
  await click(sourceSelector + ' .gmsg-bubble', 'right'); await click(menu('delete')); await click('[data-confirm-delete]');
  await until(() => evaluate('document.querySelector("#modal").hidden'), 'group deletion committed');
  assert(!(await groupHistory(group)).messages.some(row => row.messageId === groupSources[0].messageId));
  assert.equal((await groupHistory(group)).messages.find(row => row.messageId === groupQuoted.messageId).context.sources[0].text, firstGroup);
  await click('#botList [data-id=quote-alpha]');
  await until(() => evaluate('!!document.querySelector(' + JSON.stringify('.bubble[data-message-id="' + privateQuoted.messageId + '"]') + ')'), 'private history reloaded');
  assert.equal(await evaluate('!!document.querySelector(' + JSON.stringify(privateSelector) + ')'), false);
  pass('Private/group deletion supports cancel and failure retry, survives view reload, and preserves existing quote/forward snapshots');

  const initial = await app.api('/api/dimension/work/runs', { botId: alpha, text: 'APPTEST:quote_work_initial ACTIVE_PRIVATE_MID_REFERENCE', requestId: 'seed-work-source' });
  const work = await completed(initial.run.id);
  const workPrompt = fixture.records.find(row => row.tag === 'quote_work_initial');
  assert(workPrompt.body.messages.some(row => row.role === 'system' && row.content.includes('ACTIVE_PRIVATE_MID_REFERENCE')));
  assert(!workPrompt.body.messages.some(row => row.role === 'system' && row.content.includes('EXPIRED_MID_MUST_NOT_RECALL')));
  await click('#modeSwitch'); await click('#botList [data-id=quote-alpha]');
  const runSelector = '.work-run[data-run-id="' + work.id + '"]';
  await until(() => evaluate('!!document.querySelector(' + JSON.stringify(runSelector + ' .work-run-title') + ')?.messageSource?.sourceRef'), 'Work source title');
  await quote(runSelector + ' .work-run-title');
  browser.failNext(request => request.url.endsWith('/api/dimension/work/runs') && request.method === 'POST');
  await replace('#composerInput', 'APPTEST:quote_work_retry'); await click('#sendBtn');
  await until(() => evaluate('document.querySelector("#composerInput").value === "APPTEST:quote_work_retry"'), 'failed Work draft restored');
  const failedPosts = () => browser.requests.filter(row => row.pathname === '/api/dimension/work/runs' && row.body?.text === 'APPTEST:quote_work_retry');
  assert.deepEqual(failedPosts()[0].body.quote, work.sourceRef);
  browser.failNext(request => request.url.endsWith('/api/dimension/work/runs') && request.method === 'POST');
  await click('#sendBtn');
  await until(() => failedPosts().length === 2, 'same quote retried');
  await until(() => evaluate('document.querySelector("#composerInput").value === "APPTEST:quote_work_retry"'), 'second failed Work draft restored');
  assert.equal(failedPosts()[0].body.requestId, failedPosts()[1].body.requestId);
  const resultSelector = runSelector + ' .work-message[data-message-menu-bound]';
  await until(() => evaluate('!!document.querySelector(' + JSON.stringify(resultSelector) + ')'), 'quoteable Work result');
  const resultRef = await evaluate('document.querySelector(' + JSON.stringify(resultSelector) + ').messageSource.sourceRef');
  const originalEvent = work.events.find(row => JSON.stringify(row.sourceRef) === JSON.stringify(resultRef)); assert(originalEvent);
  assert.notEqual(String(originalEvent.seq), resultRef.eventSeq, 'UI sequence differs from underlying journal sequence');
  await quote(resultSelector); await click('#sendBtn');
  await until(() => failedPosts().length === 3, 'different source submitted');
  const finalPost = failedPosts()[2];
  assert.deepEqual(finalPost.body.quote, resultRef); assert.notEqual(finalPost.body.requestId, failedPosts()[0].body.requestId);
  const finalRun = await until(async () => {
    const sessions = await app.api('/api/dimension/work/sessions?botId=' + alpha);
    return sessions.runs.find(row => row.text === 'APPTEST:quote_work_retry');
  }, 'new quoted Work run');
  const finalView = await completed(finalRun.id);
  assert.equal(finalView.context.kind, 'quote'); assert.equal(finalView.context.sources[0].messageId, resultRef.eventSeq);
  assert(finalView.context.sources[0].namespace.endsWith(':run:' + work.id));
  await until(() => evaluate('!!document.querySelector(' + JSON.stringify('.work-run[data-run-id="' + finalRun.id + '"] .message-context') + ')'), 'Work quote snapshot shown');
  await click('.work-run[data-run-id="' + finalRun.id + '"] .message-context summary');
  await screenshot('03-work-event-quote');
  pass('Work title/result quote uses backend eventSeq unchanged; retries retain key for same quote and change it for a different source');
  assert.deepEqual(browser.exceptions, []); assert.deepEqual(browser.blockedExternal, []); assert.deepEqual(fixture.errors, []);
  pass('Chat, group and Work source blocks render without exceptions or external traffic using only a loopback model fixture');
  await browser.stop(); browserStopped = true;
  await app.stop(); app = await startNative({ ...config, label: 'native-restart' });
  assert.equal((await history(alpha)).messages.find(row => row.messageId === privateQuoted.messageId).context.sources[0].text, privateText);
  assert.equal((await history(beta)).messages.filter(row => row.context?.kind === 'forward').length, 1);
  assert(!(await history(alpha)).messages.some(row => row.messageId === privateSource.messageId));
  assert(!(await groupHistory(group)).messages.some(row => row.messageId === groupSources[0].messageId));
  assert.equal((await history(gamma)).messages.find(row => row.context?.kind === 'forward').context.sources[0].text, privateText);
  assert.deepEqual((await app.api('/api/dimension/work/runs/' + finalRun.id + '?view=1')).context, finalView.context);
  pass('Chat quotes, ordered forwarded snapshots and Work quoted context all survive a real native restart');
} catch (error) {
  failures.push(error.stack); process.exitCode = 1;
  if (browser) await browser.screenshot('failure').catch(() => {});
} finally {
  const browserData = browser ? { requests: browser.requests, responses: browser.responses, exceptions: browser.exceptions, screenshots: browser.screenshots, blockedExternal: browser.blockedExternal } : {};
  if (browser && !browserStopped) await browser.stop().catch(error => failures.push(error.message));
  if (app?.child.exitCode === null) await app.stop().catch(error => failures.push(error.message));
  if (fixture) await fixture.close().catch(error => failures.push(error.message));
  await cleanup(config).catch(error => failures.push(error.message));
  const processes = config.processes.map(entry => ({ label: entry.label, pid: entry.child.pid, exitCode: entry.child.exitCode, signal: entry.child.signalCode }));
  if (processes.some(entry => entry.exitCode !== 0)) failures.push('A test process did not exit normally.');
  const report = { ok: !failures.length, checks, failures, ...browserData, fingerprints: config.fingerprints, processes, traces: config.traces,
    modelRequests: (fixture?.records || []).map(row => ({ tag: row.tag, work: row.work, model: row.body.model, promptSha256: digest(JSON.stringify(row.body)) })),
    fixtureErrors: fixture?.errors, productionDataUsed: false, externalModelRequests: 0 };
  if (!report.ok) process.exitCode = 1;
  await writeFile(path.join(config.output, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ok: report.ok, checks: checks.length, output: config.output }));
}
