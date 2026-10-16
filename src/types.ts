export const roles = ['plan', 'scan', 'edit', 'verify', 'review'] as const;
export type Role = typeof roles[number];
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type JsonSchema = Record<string, unknown>;
export interface ModelProfile { model: string; effort: Effort }
export interface JevConfig {
  enabled: boolean; model: string; confidence: number; timeoutMs: number;
  profiles: { fast: ModelProfile; standard: ModelProfile; deep: ModelProfile };
}
export interface Judgment {
  choice: string; confidence: number; probabilities: Record<string, number>;
  model: string; fallback: boolean; error?: string; usage: { input_tokens: number; output_tokens: number };
}
export interface Config {
  selectionMode?: 'manual' | 'auto';
  assignments?: Record<string, ModelProfile>;
  roles: Record<Role, ModelProfile>;
  concurrency: number; maxAgents: number; timeoutMs: number; readRetries: number;
  maxInputChars: number; maxOutputChars: number; codexPath?: string;
  jev?: JevConfig;
}
export interface AgentOptions {
  id: string; role: Role; label?: string; schema?: JsonSchema;
  timeoutMs?: number;
  workspace?: string;
  webSearch?: 'disabled' | 'cached' | 'live';
}
export interface TokenUsage {
  input_tokens: number; cached_input_tokens: number; output_tokens: number;
}
export interface TaskRecord {
  id: string; label: string; phase: string; role: Role; model: string; effort: Effort;
  signature: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped';
  attempts: number; startedAt?: string; endedAt?: string; threadId?: string;
  worktree?: string; patch?: string; patchHash?: string; error?: string; result?: unknown;
  usage: TokenUsage; activity?: string;
  verifiedBy?: string; supersededBy?: string;
  order?: number;
  routing?: Judgment;
  assignment?: ModelProfile;
}
export interface RunState {
  version: 1; id: string; name: string; description: string; repo: string;
  head: string; fingerprint: string; workflowHash: string; args: unknown;
  config: Config; status: 'running' | 'paused' | 'completed' | 'partial' | 'failed' | 'cancelled';
  createdAt: string; endedAt?: string; error?: string; result?: unknown;
  phases: string[]; tasks: Record<string, TaskRecord>; applied: string[];
  failures: string[];
  decisions?: Record<string, { signature: string; judgment: Judgment }>;
}
export interface ProviderRequest {
  prompt: string; options: AgentOptions; profile: ModelProfile; cwd: string;
  signal: AbortSignal;
  emit: (event: { type: string; [key: string]: unknown }) => Promise<void>;
}
export interface ProviderResult { result: unknown; usage: TokenUsage }
export interface Provider { run(request: ProviderRequest): Promise<ProviderResult> }
export const emptyUsage = (): TokenUsage => ({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 });
