import type { JevConfig, Judgment } from './types.js';

export interface DecisionOptions {
  id: string; instructions: string; choices: Record<string, string>; fallback: string;
}
export type Judge = (state: unknown, options: DecisionOptions, signal: AbortSignal) => Promise<Judgment>;

export function createJudge(config: JevConfig, fetcher: typeof fetch = fetch, apiKey = process.env.TYPESAFE_API_KEY): Judge {
  return async (state, options, signal) => {
    const fallback = (error: string): Judgment => ({ choice: options.fallback, confidence: 0, probabilities: {},
      model: config.model, fallback: true, error, usage: { input_tokens: 0, output_tokens: 0 } });
    if (!config.enabled) return fallback('Jev disabled');
    if (!apiKey) return fallback('TYPESAFE_API_KEY is not configured');
    try {
      const response = await fetcher('https://api.typesafe.ai/v1/systemone', {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.model, state, questions: { decision: {
          type: 'choice', instructions: options.instructions, criteria: options.choices,
        } } }),
      });
      // Do not persist service error bodies, which could echo input or credentials.
      if (!response.ok) return fallback(`TypeSafe HTTP ${response.status}`);
      const text = await response.text();
      if (text.length > 100_000) return fallback('TypeSafe response exceeds limit');
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
      return fallback('TypeSafe request failed or timed out');
    }
  };
}
