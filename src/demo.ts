import { setTimeout } from 'node:timers/promises';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from './git.js';
import { emptyUsage } from './types.js';
import type { Provider, ProviderRequest, ProviderResult, RunState, Config } from './types.js';

export const demoWorkflow = `export const meta={name:'SIMULATION / audit and repair',description:'Simulated jobs demonstrating the dashboard; no model calls'};
export default async function({agent,pipeline,phase,acceptPatch}) {
  phase('Plan'); await agent('Plan the simulation',{id:'plan',role:'plan'});
  phase('Scan'); await pipeline(['parser','router','storage'],(name,index)=>agent('Scan '+name,{id:'scan-'+index,role:'scan',label:name}));
  phase('Edit'); await agent('Fix the fixture',{id:'fix',role:'edit',label:'Repair fixture'});
  phase('Verify'); await agent('Verify the fix',{id:'verify',role:'verify',workspace:'fix',schema:{type:'object',required:['passed'],properties:{passed:{type:'boolean'}}}}); await acceptPatch('fix','verify');
  phase('Report'); return agent('Summarize the simulation',{id:'review',role:'review'});
}`;
export class DemoProvider implements Provider {
  async run(request: ProviderRequest): Promise<ProviderResult> {
    await request.emit({ type: 'thread.started', thread_id: `simulation-${request.options.id}` });
    for (let index = 0; index < 3; index++) {
      await setTimeout(300, undefined, { signal: request.signal });
      await request.emit({ type: 'item.started', item: { type: 'command_execution', command: `SIMULATION: ${request.options.role} step ${index + 1}` } });
    }
    if (request.options.role === 'edit') await writeFile(join(request.cwd, 'fixture.js'), 'export const value = 2;\n');
    const result = request.options.role === 'verify' ? { passed: true } : `SIMULATED ${request.options.role} completed; no model was called.`;
    await request.emit({ type: 'turn.completed', usage: emptyUsage() });
    return { result, usage: emptyUsage() };
  }
}
export async function demoRepo(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'codex-workflow-demo-'));
  await git(path, ['init', '--quiet']); await writeFile(join(path, 'fixture.js'), 'export const value = 1;\n');
  await git(path, ['add', 'fixture.js']);
  await git(path, ['-c', 'user.name=Codex Workflow Demo', '-c', 'user.email=demo@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Demo fixture']);
  return path;
}
export function demoState(config: Config): RunState {
  const state: RunState = { version: 1, id: 'demo-preview', name: 'Repository audit', description: 'Simulated display, no model calls',
    repo: 'C:/projects/my-app', head: '', fingerprint: '', workflowHash: '', args: {}, config,
    status: 'running', createdAt: new Date(Date.now() - 42_000).toISOString(), phases: ['Scan', 'Edit', 'Verify'], tasks: {}, applied: [], failures: [] };
  for (const [index, role] of (['scan', 'scan', 'scan', 'edit', 'verify'] as const).entries()) {
    const profile = config.roles[role];
    state.tasks[`demo-${index}`] = { id: `demo-${index}`, label: ['Inspect parser', 'Inspect auth', 'Inspect routes', 'Patch verified finding', 'Cross-check the patch'][index]!,
      phase: role[0]!.toUpperCase() + role.slice(1), role, ...profile, signature: '', attempts: 1,
      status: index === 4 ? 'running' : 'completed', usage: emptyUsage(), activity: 'SIMULATION: inspect regression test' };
  }
  return state;
}
