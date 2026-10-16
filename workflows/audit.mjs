export const meta = { name: 'audit', description: 'Parallel code audit with independent finding verification and optional isolated fixes' };

const finding = {
  type: 'object', additionalProperties: false, required: ['title', 'file', 'line', 'evidence', 'severity'],
  properties: { title: { type: 'string' }, file: { type: 'string' }, line: { type: 'integer', minimum: 1 },
    evidence: { type: 'string' }, severity: { enum: ['critical', 'high', 'medium', 'low'] } },
};
const scanSchema = { type: 'object', additionalProperties: false, required: ['findings'], properties: { findings: { type: 'array', maxItems: 5, items: finding } } };
const findingCheck = { type: 'object', additionalProperties: false, required: ['confirmed', 'evidence'], properties: { confirmed: { type: 'boolean' }, evidence: { type: 'string' } } };
const patchCheck = { type: 'object', additionalProperties: false, required: ['passed', 'evidence', 'remaining'], properties: { passed: { type: 'boolean' }, evidence: { type: 'string' }, remaining: { type: 'string' } } };

export default async function ({ args, agent, pipeline, phase, log, repeat, acceptPatch }) {
  const targets = args.targets ?? ['.'];
  if (!Array.isArray(targets) || !targets.length || targets.length > 30 || targets.some(target => typeof target !== 'string' || !target || target.includes('..') || /^(?:[A-Za-z]:|[\\/])/.test(target))) throw new Error('Pass 1-30 repository-relative targets');
  const question = args.question ?? 'Find reproducible correctness, security, and regression bugs. Ignore style preferences.';
  phase('Scan');
  const scans = await pipeline(targets, (target, index) => agent(`Audit ${JSON.stringify(target)}. ${question}\nUse targeted reads. Report only findings with exact repository-relative files, line numbers, and a concrete failure scenario. Return an empty list when there is no defensible finding. Limit yourself to the most important 5 findings.`,
    { id: `scan-${index}`, role: 'scan', label: target, schema: scanSchema }));
  const unique = new Map();
  for (const scan of scans) for (const item of scan?.findings ?? []) {
    const key = `${item.file}:${item.line}:${item.title}`; if (!unique.has(key)) unique.set(key, item);
  }
  const candidates = [...unique.values()];
  if (candidates.length > 30) throw new Error(`Audit produced ${candidates.length} candidates. Narrow the targets so every candidate can be verified; no findings have been silently discarded.`);
  log(`${candidates.length} candidate findings; each requires independent verification`);
  phase('Verify findings');
  const verified = await pipeline(candidates, async (item, index) => {
    const verdict = await agent(`Independently investigate this candidate bug. Do not assume the scanner is correct. Read the real call path and find a reproduction or strong evidence. Reject speculation. Candidate:\n${JSON.stringify(item)}`,
      { id: `finding-${index}`, role: 'verify', label: item.title, schema: findingCheck });
    return { ...item, ...verdict, index };
  });
  const confirmed = verified.filter(item => item?.confirmed);
  const rejected = verified.filter(item => item && !item.confirmed);
  const patches = [];
  if (args.fix && confirmed.length) {
    phase('Edit and test');
    const fixed = await pipeline(confirmed, async item => {
      let workspace, feedback = '';
      const attempt = await repeat({ maxRounds: 2, noProgressRounds: 2 }, async round => {
        const id = `fix-${item.index}-${round}`;
        await agent(`Fix this verified finding with the smallest defensible change. Read the relevant files and tests first. Run meaningful targeted checks if available. Do not modify unrelated files or commit. Report the actual change and checks.\n${JSON.stringify(item)}\nPrevious verifier feedback: ${feedback}`,
          { id, role: 'edit', label: `${item.title} / round ${round + 1}`, ...(workspace ? { workspace } : {}) });
        workspace = id;
        const verifierId = `patch-${item.index}-${round}`;
        const verdict = await agent(`Independently inspect the full diff in this worktree for this finding. Run the relevant existing tests if the sandbox permits them. Check the fix and new regression risks. Set passed=true only with sufficient evidence; missing required dependencies or blocked essential tests mean passed=false. Finding:\n${JSON.stringify(item)}`,
          { id: verifierId, role: 'verify', label: `Check patch / ${item.title}`, workspace: id, schema: patchCheck });
        if (verdict.passed) await acceptPatch(id, verifierId);
        feedback = verdict.remaining;
        return { done: verdict.passed, progressKey: verdict.remaining, result: { edit: id, verifier: verifierId, ...verdict } };
      });
      return { finding: item.title, stopped: attempt.stopped, ...attempt.result };
    });
    patches.push(...fixed.filter(Boolean));
  }
  phase('Review');
  const summary = `${confirmed.length} confirmed, ${rejected.length} rejected, ${candidates.length - verified.filter(Boolean).length} unverified; ${scans.filter(item => !item).length} scans failed. ${patches.filter(p => p.passed).length} verified isolated patches. Inspect evidence and reports; patches have not been applied. A completed run does not prove the repository is bug-free.`;
  return { summary, confirmed, rejected, patches, unverified: candidates.length - verified.filter(Boolean).length };
}
