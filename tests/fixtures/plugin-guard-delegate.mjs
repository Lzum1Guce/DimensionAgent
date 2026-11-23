// Synthetic delegate used only by plugin-host-guard tests.
// It persists packages and performs real MCP stdio calls without external packages.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';

const secret = 'fixture-secret-only';
const ok = (value = {}) => ({ ok: true, ...value });
const fail = (code, message) => ({ ok: false, error: { code, message } });
const stateFile = data => path.join(data, 'plugins', 'fixture-delegate-state.json');
const plansRoot = data => path.join(data, 'plugins', 'fixture-plans');
async function state(data) { try { return JSON.parse(await readFile(stateFile(data), 'utf8')); } catch { return { plugins: {} }; } }
async function save(data, value) { await mkdir(path.dirname(stateFile(data)), { recursive: true }); const temp = stateFile(data) + '.tmp'; await writeFile(temp, JSON.stringify(value)); await rename(temp, stateFile(data)); }
const idOf = manifest => manifest.name.replace(/[^a-zA-Z0-9._-]/g, '-');
function publicRecord(record) { return structuredClone(record); }
function tool(record) { return { pluginId: record.id, serverName: 'fixture', rawName: 'echo', name: 'mcp__fixture__echo', description: 'Synthetic guarded echo', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }; }
function tools(record) { return [tool(record), ...(record.manifest.extraTool ? [{ ...tool(record), rawName: 'echo_two', name: 'mcp__fixture__echo_two', description: 'Second synthetic snapshot tool' }] : [])]; }
async function mcpCall(record, data, args) {
  const server = path.join(data, 'plugins', 'packages', record.id, record.manifest.fixture.server);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [server], { windowsHide: true, env: { ...process.env, FIXTURE_SECRET: secret, PLUGIN_DATA_DIR: path.join(data, 'plugins', 'plugin-data', record.id) }, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = createInterface({ input: child.stdout });
    const pending = new Map(); let sequence = 0, stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 4096) stderr = stderr.slice(-4096); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('synthetic MCP timeout')); }, 8000);
    const send = (method, params = {}) => new Promise((resolveCall, rejectCall) => {
      const id = ++sequence; pending.set(id, { resolve: resolveCall, reject: rejectCall });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    lines.on('line', line => {
      const message = JSON.parse(line), waiter = pending.get(message.id); if (!waiter) return;
      pending.delete(message.id); message.error ? waiter.reject(new Error('MCP error')) : waiter.resolve(message.result);
    });
    (async () => {
      await send('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture-guard', version: '1' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const result = await send('tools/call', { name: 'echo', arguments: args });
      clearTimeout(timer); child.stdin.end(); child.kill();
      if (result.isError) resolve(ok({ isError: true, text: 'Synthetic MCP error [redacted]', result: { isError: true, content: [{ type: 'text', text: 'Synthetic MCP error [redacted]' }] } }));
      else resolve(ok({ isError: false, text: result.content[0].text, result }));
    })().catch(() => { clearTimeout(timer); child.kill(); resolve(fail('MCP_REQUEST_FAILED', 'Synthetic MCP request failed [redacted]')); });
  });
}
async function handle(request) {
  const { action, dataDir } = request, current = await state(dataDir);
  if (action === 'plugin.list') return ok({ plugins: Object.values(current.plugins).map(publicRecord) });
  if (action === 'status') return ok({ sources: [], capabilities: ['synthetic-delegate'], plugins: Object.values(current.plugins).map(publicRecord) });
  if (action === 'package.inspect') {
    const manifest = JSON.parse(await readFile(path.join(request.path, 'package.json'), 'utf8'));
    const planId = createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0, 24);
    await mkdir(plansRoot(dataDir), { recursive: true });
    await writeFile(path.join(plansRoot(dataDir), planId + '.json'), JSON.stringify({ path: request.path, manifest }));
    return ok({ inspection: { planId, manifest, source: { type: 'local-directory', path: request.path }, classification: { supported: true, kind: 'mcp' }, mcpServers: [{ transport: 'stdio', serverName: 'fixture', env: { FIXTURE_SECRET: secret } }] } });
  }
  if (action === 'package.install' || action === 'package.update') {
    const plan = JSON.parse(await readFile(path.join(plansRoot(dataDir), request.planId + '.json'), 'utf8'));
    if (action === 'package.update' && plan.manifest.failUpdate) return fail('UPDATE_FAILED', 'Synthetic update failed before commit');
    const id = idOf(plan.manifest);
    if (action === 'package.update' && !current.plugins[id]) return fail('PLUGIN_NOT_INSTALLED', 'Not installed');
    const record = { id, enabled: action === 'package.update' ? current.plugins[id].enabled : false, manifest: plan.manifest, version: plan.manifest.version, source: { type: 'local-directory', path: plan.path }, mcpServers: [{ transport: 'stdio', serverName: 'fixture', env: { FIXTURE_SECRET: secret } }], skills: [], auth: plan.manifest.auth || { state: 'not-required' } };
    const target = path.join(dataDir, 'plugins', 'packages', id), staging = target + '.staging';
    await rm(staging, { recursive: true, force: true }); await cp(plan.path, staging, { recursive: true });
    if (action === 'package.update') { await rm(target, { recursive: true, force: true }); }
    await rename(staging, target); current.plugins[id] = record; await save(dataDir, current);
    return ok({ plugin: publicRecord(record), updated: action === 'package.update' });
  }
  const record = current.plugins[request.pluginId];
  if (action === 'plugin.enable') { if (!record) return fail('PLUGIN_NOT_INSTALLED', 'Not installed'); record.enabled = true; await save(dataDir, current); return ok({ plugin: publicRecord(record) }); }
  if (action === 'plugin.disable') { if (!record) return fail('PLUGIN_NOT_INSTALLED', 'Not installed'); record.enabled = false; await save(dataDir, current); return ok({ plugin: publicRecord(record) }); }
  if (action === 'plugin.remove') { if (!record) return fail('PLUGIN_NOT_INSTALLED', 'Not installed'); delete current.plugins[request.pluginId]; await save(dataDir, current); await rm(path.join(dataDir, 'plugins', 'packages', request.pluginId), { recursive: true, force: true }); return ok({ removed: request.pluginId, plugins: Object.values(current.plugins).map(publicRecord) }); }
  if (action === 'tools.list') { const enabled = Object.values(current.plugins).filter(item => item.enabled); return ok({ tools: enabled.flatMap(tools) }); }
  if (action === 'tools.call') {
    const owner = Object.values(current.plugins).find(item => item.enabled && tools(item).some(candidate => candidate.name === request.name));
    if (!owner) return fail('TOOL_NOT_FOUND', 'Tool unavailable');
    return mcpCall(owner, dataDir, request.args || {});
  }
  if (action === 'skill.list') return ok({ skills: [] });
  if (action === 'auth.login') { if (!record) return fail('PLUGIN_NOT_INSTALLED', 'Not installed'); record.auth = { state: 'connected', canLogin: true, canLogout: true }; await save(dataDir, current); return ok({ auth: record.auth, enabled: record.enabled }); }
  if (action === 'auth.logout') { if (!record) return fail('PLUGIN_NOT_INSTALLED', 'Not installed'); record.auth = { state: 'logged-out', canLogin: true, canLogout: false }; await save(dataDir, current); return ok({ auth: record.auth }); }
  if (action === 'adaptation.prepare') return ok({ adaptation: { original: { name: 'fixture-guarded-echo' }, adapter: { name: 'fixture-guarded-echo' } } });
  if (action === 'adaptation.bind') return ok({ adaptation: { runId: request.runId } });
  if (action === 'adaptation.install') return ok({ plugin: record });
  return fail('UNKNOWN_ACTION', 'Unknown synthetic action');
}

let input = ''; for await (const chunk of process.stdin) input += chunk;
try { const request = JSON.parse(input); process.stdout.write(JSON.stringify(await handle(request)) + '\n'); }
catch { process.stdout.write(JSON.stringify(fail('FIXTURE_ERROR', 'Synthetic fixture failed [redacted]')) + '\n'); }
