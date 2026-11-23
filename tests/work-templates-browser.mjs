// Isolated Chrome smoke test for the public template entry and manual-use gate.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startBrowser } from './native-browser-fixture.mjs';
import { project, parseOptions, startNative, until, digest } from './archive-export-api.mjs';

const options = parseOptions();
const output = path.resolve(options.get('output') || path.join(project, 'outputs', 'work-templates-browser', new Date().toISOString().replace(/[:.]/g, '-')));
const executable = path.resolve(options.get('exe') || path.join(project, 'outputs', 'build', 'DImensionagent-native.exe'));
const ui = path.resolve(options.get('ui') || path.join(project, 'ui'));
const data = path.join(output, 'data'), processes = [], traces = [], checks = [], failures = [];
let app, browser;
const pass = text => { checks.push(text); console.log('PASS ' + text); };
try {
  await mkdir(path.join(output, 'temp'), { recursive: true });
  app = await startNative({ label: 'native-browser', executable, ui, data, output, processes, traces });
  await app.api('/api/dimension/bots', { id: 'template-ui-bot', name: '模板界面助手', persona: '合成', mode: 'work' });
  browser = await startBrowser({ output, processes }, app.origin, options.get('chrome'));
  await until(() => browser.evaluate('!!document.querySelector("#sharedTaskTemplatesBtn") && !!document.querySelector(".task-template-dialog")'), 'public template entry ready');
  await browser.click('#sharedTaskTemplatesBtn');
  await until(() => browser.evaluate('document.querySelector(".task-template-dialog")?.open === true'), 'template dialog');
  assert.equal((await app.api('/api/dimension/work/sessions?botId=template-ui-bot&groupId=&limit=50')).runs.length, 0);
  await browser.click('.task-template-new');
  await browser.replace('.task-template-editor [name=name]', '界面合成流程');
  await browser.replace('.task-template-editor [name=description]', '只在点击后运行');
  await browser.replace('.task-template-editor [name=body]', '第一步：保存流程。\n第二步：手动执行。');
  await browser.click('.task-template-save');
  await until(() => browser.evaluate('document.querySelectorAll(".task-template-card").length === 1 && document.querySelector(".task-template-dialog .cap-status").textContent.includes("未创建任务")'), 'template saved without run');
  assert.equal((await app.api('/api/dimension/work/sessions?botId=template-ui-bot&groupId=&limit=50')).runs.length, 0);
  pass('Public entry saves a template through the real API without creating Work');

  await browser.click('.task-template-use-open');
  await until(() => browser.evaluate('!document.querySelector(".task-template-use").hidden && document.querySelector(".task-template-target").textContent.includes("模板界面助手")'), 'manual target confirmation');
  assert.equal(await browser.evaluate('document.querySelector(".task-template-target").textContent.includes("Bot 私聊")'), true);
  assert.equal(browser.requests.some(row => row.pathname.endsWith('/use')), false);
  await browser.click('.task-template-use-submit');
  await until(() => browser.evaluate('document.querySelector(".task-template-dialog .cap-status").textContent.includes("已创建新任务")'), 'manual use created run');
  const sessions = await app.api('/api/dimension/work/sessions?botId=template-ui-bot&groupId=&limit=50');
  assert.equal(sessions.runs.length, 1);
  assert.equal(sessions.runs[0].text, '第一步：保存流程。\n第二步：手动执行。');
  assert.equal(sessions.runs[0].inputContext, null);
  assert.equal(browser.requests.filter(row => row.pathname.endsWith('/use')).length, 1);
  await browser.screenshot('task-template-manual-use');
  assert.deepEqual(browser.exceptions, []);
  assert.deepEqual(browser.blockedExternal, []);
  pass('Use button shows current Bot/scope first; only the confirmation click creates one context-free run');
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ ok: true, checks, failures,
    fingerprints: { native: digest(await readFile(executable)), ui: digest(await readFile(path.join(ui, 'task-templates-ui.js'))) },
    screenshots: browser.screenshots, productionDataUsed: false }, null, 2));
} catch (error) {
  failures.push(error.stack); process.exitCode = 1; console.error(error);
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ ok: false, checks, failures, productionDataUsed: false }, null, 2));
} finally {
  if (browser) await browser.stop().catch(error => { failures.push(error.message); process.exitCode = 1; });
  if (app?.child.exitCode === null) await app.stop().catch(error => { failures.push(error.message); process.exitCode = 1; });
}
