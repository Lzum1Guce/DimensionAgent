import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const runtime = process.argv[3] || path.join(project, 'runtime');
const output = process.argv[2] || path.join(project, 'outputs', 'harness-protocol-tests');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(output, 'profile-'));
await mkdir(path.join(profile, '.codex'));
await writeFile(path.join(profile, '.codex', 'config.toml'), [
  '[mcp_servers.disabled_fixture]', 'enabled = false # explicitly disabled',
  'command = "node"', '[mcp_servers.missing_fixture]', 'command = "node"',
  'args = [' + JSON.stringify(path.join(profile, 'absent.mjs')) + ']', '',
].join('\n'));

function invoke(input) {
  const result = spawnSync(process.execPath, [path.join(runtime, 'cross-harness-mcp.mjs'), '--oneshot'], {
    cwd: profile, env: { ...process.env, HOME: profile, USERPROFILE: profile, LOCALAPPDATA: profile, APPDATA: profile },
    input, encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^[^\r\n]+\n$/);
  return JSON.parse(result.stdout);
}

const catalog = invoke(JSON.stringify({ op: 'arsenal.list' }));
assert.equal(catalog.ok, true);
assert.equal(catalog.mcpServers.some(row => row.serverName === 'disabled_fixture'), false);
assert.match(catalog.mcpServers.find(row => row.serverName === 'missing_fixture').configurationError, /absent\.mjs/);
assert.equal(invoke(JSON.stringify({ op: 'mcp.call', serverName: 'disabled_fixture', action: 'list_tools' })).ok, false);
assert.equal(invoke('{').ok, false);
console.log('PASS worker framing, disabled discovery and invocation, missing script diagnosis');
