import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ChatSession, openChat, listChats, chatPath } from '../dist/chat.js';
import { defaultConfig } from '../dist/config.js';
import { clean, renderChatActivity, renderChatHeader, renderChatLabel, renderJevPanel } from '../dist/dashboard.js';

async function fixture(t, run) {
  const root = await mkdtemp(join(tmpdir(), 'cwf-chat-test-'));
  const sessions = [];
  t.after(async () => { for (const session of sessions) await session.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const repo = join(root, 'repo'); await mkdir(repo);
  const config = structuredClone(defaultConfig), state = await openChat(root, repo, config);
  const calls = [];
  const engine = { async run(request) {
    calls.push(request); await request.emit({ type: 'thread.started', thread_id: 'persistent-thread' });
    return run ? run(request) : { text: request.planning ? JSON.stringify({ name: 'test', description: 'test', source: 'export default 1' }) : 'direct response' };
  } };
  const session = new ChatSession(root, state, engine);
  sessions.push(session);
  return { root, repo, config, state, calls, engine, session, sessions };
}

test('direct follow-ups reuse one thread; toggles do not reset it and workflow results reach direct chat', async t => {
  const { session, calls, state } = await fixture(t);
  await session.lock();
  let workflows = 0;
  const workflow = async () => { workflows++; return { text: 'run-1 completed; patch verified but NOT applied', runId: 'run-1' }; };
  assert.equal(state.orchestrate, false);
  await session.turn('Remember project detail', workflow);
  await session.turn('Follow up on that detail', workflow);
  assert.equal(workflows, 0); assert.equal(calls[1].threadId, 'persistent-thread');
  await session.command('/orchestrate on'); await session.command('/agents manual');
  await session.turn('Investigate it with workers', workflow);
  assert.equal(workflows, 1); assert.equal(calls[2].planning, true); assert.equal(calls[2].threadId, 'persistent-thread');
  await session.command('/orchestrate off'); await session.turn('Was it applied?', workflow);
  assert.equal(calls[3].planning, false); assert.equal(calls[3].threadId, 'persistent-thread');
  assert.match(calls[3].prompt, /NOT applied/); assert.deepEqual(state.runs, ['run-1']);
  assert.equal(state.messages.length, 8);
});

test('saved chat resumes with the same thread, mode, model, and pending workflow outcome', async t => {
  const { session, root, repo, config, engine, state, calls, sessions } = await fixture(t);
  await session.lock();
  await session.command('/model custom-model medium'); await session.command('/orchestrate on');
  await session.turn('inspect', async () => ({ text: 'Saved workflow without executing' })); await session.close();
  const loaded = await openChat(root, repo, config, state.id);
  assert.equal(loaded.orchestrate, true); assert.equal(loaded.profile.model, 'custom-model');
  const resumed = new ChatSession(root, loaded, engine); sessions.push(resumed); await resumed.lock();
  await resumed.command('/orchestrate off'); await resumed.turn('Continue', async () => { assert.fail('must not orchestrate'); });
  assert.equal(calls.at(-1).threadId, 'persistent-thread'); assert.match(calls.at(-1).prompt, /without executing/);
  assert.equal((await listChats(root)).length, 1);
  await assert.rejects(openChat(root, join(root,'different-repo'), config, state.id), /another repository/);
  assert.throws(() => chatPath(root, '../escape'), /Invalid chat ID/);
});

test('chat locks exclude another process owner and failure keeps the conversation usable', async t => {
  let fail = true;
  const f = await fixture(t, async () => { if (fail) throw Error('temporary stream failure'); return { text: 'recovered' }; });
  await f.session.lock();
  await assert.rejects(new ChatSession(f.root, f.state, f.engine).lock(), /already active/);
  await assert.rejects(f.session.turn('First', async () => ({ text: 'unused' })), /temporary stream/);
  fail = false; assert.equal(await f.session.turn('Retry', async () => ({ text: 'unused' })), 'recovered');
  assert.equal(f.calls[1].threadId, 'persistent-thread'); assert.match(f.calls[1].prompt, /Partial side effects/);
});

test('cancellation aborts the active turn, blocks simultaneous turns and releases settings afterward', async t => {
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const f = await fixture(t, async r => { ready(); await delay(10000, undefined, { signal: r.signal }); return { text: 'unused' }; });
  const turn = f.session.turn('wait', async () => ({ text: 'unused' })); await started;
  await assert.rejects(f.session.turn('concurrent', async () => ({ text: 'unused' })), /already running/);
  await assert.rejects(f.session.command('/orchestrate on'), /cancel the current turn/);
  f.session.stop(); await assert.rejects(turn);
  await f.session.command('/orchestrate on'); assert.equal(f.state.orchestrate, true);
  const saved = JSON.parse(await readFile(join(f.session.directory,'session.json'),'utf8'));
  assert.equal(saved.messages.at(-1).status, 'failed');
});

test('invalid commands and malformed plans cannot launch a workflow or corrupt session settings', async t => {
  const f = await fixture(t, async () => ({ text: '{"source":42}' }));
  for (const command of ['/orchestrate maybe', '/agents random', '/model bad! high', '/jev maybe', '/unknown']) await assert.rejects(f.session.command(command));
  assert.equal(f.state.orchestrate, false);
  await f.session.command('/orchestrate on');
  await assert.rejects(f.session.turn('plan', async () => { assert.fail('bad plan must not run'); }), /schema validation/);
});

test('model command accepts separate and slash effort forms without corrupting the model ID', async t => {
  const f = await fixture(t);
  await f.session.command('/model gpt-5.6-sol/low');
  assert.deepEqual(f.state.profile, { model: 'gpt-5.6-sol', effort: 'low' });
  await f.session.command('/model gpt-6.1-sol xhigh');
  assert.deepEqual(f.state.profile, { model: 'gpt-6.1-sol', effort: 'xhigh' });
  await assert.rejects(f.session.command('/model gpt-6.1-sol/high low'), /Choose one form/);
});

test('chat terminal renders a bounded activity view and keeps important labels readable', async t => {
  const f = await fixture(t);
  const header = renderChatHeader(f.state, 80);
  assert.match(header, /DIRECT CHAT/);
  const screen = renderChatActivity(f.state, 'Inspect this project', ['Thinking', 'COMMAND  rg --files'], Date.now(), 80, 16);
  assert.ok(screen.split('\n').length <= 16);
  assert.match(screen, /LIVE ACTIVITY/);
  const message = renderChatLabel('ERROR', 'The requested model is unsupported for this account; select a model listed by Codex.', 48);
  assert.match(message, /select a model listed by Codex/);
  assert.ok(message.split('\n').every(line => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').length <= 48));
  for (const [width,height] of [[32,12],[80,24],[110,36]]) {
    f.state.orchestrate = true;
    const screen = renderChatActivity(f.state, 'request', ['COMMAND  inspecting'], Date.now(), width,height);
    assert.ok(screen.split('\n').length <= height);
    assert.ok(screen.split('\n').every(line => clean(line).length <= width));
    assert.match(clean(screen), /COMMAND/);
  }
  f.state.config.jev.enabled = true;
  const panel = renderJevPanel(f.state.config, { route: { signature:'x', judgment: {choice:'role',confidence:0,probabilities:{},model:'jev',fallback:true,error:'No key',usage:{input_tokens:0,output_tokens:0}} } },80).join('\n');
  assert.match(panel,/FALLBACK/);
});

test('starting without a chat ID always creates a fresh conversation', async t => {
  const f = await fixture(t);
  f.state.threadId = 'old-thread'; await f.session.save();
  const fresh = await openChat(f.root, f.repo, f.config);
  assert.notEqual(fresh.id, f.state.id); assert.equal(fresh.threadId, undefined);
  assert.deepEqual(fresh.messages, []);
});

test('chat counts reported usage, warns before premium calls and blocks the next turn at budget', async t => {
  let warned = false;
  const f = await fixture(t, async request => {
    assert.equal(warned, true);
    await request.emit({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5 } });
    return { text: 'ready', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5 } };
  });
  f.state.config.tokenBudget = 15;
  await f.session.command('/model gpt-6.1-sol low');
  await f.session.turn('go', async () => ({ text: 'unused' }), () => {}, () => { warned = true; });
  assert.equal(f.state.usage.input_tokens, 10); assert.equal(f.state.usage.output_tokens, 5);
  await assert.rejects(f.session.turn('again', async () => ({ text: 'unused' })), /token budget reached/);
  assert.equal(f.calls.length, 1);
});
