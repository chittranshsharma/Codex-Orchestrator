import { appendFile, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { RunState } from './types.js';

export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
export function stateRoot(): string {
  return resolve(process.env.CWF_STATE_DIR ?? (process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'CodexWorkflow')
    : join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'codex-workflow')));
}
export function runPath(root: string, id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid run ID');
  return join(root, 'runs', id);
}
export function inside(root: string, path: string): string {
  const absolute = resolve(root, path);
  if (absolute === resolve(root) || !absolute.startsWith(resolve(root) + sep) || isAbsolute(path)) {
    throw new Error(`Path must stay inside the run directory: ${path}`);
  }
  return absolute;
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, path);
}
export class Store {
  private queue = Promise.resolve();
  private unlock?: () => Promise<void>;
  constructor(readonly directory: string, readonly state: RunState) {}
  async lock(): Promise<void> {
    this.unlock = await acquireLock(this.directory);
  }
  save(): Promise<void> {
    const snapshot = structuredClone(this.state);
    this.queue = this.queue.then(() => atomicJson(join(this.directory, 'state.json'), snapshot));
    return this.queue;
  }
  event(type: string, data: Record<string, unknown> = {}): Promise<void> {
    const entry = JSON.stringify({ at: new Date().toISOString(), type, ...data }) + '\n';
    this.queue = this.queue.then(() => appendFile(join(this.directory, 'events.jsonl'), entry, { mode: 0o600 }));
    return this.queue;
  }
  async close(): Promise<void> { try { await this.queue; } finally { await this.unlock?.(); this.unlock = undefined; } }
}
export async function acquireLock(directory: string, filename = 'run.lock'): Promise<() => Promise<void>> {
    await mkdir(directory, { recursive: true });
    const path = join(directory, filename);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const file = await open(path, 'wx', 0o600);
        await file.writeFile(String(process.pid)); await file.close();
        return () => unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const pid = Number(await readFile(path, 'utf8'));
        if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid lock at ${path}; inspect it before removing it`);
        try { process.kill(pid, 0); }
        catch (probe) {
          if ((probe as NodeJS.ErrnoException).code === 'ESRCH') { await unlink(path); continue; }
          throw probe;
        }
        throw new Error(`Run is already active in process ${pid}`);
      }
    }
    throw new Error('Could not acquire run lock');
}
export async function readState(directory: string): Promise<RunState> {
  const state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')) as RunState;
  if (state.version !== 1) throw new Error('Unsupported run state version');
  return state;
}
