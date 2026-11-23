// Declarative local inventory only. Never imports code from the inspected app.
import { lstat, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument, isMap, isSeq, isScalar, isAlias } from 'yaml';

function explicitPath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw Error(`${label} 必须是显式指定的绝对路径`);
  return path.resolve(value);
}
const safeManifest = (j, extra = {}) => ({
  name: typeof j.name === 'string' ? j.name : '',
  version: typeof j.version === 'string' ? j.version : '',
  description: typeof j.description === 'string' ? j.description : '',
  license: typeof j.license === 'string' ? j.license : '未声明',
  dsh: j.dsh && typeof j.dsh === 'object' ? j.dsh : {},
  peerDependencies: j.peerDependencies ?? {}, ...extra,
});
async function boundedText(file, max = 262144) {
  const st = await lstat(file);
  if (st.isSymbolicLink() || !st.isFile()) throw Error('拒绝读取符号链接或非常规文件');
  if (st.size > max) throw Error('配置文件超过读取限制');
  return readFile(file, 'utf8');
}
async function readArchiveManifests(archive) {
  const st = await lstat(archive);
  if (st.isSymbolicLink() || !st.isFile()) throw Error('客户端归档路径无效');
  const file = await open(archive, 'r');
  try {
    const prefix = Buffer.alloc(16);
    const pRead = await file.read(prefix, 0, 16, 0);
    if (pRead.bytesRead !== 16) throw Error('不支持的 ASAR 目录');
    const headerBytes = prefix.readUInt32LE(4), jsonBytes = prefix.readUInt32LE(12);
    if (headerBytes > 32 * 1024 * 1024 || jsonBytes > headerBytes) throw Error('不支持的 ASAR 目录');
    const raw = Buffer.alloc(jsonBytes);
    const hRead = await file.read(raw, 0, jsonBytes, 16);
    if (hRead.bytesRead !== jsonBytes) throw Error('ASAR 目录头被截断');
    const root = JSON.parse(raw.toString('utf8')), offset = 8 + headerBytes, entries = [];
    function walk(node, folder = '', depth = 0) {
      if (depth > 32) throw Error('ASAR 目录层级过深');
      for (const [name, item] of Object.entries(node?.files ?? {})) {
        if (name === '..' || name.includes('/') || name.includes('\\')) continue;
        const key = folder ? folder + '/' + name : name;
        if (item?.files) walk(item, key, depth + 1);
        else if (item && !item.link && (key === 'package.json' || /^dsh\/node_modules\/@deepseek-ai\/[^/]+\/package\.json$/.test(key))) entries.push([key, item]);
      }
    }
    walk(root);
    const result = [];
    for (const [key, entry] of entries) {
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 262144) continue;
      let text;
      if (entry.unpacked) text = await boundedText(archive + '.unpacked/' + key);
      else {
        const position = offset + Number(entry.offset);
        if (!Number.isSafeInteger(position) || position < offset) throw Error('ASAR 清单偏移无效');
        const bytes = Buffer.alloc(entry.size);
        const read = await file.read(bytes, 0, bytes.length, position);
        if (read.bytesRead !== bytes.length) throw Error('ASAR 清单被截断');
        text = bytes.toString('utf8');
      }
      const manifest = JSON.parse(text);
      if (manifest.dsh?.bundle || key === 'package.json') result.push(safeManifest(manifest, { archivePath: key }));
    }
    return result;
  } finally { await file.close(); }
}

// Unknown YAML tags and aliases are data that we refuse to execute or resolve.
function plain(node, depth = 0) {
  if (depth > 32) throw Error('YAML 结构嵌套过深');
  if (node == null) return null;
  if (isAlias(node) || (node.tag && !['tag:yaml.org,2002:str','tag:yaml.org,2002:int','tag:yaml.org,2002:float','tag:yaml.org,2002:bool','tag:yaml.org,2002:null','tag:yaml.org,2002:map','tag:yaml.org,2002:seq'].includes(node.tag))) throw Error('该配置包含动态 YAML 标签或别名，需要手动设置');
  if (isSeq(node)) return node.items.map(item => plain(item, depth + 1));
  if (isMap(node)) {
    const object = Object.create(null);
    for (const pair of node.items) {
      const key = plain(pair.key, depth + 1);
      if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key)) throw Error('配置键无效');
      object[key] = plain(pair.value, depth + 1);
    }
    return object;
  }
  if (isScalar(node)) return node.value;
  throw Error('不支持的 YAML 结构');
}
function scalarValue(map, key) {
  if (!isMap(map)) return undefined;
  const pair = map.items.find(p => isScalar(p.key) && p.key.value === key);
  return pair?.value;
}
async function profileRows(profileDirectory) {
  const found = [];
  for (const name of ['cordis.yml', 'cordis.patch.yml']) {
    let document;
    try { document = parseDocument(await boundedText(path.join(profileDirectory, name)), { uniqueKeys: true }); }
    catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (document.errors.length) throw Error('本机插件配置 YAML 无法解析');
    function visit(node, depth = 0) {
      if (depth > 24) throw Error('配置嵌套过深');
      if (isMap(node)) {
        const nameNode = scalarValue(node, 'name'), idNode = scalarValue(node, 'id');
        if (isScalar(nameNode) && typeof nameNode.value === 'string') {
          if (nameNode.value === '@deepseek-ai/dsh-mcp-client' || nameNode.value === '@deepseek-ai/dsh-plugin-market') {
            try { found.push({ ...plain(node), sourceFile: name }); }
            catch { found.push({ id: isScalar(idNode) ? String(idNode.value) : '', name: nameNode.value, blocked: true, sourceFile: name }); }
          }
        }
        for (const pair of node.items) if (isScalar(pair.key) && ['insert', 'config'].includes(pair.key.value)) visit(pair.value, depth + 1);
      } else if (isSeq(node)) for (const item of node.items) visit(item, depth + 1);
    }
    visit(document.contents);
  }
  const byId = new Map();
  for (const row of found) byId.set(row.id || row.config?.serverName || 'unnamed-' + byId.size, row);
  return [...byId.entries()].map(([id, row]) => ({ ...row, id }));
}
export async function discoverLocalDsh({ archive, profileDirectory } = {}) {
  if (!archive && !profileDirectory) throw Error('请显式指定客户端归档或 profile 路径；不会自动扫描本机');
  if (archive) archive = explicitPath(archive, '客户端归档');
  if (profileDirectory) profileDirectory = explicitPath(profileDirectory, 'profile');
  const result = { sourceVersion: '', archive, profileDirectory, sourcesURLs: [], bundledManifests: [], installedManifests: [], mcpServers: [], warnings: [] };
  if (archive) try {
    const manifests = await readArchiveManifests(archive);
    result.sourceVersion = manifests.find(j => j.name === '@deepseek-ai/dsh-desktop')?.version || '';
    result.bundledManifests = manifests.filter(j => j.dsh?.bundle);
  } catch (e) { result.warnings.push(e.code === 'ENOENT' ? '未找到该客户端安装目录' : '客户端插件清单读取失败'); }
  if (profileDirectory) try {
    const profile = JSON.parse(await boundedText(path.join(profileDirectory, 'package.json')));
    for (const name of Object.keys(profile.dependencies ?? {})) {
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) continue;
      try {
        const directory = path.join(profileDirectory, 'node_modules', ...name.split('/'));
        const manifest = JSON.parse(await boundedText(path.join(directory, 'package.json')));
        result.installedManifests.push(safeManifest(manifest, { path: directory }));
      } catch { result.warnings.push('有一个本地插件的安装清单不可读'); }
    }
    const rows = await profileRows(profileDirectory);
    for (const row of rows) {
      if (row.name === '@deepseek-ai/dsh-plugin-market' && !row.blocked) {
        for (const value of row.config?.indexes ?? []) {
          try { const u = new URL(value); if (['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.hash) result.sourcesURLs.push(u.href); } catch {}
        }
      }
      if (row.name !== '@deepseek-ai/dsh-mcp-client') continue;
      const config = row.config || {};
      result.mcpServers.push({ id: row.id, serverName: config.serverName || row.id, transport: config.transport || '', commandLabel: typeof config.command === 'string' ? path.basename(config.command) : '', argsCount: Array.isArray(config.args) ? config.args.length : 0, envKeys: Object.keys(config.env || {}), headerKeys: Object.keys(config.headers || {}), configurable: !row.blocked, reason: row.blocked ? '动态配置需手动设置；不会执行 YAML 表达式' : '', profileDirectory });
    }
  } catch (e) { result.warnings.push(e.code === 'ENOENT' ? '未找到该客户端 profile' : '本机 profile 插件配置读取失败'); }
  result.sourcesURLs = [...new Set(result.sourcesURLs)];
  return result;
}
export async function readDshMcpConfig({ profileDirectory, id }) {
  profileDirectory = explicitPath(profileDirectory, 'profile');
  const rows = await profileRows(profileDirectory);
  const row = rows.find(row => row.id === id && row.name === '@deepseek-ai/dsh-mcp-client');
  if (!row) throw Error('该本机 MCP 配置不存在');
  if (row.blocked) throw Error('动态配置需手动设置；不会执行 YAML 表达式');
  // Private return value for the trusted connector only, never an HTTP response.
  return row.config;
}
