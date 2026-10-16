import { emitKeypressEvents } from 'node:readline';
import type { Runtime } from './runtime.js';
import type { RunState, Role } from './types.js';

const reset = '\x1b[0m';
const colors = { plan: 183, scan: 117, edit: 215, verify: 157, review: 183, muted: 245, text: 252 };
const color = (text: string, value: number) => `\x1b[38;5;${value}m${text}${reset}`;
export const clean = (text: unknown) => String(text ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/[^\x20-\x7e]/g, '?');
const clip = (text: unknown, width: number) => { const value = clean(text); return value.length > width ? value.slice(0, Math.max(0, width - 1)) + '~' : value; };
const pad = (text: unknown, width: number) => clip(text, width).padEnd(width);
const number = (value: number) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}m` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
function box(title: string, rows: string[], width: number, tint = colors.muted): string[] {
  return [color('+- ' + pad(title, width - 6) + ' -+', tint),
    ...rows.map(row => color('|', tint) + ' ' + pad(row, width - 4) + ' ' + color('|', tint)),
    color('+' + '-'.repeat(width - 2) + '+', tint)];
}
export interface ViewOptions { width?: number; height?: number; selected?: number; details?: boolean; logs?: string[]; demo?: boolean }
export function renderDashboard(state: RunState, options: ViewOptions = {}): string {
  const width = Math.max(32, Math.min(options.width ?? 110, 160)), height = Math.max(16, options.height ?? 36);
  const tasks = Object.values(state.tasks), running = tasks.filter(task => task.status === 'running'), done = tasks.filter(task => task.status === 'completed').length;
  const tokens = tasks.reduce((total, task) => total + task.usage.input_tokens + task.usage.output_tokens, 0);
  const cached = tasks.reduce((total, task) => total + task.usage.cached_input_tokens, 0);
  const elapsed = Math.max(0, Math.floor((Date.parse(state.endedAt ?? new Date().toISOString()) - Date.parse(state.createdAt)) / 1000));
  const lines = [color(pad(' CODEX / WORKFLOW' + (options.demo ? '  [SIMULATION]' : ''), width), colors.text),
    color(pad(` ${state.name}  /  ${state.status.toUpperCase()}`, width), colors.plan), color('-'.repeat(width), colors.muted),
    pad(` ${running.length}/${state.config.concurrency} active   ${done}/${tasks.length} jobs done   ${number(tokens)} tokens   ${number(cached)} cached   ${elapsed}s`, width),
    color(pad(` ${state.id}  ${state.repo}`, width), colors.muted), ''];
  if (width >= 80 && height >= 30) {
    lines.push(...box(state.config.jev?.enabled ? 'JEV MODEL ROUTING / role fallbacks' : 'AUTOMATIC MODEL ROUTING', Object.entries(state.config.roles).map(([role, profile]) => `${pad(role, 8)} -> ${pad(profile.model, 22)} ${profile.effort}`), width, colors.plan), '');
  }
  const phases = state.phases.length ? state.phases : ['Waiting for workflow'];
  if (width >= 90) {
    const columns = Math.min(3, phases.length), cellWidth = Math.floor((width - (columns - 1) * 2) / columns);
    for (let i = 0; i < phases.length; i += columns) {
      const cards = phases.slice(i, i + columns).map(phase => {
        const jobs = tasks.filter(task => task.phase === phase), complete = jobs.filter(task => task.status === 'completed').length;
        const active = jobs.filter(task => task.status === 'running').length, failed = jobs.filter(task => task.status === 'failed').length;
        const count = jobs.length, barWidth = Math.max(1, cellWidth - 15), filled = count ? Math.floor(complete / count * barWidth) : 0;
        const tint = colors[(jobs[0]?.role ?? 'scan') as Role];
        return box(phase, [jobs[0]?.model ?? 'Waiting', `[${'#'.repeat(filled)}${'.'.repeat(barWidth - filled)}] ${complete}/${count}`,
          `${active} running  ${failed} failed`], cellWidth, tint);
      });
      for (let row = 0; row < 5; row++) lines.push(cards.map(card => card[row]).join('  '));
    }
  } else {
    for (const phase of phases.slice(-4)) {
      const jobs = tasks.filter(task => task.phase === phase);
      lines.push(clip(` ${phase}: ${jobs.filter(task => task.status === 'completed').length}/${jobs.length} done`, width));
    }
  }
  lines.push('');
  const detailTask = tasks[Math.min(options.selected ?? 0, Math.max(0, tasks.length - 1))];
  if (options.details && detailTask) {
    const detail = [detailTask.label, `${detailTask.role} / ${detailTask.model} / ${detailTask.effort}`, `status: ${detailTask.status}  attempts: ${detailTask.attempts}`,
      detailTask.routing ? `Jev: ${detailTask.routing.choice} / ${detailTask.routing.confidence.toFixed(2)}${detailTask.routing.fallback ? ' / fallback' : ''}` : '',
      detailTask.error ?? detailTask.activity ?? '', detailTask.threadId ? `thread: ${detailTask.threadId}` : '', detailTask.patch ? `patch: ${detailTask.patch} (${detailTask.verifiedBy ? 'verified' : 'unverified'})` : ''];
    lines.push(...box('SELECTED AGENT', detail.filter(Boolean), width, colors[detailTask.role]));
  } else {
    const available = Math.max(2, Math.min(7, height - lines.length - 5));
    const start = Math.max(0, Math.min(options.selected ?? 0, tasks.length - available));
    lines.push(color(pad(' AGENTS / up, down to select; enter for details', width), colors.muted));
    tasks.slice(start, start + available).forEach((task, index) => {
      const pointer = start + index === (options.selected ?? 0) ? '>' : ' ';
      const status = { queued: 'WAIT', running: 'RUN ', completed: 'DONE', failed: 'FAIL', cancelled: 'STOP', skipped: 'SKIP' }[task.status];
      lines.push(color(clip(` ${pointer} ${status}  ${pad(task.role, 7)} ${pad(task.label, Math.max(8, width - 48))} ${task.model}`, width), task.status === 'failed' ? 203 : colors[task.role]));
    });
    if (!tasks.length) lines.push(color(' Waiting for the first job...', colors.muted));
  }
  const logCount = Math.max(0, height - lines.length - 4);
  if (logCount) {
    lines.push('', color(pad(' SESSION LOG', width), colors.muted));
    lines.push(...(options.logs ?? []).slice(-logCount).map(log => color(clip(' ' + log, width), colors.muted)));
  }
  const footer = ['completed', 'partial', 'failed', 'cancelled'].includes(state.status)
    ? ` ${state.status.toUpperCase()} / inspect the report: codex-workflow show ${state.id}`
    : ' p pause/resume scheduling  q pause & exit  enter details  Ctrl+C stop';
  return [...lines.slice(0, height - 2), '', color(clip(footer, width), colors.muted)].join('\n');
}

export function attachDashboard(runtime: Runtime, mode: 'tui' | 'plain' | 'json', demo = false): () => void {
  let selected = 0, details = false, dirty = true; const logs: string[] = [];
  let lastSecond = -1;
  const update = () => { dirty = true; };
  const event = (value: Record<string, unknown>) => {
    const { type, id } = value;
    if (type !== 'codex.event') {
      const message = `${new Date().toLocaleTimeString()}  ${type}${id ? `  ${id}` : ''}${value.error ? `  ${value.error}` : ''}${value.message ? `  ${value.message}` : ''}`;
      logs.push(message); if (logs.length > 30) logs.shift();
      if (mode === 'plain') console.log(clean(message));
      if (mode === 'json') console.log(JSON.stringify(value));
    }
    dirty = true;
  };
  const draw = () => {
    const second = Math.floor(Date.now() / 1000);
    if (second !== lastSecond) { dirty = true; lastSecond = second; }
    if (mode !== 'tui' || !dirty) return; dirty = false;
    process.stdout.write('\x1b[H\x1b[2J' + renderDashboard(runtime.state, { width: process.stdout.columns, height: (process.stdout.rows ?? 36) - 1, selected, details, logs, demo }));
  };
  const keypress = (_text: string, key: { name?: string; ctrl?: boolean }) => {
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) runtime.stop();
    if (key.name === 'p') runtime.state.status === 'paused' ? runtime.resume() : runtime.pause();
    if (key.name === 'up') selected = Math.max(0, selected - 1);
    if (key.name === 'down') selected = Math.min(Math.max(0, Object.keys(runtime.state.tasks).length - 1), selected + 1);
    if (key.name === 'return') details = !details;
    dirty = true;
  };
  runtime.on('update', update); runtime.on('event', event);
  let timer: NodeJS.Timeout | undefined;
  const priorRaw = process.stdin.isRaw;
  if (mode === 'tui') {
    process.stdout.write('\x1b[?1049h\x1b[?25l');
    emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('keypress', keypress);
    timer = setInterval(draw, 125); draw();
  }
  return () => {
    runtime.off('update', update); runtime.off('event', event);
    if (timer) clearInterval(timer);
    if (mode === 'tui') {
      process.stdin.off('keypress', keypress); process.stdin.setRawMode(Boolean(priorRaw)); process.stdin.pause();
      process.stdout.write('\x1b[?25h\x1b[?1049l');
      process.stdout.write(renderDashboard(runtime.state, { width: process.stdout.columns, height: (process.stdout.rows ?? 36) - 1, selected, details, logs, demo }) + '\n');
    }
  };
}
