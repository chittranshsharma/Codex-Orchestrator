import test from 'node:test';
import assert from 'node:assert/strict';
import { createJudge } from '../dist/jev.js';
import { defaultConfig } from '../dist/config.js';
import reviewWorkflow from '../workflows/jev-review.mjs';
const config = { ...defaultConfig.jev, enabled: true };
const options = { id: 'decision', instructions: 'Which?', choices: { fast: 'Simple', deep: 'Complex' }, fallback: 'deep' };
const body = (p = 0.95) => ({ model: 'jev-test', answers: { decision: { type: 'choice', choice: 'fast', confidence: 2 * p - 1,
  probabilities: { fast: p, deep: 1 - p } } }, usage: { input_tokens: 30, output_tokens: 5 } });
test('Jev review selects a target and always independently verifies; fallback covers all targets', async () => {
  for (const choice of ['target_1', 'all']) {
    const jobs = [];
    await reviewWorkflow({ args: { targets: ['auth', 'api'] }, phase() {}, log() {},
      decide: async () => ({ choice }), agent: async (prompt, options) => { jobs.push({ prompt, ...options }); return 'evidence'; } });
    assert.equal(jobs.length, 2); assert.equal(jobs[1].role, 'verify');
    assert.ok(jobs[0].prompt.includes('api'));
    assert.equal(jobs[0].prompt.includes('auth'), choice === 'all');
  }
});
test('Jev sends official Choice contract, gates uncertainty and retains usage', async () => {
  let request;
  const judge = createJudge(config, async (url, init) => {
    request = { url, ...init }; return new Response(JSON.stringify(body()));
  }, 'test-key');
  const result = await judge({ task: 'Inspect one file' }, options, new AbortController().signal);
  assert.equal(result.choice, 'fast'); assert.equal(result.fallback, false); assert.equal(result.usage.input_tokens, 30);
  assert.equal(request.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(JSON.parse(request.body).questions.decision.type, 'choice');
  const uncertain = await createJudge(config, async () => new Response(JSON.stringify(body(0.6))), 'test-key')({}, options, new AbortController().signal);
  assert.equal(uncertain.choice, 'deep'); assert.equal(uncertain.fallback, true); assert.equal(uncertain.usage.input_tokens, 30);
});
test('Jev fails to explicit fallback on missing keys, malformed responses, HTTP errors and timeouts', async () => {
  const signal = new AbortController().signal;
  const missing = await createJudge(config, () => { throw Error('must not call'); }, '')({}, options, signal);
  assert.match(missing.error, /not configured/);
  for (const fetcher of [async () => new Response('secret response', { status: 401 }),
    async () => new Response('{}'), async () => { throw Error('secret key'); },
    async () => new Response(JSON.stringify({ ...body(), answers: { decision: { ...body().answers.decision, probabilities: { fast: 0.4, deep: 0.6 } } } }))]) {
    const result = await createJudge(config, fetcher, 'test-key')({}, options, signal);
    assert.equal(result.choice, 'deep'); assert.equal(result.fallback, true); assert.ok(!JSON.stringify(result).includes('secret'));
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createJudge(config, async () => { throw Error('aborted'); }, 'test-key')({}, options, controller.signal));
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const timeout = await createJudge({ ...config, timeoutMs: 100 }, async (_url, init) => {
      await new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    }, 'test-key')({}, options, signal);
    assert.equal(timeout.fallback, true); assert.match(timeout.error, /timed out/);
  } finally { clearTimeout(keepAlive); }
});

test('Jev stops reading oversized responses and obeys cancellation even without a key', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(100001)); }, cancel() { cancelled = true; } });
  const judge = createJudge(config, async () => new Response(stream), 'test-key');
  const result = await judge({}, options, new AbortController().signal);
  assert.equal(cancelled, true); assert.match(result.error, /exceeds limit/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createJudge(config, fetch, '')({}, options, controller.signal));
});
