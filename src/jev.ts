import type { JevConfig, Judgment } from './types.js';
import { jevKey } from './environment.js';
import { hash, stable } from './storage.js';

export interface DecisionOptions {
  id: string; instructions: string; choices: Record<string, string>; fallback: string;
}
export type Judge = (state: unknown, options: DecisionOptions, signal: AbortSignal) => Promise<Judgment>;

export function createJudge(config: JevConfig, fetcher: typeof fetch = fetch, apiKey = jevKey()): Judge {
  const cache = new Map<string, Promise<Judgment>>();
  let unavailable = false;
  const request: Judge = async (state, options, signal) => {
    signal.throwIfAborted();
    const fallback = (error: string): Judgment => ({ choice: options.fallback, confidence: 0, probabilities: {},
      model: config.model, fallback: true, error, usage: { input_tokens: 0, output_tokens: 0 } });
    if (!config.enabled) return fallback('Jev disabled');
    if (!apiKey) return fallback('TYPESAFE_API_KEY is not configured');
    if (unavailable) return fallback('Jev unavailable for this run; local routing active');
    if (!config.shareTaskText && !options.id.startsWith('route-')) return fallback('Task text sharing is off; semantic decision uses its explicit fallback');
    if (!config.shareTaskText) {
      const data = state as Record<string, unknown> | null;
      state = { role: ['plan', 'scan', 'edit', 'verify', 'review'].includes(String(data?.role)) ? data?.role : 'scan',
        promptChars: typeof data?.promptChars === 'number' ? Math.max(0, Math.min(1000000, data.promptChars)) : 0,
        structuredOutput: data?.structuredOutput === true, existingWorkspace: data?.existingWorkspace === true, complex: data?.complex === true };
    }
    if (JSON.stringify(state ?? null).length > 8000) return fallback('Jev state exceeds the 8000-character disclosure limit');
    try {
      const response = await fetcher('https://api.typesafe.ai/v1/systemone', {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.model, state, questions: { decision: {
          type: 'choice', instructions: options.instructions, criteria: options.choices,
        } } }),
      });
      // Do not persist service error bodies, which could echo input or credentials.
      if (!response.ok) { unavailable = true; return fallback(`TypeSafe HTTP ${response.status}`); }
      if (!response.body) return fallback('Empty TypeSafe response');
      const reader = response.body.getReader();
      let size = 0; const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 100_000) { await reader.cancel(); return fallback('TypeSafe response exceeds limit'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const text = Buffer.concat(chunks).toString('utf8');
      const body = JSON.parse(text);
      const answer = body?.answers?.decision;
      const keys = Object.keys(options.choices);
      const probability = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
      const distribution = answer?.probabilities;
      if (answer?.type !== 'choice' || !keys.includes(answer.choice) || !probability(answer.confidence)
        || !distribution || Object.keys(distribution).length !== keys.length || !keys.every(key => probability(distribution[key]))
        || Math.abs(keys.reduce((sum, key) => sum + distribution[key], 0) - 1) > 0.01
        || keys.some(key => distribution[key] > distribution[answer.choice] + 0.000001)
        || typeof body.model !== 'string' || !body.model || body.model.length > 120
        || !Number.isSafeInteger(body.usage?.input_tokens) || body.usage.input_tokens < 0
        || !Number.isSafeInteger(body.usage?.output_tokens) || body.usage.output_tokens < 0) return fallback('Invalid TypeSafe response');
      // Check the documented Choice confidence formula as well as the supplied field.
      const concentration = Math.max(0, (keys.length * distribution[answer.choice] - 1) / (keys.length - 1));
      const confidence = Math.min(answer.confidence, concentration);
      const uncertain = confidence < config.confidence;
      return { choice: uncertain ? options.fallback : answer.choice, confidence, probabilities: distribution,
        model: body.model, fallback: uncertain, ...(uncertain ? { error: 'Below routing confidence threshold' } : {}), usage: body.usage };
    } catch {
      signal.throwIfAborted();
      unavailable = true;
      return fallback('TypeSafe request failed or timed out');
    }
  };
  return async (state, options, signal) => {
    signal.throwIfAborted();
    const key = hash(stable({ state, instructions: options.instructions, choices: options.choices, fallback: options.fallback }));
    const saved = cache.get(key);
    if (saved) {
      const result = await saved; signal.throwIfAborted();
      return { ...structuredClone(result), cached: true, usage: { input_tokens: 0, output_tokens: 0 } };
    }
    const pending = request(state, options, signal);
    cache.set(key, pending);
    try { return await pending; } catch (error) { cache.delete(key); throw error; }
  };
}
