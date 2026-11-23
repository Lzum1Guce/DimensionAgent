// Dimension Unified Cross-Harness Arsenal & MCP Bridge
// Dual-mode worker:
//   1) `--oneshot`: Reads one JSON action from stdin (`arsenal.list`, `skill.read`, `mcp.call`) and prints JSON to stdout
//      so DimensionAgent itself (Solo / Group Lead / Members / Built-in model) can inspect, use, and distribute
//      skills & MCP tools from Hermes, DeepSeek Harness, Codex, and Claude Code!
//   2) Default (no flag): Runs as a standard JSON-RPC 2.0 MCP stdio server (`cross_harness`).

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import crossSpawn from 'cross-spawn';
import { parseDocument, isMap, isSeq, isScalar, isAlias } from 'yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const DEFAULT_CWD = process.env.DIMENSION_WORKSPACE_CWD || process.cwd();
const USER_HOME = os.homedir();
const LOCAL_APPDATA = process.env.LOCALAPPDATA || path.join(USER_HOME, 'AppData', 'Local');
const APPDATA = process.env.APPDATA || path.join(USER_HOME, 'AppData', 'Roaming');
const MAX_IPC_BYTES = 4 * 1024 * 1024;
const BLOCKED_ENV_KEYS = /^(?:NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|LD_.*|DYLD_.*|PYTHONPATH|PYTHONSTARTUP|BASH_ENV|ENV)$/i;
const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy'];

function killProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    });
  }
  try { process.kill(pid, 'SIGKILL'); } catch {}
  return Promise.resolve();
}

function buildSafeChildEnv(extraEnv = {}, { allowProxy = false } = {}) {
  const base = getDefaultEnvironment();
  if (allowProxy) {
    for (const k of PROXY_ENV_KEYS) {
      if (typeof process.env[k] === 'string' && process.env[k]) base[k] = process.env[k];
    }
  }
  if (extraEnv && typeof extraEnv === 'object') {
    for (const [k, v] of Object.entries(extraEnv)) {
      if (typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !BLOCKED_ENV_KEYS.test(k)) {
        base[k] = v;
      }
    }
  }
  return base;
}

function safeSubCwd(candidate, rootCwd = DEFAULT_CWD) {
  const resolvedRoot = path.resolve(rootCwd);
  if (!candidate || typeof candidate !== 'string') return existsSync(resolvedRoot) ? resolvedRoot : process.cwd();
  const resolvedTarget = path.resolve(resolvedRoot, candidate);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (rel && (rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel))) {
    throw new Error('工作目录越界：仅允许在当前任务受管工作区内执行');
  }
  return existsSync(resolvedTarget) ? resolvedTarget : resolvedRoot;
}

function safeCliToken(value, maxLen = 128) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLen || !/^[A-Za-z0-9._:,/@-]+$/.test(trimmed) || trimmed.startsWith('-')) {
    throw new Error('CLI 模型或工具集标识包含非法字符');
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// 1. Local CLI Binary Discovery (with short TTL cache for server mode)
// ---------------------------------------------------------------------------
let cachedBins = null;
let cachedBinsAt = 0;

async function findCodexDesktopBin() {
  const codexBinsRoot = path.join(LOCAL_APPDATA, 'OpenAI', 'Codex', 'bin');
  try {
    const subdirs = await readdir(codexBinsRoot, { withFileTypes: true });
    for (const d of subdirs) {
      if (!d.isDirectory()) continue;
      const cand = path.join(codexBinsRoot, d.name, 'codex.exe');
      if (existsSync(cand)) return cand;
    }
  } catch {}
  return '';
}

function firstExisting(candidates) {
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return '';
}

async function resolveSiblingHarnesses() {
  if (cachedBins && Date.now() - cachedBinsAt < 10000) return cachedBins;
  const hermes = firstExisting([
    path.join(LOCAL_APPDATA, 'hermes', 'bin', 'hermes.exe'),
    path.join(USER_HOME, '.hermes', 'bin', 'hermes.exe'),
  ]);
  const kimi = firstExisting([
    path.join(USER_HOME, '.kimi-code', 'bin', 'kimi.exe'),
    path.join(LOCAL_APPDATA, 'kimi-code', 'bin', 'kimi.exe'),
  ]);
  let codex = firstExisting([
    path.join(USER_HOME, '.cargo', 'bin', 'codex.exe'),
    path.join(APPDATA, 'npm', 'codex.cmd'),
  ]);
  if (!codex) codex = await findCodexDesktopBin();
  const claude = firstExisting([
    path.join(USER_HOME, '.local', 'bin', 'claude.exe'),
    path.join(LOCAL_APPDATA, 'AnthropicClaude', 'claude.exe'),
    path.join(APPDATA, 'npm', 'claude.cmd'),
  ]);
  cachedBins = { hermes, kimi, codex, claude };
  cachedBinsAt = Date.now();
  return cachedBins;
}

// ---------------------------------------------------------------------------
// 2. Cross-Harness Skills Discovery (Hermes + DeepSeek Harness + Codex + Claude)
// ---------------------------------------------------------------------------
function parseSkillFrontmatter(rawContent, fallbackName) {
  const text = String(rawContent || '');
  let name = fallbackName;
  let description = '';
  if (text.startsWith('---')) {
    const endIdx = text.indexOf('\n---', 3);
    if (endIdx > 0) {
      const fm = text.slice(3, endIdx);
      for (const line of fm.split(/\r?\n/)) {
        const idx = line.indexOf(':');
        if (idx <= 0) continue;
        const k = line.slice(0, idx).trim().toLowerCase();
        const v = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
        if (k === 'name' && v) name = v;
        else if (k === 'description' && v) description = v;
      }
    }
  }
  if (!description) {
    const bodyLines = text.replace(/^---[\s\S]*?---\s*/, '').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    if (bodyLines.length) description = bodyLines[0].slice(0, 180);
  }
  return { name, description: description.slice(0, 220) };
}

async function scanSkillDirRecursive(rootDir, sourceHarness, outMap, maxDepth = 2, curDepth = 0) {
  if (!rootDir || curDepth > maxDepth) return;
  let entries;
  try {
    const rootStat = await lstat(rootDir);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return;
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.hub' || entry.name === '.locks') continue;
    const subDir = path.join(rootDir, entry.name);
    const skillMd = path.join(subDir, 'SKILL.md');
    try {
      const st = await lstat(skillMd);
      if (!st.isSymbolicLink() && st.isFile() && st.size <= 512 * 1024) {
        const raw = await readFile(skillMd, 'utf8');
        const meta = parseSkillFrontmatter(raw, entry.name);
        const id = `${sourceHarness}:${meta.name}`;
        if (!outMap.has(id)) {
          outMap.set(id, {
            skillId: id,
            shortName: meta.name,
            sourceHarness,
            description: meta.description,
            directory: subDir,
            skillFile: skillMd,
          });
        }
        continue;
      }
    } catch {}
    if (curDepth < maxDepth) {
      await scanSkillDirRecursive(subDir, sourceHarness, outMap, maxDepth, curDepth + 1);
    }
  }
}

async function discoverAllHarnessSkills(extraDshOfficeDir = '') {
  const skills = new Map();
  await scanSkillDirRecursive(path.join(LOCAL_APPDATA, 'hermes', 'skills'), 'hermes', skills, 2);
  await scanSkillDirRecursive(path.join(USER_HOME, '.hermes', 'skills'), 'hermes', skills, 2);
  await scanSkillDirRecursive(path.join(USER_HOME, '.dsh', 'skills'), 'deepseek-harness', skills, 1);
  if (extraDshOfficeDir && path.isAbsolute(extraDshOfficeDir)) {
    await scanSkillDirRecursive(path.resolve(extraDshOfficeDir), 'deepseek-harness', skills, 1);
  }
  await scanSkillDirRecursive(path.join(USER_HOME, '.codex', 'skills'), 'codex', skills, 2);
  await scanSkillDirRecursive(path.join(USER_HOME, '.claude', 'skills'), 'claude-code', skills, 2);
  return skills;
}

// ---------------------------------------------------------------------------
// 3. Cross-Harness MCP Server Discovery (DSH Desktop + Codex + Hermes + Claude)
// ---------------------------------------------------------------------------
function plainYaml(node, depth = 0) {
  if (node == null || depth > 32 || isAlias(node)) return null;
  if (isSeq(node)) return node.items.map(item => plainYaml(item, depth + 1));
  if (isMap(node)) {
    const out = Object.create(null);
    for (const pair of node.items) {
      if (isScalar(pair.key) && typeof pair.key.value === 'string' && !['__proto__', 'prototype', 'constructor'].includes(pair.key.value)) {
        out[pair.key.value] = plainYaml(pair.value, depth + 1);
      }
    }
    return out;
  }
  if (isScalar(node)) return node.value;
  return null;
}

function unquoteToml(s) {
  const t = String(s || '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    const inner = t.slice(1, -1);
    return t.startsWith('"') ? inner.replace(/\\\\/g, '\\').replace(/\\"/g, '"') : inner;
  }
  return t;
}

function parseTomlArray(raw) {
  const inner = raw.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!inner.trim()) return [];
  const items = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'/g;
  let m;
  while ((m = re.exec(inner)) !== null) {
    items.push(m[1] !== undefined ? m[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"') : m[2]);
  }
  return items;
}



async function readSafeConfigFile(filePath, maxBytes = 1024 * 1024) {
  const st = await lstat(filePath);
  if (st.isSymbolicLink() || !st.isFile() || st.size > maxBytes) return null;
  return readFile(filePath, 'utf8');
}

async function discoverHostMcpServers() {

  const catalog = new Map();
  const skipNames = new Set(['cross_harness', 'node_repl']);

  // Source A: ~/.dsh/profiles/desktop/cordis.patch.yml
  const dshPatch = path.join(USER_HOME, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
  try {
    const raw = await readSafeConfigFile(dshPatch);
    if (raw) {
      const doc = parseDocument(raw, { uniqueKeys: false });
      const visit = (node, depth = 0) => {
        if (depth > 32) return;
        if (isSeq(node)) {
          for (const it of node.items) visit(it, depth + 1);
        } else if (isMap(node)) {
          const obj = plainYaml(node);
          if (obj?.disabled === true || obj?.enabled === false) return;
          if (obj && obj.name === '@deepseek-ai/dsh-mcp-client' && obj.config) {
            const sName = String(obj.config.serverName || obj.id || '').trim();
            if (sName && !skipNames.has(sName) && !catalog.has(sName)) {
              catalog.set(sName, {
                serverName: sName,
                source: 'deepseek-harness',
                transport: obj.config.transport || 'stdio',
                command: obj.config.command || '',
                args: Array.isArray(obj.config.args) ? obj.config.args.map(String) : [],
                cwd: obj.config.cwd || '',
                env: obj.config.env && typeof obj.config.env === 'object' ? obj.config.env : {},
                url: obj.config.url || '',
                headers: obj.config.headers && typeof obj.config.headers === 'object' ? obj.config.headers : {},
                timeoutMs: Number(obj.config.toolCallTimeoutMs) || 120000,
              });
            }
          }
          for (const pair of node.items) visit(pair.value, depth + 1);
        }
      };
      visit(doc.contents);
    }
  } catch {}

  // Source B: ~/.codex/config.toml ([mcp_servers.<name>])
  const codexToml = path.join(USER_HOME, '.codex', 'config.toml');
  try {
    const raw = await readSafeConfigFile(codexToml);
    if (raw) {
      let curServer = '';
      let inEnv = false;
      const temp = new Map();
      for (const rawLine of raw.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        if (line.startsWith('[') && line.endsWith(']')) {
          const sec = line.slice(1, -1).trim();
          const envMatch = sec.match(/^mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\.env$/);
          const srvMatch = sec.match(/^mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))$/);
          if (envMatch) {
            curServer = envMatch[1] || envMatch[2] || envMatch[3];
            inEnv = true;
            if (!temp.has(curServer)) temp.set(curServer, { args: [], env: {} });
          } else if (srvMatch) {
            curServer = srvMatch[1] || srvMatch[2] || srvMatch[3];
            inEnv = false;
            if (!temp.has(curServer)) temp.set(curServer, { args: [], env: {} });
          } else {
            curServer = '';
            inEnv = false;
          }
          continue;
        }
        if (!curServer) continue;
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const k = unquoteToml(line.slice(0, eq));
        const vRaw = line.slice(eq + 1).trim();
        const entry = temp.get(curServer);
        if (inEnv) {
          entry.env[k] = unquoteToml(vRaw);
        } else if (k === 'enabled') {
          entry.enabled = !/^false(?:\s*#.*)?$/.test(vRaw);
        } else if (k === 'command') {
          entry.command = unquoteToml(vRaw);
        } else if (k === 'cwd') {
          entry.cwd = unquoteToml(vRaw);
        } else if (k === 'url') {
          entry.url = unquoteToml(vRaw);
        } else if (k === 'args' && vRaw.startsWith('[')) {
          entry.args = parseTomlArray(vRaw);
        }
      }
      for (const [sName, cfg] of temp.entries()) {
        if (skipNames.has(sName) || catalog.has(sName)) continue;
        if (cfg.enabled === false || cfg.disabled === true || (!cfg.command && !cfg.url)) continue;
        catalog.set(sName, {
          serverName: sName,
          source: 'codex',
          transport: cfg.url ? 'streamable-http' : 'stdio',
          command: cfg.command || '',
          args: cfg.args || [],
          cwd: cfg.cwd || '',
          env: cfg.env || {},
          url: cfg.url || '',
          headers: {},
          timeoutMs: 120000,
        });
      }
    }
  } catch {}

  // Source C: ~/.hermes/config.yaml or %LOCALAPPDATA%/hermes/config.yaml (`mcp_servers:`)
  for (const hCfgPath of [path.join(LOCAL_APPDATA, 'hermes', 'config.yaml'), path.join(USER_HOME, '.hermes', 'config.yaml')]) {
    try {
      const raw = await readSafeConfigFile(hCfgPath);
      if (!raw) continue;
      const doc = parseDocument(raw, { uniqueKeys: false });
      const rootObj = plainYaml(doc.contents);
      const mcpSec = rootObj?.mcp_servers;
      if (mcpSec && typeof mcpSec === 'object') {
        for (const [sName, cfg] of Object.entries(mcpSec)) {
          if (skipNames.has(sName) || catalog.has(sName) || !cfg || typeof cfg !== 'object') continue;
          if (cfg.enabled === false || cfg.disabled === true || (!cfg.command && !cfg.url)) continue;
          catalog.set(sName, {
            serverName: sName,
            source: 'hermes',
            transport: cfg.url ? 'streamable-http' : 'stdio',
            command: cfg.command || '',
            args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
            cwd: cfg.cwd || '',
            env: cfg.env && typeof cfg.env === 'object' ? cfg.env : {},
            url: cfg.url || '',
            headers: cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : {},
            timeoutMs: 120000,
          });
        }
      }
    } catch {}
  }

  // Source D: ~/.claude.json
  const claudeJson = path.join(USER_HOME, '.claude.json');
  try {
    const raw = await readSafeConfigFile(claudeJson);
    if (raw) {
      const parsed = JSON.parse(raw);
      const servers = parsed?.mcpServers || {};
      for (const [sName, cfg] of Object.entries(servers)) {
        if (skipNames.has(sName) || catalog.has(sName) || !cfg || typeof cfg !== 'object') continue;
        if (cfg.enabled === false || cfg.disabled === true || (!cfg.command && !cfg.url)) continue;
        catalog.set(sName, {
          serverName: sName,
          source: 'claude-code',
          transport: cfg.url ? 'streamable-http' : 'stdio',
          command: cfg.command || '',
          args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
          cwd: cfg.cwd || '',
          env: cfg.env && typeof cfg.env === 'object' ? cfg.env : {},
          url: cfg.url || '',
          headers: cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : {},
          timeoutMs: 120000,
        });
      }
    }
  } catch {}


  return catalog;
}

function missingDependency(spec) {
  if (spec.transport !== 'stdio') return '';
  if (path.isAbsolute(spec.command) && !existsSync(spec.command)) return '找不到配置的启动程序';
  if (spec.cwd && path.isAbsolute(spec.cwd) && !existsSync(spec.cwd)) return '找不到配置的工作目录';
  const script = spec.args[0];
  if (/^(?:node|python[0-9.]*)(?:\.exe)?$/i.test(path.basename(spec.command)) &&
      script && /\.(?:[cm]?js|py)$/i.test(script) &&
      (path.isAbsolute(script) || path.isAbsolute(spec.cwd || '')) &&
      !existsSync(path.resolve(spec.cwd || DEFAULT_CWD, script))) return '找不到入口脚本 ' + path.basename(script);
  return '';
}

function describeServer(spec) {
  return { serverName: spec.serverName, sourceHarness: spec.source, transport: spec.transport,
    configurationError: missingDependency(spec), catalogStatus: 'untested', targetStatus: 'untested' };
}

export async function hostToolDiagnostics(serverName) {
  const catalog = await discoverHostMcpServers();
  if (serverName === undefined) return { ok: true, servers: [...catalog.values()].map(describeServer) };
  const spec = catalog.get(serverName);
  if (!spec) return { ok: false, error: {code: 'NOT_FOUND', message: '该工具服务未启用或已移除'} };
  const status = describeServer(spec);
  status.checkedAt = new Date().toISOString();
  if (status.configurationError) return { ok: true, status };
  try {
    const { client } = await getOrConnectHostMcp(spec, DEFAULT_CWD, 8000);
    await client.listTools(undefined, { timeout: 8000 });
    status.catalogStatus = 'connected';
    if (serverName === 'blender') {
      const reply = await client.callTool({name: 'get_addon_status', arguments: {}}, undefined, {timeout: 8000});
      const text = (reply.content || []).map(item => item.text || '').join(' ');
      if (reply.isError || /could not connect|error checking|connection refused|failed to connect|not connected|disconnected|unavailable/i.test(text)) {
        status.targetStatus = 'failed';
        status.error = /outdated/i.test(text) ? 'Blender 未连接，请检查本体连接并更新 MCP 插件' : 'Blender 本体连接检查失败';
      } else if (/\bconnected\b|protocol.version|addon.version/i.test(text)) status.targetStatus = 'connected';
    }
  } catch {
    if (status.catalogStatus === 'connected') {
      status.targetStatus = 'failed';
      status.error = '目标软件状态查询失败或超时';
    } else {
      status.catalogStatus = 'failed';
      status.error = '工具目录读取失败，请检查启动命令、依赖和服务连接';
    }
  } finally { await closeAllHostMcp(); }
  return { ok: true, status };
}


const activeMcpClients = new Map();
const pendingMcpConnections = new Map();

async function closeMcpEntry(entry) {
  if (!entry) return;
  const pid = entry.transport?.pid;
  try { await entry.transport?.close(); } catch {}
  if (pid) await killProcessTree(pid);
}

async function getOrConnectHostMcp(spec, overrideCwd = '', startupLimit = 60000) {
  if (activeMcpClients.has(spec.serverName)) {
    return activeMcpClients.get(spec.serverName);
  }
  if (pendingMcpConnections.has(spec.serverName)) {
    return pendingMcpConnections.get(spec.serverName);
  }
  const connectPromise = (async () => {
    const client = new Client({ name: 'dimension-arsenal', version: '0.7.18' }, { capabilities: {} });
    let transport;
    if (spec.transport === 'streamable-http' && spec.url) {
      const parsedUrl = new URL(spec.url);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error('MCP HTTP 传输仅支持 http/https 协议');
      }
      transport = new StreamableHTTPClientTransport(parsedUrl, {
        requestInit: { headers: spec.headers || {}, redirect: 'error' },
      });
    } else {
      const effCwd = (spec.cwd && path.isAbsolute(spec.cwd) && existsSync(spec.cwd))
        ? spec.cwd
        : ((overrideCwd && path.isAbsolute(overrideCwd) && existsSync(overrideCwd)) ? overrideCwd : DEFAULT_CWD);
      // StdioClientTransport uses cross-spawn internally on Windows; never wrap in raw cmd.exe /c
      transport = new StdioClientTransport({
        command: spec.command,
        args: spec.args || [],
        cwd: effCwd,
        env: buildSafeChildEnv(spec.env, { allowProxy: true }),
        stderr: 'ignore',
      });
    }
    try {
      await client.connect(transport, { timeout: Math.min(spec.timeoutMs || 120000, startupLimit) });
      const entry = { client, transport };
      activeMcpClients.set(spec.serverName, entry);
      return entry;
    } catch (err) {
      await closeMcpEntry({ client, transport });
      throw err;
    }
  })();

  pendingMcpConnections.set(spec.serverName, connectPromise);
  try {
    return await connectPromise;
  } finally {
    pendingMcpConnections.delete(spec.serverName);
  }
}

async function closeAllHostMcp() {
  const entries = [...activeMcpClients.values()];
  activeMcpClients.clear();
  await Promise.allSettled(entries.map(entry => closeMcpEntry(entry)));
}

function matchSkillFromMap(skillsMap, requestedId) {
  const q = String(requestedId || '').trim();
  if (!q) return null;
  if (skillsMap.has(q)) return skillsMap.get(q);
  const qLow = q.toLowerCase();
  for (const [fullId, item] of skillsMap.entries()) {
    if (fullId.toLowerCase() === qLow || item.shortName.toLowerCase() === qLow) {
      return item;
    }
  }
  for (const item of skillsMap.values()) {
    if (item.shortName.toLowerCase().includes(qLow)) return item;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 4. Oneshot Mode for DimensionAgent C++ Core (`node cross-harness-mcp.mjs --oneshot`)
// ---------------------------------------------------------------------------
async function runOneshotMode() {
  const chunks = [];
  let totalBytes = 0;
  for await (const c of process.stdin) {
    totalBytes += c.length;
    if (totalBytes > MAX_IPC_BYTES) throw new Error('请求输入超过 4 MiB 上限');
    chunks.push(c);
  }
  const req = JSON.parse(Buffer.concat(chunks, totalBytes).toString('utf8') || '{}');
  const op = String(req.op || 'arsenal.list');
  const officeDir = String(req.dshOfficeSkillsDir || '');

  try {
    if (op === 'arsenal.list') {
      const query = String(req.query || '').trim().toLowerCase();
      const [skillsMap, mcpMap, bins] = await Promise.all([
        discoverAllHarnessSkills(officeDir),
        discoverHostMcpServers(),
        resolveSiblingHarnesses(),
      ]);

      const skills = [];
      for (const s of skillsMap.values()) {
        if (query && !`${s.skillId} ${s.description}`.toLowerCase().includes(query)) continue;
        skills.push({
          skillId: s.skillId,
          name: s.shortName,
          sourceHarness: s.sourceHarness,
          description: s.description,
        });
      }

      const mcpServers = [];
      for (const m of mcpMap.values()) {
        if (query && !`${m.serverName} ${m.source}`.toLowerCase().includes(query)) continue;
        mcpServers.push(describeServer(m));
      }

      return {
        ok: true,
        harnesses: {
          hermes: Boolean(bins.hermes),
          deepseekHarness: Boolean(officeDir) || existsSync(path.join(USER_HOME, '.dsh')),
          codex: Boolean(bins.codex),
          kimiCode: Boolean(bins.kimi),
          claudeCode: Boolean(bins.claude),
        },
        totalSkills: skills.length,
        skills,
        mcpServers,
      };
    }

    if (op === 'skill.read') {
      const skillsMap = await discoverAllHarnessSkills(officeDir);
      const ids = Array.isArray(req.skillIds) ? req.skillIds : [req.skillId];
      const loaded = [];
      for (const id of ids) {
        const matched = matchSkillFromMap(skillsMap, id);
        if (!matched) continue;
        const content = await readFile(matched.skillFile, 'utf8');
        loaded.push({
          skillId: matched.skillId,
          name: matched.shortName,
          sourceHarness: matched.sourceHarness,
          directory: matched.directory,
          content: content.slice(0, 65536),
        });
      }
      if (!loaded.length) {
        return {
          ok: false,
          error: `未找到匹配的跨 Harness 技能 "${req.skillId || ids.join(',')}"，请先调用 list_harness_arsenal 查看准确的 skillId。`,
        };
      }
      return { ok: true, skills: loaded };
    }

    if (op === 'mcp.call') {
      const serverName = String(req.serverName || '').trim();
      const action = String(req.action || 'list_tools').trim();
      const mcpMap = await discoverHostMcpServers();
      const spec = mcpMap.get(serverName);
      if (!spec) {
        return {
          ok: false,
          error: `未找到外部 MCP 服务器 "${serverName}"（当前可用：${[...mcpMap.keys()].join(', ') || '无'}）`,
        };
      }
      try {
        const { client } = await getOrConnectHostMcp(spec, String(req.workspace || ''));
        if (action === 'list_tools') {
          const res = await client.listTools(undefined, { timeout: spec.timeoutMs || 120000 });
          return { ok: true, serverName, tools: res.tools || [] };
        }
        const res = await client.callTool(
          {
            name: String(req.toolName || ''),
            arguments: req.arguments && typeof req.arguments === 'object' ? req.arguments : {},
          },
          undefined,
          { timeout: spec.timeoutMs || 120000 }
        );
        return {
          ok: !res?.isError,
          serverName,
          toolName: req.toolName,
          result: res?.content ?? res,
        };
      } finally {
        await closeAllHostMcp();
      }
    }

    return { ok: false, error: `未知操作: ${op}` };
  } catch (err) {
    await closeAllHostMcp();
    return { ok: false, error: err?.message || String(err) };
  }
}

// ---------------------------------------------------------------------------
// 5. Stdio MCP Server Mode (when mounted inside DeepSeek Harness / Codex / Hermes)
// ---------------------------------------------------------------------------
function runSubprocessCapture(binPath, args, { cwd = DEFAULT_CWD, envExtra = {}, timeoutMs = 300000 } = {}) {
  return new Promise((resolve) => {
    const safeCwd = safeSubCwd(cwd, DEFAULT_CWD);
    const child = crossSpawn(binPath, args, {
      cwd: safeCwd,
      env: buildSafeChildEnv({
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        PYTHONUNBUFFERED: '1',
        NO_COLOR: '1',
        ...envExtra,
      }, { allowProxy: true }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };

    const timer = setTimeout(async () => {
      timedOut = true;
      if (child.pid) await killProcessTree(child.pid);
      try { child.stdout?.destroy(); } catch {}
      try { child.stderr?.destroy(); } catch {}
      finish({ code: 124, stdout, stderr: `${stderr}\n子进程执行超时（>${timeoutMs}ms）`.trim(), timedOut: true });
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      if (stdout.length < 512 * 1024) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 128 * 1024) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      finish({ code: 1, stdout, stderr: `${stderr}\n${err.message}`.trim(), timedOut });
    });
    child.on('close', (code) => {
      finish({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

function extractStreamJsonSummary(rawStdout) {
  const lines = String(rawStdout || '').split(/\r?\n/);
  const texts = [];
  const toolsUsed = [];
  let finalResult = '';

  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const obj = JSON.parse(t);
      if (obj.type === 'text' && obj.text) texts.push(obj.text);
      else if (obj.type === 'tool_use' || obj.type === 'tool_call') {
        toolsUsed.push(obj.name || obj.tool || 'tool');
      } else if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
        for (const item of obj.message.content) {
          if (item.type === 'text' && item.text) texts.push(item.text);
          if (item.type === 'tool_use' && item.name) toolsUsed.push(item.name);
        }
      } else if (obj.type === 'item.completed' && obj.item?.type === 'agent_message' && obj.item.text) {
        texts.push(obj.item.text);
      } else if (obj.type === 'result' || obj.type === 'final') {
        finalResult = obj.text || obj.result || obj.response || finalResult;
      }
    } catch {}
  }

  const body = (finalResult || texts.join('') || rawStdout).trim();
  const toolNote = toolsUsed.length ? `[已调用工具: ${[...new Set(toolsUsed)].join(', ')}]\n` : '';
  return `${toolNote}${body}`.trim();
}

const MCP_TOOLS = [
  {
    name: 'delegate_hermes',
    description: '调遣本机 Hermes Agent 执行专项子任务（如联网检索插件 deepseek-search-fetch、多工具流或独立审校）。',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '交给 Hermes 执行的子任务目标与边界' },
        model: { type: 'string', description: '可选模型名' },
        toolsets: { type: 'string', description: '可选工具集（如 file,terminal,web）' },
        cwd: { type: 'string', description: '可选工作目录' },
      },
      required: ['task'],
    },
  },
  {
    name: 'delegate_codex',
    description: '调遣本机 OpenAI Codex CLI 执行高难度算法推演或独立 Code Review。',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '交给 Codex 执行的子任务' },
        model: { type: 'string', description: '可选模型名' },
        cwd: { type: 'string', description: '可选工作目录' },
      },
      required: ['task'],
    },
  },
  {
    name: 'list_host_mcp_servers',
    description: '列出本机在 DeepSeek Harness / Codex / Hermes / Claude 中已配置的外部 MCP 工具服务器（如 aseprite、blender、sketchup-mcp、tripo、taptap-maker）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'call_host_mcp_tool',
    description: '按需连接并调用本机任意已配置的外部 MCP 工具服务器（action="list_tools" 或 "call_tool"）。',
    inputSchema: {
      type: 'object',
      properties: {
        serverName: { type: 'string' },
        action: { type: 'string', enum: ['list_tools', 'call_tool'] },
        toolName: { type: 'string' },
        arguments: { type: 'object' },
      },
      required: ['serverName', 'action'],
    },
  },
];

async function handleMcpServerToolCall(name, args = {}) {
  const bins = await resolveSiblingHarnesses();
  if (name === 'delegate_hermes') {
    if (!bins.hermes) return { isError: true, text: '未检测到 Hermes CLI。' };
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'dim-hermes-'));
    const qFile = path.join(tmpDir, `q-${randomUUID()}.txt`);
    try {
      await writeFile(qFile, String(args.task || ''), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      const targetCwd = safeSubCwd(args.cwd, DEFAULT_CWD);
      const cliArgs = ['chat', '--query-file', qFile, '--format', 'stream-json', '--in', targetCwd, '--accept-hooks', '--yolo', '--source', 'tool'];
      if (args.model) cliArgs.push('-m', safeCliToken(args.model));
      if (args.toolsets) cliArgs.push('-t', safeCliToken(args.toolsets, 256));
      const res = await runSubprocessCapture(bins.hermes, cliArgs, {
        cwd: targetCwd,
        envExtra: { HERMES_ACCEPT_HOOKS: '1', HERMES_QUIET: '1' },
      });
      return { isError: res.code !== 0 && !res.stdout, text: extractStreamJsonSummary(res.stdout) || res.stderr };
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (name === 'delegate_codex') {
    if (!bins.codex) return { isError: true, text: '未检测到 Codex CLI。' };
    const targetCwd = safeSubCwd(args.cwd, DEFAULT_CWD);
    const cliArgs = ['exec', '--json', '--full-auto', '--skip-git-repo-check'];
    if (args.model) cliArgs.push('-m', safeCliToken(args.model));
    cliArgs.push('--', String(args.task || ''));
    const res = await runSubprocessCapture(bins.codex, cliArgs, { cwd: targetCwd });
    return { isError: res.code !== 0 && !res.stdout, text: extractStreamJsonSummary(res.stdout) || res.stderr };
  }
  if (name === 'list_host_mcp_servers') {
    const catalog = await discoverHostMcpServers();
    return { isError: false, text: JSON.stringify([...catalog.values()].map(s => ({ serverName: s.serverName, source: s.source, transport: s.transport })), null, 2) };
  }
  if (name === 'call_host_mcp_tool') {
    const catalog = await discoverHostMcpServers();
    const spec = catalog.get(String(args.serverName || ''));
    if (!spec) return { isError: true, text: `未找到外部 MCP 服务器 "${args.serverName}"` };
    let connected = null;
    try {
      connected = await getOrConnectHostMcp(spec);
      const { client } = connected;
      if (args.action === 'list_tools') {
        const res = await client.listTools(undefined, { timeout: spec.timeoutMs || 120000 });
        return { isError: false, text: JSON.stringify(res.tools || [], null, 2) };
      }
      const res = await client.callTool(
        { name: String(args.toolName || ''), arguments: args.arguments || {} },
        undefined,
        { timeout: spec.timeoutMs || 120000 }
      );
      return { isError: Boolean(res?.isError), text: JSON.stringify(res?.content ?? res, null, 2) };
    } catch (err) {
      activeMcpClients.delete(spec.serverName);
      if (connected) await closeMcpEntry(connected);
      return { isError: true, text: err?.message || String(err) };
    }
  }
  return { isError: true, text: `未知工具: ${name}` };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly && process.argv.includes('--oneshot')) {
  runOneshotMode()
    .then((payload) => {
      process.stdout.write(JSON.stringify(payload) + '\n', () => process.exit(0));
    })
    .catch((err) => {
      process.stdout.write(JSON.stringify({ ok: false, error: err?.message || String(err) }) + '\n', () => process.exit(0));
    });
} else if (invokedDirectly) {
  const sendJsonRpc = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const rl = readline.createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
  rl.on('line', async (rawLine) => {
    if (Buffer.byteLength(rawLine, 'utf8') > MAX_IPC_BYTES) return;
    const line = rawLine.trim();
    if (!line) return;
    let req;
    try { req = JSON.parse(line); } catch { return; }
    if (!req || req.id === undefined || req.id === null) return;
    const { id, method, params } = req;
    try {
      if (method === 'initialize') {
        sendJsonRpc({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: params?.protocolVersion || '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'dimension-cross-harness', version: '0.7.18' },
          },
        });
      } else if (method === 'ping') {
        sendJsonRpc({ jsonrpc: '2.0', id, result: {} });
      } else if (method === 'tools/list') {
        sendJsonRpc({ jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
      } else if (method === 'tools/call') {
        const out = await handleMcpServerToolCall(params?.name, params?.arguments || {});
        sendJsonRpc({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: out.text }], isError: out.isError } });
      } else if (method === 'resources/list') {
        sendJsonRpc({ jsonrpc: '2.0', id, result: { resources: [] } });
      } else if (method === 'prompts/list') {
        sendJsonRpc({ jsonrpc: '2.0', id, result: { prompts: [] } });
      } else {
        sendJsonRpc({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
    } catch (err) {
      sendJsonRpc({ jsonrpc: '2.0', id, error: { code: -32603, message: err?.message || String(err) } });
    }
  });
  let closing = false;
  const cleanup = async () => {
    if (closing) return;
    closing = true;
    await closeAllHostMcp();
    process.exit(0);
  };
  rl.on('close', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
}
