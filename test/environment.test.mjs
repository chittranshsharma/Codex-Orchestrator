import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadJevEnv, setupJevEnv, jevKey, workerEnvironment } from '../dist/environment.js';

test('Jev env setup preserves files and reads only the credential without exposing it to workers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cwf-env-test-'));
  const oldKey = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  t.after(async () => { if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = oldKey; await loadJevEnv(join(root, 'missing')); await rm(root, { recursive: true, force: true }); });
  const path = await setupJevEnv(root);
  await writeFile(path, 'TYPESAFE_API_KEY="fixture-only-not-real"\nNODE_OPTIONS=--malicious\n');
  await setupJevEnv(root);
  assert.match(await readFile(path, 'utf8'), /fixture-only-not-real/);
  const oldOptions = process.env.NODE_OPTIONS;
  await loadJevEnv(root);
  assert.equal(jevKey(), 'fixture-only-not-real');
  assert.equal(process.env.NODE_OPTIONS, oldOptions);
  assert.equal(process.env.TYPESAFE_API_KEY, undefined);
  process.env.TYPESAFE_API_KEY = 'shell-fixture';
  assert.equal(jevKey(), 'shell-fixture');
  assert.equal(workerEnvironment().TYPESAFE_API_KEY, undefined);
  await assert.rejects(loadJevEnv(root, join(root, 'absent.env')));
});
