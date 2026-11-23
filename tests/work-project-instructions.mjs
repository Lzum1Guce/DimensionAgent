// node tests/work-project-instructions.mjs --exe <native executable> --output <test directory>
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { parseOptions, startNative, until } from './archive-export-api.mjs';

const options = parseOptions();
const executable = path.resolve(options.get('exe'));
const outputRoot = path.resolve(options.get('output'));
await mkdir(outputRoot, { recursive: true });
const output = await mkdtemp(path.join(outputRoot, 'project-rules-'));
const repo = path.join(output, 'repo');
const workspace = path.join(repo, 'app');
const frontend = path.join(workspace, 'frontend');
const target = path.join(frontend, 'result.txt');
await mkdir(path.join(repo, '.git'), { recursive: true });
await mkdir(frontend, { recursive: true });
await writeFile(path.join(repo, 'AGENTS.md'), 'SHADOWED');
await writeFile(path.join(repo, 'AGENTS.override.md'), 'ROOT-OVERRIDE');
await writeFile(path.join(workspace, 'CLAUDE.md'), 'APP-FALLBACK');
await writeFile(path.join(frontend, 'AGENTS.md'), 'FRONTEND-RULE');

let round = 0;
const errors = [];
const model = createServer(async (req, res) => {
  try {
    let bytes = '';
    for await (const chunk of req) bytes += chunk;
    const { tools, messages } = JSON.parse(bytes);
    res.setHeader('content-type', 'application/json');
    if (!tools?.some(tool => tool.function.name === 'write_file')) {
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] }));
      return;
    }

    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    assert(system.includes('ROOT-OVERRIDE') && system.includes('APP-FALLBACK'));
    assert(!system.includes('SHADOWED') && !system.includes('FRONTEND-RULE'));
    let name = 'write_file';
    let args = { scope: 'project', path: 'frontend/result.txt', content: 'reviewed' };
    const previous = messages.findLast(message => message.role === 'tool');
    if (round === 0) {
      args.instructionRevision = system.match(/instructionRevision）.*?([a-f0-9]{64})/)[1];
    } else if (round === 1 || round === 2) {
      await assert.rejects(access(target), { code: 'ENOENT' });
      const result = JSON.parse(previous.content);
      assert(result.error && result.metadata.no_side_effects);
      assert(result.result.includes(round === 1 ? 'FRONTEND-RULE' : 'UPDATED-RULE'));
      args.instructionRevision = result.result.match(/instructionRevision=([a-f0-9]{64})/)[1];
      if (round === 1) await writeFile(path.join(frontend, 'AGENTS.md'), 'UPDATED-RULE');
    } else {
      assert.equal(round, 3);
      assert.equal(await readFile(target, 'utf8'), 'reviewed');
      name = 'task_finish';
      args = { summary: 'Verified', evidenceCallIds: [previous.tool_call_id] };
    }
    const call = { id: 'step-' + ++round, type: 'function', function: { name, arguments: JSON.stringify(args) } };
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [call] }, finish_reason: 'tool_calls' }] }));
  } catch (error) {
    errors.push(error.message);
    res.writeHead(500);
    res.end(error.message);
  }
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
let app;
try {
  app = await startNative({
    label: 'project-instructions', executable, ui: path.resolve(import.meta.dirname, '../ui'),
    data: path.join(output, 'data'), output,
  });
  const botId = 'rules';
  await app.api('/api/dimension/bots', { id: botId, name: 'Rules', mode: 'work' });
  await app.api('/api/dimension/work/settings', {
    botId, cliEngine: 'builtin', workspaceMode: 'windows_native', projectCwd: workspace, approvalMode: 'full',
  }, 'PATCH');
  await app.api('/api/providers', {
    name: 'fixture', secretValue: 'fixture',
    entry: { kind: 'openai-chat-compat', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, spec: { model: 'fixture' } },
  });
  const { run } = await app.api('/api/dimension/work/runs', { botId, text: 'Write frontend/result.txt', requestId: 'rules' });
  const done = await until(async () => {
    const state = await app.api('/api/dimension/work/runs/' + run.id);
    return state.terminal && !state.executing ? state : null;
  }, 'project instruction delivery', 30000);
  assert.deepEqual(errors, []);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(round, 4);
  const events = done.events.filter(e => e.kind === 'project-instructions').map(e => e.instructions);
  assert.equal(events.length, 3);
  assert.deepEqual(events[0].files.map(f => f.path.replaceAll('\\', '/')), ['AGENTS.override.md', 'app/CLAUDE.md']);
  assert.equal(events.at(-1).files.at(-1).sha256, createHash('sha256').update('UPDATED-RULE').digest('hex'));
  console.log('PASS project instruction precedence, nested writes, revision checks, persisted UI metadata');
} finally {
  model.closeAllConnections();
  model.close();
  if (app) await app.stop();
}
