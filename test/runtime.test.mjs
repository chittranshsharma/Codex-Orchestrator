import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Runtime, createRun, resumeRun } from '../dist/runtime.js';
import { defaultConfig, loadConfig } from '../dist/config.js';
import { git, applyPatch } from '../dist/git.js';
import { Store, hash, inside, runPath } from '../dist/storage.js';
import { renderDashboard, clean } from '../dist/dashboard.js';
import { demoState } from '../dist/demo.js';

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cwf-test-'));
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cwf-test-'));
  t.after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const repo = join(root, 'repo'); await mkdir(repo); await git(repo, ['init', '--quiet']);
  await git(repo, ['config', 'core.autocrlf', 'false']);
  await writeFile(join(repo, 'value.txt'), 'original\n'); await git(repo, ['add', '.']);
  await git(repo, ['-c', 'user.name=Workflow Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixture']);
  return { root, repo, config: { ...structuredClone(defaultConfig), readRetries: 0, ...overrides } };
}
const moduleOf = body => `export const meta={name:'test',description:'Runtime verification fixture'};export default async function(api){const {agent,pipeline,phase,parallel,args,acceptPatch,repeat}=api;${body}}`;
function provider(run = async request => `result:${request.options.id}`) {
  const calls = [];
  return { calls, async run(request) {
    calls.push({ id: request.options.id, model: request.profile.model, cwd: request.cwd });
    const result = await run(request);
    await request.emit({ type: 'thread.started', thread_id: `test-${request.options.id}` });
    const usage = { input_tokens: 10, cached_input_tokens: 3, output_tokens: 2 };
    await request.emit({ type: 'turn.completed', usage }); return { result, usage };
  } };
}
async function setup(t, body, overrides) {
  const f = await fixture(t, overrides);
  const store = await createRun(join(f.root, 'state'), f.repo, moduleOf(body), {}, f.config);
  return { ...f, store };
}

test('parallel jobs respect concurrency, route models, persist outputs and count tokens', async t => {
  const { store } = await setup(t, `phase('scan');const scans=await pipeline([0,1,2,3,4],i=>agent('inspect '+i,{id:'scan-'+i,role:'scan'}));phase('verify');return agent(JSON.stringify(scans),{id:'verify',role:'verify'});`, { concurrency: 2 });
  let active = 0, maximum = 0;
  const p = provider(async request => { active++; maximum = Math.max(maximum, active); await delay(15); active--; return request.options.id; });
  await new Runtime(store, p).run();
  assert.equal(maximum, 2); assert.equal(p.calls.length, 6);
  assert.equal(p.calls[0].model, defaultConfig.roles.scan.model);
  assert.equal(p.calls.at(-1).model, defaultConfig.roles.verify.model);
  assert.equal(store.state.status, 'completed'); assert.equal(store.state.tasks['scan-0'].usage.input_tokens, 10);
});

test('Jev routes jobs, protects verifier tier and reuses saved decisions on resume', async t => {
  const jev = { ...structuredClone(defaultConfig.jev), enabled: true };
  const { root, store } = await setup(t, `const d=await api.decide({task:'choose'},{id:'branch',instructions:'Choose next step',choices:{run:'Inspect',stop:'Stop'},fallback:'stop'});await agent('inspect',{id:'scan',role:'scan'});return agent('check',{id:'verify',role:'verify'});`, { jev });
  let decisions = 0;
  const judge = async (_state, options) => { decisions++; return { choice: options.id === 'branch' ? 'run' : 'fast', confidence: 0.95,
    probabilities: {}, model: 'jev-test', fallback: false, usage: { input_tokens: 1, output_tokens: 1 } }; };
  const first = provider(async r => { if (r.options.id === 'verify') throw Error('offline'); return 'ok'; });
  await assert.rejects(new Runtime(store, first, judge).run(), /offline/);
  assert.equal(first.calls[0].model, jev.profiles.fast.model);
  assert.equal(first.calls[1].model, jev.profiles.standard.model);
  const reloaded = await resumeRun(join(root, 'state'), store.state.id);
  await new Runtime(reloaded, provider(), async () => { throw Error('cached decisions must be reused'); }).run();
  assert.equal(decisions, 3); assert.equal(reloaded.state.status, 'completed');
});

test('partial fan-out returns null visibly; resume reuses the prefix and reruns the suffix', async t => {
  const { root, store } = await setup(t, `return pipeline([0,1,2],i=>agent('job '+i,{id:'job-'+i,role:'scan'}));`);
  const first = provider(async request => { if (request.options.id === 'job-1') throw new Error('intentional failure'); return request.options.id; });
  await new Runtime(store, first).run();
  assert.equal(store.state.status, 'partial'); assert.equal(store.state.result[1], null); assert.ok(store.state.failures.length);
  const reloaded = await resumeRun(join(root, 'state'), store.state.id); const second = provider();
  await new Runtime(reloaded, second).run();
  assert.deepEqual(second.calls.map(call => call.id).sort(), ['job-1', 'job-2']); assert.equal(reloaded.state.status, 'completed');
});

test('resume invalidates downstream summaries when failed jobs return new results', async t => {
  const { root, store } = await setup(t, `const data=await pipeline([0,1],i=>agent('job '+i,{id:'job-'+i,role:'scan'}));return agent(JSON.stringify(data),{id:'summary',role:'review'});`);
  await new Runtime(store, provider(async request => { if (request.options.id === 'job-1') throw new Error('offline'); return request.prompt; })).run();
  assert.equal(store.state.status, 'partial'); assert.ok(store.state.tasks.summary.result.includes('null'));
  const reloaded = await resumeRun(join(root, 'state'), store.state.id);
  const second = provider(async request => request.options.id === 'summary' ? request.prompt : 'new evidence');
  await new Runtime(reloaded, second).run();
  assert.deepEqual(second.calls.map(call => call.id), ['job-1', 'summary']);
  assert.ok(!reloaded.state.result.includes('null')); assert.ok(reloaded.state.result.includes('new evidence'));
});

test('callback errors and schema failures cannot silently become clean results', async t => {
  const { store } = await setup(t, `return pipeline([0,1],i=>{if(i===0)throw Error('callback failed');return agent('json',{id:'json',role:'scan',schema:{type:'object',required:['ok'],properties:{ok:{type:'boolean'}}}});});`);
  await new Runtime(store, provider(async () => ({ nope: true }))).run();
  assert.equal(store.state.status, 'partial'); assert.equal(store.state.failures.length, 2);
  assert.match(store.state.tasks.json.error, /schema validation/);
});

test('resume rejects changed repository and tampered workflow before any model work', async t => {
  const { root, repo, store } = await setup(t, `return agent('job',{id:'job',role:'scan'});`);
  await new Runtime(store, provider()).run();
  await writeFile(join(repo, 'value.txt'), 'changed\n');
  const reloaded = await resumeRun(join(root, 'state'), store.state.id); const p = provider();
  await assert.rejects(new Runtime(reloaded, p).run(), /Repository changed/); assert.equal(p.calls.length, 0);
  await writeFile(join(repo, 'value.txt'), 'original\n');
  await writeFile(join(store.directory, 'workflow.mjs'), moduleOf('return 1'));
  await assert.rejects(new Runtime(reloaded, p).run(), /Saved workflow changed/);
});

test('a source change during a run prevents a misleading successful audit', async t => {
  const { repo, store } = await setup(t, `return agent('read',{id:'read',role:'scan'});`);
  const p = provider(async () => { await writeFile(join(repo, 'value.txt'), 'external user edit\n'); return 'old findings'; });
  await assert.rejects(new Runtime(store, p).run(), /changed while/); assert.equal(store.state.status, 'failed');
  assert.equal(store.state.tasks.read.status, 'completed');
});

test('duplicate IDs and job caps fail visibly without launching extra agents', async t => {
  const { store } = await setup(t, `await agent('first',{id:'same',role:'scan'});return agent('second',{id:'same',role:'scan'});`, { maxAgents: 1 });
  const p = provider(); await assert.rejects(new Runtime(store, p).run(), /Duplicate agent/); assert.equal(p.calls.length, 1);
  const { store: capped } = await setup(t, `return pipeline([0,1],i=>agent('job '+i,{id:'job-'+i,role:'scan'}));`, { maxAgents: 1 });
  await new Runtime(capped, provider()).run(); assert.equal(Object.keys(capped.state.tasks).length, 1); assert.equal(capped.state.status, 'partial');
});

test('run lock excludes another process owner and cannot be stolen', async t => {
  const { store } = await setup(t, 'return null;'); await store.lock();
  const other = new Store(store.directory, store.state);
  await assert.rejects(other.lock(), /already active/); await store.close(); await other.lock(); await other.close();
});

test('stopping cancels queued and active work, then releases the lock for resume', async t => {
  const { root, store } = await setup(t, `return pipeline([0,1,2],i=>agent('job '+i,{id:'job-'+i,role:'scan'}));`, { concurrency: 1 });
  const p = provider(async request => { await delay(20_000, undefined, { signal: request.signal }); return 'done'; });
  const runtime = new Runtime(store, p); const run = runtime.run();
  await new Promise(resolve => runtime.once('event', event => resolve(event)));
  // Wait for an actual running job so this tests cancellation of an SDK-equivalent operation.
  while (!Object.values(store.state.tasks).some(task => task.status === 'running')) await delay(5);
  runtime.stop(); await assert.rejects(run); assert.equal(store.state.status, 'paused'); assert.equal(p.calls.length, 1);
  const resumed = await resumeRun(join(root, 'state'), store.state.id); await new Runtime(resumed, provider()).run();
  assert.equal(resumed.state.status, 'completed');
});

test('pause lets current work finish while holding queued work until resume', async t => {
  const { store } = await setup(t, `return pipeline([0,1,2],i=>agent('job '+i,{id:'job-'+i,role:'scan'}));`, { concurrency: 1 });
  const p = provider(async () => { await delay(40); return 'done'; }); const runtime = new Runtime(store, p);
  runtime.on('event', event => { if (event.type === 'agent.started' && event.id === 'job-0') runtime.pause(); });
  const run = runtime.run(); while (store.state.tasks['job-0']?.status !== 'completed') await delay(5);
  assert.equal(p.calls.length, 1); runtime.resume(); await run; assert.equal(p.calls.length, 3);
});

test('edits are isolated and apply requires passing independent verification', async t => {
  const { repo, store } = await setup(t, `await agent('edit',{id:'edit',role:'edit'});await agent('verify',{id:'verify',role:'verify',workspace:'edit',schema:{type:'object',required:['passed'],properties:{passed:{type:'boolean'}}}});await acceptPatch('edit','verify');return 'ready';`);
  const p = provider(async request => {
    if (request.options.role === 'edit') { await writeFile(join(request.cwd, 'value.txt'), 'fixed\n'); await writeFile(join(request.cwd, 'new.txt'), 'new file\n'); return 'patched'; }
    assert.equal(await readFile(join(request.cwd, 'value.txt'), 'utf8'), 'fixed\n'); return { passed: true };
  });
  await new Runtime(store, p).run();
  assert.equal(await readFile(join(repo, 'value.txt'), 'utf8'), 'original\n'); assert.notEqual(p.calls[0].cwd, repo);
  assert.equal(p.calls[1].cwd, p.calls[0].cwd); assert.equal(store.state.tasks.edit.verifiedBy, 'verify');
  await store.lock(); try { await applyPatch(store, 'edit'); } finally { await store.close(); }
  assert.equal(await readFile(join(repo, 'value.txt'), 'utf8'), 'fixed\n'); assert.equal(await readFile(join(repo, 'new.txt'), 'utf8'), 'new file\n');
  await assert.rejects(applyPatch(store, 'edit'), /already been applied/);
});

test('unverified, tampered and conflicting patches do not change the main checkout', async t => {
  const { repo, store } = await setup(t, `return agent('edit',{id:'edit',role:'edit'});`);
  await new Runtime(store, provider(async request => { await writeFile(join(request.cwd, 'value.txt'), 'fixed\n'); return 'edited'; })).run();
  await assert.rejects(applyPatch(store, 'edit'), /independent verifier/);
  // An invalid truthy value must not pass the verification gate.
  store.state.tasks.fake = { ...store.state.tasks.edit, id: 'fake', role: 'verify', result: { passed: 'yes' } };
  store.state.tasks.edit.verifiedBy = 'fake'; await assert.rejects(applyPatch(store, 'edit'), /independent verifier/);
  store.state.tasks.fake.result = { passed: true };
  await writeFile(join(store.directory, 'edit.patch'), 'tampered'); await assert.rejects(applyPatch(store, 'edit'), /Patch changed/);
  assert.equal(await readFile(join(repo, 'value.txt'), 'utf8'), 'original\n');
});

test('a conflicting patch is rejected atomically without overwriting user edits', async t => {
  const { repo, store } = await setup(t, `await agent('edit',{id:'edit',role:'edit'});await agent('verify',{id:'verify',role:'verify',workspace:'edit'});await acceptPatch('edit','verify');`);
  await new Runtime(store, provider(async request => {
    if (request.options.role === 'edit') { await writeFile(join(request.cwd, 'value.txt'), 'fixed\n'); return 'edited'; }
    return { passed: true };
  })).run();
  await writeFile(join(repo, 'value.txt'), 'user edit\n');
  await assert.rejects(applyPatch(store, 'edit'), /patch does not apply|patch failed/);
  assert.equal(await readFile(join(repo, 'value.txt'), 'utf8'), 'user edit\n');
});

test('read-only transient failures retry once; edits never automatically retry', async t => {
  const { store } = await setup(t, `return agent('scan',{id:'scan',role:'scan'});`, { readRetries: 1 });
  let calls = 0;
  await new Runtime(store, provider(async () => { if (++calls === 1) throw new Error('503 network unavailable'); return 'ok'; })).run();
  assert.equal(calls, 2); assert.equal(store.state.tasks.scan.attempts, 2);
  const { store: edited } = await setup(t, `return agent('edit',{id:'edit',role:'edit'});`, { readRetries: 1 });
  const editProvider = provider(async () => { throw new Error('503 network unavailable'); });
  await assert.rejects(new Runtime(edited, editProvider).run(), /503/); assert.equal(editProvider.calls.length, 1);
});

test('edit jobs refuse dirty source trees', async t => {
  const { repo, store } = await setup(t, `return agent('edit',{id:'edit',role:'edit'});`);
  await writeFile(join(repo, 'value.txt'), 'user work\n');
  // Capture the dirty state as a new run, then exercise the separate edit guard.
  const newStore = await createRun(join(store.directory, 'other-state'), repo, moduleOf(`return agent('edit',{id:'edit',role:'edit'});`), {}, store.state.config);
  const p = provider(); await assert.rejects(new Runtime(newStore, p).run(), /clean Git working tree/); assert.equal(p.calls.length, 0);
  assert.equal(await readFile(join(repo, 'value.txt'), 'utf8'), 'user work\n');
});

test('no-progress loop stops after two unchanged rounds; successful loop stops immediately', async t => {
  const { store } = await setup(t, `let count=0;const result=await repeat({maxRounds:8,noProgressRounds:2},async()=>({done:false,progressKey:'same',result:++count}));return {count,...result};`);
  await new Runtime(store, provider()).run(); assert.deepEqual(store.state.result, { count: 3, stopped: 'no-progress', result: 3 });
});

test('schema and path boundaries reject invalid configuration and traversal', async t => {
  const { repo } = await fixture(t);
  await writeFile(join(repo, '.codex-workflow.json'), JSON.stringify({ concurrency: 0 }));
  await assert.rejects(loadConfig(repo), /Invalid workflow config/);
  for (const path of ['../escape', '/escape', 'C:\\escape']) {
    if (process.platform === 'win32' || path !== 'C:\\escape') assert.throws(() => inside(repo, path), /inside/);
  }
  assert.throws(() => runPath(repo, '../run'), /Invalid run ID/);
});

test('reserved object keys cannot be used as job IDs', async t => {
  const { store } = await setup(t, `return agent('job',{id:'__proto__',role:'scan'});`);
  const p = provider(); await assert.rejects(new Runtime(store, p).run(), /prototype keys/);
  assert.equal(p.calls.length, 0); assert.equal(Object.keys(store.state.tasks).length, 0);
});

test('dashboard stays within terminal dimensions and strips terminal control input', () => {
  for (const [width, height] of [[40, 16], [80, 24], [110, 42]]) {
    const state = demoState(defaultConfig); state.name = '\x1b[2JInjected\x07';
    const screen = renderDashboard(state, { width, height, demo: true });
    const lines = screen.split('\n'); assert.ok(lines.length <= height);
    for (const line of lines) assert.ok(clean(line).length <= width, `Overflow at ${width}: ${clean(line)}`);
    assert.match(clean(lines.at(-1)), /pause/); assert.ok(!screen.includes('\x07'));
  }
});
