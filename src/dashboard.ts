import { emitKeypressEvents } from 'node:readline';
import type { Runtime } from './runtime.js';
import type { RunState } from './types.js';
import type { AgentPicker } from './selection.js';

const reset = '\x1b[0m';
const palette = { plan: 183, scan: 117, edit: 215, verify: 157, review: 183, muted: 250, line: 60, text: 255, error: 203 };
const paint = (text: string, tint = palette.text) => `\x1b[38;5;${tint}m${text}${reset}`;
const bold = (text: string) => `\x1b[1m${text}${reset}`;
export const clean = (text: unknown) => String(text ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/[^\x20-\x7e]/g, '?');
const clip = (text: unknown, width: number) => { const s = clean(text); return s.length > width ? s.slice(0, Math.max(0, width - 1)) + '~' : s; };
const pad = (text: unknown, width: number) => clip(text, width).padEnd(width);
const num = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}m` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
const rule = (title: string, width: number) => paint(clip(` -- ${title} `, width), palette.muted) + paint('-'.repeat(Math.max(0, width - title.length - 5)), palette.line);
const status = { queued: 'WAIT', running: 'LIVE', completed: 'DONE', failed: 'FAIL', cancelled: 'STOP', skipped: 'SKIP' };
export interface ViewOptions { width?: number; height?: number; selected?: number; details?: boolean; logs?: string[]; demo?: boolean }

export function renderDashboard(state: RunState, options: ViewOptions = {}): string {
  const width = Math.max(24, Math.min(options.width ?? 110, 180)), height = Math.max(12, options.height ?? 36);
  const tasks = Object.values(state.tasks), done = tasks.filter(t => t.status === 'completed').length;
  const running = tasks.filter(t => t.status === 'running').length, failed = tasks.filter(t => t.status === 'failed').length;
  const usage = tasks.reduce((a, t) => a + t.usage.input_tokens + t.usage.output_tokens, 0);
  const elapsed = Math.max(0, Math.floor((Date.parse(state.endedAt ?? new Date().toISOString()) - Date.parse(state.createdAt)) / 1000));
  const mode = state.config.selectionMode === 'manual' ? 'MANUAL / you assign every job' : state.config.jev?.enabled ? 'AUTO / Jev routing' : 'AUTO / role profiles';
  const lines = [`\x1b[48;5;24m${bold(paint(pad(' CODEX ORCHESTRATOR' + (options.demo ? '  [SIMULATION]' : ''), width)))}`,
    paint(pad(` ${state.name}  /  ${state.status.toUpperCase()}`, width), state.status === 'failed' ? palette.error : palette.scan),
    paint(pad(` ${mode}`, width), palette.muted),
    pad(` ${running}/${state.config.concurrency} active   ${done}/${tasks.length} done   ${failed} failed   ${num(usage)} tokens   ${elapsed}s`, width),
    paint(pad(` ${state.id}  ${state.repo}`, width), palette.muted)];

  if (height >= 24) {
    lines.push('', rule('PIPELINE', width));
    const phases = state.phases.length ? state.phases : ['Waiting for workflow'];
    for (const phase of phases.slice(-Math.min(4, Math.floor(height / 8)))) {
      const jobs = tasks.filter(t => t.phase === phase), complete = jobs.filter(t => t.status === 'completed').length;
      const live = jobs.some(t => t.status === 'running'), broken = jobs.some(t => t.status === 'failed');
      const barSize = Math.max(4, Math.min(26, width - 37)), fill = jobs.length ? Math.round(complete / jobs.length * barSize) : 0;
      lines.push(paint(clip(` ${live ? '>' : ' '} ${pad(phase, 12)} [${'='.repeat(fill)}${'.'.repeat(barSize - fill)}] ${complete}/${jobs.length} ${broken ? 'FAILED' : live ? 'RUNNING' : complete && complete === jobs.length ? 'COMPLETE' : 'QUEUED'}`, width), broken ? palette.error : palette[jobs[0]?.role ?? 'scan']));
    }
  }
  const selected = Math.min(Math.max(0, options.selected ?? 0), Math.max(0, tasks.length - 1));
  lines.push('', rule(options.details ? 'AGENT DETAIL' : 'AGENT ROSTER', width));
  const available = Math.max(1, height - lines.length - (height >= 30 ? 6 : 2));
  if (options.details && tasks[selected]) {
    const t = tasks[selected]!;
    const rows = [` ${t.label}  [${status[t.status]}]`, ` ${t.role} / ${t.model} / effort ${t.effort}`,
      ` Assignment: ${t.assignment ? 'manual selection' : t.routing ? 'Jev' : 'role profile'}`,
      ...(t.routing ? [` Jev: ${t.routing.choice} / confidence ${t.routing.confidence.toFixed(2)}${t.routing.fallback ? ' / FALLBACK' : ''}`, ...(t.routing.error ? [` ${t.routing.error}`] : [])] : []),
      ` ${t.error ?? t.activity ?? 'Waiting for activity'}`, ` Attempts ${t.attempts} / ${num(t.usage.input_tokens)} input / ${num(t.usage.output_tokens)} output`,
      ...(t.patch ? [` Patch: ${t.verifiedBy ? 'VERIFIED' : 'UNVERIFIED'} / ${t.patch}`] : [])];
    lines.push(...rows.slice(0, available).map(row => paint(clip(row, width), palette[t.role])));
  } else {
    const start = Math.max(0, selected - available + 1);
    for (const [index, t] of tasks.slice(start, start + available).entries()) {
      const pointer = start + index === selected ? '>' : ' ';
      const row = width >= 85
        ? ` ${pointer} ${status[t.status]} ${pad(t.label, width - 55)} ${pad(t.role, 7)} ${pad(t.model, 21)} ${t.effort}`
        : ` ${pointer} ${status[t.status]} ${t.label} / ${t.model}`;
      const text = paint(clip(row, width), t.status === 'failed' ? palette.error : palette[t.role]);
      lines.push(start + index === selected ? `\x1b[48;5;236m${text}` : text);
    }
    if (!tasks.length) lines.push(paint(clip(' No jobs yet. Preparing workflow...', width), palette.muted));
  }
  const room = height - lines.length - 4;
  if (room > 0 && options.logs?.length) lines.push('', rule('EVENT STREAM', width), ...options.logs.slice(-room).map(log => paint(clip(` ${log}`, width), palette.muted)));
  const footer = ' p pause  q save & exit  Enter details  up/down select';
  return [...lines.slice(0, height - 2), '', paint(clip(footer, width), palette.scan)].join('\n');
}

export function renderSelection(picker: AgentPicker, width = 100, height = 30): string {
  width = Math.max(24, width); height = Math.max(12, height);
  const request = picker.request;
  if (!request) return '';
  const lines = [bold(paint(clip(' ASSIGN AGENT / MANUAL', width), palette.edit)),
    paint(clip(` ${request.options.label ?? request.options.id} / ${request.options.role}`, width), palette.text),
    paint(clip(` Job ID: ${request.options.id}`, width), palette.muted), '',
    rule(picker.showPrompt ? 'JOB PROMPT / up-down scroll' : 'CHOOSE A MODEL', width)];
  if (picker.showPrompt) {
    const prompt = clean(request.prompt).slice(picker.promptOffset);
    for (let row = 0; row < height - 10 && row * (width - 2) < prompt.length; row++) lines.push(' ' + prompt.slice(row * (width - 2), (row + 1) * (width - 2)));
  } else {
    const room = Math.max(1, height - 12), start = Math.max(0, picker.index - room + 1);
    request.profiles.slice(start, start + room).forEach((p, i) => lines.push(paint(clip(` ${start + i === picker.index ? '>' : ' '} ${p.model} / ${p.effort}`, width), start + i === picker.index ? palette.scan : palette.muted)));
    lines.push('', paint(clip(` Model: ${picker.custom || request.profiles[picker.index]!.model}${picker.editing ? '_' : ''}`, width), palette.text),
      paint(clip(` Effort: ${picker.effort}  [E to change]`, width), palette.edit),
      paint(clip(picker.editing ? ' Type model ID; Enter finishes typing' : ' Enter confirms this job. No job starts without selection.', width), palette.verify));
  }
  if (picker.error) lines.push(paint(clip(picker.error, width), palette.error));
  return [...lines.slice(0, height - 2), '', paint(clip(' up/down model  E effort  M custom  Tab prompt  Ctrl+C cancel', width), palette.scan)].join('\n');
}

export function attachDashboard(runtime: Runtime, mode: 'tui' | 'plain' | 'json', demo = false, picker?: AgentPicker): () => void {
  let selected = 0, details = false, dirty = true, lastSecond = -1; const logs: string[] = [];
  const update = () => { dirty = true; };
  const event = (value: Record<string, unknown>) => {
    if (value.type !== 'codex.event') {
      const message = `${new Date().toLocaleTimeString()} ${value.type}${value.id ? ` / ${value.id}` : ''}${value.error ? ` / ${value.error}` : ''}${value.message ? ` / ${value.message}` : ''}`;
      logs.push(message); if (logs.length > 50) logs.shift();
      if (mode === 'plain') console.log(clean(message));
      if (mode === 'json') console.log(JSON.stringify(value));
    }
    dirty = true;
  };
  const draw = () => {
    const second = Math.floor(Date.now() / 1000);
    if (second !== lastSecond) { dirty = true; lastSecond = second; }
    if (mode !== 'tui' || !dirty) return;
    dirty = false;
    const width = process.stdout.columns ?? 100, height = (process.stdout.rows ?? 36) - 1;
    const screen = picker?.request ? renderSelection(picker, width, height) : renderDashboard(runtime.state, { width, height, selected, details, logs, demo });
    process.stdout.write('\x1b[H\x1b[2J' + screen);
  };
  const keypress = (text: string, key: { name?: string; ctrl?: boolean }) => {
    if (key.ctrl && key.name === 'c') { runtime.stop(); return; }
    if (picker?.request) { picker.key(text ?? '', key); return; }
    if (key.name === 'q') runtime.stop();
    if (key.name === 'p') runtime.state.status === 'paused' ? runtime.resume() : runtime.pause();
    if (key.name === 'up') selected = Math.max(0, selected - 1);
    if (key.name === 'down') selected = Math.min(Math.max(0, Object.keys(runtime.state.tasks).length - 1), selected + 1);
    if (key.name === 'return') details = !details;
    dirty = true;
  };
  runtime.on('update', update); runtime.on('event', event); picker?.on('update', update);
  let timer: NodeJS.Timeout | undefined;
  const priorRaw = process.stdin.isRaw;
  if (mode === 'tui') {
    process.stdout.write('\x1b[?1049h\x1b[?25l');
    emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('keypress', keypress);
    timer = setInterval(draw, 100); draw();
  }
  return () => {
    runtime.off('update', update); runtime.off('event', event); picker?.off('update', update);
    if (timer) clearInterval(timer);
    if (mode === 'tui') {
      process.stdin.off('keypress', keypress); process.stdin.setRawMode(Boolean(priorRaw)); process.stdin.pause();
      process.stdout.write('\x1b[?25h\x1b[?1049l');
      process.stdout.write(renderDashboard(runtime.state, { width: process.stdout.columns, height: (process.stdout.rows ?? 36) - 1, selected, details, logs, demo }) + '\n');
    }
  };
}
