import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, readdir, mkdir, cp, lstat, access } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { AgentPicker } from './selection.js';
import { reviewAndLaunch } from './guided.js';
import { runChat } from './chat-ui.js';
import { listChats } from './chat.js';
import { defaultConfig, loadConfig } from './config.js';
import { Runtime, createRun, resumeRun, writeReport } from './runtime.js';
import { Store, stateRoot, runPath, readState } from './storage.js';
import { repository, applyPatch } from './git.js';
import { CodexProvider } from './provider.js';
import { attachDashboard, renderDashboard, clean } from './dashboard.js';
import { demoRepo, demoWorkflow, DemoProvider, demoState } from './demo.js';
import { authoringReference, plannerWorkflow } from './planner.js';
import { roles } from './types.js';
import { createJudge } from './jev.js';
import type { Provider, Role, Effort } from './types.js';
const exec = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const help = `Codex Orchestrator 0.5.1
Scripted workflows, automatic role-based model routing, isolated edits, live telemetry.

  cwf                                        Open persistent chat; orchestration starts off
  cwf chat [CHAT_ID]                          Start or resume a chat with follow-ups
  cwf chats                                  List saved chats
  cwf start "your task"                       Plan, review, then launch real Codex jobs
  codex-workflow init                         Create a repository model/routing config
  codex-workflow doctor [--live]              Check install/login; optionally probe models
  codex-workflow plan "task" --out task.mjs    Generate a workflow for review
  codex-workflow run audit --target src       Audit and independently verify findings
  codex-workflow run audit --fix              Also prepare isolated, verified patches
  codex-workflow run ./task.mjs --args-file inputs.json
  codex-workflow list                         List saved runs
  codex-workflow show RUN                     Show a run's report
  codex-workflow show RUN --script            Read the exact saved script
  codex-workflow watch RUN                    Watch a run from another terminal
  codex-workflow resume RUN                   Replay checkpoints and retry unfinished jobs
  codex-workflow save RUN --out saved.mjs      Save a run's script for reuse
  codex-workflow apply RUN --task JOB          Apply an independently verified patch
  codex-workflow demo                         Dashboard simulation, no model calls
  codex-workflow demo --snapshot              Print a static simulated dashboard
  codex-workflow install-skill                Enable $codex-workflow in Codex

Common options:
  --repo PATH       Git repository (default: current directory)
  --state-dir PATH  Durable state directory (or CWF_STATE_DIR)
  --plain           Plain text progress, suitable for Codex chat
  --json            JSON event output, suitable for scripts
  --tui             Force the interactive terminal dashboard
  --args JSON       Workflow input object
  --target PATH     Audit target, repeatable
  --question TEXT   Audit focus
  --concurrency N   Maximum active agents, default 4
  --max-agents N    Maximum total jobs per run, default 100
  --model ROLE=ID   Override a role's model, repeatable
  --effort ROLE=N   Override a role's reasoning effort, repeatable
  --jev            Enable Jev decisions and per-job model routing
  --no-jev         Use fixed role profiles for this run
  --manual         Choose model and effort before every job (default)
  --auto           Explicitly allow automatic role/Jev assignment
  --agents-file F  JSON map of exact job IDs to {model,effort} for manual runs
  --orchestrate    Start a new chat with orchestration on

Scripts are trusted local JavaScript. Read generated scripts before running them.
Worktrees and patches stay isolated until you explicitly use apply.
This is an independent tool built on the official Codex SDK.`;

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'V' },
    jev: { type: 'boolean' }, 'no-jev': { type: 'boolean' },
    manual: { type: 'boolean' }, auto: { type: 'boolean' }, 'agents-file': { type: 'string' },
    orchestrate: { type: 'boolean' },
    repo: { type: 'string' }, 'state-dir': { type: 'string' }, plain: { type: 'boolean' }, json: { type: 'boolean' }, tui: { type: 'boolean' },
    args: { type: 'string' }, 'args-file': { type: 'string' }, target: { type: 'string', multiple: true },
    fix: { type: 'boolean' }, question: { type: 'string' }, concurrency: { type: 'string' }, 'max-agents': { type: 'string' },
    model: { type: 'string', multiple: true }, effort: { type: 'string', multiple: true },
    out: { type: 'string' }, task: { type: 'string' }, script: { type: 'boolean' }, live: { type: 'boolean' }, snapshot: { type: 'boolean' },
  } });
  let [command, subject] = positionals;
  if (!command && !values.help && process.stdin.isTTY && process.stdout.isTTY) command = 'chat';
  if (values.version) { console.log('0.5.1'); return; }
  if (values.manual && values.auto) throw new Error('Choose --manual or --auto');
  if (values.auto && values['agents-file']) throw new Error('--agents-file requires manual mode');
  if (values.jev && values['no-jev']) throw new Error('Choose --jev or --no-jev');
  if (values.help || !command) { console.log(help); return; }
  const root = resolve(values['state-dir'] ?? stateRoot());
  const output = (value: unknown) => console.log(values.json ? JSON.stringify(value) : typeof value === 'string' ? value.split('\n').map(line => clean(line)).join('\n') : JSON.stringify(value, null, 2));
  if (!['chat', 'chats', 'start', 'init', 'doctor', 'plan', 'run', 'list', 'show', 'watch', 'resume', 'save', 'apply', 'demo', 'install-skill'].includes(command)) throw new Error(`Unknown command: ${command}. Use --help.`);
  if (!['plan', 'start'].includes(command) && positionals.length > 2) throw new Error('Unexpected positional arguments. Use --help.');
  if (command === 'start' && (!process.stdin.isTTY || !process.stdout.isTTY || values.plain || values.json)) throw new Error('start needs an interactive terminal. In command tools use plan "task" --out task.mjs, inspect it, then run task.mjs with explicit assignments or --auto.');
  if ([values.plain, values.json, values.tui].filter(Boolean).length > 1) throw new Error('Choose only one of --plain, --json, --tui');
  if (values.tui && (!process.stdout.isTTY || !process.stdin.isTTY)) throw new Error('--tui needs an interactive terminal. Use --plain or --json here.');
  const mode = values.json ? 'json' : values.plain || !process.stdout.isTTY || !process.stdin.isTTY ? 'plain' : 'tui';
  if (command === 'chat' && mode !== 'tui') throw new Error('chat needs an interactive terminal. Use run/plan with --plain or --json in command tools.');
  if (command === 'chats') {
    const chats = await listChats(root);
    output(values.json ? chats.map(c => ({ id: c.id, repo: c.repo, updatedAt: c.updatedAt, orchestrate: c.orchestrate, messages: c.messages.length })) : chats.map(c => `${c.id}  ${c.orchestrate ? 'ON' : 'OFF'}  ${c.messages.length} messages  ${c.repo}`).join('\n') || 'No saved chats');
    return;
  }
  if (command === 'install-skill') {
    const skillHome = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'skills');
    const destination = join(skillHome, 'codex-workflow');
    try { await lstat(destination); throw new Error(`Skill already exists at ${destination}; inspect it before replacing it`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await mkdir(skillHome, { recursive: true });
    await cp(join(packageRoot, 'skill', 'codex-workflow'), destination, { recursive: true, errorOnExist: true, force: false });
    output(`Installed ${destination}. Start a new Codex chat or reload skills to discover $codex-workflow.`); return;
  }
  if (command === 'list') {
    let ids: string[] = [];
    try { ids = await readdir(join(root, 'runs')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const runs = [];
    for (const id of ids.sort().reverse()) {
      try { const state = await readState(runPath(root, id)); runs.push({ id, name: state.name, status: state.status, jobs: Object.keys(state.tasks).length, repo: state.repo }); }
      catch { /* Incomplete directories are not runnable checkpoints. */ }
    }
    output(values.json ? runs : runs.map(run => `${run.id}  ${run.status.padEnd(10)} ${run.name}  (${run.jobs} jobs)`).join('\n') || 'No saved runs'); return;
  }
  if (['show', 'save', 'apply', 'watch', 'resume'].includes(command)) {
    if (!subject) throw new Error(`${command} needs a run ID`);
    const store = await resumeRun(root, subject);
    if (command === 'show') {
      if (values.json) output(store.state);
      else if (values.script) process.stdout.write(await readFile(join(store.directory, 'workflow.mjs'), 'utf8'));
      else process.stdout.write(await readFile(await writeReport(store), 'utf8'));
      return;
    }
    if (command === 'save') {
      if (!values.out) throw new Error('save needs --out PATH.mjs');
      await writeFile(resolve(values.out), await readFile(join(store.directory, 'workflow.mjs')), { flag: 'wx' }); output(`Saved ${resolve(values.out)}`); return;
    }
    if (command === 'apply') {
      if (!values.task) throw new Error('apply needs --task JOB');
      await store.lock();
      try { await applyPatch(store, values.task); await writeReport(store); output(`Applied ${values.task}. Review the main checkout diff before committing.`); }
      finally { await store.close(); }
      return;
    }
    if (command === 'watch') { await watch(store, mode); return; }
    if (values.manual || values.auto || values['agents-file'] || values.jev || values['no-jev'] || values.model || values.effort || values.concurrency || values['max-agents'] || values.args || values['args-file'] || values.fix || values.target || values.question) throw new Error('Resume uses the original script, args and model settings. Start a new run to change them.');
    await execute(store, new CodexProvider(store.state.config), mode); return;
  }
  if (command === 'demo') {
    const config = structuredClone(defaultConfig); config.selectionMode = values.manual ? 'manual' : 'auto';
    if (values['agents-file']) { config.assignments = JSON.parse(await readFile(resolve(values['agents-file']), 'utf8')); config.selectionMode = 'manual'; }
    const checked = await loadConfig(packageRoot, config);
    if (values.snapshot) { console.log(renderDashboard(demoState(checked), { width: process.stdout.columns ?? 108, height: 42, demo: true })); return; }
    const repo = await demoRepo();
    const store = await createRun(root, repo, demoWorkflow, {}, checked);
    await execute(store, new DemoProvider(), mode, true); return;
  }
  const repoPath = resolve(values.repo ?? process.cwd());
  let config = await loadConfig(repoPath);
  config = structuredClone(config);
  if (values.manual || values.auto || values['agents-file']) config.selectionMode = values.auto ? 'auto' : 'manual';
  if (values['agents-file']) config.assignments = JSON.parse(await readFile(resolve(values['agents-file']), 'utf8'));
  if (values.jev || values['no-jev']) config.jev!.enabled = Boolean(values.jev);
  for (const override of values.model ?? []) {
    const index = override.indexOf('='); const role = override.slice(0, index) as Role;
    if (index < 1 || !roles.includes(role)) throw new Error('--model must be ROLE=MODEL');
    config.roles[role].model = override.slice(index + 1);
  }
  for (const override of values.effort ?? []) {
    const [role, effort] = override.split('=') as [Role, Effort];
    if (!roles.includes(role)) throw new Error('--effort must be ROLE=EFFORT');
    config.roles[role].effort = effort;
  }
  if (values.concurrency) config.concurrency = Number(values.concurrency);
  if (values['max-agents']) config.maxAgents = Number(values['max-agents']);
  config = await loadConfig(repoPath, config);
  if (command === 'init') {
    const path = join(repoPath, '.codex-workflow.json'); await writeFile(path, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
    output(`Created ${path}. Review models and limits, then commit the config before edit workflows.`); return;
  }
  if (command === 'doctor') {
    const binary = config.codexPath ?? 'codex';
    const checks: Record<string, unknown> = { node: process.version, stateDirectory: root, routing: config.roles };
    checks.jev = { enabled: config.jev?.enabled ?? false, model: config.jev?.model, keyConfigured: Boolean(process.env.TYPESAFE_API_KEY) };
    for (const [name, args] of [['git', ['--version']], [binary, ['--version']], [binary, ['login', 'status']]] as const) {
      const label = name === 'git' ? 'git' : args.length === 1 ? 'installedCodexCLI' : 'login';
      try { const result = await exec(name, [...args], { windowsHide: true }); checks[label] = (result.stdout + result.stderr).trim(); }
      catch (error) { checks[label] = String(error); process.exitCode = 1; }
    }
    if (values.live) {
      if (config.jev?.enabled) {
        const judgment = await createJudge(config.jev)({ task: 'Read one known file and report its exported function names' }, {
          id: 'jev-probe', instructions: 'Does this task require simple inspection or complex reasoning?',
          choices: { simple: 'Bounded local lookup', complex: 'Multi-step ambiguous analysis' }, fallback: 'complex',
        }, AbortSignal.timeout(config.jev.timeoutMs));
        checks.jevProbe = judgment;
        if (judgment.error && !judgment.probabilities.simple) process.exitCode = 1;
      }
      const provider = new CodexProvider(config); const probes = [];
      for (const [model, profile] of new Map(Object.values(config.roles).map(profile => [profile.model, profile]))) {
        try {
          const result = await provider.run({ prompt: 'Do not call any tools. Return {"ok":true}. This is a connectivity check.',
            options: { id: 'probe', role: 'scan', schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } } },
            profile, cwd: repoPath, signal: AbortSignal.timeout(90_000), emit: async () => {} });
          probes.push({ model, result: result.result, usage: result.usage });
        } catch (error) { probes.push({ model, error: String(error) }); process.exitCode = 1; }
      }
      checks.liveProbes = probes;
    }
    output(checks); return;
  }
  const repo = await repository(repoPath);
  if (command === 'chat') {
    if (subject && (values.orchestrate || values.auto || values.manual || values.jev || values['no-jev'] || values['agents-file'] || values.model || values.effort)) throw new Error('Resume a chat with its saved settings, then use /orchestrate, /agents, /model or /jev to change them.');
    await runChat(root, repo, config, execute, subject, values.orchestrate); return;
  }
  let guidedRequest = positionals.slice(1).join(' ');
  if (command === 'start' && !guidedRequest) {
    console.log('\nCODEX ORCHESTRATOR / REAL TASK\nDescribe a task for this repository. Use codex separately for ordinary chat.');
    guidedRequest = (await question('What would you like to work on? ')).trim();
    if (!guidedRequest) { output('No task entered. Nothing started.'); return; }
  }
  if (['run', 'plan', 'start'].includes(command) && !values.manual && !values.auto && !values['agents-file'] && mode === 'tui') {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log('\nCODEX ORCHESTRATOR / AGENT ASSIGNMENT\n  Manual: approve the model and effort before every job.\n  Auto: allow configured role routing' + (config.jev?.enabled ? ' and Jev decisions.' : '.'));
      let selected = '';
      do { selected = (await input.question('Choose [M]anual or [A]uto (default M): ')).trim().toLowerCase(); } while (!['', 'm', 'manual', 'a', 'auto'].includes(selected));
      config.selectionMode = ['a', 'auto'].includes(selected) ? 'auto' : 'manual';
    } finally { input.close(); }
  }
  if (command === 'plan' || command === 'start') {
    const request = command === 'start' ? guidedRequest : positionals.slice(1).join(' ');
    if (!request || (command === 'plan' && !values.out)) throw new Error('Usage: codex-workflow plan "task" --out workflow.mjs');
    const path = values.out ? resolve(values.out) : undefined;
    if (path) {
    if (!path.endsWith('.mjs')) throw new Error('Workflow output must end in .mjs');
    try { await access(path); throw new Error('Output already exists; choose another --out path'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const store = await createRun(root, repo, plannerWorkflow, { request, reference: authoringReference }, config);
    await execute(store, new CodexProvider(config), mode);
    const generated = store.state.result as { source?: string };
    if (!generated?.source) throw new Error('Planner returned no source');
    const candidate = join(store.directory, 'generated.mjs'); await writeFile(candidate, generated.source);
    await exec(process.execPath, ['--check', candidate], { windowsHide: true });
    if (path) await writeFile(path, generated.source, { flag: 'wx' });
    if (command === 'plan') { output(`Saved ${path}. Read the script before running: codex-workflow run "${path}"`); return; }
    if (values.args && values['args-file']) throw new Error('Choose --args or --args-file');
    const input = values['args-file'] ? JSON.parse(await readFile(resolve(values['args-file']), 'utf8')) : values.args ? JSON.parse(values.args) : {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Workflow args must be a JSON object');
    const args = { request, ...input, ...(values.target ? { targets: values.target } : {}), ...(values.fix ? { fix: true } : {}) };
    const launched = await reviewAndLaunch({
      path: candidate,
      preview: source => { output(`\nGENERATED WORKFLOW / ${path ?? candidate}\n${source}\n\nRead this trusted JavaScript before launching. Jobs use real Codex sessions and your account limits. Changes are prepared in isolated worktrees; applying patches is a separate action.`); },
      confirm: () => question('Type RUN to execute this workflow, or Enter to save and exit: '),
      launch: async source => {
        const run = await createRun(root, repo, source, args, config);
        await execute(run, new CodexProvider(config), mode);
        output(`\nTask result:\n${typeof run.state.result === 'string' ? run.state.result : JSON.stringify(run.state.result, null, 2)}`);
        output('Inspect the report and any verified patches. Use cwf apply RUN_ID --task EDIT_JOB_ID when ready.');
      },
    });
    if (!launched) output(`Saved without running: ${path ?? candidate}\nLater: cwf run "${path ?? candidate}" --manual`);
    return;
  }
  if (command !== 'run') throw new Error(`Unknown command: ${command}. Use --help.`);
  if (!subject) throw new Error('run needs a bundled workflow name or a .mjs path');
  if (values.args && values['args-file']) throw new Error('Choose --args or --args-file');
  let args = values['args-file'] ? JSON.parse(await readFile(resolve(values['args-file']), 'utf8')) : values.args ? JSON.parse(values.args) : {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Workflow args must be a JSON object');
  if (values.fix) args.fix = true;
  if (values.target) args.targets = values.target;
  if (values.question) args.question = values.question;
  const path = ['audit', 'example', 'jev-review'].includes(subject) ? join(packageRoot, 'workflows', `${subject}.mjs`) : resolve(subject);
  const source = await readFile(path, 'utf8');
  const store = await createRun(root, repo, source, args, config);
  await execute(store, new CodexProvider(config), mode);
}

async function question(prompt: string): Promise<string> {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try { return await input.question(prompt); } finally { input.close(); }
}

async function execute(store: Store, provider: Provider, mode: 'tui' | 'plain' | 'json', demo = false, signal?: AbortSignal): Promise<void> {
  const picker = mode === 'tui' ? new AgentPicker() : undefined;
  const runtime = new Runtime(store, provider, undefined, picker?.select); const detach = attachDashboard(runtime, mode, demo, picker);
  const onStop = () => runtime.stop(); process.on('SIGINT', onStop); process.on('SIGTERM', onStop);
  if (signal?.aborted) runtime.stop();
  signal?.addEventListener('abort', onStop, { once: true });
  let error: unknown;
  try { await runtime.run(); } catch (caught) { error = caught; }
  finally { detach(); process.off('SIGINT', onStop); process.off('SIGTERM', onStop); signal?.removeEventListener('abort', onStop); }
  const report = await writeReport(store);
  const result = { type: 'summary', run: store.state.id, status: store.state.status, report, ...(demo ? { simulation: true } : {}) };
  console.log(mode === 'json' ? JSON.stringify(result) : `\nRun ${store.state.id}: ${store.state.status}\nReport: ${report}\nInspect: codex-workflow show ${store.state.id}`);
  if (error) throw error;
  if (store.state.status === 'partial') process.exitCode = 2;
}

async function watch(store: Store, mode: string): Promise<void> {
  if (mode !== 'tui') { console.log(JSON.stringify(store.state, null, 2)); return; }
  process.stdout.write('\x1b[?1049h\x1b[?25l'); emitKeypressEvents(process.stdin);
  const priorRaw = process.stdin.isRaw; process.stdin.setRawMode(true); process.stdin.resume();
  let quit = false;
  const key = (_text: string, event: { name?: string; ctrl?: boolean }) => { if (event.name === 'q' || (event.ctrl && event.name === 'c')) quit = true; };
  process.stdin.on('keypress', key);
  try {
    while (!quit) {
      const state = await readState(store.directory);
      const screen = renderDashboard(state, { width: process.stdout.columns, height: (process.stdout.rows ?? 36) - 2 });
      process.stdout.write('\x1b[H\x1b[2J' + screen + '\nWATCH ONLY / q close viewer');
      if (!['running', 'paused'].includes(state.status)) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } finally { process.stdin.off('keypress', key); process.stdin.setRawMode(Boolean(priorRaw)); process.stdin.pause(); process.stdout.write('\x1b[?25h\x1b[?1049l'); }
}
