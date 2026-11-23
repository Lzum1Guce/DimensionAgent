// Shared real-native fixture and API checks; importing this file starts nothing.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { project, parseOptions, startNative, digest, until } from './archive-export-api.mjs';

export { project, parseOptions, startNative, digest, until };
export const keys = ['user-profile', 'user-relationship', 'contacts', 'external-bots'];
export const titles = ['关于用户', '与用户的关系', '联系人及关系', '认识的外部Bot'];
export const emptyValues = () => Object.fromEntries(keys.map(key => [key, '']));
export const valuesOf = result => Object.fromEntries(result.overview.relations.map(item => [item.key, item.content]));
export const memoryRoute = botId => '/api/dimension/memory?botId=' + encodeURIComponent(botId);
export const personaRoute = botId => '/api/dimension/persona?botId=' + encodeURIComponent(botId);
export const bodyPrefix = 'SYNTH_RELATION_BODY_';
export const htmlText = bodyPrefix + '</textarea><img id="relationInjected" src="x" onerror="window.__relationXss=1"><script>window.__relationXss=2</script> 中文🙂';
export function assertOverview(result, values) {
  assert(Array.isArray(result.overview?.relations)); assert.equal(result.overview.relations.length, 4);
  assert.deepEqual(result.overview.relations.map(item => item.key), keys);
  assert.deepEqual(result.overview.relations.map(item => item.title), titles);
  for (const item of result.overview.relations) {
    assert.equal(typeof item.description, 'string'); assert(item.description.length > 0);
    assert.equal(typeof item.content, 'string');
  }
  assert.match(result.overview.relationRevision, /^[0-9a-f]{64}$/);
  if (values) assert.deepEqual(valuesOf(result), values);
  return result;
}
export async function saveRelations(app, botId, values, baseRevision, status = 200) {
  return app.api('/api/dimension/memory', { action: 'save-relations', botId, values, baseRevision }, 'POST', status);
}
export async function seedBots(app, prefix) {
  const ids = { alpha: prefix + '-alpha', beta: prefix + '-beta' };
  const personas = {};
  for (const id of Object.values(ids)) {
    personas[id] = bodyPrefix + id + ' 独立人设 <b>原样文本</b>';
    await app.api('/api/dimension/bots', { id, name: '合成关系 ' + id, persona: personas[id] });
  }
  return { ids, personas };
}
export async function exerciseApi(app, pass) {
  const { ids, personas } = await seedBots(app, 'relation-api');
  const first = assertOverview(await app.api(memoryRoute(ids.alpha)), emptyValues());
  const second = assertOverview(await app.api(memoryRoute(ids.beta)), emptyValues());
  assert.notEqual(first.overview.relationRevision, second.overview.relationRevision);
  const persona = await app.api(personaRoute(ids.alpha));
  assert.deepEqual(persona.fields.map(field => field.key), ['persona']); assert.equal(persona.fields[0].content, personas[ids.alpha]);
  pass('Each Bot starts with four empty semantic relation fields and its own revision; persona contains only persona');

  const values = { 'user-profile': htmlText, 'user-relationship': bodyPrefix + '从真实交流逐步了解，不预设关系',
    contacts: bodyPrefix + '本应用 Bot beta；跨平台人类联系人', 'external-bots': bodyPrefix + '另一个 Agent 平台中的 Bot' };
  const saved = assertOverview(await saveRelations(app, ids.alpha, values, first.overview.relationRevision), values);
  assert.notEqual(saved.overview.relationRevision, first.overview.relationRevision);
  assert.equal(saved.revision, first.revision, 'Relations must not rewrite ordinary memories');
  assert.equal((await app.api(personaRoute(ids.alpha))).fields[0].content, personas[ids.alpha]);
  assertOverview(await app.api(memoryRoute(ids.beta)), emptyValues());
  pass('Saving all four fields preserves exact text, ordinary memory revision, persona and the other Bot');

  await saveRelations(app, ids.alpha, emptyValues(), first.overview.relationRevision, 409);
  await saveRelations(app, ids.beta, values, saved.overview.relationRevision, 409);
  assertOverview(await app.api(memoryRoute(ids.alpha)), values); assertOverview(await app.api(memoryRoute(ids.beta)), emptyValues());
  pass('Stale and cross-Bot relation revisions reject without overwriting either Bot');

  const invalidValues = [{ ...values, extra: 'unknown' }, { ...values, contacts: 42 }, { ...values, 'user-profile': 'x'.repeat(65537) }];
  const missing = { ...values }; delete missing.contacts; invalidValues.push(missing);
  for (const bad of invalidValues) await saveRelations(app, ids.alpha, bad, saved.overview.relationRevision, 400);
  await app.api('/api/dimension/memory', { action: 'save-relations', botId: ids.alpha, groupId: 'synthetic-group', values, baseRevision: saved.overview.relationRevision }, 'POST', 400);
  const grouped = await app.api(memoryRoute(ids.alpha) + '&groupId=synthetic-group');
  assert.deepEqual(grouped.overview.relations, []); assert.equal(grouped.overview.relationRevision, '');
  assertOverview(await app.api(memoryRoute(ids.alpha)), values);
  pass('Unknown/missing/nontext/oversized fields and group writes reject; group reads do not expose private relation notes');

  await app.api(personaRoute(ids.alpha), { values: { persona: 'must not replace', contacts: 'must not append' } }, 'POST', 400);
  assert.equal((await app.api(personaRoute(ids.alpha))).fields[0].content, personas[ids.alpha]);
  const revisedPersona = bodyPrefix + '明确修改的人设，保持关系分离';
  await app.api(personaRoute(ids.alpha), { values: { persona: revisedPersona } });
  assert.equal((await app.api(personaRoute(ids.alpha))).fields[0].content, revisedPersona);
  assertOverview(await app.api(memoryRoute(ids.alpha)), values);
  pass('Persona rejects relation keys and a valid persona-only edit does not rewrite relation notes');

  const cleared = assertOverview(await saveRelations(app, ids.beta, { ...emptyValues(), contacts: 'temporary' }, second.overview.relationRevision));
  assertOverview(await saveRelations(app, ids.beta, emptyValues(), cleared.overview.relationRevision), emptyValues());
  await app.api('/api/dimension/bots/' + ids.alpha, undefined, 'DELETE');
  assertOverview(await app.api(memoryRoute(ids.alpha)), values);
  assert.equal((await app.api(personaRoute(ids.alpha))).fields[0].content, revisedPersona);
  pass('Empty strings remain empty, and removing a Bot from rosters retains its relation notes and persona');
  return { ids, values, persona: revisedPersona };
}
export async function assertRestart(app, state, pass) {
  assertOverview(await app.api(memoryRoute(state.ids.alpha)), state.values);
  assertOverview(await app.api(memoryRoute(state.ids.beta)), emptyValues());
  assert.equal((await app.api(personaRoute(state.ids.alpha))).fields[0].content, state.persona);
  pass('Relation notes, empty fields and independent persona persist through a real native restart');
}
export async function setup(options, name) {
  const output = path.resolve(options.get('output') || path.join(project, 'outputs', name, new Date().toISOString().replace(/[:.]/g, '-')));
  assert(/^[lL]:[\\/]/.test(output));
  const executable = path.resolve(options.get('exe') || path.join(project, 'outputs/build/DImensionagent-native.exe'));
  const ui = path.resolve(options.get('ui') || path.join(project, 'ui')), data = path.join(output, 'data');
  await mkdir(path.join(output, 'temp'), { recursive: true });
  assert.equal(await stat(data).catch(error => { if (error.code === 'ENOENT') return null; throw error; }), null, 'Fresh synthetic data directory required');
  const fingerprints = { native: digest(await readFile(executable)), ui: digest(await readFile(path.join(ui, 'app.js'))), apiTest: digest(await readFile(import.meta.filename)) };
  if (options.has('expected-sha')) assert.equal(fingerprints.native, options.get('expected-sha').toLowerCase());
  return { output, executable, ui, data, fingerprints, processes: [], traces: [] };
}
export async function cleanup(config) {
  const execFileAsync = promisify(execFile);
  for (const entry of config.processes) if (entry.child.exitCode === null && entry.child.pid)
    await execFileAsync('taskkill', ['/PID', String(entry.child.pid), '/T', '/F'], { cwd: config.output, windowsHide: true }).catch(() => {});
  for (const entry of config.processes) {
    assert(!entry.stdout.includes(bodyPrefix) && !entry.stderr.includes(bodyPrefix), 'Native logs exposed relation bodies');
    await writeFile(path.join(config.output, entry.label + '.log'), entry.stdout + '\nSTDERR\n' + entry.stderr);
  }
}
async function main() {
  const config = await setup(parseOptions(), 'phase3-relation-api'), checks = [], failures = [];
  const pass = name => { checks.push(name); console.log('PASS ' + name); }; let app;
  try {
    app = await startNative({ ...config, label: 'native' });
    const state = await exerciseApi(app, pass);
    await app.stop(); app = await startNative({ ...config, label: 'native-restart' }); await assertRestart(app, state, pass);
    await app.stop();
  } catch (error) { failures.push(error.stack); process.exitCode = 1; }
  finally {
    if (app?.child.exitCode === null) await app.stop().catch(error => failures.push(error.message));
    await cleanup(config);
    const report = { ok: failures.length === 0, checks, failures, fingerprints: config.fingerprints, traces: config.traces, productionDataUsed: false, modelRequests: 0 };
    await writeFile(path.join(config.output, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ok: report.ok, checks: checks.length, output: config.output }));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) await main();
