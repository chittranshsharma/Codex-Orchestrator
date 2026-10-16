export const meta = { name: 'jev-review', description: 'Jev selects a relevant target, then independently reviews findings' };
export default async function({ args, decide, agent, phase, log }) {
  const targets = args.targets;
  if (!Array.isArray(targets) || !targets.length || targets.length > 30 || targets.some(t => typeof t !== 'string' || !t.trim())) throw new Error('Supply 1–30 targets');
  phase('Select target');
  const choices = Object.fromEntries(targets.map((target, index) => [`target_${index}`, `Inspect repository target ${target}`]));
  choices.all = 'No single target clearly covers the question; inspect all supplied targets together';
  const selection = await decide({ targets, question: args.question ?? 'Find actionable correctness defects' }, {
    id: 'select-target', instructions: 'Which supplied target is most relevant to the question? Select all when evidence is insufficient or several targets are needed.', choices, fallback: 'all',
  });
  const selected = selection.choice === 'all' ? targets : [targets[Number(selection.choice.slice(7))]];
  log(`Selected: ${selected.join(', ')}`);
  phase('Inspect');
  const findings = await agent(`Inspect repository targets: ${JSON.stringify(selected)}. Focus: ${args.question ?? 'correctness defects'}. Read relevant files and provide concrete evidence. Do not edit.`, { id: 'inspect', role: 'scan' });
  phase('Independent review');
  return agent(`Independently verify each finding against repository evidence. Distinguish confirmed, refuted and unverified. Targets: ${JSON.stringify(selected)}. Findings: ${JSON.stringify(findings)}`, { id: 'review', role: 'verify' });
}
