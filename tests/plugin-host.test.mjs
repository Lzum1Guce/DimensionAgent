import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, writeFile, symlink, stat, utimes, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { handleRequest } from '../runtime/plugin-host.mjs';

const require = createRequire(new URL('../runtime/package.json', import.meta.url));
const tar = require('tar');
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(scriptRoot);
const hostPath = path.join(projectRoot, 'runtime', 'plugin-host.mjs');
const syntheticSecret = 'fixture-secret-only';
const echoSchema = { type: 'object', properties: { text: { type: 'string', minLength: 1 } }, required: ['text'], additionalProperties: false };
const outputSchema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false };
const fixtureTools = [
  { name: 'echo', description: 'Synthetic echo', inputSchema: echoSchema, outputSchema },
  { name: 'raw/echo', description: 'Synthetic raw-name mapping', inputSchema: echoSchema },
  { name: 'argument_error', inputSchema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'], additionalProperties: false } },
  ...['error', 'environment', 'workspace', 'delay', 'invalid_output'].map(name => ({ name, inputSchema: { type: 'object', additionalProperties: false }, ...(name === 'invalid_output' ? { outputSchema } : {}) })),
];
const stdioServer = `import { createInterface } from 'node:readline';
const tools = ${JSON.stringify(fixtureTools)};
const mode = process.argv[2];
const send = (id,result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
for await (const line of createInterface({input:process.stdin})) {
  const m=JSON.parse(line); if(m.id===undefined)continue;
  if(m.method==='initialize')send(m.id,{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic',version:'1.0.0'}});
  else if(m.method==='tools/list')send(m.id,{tools:mode==='duplicate'?[tools[0],tools[0]]:tools});
  else if(m.method==='tools/call'){
    const name=m.params.name;
    if(name==='delay')await new Promise(r=>setTimeout(r,2000));
    if(name==='error')send(m.id,{isError:true,content:[{type:'text',text:'Synthetic '+process.env.FIXTURE_SECRET+' '+process.argv.join(' ')}]});
    else if(name==='argument_error')send(m.id,{isError:true,content:[{type:'text',text:m.params.arguments.token}],structuredContent:{[m.params.arguments.token]:m.params.arguments.token}});
    else if(name==='workspace')send(m.id,{content:[{type:'text',text:JSON.stringify({workspace:process.env.DIMENSION_WORKSPACE??null,cwd:process.cwd(),temp:process.env.TEMP,tmp:process.env.TMP})}]});
    else if(name==='environment')send(m.id,{content:[{type:'text',text:JSON.stringify({inherited:process.env.DANGER_TOKEN??null,dsh:process.env.DSH_EXAMPLE??null,explicit:process.env.FIXTURE_SECRET})}]});
    else if(name==='invalid_output')send(m.id,{content:[{type:'text',text:'bad'}],structuredContent:{text:42}});
    else {const text=(name==='raw/echo'?'raw:':'')+(m.params.arguments.text??'done');send(m.id,{content:[{type:'text',text}],structuredContent:{text}});}
  } else process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'unsupported'}})+'\\n');
}
`;

async function writePackage(directory, { name = 'fixture-local', version = '1.0.0', rows, patches, skill = true, server = true, manifest = {} } = {}) {
  await mkdir(directory, { recursive: true });
  const patchNames = patches ? patches.map((_, i) => `patch-${i}.yml`) : ['bundle.yml'];
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, version, license: 'MIT', dsh: { bundle: { patch: patchNames } }, ...manifest }));
  if (patches) for (let i = 0; i < patches.length; i++) await writeFile(path.join(directory, patchNames[i]), typeof patches[i] === 'string' ? patches[i] : JSON.stringify(patches[i]));
  // TEMP/TMP are host-managed and deliberately rejected in plugin config; the
  // workspace check below verifies the host-provided values instead.
  else await writeFile(path.join(directory, 'bundle.yml'), JSON.stringify([{ insert: rows ?? [{ id: 'fixture', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'fixture', transport: 'stdio', command: process.execPath, args: ['server.mjs'], env: { FIXTURE_SECRET: syntheticSecret } } }] }]));
  if (server) await writeFile(path.join(directory, 'server.mjs'), stdioServer);
  if (skill) { await mkdir(path.join(directory, 'skills', 'fixture'), { recursive: true }); await writeFile(path.join(directory, 'skills', 'fixture', 'SKILL.md'), '---\nname: fixture-skill\ndescription: Synthetic skill body loaded only on demand\n---\nUse the synthetic echo tool.\n'); }
  return directory;
}

// Shared fixture for the browser test. It serves only original synthetic data.
export async function createBrowserMarketFixture(workDir) {
  await mkdir(workDir, { recursive: true });
  const root = await mkdtemp(path.join(workDir, 'market-fixture-'));
  const archives = new Map(), metadata = new Map(), requests = [], sockets = new Set();
  let index;
  const server = http.createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url });
    const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/market.json' }); res.end(); return; }
    if (req.url === '/invalid.json') { send({ format: 1, title: { fr: 'missing English' }, plugins: [] }); return; }
    if (req.url === '/duplicate.json') { send({ ...index, plugins: [index.plugins[0], index.plugins[0]] }); return; }
    if (req.url === '/oversize.json') { res.writeHead(200, { 'Content-Length': String(9 * 1024 * 1024) }); res.end(); return; }
    if (req.url === '/contracts.json') { send({ ...index, metadata: { categories: { dev: { title: 'Development' } }, labels: { tools: { title: 'Tools' } }, sortKeys: { github_stars: { title: 'Stars', order: 'desc' } } }, plugins: [{ ...index.plugins[0], homepage: 'https://example.com/plugin#readme', repository: { url: 'https://example.com/repo', directory: './packages/test' }, metadata: { category: 'dev', labels: ['tools'], sortKeys: { github_stars: 0 } }, versions: [index.plugins[0].versions[1], { ...index.plugins[0].versions[0], version: '3.0.0-rc.1' }, index.plugins[0].versions[0]] }] }); return; }
    if (req.url === '/bad-metadata.json') { send({ ...index, plugins: [{ ...index.plugins[0], metadata: { category: 'undeclared' } }] }); return; }
    if (req.url === '/market.json') { send(index); return; }
    if (metadata.has(req.url)) { send(metadata.get(req.url)); return; }
    if (archives.has(req.url)) { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(archives.get(req.url)); return; }
    if (req.url === '/mcp') {
      if (req.method === 'GET') { res.writeHead(405); res.end(); return; }
      if (req.method === 'DELETE') { res.writeHead(200); res.end(); return; }
      let bytes = ''; for await (const chunk of req) bytes += chunk;
      const m = JSON.parse(bytes);
      if (m.id === undefined) { res.writeHead(202); res.end(); return; }
      let result;
      if (m.method === 'initialize') result = { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'synthetic-http', version: '1.0.0' } };
      else if (m.method === 'tools/list') result = { tools: fixtureTools };
      else if (m.method === 'tools/call') {
        if (m.params.name === 'error') result = { isError: true, content: [{ type: 'text', text: 'Synthetic ' + (req.headers.authorization ?? '') }] };
        else { const text = (m.params.name === 'raw/echo' ? 'raw:' : '') + (m.params.arguments.text ?? 'done'); result = { content: [{ type: 'text', text }], structuredContent: { text } }; }
      } else { send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unsupported' } }); return; }
      send({ jsonrpc: '2.0', id: m.id, result }); return;
    }
    send({ error: 'not found' }, 404);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const mcpName = 'fixture-market-mcp', unsupportedName = 'fixture-market-cordis', exactVersion = '2.0.0', otherVersion = '1.0.0';
  async function addPackage(name, version, options) {
    const directory = path.join(root, name + '-' + version), packageDir = path.join(directory, 'package');
    await writePackage(packageDir, { name, version, ...options });
    const tgz = path.join(directory, 'package.tgz'); await tar.c({ gzip: true, cwd: directory, file: tgz, portable: true }, ['package']);
    const archive = await readFile(tgz), archiveURL = '/tar/' + name + '-' + version + '.tgz';
    archives.set(archiveURL, archive);
    metadata.set('/registry/' + encodeURIComponent(name) + '/' + version, { name, version, dist: { tarball: url + archiveURL, integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64') } });
    return { version, publishTimestamp: 1700000000, source: { type: 'npm', registry: url + '/registry/' } };
  }
  const mcpVersions = [];
  for (const version of [exactVersion, otherVersion]) mcpVersions.push(await addPackage(mcpName, version, { rows: [{ id: 'mcp', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'fixture_market', transport: 'streamable-http', url: url + '/mcp', headers: { Authorization: syntheticSecret } } }] }));
  const unsupportedVersion = await addPackage(unsupportedName, '1.0.0', { rows: [{ id: 'custom', name: 'fixture-cordis-service', config: {} }], skill: false, server: false, manifest: { main: 'index.js', peerDependencies: { '@deepseek-ai/dsh-tools': '*' } } });
  index = { format: 1, title: { en: 'Synthetic market', 'zh-cn': '合成插件市场' }, plugins: [
    { name: mcpName, title: { en: 'Fixture MCP', 'zh-cn': '合成 MCP' }, description: '<img src=x onerror=window.__marketInjected=1> Synthetic fixture', license: 'MIT', versions: mcpVersions },
    { name: unsupportedName, title: 'Unsupported Cordis fixture', description: 'A service runtime adapter is required', versions: [unsupportedVersion] },
  ] };
  return { root, url, indexUrl: url + '/market.json', registryUrl: url + '/registry/', mcpName, unsupportedName, exactVersion, otherVersion, requests, index, metadata, archives, close: () => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve); }) };
}

function worker(request, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hostPath], { cwd: projectRoot, windowsHide: true, env: { ...process.env, DANGER_TOKEN: 'must-not-inherit', DSH_EXAMPLE: 'must-not-inherit' }, ...options });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
    const timer = setTimeout(() => { child.kill(); reject(Error('Worker timed out')); }, 15000);
    child.on('error', reject);
    child.on('exit', code => {
      clearTimeout(timer);
      try { assert.equal(code, 0); assert.equal(stderr, '', 'No diagnostics on stderr'); assert.equal(stdout.trim().split('\n').length, 1); resolve(JSON.parse(stdout)); }
      catch (e) { reject(new Error(e.message + '\n' + stdout + '\n' + stderr)); }
    });
    child.stdin.end(JSON.stringify(request) + '\n');
  });
}

async function main() {
  const outputRoot = path.resolve(process.argv[2] ?? path.join(projectRoot, 'outputs', 'phase3-plugins'));
  await mkdir(outputRoot, { recursive: true });
  const work = await mkdtemp(path.join(outputRoot, 'plugin-host-')), dataDir = path.join(work, 'data');
  const fixture = await createBrowserMarketFixture(work), report = [];
  async function test(name, callback) { try { await callback(); report.push({ name, ok: true }); console.log('PASS ' + name); } catch (e) { report.push({ name, ok: false, error: e.stack }); console.error('FAIL ' + name + '\n' + e.stack); } }
  const call = (action, args = {}) => worker({ action, dataDir, ...args });
  const direct = (action, args = {}) => handleRequest({ action, dataDir, ...args });
  let sourceId, planId, pluginId, stdioPluginId;
  try {
    await test('fresh status has no implicit source or enabled plugin', async () => { const r = await call('status'); assert(r.ok); assert.deepEqual(r.sources, []); assert.deepEqual(r.plugins, []); });
    await test('anonymous format-1 source and stable id', async () => { const r = await call('source.add', { url: fixture.indexUrl }); assert(r.ok, JSON.stringify(r)); sourceId = r.source.id; assert.equal((await call('source.add', { url: fixture.indexUrl })).source.id, sourceId); });
    await test('market pagination preserves index order and does not preclaim compatibility', async () => { const r = await call('market.list', { sourceId, limit: 1 }); assert.equal(r.items[0].name, fixture.mcpName); assert.equal(r.items[0].runtimeCompatibility.status, 'needs-inspection'); assert.equal(r.nextOffset, 1); assert.equal((await call('market.list', { sourceId, offset: 1, limit: 1 })).items[0].name, fixture.unsupportedName); assert.equal((await call('market.list', { sourceId, limit: 51 })).error.code, 'INVALID_PAGE'); });
    await test('exact version listing and search', async () => { const r = await call('market.versions', { sourceId, name: fixture.mcpName }); assert.deepEqual(r.versions.map(v => v.version), [fixture.exactVersion, fixture.otherVersion]); const search = await call('market.list', { sourceId, query: 'cordis' }); assert.equal(search.total, 1); });
    await test('redirect, invalid localization, duplicate names, oversized response rejected', async () => { for (const endpoint of ['/redirect', '/invalid.json', '/duplicate.json', '/oversize.json']) assert.equal((await call('source.add', { url: fixture.url + endpoint })).ok, false, endpoint); });
    await test('npm exact version inspected with SHA-512 and no enabled tools', async () => { const r = await call('package.inspect', { sourceId, name: fixture.mcpName, version: fixture.otherVersion }); assert(r.ok, JSON.stringify(r)); planId = r.inspection.planId; assert.equal(r.inspection.manifest.version, fixture.otherVersion); assert.equal(r.inspection.classification.supported, true); assert(!JSON.stringify(r).includes(syntheticSecret)); assert.deepEqual((await call('tools.list')).tools, []); });
    await test('install remains disabled and persists across worker processes', async () => { const r = await call('package.install', { planId }); assert(r.ok, JSON.stringify(r)); pluginId = r.plugin.id; assert.equal(r.plugin.enabled, false); assert.equal((await call('plugin.list')).plugins[0].id, pluginId); assert.deepEqual((await call('tools.list')).tools, []); });
    await test('HTTP MCP activation, public-to-raw mapping, canonical success output', async () => { const r = await call('plugin.enable', { pluginId }); assert(r.ok, JSON.stringify(r)); const echo = r.tools.find(t => t.rawName === 'echo'), raw = r.tools.find(t => t.rawName === 'raw/echo'); assert.equal(echo.name, 'mcp__fixture_market__echo'); assert.notEqual(raw.name, 'mcp__fixture_market__raw/echo'); const reply = await call('tools.call', { name: raw.name, args: { text: '猫🙂' }, workspace: work }); assert.equal(reply.text, 'raw:猫🙂'); assert.equal(reply.isError, false); });
    await test('MCP isError stays error and configured header secret is redacted', async () => { const r = await call('tools.call', { name: 'mcp__fixture_market__error', args: {} }); assert(r.ok, JSON.stringify(r)); assert.equal(r.isError, true); assert(!JSON.stringify(r).includes(syntheticSecret)); assert.match(r.text, /redacted/); });
    await test('JSON Schema input constraints enforced', async () => { const r = await call('tools.call', { name: 'mcp__fixture_market__echo', args: { text: '' } }); assert.equal(r.error.code, 'INVALID_ARGUMENTS'); });
    await test('skills are discoverable by id and loaded on demand', async () => { const r = await call('skill.list'); assert.equal(r.skills.length, 1); assert(r.skills[0].skillId); assert(!JSON.stringify(r).includes('Use the synthetic')); const body = await call('skill.read', { pluginId, skillId: r.skills[0].skillId }); assert.match(body.skill.body, /Use the synthetic echo/); });
    await test('modified enabled skill is rejected before body read', async () => { const r = await call('skill.list'), file = path.join(dataDir, 'plugins', 'packages', pluginId, 'skills', 'fixture', 'SKILL.md'), original = await readFile(file); await writeFile(file, original + '\nchanged'); assert.equal((await call('skill.read', { pluginId, skillId: r.skills[0].skillId })).error.code, 'PACKAGE_CHANGED'); await writeFile(file, original); });
    await test('duplicate enabled namespaces rejected atomically', async () => { const r = await call('package.inspect', { sourceId, name: fixture.mcpName, version: fixture.exactVersion }); const installed = await call('package.install', { planId: r.inspection.planId }); const enabled = await call('plugin.enable', { pluginId: installed.plugin.id }); assert.equal(enabled.error.code, 'NAMESPACE_CONFLICT'); assert.equal((await call('plugin.list')).plugins.find(p => p.id === installed.plugin.id).enabled, false); await call('plugin.remove', { pluginId: installed.plugin.id }); });
    await test('Cordis package inspection explains adapter need and refuses install', async () => { const r = await call('package.inspect', { sourceId, name: fixture.unsupportedName, version: '1.0.0' }); assert(r.ok, JSON.stringify(r)); assert.equal(r.inspection.classification.supported, false); const installed = await call('package.install', { planId: r.inspection.planId }); assert.equal(installed.error.code, 'UNSUPPORTED_PLUGIN'); });
    await test('disable immediately removes tools and skill availability', async () => { assert((await call('plugin.disable', { pluginId })).ok); assert.deepEqual((await call('tools.list')).tools, []); assert.deepEqual((await call('skill.list')).skills, []); assert.equal((await call('tools.call', { name: 'mcp__fixture_market__echo', args: { text: 'x' } })).error.code, 'TOOL_NOT_FOUND'); });
    await test('stdio MCP environment scrub, namespaces and schema-checked output', async () => { const local = await writePackage(path.join(work, 'stdio-package')); const r = await call('package.install', { path: local }); assert(r.ok, JSON.stringify(r)); stdioPluginId = r.plugin.id; assert((await call('plugin.enable', { pluginId: stdioPluginId })).ok); const env = await call('tools.call', { name: 'mcp__fixture__environment', args: {} }); assert(env.ok, JSON.stringify(env)); assert.deepEqual(JSON.parse(env.text), { inherited: null, dsh: null, explicit: syntheticSecret }); const raw = (await call('tools.list')).tools.find(t => t.rawName === 'raw/echo'); assert.equal((await call('tools.call', { name: raw.name, args: { text: 'mapped' } })).text, 'raw:mapped'); const invalid = await call('tools.call', { name: 'mcp__fixture__invalid_output', args: {} }); assert.equal(invalid.error.code, 'MCP_INVALID_RESULT'); });
    await test('stdio MCP error secret redaction', async () => { const r = await call('tools.call', { name: 'mcp__fixture__error', args: {} }); assert.equal(r.isError, true); assert(!JSON.stringify(r).includes(syntheticSecret)); });
    await test('MCP errors cannot echo private tool arguments or structured keys', async () => { const token = 'SYNTHETIC_ARGS_SECRET'; const r = await call('tools.call', { name: 'mcp__fixture__argument_error', args: { token } }); assert.equal(r.isError, true); assert(!JSON.stringify(r).includes(token)); });
    await test('workspace is explicit, cwd stays installed, and TEMP/TMP stay inside task data', async () => { const r = await call('tools.call', { name: 'mcp__fixture__workspace', args: {}, workspace: work }); const value = JSON.parse(r.text); assert.equal(value.workspace, work); assert.equal(value.cwd, path.join(dataDir, 'plugins', 'packages', stdioPluginId)); assert.equal(value.temp, path.join(dataDir, 'plugins', 'temporary')); assert.equal(value.tmp, value.temp); assert.equal((await call('tools.call', { name: 'mcp__fixture__workspace', args: {}, workspace: './relative' })).error.code, 'INVALID_WORKSPACE'); });
    await test('modified enabled package is rejected before MCP process execution', async () => { const serverPath = path.join(dataDir, 'plugins', 'packages', stdioPluginId, 'server.mjs'); const original = await readFile(serverPath); await writeFile(serverPath, original + '\n// modified after enable'); const r = await call('tools.call', { name: 'mcp__fixture__echo', args: { text: 'must not run' } }); assert.equal(r.error.code, 'PACKAGE_CHANGED'); await writeFile(serverPath, original); });
    await test('nested group patches preserve order and replace config wholesale', async () => { const local = await writePackage(path.join(work, 'patch-package'), { name: 'fixture-patch', patches: [
      [{ insert: [{ id: 'group', name: 'cordis:group', group: true, config: [] }] }, { id: 'group', insert: [{ id: 'server', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'patch', transport: 'invalid', expandTemplates: true } }] }],
      [{ id: 'server', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'patch', transport: 'stdio', command: process.execPath, args: ['server.mjs'] } }],
    ] }); const r = await call('package.inspect', { path: local }); assert(r.ok, JSON.stringify(r)); assert.equal(r.inspection.classification.supported, true); assert.equal(r.inspection.mcpServers[0].serverName, 'patch'); });
    await test('executable tags and YAML aliases rejected', async () => { for (const [suffix, patch] of [['tag', '- insert:\n  - id: x\n    name: x\n    config: !!js process.env.SECRET'], ['alias', '- insert: &x []\n- insert: *x']]) { const local = await writePackage(path.join(work, 'yaml-' + suffix), { patches: [patch] }); assert.equal((await call('package.inspect', { path: local })).error.code, 'UNSUPPORTED_YAML'); } });
    await test('changed local package invalidates install plan', async () => { const local = await writePackage(path.join(work, 'changed-package'), { name: 'fixture-change' }); const r = await call('package.inspect', { path: local }); await writeFile(path.join(local, 'new-file.txt'), 'changed'); assert.equal((await call('package.install', { planId: r.inspection.planId })).error.code, 'PACKAGE_CHANGED'); });
    await test('leading ./ bundle paths are accepted while parent traversal is rejected', async () => { const local = await writePackage(path.join(work, 'dot-path-package'), { name: 'fixture-dot-path' }); const manifestPath = path.join(local, 'package.json'), manifest = JSON.parse(await readFile(manifestPath)); manifest.dsh.bundle.patch = './bundle.yml'; await writeFile(manifestPath, JSON.stringify(manifest)); assert((await call('package.inspect', { path: local })).ok); manifest.dsh.bundle.patch = './sub/../bundle.yml'; await writeFile(manifestPath, JSON.stringify(manifest)); assert.equal((await call('package.inspect', { path: local })).error.code, 'UNSAFE_PATH'); });
    await test('valid market repository and metadata contracts, stable SemVer default', async () => { const source = await call('source.add', { url: fixture.url + '/contracts.json' }); assert(source.ok, JSON.stringify(source)); const market = await call('market.list', { sourceId: source.source.id }); assert.equal(market.items[0].defaultVersion, fixture.exactVersion); assert.equal(market.items[0].repository.directory, 'packages/test'); assert.equal(market.items[0].homepage, 'https://example.com/plugin#readme'); assert.equal(market.items[0].metadata.sortKeys.github_stars, 0); assert.equal((await call('source.add', { url: fixture.url + '/bad-metadata.json' })).error.code, 'INVALID_INDEX'); await call('source.remove', { sourceId: source.source.id }); });
    await test('crashed empty lock is reclaimed after grace period; fresh empty lock is busy', async () => { const lock = path.join(dataDir, 'plugins', 'state.lock'); await writeFile(lock, ''); const old = new Date(Date.now() - 60000); await utimes(lock, old, old); assert((await call('source.add', { url: fixture.indexUrl })).ok); await writeFile(lock, ''); assert.equal((await call('source.add', { url: fixture.indexUrl })).error.code, 'STATE_BUSY'); await rm(lock); });
    await test('duplicate tool list rolls back activation', async () => { const local = await writePackage(path.join(work, 'duplicate-tools'), { name: 'fixture-duplicate', rows: [{ id: 'x', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'duplicate', transport: 'stdio', command: process.execPath, args: ['server.mjs', 'duplicate'] } }] }); const r = await call('package.install', { path: local }); const enabled = await call('plugin.enable', { pluginId: r.plugin.id }); assert.equal(enabled.error.code, 'MCP_TOOL_LIST'); assert.equal((await call('plugin.list')).plugins.find(p => p.id === r.plugin.id).enabled, false); await call('plugin.remove', { pluginId: r.plugin.id }); });
    await test('oversized cumulative tool definitions do not partially enable', async () => { const local = await writePackage(path.join(work, 'large-tools'), { name: 'fixture-large-tools', rows: [{ id: 'x', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'large_tools', transport: 'stdio', command: process.execPath, args: ['server.mjs'] } }] }); const large = Array.from({ length: 20 }, (_, i) => ({ name: 'tool_' + i, description: 'd'.repeat(60000), inputSchema: { type: 'object' } })); await writeFile(path.join(local, 'server.mjs'), stdioServer.replace(JSON.stringify(fixtureTools), JSON.stringify(large))); const r = await call('package.install', { path: local }); assert(r.ok, JSON.stringify(r)); const enabled = await call('plugin.enable', { pluginId: r.plugin.id }); assert.equal(enabled.error.code, 'MCP_TOOL_LIST'); assert.equal((await call('plugin.list')).plugins.find(p => p.id === r.plugin.id).enabled, false); assert(!(await call('tools.list')).tools.some(t => t.serverName === 'large_tools')); await call('plugin.remove', { pluginId: r.plugin.id }); });
    await test('MCP call timeout fails without untrusted diagnostics', async () => { const local = await writePackage(path.join(work, 'timeout-package'), { name: 'fixture-timeout', rows: [{ id: 'x', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'timeout', transport: 'stdio', command: process.execPath, args: ['server.mjs'], toolCallTimeoutMs: 80 } }] }); const r = await call('package.install', { path: local }); assert((await call('plugin.enable', { pluginId: r.plugin.id })).ok); const start = Date.now(); const result = await call('tools.call', { name: 'mcp__timeout__delay', args: {} }); assert.equal(result.error.code, 'MCP_REQUEST_FAILED'); assert(Date.now() - start < 5000); await call('plugin.remove', { pluginId: r.plugin.id }); });
    await test('npm integrity mismatch rejected before extraction', async () => { const key = '/registry/' + fixture.mcpName + '/' + fixture.exactVersion, meta = fixture.metadata.get(key); const backup = meta.dist.integrity; meta.dist.integrity = 'sha512-' + Buffer.alloc(64).toString('base64'); const r = await call('package.inspect', { sourceId, name: fixture.mcpName, version: fixture.exactVersion }); meta.dist.integrity = backup; assert.equal(r.error.code, 'PACKAGE_INTEGRITY'); });
    await test('npm path traversal and symbolic-link archives rejected', async () => { const key = '/registry/' + fixture.mcpName + '/' + fixture.exactVersion, meta = fixture.metadata.get(key), archiveKey = new URL(meta.dist.tarball).pathname, backup = fixture.archives.get(archiveKey), integrity = meta.dist.integrity;
      for (const [name, type, link] of [['../escape.txt', '0', ''], ['package/link', '2', '../../escape']]) {
        const header = Buffer.alloc(512); header.write(name, 0); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116); header.write('00000000000\0', 124); header.write('00000000000\0', 136); header.fill(32, 148, 156); header.write(type, 156); header.write(link, 157); header.write('ustar\0', 257); header.write('00', 263); let checksum = 0; for (const b of header) checksum += b; header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148); const archive = gzipSync(Buffer.concat([header, Buffer.alloc(1024)])); fixture.archives.set(archiveKey, archive); meta.dist.integrity = 'sha512-' + createHash('sha512').update(archive).digest('base64'); const r = await call('package.inspect', { sourceId, name: fixture.mcpName, version: fixture.exactVersion }); assert.equal(r.ok, false, JSON.stringify(r)); assert(['UNSAFE_PATH', 'UNSAFE_ARCHIVE'].includes(r.error.code), JSON.stringify(r));
      }
      fixture.archives.set(archiveKey, backup); meta.dist.integrity = integrity;
    });
    await test('local links rejected', async () => { const local = await writePackage(path.join(work, 'linked-package')); const outside = path.join(work, 'outside'); await mkdir(outside); await symlink(outside, path.join(local, 'escape'), 'junction'); assert.equal((await call('package.inspect', { path: local })).error.code, 'UNSAFE_PATH'); });
    await test('invalid and unknown worker requests fail in one JSON line', async () => { assert.equal((await call('does-not-exist')).error.code, 'UNKNOWN_ACTION'); assert.equal((await worker({ action: 'status', dataDir: 'relative' })).error.code, 'INVALID_REQUEST'); });
    await test('remove unregisters and deletes only managed package', async () => { assert((await call('plugin.remove', { pluginId: stdioPluginId })).ok); assert((await call('plugin.remove', { pluginId })).ok); assert.deepEqual((await call('plugin.list')).plugins, []); assert.deepEqual((await call('tools.list')).tools, []); await call('source.remove', { sourceId }); assert.deepEqual((await direct('source.list')).sources, []); });
  } finally { await fixture.close(); }
  const result = { passed: report.filter(r => r.ok).length, total: report.length, work, report };
  await writeFile(path.join(outputRoot, 'plugin-host-report.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: result.passed, total: result.total, report: path.join(outputRoot, 'plugin-host-report.json') }));
  if (result.passed !== result.total) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
