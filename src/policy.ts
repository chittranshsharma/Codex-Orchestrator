import type { AgentOptions, Config, ModelProfile, TokenUsage } from './types.js';

export function premiumWarning(profile: ModelProfile): string | undefined {
  if (/^(?:gpt-6-astra|gpt-6\.1-sol)(?:$|[-/:])/.test(profile.model)) return `Premium model ${profile.model}/${profile.effort} will run next. It can consume more of your account allowance; token use depends on the task.`;
}
export const totalTokens = (usage?: TokenUsage) => (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
export function routingMetadata(prompt: string, options: AgentOptions) {
  return { role: options.role, promptChars: prompt.length, structuredOutput: Boolean(options.schema),
    existingWorkspace: Boolean(options.workspace),
    complex: /architecture|concurrency|deadlock|cryptograph|root cause|distributed|race condition/i.test(prompt) };
}
export function automaticProfile(config: Config, prompt: string, options: AgentOptions): ModelProfile {
  const base = config.roles[options.role];
  if (!config.localRouting || config.fixedRoles?.includes(options.role)) return base;
  // A local policy selects effort without an extra model call or external data transfer.
  return { ...base, effort: routingMetadata(prompt, options).complex ? 'high' : base.effort };
}
