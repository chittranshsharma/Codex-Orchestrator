export const meta = { name: 'architecture-review', description: 'Explore two code areas and independently check the resulting review' };
export default async function ({ args, agent, pipeline, phase }) {
  phase('Explore');
  const areas = args.targets ?? ['src', 'test'];
  const notes = await pipeline(areas, (area, index) => agent(`Explain the architecture and important risks under ${JSON.stringify(area)}. Cite exact files and symbols.`, { id: `explore-${index}`, role: 'scan', label: area }));
  phase('Cross-check');
  const checked = await agent(`Check the following notes against the repository. Correct unsupported claims and preserve citations.\n${JSON.stringify(notes)}`, { id: 'check', role: 'verify' });
  phase('Report');
  return agent(`Write a concise architecture review using only these checked notes:\n${checked}`, { id: 'report', role: 'review' });
}
