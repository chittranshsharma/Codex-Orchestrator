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
import { clean, renderChatActivity, renderChatHeader, renderChatLabel, renderChatState, renderJevPanel } from './dashboard.js';
import { reviewAndLaunch } from './guided.js';
import type { Store } from './storage.js';
import type { Config, Provider } from './types.js';
import { premiumWarning, totalTokens } from './policy.js';
import { loadJevEnv, jevEnvSource } from './environment.js';
const exec = promisify(execFile);
export type RunExecutor = (store: Store, provider: Provider, mode: 'tui' | 'plain' | 'json', demo?: boolean, signal?: AbortSignal) => Promise<void>;
const print = (value: string) => console.log(value.split('\n').map(line => clean(line)).join('\n'));
const width = () => process.stdout.columns ?? 100;
const prompt = (on: boolean) => `\x1b[38;5;${on ? 215 : 117}m\x1b[1mcwf ${on ? 'ON' : 'OFF'}\x1b[0m \x1b[38;5;250m>\x1b[0m `;
function friendlyError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch { /* The SDK may return either text or a JSON error envelope. */ }
  return raw;
}

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
function activityLine(event: ThreadEvent): string | undefined {
  if (event.type === 'thread.started') return 'Codex thread connected';
  if (event.type === 'turn.started') return 'Thinking through the request';
  if (event.type === 'item.started' && event.item.type === 'command_execution') return `COMMAND  ${event.item.command}`;
  if (event.type === 'item.started' && event.item.type === 'mcp_tool_call') return `TOOL     ${event.item.server}/${event.item.tool}`;
  if (event.type === 'item.completed' && event.item.type === 'file_change') return `FILES    ${event.item.changes.map(c => c.path).join(', ')}`;
  if (event.type === 'turn.completed') return 'Response ready';
  return undefined;
}
class ChatActivity {
  private readonly startedAt = Date.now();
  private readonly events: string[] = [];
  private timer?: NodeJS.Timeout;
  private active = false;
  constructor(private readonly state: ChatState, private readonly request: string) {}
  start() {
    if (!process.stdout.isTTY) return;
    this.active = true;
    process.stdout.write('\x1b[?1049h\x1b[?25l');
    this.timer = setInterval(() => this.draw(), 1000);
    this.draw();
  }
  event(event: ThreadEvent) {
    const line = activityLine(event);
    if (!line) return;
    this.events.push(line);
    if (this.events.length > 50) this.events.shift();
    this.draw();
  }
  stop() {
    if (!this.active) return;
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    process.stdout.write('\x1b[?25h\x1b[?1049l');
  }
  private draw() {
    if (!this.active) return;
    process.stdout.write('\x1b[H\x1b[2J' + renderChatActivity(this.state, this.request, this.events, this.startedAt, width(), process.stdout.rows ?? 30));
  }
}
export async function runChat(root: string, repo: string, config: Config, execute: RunExecutor, id?: string, orchestrate = false): Promise<void> {
  while (await runChatSession(root, repo, config, execute, id, orchestrate)) { id = undefined; orchestrate = false; }
}
async function runChatSession(root: string, repo: string, config: Config, execute: RunExecutor, id?: string, orchestrate = false): Promise<boolean> {
  const state = await openChat(root, repo, config, id);
  if (!id && orchestrate) state.orchestrate = true;
  const session = new ChatSession(root, state, new SdkChatEngine(state.config));
  await session.lock();
  const inputReader = new ChatInput();
  let currentActivity: ChatActivity | undefined;
  let terminating = false;
  let freshChat = false;
  const stop = () => session.stop();
  const terminate = () => { terminating = true; session.stop(); };
  process.on('SIGINT', stop); process.on('SIGTERM', terminate);
  const workflow = async (source: string, request: string, signal: AbortSignal): Promise<WorkflowOutcome> => {
    currentActivity?.stop(); currentActivity = undefined;
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
        const remaining = state.config.tokenBudget ? state.config.tokenBudget - totalTokens(state.usage) - (state.workflowTokens ?? 0) : undefined;
        if (remaining !== undefined && remaining <= 0) throw new Error('Planning reached the reported token budget. No workers started.');
        const store = await createRun(root, repo, reviewed, { request }, { ...state.config, ...(remaining ? { tokenBudget: remaining } : {}) });
        const previousExitCode = process.exitCode;
        try { await execute(store, new CodexProvider(state.config), 'tui', false, signal); }
        catch (error) { print(`Workflow did not complete: ${error instanceof Error ? error.message : String(error)}`); }
        finally { process.exitCode = previousExitCode; }
        const report = await writeReport(store);
        const patches = Object.values(store.state.tasks).filter(t => t.patch).map(t => ({ job: t.id, verifiedBy: t.verifiedBy ?? null, applied: store.state.applied.includes(t.id) }));
        const result = typeof store.state.result === 'string' ? store.state.result : JSON.stringify(store.state.result ?? null);
        outcome = { runId: store.state.id, tokens: Object.values(store.state.tasks).reduce((sum, task) => sum + totalTokens(task.usage), 0), text: `Workflow ${store.state.id}: ${store.state.status}.\nReport: ${report}\nPatches: ${JSON.stringify(patches)}\nResult: ${result.slice(0, Math.min(6000, state.config.maxInputChars / 2))}${result.length > Math.min(6000, state.config.maxInputChars / 2) ? '\n[Result shortened; read the full report.]' : ''}${store.state.error ? `\nError: ${store.state.error}` : ''}` };
      },
    });
    return outcome;
  };
  process.stdout.write('\x1b[2J\x1b[H');
  console.log(renderChatHeader(state, width()));
  console.log(renderChatLabel('SYSTEM', 'Fresh conversation ready. /new starts another; resuming old chats is optional.', width()));
  console.log();
  try {
    await session.save();
    while (!terminating) {
      const history = state.messages.filter(m => m.role === 'user').slice(-50).reverse().map(m => m.text);
      let input = await inputReader.ask(prompt(state.orchestrate), history);
      if (input === null) break;
      while (input.endsWith('\\')) {
        const next = await inputReader.ask('... ');
        if (next === null) { input = ''; break; }
        input = input.slice(0, -1) + '\n' + next;
        if (input.length > state.config.maxInputChars) break;
      }
      if (!input.trim()) continue;
      try {
        if (input.trim() === '/new') { freshChat = true; break; }
        if (input.startsWith('/apply ')) {
          const [, runId, jobId, extra] = input.trim().split(/\s+/);
          if (!runId || !jobId || extra || !state.runs.includes(runId)) throw new Error('Usage: /apply RUN_ID JOB_ID (run must belong to this chat)');
          const message = await applyChatPatch(root, state, runId, jobId);
          state.pendingContext.push(message); state.messages.push({ role: 'system', text: message, at: new Date().toISOString() }); await session.save();
          print(message); continue;
        }
        if (input.startsWith('/')) {
          if (input.trim() === '/jev on') await loadJevEnv(root, jevEnvSource() ?? process.env.CWF_ENV_FILE);
          const result = await session.command(input);
          if (['/status', '/orchestrate', '/agents', '/model', '/jev'].includes(input.trim().split(/\s+/)[0]!)) {
            console.log(renderChatState(state, width()));
            console.log(renderJevPanel(state.config, {}, width(), state.orchestrate).join('\n'));
            if (input.trim() === '/status') print(result.text);
          }
          else print(result.text);
          if (input.startsWith('/model') && premiumWarning(state.profile)) console.log(renderChatLabel('SYSTEM', premiumWarning(state.profile)!, width()));
          if (input.trim() === '/jev on') console.log(renderChatLabel('SYSTEM', `Jev is hosted by TypeSafe. ${state.config.jev?.shareTaskText ? 'Task text sharing is ON.' : 'Only routing metadata leaves this runner; semantic decisions use local fallback.'}`, width()));
          if (result.exit) break;
          continue;
        }
        console.log();
        console.log(renderChatLabel('YOU', input.replace(/\s+/g, ' '), width()));
        const notice = premiumWarning(state.profile);
        if (notice) console.log(renderChatLabel('SYSTEM', notice, width()));
        currentActivity = new ChatActivity(state, input.replace(/\s+/g, ' '));
        currentActivity.start();
        const result = await session.turn(input, workflow, event => currentActivity?.event(event));
        currentActivity?.stop(); currentActivity = undefined;
        console.log(); print(result); console.log();
      } catch (error) {
        currentActivity?.stop(); currentActivity = undefined;
        console.log(); console.log(renderChatLabel('ERROR', friendlyError(error), width()));
        console.log(renderChatLabel('SYSTEM', 'Chat remains open. Use /status or send another prompt.', width())); console.log();
      }
    }
  } finally {
    currentActivity?.stop();
    inputReader.close();
    process.off('SIGINT', stop); process.off('SIGTERM', terminate);
    await session.save(); await session.close();
    print(`\nChat saved. Resume: cwf chat ${state.id}`);
  }
  return freshChat;
}
