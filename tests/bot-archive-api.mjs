// Selective Bot archives through actual released native HTTP and SQLite snapshots.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { body, canonical, digest, parseOptions, until } from './archive-export-api.mjs';
import { startFixture } from './app-integration.mjs';
import { setup, launch, seed, snapshot, unchanged, fields, contentFields, defaultFields, marker, prefix, png,
  binary, route, exportBot, stage, discard, commit, resign, largePng, cleanup, report } from './bot-archive-fixture.mjs';

const config = await setup(parseOptions(), 'bot-archive-api');
const checks = [], failures = [], exports = [];
const pass = text => { checks.push(text); console.log('PASS ' + text); };
let source, target, fixture;
try {
  source = await launch(config, 'source'); target = await launch(config, 'target');
  const capabilities = await source.api(route + '/capabilities');
  assert.deepEqual(capabilities.fields, fields); assert.equal(capabilities.defaultNewId, true); assert.equal(capabilities.existingIdOverwrite, false);
  assert.equal(capabilities.maxPackageBytes, 16 * 1024 * 1024 - 8192); assert.equal(capabilities.maxBodyBytes, 16 * 1024 * 1024);
  assert.equal(capabilities.maxAvatarBytes, 8 * 1024 * 1024); assert.equal(capabilities.maxTextBytes, 4 * 1024 * 1024);
  assert.equal((await source.api('/api/dimension/bootstrap')).features.botArchives, true);
  pass('Capabilities expose all nine selectable fields, accurate byte limits, default new IDs and no existing-ID overwrite');

  const sample = await seed(source), owner = sample.ids.owner;
  fixture = await startFixture();
  await source.api('/api/providers', { name: 'synthetic', entry: { kind: 'openai-chat-compat', baseUrl: fixture.baseUrl, spec: { model: 'fixture-flash' } }, secretValue: 'synthetic-key' });
  const initial = 'APPTEST:bot_archive_work\n归档原要求：保留真实任务文字。', supplement = 'RELEASE\n归档补充要求：保留中文🙂。', answer = 'Verified delivery bot_archive_work';
  fixture.gate('bot_archive_work');
  const work = await source.api('/api/dimension/work/runs', { botId: owner, text: initial, requestId: 'bot-archive-initial' });
  await fixture.pending('bot_archive_work');
  const steered = await source.api('/api/dimension/work/runs', { botId: owner, text: supplement, requestId: 'bot-archive-supplement' });
  assert.equal(steered.run.id, work.run.id);
  const completed = await until(async () => { const run = await source.api('/api/dimension/work/runs/' + work.run.id); return run.terminal && !run.executing && run; }, 'synthetic Work completion');
  assert.equal(completed.status, 'completed');
  const sourceBefore = await snapshot(config, source, 'source-seeded');
  const all = await exportBot(source, owner, fields), packageValue = all.package;
  await writeFile(path.join(config.output, 'all-fields-bot.json'), all.text);
  exports.push({ fields, bytes: all.bytes, sha256: digest(all.text), counts: packageValue.counts });
  assert.deepEqual(packageValue.counts, { name: 1, id: 1, persona: 1, chatHistory: 2, workHistory: 4, longTermMemory: 3, relations: 1, midTermMemory: 1, avatar: 1, avatarBytes: png.length });
  const workTexts = packageValue.data.workHistory.map(row => row.text);
  for (const text of [body('PRIVATE_WORK_INT64_MAX'), initial, supplement, answer]) assert(workTexts.includes(text));
  assert.equal(packageValue.data.longTermMemory.find(row => row.text === body('PRIVATE_CONFIRMED')).revision, '9223372036854775807');
  assert.deepEqual(packageValue.data.chatHistory.map(row => row.createdAtMs), ['0', '-1']);
  for (const text of ['GROUP_', 'WORK_ONLY_', marker.groupMid, 'synthetic-key', 'tool_results', 'fixture_call_', 'THINKING_ONLY_', 'execution_outcome_known', 'protectedKey', 'baseUrl'])
    assert(!all.text.includes(text), 'Only private selected data belongs in Bot archive: ' + text);
  assert.deepEqual(Object.keys(packageValue.data.workHistory[0]).sort(), ['id', 'actor', 'text', 'createdAtMs'].sort());
  await unchanged(config, source, sourceBefore, 'exports-do-not-mutate-source');
  pass('All-field export includes actual Work original/supplement/reply, exact private Chat/int64/memory data and avatar; excludes groups, other Bots and Work execution internals');

  for (const key of fields) {
    const value = await exportBot(source, owner, [key]);
    assert.equal(Object.keys(value.package.data).length, 1);
    if (key !== 'id') assert(!value.text.includes(owner));
    for (const [field, secret] of [['persona', marker.persona], ['longTermMemory', body('PRIVATE_CONFIRMED')], ['relations', marker.relation], ['midTermMemory', marker.mid], ['avatar', png.toString('base64')]])
      if (key !== field) assert(!value.text.includes(secret), 'Unselected ' + field + ' body leaked into ' + key + ' export');
    exports.push({ fields: [key], bytes: value.bytes, sha256: digest(value.text), counts: value.package.counts });
  }
  const anonymous = await exportBot(source, owner, contentFields);
  assert(!anonymous.text.includes(owner));
  const minimal = await exportBot(source, owner, ['name', 'persona']);
  await writeFile(path.join(config.output, 'profile-only-bot.json'), minimal.text);
  pass('Every field exports independently; omitting ID, memory kinds and avatar removes their actual bodies and original Bot ID from the downloaded package');

  await target.api('/api/dimension/bots', { id: owner, name: 'Existing identity', persona: 'LOCAL_PROFILE_MUST_SURVIVE' });
  let before = await snapshot(config, target, 'target-existing-id');
  const inspect = await stage(target, packageValue, []);
  assert.equal(inspect.report.canCommit, false); assert.equal(inspect.report.target.preserveId, false);
  await target.api(route + '/commit', { token: inspect.token }, 'POST', 409);
  await unchanged(config, target, before, 'inventory-no-write'); await discard(target, inspect.token);
  const cancel = await stage(target, packageValue, defaultFields); assert(cancel.report.canCommit);
  await unchanged(config, target, before, 'selected-preview-no-write'); await discard(target, cancel.token);
  await target.api(route + '/commit', { token: cancel.token }, 'POST', 404);
  await unchanged(config, target, before, 'cancel-no-write');
  pass('Inventory starts with no selection; preview cannot write; cancellation invalidates the token and leaves every SQLite row unchanged');

  const conflict = await stage(target, packageValue, fields, true);
  assert.equal(conflict.report.canCommit, false); assert(conflict.report.conflicts.some(item => item.code === 'bot_archive_id_exists'));
  await target.api(route + '/commit', { token: conflict.token }, 'POST', 409); await discard(target, conflict.token);
  await unchanged(config, target, before, 'id-conflict-no-overwrite');
  const profilePreview = await stage(target, packageValue, ['persona']);
  assert(profilePreview.report.canCommit); assert.notEqual(profilePreview.report.target.id, owner);
  const profile = await commit(target, profilePreview); await discard(target, profilePreview.token);
  const isolated = await exportBot(target, profile.bot.id, fields.filter(key => key !== 'avatar'));
  assert.equal(isolated.package.data.name, 'Imported Bot'); assert.equal(isolated.package.data.persona, marker.persona);
  for (const key of ['chatHistory', 'workHistory', 'longTermMemory', 'relations', 'midTermMemory']) assert.deepEqual(isolated.package.data[key], []);
  await binary(target, '/api/dimension/bots/' + profile.bot.id + '/avatar', { expected: 404 });
  assert.equal((await exportBot(target, owner, ['persona'])).package.data.persona, 'LOCAL_PROFILE_MUST_SURVIVE');
  pass('Retaining an occupied ID blocks commit without overwriting; persona-only import creates an independent Bot with no unselected history, memory or avatar');

  before = await snapshot(config, target, 'before-invalid-packages');
  const tampered = structuredClone(packageValue); tampered.data.persona = 'modified';
  const malformed = [
    { package: tampered, fields: ['persona'], preserveId: false },
    { package: minimal.package, fields: ['avatar'], preserveId: false },
    { package: packageValue, fields: ['id'], preserveId: false },
    { package: packageValue, fields: ['name'], preserveId: true },
    { package: packageValue, fields: ['name', 'name'], preserveId: false },
    { package: packageValue, fields: ['unknown'], preserveId: false },
    { package: packageValue, fields: ['name'], preserveId: false, targetId: owner },
  ];
  for (const payload of malformed) await target.api(route + '/stage', payload, 'POST', 400);
  const duplicate = JSON.stringify(packageValue).replace('"format":"dimension-bot-archive"', '"format":"dimension-bot-archive","format":"dimension-bot-archive"');
  await target.api(route + '/stage', '{"package":' + duplicate + ',"fields":[],"preserveId":false}', 'POST', 400);
  const badAvatar = structuredClone(packageValue); badAvatar.data.avatar.width = 999; const rebound = resign(badAvatar);
  await target.api(route + '/stage', { package: rebound, fields: ['persona'], preserveId: false }, 'POST', 400);
  await unchanged(config, target, before, 'invalid-packages-no-write');
  pass('Checksum errors, duplicate keys/selections, unknown fields, absent content, ID mismatches and malformed even-unselected avatars reject atomically');

  const fullPreview = await stage(target, packageValue, contentFields); assert(fullPreview.report.canCommit);
  const full = await commit(target, fullPreview), importedId = full.bot.id;
  const replay = await commit(target, fullPreview); assert.equal(replay.idempotent, true); await discard(target, fullPreview.token);
  const imported = (await exportBot(target, importedId, contentFields)).package;
  for (const key of ['name', 'persona', 'avatar']) assert.deepEqual(imported.data[key], packageValue.data[key]);
  for (const key of ['chatHistory', 'workHistory', 'longTermMemory', 'relations', 'midTermMemory']) {
    const normalize = rows => rows.map(({ id, ...rest }) => rest);
    assert.deepEqual(normalize(imported.data[key]), normalize(packageValue.data[key]), key + ' roundtrip');
  }
  const history = await target.api('/api/dimension/bots/' + importedId + '/history?mode=work&limit=2');
  assert.equal(history.messages.length, 2); assert.equal(history.hasMore, true); assert(history.messages.every(row => row.archived && row.kind === 'archive'));
  const older = await target.api('/api/dimension/bots/' + importedId + '/history?mode=work&limit=2&before=' + history.before);
  assert.equal(older.messages.length, 2); assert.equal(older.hasMore, false);
  assert.deepEqual([...older.messages, ...history.messages].map(row => row.text), workTexts);
  assert.deepEqual((await target.api('/api/dimension/work/sessions?botId=' + importedId)).runs, []);
  pass('Full content import preserves private data and actual Work text with read-only cursor pagination; it creates no runnable Work task');

  const changedSelection = await stage(target, packageValue, ['name']); assert(changedSelection.report.canCommit && changedSelection.report.target.newCopy);
  assert.notEqual(changedSelection.report.target.id, importedId); const second = await commit(target, changedSelection); await discard(target, changedSelection.token);
  const changedPackage = await stage(target, anonymous.package, contentFields); assert(changedPackage.report.canCommit && changedPackage.report.target.newCopy);
  assert.notEqual(changedPackage.report.target.id, importedId); await discard(target, changedPackage.token);
  const reordered = await stage(target, packageValue, [...contentFields].reverse());
  assert.equal(reordered.report.target.id, importedId); assert.equal(reordered.report.target.isNew, false);
  assert((await commit(target, reordered)).idempotent); await discard(target, reordered.token);
  assert.notEqual(second.bot.id, profile.bot.id);
  pass('A different selection or package gets a distinct new target, while equivalent selection order and exact replay reuse only the matching imported Bot');

  await target.api('/api/dimension/bots/' + importedId + '/profile', { persona: 'LOCAL_EDIT_AFTER_IMPORT' }, 'PATCH');
  const memory = await target.api('/api/dimension/memory?botId=' + importedId);
  const removed = memory.entries.find(row => row.text === body('PRIVATE_CONFIRMED')); assert(removed);
  await target.api('/api/dimension/memory', { action: 'save-entries', botId: importedId, entries: [{ id: removed.id, revision: removed.revision, text: '' }] });
  await target.api('/api/dimension/memory', { action: 'save-relations', botId: importedId, values: { 'user-profile': '', 'user-relationship': '', contacts: '', 'external-bots': '' }, baseRevision: memory.overview.relationRevision });
  assert.equal(memory.mid.length, 1);
  await target.api('/api/dimension/memory', { action: 'save-mid', botId: importedId, mid: [{ id: memory.mid[0].id, revision: memory.mid[0].revision, text: '' }] });
  await binary(target, '/api/dimension/bots/' + importedId + '/avatar', { method: 'DELETE' });
  const deleted = await snapshot(config, target, 'user-deletions');
  await target.stop(); target = await launch(config, 'target-restart', 'target');
  const durable = await stage(target, packageValue, contentFields); assert.equal(durable.report.target.id, importedId); assert(durable.report.canCommit);
  assert.equal(durable.report.importCounts.memoriesTombstoned, 2); assert.equal(durable.report.importCounts.midMemoriesTombstoned, 1);
  assert((await commit(target, durable)).idempotent); await discard(target, durable.token);
  await unchanged(config, target, deleted, 'restart-replay-preserves-tombstones-and-edits');
  await binary(target, '/api/dimension/bots/' + importedId + '/avatar', { expected: 404 });
  assert.equal((await exportBot(target, importedId, ['persona'])).package.data.persona, 'LOCAL_EDIT_AFTER_IMPORT');
  pass('After real native restart exact replay preserves profile edits and tombstones for long-term memory, relationships, mid-term memory and deleted avatar');

  const largeAvatar = largePng(); await binary(source, '/api/dimension/bots/' + owner + '/avatar', { method: 'POST', body: largeAvatar, mime: 'image/png' });
  const large = await exportBot(source, owner, ['avatar']); assert(large.bytes > 4 * 1024 * 1024 && large.bytes < capabilities.maxPackageBytes);
  await writeFile(path.join(config.output, 'large-avatar-bot.json'), large.text);
  const largePreview = await stage(target, large.package, ['avatar']); assert(largePreview.report.canCommit);
  const largeResult = await commit(target, largePreview); await discard(target, largePreview.token);
  const returnedImage = await binary(target, '/api/dimension/bots/' + largeResult.bot.id + '/avatar');
  assert.equal(digest(returnedImage.bytes), digest(largeAvatar));
  exports.push({ fields: ['avatar'], bytes: large.bytes, sha256: digest(large.text), imageBytes: largeAvatar.length, counts: large.package.counts });
  const oversizedOrdinary = '{"padding":"' + 'x'.repeat(4 * 1024 * 1024) + '"}';
  assert.equal((await target.response(route + '/commit', oversizedOrdinary, 'POST')).status, 413);
  pass('A valid decoded 1024×1024 PNG produces a package larger than 4 MiB, stages through the dedicated 16 MiB route, and restores byte-for-byte; ordinary routes retain 4 MiB limit');

  before = await snapshot(config, target, 'before-capacity');
  const stages = [];
  for (let i = 0; i < capabilities.maxStages; ++i) stages.push(await stage(target, packageValue, []));
  await target.api(route + '/stage', { package: packageValue, fields: [], preserveId: false }, 'POST', 429);
  for (const item of stages) await discard(target, item.token);
  await unchanged(config, target, before, 'capacity-and-discard-no-write');
  assert.deepEqual(fixture.errors, []);
  for (const entry of config.processes) for (const secret of [prefix, 'SYNTH_EXPORT_BODY_', 'synthetic-key']) assert(!entry.stdout.includes(secret) && !entry.stderr.includes(secret));
  pass('Staging capacity is enforced and released by cancellation; native logs contain no private synthetic record bodies or credentials');
} catch (error) { failures.push(error.stack); console.error(error.stack); }
finally {
  await cleanup(config, failures);
  await fixture?.close().catch(error => failures.push(error.stack));
  await report(config, checks, failures, { exports, modelRequests: (fixture?.records || []).map(row => ({ tag: row.tag, work: row.work, model: row.body.model, requestSha256: digest(canonical(row.body)) })), fixtureErrors: fixture?.errors || [] });
}

