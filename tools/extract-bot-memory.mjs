// One-time data adapter. Reads declarative user files only; no old runtime code.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PERSONA = ['SELF.md','PERSONALITY.md','PREFERENCES.md','SPEECH.md','CRAFT.md','CONSTITUTION.md','PARTNER.md'];
const JOURNALS = new Set(['candidates.jsonl','mid.entries.jsonl','mid.jsonl','mid.pending.jsonl','mid.archive.jsonl','deep.jsonl','deep.archive.jsonl']);
const EXCLUDED = ['conversation-history','groups','attachments','avatars','work-runs','accounts','plugins','application-settings','runtime-code'];
const LIMIT = { file: 1024 * 1024, total: 32 * 1024 * 1024, files: 20000, bots: 2048, memories: 10000, package: 4 * 1024 * 1024 - 16384, perPackage: 128 };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const byteSize = text => Buffer.byteLength(text, 'utf8');
const fail = code => { const e = new Error(code); e.code = code; throw e; };
const safeId = id => typeof id === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(id);
const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, sort(value[k])]));
  return value;
}
function decode(bytes) {
  try {
    // A leading UTF-8 BOM is a transport marker; original bytes stay in snapshot.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { fail('INVALID_UTF8'); }
}
export function strictJson(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { fail('INVALID_JSON'); }
  // JSON.parse accepts duplicate members. Scan structure separately before using it.
  let at = 0;
  const ws = () => { while (/\s/.test(text[at] ?? '') && at < text.length) at++; };
  const string = () => {
    const start = at++;
    while (at < text.length) {
      if (text[at] === '\\') { at += 2; continue; }
      if (text[at++] === '"') {
        const value = JSON.parse(text.slice(start, at));
        if (!value.isWellFormed()) fail('INVALID_UNICODE');
        return value;
      }
    }
    fail('INVALID_JSON');
  };
  const walk = depth => {
    if (depth > 64) fail('JSON_DEPTH');
    ws();
    if (text[at] === '{') {
      at++; ws(); const seen = new Set();
      if (text[at] === '}') { at++; return; }
      while (true) {
        ws(); const key = string();
        if (seen.has(key)) fail('DUPLICATE_JSON_KEY');
        seen.add(key); ws(); at++; walk(depth + 1); ws();
        if (text[at++] === '}') return;
      }
    } else if (text[at] === '[') {
      at++; ws(); if (text[at] === ']') { at++; return; }
      while (true) { walk(depth + 1); ws(); if (text[at++] === ']') return; }
    } else if (text[at] === '"') string();
    else while (at < text.length && !/[\s,\]}]/.test(text[at])) at++;
  };
  walk(0);
  return parsed;
}
async function noLinks(input, allowMissingLeaf = false) {
  const full = path.resolve(input);
  if (!path.isAbsolute(input) || full.startsWith('\\\\')) fail('ABSOLUTE_LOCAL_PATH_REQUIRED');
  const parts = full.slice(path.parse(full).root.length).split(path.sep).filter(Boolean);
  let item = path.parse(full).root;
  for (let i = 0; i < parts.length; i++) {
    item = path.join(item, parts[i]);
    let st;
    try { st = await fs.lstat(item); }
    catch (e) { if (e.code === 'ENOENT' && allowMissingLeaf && i === parts.length - 1) return full; throw e; }
    if (st.isSymbolicLink()) fail('REPARSE_PATH');
    if (i !== parts.length - 1 && !st.isDirectory()) fail('NOT_DIRECTORY');
  }
  return full;
}
async function regularRead(file) {
  await noLinks(file);
  const handle = await fs.open(file, 'r');
  try {
    const st = await handle.stat();
    if (!st.isFile()) fail('NOT_REGULAR_FILE');
    if (st.size > LIMIT.file) fail('FILE_LIMIT');
    // Bounded read even if a producer grows the file after stat.
    const bytes = Buffer.alloc(LIMIT.file + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > LIMIT.file) fail('FILE_LIMIT');
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}
async function listInput(characters) {
  const files = [], bots = [];
  const add = relative => { files.push(relative.replaceAll(path.sep, '/')); };
  const entries = (await fs.readdir(characters, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name, 'en'));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) fail('REPARSE_PATH');
    if (!entry.isDirectory()) continue;
    if (!safeId(entry.name)) fail('INVALID_BOT_DIRECTORY');
    const bot = entry.name, base = path.join(characters, bot);
    bots.push(bot); add(path.join(bot, 'character.json'));
    for (const name of PERSONA) {
      const relative = path.join(bot, 'workspace', name);
      try { await fs.lstat(path.join(characters, relative)); add(relative); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    const notes = path.join(base, 'workspace', 'notes');
    let noteEntries;
    try { await noLinks(notes); noteEntries = await fs.readdir(notes, { withFileTypes: true }); }
    catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    for (const n of noteEntries) {
      if (n.isSymbolicLink()) fail('REPARSE_PATH');
      if (n.isFile() && (n.name.endsWith('.md') || JOURNALS.has(n.name))) {
        add(path.join(bot, 'workspace', 'notes', n.name));
      } else if (n.isDirectory() && ['mid-entries','mid-pending'].includes(n.name)) {
        const dir = path.join(notes, n.name); await noLinks(dir);
        for (const row of await fs.readdir(dir, { withFileTypes: true })) {
          if (row.isSymbolicLink() || !row.isFile() || !/^[a-zA-Z0-9_-]+\.json$/.test(row.name)) fail('UNSUPPORTED_MEMORY_ENTRY');
          add(path.join(bot, 'workspace', 'notes', n.name, row.name));
        }
      } else if (n.isFile() && n.name === 'state.json') {
        // Affect/reply-appetite is runtime state, not a saved memory.
      } else {
        fail('UNSUPPORTED_NOTE_FILE');
      }
    }
  }
  if (!bots.length || bots.length > LIMIT.bots || files.length > LIMIT.files) fail('SOURCE_LIMIT');
  files.sort();
  return { bots, files };
}
function nonemptyString(value, code) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) fail(code);
  return value;
}
function stateFor(record, family, filename) {
  const status = record.status;
  if (['rejected','archived','superseded','deleted'].includes(status)) return 'rejected';
  if (family === 'mid') {
    if (!['active','candidate','pending','confirmed'].includes(status)) fail('UNKNOWN_MEMORY_STATE');
    // Native memory has no TTL. Preserve temporary entries without making them permanent facts.
    return 'candidate';
  }
  if (record.expiresAt !== undefined) {
    if (typeof record.expiresAt !== 'string' || !Number.isFinite(Date.parse(record.expiresAt))) fail('INVALID_MEMORY_EXPIRY');
    if (!['active','candidate','pending','confirmed','accepted'].includes(status)) fail('UNKNOWN_MEMORY_STATE');
    return 'candidate';
  }
  if (['candidate','pending'].includes(status) || (status === undefined && filename === 'candidates.jsonl')) return 'candidate';
  if (['confirmed','accepted','active'].includes(status)) return 'confirmed';
  fail('UNKNOWN_MEMORY_STATE');
}
function archive(bots, memories) {
  return {
    format: 'dimension-conversation-archive', version: 1, coverage: 'conversation-data-only',
    excludedTypes: ['work-runs','tool-receipts','message-receipts','artifacts','plugins','accounts','provider-settings','group-metadata'],
    bots, conversations: [], memories
  };
}
function isMisplacedCharacterProfile(text, name) {
  const lines = text.replaceAll('\r\n', '\n').trim().split('\n').filter(line => line.trim());
  return lines.length >= 4 && lines[0] === '# ' + name &&
    lines.slice(1).every(line => /^- (日文名|英文名|出处|角色库热度排名)[：:]/.test(line)) &&
    ['日文名','出处','角色库热度排名'].every(label => lines.some(line => line.startsWith('- ' + label + '：') || line.startsWith('- ' + label + ':')));
}
function normalize(source, roster) {
  if (!roster || Object.keys(roster).sort().join(',') !== 'chatBots,version,workBots' || roster.version !== 1) fail('INVALID_ROSTER');
  for (const key of ['chatBots','workBots']) {
    if (!Array.isArray(roster[key]) || roster[key].some(id => !safeId(id)) || new Set(roster[key]).size !== roster[key].length) fail('INVALID_ROSTER');
  }
  const known = new Set(source.bots);
  const dangling = [...new Set([...roster.chatBots, ...roster.workBots])].filter(id => !known.has(id)).sort();
  const bots = [], memories = [], sourceRecords = [], ids = new Set();
  const counts = { confirmed: 0, candidate: 0, rejected: 0, mirrorCopiesDeduplicated: 0, temporaryMemoriesHeldForReview: 0, emptyFiles: 0, characterProfilesMovedToPersona: 0, relationNotes: 0 };
  const read = relative => source.bytes.has(relative) ? decode(source.bytes.get(relative)) : null;
  const addMemory = (bot, key, text, state, locators) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.includes('\0') || byteSize(trimmed) > 262144) fail('MEMORY_TEXT_LIMIT');
    const id = (BigInt('0x' + hash(bot + '\0' + key).slice(0, 15)) + 1n).toString();
    if (ids.has(id)) fail('MEMORY_ID_COLLISION');
    ids.add(id);
    memories.push({ id, botId: bot, groupId: '', text: trimmed, state, revision: '1', sourceActor: 'user' });
    sourceRecords.push({ id, botId: bot, sourceKey: key, files: locators, state });
    counts[state]++;
  };
  for (const id of source.bots) {
    const metadata = strictJson(read(id + '/character.json'));
    if (!metadata || Array.isArray(metadata) || metadata.id !== id || metadata.version !== 1) fail('INVALID_CHARACTER');
    const allowed = new Set(['version','id','name','role','createdAt','updatedAt','program','architecture','affectExpression']);
    if (Object.keys(metadata).some(key => !allowed.has(key))) fail('UNSUPPORTED_CHARACTER_FIELD');
    const name = nonemptyString(metadata.name, 'INVALID_CHARACTER_NAME').trim();
    const role = nonemptyString(metadata.role, 'INVALID_CHARACTER_ROLE');
    if (byteSize(name) > 1024) fail('CHARACTER_NAME_LIMIT');
    const sections = ['【角色设定】\n' + role];
    if (metadata.affectExpression !== undefined)
      sections.push('【情绪表达偏好】\n' + nonemptyString(metadata.affectExpression, 'INVALID_AFFECT_EXPRESSION'));
    for (const filename of PERSONA) {
      if (filename === 'PARTNER.md') continue; // About the user relationship, never the Bot's own identity.
      const content = read(id + '/workspace/' + filename);
      if (content === null) continue;
      if (content.trim()) sections.push('【' + filename + '】\n' + content);
      else counts.emptyFiles++;
    }
    const profileFile = id + '/workspace/notes/profile.md';
    const misplacedProfile = read(profileFile);
    const moveProfile = misplacedProfile !== null && isMisplacedCharacterProfile(misplacedProfile, name);
    if (moveProfile) {
      sections.push('【角色资料】\n' + misplacedProfile);
      counts.characterProfilesMovedToPersona++;
    }
    const persona = sections.join('\n\n');
    if (persona.includes('\0') || byteSize(persona) > 262144) fail('PERSONA_LIMIT');
    bots.push({ id, name, persona, inChat: roster.chatBots.includes(id), inWork: roster.workBots.includes(id) });
    const partnerFile = id + '/workspace/PARTNER.md';
    const partner = read(partnerFile);
    if (partner?.trim()) {
      addMemory(id, 'relation/user-relationship', '@dimension-note/v1/user-relationship\n' + partner.trim(), 'confirmed', [partnerFile]);
      counts.relationNotes++;
    }
    const memoryRecords = new Map();
    for (const file of source.files.filter(f => f.startsWith(id + '/workspace/notes/'))) {
      const local = file.slice((id + '/workspace/notes/').length);
      const text = read(file);
      if (!text.trim()) { counts.emptyFiles++; continue; }
      if (local.endsWith('.md')) {
        if (local === 'profile.md' && moveProfile) continue;
        const relation = { 'profile.md': 'user-profile', 'people.md': 'contacts', 'bots.md': 'external-bots' }[local];
        if (relation) {
          addMemory(id, 'relation/' + relation, '@dimension-note/v1/' + relation + '\n' + text.trim(), 'confirmed', [file]);
          counts.relationNotes++;
          continue;
        }
        const state = ['profile.md','people.md','bots.md'].includes(local) ? 'confirmed' : 'candidate';
        addMemory(id, 'note/' + local, '【旧版笔记：' + local + '】\n' + text, state, [file]);
        continue;
      }
      const rows = local.endsWith('.jsonl')
        ? text.split(/\r?\n/).filter(line => line.trim()).map(strictJson)
        : [strictJson(text)];
      const family = local.startsWith('mid') ? 'mid' : 'fact';
      for (const row of rows) {
        if (!row || Array.isArray(row) || row.characterId !== id) fail('MEMORY_OWNER_MISMATCH');
        const sourceId = nonemptyString(row.id, 'INVALID_MEMORY_ID');
        if (sourceId.length > 512 || /[\0\r\n]/.test(sourceId)) fail('INVALID_MEMORY_ID');
        if (/^mid-(entries|pending)\//.test(local) && local.slice(local.indexOf('/') + 1) !== sourceId + '.json') fail('MEMORY_FILENAME_MISMATCH');
        // v3 adds reinforcement/recall metadata; preserve original bytes and the
        // same summary/openLoops/entities without treating a TTL as permanent.
        if (family === 'mid' && ![1, 3].includes(row.schemaVersion)) fail('UNSUPPORTED_MEMORY_VERSION');
        if (family === 'fact' && row.schemaVersion !== undefined && row.schemaVersion !== 1) fail('UNSUPPORTED_MEMORY_VERSION');
        const allowedFields = new Set(family === 'mid'
          ? ['schemaVersion','id','characterId','status','summary','openLoops','entities','sourceRefs','startAt','lastActive','stabilityMs','expiresAt','recallCount','importance','compressor','contentHash','lastRecalledAt','lastReinforcedAt','reinforcementCount']
          : ['schemaVersion','id','characterId','status','kind','text','subjectId','memoryKey','source','sources','recordedAt','confidence','importance','updatedAt','accessCount','conflicts','expiresAt']);
        if (Object.keys(row).some(k => !allowedFields.has(k))) fail('UNSUPPORTED_MEMORY_FIELD');
        const key = family + '/' + sourceId;
        const normalized = canonical(row);
        const state = stateFor(row, family, local);
        let body = nonemptyString(family === 'mid' ? row.summary : row.text, 'INVALID_MEMORY_TEXT');
        if (family === 'mid') {
          for (const keyName of ['openLoops','entities']) {
            if (!Array.isArray(row[keyName]) || row[keyName].some(v => typeof v !== 'string')) fail('UNSUPPORTED_MEMORY_DETAIL');
            if (row[keyName].length) body += '\n' + (keyName === 'openLoops' ? '未完事项：' : '相关对象：') + row[keyName].join('\n');
          }
        }
        if (memoryRecords.has(key)) {
          const prev = memoryRecords.get(key);
          if (prev.normalized !== normalized) fail('MEMORY_MIRROR_CONFLICT');
          prev.files.push(file); counts.mirrorCopiesDeduplicated++; continue;
        }
        if (family === 'mid') {
          if (state === 'candidate') counts.temporaryMemoriesHeldForReview++;
        }
        memoryRecords.set(key, { normalized, files: [file], state, body });
      }
    }
    for (const [key, row] of [...memoryRecords.entries()].sort(([a],[b]) => a.localeCompare(b, 'en')))
      addMemory(id, key, '【旧版' + (key.startsWith('mid/') ? '临时记忆' : '记忆') + '：' + key.slice(key.indexOf('/') + 1) + '】\n' + row.body, row.state, row.files);
  }
  if (memories.length > LIMIT.memories) fail('MEMORY_COUNT_LIMIT');
  return { bots, memories, sourceRecords, dangling, counts };
}
export async function extractBotMemory({ characters, roster: rosterFile, output, afterRead }) {
  characters = await noLinks(characters);
  rosterFile = await noLinks(rosterFile);
  output = await noLinks(output, true);
  if (!/^[Ll]:[\\/]/.test(output)) fail('L_OUTPUT_REQUIRED');
  const relOut = path.relative(characters, output);
  if (!relOut || (!relOut.startsWith('..' + path.sep) && !path.isAbsolute(relOut))) fail('OUTPUT_INSIDE_SOURCE');
  try { await fs.lstat(output); fail('OUTPUT_EXISTS'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const listing = await listInput(characters);
  const source = { ...listing, bytes: new Map() };
  let total = 0;
  for (const file of listing.files) {
    const bytes = await regularRead(path.join(characters, file));
    total += bytes.length; if (total > LIMIT.total) fail('TOTAL_BYTE_LIMIT');
    source.bytes.set(file, bytes);
  }
  const rosterBytes = await regularRead(rosterFile);
  const normalized = normalize(source, strictJson(decode(rosterBytes)));
  const sourceId = 'legacy-' + hash(characters.replaceAll('\\','/').toLowerCase()).slice(0, 32);
  const envelopes = [];
  let partBots = [], partMemories = [];
  const make = (bots, memories) => ({ format: 'dimension-bot-memory-transfer', version: 1, sourceId, archive: archive(bots, memories) });
  for (const bot of normalized.bots) {
    const own = normalized.memories.filter(m => m.botId === bot.id);
    const nextBots = [...partBots, bot], nextMemories = [...partMemories, ...own];
    if (partBots.length && (nextBots.length > LIMIT.perPackage || byteSize(canonical(make(nextBots, nextMemories))) > LIMIT.package)) {
      envelopes.push(make(partBots, partMemories)); partBots = []; partMemories = [];
    }
    partBots.push(bot); partMemories.push(...own);
    if (byteSize(canonical(make(partBots, partMemories))) > LIMIT.package) fail('SINGLE_BOT_PACKAGE_LIMIT');
  }
  if (partBots.length) envelopes.push(make(partBots, partMemories));
  if (afterRead) await afterRead(); // Internal synthetic-test hook; never exposed as a CLI option.
  const second = await listInput(characters);
  if (canonical(second) !== canonical(listing)) fail('SOURCE_CHANGED');
  for (const file of listing.files)
    if (!source.bytes.get(file).equals(await regularRead(path.join(characters, file)))) fail('SOURCE_CHANGED');
  if (!rosterBytes.equals(await regularRead(rosterFile))) fail('SOURCE_CHANGED');
  const packageFiles = envelopes.map((e, i) => ({ path: 'packages/part-' + String(i + 1).padStart(3, '0') + '.json', bytes: Buffer.from(canonical(e), 'utf8') }));
  const manifest = {
    format: 'dimension-bot-memory-migration-manifest', version: 1, complete: true, generatedAt: new Date().toISOString(),
    sourceId, sourceCharacters: characters, sourceRoster: rosterFile,
    snapshot: 'two-pass-stable-files-not-cross-file-transaction', coverage: 'bot-personas-and-memories-only',
    excludedTypes: EXCLUDED, bots: normalized.bots.length, memories: normalized.memories.length,
    chatBots: normalized.bots.filter(b => b.inChat).length, workBots: normalized.bots.filter(b => b.inWork).length,
    danglingRosterIds: normalized.dangling, counts: normalized.counts,
    sourceFiles: listing.files.map(f => ({ path: f, bytes: source.bytes.get(f).length, sha256: hash(source.bytes.get(f)) })),
    sourceRosterSha256: hash(rosterBytes), sourceRecords: normalized.sourceRecords,
    packages: packageFiles.map(f => ({ path: f.path, bytes: f.bytes.length, sha256: hash(f.bytes) })),
    mappings: {
      relationNotes: 'PARTNER.md -> user-relationship; genuine profile.md -> user-profile; people.md -> contacts; bots.md -> external-bots; all nonempty confirmed and typed',
      misplacedProfiles: 'exact character-name + known biography template moves from profile.md to persona; never inferred user information',
      otherNotes: 'candidate', temporaryMemory: 'active/pending -> candidate; inactive -> rejected',
      factMemory: 'source status -> candidate/confirmed/rejected',
      missingNativeFields: 'revision starts at 1; sourceActor user identifies this user-requested migration, not the original author',
      scope: 'old per-character workspace remains per-Bot; group definitions/history are not reconstructed',
      originalMetadata: 'source-snapshot preserves original bytes, review/expiry/provenance fields; import text uses summary/text and openLoops/entities'
    }
  };
  // Publish the completion manifest last. A write failure never looks complete.
  await noLinks(output, true);
  await fs.mkdir(output);
  await fs.mkdir(path.join(output, 'packages'));
  await fs.mkdir(path.join(output, 'source-snapshot'));
  for (const [file, bytes] of source.bytes) {
    const target = path.join(output, 'source-snapshot', file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, { flag: 'wx' });
  }
  await fs.writeFile(path.join(output, 'source-snapshot', 'roster.json'), rosterBytes, { flag: 'wx' });
  for (const file of packageFiles) await fs.writeFile(path.join(output, file.path), file.bytes, { flag: 'wx' });
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}
async function main() {
  try {
    const args = {};
    for (let i = 2; i < process.argv.length; i += 2) {
      const key = process.argv[i];
      if (!['--characters','--roster','--output'].includes(key) || !process.argv[i + 1] || key in args) fail('INVALID_ARGUMENTS');
      args[key] = process.argv[i + 1];
    }
    if (Object.keys(args).length !== 3) fail('INVALID_ARGUMENTS');
    const m = await extractBotMemory({ characters: args['--characters'], roster: args['--roster'], output: args['--output'] });
    console.log(JSON.stringify({ ok: true, bots: m.bots, memories: m.memories, packages: m.packages.length, chatBots: m.chatBots, workBots: m.workBots, counts: m.counts, danglingRosterEntries: m.danglingRosterIds.length, output: args['--output'] }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, code: /^[A-Z_]+$/.test(e.code ?? '') ? e.code : 'EXTRACTION_FAILED' }));
    process.exitCode = 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

