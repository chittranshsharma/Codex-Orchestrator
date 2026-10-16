---
name: codex-workflow
description: Run Codex Orchestrator when the user asks to use the orchestrator, cwf, multi-model workflows, or saved Codex workflows. Supports automatic task routing, explicit model choices, isolated edits, verification, and checkpoint resumption.
---

# Codex Orchestrator

When the user says “use orchestrator,” execute the task through `cwf` from the intended Git repository. In Codex app command tools use `--plain` or `--json`. Do not launch the interactive chat inside a command tool. A terminal dashboard can be opened separately with `cwf watch RUN_ID`.

Use automatic assignment unless the user asks for manual selection. Honor requested models before any call: use `--model ROLE=MODEL --effort ROLE=EFFORT` for role preferences, or `model`/`effort` in each `agent` option for task preferences. Exact job mappings can use `--agents-file PATH` in manual runs. Explicit assignments override routing. Warn the user before using `gpt-6-astra` or `gpt-6.1-sol`; the runner also emits a warning before each such call. Do not change an unavailable requested model silently.

For audits use `cwf run audit --target RELATIVE_PATH --auto --plain`; add `--fix` when fixes are requested. For other tasks, author a short trusted `.mjs` workflow yourself in this conversation, inspect it, then execute `cwf run PATH.mjs --auto --plain`. This avoids a second planning model call. Do not ask the user to choose workers unless they requested Manual. Do not call `cwf plan` when you can author the workflow here.

```js
export const meta = {name:'inspect',description:'Inspect the requested code'};
export default async function({agent,phase}) {
  phase('Inspect');
  return agent('Inspect the user-requested target. Return concise evidence.',
    {id:'inspect',role:'scan'});
}
```

Roles: `scan`, `plan`, `edit`, `verify`, `review`. Omit `model` to use local routing. `pipeline(items,callback)` and `parallel([functions])` return null for failed branches; report these failures. Schemas must have an object root. Editors receive isolated worktrees and require a clean source checkout. To verify a patch, run a separate `verify` job with `workspace:EDIT_ID` returning `{passed:true}` only on actual success, then `await acceptPatch(EDIT_ID,VERIFY_ID)`. Apply only when authorized with `cwf apply RUN_ID --task EDIT_ID`, then check the combined checkout diff and relevant integration tests.

Use the fewest workers needed. Group related reads; avoid redundant scans or summary workers. New defaults use Luna/Sol 6, two concurrent workers, a 16-job cap, and a reported 100000-token scheduling limit (`--token-budget N`). Running calls and unreported usage can exceed it. Model choice alone does not guarantee savings. Read the generated report before claiming completion; failed or unverified work remains visible.

Jev is optional and off by default. `cwf jev setup` prints the global env-file location; `--env-file PATH` reads only `TYPESAFE_API_KEY`. Never read or print the credential. `--jev` sends bounded routing metadata to hosted TypeSafe; `--jev-task-text` separately opts into sending job text and semantic decision state. Do not enable text disclosure without the user's informed request. Local routing works without Jev. Its probabilities are not proof of correctness or savings.

Start fresh by default. Resume only when asked: `cwf resume RUN_ID --plain` replays saved configuration and matching checkpoints and rejects changed source state. For humans, `cwf` always starts a fresh chat; `/new` starts another. `cwf chat CHAT_ID` is optional explicit resumption. Normal `codex` use is independent.
