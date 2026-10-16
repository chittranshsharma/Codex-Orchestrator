# Codex Workflow

Version 0.6: `cwf` starts a fresh conversation every time. `/new` starts another; resumption is optional through `cwf chat CHAT_ID`. `/orchestrate on|off` retains the current lead thread. OFF edits the current checkout; ON plans read-only and launches reviewed isolated jobs. Commands include `/agents manual|auto`, `/model MODEL [EFFORT]` (or `MODEL/EFFORT`), `/jev on|off`, `/status`, `/usage`, `/history`, `/runs`, `/apply RUN_ID JOB_ID`, and `/exit`.

`cwf start "task"` is the separate single-task launcher: it plans, displays trusted source and requires RUN. In Codex app, install/update the packaged skill (`cwf install-skill --update`) and say “use orchestrator.” The current agent authors and inspects a script, then invokes `run --auto --plain`, avoiding a second planner call. Automatic skill selection depends on the app discovering the skill; restart/reload skills if newly installed. This does not replace the app's native interface.

New runs default to Auto. Use `--manual` for the per-job picker or `--manual --agents-file agents.json` for exact job mappings. Missing manual assignments block that job. Explicit agent model/effort, assignment maps and CLI role overrides take priority over Jev. Manual mode never calls Jev. Existing configuration/checkpoints retain their saved choices; no saved chat is resumed implicitly.

A terminal workflow runner built on the official Codex SDK. A lead Codex model can write a reusable JavaScript workflow. The script coordinates smaller jobs, routes each role to its configured model, and keeps intermediate results in local run files. The terminal shows live job activity and actual token usage reported by Codex.

This is an independent project, not an official OpenAI product or a modification of the Codex desktop interface.

## Start here

Requirements: Node.js 22 or newer, Git, and a Codex login with access to the models you choose. The SDK bundles its own Codex CLI runtime and uses your existing Codex authentication. No separate API key is required when the local Codex runtime works with your ChatGPT login. Account limits still apply.

From this package directory:

```powershell
npm ci
npm run build
npm link
codex-workflow doctor
codex-workflow demo
```

`cwf` is a shorter alias for every command. The demo is clearly marked **SIMULATION**, calls no models, and edits only its generated temporary fixture. `cwf demo --snapshot` prints a static preview. `cwf doctor --live` makes one short paid/plan-metered check per configured model to verify account access; ordinary `doctor` makes no model calls.

In your own Git repository:

```powershell
cwf init
# Review .codex-workflow.json; commit it before starting edit jobs.
cwf run audit --target src
cwf run audit --target src --question "Find missing authorization checks"
cwf run audit --target src --fix
```

The dashboard opens automatically in an interactive terminal. Use `--plain` in Codex chat or `--json` in scripts. Run `cwf --help` for all commands.

## What works

- Automatic role-based model and reasoning routing: plan, scan, edit, verify, review.
- Self-contained JavaScript workflows, natural-language workflow authoring, saved scripts, and JSON inputs.
- Bounded parallelism, a total job cap, per-job timeouts, and bounded transient retries for read-only jobs.
- Independent confirmation of audit findings; failed checks stay visible as unverified work.
- Dedicated Git worktrees for edits and separate verifier sessions that inspect each patch's worktree.
- Explicit patch acceptance and conflict-checked application to the main checkout.
- Checkpoint replay of completed jobs and retries of unfinished work; modified source repositories or changed scripts are rejected.
- Bounded fix loops stopping after two unchanged rounds or a maximum round count.
- Live terminal phase cards, model labels, agent details, a session log, actual token totals, and a plain/JSON output mode.
- Persistent reports, per-job results, thread IDs, patches, and raw SDK events.
- A Codex skill invoking the same runner used by the terminal command.

## Model routing

Defaults: Luna/medium for planning and review, Luna/low for scans, Sol 6/medium for edits and independent verification. Local complexity metadata can raise effort to high without another model call. Premium Astra and Sol 6.1 are not default routes; if selected, a warning is emitted before the call. Models must be available to your account; unavailable requested models fail visibly. These are policies, not measured quality or savings claims.

`cwf init` writes a reviewable `.codex-workflow.json`. You can change every role there, or override individual roles for one run:

```powershell
cwf run audit --model scan=gpt-6-luna --model verify=gpt-6.1-sol --effort verify=high --concurrency 3
```

The coordinator script chooses a **role**; the runner uses that role's configured model by default. Enable optional Jev routing with `--jev` to select a computing tier per task. Deterministic loops and execution stay in local code. Jev uses TypeSafe's hosted API and requires a separate key.

Default limits: two concurrent workers, 16 jobs per run, 15 minutes per job, no automatic request retries. `--token-budget N` stops scheduling new model calls once reported input+output tokens reach N (default 100000). In-flight and unreported usage can exceed this limit; it is not a hard spending cap. Chat `/usage` includes lead and recorded workflow usage; cached input is a subset of input, not added twice. Budgets count Codex tokens, while Jev tokens are recorded separately. Smaller models do not necessarily use fewer tokens, and orchestration can cost more than a direct turn. Worker limits do not sandbox arbitrary coordinator JavaScript.

Worker sessions use a 1000-token skill catalog and a 3000-token limit per retained tool output via [documented Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference). This can shorten discovery/tool history; workers should read targeted sections and include required skill paths in task prompts when relevant. The persistent chat lead retains its ordinary skill catalog.

## Terminal controls

| Key | Action |
| --- | --- |
| Up / Down | Select an agent |
| Enter | Toggle selected-agent detail |
| P | Pause/resume scheduling; already running jobs finish |
| Q or Ctrl+C | Abort active requests and save the run for later resume |

Use `cwf watch RUN_ID` in another terminal to inspect the saved run. It is a viewer; pause/stop controls belong to the terminal running the workflow. The UI adapts to terminal width, uses text status alongside colors, and restores the terminal on ordinary exit or handled interruption.

## Saved workflows

Generate a workflow, read the source, and run it:

```powershell
cwf plan "Review each API route for missing authorization; verify each finding independently" --out auth-audit.mjs
Get-Content auth-audit.mjs
cwf run ./auth-audit.mjs
```

The authoring command saves source after a syntax check; it does **not** execute that generated source. Review the script before `run`. Syntax checking does not establish correctness or safety.

Scripts are trusted Node.js ES modules and execute with the runner's operating-system permissions. They are not a secure sandbox. Keep scripts self-contained, pass inputs through `args`, and perform repository work through `agent()`. The provided authoring instructions follow this pattern. Do not run untrusted scripts.

```javascript
export const meta = {
  name: 'review-areas',
  description: 'Explore separate code areas and independently check the review',
};

export default async function ({ args, phase, agent, pipeline }) {
  phase('Scan');
  const notes = await pipeline(args.targets ?? ['src'], (path, index) =>
    agent(`Inspect ${JSON.stringify(path)} and cite concrete risks.`, {
      id: `scan-${index}`, role: 'scan', label: path,
    }),
  );
  phase('Verify');
  return agent(`Check these notes against the code; retain failures explicitly:\n${JSON.stringify(notes)}`, {
    id: 'verify', role: 'verify',
  });
}
```

Inputs can come from `--args` or `--args-file inputs.json`. The file form avoids terminal quoting differences. Use `cwf save RUN_ID --out reusable.mjs` to save the exact script of an existing run. Existing files are never overwritten by `init`, `plan`, or `save`.

## Workflow API

- `agent(prompt, { id, role, model?, effort?, label?, schema?, workspace?, timeoutMs?, webSearch? })`: a fresh Codex thread. Explicit model/effort overrides routing. `schema` requests object-root JSON output, also validated locally. `workspace` references a completed edit job. Web search defaults to disabled; research can explicitly request `cached` or `live`.
- `pipeline(items, (item, index) => ...)`: fan out up to 4,096 items, subject to the active-job and total-job limits. Returns `null` for failed branches and records the failure; the final run is marked `partial`.
- `parallel([() => task1(), () => task2()])`: run task functions concurrently, with the same failure semantics.
- `phase(title)`: label following jobs in the dashboard. Call between stages, outside concurrent callbacks.
- `log(message)`: append a progress message.
- `repeat({ maxRounds: 5, noProgressRounds: 2 }, async round => ({ done, progressKey, result }))`: a bounded convergence loop. Use a stable description or count of remaining failures as `progressKey`; forward verifier feedback to the next edit.
- `acceptPatch(editId, verifierId)`: mark an edit patch accepted only after a separate completed `verify` job in the same worktree returns `{ passed: true }`. The worktree diff must still match the captured patch.

Only the `edit` role gets a workspace-write Codex sandbox; other roles use read-only. Workers receive no automatic sandbox bypass. Shell network access is disabled. They inherit the applicable local Codex configuration, repository guidance, authentication, and available integrations. Read-only worker instructions do not turn third-party MCP integrations into read-only services; use only trusted configured tools. Worktrees isolate code edits, not all operating-system resources or shared Git metadata.

Each call needs a unique, deterministic ID. Prompts, role settings, and IDs must repeat identically during replay. Avoid timestamps, random values, external mutable inputs, relative imports, and global state in the coordinator. The saved script is copied into the run directory; relative imports would resolve there.

## Resume and inspect

```powershell
cwf list
cwf show RUN_ID
cwf show RUN_ID --script
cwf show RUN_ID --json
cwf resume RUN_ID
```

Resume re-executes the same saved coordinator with the same inputs and routing. Completed matching jobs before the first unsuccessful job return their recorded result. That unsuccessful job and all later jobs rerun, including later completed summaries, so a changed upstream result cannot leave a stale downstream report. Jobs made obsolete by a new upstream result are marked skipped. A branch failure before an agent record exists conservatively invalidates all jobs. Unfinished jobs start fresh Codex threads. Existing edits in an unfinished edit worktree remain, and the next worker is instructed to inspect them. A changed prompt in the retained prefix or a skipped completed prefix job causes a visible replay error.

The runner fingerprints tracked changes and untracked, non-ignored files in the source repository. It rejects resume after source changes. Files ignored by Git, such as dependencies, are not fingerprinted; changes to those can still affect results. It does not cache across unrelated runs. A run lock prevents two processes from executing the same checkpoint together. Raw event files and state are local, and can contain source code or command output.

State defaults to `%LOCALAPPDATA%/CodexWorkflow` on Windows and `$XDG_STATE_HOME/codex-workflow` (or `~/.local/state/codex-workflow`) elsewhere. Use `--state-dir PATH` or `CWF_STATE_DIR` to change it. Each run has `state.json`, `workflow.mjs`, `events.jsonl`, `report.md`, and any patches/worktrees. User timezone settings determine the display of local time; stored timestamps are UTC.

## Applying changes

```powershell
cwf show RUN_ID
# Inspect the recorded patch and verifier evidence first.
cwf apply RUN_ID --task fix-0-0
git diff
# Run your project's integration checks before committing or shipping.
```

The original checkout is not edited by worker jobs. `apply` requires recorded independent verification, checks the patch hash and original commit, and uses Git's conflict checking. New files are included in captured patches. Later edits in the same worktree supersede earlier patches. Individually verified patches can still conflict or fail combined integration checks, so apply and test deliberately. No merge, commit, push, deployment, or worktree deletion is automatic.

Edit worktrees contain tracked files from the saved commit. Untracked/ignored dependencies and environment files are not copied. If essential tests need setup, prepare the worktree using the project's normal process and retry; blocked checks are not counted as passing. Keep the source checkout unchanged if you want to resume the run.

## Use from Codex desktop or CLI chat

```powershell
cwf install-skill
```

Open a new Codex chat, then ask:

> Use $codex-workflow to audit src for authorization bugs and prepare verified fixes.

The skill invokes this same runner using plain progress output, then reads the report and patches. It does not add a native `/workflows` screen to the desktop app. After patches are applied, changes appear in the source checkout's normal diff view. To see the live dashboard, run `cwf` from an interactive terminal.

## Verification and current limits

Run `npm test` for the runtime tests. They exercise real temporary Git repositories and a controlled provider: concurrency, role routing, checkpoints, failure visibility, cancellation, locks, schema validation, dirty-tree protection, patch capture/application, and terminal rendering. `demo` is a simulation and does not prove model behavior. A separately documented live pilot checks the SDK and bundled audit flow against the signed-in account.

This first release does not reproduce every Claude UI interaction or runtime policy. It has no automatic wait-until-subscription-reset, detached daemon, operating-system process-tree recovery after a crash, guaranteed dollar-budget cap, learned model router, or secure sandbox for coordinator scripts. Timeout interrupts a request; it is not a full stalled-stream recovery implementation. Usage reported for completed turns is summed; interrupted requests can incur usage without a final usage event. Token and wall-time savings need measurement on your workloads.

Reference: [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk), [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), [Programmatic Tool Calling](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling).
# Jev routing

Enable TypeSafe Jev for automatic model and reasoning effort selection:

```powershell
$env:TYPESAFE_API_KEY = '<your TypeSafe key>'
cwf run audit --target src --jev
cwf run jev-review --target src/auth --target src/api --question 'Find session expiry bugs' --jev
```

Use `cwf jev setup` to create the global `jev.env` file under the state directory (on Windows normally `%LOCALAPPDATA%/CodexWorkflow/jev.env`). Edit it locally and add `TYPESAFE_API_KEY=...`; never paste a key into chat. Or use `--env-file C:/private/jev.env` / `CWF_ENV_FILE`. An existing process environment key takes priority. Only that key is read; no other variables are loaded. The key is not persisted in config/reports or passed into Codex worker environments. This does not encrypt the local file or prevent tools with independent filesystem access from reading it. `cwf jev status` reports presence without printing it. `cwf jev probe` makes one synthetic metadata request to check connectivity, not quality. It exits nonzero on fallback. `doctor --live` also calls the configured Codex models.

Jev is optional and off by default. `--jev` enables hosted metadata routing. Its profiles default to Luna/low, Sol 6/medium and Sol 6/high. Planning, verification and final review have a standard tier floor. `--model ROLE=MODEL` and `--effort ROLE=EFFORT` mark those roles fixed so Jev cannot override them. Exact job assignments take priority as well.

Default disclosure is restricted to role, prompt character count, structured-output/workspace flags and a local complexity flag. No prompt text, label, filename or code is included. Generic semantic `decide` calls use their explicit fallback in this mode. `--jev-task-text` (or `jev.shareTaskText:true`) separately opts into sharing up to 2000 prompt characters per route and explicit semantic state, capped at 8000 serialized characters. Treat that as disclosure to TypeSafe, not local processing. Equivalent judgments share a request/cache within a run; reused decisions record zero additional Jev tokens. HTTP/request failures disable further hosted attempts for that run. Missing keys, invalid responses and low confidence use fallback. Confidence is not correctness; metadata is limited evidence and may not improve decisions. No live routing quality or token savings claim is made without workload evaluation.

The dashboard shows the actual assigned model per job and Jev decisions in the session log. Reports and saved JSON include probabilities, resolved Jev model, confidence, fallback reason and separate Jev token usage. No key is saved in run configuration. No automatic model retry, file splitting, skipped verification or patch application is triggered by the router.

Scripts can use Jev for workflow branches as well:

```javascript
const next = await decide(
  { finding, verifierFeedback, attempts },
  {
    id: `next-${round}`,
    instructions: 'Given the verifier evidence, choose the next bounded action.',
    choices: {
      retry: 'A specific local correction is supported by verifier feedback.',
      split: 'The remaining work has distinct independently testable parts.',
      stop: 'No actionable evidence, already complete, or further work is unjustified.',
    },
    fallback: 'stop',
  },
);
```

Destructure `decide` from the workflow API. Branch on `next.choice` in ordinary code, with bounded loops and stable job IDs. A Jev decision does not satisfy `acceptPatch`; independent verification remains required. Coordinator scripts remain trusted local JavaScript.

API contract: [TypeSafe HTTP API](https://docs.typesafe.ai/api), [Choice](https://docs.typesafe.ai/primitives/choice), [confidence](https://docs.typesafe.ai/confidence). This implementation uses Node's native HTTP client with no new runtime dependency.
