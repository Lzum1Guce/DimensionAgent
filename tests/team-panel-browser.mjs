// Real UI modules in isolated Chrome against synthetic loopback HTTP/SSE data.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startBrowser } from './native-browser-fixture.mjs';
import { until, digest } from './archive-export-api.mjs';
import { workTaskGroups, shortWorkReport, workReport } from '../ui/work-task-groups.js';

const project = path.resolve(import.meta.dirname, '..');
const output = path.join(project, 'outputs/team-panel', 'browser-' + Date.now());
await mkdir(path.join(output, 'temp'), { recursive: true });
const checks = [], processes = [], streams = new Map(), requests = [], failures = [];
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const names = { coordinator: '薇尔莉特', draft: '亚丝娜', review: '芙莉莲', proof: '立华奏', waiting: '晓美焰', solo: '单聊 Bot' };
const event = (id, seq, kind, text, extra = {}) => ({ seq, kind, text, runId: id, from: 'draft', sourceRef: { runId: id, eventSeq: String(seq) }, ...extra });
const record = (id, botId, text, parentRunId = '', status = 'completed', index = 1) => ({
  id, botId, text, parentRunId, groupId: 'fixture-group', status, order: 0, createdAt: `2026-11-15T12:00:${String(index).padStart(2, '0')}Z`,
  detailsLoaded: true, lastSeq: 2, sourceRef: { runId: id, eventSeq: '1' },
  events: [event(id, 1, 'result', '结果 ' + text, { from: botId, taskId: id, status }), event(id, 2, 'run-state', '', { from: botId, status })], assignments: [],
});
const root = record('root-task', 'coordinator', '整理项目资料并完成校验', '', 'running', 1);
root.events = [event(root.id, 1, 'plan', '已分配资料整理和结果校验。', { from: 'coordinator' })]; root.lastSeq = 1;
const draft = record('draft-task', 'draft', '整理参考资料', root.id, 'completed', 2);
const fullResult = '已整理参考资料。' + '完整结果包含所有引用和检查记录。'.repeat(35);
draft.events[0].text = fullResult;
draft.events = [...Array.from({ length: 12 }, (_, index) => event(draft.id, index + 1, 'say', `成员对话 ${index + 1}`, { from: draft.botId, taskId: draft.id })),
  { ...draft.events[0], seq: 13 }, { ...draft.events[1], seq: 14 }];
draft.lastSeq = 14;
const review = record('review-task', 'review', '校验图片与排版', root.id, 'failed', 3);
review.events[0].text = '校验失败：缺少最终图片，已保留检查清单。'; review.error = review.events[0].text;
const proof = record('proof-task', 'proof', '检查引用来源', draft.id, 'completed', 4);
const independent = record('separate-task', 'review', '同群另一项独立工作', '', 'completed', 5);
independent.events = Array.from({ length: 12 }, (_, index) => event(independent.id, index + 1, 'say', `独立任务对话 ${index + 1}`, { from: independent.botId, taskId: independent.id }));
independent.lastSeq = 12;
const orphan = record('orphan-task', 'draft', '原父任务已删除的保留成果', 'missing-parent', 'completed', 6);
const oldRoot = record('archived-root', 'coordinator', '旧分页中的插件适配', '', 'failed', 0);
oldRoot.createdAt = '2026-11-14T12:00:00Z'; oldRoot.events[0].text = 'tool_round_limit_exceeded'; oldRoot.error = 'tool_round_limit_exceeded';
const oldWorker = record('archived-worker', 'draft', '整理插件工具', oldRoot.id, 'interrupted', 0);
oldWorker.createdAt = '2026-11-14T12:00:01Z'; oldWorker.events[0].text = 'Model output token limit reached'; oldWorker.error = oldWorker.events[0].text;
oldRoot.assignments = [{ key: oldWorker.id, runId: oldWorker.id, botId: oldWorker.botId, job: oldWorker.text, status: oldWorker.status }];
const foreign = { ...record('foreign-task', 'draft', '其他会话任务'), groupId: 'different-group' };
const archived = new Map([oldRoot, oldWorker, foreign].map(row => [row.id, row]));
root.assignments = [draft, review].map(row => ({ key: row.id, runId: row.id, botId: row.botId, assignee: row.botId, job: row.text, status: row.status, dependsOn: [] }));
root.assignments.push({ key: 'waiting-job', botId: 'waiting', assignee: 'waiting', job: '收到资料后复核', status: 'waiting', dependsOn: [draft.id] });
draft.assignments = [{ key: proof.id, runId: proof.id, botId: proof.botId, assignee: proof.botId, job: proof.text, status: proof.status }];
let rows = [review, draft, root, proof, independent, orphan];
const deliveries = new Map([root, draft, review, proof].map(row => [row.id, [{ name: row.id + '.txt', path: 'synthetic/' + row.id + '.txt',
  bytes: 16, available: true, extension: '.txt', url: '/fixture-files/' + row.id + '.txt' }]]));
const solo = { ...record('solo-run', 'solo', '单聊原任务卡片', '', 'running', 1), groupId: '' };
solo.events = [event(solo.id, 1, 'plan', '单聊任务仍使用原卡片。', { from: 'solo' })]; solo.lastSeq = 1;
let browser, server;
try {
  const grouped = workTaskGroups(rows);
  assert.equal(grouped.groups.length, 3); assert.equal(grouped.rootOf.get(proof.id), root.id);
  assert.equal(workTaskGroups([record('a', 'draft', 'a', 'b'), record('b', 'review', 'b', 'a')]).groups.length, 1);
  assert.equal(Array.from(shortWorkReport('🙂'.repeat(200))).length, 140);
  assert(workReport('tool_round_limit_exceeded').includes('操作轮数上限'));
  pass('Task grouping and report helpers retain their existing behavior');

  const html = `<!doctype html><meta charset="utf-8"><title>群任务工作区测试</title>
    <link rel="stylesheet" href="/dimension-ui/styles.css"><link rel="stylesheet" href="/dimension-ui/work-task-panel.css"><link rel="stylesheet" href="/dimension-ui/message-actions.css">
    <style>body{margin:0;background:#faf9f6;color:#45443e}main{max-width:1100px;margin:20px auto}#fixtureTranscript{height:900px;overflow:auto;padding:8px}#soloTranscript{height:500px;overflow:auto}#workSessionBar{padding:8px}</style>
    <main><div id="workSessionBar"></div><div id="fixtureTranscript"></div><textarea id="composerInput"></textarea><div id="soloTranscript"></div></main>
    <script type="module">
      import {createWorkSessionUi} from '/dimension-ui/work-session-ui.js?v=team-panel1';
      const names=${JSON.stringify(names)},api=async(url,options={})=>{const r=await fetch(url,options);if(!r.ok)throw Error('fixture '+r.status);return r.json()};
      window.quotes=[];window.busyStates=[];
      window.ui=createWorkSessionUi({api,getTranscript:()=>document.querySelector('#fixtureTranscript'),nameOf:id=>names[id]||id,onBusy:(busy,runId,botId)=>busyStates.push({busy,runId,botId}),onQuote:q=>quotes.push(q)});
      window.soloUi=createWorkSessionUi({api,getTranscript:()=>document.querySelector('#soloTranscript'),nameOf:id=>names[id]||id,onBusy:()=>{}});
      ui.setHandoffAvailable(true);await ui.open({botId:'coordinator',groupId:'fixture-group'});window.ready=true;
    </script>`;
  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      let body = ''; for await (const chunk of req) body += chunk;
      let parsed; try { parsed = body ? JSON.parse(body) : undefined; } catch { parsed = body; }
      requests.push({ method: req.method, path: url.pathname, query: url.search, body: parsed });
      const json = value => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (url.pathname === '/dimension-ui/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); return; }
      if (/^\/dimension-ui\/[a-zA-Z0-9.-]+\.(js|css)$/.test(url.pathname)) {
        const file = path.join(project, 'ui', path.basename(url.pathname));
        res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/css' }); res.end(await readFile(file)); return;
      }
      if (url.pathname === '/api/dimension/work/sessions') {
        if (!url.searchParams.has('groupId')) { json({ runs: [solo], hasMore: false, paused: false }); return; }
        const cursors = JSON.parse(url.searchParams.get('cursors') || '{}');
        json({ runs: rows.map(row => ({ ...row, events: row.events.filter(item => item.seq > (cursors[row.id] || 0)) })), hasMore: false, paused: false }); return;
      }
      const stream = /^\/api\/dimension\/work\/runs\/([^/]+)\/events$/.exec(url.pathname);
      if (stream) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': fixture\n\n'); streams.set(stream[1], res); req.on('close', () => streams.delete(stream[1])); return; }
      const files = /^\/api\/dimension\/work\/tasks\/([^/]+)\/artifacts$/.exec(url.pathname);
      if (files) { json({ files: deliveries.get(files[1]) || [] }); return; }
      if (url.pathname.startsWith('/fixture-files/')) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('合成成果文件'); return; }
      const cancel = /^\/api\/dimension\/work\/runs\/([^/]+)\/cancel$/.exec(url.pathname);
      if (cancel && req.method === 'POST') { json({ id: cancel[1], accepted: true }); return; }
      const resume = /^\/api\/dimension\/work\/runs\/([^/]+)\/resume$/.exec(url.pathname);
      if (resume && req.method === 'POST') { json({ mode: 'steer', run: rows.find(row => row.id === resume[1]) }); return; }
      const run = /^\/api\/dimension\/work\/runs\/([^/]+)$/.exec(url.pathname);
      if (run && req.method === 'DELETE') {
        const ids = workTaskGroups(rows).groups.find(group => group.root.id === run[1])?.runs.map(row => row.id) || [run[1]];
        rows = rows.filter(row => !ids.includes(row.id)); json({ deleted: true, deletedIds: ids }); return;
      }
      if (run) { json(rows.find(row => row.id === run[1]) || (run[1] === solo.id ? solo : archived.get(run[1]))); return; }
      res.writeHead(404); res.end();
    } catch (error) { failures.push(error.stack); res.writeHead(500); res.end('fixture error'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await startBrowser({ output, processes }, 'http://127.0.0.1:' + server.address().port);
  const { evaluate, click } = browser;
  const current = () => evaluate('document.querySelector(".work-task-space-detail > .work-task-panel")?.dataset.runId');
  const select = id => click(`.work-task-space-bot[data-run-id="${id}"]`);
  const order = () => evaluate('[...document.querySelectorAll(".work-task-space-bot")].map(row=>row.dataset.entryId)');
  await until(() => evaluate('window.ready'), 'synthetic component ready');
  assert.equal(await evaluate('document.querySelectorAll("#fixtureTranscript > .work-task-space-inline").length'), 1);
  assert.equal(await evaluate('document.querySelectorAll("#fixtureTranscript > .work-run").length'), 0);
  assert.equal(await current(), root.id);
  assert.equal(await evaluate('document.querySelectorAll(".work-task-space-detail .work-run .work-run").length'), 0);
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".work-task-space-bot-name")].map(n=>n.textContent)'), ['薇尔莉特 · 群主', '晓美焰', '亚丝娜', '芙莉莲', '立华奏', '芙莉莲', '亚丝娜']);
  assert.equal(await evaluate('document.querySelector(".work-task-space-bot[data-bot-id=waiting] .work-task-space-bot-state").textContent'), '等待前置成果');
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".work-task-space-detail > .work-task-panel > .work-team")).display'), 'none');
  for (const action of ['cancel', 'handoff', 'task-space', 'delete']) assert.equal(await evaluate('!!document.querySelector(' + JSON.stringify('.work-task-space-detail [data-action=' + action + ']') + ')'), true);
  pass('One inline workspace shows only the selected root run, with a real Bot/task list and no nested result-card panels');

  await browser.cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 616, deviceScaleFactor: 1, mobile: false });
  const compact = await evaluate(`(() => {const body=document.querySelector('.work-task-space-detail .work-owner-talk-body'),line=parseFloat(getComputedStyle(body).lineHeight);return {height:body.clientHeight,content:body.scrollHeight,line,expandHidden:document.querySelector('.work-task-space-detail .work-talk-expand').hidden}})()`);
  assert(compact.height <= compact.content + 1); assert(compact.height < compact.line * 10); assert.equal(compact.expandHidden, true);
  await select(independent.id);
  const longBefore = await evaluate(`(() => {const body=document.querySelector('.work-task-space-detail .work-owner-talk-body'),rows=[...body.querySelectorAll('.work-message')].filter(row=>row.textContent.startsWith('独立任务对话'));return {height:body.clientHeight,content:body.scrollHeight,ten:rows[9].offsetTop+rows[9].offsetHeight-rows[0].offsetTop<=body.clientHeight+1,whiteSpace:getComputedStyle(rows[0]).whiteSpace}})()`);
  assert.equal(longBefore.ten, true); assert(longBefore.content > longBefore.height); assert.equal(longBefore.whiteSpace, 'pre-wrap');
  await click('.work-task-space-detail .work-talk-expand');
  await until(async () => (await evaluate('document.querySelector(".work-task-space-detail .work-owner-talk-body").clientHeight')) > longBefore.height, 'expanded conversation grows after transition');
  assert.equal(await evaluate('document.querySelector(".work-task-space-detail .work-talk-expand").getAttribute("aria-expanded")'), 'true');
  await click('.work-task-space-detail .work-talk-expand');
  await browser.cdp.call('Emulation.clearDeviceMetricsOverride');
  pass('Short conversations stay content-sized; long conversations scroll ten rows and expand without a fixed blank minimum');

  await select(draft.id);
  assert.equal(await evaluate('document.querySelector(".work-task-space-detail .work-owner-talk-title").textContent'), '与亚丝娜交谈');
  assert.equal(await evaluate(`(() => {const body=document.querySelector('.work-task-space-detail .work-owner-talk-body'),rows=[...body.querySelectorAll('.work-message')].filter(row=>row.textContent.startsWith('成员对话'));return rows[9].offsetTop+rows[9].offsetHeight-rows[0].offsetTop<=body.clientHeight+1})()`), true);
  await until(() => evaluate('document.querySelector(".work-task-space-detail .work-talk-file")?.textContent.includes("draft-task.txt")'), 'member artifact in member conversation');
  assert.equal(await evaluate('document.querySelector(".work-task-space-detail .work-talk-file").textContent.includes("root-task.txt")'), false);
  await evaluate(`(() => {const node=[...document.querySelectorAll('.work-task-space-detail .work-message')].find(row=>row.textContent.includes(${JSON.stringify(fullResult)}));node.dataset.testQuote='1'})()`);
  await click('[data-test-quote="1"]', 'right'); await click('[data-message-action=quote]');
  assert.deepEqual(await evaluate('window.quotes.at(-1).sourceRef'), { runId: draft.id, eventSeq: '1' });
  await evaluate(`window.draftNode=document.querySelector('.work-task-space-detail > .work-task-panel')`);
  draft.status = 'running'; draft.events.push(event(draft.id, 15, 'run-state', '', { from: draft.botId, status: 'running' })); draft.lastSeq = 15;
  await evaluate('ui.refresh()'); await until(() => streams.has(draft.id), 'member SSE connected');
  streams.get(draft.id).write('data: ' + JSON.stringify(event(draft.id, 16, 'say', '个人 Work 同一 run 实时同步', { from: draft.botId, taskId: draft.id })) + '\n\n');
  await until(() => evaluate('document.querySelector(".work-task-space-detail .work-owner-talk-body").textContent.includes("个人 Work 同一 run 实时同步")'), 'live member message');
  assert.equal(await evaluate('document.querySelector(".work-task-space-detail > .work-task-panel")===window.draftNode'), true);
  assert.equal(await current(), draft.id);
  draft.status = 'completed'; draft.events.push(event(draft.id, 17, 'run-state', '', { from: draft.botId, status: 'completed' })); draft.lastSeq = 17;
  streams.get(draft.id).write('data: ' + JSON.stringify(draft.events.at(-1)) + '\n\n');
  await until(() => evaluate('document.querySelector(".work-task-space-detail > .work-task-panel").dataset.status==="completed"'), 'member terminal state');
  pass('Member selection exposes the same run DOM, independent context, truthful title, live SSE updates and its own artifact entry');

  await evaluate(`ui.presentPending([{id:'approval-draft',botId:'draft',runId:'draft-task',action:{risk:'write',tool:'write',path:'draft.txt'}}],{})`);
  assert.equal(await evaluate('document.querySelector(".work-task-space-detail .work-talk-approval").dataset.approvalId'), 'approval-draft');
  await select(root.id); assert.equal(await evaluate('document.querySelector(".work-task-space-detail .work-talk-approval")'), null);
  await select(draft.id); assert.equal(await evaluate('document.querySelector(".work-task-space-detail .work-talk-approval").dataset.approvalId'), 'approval-draft');
  await evaluate('ui.presentPending([])');
  await click('.work-task-space-detail .work-talk-file');
  await until(() => evaluate('!!document.querySelector(".work-preview[open]")'), 'member file preview'); await click('.work-preview-close');
  await browser.replace('.work-task-space-detail > .work-task-panel > .work-owner-talk .work-owner-talk-input', '成员定向补充');
  await evaluate('document.querySelector(".work-task-space-detail > .work-task-panel > .work-owner-talk .work-owner-talk-composer").requestSubmit()');
  await until(() => requests.some(row => row.method === 'POST' && row.path === '/api/dimension/work/runs/draft-task/resume'), 'member input targets member run');
  assert.equal(requests.find(row => row.path === '/api/dimension/work/runs/draft-task/resume').body.text, '成员定向补充');
  pass('Approvals remain explicit per selected Bot, files open from the real conversation, and input posts only to the selected run');

  await browser.replace('.work-task-space-detail > .work-task-panel > .work-owner-talk .work-owner-talk-input', '成员输入草稿');
  await select(root.id); await evaluate(`window.rootNode=document.querySelector('.work-task-space-detail > .work-task-panel')`);
  await browser.replace('.work-task-space-detail > .work-task-panel > .work-owner-talk .work-owner-talk-input', '群主输入草稿');
  const actionsBefore = requests.filter(row => row.method === 'POST' && /\/(cancel|resume|queue)$/.test(row.path)).length;
  await select(draft.id); assert.equal(await evaluate('document.querySelector(".work-task-space-detail > .work-task-panel")===window.draftNode'), true);
  assert.equal(await evaluate('document.querySelector(".work-task-space-detail > .work-task-panel > .work-owner-talk .work-owner-talk-input").value'), '成员输入草稿');
  await select(root.id); assert.equal(await evaluate('document.querySelector(".work-task-space-detail > .work-task-panel")===window.rootNode'), true);
  assert.equal(await evaluate('document.querySelector(".work-task-space-detail > .work-task-panel > .work-owner-talk .work-owner-talk-input").value'), '群主输入草稿');
  assert.equal(requests.filter(row => row.method === 'POST' && /\/(cancel|resume|queue)$/.test(row.path)).length, actionsBefore);
  pass('Clicking Bots only moves the original panels and preserves isolated drafts without task actions');

  const beforeDrag = await order();
  await evaluate(`window.dragTexts=[];document.querySelector('.work-task-space-bots').addEventListener('dragstart',event=>dragTexts.push(event.dataTransfer.getData('text/plain')))`);
  const points = await evaluate(`(() => {const source=document.querySelector('[data-entry-id=root-task] .work-task-space-drag-handle').getBoundingClientRect(),target=document.querySelector('[data-entry-id=orphan-task]').getBoundingClientRect();return {sx:source.x+source.width/2,sy:source.y+source.height/2,tx:target.x+target.width/2,ty:target.y+target.height/2}})()`);
  await browser.cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, x: points.sx, y: points.sy });
  for (let step = 1; step <= 8; step++) await browser.cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: points.sx + (points.tx - points.sx) * step / 8, y: points.sy + (points.ty - points.sy) * step / 8 });
  await evaluate(`(() => {const target=document.querySelector('[data-entry-id=orphan-task]'),rect=target.getBoundingClientRect();target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,clientY:rect.bottom-1,dataTransfer:new DataTransfer()}))})()`);
  await browser.cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, x: points.tx, y: points.ty });
  await until(async () => (await order()).at(-1) === root.id, 'drag changes display order only');
  assert.notDeepEqual(await order(), beforeDrag); assert.equal(await evaluate('dragTexts.at(-1)'), root.text);
  assert.equal(requests.filter(row => row.method === 'POST' && /\/(cancel|resume|queue)$/.test(row.path)).length, actionsBefore);
  const beforeKey = await order();
  await evaluate(`document.querySelector('.work-task-space-bot .work-task-space-drag-handle').focus()`);
  await browser.cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
  await browser.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
  await until(async () => JSON.stringify(await order()) !== JSON.stringify(beforeKey), 'keyboard display reorder');
  assert.equal(requests.filter(row => row.method === 'POST' && /\/(cancel|resume|queue)$/.test(row.path)).length, actionsBefore);
  assert((await evaluate('localStorage.getItem("dimension-work-display-order:fixture-group")')).includes(root.id));
  pass('Handle dragging shows the task name and keyboard arrows provide an alternative; both persist only local display order');

  await select(draft.id);
  await evaluate(`window.workspaceNode=document.querySelector('.work-task-space-inline');document.querySelector('.work-task-space-detail .work-owner-talk-body').scrollTop=40;document.querySelector('.work-task-space-detail [data-action=task-space]').click()`);
  await until(() => evaluate('document.querySelector(".work-task-space")?.open'), 'fullscreen workspace');
  assert.equal(await evaluate('document.querySelector(".work-task-space > .work-task-space-inline")===window.workspaceNode'), true);
  assert.equal(await evaluate('document.querySelector(".work-task-space-detail > .work-task-panel")===window.draftNode'), true);
  await browser.cdp.call('Emulation.setDeviceMetricsOverride', { width: 620, height: 420, deviceScaleFactor: 1, mobile: false });
  const shortViewport = await evaluate(`(() => {const dialog=document.querySelector('.work-task-space').getBoundingClientRect(),detail=document.querySelector('.work-task-space-detail'),panel=document.querySelector('.work-task-space-detail > .work-task-panel').getBoundingClientRect(),box=detail.getBoundingClientRect(),body=document.querySelector('.work-task-space-detail .work-owner-talk-body');return {inside:dialog.bottom<=innerHeight+1&&panel.bottom<=box.bottom+1,noOverflow:detail.scrollHeight<=detail.clientHeight+1,columns:getComputedStyle(document.querySelector('.work-task-space-layout')).gridTemplateColumns.split(' ').length,scrollable:body.scrollHeight>body.clientHeight&&getComputedStyle(body).overflowY==='auto'}})()`);
  assert.equal(shortViewport.inside, true); assert.equal(shortViewport.noOverflow, true); assert.equal(shortViewport.columns, 2); assert.equal(shortViewport.scrollable, true);
  await browser.screenshot('task-space-short-viewport');
  await browser.cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await browser.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await until(() => evaluate('!document.querySelector(".work-task-space")'), 'Escape exits fullscreen');
  assert.equal(await evaluate('document.querySelector("#fixtureTranscript > .work-task-space-inline")===window.workspaceNode'), true);
  assert.equal(await evaluate('document.querySelector(".work-task-space-detail > .work-task-panel > .work-owner-talk .work-owner-talk-input").value'), '成员输入草稿');
  assert.equal(await evaluate('document.querySelector(".work-task-space-detail .work-owner-talk-body").scrollTop'), 40);
  await evaluate('document.querySelector(".work-task-space-detail [data-action=task-space]").click()');
  await until(() => evaluate('document.querySelector(".work-task-space")?.open'), 'fullscreen reopened'); await click('.work-task-space-close');
  await until(() => evaluate('!document.querySelector(".work-task-space")'), 'close button exits fullscreen');
  await browser.cdp.call('Emulation.clearDeviceMetricsOverride');
  pass('Fullscreen moves the same workspace DOM into a two-column, short-viewport-safe layout and exits with drafts intact');

  await select(root.id);
  root.status = 'failed'; root.events.push(event(root.id, 2, 'result', '任务未完成：图片校验失败，请补充图片。', { from: 'coordinator', taskId: root.id, status: 'failed' }), event(root.id, 3, 'run-state', '', { from: 'coordinator', status: 'failed' })); root.lastSeq = 3;
  await until(() => streams.has(root.id), 'root SSE connected');
  for (const item of root.events.slice(-2)) streams.get(root.id)?.write('data: ' + JSON.stringify(item) + '\n\n');
  await until(() => evaluate('document.querySelector(".work-task-space-detail > .work-task-panel").dataset.status==="failed"'), 'live root failure');
  assert((await evaluate('document.querySelector(".work-task-space-detail .work-owner-talk-body").textContent')).includes('任务未完成'));
  await until(() => evaluate('document.querySelector(".work-task-space-detail .work-talk-file")?.textContent.includes("root-task.txt")'), 'owner deliverable');
  assert.equal(await evaluate('document.querySelectorAll("#fixtureTranscript > .work-task-space-inline").length'), 1);
  await click('.work-task-space-detail [data-action=delete]');
  await until(async () => !(await order()).includes(root.id), 'task tree removed');
  assert.deepEqual(new Set(await order()), new Set([independent.id, orphan.id]));
  pass('Failure, owner delivery and deletion update the same workspace without duplicate panels or returning child cards');

  const focused = await evaluate('ui.reveal("archived-worker")');
  assert.deepEqual(focused, { runId: oldWorker.id, rootRunId: oldRoot.id }); assert.equal(await current(), oldWorker.id);
  assert.equal(await evaluate('document.querySelector(".work-task-space-detail .work-owner-talk-title").textContent'), '与亚丝娜交谈');
  assert((await evaluate('document.querySelector(".work-task-space-detail .work-owner-talk-body").textContent')).includes('Model output token limit reached'));
  const rejected = await evaluate('ui.reveal("foreign-task").then(()=>"unexpected",error=>error.message)');
  assert(rejected.includes('其他工作会话')); assert.notEqual(await current(), foreign.id);
  const persisted = await order();
  await evaluate('ui.close();document.querySelector("#fixtureTranscript").replaceChildren();ui.open({botId:"coordinator",groupId:"fixture-group",focusRunId:"archived-worker"})');
  assert.equal(await current(), oldWorker.id);
  assert.deepEqual(await order(), persisted.filter(id => [independent.id, orphan.id, oldRoot.id, oldWorker.id].includes(id)));
  pass('Reveal selects the actual member context, rejects foreign runs, and reopening retains group-specific display order');

  await evaluate('ui.close();document.querySelector("#fixtureTranscript").replaceChildren();soloUi.open({botId:"solo"})');
  await until(() => evaluate('document.querySelector("#soloTranscript > .work-run.work-task-panel")'), 'solo original task card');
  assert.equal(await evaluate('document.querySelector("#soloTranscript > .work-run").classList.contains("is-group-work")'), false);
  assert.equal(await evaluate('document.querySelector("#soloTranscript .work-task-space-inline")'), null);
  assert.equal(await evaluate('document.querySelector("#soloTranscript > .work-run > .work-owner-talk")'), null);
  assert.equal(await evaluate('!!document.querySelector("#soloTranscript > .work-run > .work-run-actions [data-action=cancel]")'), true);
  await evaluate('soloUi.close()');
  pass('Solo Work keeps its original non-group task card and actions, with no group conversation or workspace conversion');

  assert.deepEqual(browser.exceptions, []); assert.deepEqual(browser.blockedExternal, []); assert.deepEqual(failures, []);
} catch (error) { failures.push(error.stack); console.error(error.stack); process.exitCode = 1; }
finally {
  if (browser) await browser.stop().catch(error => { failures.push(error.stack); process.exitCode = 1; });
  for (const stream of streams.values()) stream.end();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ type: 'synthetic-dom-component-fixture', passed: failures.length === 0, checks, failures, requests,
    fingerprints: { ui: digest(await readFile(path.join(project, 'ui/work-session-ui.js'))), groups: digest(await readFile(path.join(project, 'ui/work-task-groups.js'))) }, screenshots: browser?.screenshots || [] }, null, 2));
  console.log('REPORT ' + path.join(output, 'report.json'));
}
