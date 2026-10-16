import { createInterface } from 'node:readline/promises';
import type { Interface } from 'node:readline/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ThreadEvent } from '@openai/codex-sdk';
import { ChatSession, SdkChatEngine, openChat } from './chat.js';
import type { ChatState, WorkflowOutcome } from './chat.js';
import { createRun, resumeRun, writeReport } from './runtime.js';
import { applyPatch } from './git.js';
import { CodexProvider } from './provider.js';
import { clean } from './dashboard.js';
import { reviewAndLaunch } from './guided.js';
import type { Store } from './storage.js';
import type { Config, Provider } from './types.js';
const exec = promisify(execFile);
export type RunExecutor = (store: Store, provider: Provider, mode: 'tui' | 'plain' | 'json', demo?: boolean, signal?: AbortSignal) => Promise<void>;
const print = (value: string) => console.log(value.split('\n').map(line => clean(line)).join('\n'));

export async function applyChatPatch(root: string, state: Pick<ChatState, 'runs' | 'repo'>, runId: string, jobId: string): Promise<string> {
  if (!state.runs.includes(runId)) throw new Error('Run must belong to this chat');
  const store = await resumeRun(root, runId);
  if (store.state.repo !== state.repo) throw new Error('Run belongs to another repository');
  await store.lock();
  try { await applyPatch(store, jobId); await writeReport(store); } finally { await store.close(); }
  return `Applied verified patch ${jobId} from ${runId} to the source checkout. Review the diff and run integration checks.`;
}

class ChatInput {
  private input?: Interface;
  async ask(prompt: string, history: string[] = [], signal?: AbortSignal): Promise<string | null> {
    signal?.throwIfAborted();
    // Reuse readline between chat prompts; repeatedly replacing a Windows TTY reader can swallow input.
    if (!this.input) {
      this.input = createInterface({ input: process.stdin, output: process.stdout, history });
      this.input.on('SIGINT', () => this.close());
      this.input.once('close', () => { this.input = undefined; });
    }
    const input = this.input;
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    input.resume();
    let onClose: () => void = () => {};
    const closed = new Promise<null>(resolve => { onClose = () => resolve(null); input.once('close', onClose); });
    try { return await Promise.race([input.question(prompt, { signal }), closed]); }
    finally {
      input.off('close', onClose); input.pause();
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    }
  }
  close() { this.input?.close(); this.input = undefined; }
}
function activity(event: ThreadEvent): void {
  if (event.type === 'item.started' && event.item.type === 'command_execution') print(`  [command] ${event.item.command}`);
  if (event.type === 'item.started' && event.item.type === 'mcp_tool_call') print(`  [tool] ${event.item.server}/${event.item.tool}`);
  if (event.type === 'item.completed' && event.item.type === 'file_change') print(`  [files] ${event.item.changes.map(c => c.path).join(', ')}`);
}
export async function runChat(root: string, repo: string, config: Config, execute: RunExecutor, id?: string, orchestrate = false): Promise<void> {
  const state = await openChat(root, repo, config, id);
  if (!id && orchestrate) state.orchestrate = true;
  const session = new ChatSession(root, state, new SdkChatEngine(state.config));
  await session.lock();
  const inputReader = new ChatInput();
  let terminating = false;
  const stop = () => session.stop();
  const terminate = () => { terminating = true; session.stop(); };
  process.on('SIGINT', stop); process.on('SIGTERM', terminate);
  const workflow = async (source: string, request: string, signal: AbortSignal): Promise<WorkflowOutcome> => {
    inputReader.close();
    const path = join(session.directory, `workflow-${randomUUID()}.mjs`);
    await writeFile(path, source, { flag: 'wx', mode: 0o600 });
    await exec(process.execPath, ['--check', path], { windowsHide: true });
    let outcome: WorkflowOutcome = { text: `Workflow saved but NOT executed: ${path}` };
    await reviewAndLaunch({ path,
      preview: text => print(`\nWORKFLOW REVIEW / ${path}\n${text}\nType RUN only after reviewing this trusted JavaScript.`),
      confirm: async () => (await inputReader.ask('RUN to execute; Enter to return to chat: ', [], signal)) ?? '',
      launch: async reviewed => {
        inputReader.close();
        signal.throwIfAborted();
        const store = await createRun(root, repo, reviewed, { request }, state.config);
        const previousExitCode = process.exitCode;
        try { await execute(store, new CodexProvider(state.config), 'tui', false, signal); }
        catch (error) { print(`Workflow did not complete: ${error instanceof Error ? error.message : String(error)}`); }
        finally { process.exitCode = previousExitCode; }
        const report = await writeReport(store);
        const patches = Object.values(store.state.tasks).filter(t => t.patch).map(t => ({ job: t.id, verifiedBy: t.verifiedBy ?? null, applied: store.state.applied.includes(t.id) }));
        const result = typeof store.state.result === 'string' ? store.state.result : JSON.stringify(store.state.result ?? null);
        outcome = { runId: store.state.id, text: `Workflow ${store.state.id}: ${store.state.status}.\nReport: ${report}\nPatches: ${JSON.stringify(patches)}\nResult: ${result.slice(0, Math.min(32000, state.config.maxInputChars / 2))}${result.length > Math.min(32000, state.config.maxInputChars / 2) ? '\n[Result shortened; read the full report.]' : ''}${store.state.error ? `\nError: ${store.state.error}` : ''}` };
      },
    });
    return outcome;
  };
  print(`\nCODEX ORCHESTRATOR / CHAT\n${session.status()}\nType prompts and follow-ups here. /orchestrate on or off switches this chat.\n/help lists controls. /exit saves and closes.\nResume later: cwf chat ${state.id}\n`);
  try {
    await session.save();
    while (!terminating) {
      const history = state.messages.filter(m => m.role === 'user').slice(-50).reverse().map(m => m.text);
      let input = await inputReader.ask(`cwf [${state.orchestrate ? 'ON' : 'OFF'}] > `, history);
      if (input === null) break;
      while (input.endsWith('\\')) {
        const next = await inputReader.ask('... ');
        if (next === null) { input = ''; break; }
        input = input.slice(0, -1) + '\n' + next;
        if (input.length > state.config.maxInputChars) break;
      }
      if (!input.trim()) continue;
      try {
        if (input.startsWith('/apply ')) {
          const [, runId, jobId, extra] = input.trim().split(/\s+/);
          if (!runId || !jobId || extra || !state.runs.includes(runId)) throw new Error('Usage: /apply RUN_ID JOB_ID (run must belong to this chat)');
          const message = await applyChatPatch(root, state, runId, jobId);
          state.pendingContext.push(message); state.messages.push({ role: 'system', text: message, at: new Date().toISOString() }); await session.save();
          print(message); continue;
        }
        if (input.startsWith('/')) {
          const result = await session.command(input); print(result.text); if (result.exit) break;
          continue;
        }
        print(`\n${state.orchestrate ? 'Planning workflow' : 'Codex'} / ${state.profile.model} / ${state.profile.effort} ...`);
        const result = await session.turn(input, workflow, activity);
        print(`\n${result}\n`);
      } catch (error) { print(`\n${error instanceof Error ? error.message : String(error)}\nChat is still open. Use /status or send another prompt.\n`); }
    }
  } finally {
    inputReader.close();
    process.off('SIGINT', stop); process.off('SIGTERM', terminate);
    await session.save(); await session.close();
    print(`\nChat saved. Resume: cwf chat ${state.id}`);
  }
}
