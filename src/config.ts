import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import type { Config, JsonSchema } from './types.js';

export const defaultConfig: Config = {
  selectionMode: 'manual', assignments: {},
  roles: {
    plan: { model: 'gpt-6.1-sol', effort: 'high' },
    scan: { model: 'gpt-6-luna', effort: 'high' },
    edit: { model: 'gpt-6.1-sol', effort: 'high' },
    verify: { model: 'gpt-6.1-sol', effort: 'high' },
    review: { model: 'gpt-6.1-sol', effort: 'high' },
  },
  concurrency: 4, maxAgents: 100, timeoutMs: 900_000, readRetries: 1,
  maxInputChars: 120_000, maxOutputChars: 1_000_000,
  jev: { enabled: false, model: 'jev-latest', confidence: 0.8, timeoutMs: 10_000,
    profiles: { fast: { model: 'gpt-6-luna', effort: 'high' },
      standard: { model: 'gpt-6.1-sol', effort: 'high' }, deep: { model: 'gpt-6.1-sol', effort: 'xhigh' } } },
};
const profileSchema = {
  type: 'object', additionalProperties: false, required: ['model', 'effort'],
  properties: {
    model: { type: 'string', minLength: 1, maxLength: 120 },
    effort: { enum: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  },
};
const configSchema = {
  type: 'object', additionalProperties: false,
  required: ['roles', 'concurrency', 'maxAgents', 'timeoutMs', 'readRetries', 'maxInputChars', 'maxOutputChars'],
  properties: {
    selectionMode: { enum: ['manual', 'auto'] },
    assignments: { type: 'object', maxProperties: 1000, propertyNames: { pattern: '^[a-zA-Z0-9_-]{1,100}$', not: { enum: ['__proto__', 'prototype', 'constructor'] } }, additionalProperties: profileSchema },
    roles: { type: 'object', additionalProperties: false, required: Object.keys(defaultConfig.roles),
      properties: Object.fromEntries(Object.keys(defaultConfig.roles).map(role => [role, profileSchema])) },
    concurrency: { type: 'integer', minimum: 1, maximum: 32 },
    maxAgents: { type: 'integer', minimum: 1, maximum: 1000 },
    timeoutMs: { type: 'integer', minimum: 1000, maximum: 86_400_000 },
    readRetries: { type: 'integer', minimum: 0, maximum: 3 },
    maxInputChars: { type: 'integer', minimum: 1000, maximum: 1_000_000 },
    maxOutputChars: { type: 'integer', minimum: 1000, maximum: 10_000_000 },
    codexPath: { type: 'string', minLength: 1 },
    jev: { type: 'object', additionalProperties: false, required: ['enabled', 'model', 'confidence', 'timeoutMs', 'profiles'], properties: {
      enabled: { type: 'boolean' }, model: { type: 'string', minLength: 1, maxLength: 120 },
      confidence: { type: 'number', minimum: 0, maximum: 1 }, timeoutMs: { type: 'integer', minimum: 100, maximum: 60_000 },
      profiles: { type: 'object', additionalProperties: false, required: ['fast', 'standard', 'deep'],
        properties: { fast: profileSchema, standard: profileSchema, deep: profileSchema } },
    } },
  },
};
const ajv = new Ajv({ allErrors: true, strict: false });
export function validateSchema(schema: JsonSchema, value: unknown): void {
  const check = ajv.compile(schema);
  if (!check(value)) throw new Error(`Output failed schema validation: ${ajv.errorsText(check.errors)}`);
}
export async function loadConfig(repo: string, overrides: Partial<Config> = {}): Promise<Config> {
  let local: Partial<Config> = {};
  try { local = JSON.parse(await readFile(join(repo, '.codex-workflow.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const config = { ...structuredClone(defaultConfig), ...local, ...overrides,
    roles: { ...defaultConfig.roles, ...local.roles, ...overrides.roles } };
  const validate = ajv.compile(configSchema);
  if (!validate(config)) throw new Error(`Invalid workflow config: ${ajv.errorsText(validate.errors)}`);
  return config;
}
