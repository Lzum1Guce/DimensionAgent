// Synthetic data only. Shared real-HTTP helpers; importing starts no processes.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { project, body, fixtureArchive, rawImport, digest, canonical, readSnapshot, startNative } from './archive-export-api.mjs';

export const fields = ['name', 'id', 'persona', 'chatHistory', 'workHistory', 'longTermMemory', 'relations', 'midTermMemory', 'avatar'];
export const contentFields = fields.filter(key => key !== 'id');
export const defaultFields = ['name', 'persona', 'longTermMemory', 'relations', 'midTermMemory'];
export const prefix = 'CAPSULE_PRIVATE_';
export const marker = {
  name: '归档样本 中文🙂', persona: prefix + 'PERSONA 中文🙂', relation: prefix + 'RELATION 中文🙂',
  mid: prefix + 'MID 中文🙂', groupMid: 'CAPSULE_GROUP_MID_EXCLUDED', candidate: prefix + 'CANDIDATE', rejected: prefix + 'REJECTED',
};
export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGN8ZqPBwMDAxAAGABBgAU6wYIpsAAAAAElFTkSuQmCC', 'base64');
export const route = '/api/native/bot-archive';
const packageBytes = new WeakMap();
export async function setup(options, label) {
  const output = path.resolve(options.get('output') || path.join(project, 'outputs', label, String(Date.now())));
  assert(/^[lL]:[\\/]/.test(output), 'All independent output belongs on L:');
  assert(options.get('exe'), 'A parent-released --exe is required; this test never builds');
  await mkdir(path.join(output, 'temp'), { recursive: true });
  await mkdir(path.join(output, 'bin'), { recursive: true });
  const sourceExe = path.resolve(options.get('exe')), executable = path.join(output, 'bin', 'DimensionAgent-native.exe');
  await copyFile(sourceExe, executable);
  const executableSha256 = digest(await readFile(executable));
  assert.equal(executableSha256, digest(await readFile(sourceExe)));
  const ui = path.resolve(options.get('ui') || path.join(project, 'ui'));
  const processes = [], traces = [], snapshots = [], fingerprints = { sourceExe, executable, executableSha256 };
  for (const name of ['app.js', 'bot-archive-ui.js', 'archived-work-ui.js', 'conversation-archive-ui.js', 'index.html', 'styles.css'])
    fingerprints[name] = digest(await readFile(path.join(ui, name)));
  return { output, executable, ui, processes, traces, snapshots, fingerprints, python: options.get('python') || 'python' };
}
export const launch = (config, label, dataName = label) => startNative({ ...config, label, data: path.join(config.output, dataName + '-data') });
export const snapshot = (config, app, label) => readSnapshot(app.data, config.output, label, config.snapshots, config.python);
export async function unchanged(config, app, before, label) { assert.equal((await snapshot(config, app, label)).hash, before.hash, label); }
export async function binary(app, endpoint, { method = 'GET', body: bytes, mime, expected = 200 } = {}) {
  const response = await fetch(app.origin + endpoint, { method, body: bytes, headers: mime ? { 'content-type': mime } : {} });
  const data = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, expected, method + ' ' + endpoint + ': ' + (response.status === expected ? '' : data.toString('utf8').slice(0, 300)));
  return { bytes: data, status: response.status, type: response.headers.get('content-type') };
}
export async function seed(app, name = 'capsule') {
  const value = fixtureArchive(name);
  value.archive.memories.push(
    { id: '9007199254743001', botId: value.ids.owner, groupId: '', text: marker.candidate, state: 'candidate', revision: '3', sourceActor: 'user' },
    { id: '9007199254743002', botId: value.ids.owner, groupId: '', text: marker.rejected, state: 'rejected', revision: '7', sourceActor: 'user' });
  await rawImport(app, value.archive, 'synthetic-' + name + '-seed');
  await app.api('/api/dimension/bots/' + value.ids.owner + '/profile', { name: marker.name, persona: marker.persona }, 'PATCH');
  const memory = await app.api('/api/dimension/memory?botId=' + value.ids.owner);
  await app.api('/api/dimension/memory', { action: 'save-relations', botId: value.ids.owner,
    values: { 'user-profile': marker.relation, 'user-relationship': '', contacts: '', 'external-bots': '' }, baseRevision: memory.overview.relationRevision });
  await app.api('/api/dimension/memory', { action: 'add-mid', botId: value.ids.owner, text: marker.mid });
  await app.api('/api/dimension/memory', { action: 'add-mid', botId: value.ids.owner, groupId: value.ids.group, text: marker.groupMid });
  await binary(app, '/api/dimension/bots/' + value.ids.owner + '/avatar', { method: 'POST', body: png, mime: 'image/png' });
  return value;
}
export function assertPackage(value, wanted, rawText) {
  assert.deepEqual(Object.keys(value).sort(), ['format', 'version', 'sourceKey', 'fields', 'data', 'counts', 'packageSha256'].sort());
  assert.equal(value.format, 'dimension-bot-archive'); assert.equal(value.version, 1);
  assert.match(value.sourceKey, /^[0-9a-f]{64}$/); assert.match(value.packageSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(value.fields, fields.filter(key => wanted.includes(key)));
  assert.deepEqual(Object.keys(value.data).sort(), [...wanted].sort());
  const { packageSha256, ...unsigned } = value;
  // Native std::to_chars uses exponent notation for some large integer doubles.
  // Verify the exact native canonical bytes rather than reformatting their numbers.
  const unsignedText = rawText ? rawText.replace(/,"packageSha256":"[0-9a-f]{64}"/, '') : canonical(unsigned);
  assert.equal(packageSha256, digest(unsignedText), 'Canonical checksum covers the complete package');
  packageBytes.set(value, Buffer.byteLength(rawText || canonical(value)));
  for (const key of fields) assert.equal(value.counts[key], wanted.includes(key) ? Array.isArray(value.data[key]) ? value.data[key].length : 1 : 0, key + ' count');
  assert.equal(value.counts.avatarBytes, value.data.avatar?.byteSize || 0);
  if (value.data.avatar) {
    const bytes = Buffer.from(value.data.avatar.base64, 'base64');
    assert.equal(bytes.length, value.counts.avatarBytes); assert.equal(digest(bytes), value.data.avatar.sha256);
  }
  return value;
}
export async function exportBot(app, botId, wanted) {
  const response = await app.response(route + '/export', { botId, fields: wanted });
  assert.equal(response.status, 200); assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['content-disposition'], 'attachment; filename="DimensionAgent-bot.json"');
  return { ...response, package: assertPackage(response.value, wanted, response.text), bytes: Buffer.byteLength(response.text) };
}
export async function stage(app, packageValue, selected, preserveId = false) {
  const result = await app.api(route + '/stage', { package: packageValue, fields: selected, preserveId });
  assert.match(result.token, /^[0-9a-f]{32}$/);
  assert.deepEqual(result.report.selectedFields, fields.filter(key => selected.includes(key)));
  assert.deepEqual(result.report.availableFields, packageValue.fields);
  assert.equal(result.report.packageBytes, packageBytes.get(packageValue) || Buffer.byteLength(canonical(packageValue)));
  for (const key of fields) assert.equal(result.report.selectedCounts[key], selected.includes(key) ? packageValue.counts[key] : 0);
  const text = JSON.stringify(result);
  for (const secret of [prefix, 'SYNTH_EXPORT_BODY_', marker.name, marker.groupMid, png.toString('base64')]) assert(!text.includes(secret), 'Preview must not expose record bodies');
  if (!selected.includes('id')) assert.equal(result.report.source.id, undefined);
  app.tokens.add(result.token);
  return result;
}
export async function discard(app, token) {
  const result = await app.api(route + '/stage/' + token, undefined, 'DELETE');
  assert.equal(result.discarded, true); app.tokens.delete(token);
}
export async function commit(app, preview) {
  const result = await app.api(route + '/commit', { token: preview.token });
  assert.equal(result.committed, true); assert.equal(result.bot.id, preview.report.target.id);
  assert.equal(result.bot.inChat, false); assert.equal(result.bot.inWork, false);
  assert(result.bots.some(bot => bot.id === result.bot.id), 'Commit returns refreshed authorized Bot list');
  return result;
}
export const resign = value => { const { packageSha256, ...unsigned } = value; return { ...unsigned, packageSha256: digest(canonical(unsigned)) }; };
export function largePng() {
  const width = 1024, height = 1024, raw = Buffer.alloc((width * 3 + 1) * height);
  let state = 0x12345678;
  for (let y = 0; y < height; ++y) for (let x = 1; x <= width * 3; ++x) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5; raw[y * (width * 3 + 1) + x] = state & 255;
  }
  function chunk(name, data) {
    const tag = Buffer.from(name), size = Buffer.alloc(4), crc = Buffer.alloc(4); size.writeUInt32BE(data.length);
    let value = 0xffffffff;
    for (const byte of Buffer.concat([tag, data])) { value ^= byte; for (let i = 0; i < 8; ++i) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
    crc.writeUInt32BE((value ^ 0xffffffff) >>> 0); return Buffer.concat([size, tag, data, crc]);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
}
export async function cleanup(config, failures) {
  for (const app of config.processes) if (app.stop && app.child.exitCode === null) {
    for (const token of app.tokens) await app.api(route + '/stage/' + token, undefined, 'DELETE').catch(() => {});
    await app.stop().catch(error => failures.push(error.stack));
  }
  for (const entry of config.processes) if (entry.child.pid && entry.child.exitCode === null)
    await promisify(execFile)('taskkill', ['/PID', String(entry.child.pid), '/T', '/F'], { cwd: config.output, windowsHide: true }).catch(() => {});
  for (const entry of config.processes) await writeFile(path.join(config.output, entry.label + '.log'), entry.stdout + '\nSTDERR\n' + entry.stderr);
}
export async function report(config, checks, failures, extra = {}) {
  const processes = config.processes.map(entry => ({ label: entry.label, pid: entry.child.pid, exitCode: entry.child.exitCode, signal: entry.child.signalCode, data: entry.data }));
  const ok = failures.length === 0 && processes.every(entry => entry.exitCode === 0);
  const result = { ok, checks, failures, fingerprints: config.fingerprints, traces: config.traces, snapshots: config.snapshots, processes,
    scope: 'Fresh synthetic L: databases and independent copied released binary; loopback HTTP and optional isolated headless Chrome only; no native builds, real accounts, production data, external websites or host input.', ...extra };
  await writeFile(path.join(config.output, 'result.json'), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify({ ok, checks: checks.length, output: config.output }));
  if (!ok) process.exitCode = 1; return result;
}

