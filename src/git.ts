import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hash, inside, atomicJson } from './storage.js';
import type { Store } from './storage.js';
const exec = promisify(execFile);
export async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', repo, ...args], { maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  return stdout;
}
export async function repository(path: string): Promise<string> {
  return realpath((await git(resolve(path), ['rev-parse', '--show-toplevel'])).trim());
}
export async function fingerprint(repo: string): Promise<{ head: string; fingerprint: string }> {
  const head = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  const diff = await git(repo, ['diff', '--binary', 'HEAD']);
  const paths = (await git(repo, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean).sort();
  const untracked = [];
  for (const path of paths) {
    const file = join(repo, path); const stat = await lstat(file);
    if (stat.isSymbolicLink()) throw new Error(`Untracked symlink prevents a reliable snapshot: ${path}`);
    untracked.push([path, hash(await readFile(file))]);
  }
  return { head, fingerprint: hash(JSON.stringify({ head, diff, untracked })) };
}
export async function assertClean(repo: string): Promise<void> {
  if ((await git(repo, ['status', '--porcelain'])).trim()) {
    throw new Error('Edit jobs require a clean Git working tree. Commit or stash your changes, or run an audit without --fix.');
  }
}
export async function createWorktree(store: Store, taskId: string): Promise<string> {
  const path = inside(store.directory, `worktrees/${taskId}`);
  try {
    await lstat(path);
    const head = (await git(path, ['rev-parse', 'HEAD'])).trim();
    const top = await repository(path);
    if (head !== store.state.head || top !== await realpath(path)) throw new Error('Worktree no longer matches the saved base');
    return path;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await assertClean(store.state.repo);
  await git(store.state.repo, ['worktree', 'add', '--detach', path, store.state.head]);
  return path;
}
export async function savePatch(store: Store, taskId: string, cwd: string): Promise<void> {
  if ((await git(cwd, ['rev-parse', 'HEAD'])).trim() !== store.state.head) {
    throw new Error('Edit agent changed HEAD. Do not commit or switch branches inside workflow worktrees.');
  }
  await git(cwd, ['add', '--intent-to-add', '--all']);
  const patch = await git(cwd, ['diff', '--binary', 'HEAD']);
  const relative = `${taskId}.patch`;
  await writeFile(inside(store.directory, relative), patch, { mode: 0o600 });
  const task = store.state.tasks[taskId]!;
  task.patch = relative; task.patchHash = hash(patch);
}
export async function applyPatch(store: Store, taskId: string): Promise<void> {
  const task = store.state.tasks[taskId];
  if (!task?.patch || task.status !== 'completed' || !task.patchHash) throw new Error('Task has no completed patch');
  const verifier = task.verifiedBy ? store.state.tasks[task.verifiedBy] : undefined;
  if (!verifier || verifier.role !== 'verify' || verifier.worktree !== task.worktree || verifier.status !== 'completed' || (verifier.result as { passed?: boolean })?.passed !== true) throw new Error('Patch needs a passing independent verifier before it can be applied');
  if (task.supersededBy) throw new Error(`Patch was superseded by ${task.supersededBy}`);
  if (store.state.applied.includes(taskId)) throw new Error('Patch has already been applied');
  if ((await git(store.state.repo, ['rev-parse', 'HEAD'])).trim() !== store.state.head) throw new Error('Repository HEAD changed since this run');
  const patchFile = inside(store.directory, task.patch);
  const patch = await readFile(patchFile, 'utf8');
  if (hash(patch) !== task.patchHash) throw new Error('Patch changed after it was recorded');
  if (!patch.trim()) throw new Error('Patch is empty');
  await git(store.state.repo, ['apply', '--check', patchFile]);
  await git(store.state.repo, ['apply', patchFile]);
  store.state.applied.push(taskId);
  await atomicJson(join(store.directory, 'state.json'), store.state);
}
