// DimensionAgent plugin access-control guard.
// The configured plugin host remains responsible for packages, MCP and skills.
// This worker adds persisted scope, permission and run snapshots without secrets.
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleRequest as defaultHostHandleRequest } from './plugin-host.mjs';

const STATE_VERSION = 1;
const MAX_RESPONSE = 4 * 1024 * 1024;
const LOCK_STALE_MS = 10 * 60 * 1000;
const MAX_RUN_RECORDS = 500;
const DEFAULT_HOST_FILE = path.resolve(fileURLToPath(new URL('./plugin-host.mjs', import.meta.url)));
const SENSITIVE_KEY_RE = /(?:secret|password|passwd|token|credential|api[_-]?key|private[_-]?key|access[_-]?key|authorization|cookie|bearer)/i;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clone = value => structuredClone(value);
const now = () => new Date().toISOString();
const pluginIdOf = plugin => String(plugin?.id || plugin?.pluginId || '');
const manifestOf = plugin => plugin?.manifest || {};
const array = value => Array.isArray(value) ? value : [];

class GuardError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const failure = (code, message) => ({ ok: false, error: { code, message } });

function killProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise(resolve => execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
  }
  try { process.kill(pid, 'SIGKILL'); } catch {}
  return Promise.resolve();
}

function validId(value, label) {
  if (typeof value !== 'string' || !value.length || value.length > 256 || /[\u0000-\u001f\\/\r\n]/.test(value)) {
    throw new GuardError('INVALID_SCOPE', `${label}无效`);
  }
  return value;
}

function sanitize(value, key = '') {
  if (Array.isArray(value)) return value.map(item => sanitize(item));
  if (!value || typeof value !== 'object') {
    return SENSITIVE_KEY_RE.test(key) && value != null ? '[redacted]' : value;
  }
  const result = {};
  for (const [childKey, child] of Object.entries(value)) {
    if (childKey === '__proto__' || childKey === 'constructor' || childKey === 'prototype') continue;
    if (['env', 'headers'].includes(childKey) && child && typeof child === 'object' && !Array.isArray(child)) {
      result[childKey] = Object.fromEntries(Object.keys(child).map(name => [name, '[redacted]']));
    } else if (SENSITIVE_KEY_RE.test(childKey) && child != null && typeof child !== 'object') {
      result[childKey] = '[redacted]';
    } else if (childKey === 'url' && typeof child === 'string') {
      try { const url = new URL(child); url.username = ''; url.password = ''; result[childKey] = url.toString(); }
      catch { result[childKey] = child; }
    } else result[childKey] = sanitize(child, childKey);
  }
  return result;
}

function permissionInfo(plugin) {
  const manifest = manifestOf(plugin);
  const declared = manifest.permissions || manifest.dsh?.permissions || plugin.declaredPermissions;
  const values = [];
  for (const item of array(declared)) {
    if (typeof item === 'string' && item.trim()) values.push({ id: item.trim(), label: item.trim() });
    else if (item && typeof item === 'object') {
      const id = String(item.id || item.permission || item.name || '').trim();
      if (id) values.push({ id, label: String(item.label || item.description || id) });
    }
  }
  for (const server of array(plugin.mcpServers)) {
    if (server.transport === 'stdio') {
      const cmdDesc = server.commandLabel
        ? `${server.commandLabel}${server.execDigest ? '#' + server.execDigest : ''}`
        : 'stdio';
      values.push({ id: `process:execute:${cmdDesc}`, label: `启动插件声明的本地 MCP 进程${server.commandLabel ? ' (' + server.commandLabel + ')' : ''}` });
      values.push({ id: 'workspace:access', label: '访问当前 Work 任务工作区路径' });
      const envNames = Array.isArray(server.envKeys) ? server.envKeys : Object.keys(server.env || {});
      for (const name of envNames) values.push({ id: `secret:env:${name}`, label: `使用已配置环境变量 ${name}（值不展示）` });
    }
    if (server.transport === 'streamable-http') {
      let origin = typeof server.endpointOrigin === 'string' && server.endpointOrigin ? server.endpointOrigin : '';
      if (!origin && server.url) {
        try { origin = new URL(server.url).origin; } catch {}
      }
      if (!origin) origin = '远程服务';
      values.push({ id: `network:${origin}`, label: `连接 ${origin}` });
      const headerNames = Array.isArray(server.headerKeys) ? server.headerKeys : Object.keys(server.headers || {});
      for (const name of headerNames) values.push({ id: `secret:header:${name}`, label: `使用已配置请求头 ${name}（值不展示）` });
    }
  }
  if (!values.length) values.push({ id: array(plugin.skills).length ? 'instructions:read' : 'runtime:plugin', label: array(plugin.skills).length ? '读取插件内 Skill 指令' : '使用插件声明的运行能力' });
  const unique = new Map(values.map(item => [item.id, { id: item.id.slice(0, 300), label: item.label.slice(0, 500) }]));
  const permissions = [...unique.values()].sort((a, b) => a.id.localeCompare(b.id));
  // Labels are presentation, not authority; changing wording is not a grant change.
  const fingerprint = createHash('sha256').update(JSON.stringify(permissions.map(item => item.id))).digest('hex');
  return { permissions, fingerprint };
}

function authInfo(plugin) {
  const manifest = manifestOf(plugin);
  const declared = plugin.auth || manifest.auth || manifest.dsh?.auth || {};
  const required = declared.required === true || declared.state === 'required';
  const state = declared.state === 'connected' ? 'connected'
    : ['logged-out', 'expired', 'required'].includes(declared.state) ? declared.state
    : required ? 'logged-out' : 'not-required';
  return { state, canLogin: declared.canLogin === true, canLogout: state === 'connected' && declared.canLogout !== false };
}

function emptyState() { return { schema: STATE_VERSION, plugins: {}, runs: {}, adaptations: {}, pendingAdaptations: {}, revokedAdaptations: {}, revokedAdaptationIds: {}, removed: {} }; }
function stateRoot(dataDir) { return path.join(dataDir, 'plugins', 'access-control'); }
function stateFile(dataDir) { return path.join(stateRoot(dataDir), 'state.json'); }
function pluginDataRoot(dataDir) { return path.join(dataDir, 'plugins', 'plugin-data'); }
async function readState(dataDir) {
  try {
    const value = JSON.parse(await readFile(stateFile(dataDir), 'utf8'));
    if (value?.schema !== STATE_VERSION) throw new GuardError('STATE_INVALID', '插件授权状态版本无效');
    return { ...emptyState(), ...value };
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw error;
  }
}
function pruneRuns(state) {
  const entries = Object.entries(state.runs || {});
  if (entries.length <= MAX_RUN_RECORDS) return;
  entries.sort((a, b) => (Date.parse(a[1]?.createdAt || 0) || 0) - (Date.parse(b[1]?.createdAt || 0) || 0));
  const toDelete = entries.slice(0, entries.length - MAX_RUN_RECORDS);
  for (const [runId] of toDelete) delete state.runs[runId];
}
async function writeState(dataDir, value, baselineJson = null) {
  pruneRuns(value);
  const serialized = JSON.stringify(value);
  if (baselineJson !== null && serialized === baselineJson) return;
  await mkdir(stateRoot(dataDir), { recursive: true });
  const target = stateFile(dataDir), temporary = target + '.' + process.pid + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, serialized, { mode: 0o600 });
  await rename(temporary, target);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e?.code === 'EPERM'; }
}
function ownerExpired(owner, fallbackMtimeMs = 0) {
  const createdMs = Date.parse(owner?.createdAt || '') || fallbackMtimeMs;
  if (createdMs && Date.now() - createdMs > LOCK_STALE_MS) return true;
  return !Number.isInteger(owner?.pid) || !alive(owner.pid);
}
async function acquireLock(dataDir) {
  await mkdir(stateRoot(dataDir), { recursive: true });
  const filename = path.join(stateRoot(dataDir), 'state.lock');
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    try {
      const handle = await open(filename, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: now() }));
      return async () => { await handle.close().catch(() => {}); await unlink(filename).catch(() => {}); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let reclaim = false;
      try {
        const owner = JSON.parse(await readFile(filename, 'utf8'));
        reclaim = ownerExpired(owner);
      } catch {
        const info = await stat(filename).catch(() => null);
        reclaim = Boolean(info && Date.now() - info.mtimeMs > 30000);
      }
      if (reclaim) { await unlink(filename).catch(() => {}); continue; }
      await sleep(35);
    }
  }
  throw new GuardError('STATE_BUSY', '插件授权状态正被其他调用使用');
}

function invocationRoot(dataDir) { return path.join(stateRoot(dataDir), 'invocation'); }
async function ownerFiles(directory) {
  const result = [];
  for (const name of await readdir(directory).catch(() => [])) {
    if (!name.endsWith('.json')) continue;
    const filename = path.join(directory, name);
    try {
      const owner = JSON.parse(await readFile(filename, 'utf8'));
      if (!ownerExpired(owner)) result.push(filename);
      else await unlink(filename).catch(() => {});
    } catch {
      const info = await stat(filename).catch(() => null);
      if (info && Date.now() - info.mtimeMs > 30000) await unlink(filename).catch(() => {});
    }
  }
  return result;
}
async function createOwnerFile(directory) {
  await mkdir(directory, { recursive: true });
  const filename = path.join(directory, `${process.pid}-${randomUUID()}.json`);
  const handle = await open(filename, 'wx', 0o600);
  await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: now() }));
  await handle.close();
  return filename;
}
async function acquireInvocationRead(dataDir) {
  const root = invocationRoot(dataDir), readers = path.join(root, 'readers'), writers = path.join(root, 'writers');
  await mkdir(readers, { recursive: true }); await mkdir(writers, { recursive: true });
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    if ((await ownerFiles(writers)).length) { await sleep(20); continue; }
    const filename = await createOwnerFile(readers);
    if (!(await ownerFiles(writers)).length) return async () => { await unlink(filename).catch(() => {}); };
    await unlink(filename).catch(() => {}); await sleep(20);
  }
  throw new GuardError('INVOCATION_BUSY', '插件调用读锁等待超时');
}
async function acquireInvocationWrite(dataDir) {
  const root = invocationRoot(dataDir), readers = path.join(root, 'readers'), writers = path.join(root, 'writers');
  await mkdir(readers, { recursive: true }); await mkdir(writers, { recursive: true });
  const intent = await createOwnerFile(writers);
  const mutex = path.join(root, 'write.lock');
  let handle;
  const deadline = Date.now() + 300000;
  try {
    while (!handle && Date.now() < deadline) {
      try { handle = await open(mutex, 'wx', 0o600); await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: now() })); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let reclaim = false;
        try { const owner = JSON.parse(await readFile(mutex, 'utf8')); reclaim = ownerExpired(owner); }
        catch { const info = await stat(mutex).catch(() => null); reclaim = Boolean(info && Date.now() - info.mtimeMs > 30000); }
        if (reclaim) await unlink(mutex).catch(() => {}); else await sleep(25);
      }
    }
    if (!handle) throw new GuardError('INVOCATION_BUSY', '插件调用写锁等待超时');
    while ((await ownerFiles(readers)).length) {
      if (Date.now() >= deadline) throw new GuardError('INVOCATION_BUSY', '等待已派发插件调用结束超时');
      await sleep(25);
    }
    return async () => {
      await handle.close().catch(() => {}); await unlink(mutex).catch(() => {}); await unlink(intent).catch(() => {});
    };
  } catch (error) {
    if (handle) { await handle.close().catch(() => {}); await unlink(mutex).catch(() => {}); }
    await unlink(intent).catch(() => {}); throw error;
  }
}
async function stateTransaction(dataDir, operation) {
  const release = await acquireLock(dataDir);
  try {
    const state = await readState(dataDir);
    const baselineJson = JSON.stringify(state);
    return await operation(state, baselineJson);
  } finally { await release(); }
}

async function delegate(request) {
  const host = request.pluginHost;
  if (!path.isAbsolute(host || '')) throw new GuardError('INVALID_REQUEST', '插件宿主路径无效');
  const input = clone(request);
  delete input.pluginHost;
  for (const key of ['scope', 'approvedPermissions', 'permissionFingerprint', 'botId', 'runId', 'runCreatedAt']) {
    if (!request.action.startsWith('adaptation.')) delete input[key];
  }
  if (['tools.list', 'skill.list'].includes(request.action)) {
    for (const key of Object.keys(input)) if (!['action', 'dataDir'].includes(key)) delete input[key];
  }
  if (request.action === 'tools.call') {
    for (const key of Object.keys(input)) if (!['action', 'dataDir', 'name', 'args', 'workspace'].includes(key)) delete input[key];
  }
  if (request.action === 'skill.read') {
    for (const key of Object.keys(input)) if (!['action', 'dataDir', 'pluginId', 'skillId'].includes(key)) delete input[key];
  }

  // Fast path: directly invoke sibling plugin-host.mjs in-process, avoiding 3-4 Node process spawns per call!
  if (path.resolve(host) === DEFAULT_HOST_FILE) {
    let timer;
    try {
      const value = await Promise.race([
        defaultHostHandleRequest(input),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new GuardError('HOST_TIMEOUT', '插件宿主调用超时')), 95000); }),
      ]);
      if (Buffer.byteLength(JSON.stringify(value)) > MAX_RESPONSE) {
        throw new GuardError('HOST_RESPONSE_LIMIT', '插件宿主响应过大');
      }
      return value;
    } finally {
      clearTimeout(timer);
    }
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [host], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const finish = (callback, value) => { if (!settled) { settled = true; clearTimeout(timer); callback(value); } };
    const timer = setTimeout(async () => {
      if (child.pid) await killProcessTree(child.pid);
      finish(reject, new GuardError('HOST_TIMEOUT', '插件宿主调用超时'));
    }, 95000);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_RESPONSE) {
        if (child.pid) void killProcessTree(child.pid);
        finish(reject, new GuardError('HOST_RESPONSE_LIMIT', '插件宿主响应过大'));
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 65536) stderr = stderr.slice(-65536); });
    child.on('error', error => finish(reject, error));
    child.on('exit', code => {
      if (code !== 0) return finish(reject, new GuardError('HOST_FAILED', '插件宿主未正常完成调用'));
      try {
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        if (lines.length !== 1) throw new Error('line count');
        const value = JSON.parse(lines[0]);
        if (Buffer.byteLength(JSON.stringify(value)) > MAX_RESPONSE) throw new Error('size');
        finish(resolve, value);
      } catch { finish(reject, new GuardError('HOST_PROTOCOL', '插件宿主响应协议无效')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input) + '\n');
  });
}

async function rawPlugins(request) {
  const response = await delegate({ action: 'plugin.list', dataDir: request.dataDir, pluginHost: request.pluginHost });
  if (!response.ok) throw new GuardError(response.error?.code || 'HOST_FAILED', response.error?.message || '无法读取插件状态');
  return array(response.plugins);
}
function scopeKey(scope) { return scope.type === 'shared' ? 'shared' : scope.type === 'bot' ? `bot:${scope.botId}` : `run:${scope.runId}`; }
function normalizeScope(request) {
  const scope = request.scope || { type: 'shared' };
  if (!scope || typeof scope !== 'object' || !['shared', 'bot', 'run'].includes(scope.type)) throw new GuardError('INVALID_SCOPE', '启用范围必须为共享、Bot 或单个 Work 任务');
  const result = { type: scope.type };
  if (scope.type === 'bot') result.botId = validId(scope.botId, 'Bot 范围');
  if (scope.type === 'run') { result.botId = validId(scope.botId, 'Bot 范围'); result.runId = validId(scope.runId, 'Work 范围'); }
  return result;
}
function scopeMatches(scope, request) {
  if (scope.type === 'shared') return true;
  if (!request.botId || scope.botId !== request.botId) return false;
  return scope.type === 'bot' || (scope.type === 'run' && scope.runId === request.runId);
}
function selectScope(record, request) {
  const scopes = Object.values(record?.scopes || {}).filter(scope => scopeMatches(scope, request));
  return scopes.sort((a, b) => ({ shared: 0, bot: 1, run: 2 }[a.type] - { shared: 0, bot: 1, run: 2 }[b.type])).at(-1) || null;
}

function syncPlugins(state, plugins) {
  const present = new Set();
  for (const plugin of plugins) {
    const id = pluginIdOf(plugin); if (!id) continue;
    present.add(id);
    const info = permissionInfo(plugin), auth = authInfo(plugin);
    let record = state.plugins[id];
    if (!record) {
      record = state.plugins[id] = {
        fingerprint: info.fingerprint,
        permissions: info.permissions,
        scopes: {},
        managed: true,
        reconfirmRequired: Boolean(plugin.enabled),
        confirmedAt: '',
      };
    } else if (record.fingerprint !== info.fingerprint) {
      record.previousFingerprint = record.fingerprint;
      record.fingerprint = info.fingerprint;
      record.permissions = info.permissions;
      record.reconfirmRequired = true;
      record.scopes = {};
    } else record.permissions = info.permissions;
    record.name = manifestOf(plugin).name || plugin.name || id;
    record.version = manifestOf(plugin).version || plugin.version || '';
    record.auth = auth;
    if (!plugin.enabled && record.managed) record.scopes = {};
    if (record.reconfirmRequired) record.scopes = {};
    delete state.removed[id];
  }
  for (const id of Object.keys(state.plugins)) {
    if (present.has(id)) continue;
    const record = state.plugins[id];
    if (record.managed && Object.keys(record.scopes || {}).length) record.scopes = {};
  }
}
function publicPlugin(plugin, record) {
  const value = sanitize(plugin);
  const enabledScopes = Object.values(record?.scopes || {});
  value.installed = true;
  value.hostEnabled = plugin.enabled === true;
  value.enabled = plugin.enabled === true && enabledScopes.length > 0;
  value.enabledState = value.enabled ? 'enabled' : 'disabled';
  value.auth = record?.auth || authInfo(plugin);
  value.permissions = record?.permissions || permissionInfo(plugin).permissions;
  value.permissionFingerprint = record?.fingerprint || permissionInfo(plugin).fingerprint;
  value.permissionReconfirmationRequired = record?.reconfirmRequired === true;
  value.previousPermissionFingerprint = record?.previousFingerprint || null;
  value.scopes = enabledScopes.map(scope => ({ type: scope.type, ...(scope.botId ? { botId: scope.botId } : {}), ...(scope.runId ? { runId: scope.runId } : {}), confirmedAt: scope.confirmedAt, permissionFingerprint: scope.fingerprint }));
  return value;
}
function exportPlugin(plugin, record) {
  const manifest = manifestOf(plugin), decorated = publicPlugin(plugin, record);
  return {
    id: pluginIdOf(plugin), name: manifest.name || plugin.name || pluginIdOf(plugin), version: manifest.version || plugin.version || '',
    license: manifest.license || plugin.license || '', description: manifest.description || '', source: sanitize(plugin.source || null),
    installed: true, enabled: decorated.enabled, enabledState: decorated.enabledState, auth: decorated.auth,
    permissions: decorated.permissions, permissionFingerprint: decorated.permissionFingerprint,
    permissionReconfirmationRequired: decorated.permissionReconfirmationRequired, scopes: decorated.scopes,
  };
}
function ensureConfirmation(request, record) {
  if (!record?.reconfirmRequired) return;
  const approved = Array.isArray(request.approvedPermissions) ? [...new Set(request.approvedPermissions)].sort() : [];
  const expected = record.permissions.map(item => item.id).sort();
  if (request.permissionFingerprint !== record.fingerprint || JSON.stringify(approved) !== JSON.stringify(expected)) {
    throw new GuardError('PERMISSION_CONFIRMATION_REQUIRED', '插件权限已变化，必须核对完整权限清单并重新确认');
  }
}
function ensureAuth(record) {
  if (record?.auth && !['not-required', 'connected'].includes(record.auth.state)) throw new GuardError('AUTH_REQUIRED', '插件尚未完成登录；登录与启用是两个独立步骤');
}
function runView(state, request, record, available, kind) {
  if (!request.runId) return available;
  const runId = validId(request.runId, 'Work 任务');
  if (request.runCreatedAt && !Number.isFinite(Date.parse(request.runCreatedAt))) throw new GuardError('RUN_SCOPE', 'Work 任务创建时间无效');
  const run = state.runs[runId] || (state.runs[runId] = { createdAt: request.runCreatedAt || now(), plugins: {} });
  if (request.runCreatedAt && run.createdAt !== request.runCreatedAt) {
    if (Date.parse(run.createdAt) !== Date.parse(request.runCreatedAt)) throw new GuardError('RUN_SCOPE', 'Work 任务创建时间与授权快照不一致');
  }
  const id = record.id;
  const scope = selectScope(record, request);
  if (!scope) return [];
  let grant = run.plugins[id];
  if (!grant) {
    if (scope.confirmedAt && Date.parse(scope.confirmedAt) > Date.parse(run.createdAt)) return [];
    grant = run.plugins[id] = { fingerprint: record.fingerprint, tools: kind === 'tools' ? available.map(item => item.name) : [], skills: kind === 'skills' ? available.map(item => item.skillId) : [] };
  }
  if (grant.fingerprint !== record.fingerprint) throw new GuardError('RUN_PERMISSION_SNAPSHOT', '旧 Work 任务保留原权限快照，不会自动获得新权限；请新建任务');
  if (kind === 'tools') return available.filter(item => grant.tools.includes(item.name));
  return available.filter(item => grant.skills.includes(item.skillId));
}
function requirePlugin(state, id) {
  const record = state.plugins[id];
  if (!record) throw new GuardError(state.removed[id] ? 'PLUGIN_NOT_INSTALLED' : 'PLUGIN_DISABLED', state.removed[id] ? '插件已卸载，后续调用已拒绝' : '插件不可用');
  return { ...record, id };
}
function revokeRun(state, runId, pluginId) { if (state.runs[runId]?.plugins) delete state.runs[runId].plugins[pluginId]; }

function groupByPluginId(items) {
  const grouped = new Map();
  for (const item of items) {
    const pid = item.pluginId;
    if (!grouped.has(pid)) grouped.set(pid, []);
    grouped.get(pid).push(item);
  }
  return grouped;
}

function collectScopedItems(state, request, items, kind) {
  const byPlugin = groupByPluginId(items);
  const visible = [];
  for (const [pluginId, available] of byPlugin.entries()) {
    const record = state.plugins[pluginId];
    if (!record || !selectScope({ ...record, id: pluginId }, request)) continue;
    try {
      visible.push(...runView(state, request, { ...record, id: pluginId }, available, kind));
    } catch (error) {
      if (error.code !== 'RUN_PERMISSION_SNAPSHOT') throw error;
    }
  }
  return visible;
}

async function guarded(request) {
  const { action, dataDir } = request;
  const state = await readState(dataDir);
  const baselineJson = JSON.stringify(state);
  if (action.startsWith('adaptation.') && ((request.runId && state.revokedAdaptations[request.runId]) ||
      (request.adaptationId && state.revokedAdaptationIds[request.adaptationId]))) {
    throw new GuardError('ADAPTATION_REVOKED', '插件已卸载，本任务的适配授权已撤销');
  }
  if (action === 'plugin.enable') {
    const id = validId(request.pluginId, '插件'), scope = normalizeScope(request);
    const plugins = await rawPlugins(request); syncPlugins(state, plugins);
    const raw = plugins.find(plugin => pluginIdOf(plugin) === id);
    if (!raw) throw new GuardError('PLUGIN_NOT_INSTALLED', '插件未安装或已卸载');
    const record = state.plugins[id];
    ensureConfirmation(request, record); ensureAuth(record);
    let enabled = raw;
    if (!raw.enabled) {
      const response = await delegate({ action: 'plugin.enable', dataDir, pluginHost: request.pluginHost, pluginId: id });
      if (!response.ok) return sanitize(response);
      enabled = response.plugin || { ...raw, enabled: true };
    }
    const tools = await delegate({ action: 'tools.list', dataDir, pluginHost: request.pluginHost });
    if (!tools.ok) throw new GuardError('ENABLE_FAILED', '插件启用后的工具检查失败，未授予新范围');
    record.managed = true; record.reconfirmRequired = false; record.previousFingerprint = null;
    record.confirmedAt = now();
    record.scopes[scopeKey(scope)] = { ...scope, fingerprint: record.fingerprint, confirmedAt: record.confirmedAt };
    await writeState(dataDir, state, baselineJson);
    return { ...sanitize(tools), plugin: publicPlugin(enabled, record) };
  }
  if (action === 'plugin.disable') {
    const id = validId(request.pluginId, '插件');
    const plugins = await rawPlugins(request); syncPlugins(state, plugins);
    const record = requirePlugin(state, id);
    const revokeAll = !request.scope;
    const scope = revokeAll ? null : normalizeScope(request);
    if (revokeAll) record.scopes = {}; else delete record.scopes[scopeKey(scope)];
    record.managed = true;
    let response = { ok: true };
    if (!Object.keys(record.scopes).length) {
      response = await delegate({ action: 'plugin.disable', dataDir, pluginHost: request.pluginHost, pluginId: id });
      if (!response.ok) return sanitize(response);
    }
    await writeState(dataDir, state, baselineJson);
    const raw = plugins.find(plugin => pluginIdOf(plugin) === id) || {};
    return { ...sanitize(response), plugin: publicPlugin({ ...raw, enabled: Object.keys(record.scopes).length > 0 }, record) };
  }
  if (action === 'plugin.remove') {
    const id = validId(request.pluginId, '插件');
    const plugins = await rawPlugins(request); syncPlugins(state, plugins);
    const raw = plugins.find(plugin => pluginIdOf(plugin) === id);
    if (!raw) throw new GuardError('PLUGIN_NOT_INSTALLED', '插件已卸载');
    const record = state.plugins[id] || { scopes: {}, name: manifestOf(raw).name || id };
    const allTools = await delegate({ action: 'tools.list', dataDir, pluginHost: request.pluginHost });
    const toolNames = array(allTools.tools).filter(tool => tool.pluginId === id).map(tool => tool.name);
    const response = await delegate({ action: 'plugin.remove', dataDir, pluginHost: request.pluginHost, pluginId: id });
    if (!response.ok) return sanitize(response);
    const revokedAdaptations = [];
    for (const [runId, grant] of Object.entries(state.adaptations)) {
      if (grant.pluginId === id || (grant.name && grant.name === record.name)) {
        state.revokedAdaptations[runId] = { pluginId: id, revokedAt: now() };
        if (grant.adaptationId) state.revokedAdaptationIds[grant.adaptationId] = { pluginId: id, revokedAt: now() };
        revokeRun(state, runId, id); revokedAdaptations.push(runId); delete state.adaptations[runId];
      }
    }
    for (const [adaptationId, grant] of Object.entries(state.pendingAdaptations)) if (grant.name === record.name) {
      state.revokedAdaptationIds[adaptationId] = { pluginId: id, revokedAt: now() };
      delete state.pendingAdaptations[adaptationId];
    }
    for (const run of Object.values(state.runs)) delete run.plugins[id];
    const dataDirectory = path.join(pluginDataRoot(dataDir), id);
    const dataRetained = await stat(dataDirectory).then(info => info.isDirectory(), () => false);
    state.removed[id] = { name: record.name, version: record.version, toolNames, dataRetained, removedAt: now() };
    delete state.plugins[id];
    await writeState(dataDir, state, baselineJson);
    return { ...sanitize(response), plugins: array(response.plugins).map(plugin => publicPlugin(plugin, state.plugins[pluginIdOf(plugin)])), revokedScopes: Object.keys(record.scopes || {}).length, revokedAdaptations, dataRetained, dataDeleted: false };
  }
  if (action === 'plugin.data.delete') {
    const id = validId(request.pluginId, '插件');
    if (!state.removed[id]) throw new GuardError('PLUGIN_STILL_INSTALLED', '删除数据与卸载分离；请先卸载插件');
    const root = path.resolve(pluginDataRoot(dataDir)), target = path.resolve(root, id);
    if (path.dirname(target) !== root) throw new GuardError('UNSAFE_PATH', '插件数据路径无效');
    await rm(target, { recursive: true, force: true });
    state.removed[id].dataRetained = false; state.removed[id].dataDeletedAt = now();
    await writeState(dataDir, state, baselineJson);
    return { ok: true, pluginId: id, dataDeleted: true, uninstalled: true };
  }
  if (action === 'auth.logout') {
    const id = validId(request.pluginId, '插件');
    const response = await delegate(request);
    if (!response.ok) return sanitize(response);
    const record = requirePlugin(state, id);
    record.scopes = {}; record.managed = true; record.auth = { ...record.auth, state: 'logged-out', canLogout: false };
    await delegate({ action: 'plugin.disable', dataDir, pluginHost: request.pluginHost, pluginId: id });
    await writeState(dataDir, state, baselineJson); return sanitize(response);
  }
  if (action === 'package.install' || action === 'package.update' || action.startsWith('auth.')) {
    const response = await delegate(request);
    if (!response.ok) return sanitize(response);
    const plugins = await rawPlugins(request); syncPlugins(state, plugins); await writeState(dataDir, state, baselineJson);
    const id = pluginIdOf(response.plugin);
    return id ? { ...sanitize(response), plugin: publicPlugin(plugins.find(plugin => pluginIdOf(plugin) === id), state.plugins[id]) } : sanitize(response);
  }
  if (action === 'adaptation.prepare') {
    const response = await delegate(request); if (!response.ok) return sanitize(response);
    state.pendingAdaptations[request.adaptationId] = { name: response.adaptation?.original?.name || response.adaptation?.adapter?.name || '', preparedAt: now() };
    await writeState(dataDir, state, baselineJson); return sanitize(response);
  }
  if (action === 'adaptation.bind') {
    const response = await delegate(request); if (!response.ok) return sanitize(response);
    const pending = state.pendingAdaptations[request.adaptationId] || {};
    state.adaptations[request.runId] = { ...pending, adaptationId: request.adaptationId, botId: request.botId, boundAt: now() };
    await writeState(dataDir, state, baselineJson); return sanitize(response);
  }
  if (action === 'adaptation.install') {
    const response = await delegate(request); if (!response.ok) return sanitize(response);
    const id = pluginIdOf(response.plugin);
    if (state.adaptations[request.runId]) state.adaptations[request.runId].pluginId = id;
    const plugins = await rawPlugins(request); syncPlugins(state, plugins); await writeState(dataDir, state, baselineJson);
    return sanitize(response);
  }
  return sanitize(await delegate(request));
}

const passthroughReadActions = new Set(['source.add', 'source.remove', 'source.list', 'market.list', 'market.versions', 'package.inspect', 'local.discover']);

async function guardedRead(request) {
  const { action, dataDir } = request;
  if (passthroughReadActions.has(action)) {
    return sanitize(await delegate(request));
  }
  if (action === 'plugin.list' || action === 'status') {
    let base = { ok: true };
    if (action === 'status') {
      base = await delegate({ action: 'status', dataDir, pluginHost: request.pluginHost });
      if (!base.ok) return sanitize(base);
    }
    const plugins = action === 'status' && Array.isArray(base.plugins) ? base.plugins : await rawPlugins(request);
    return stateTransaction(dataDir, async (state, baselineJson) => {
      syncPlugins(state, plugins);
      const response = { ...sanitize(base), ok: true, plugins: plugins.map(plugin => publicPlugin(plugin, state.plugins[pluginIdOf(plugin)])) };
      response.retainedData = Object.entries(state.removed).filter(([, item]) => item.dataRetained).map(([pluginId, item]) => ({ pluginId, name: item.name, version: item.version }));
      await writeState(dataDir, state, baselineJson); return response;
    });
  }
  if (action === 'plugin.export') {
    const plugins = await rawPlugins(request);
    return stateTransaction(dataDir, async (state, baselineJson) => {
      syncPlugins(state, plugins); await writeState(dataDir, state, baselineJson);
      return { ok: true, format: 'dimension-plugin-metadata-1', exportedAt: now(), plugins: plugins.map(plugin => exportPlugin(plugin, state.plugins[pluginIdOf(plugin)])), secretsIncluded: false, dataIncluded: false };
    });
  }
  if (action === 'tools.list' || action === 'tools.call') {
    const [catalog, plugins] = await Promise.all([
      delegate({ action: 'tools.list', dataDir, pluginHost: request.pluginHost }), rawPlugins(request),
    ]);
    if (!catalog.ok) return sanitize(catalog);
    const tools = array(catalog.tools);
    const outcome = await stateTransaction(dataDir, async (state, baselineJson) => {
      syncPlugins(state, plugins);
      for (const tool of tools) {
        const record = state.plugins[tool.pluginId];
        if (record) record.toolNames = [...new Set([...(record.toolNames || []), tool.name])];
      }
      if (action === 'tools.list') {
        const visible = collectScopedItems(state, request, tools, 'tools');
        await writeState(dataDir, state, baselineJson);
        return { response: { ...sanitize(catalog), tools: visible.map(tool => sanitize(tool)) } };
      }
      const tool = tools.find(item => item.name === request.name);
      if (!tool) {
        const installed = Object.values(state.plugins).some(item => item.toolNames?.includes(request.name));
        if (installed) throw new GuardError('PLUGIN_DISABLED', '插件已停用，新调用已拒绝');
        const removed = Object.entries(state.removed).find(([, item]) => item.toolNames?.includes(request.name));
        if (removed) throw new GuardError('PLUGIN_NOT_INSTALLED', '插件已卸载，后续调用已拒绝');
        throw new GuardError('PLUGIN_DISABLED', '插件已停用或工具不存在，新调用已拒绝');
      }
      const record = requirePlugin(state, tool.pluginId);
      ensureAuth(record);
      if (!selectScope({ ...record, id: tool.pluginId }, request)) throw new GuardError('PLUGIN_SCOPE_DENIED', '插件未授权给当前 Bot 或 Work 范围');
      const available = tools.filter(item => item.pluginId === tool.pluginId);
      const visible = runView(state, request, { ...record, id: tool.pluginId }, available, 'tools');
      if (!visible.some(item => item.name === tool.name)) throw new GuardError('RUN_PERMISSION_SNAPSHOT', '旧 Work 任务不自动获得后授予的插件或权限');
      await writeState(dataDir, state, baselineJson);
      return { dispatch: { action: 'tools.call', dataDir, pluginHost: request.pluginHost, name: request.name, args: request.args, workspace: request.workspace } };
    });
    return outcome.dispatch ? sanitize(await delegate(outcome.dispatch)) : outcome.response;
  }
  if (action === 'skill.list' || action === 'skill.read') {
    const [response, plugins] = await Promise.all([
      delegate({ action: 'skill.list', dataDir, pluginHost: request.pluginHost }), rawPlugins(request),
    ]);
    if (!response.ok) return sanitize(response);
    const skills = array(response.skills);
    const outcome = await stateTransaction(dataDir, async (state, baselineJson) => {
      syncPlugins(state, plugins);
      const visible = collectScopedItems(state, request, skills, 'skills');
      if (action === 'skill.list') {
        await writeState(dataDir, state, baselineJson);
        return { response: { ...sanitize(response), skills: visible.map(skill => sanitize(skill)) } };
      }
      const selected = visible.find(skill => skill.pluginId === request.pluginId && skill.skillId === request.skillId);
      if (!selected) throw new GuardError(state.plugins[request.pluginId] ? 'PLUGIN_SCOPE_DENIED' : 'PLUGIN_NOT_INSTALLED', '当前范围不能读取此插件 Skill');
      await writeState(dataDir, state, baselineJson);
      return { dispatch: { action: 'skill.read', dataDir, pluginHost: request.pluginHost, pluginId: request.pluginId, skillId: request.skillId } };
    });
    return outcome.dispatch ? sanitize(await delegate(outcome.dispatch)) : outcome.response;
  }
  throw new GuardError('UNKNOWN_ACTION', '未知插件只读操作');
}

const readActions = new Set(['plugin.list', 'status', 'plugin.export', 'tools.list', 'tools.call', 'skill.list', 'skill.read', ...passthroughReadActions]);
const writeActions = new Set(['plugin.enable', 'plugin.disable', 'plugin.remove', 'plugin.data.delete', 'package.install', 'package.update', 'auth.login', 'auth.logout', 'adaptation.prepare', 'adaptation.bind', 'adaptation.inspect', 'adaptation.install', 'adaptation.status', 'local.import']);

export async function handleRequest(request) {
  try {
    if (!request || typeof request !== 'object' || typeof request.action !== 'string' || !path.isAbsolute(request.dataDir || '')) return failure('INVALID_REQUEST', '插件守卫请求无效');
    if (request.action === 'harness.list' || request.action === 'harness.probe') {
      const { hostToolDiagnostics } = await import('./cross-harness-mcp.mjs');
      return await hostToolDiagnostics(request.action === 'harness.list' ? undefined : String(request.serverName || ''));
    }
    if (readActions.has(request.action)) {
      const release = await acquireInvocationRead(request.dataDir);
      try {
        const result = await guardedRead(request);
        return result?.ok === false ? result : { ok: true, ...result };
      } finally { await release(); }
    }
    if (writeActions.has(request.action)) {
      const release = await acquireInvocationWrite(request.dataDir);
      try {
        const result = await guarded(request);
        return result?.ok === false ? result : { ok: true, ...result };
      } finally { await release(); }
    }
    return failure('UNKNOWN_ACTION', '不支持的插件守卫操作');
  } catch (error) {
    if (error instanceof GuardError) return failure(error.code, error.message);
    return failure('GUARD_FAILED', '插件授权守卫未能完成操作');
  }
}

async function main() {
  let input = '';
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_RESPONSE) {
      process.stdout.write(JSON.stringify(failure('INVALID_REQUEST', '请求过大')) + '\n', () => process.exit(0));
      return;
    }
    input += chunk;
  }
  let request;
  try { request = JSON.parse(input.trim()); } catch { request = null; }
  const response = await handleRequest(request);
  process.stdout.write(JSON.stringify(response) + '\n', () => process.exit(0));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
