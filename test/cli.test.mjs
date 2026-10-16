import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve, sep } from 'node:path';
const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/codex-workflow.mjs', import.meta.url));
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'cwf-cli-test-'));
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cwf-cli-test-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 })); return root;
}
const run = (args, cwd) => exec(process.execPath, [cli, ...args], { cwd, windowsHide: true });

test('CLI help, version, configuration creation and safe overwrite refusal work without model calls', async t => {
  const cwd = await temporary(t);
  assert.match((await run(['--help'], cwd)).stdout, /automatic role-based model routing/);
  assert.equal((await run(['--version'], cwd)).stdout.trim(), '0.6.0');
  await run(['init', '--model', 'scan=custom-model', '--concurrency', '2', '--jev'], cwd);
  const config = JSON.parse(await readFile(join(cwd, '.codex-workflow.json'), 'utf8'));
  assert.equal(config.roles.scan.model, 'custom-model'); assert.equal(config.concurrency, 2);
  assert.equal(config.jev.enabled, true);
  assert.equal(config.selectionMode, 'auto');
  await assert.rejects(run(['init'], cwd), error => error.stderr.includes('EEXIST'));
});

test('CLI validates malformed overrides and supports machine-readable empty run lists', async t => {
  const cwd = await temporary(t);
  const response = await run(['list', '--state-dir', join(cwd, 'state'), '--json'], cwd);
  assert.deepEqual(JSON.parse(response.stdout), []);
  await assert.rejects(run(['init', '--model', 'bogus=x'], cwd), error => error.stderr.includes('ROLE=MODEL'));
  await assert.rejects(run(['init', '--concurrency', '0'], cwd), error => error.stderr.includes('Invalid workflow config'));
  await assert.rejects(run(['unknown'], cwd), error => error.stderr.includes('Unknown command'));
  await assert.rejects(run(['demo', '--plain', '--json'], cwd), error => error.stderr.includes('Choose only one'));
  await assert.rejects(run(['demo', '--manual', '--auto'], cwd), error => error.stderr.includes('Choose --manual or --auto'));
  await assert.rejects(run(['demo', '--auto', '--agents-file', 'agents.json'], cwd), error => error.stderr.includes('requires manual mode'));
  await assert.rejects(run(['start', 'fix a bug'], cwd), error => error.stderr.includes('interactive terminal'));
  await assert.rejects(run(['chat'], cwd), error => error.stderr.includes('interactive terminal'));
  assert.deepEqual(JSON.parse((await run(['chats', '--state-dir', join(cwd, 'state'), '--json'], cwd)).stdout), []);
});

test('Jev setup and env-file status work without leaking credentials or calling models', async t => {
  const cwd = await temporary(t), state = join(cwd, 'state');
  assert.match((await run(['jev', 'setup', '--state-dir', state], cwd)).stdout, /jev.env/);
  const path = join(state, 'jev.env');
  await writeFile(path, 'TYPESAFE_API_KEY=fixture-not-a-real-key\n');
  const result = await run(['jev', 'status', '--env-file', path, '--state-dir', state, '--json'], cwd);
  assert.equal(JSON.parse(result.stdout).keyConfigured, true);
  assert.ok(!result.stdout.includes('fixture-not-a-real-key'));
  await run(['jev', 'setup', '--state-dir', state], cwd);
  assert.match(await readFile(path, 'utf8'), /fixture-not-a-real-key/);
});
