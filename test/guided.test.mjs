import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reviewAndLaunch } from '../dist/guided.js';

test('guided launcher shows source and requires exact RUN before execution', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cwf-guided-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'workflow.mjs'), source = 'throw new Error("Must not execute during review");';
  await writeFile(path, source);
  let launched = 0, previewed = 0;
  for (const answer of ['', 'yes', 'run', 'RUN']) {
    const result = await reviewAndLaunch({ path, preview: s => { assert.equal(s, source); previewed++; }, confirm: async () => answer,
      launch: async s => { assert.equal(s, source); launched++; } });
    assert.equal(result, answer === 'RUN');
  }
  assert.equal(launched, 1); assert.equal(previewed, 4);
});

test('changing reviewed source blocks the guided launch', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cwf-guided-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'workflow.mjs'); await writeFile(path, 'export default 1');
  await assert.rejects(reviewAndLaunch({ path, preview() {},
    confirm: async () => { await writeFile(path, 'export default 2'); return 'RUN'; },
    launch: async () => { assert.fail('changed code must not launch'); } }), /changed during review/);
});
