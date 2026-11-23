import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseOptions, setup, startNative, cleanup, digest, until } from './relation-notes-api.mjs';
import { rawImport, excluded } from './archive-export-api.mjs';
import { startBrowser } from './native-browser-fixture.mjs';

const options = parseOptions(), config = await setup(options, 'group-invite-browser');
const checks = [], failures = [], pass = text => { checks.push(text); console.log('PASS ' + text); };
const owner = 'invite-owner', beta = 'invite-beta', gamma = 'invite-gamma', local = 'invite-local', extra = 'invite-extra', groupId = 'invite-group';
let app, browser;
const group = () => app.api('/api/dimension/groups/' + groupId + '?mode=discuss&limit=1');
try {
  for (const file of ['app.js', 'group-invite-ui.js', 'group-invite.css']) config.fingerprints[file] = digest(await readFile(path.join(config.ui, file)));
  app = await startNative({ ...config, label: 'native' });
  const bot = (id, name = id, active = true) => ({ id, name, persona: 'Synthetic invitation persona', inChat: active, inWork: active });
  await rawImport(app, { format: 'dimension-conversation-archive', version: 3, coverage: 'conversation-and-group-data', excludedTypes: [...excluded],
    bots: [bot(owner), bot(beta), bot(gamma), bot(local, '本地未启动角色', false), bot(extra)],
    groups: [{ id: groupId, name: '邀请多选测试', ownerId: owner, admins: [], members: [owner], historyMembers: [owner], inChat: true, inWork: true, deleted: false, revision: '1', seal: { shape: 'round-seal', color: 'persimmon' } }],
    conversations: [], memories: [], midMemories: [] }, 'invite-test');
  const library = await app.api('/api/dimension/library');
  await app.api('/api/dimension/library/catalog', { baseRevision: library.directoryRevision, catalog: { format: 'dimension-character-directory', version: 1,
    source: { id: 'invite-fixture', name: '邀请测试目录', url: 'https://example.test/invite.json', license: 'Original synthetic test' },
    entries: [{ id: 'one', name: '目录角色一', persona: 'Synthetic invitation one' }, { id: 'two', name: '目录角色二', persona: 'Synthetic invitation two' }] } });
  browser = await startBrowser(config, app.origin, options.get('chrome'));
  const { click, evaluate, replace, screenshot } = browser;
  await until(() => evaluate('!!document.querySelector("#groupList [data-group-id=invite-group]")'), 'group loaded');
  await click('#groupList [data-group-id=invite-group]');
  await click('#groupBar'); await click('#groupDrawerInviteBtn');
  const choice = id => '.group-invite-dialog input[data-invite-bot="' + id + '"]';
  await click(choice(beta)); await click(choice(gamma));
  assert.match(await evaluate('document.querySelector("#inviteConfirm").textContent'), /2/);
  await click(choice(gamma)); assert.match(await evaluate('document.querySelector("#inviteConfirm").textContent'), /1/);
  assert.deepEqual((await group()).group.members, [owner]);
  await click('#modal [data-close]');
  assert.equal(browser.requests.filter(row => row.method === 'PATCH' && row.pathname === '/api/dimension/groups/' + groupId).length, 0);
  pass('Checking and unchecking multiple Bots stays local; cancelling makes no membership change');

  await click('#groupDrawerInviteBtn'); await click(choice(beta)); await click(choice(gamma));
  await replace('#inviteLibSearch', '本地'); await until(() => evaluate('!!document.querySelector(' + JSON.stringify(choice(local)) + ')'), 'local library result');
  await click(choice(local));
  await replace('#inviteLibSearch', '目录角色');
  await until(() => evaluate('document.querySelectorAll("#inviteLibResults input[type=checkbox]").length===2'), 'external catalog results');
  await click('#inviteLibResults input[type=checkbox]');
  assert.match(await evaluate('document.querySelector("#inviteConfirm").textContent'), /4/);
  assert.equal(await evaluate('(()=>{const m=document.querySelector("#modal");return m.scrollWidth<=m.clientWidth})()'), true, 'invitation has no horizontal overflow');
  assert.equal(browser.requests.filter(row => row.pathname === '/api/dimension/library/import').length, 0);
  await screenshot('01-multi-invite-selected');
  pass('Selections survive searches across active Bots, local characters and catalog entries without early import');

  const before = (await group()).group;
  await app.api('/api/dimension/groups/' + groupId, { members: [owner, extra], baseRevision: before.revision }, 'PATCH');
  browser.failNext(request => request.method === 'PATCH' && request.url.endsWith('/groups/' + groupId));
  await click('#inviteConfirm');
  await until(() => evaluate('!document.querySelector("#inviteConfirm").disabled && document.querySelector("#inviteMsg").textContent !== "正在邀请…"'), 'failure preserves selection');
  assert.deepEqual((await group()).group.members, [owner, extra]);
  assert.match(await evaluate('document.querySelector("#inviteConfirm").textContent'), /4/);
  await click('#inviteConfirm');
  await until(() => evaluate('document.querySelector("#modal").hidden'), 'batch invite saved');
  const after = (await group()).group;
  assert.equal(after.members.length, 6);
  for (const id of [owner, extra, beta, gamma, local]) assert(after.members.includes(id));
  const imported = after.members.find(id => ![owner, extra, beta, gamma, local].includes(id)); assert(imported);
  assert.equal(browser.requests.filter(row => row.pathname === '/api/dimension/library/import').length, 1, 'retry uses already imported Bot');
  const patches = browser.requests.filter(row => row.method === 'PATCH' && row.pathname === '/api/dimension/groups/' + groupId);
  assert.equal(patches.length, 2, 'one failed batch and one successful batch, never per-member PATCH');
  assert.equal(patches[1].body.members.length, 6);
  await until(() => evaluate('document.querySelectorAll("#groupMembers [data-mid]").length===6'), 'drawer updated after batch');
  await screenshot('02-multi-invite-completed');
  pass('Single batch invitation preserves concurrent joins; failed commit retries without duplicate import and updates drawer');
  assert.deepEqual(browser.exceptions, []); assert.deepEqual(browser.blockedExternal, []);
  await browser.stop(); browser = null; await app.stop();
  app = await startNative({ ...config, label: 'native-restart' });
  assert.deepEqual((await group()).group.members, after.members);
  pass('All selected members persist after native restart without model or external network use');
} catch (error) { failures.push(error.stack); process.exitCode = 1; if (browser) await browser.screenshot('failure').catch(() => {}); }
finally {
  const evidence = browser ? { requests: browser.requests, screenshots: browser.screenshots, exceptions: browser.exceptions } : {};
  if (browser) await browser.stop().catch(error => failures.push(error.message));
  if (app?.child.exitCode === null) await app.stop().catch(error => failures.push(error.message));
  await cleanup(config).catch(error => failures.push(error.message));
  const report = { ok: !failures.length, checks, failures, fingerprints: config.fingerprints, ...evidence, productionDataUsed: false };
  await writeFile(path.join(config.output, 'result.json'), JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
  console.log(JSON.stringify({ ok: report.ok, checks: checks.length, output: config.output }));
}
