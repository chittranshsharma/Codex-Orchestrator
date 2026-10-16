# Codex Workflow

Version 0.3 defaults new runs to Manual assignment. Use `--manual` to choose model/effort before every job in a terminal, or `--manual --agents-file agents.json` for exact per-job assignments in command tools. Missing assignments fail visibly. `--auto` explicitly enables role routing and, with `--jev`, dynamic Jev routing. An interactive run without a mode flag asks you to choose. Manual mode never calls Jev, and workflow `decide` calls use their explicit fallback. Saved selections are reused on resume unless an invalidated job's prompt changes. Older checkpoints retain their saved behavior.

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

The default route is GPT-6 Luna for scans and GPT-6.1 Sol for planning, edits, verification, and review, with high reasoning effort. These are starting profiles, not a benchmark claim. Models must be available to your account. The runner fails visibly when a requested model is unavailable; it does not silently substitute another model.

`cwf init` writes a reviewable `.codex-workflow.json`. You can change every role there, or override individual roles for one run:

```powershell
cwf run audit --model scan=gpt-6-luna --model verify=gpt-6.1-sol --effort verify=high --concurrency 3
```

The coordinator script chooses a **role**; the runner uses that role's configured model by default. Enable optional Jev routing with `--jev` to select a computing tier per task. Deterministic loops and execution stay in local code. Jev uses TypeSafe's hosted API and requires a separate key.

Default limits: four concurrent jobs, 100 jobs per run, 15 minutes per job, one transient retry for read-only jobs. Edits are not automatically retried. Configure limits in `.codex-workflow.json`; supported concurrency is 1–32 and the total job cap is 1–1,000. Token counts are displayed, not enforced as a spending budget. Worker limits do not cap arbitrary JavaScript outside the workflow API.

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

- `agent(prompt, { id, role, label?, schema?, workspace?, timeoutMs?, webSearch? })`: a fresh Codex thread. `schema` requests JSON output, also validated locally. `workspace` references a completed edit job, allowing a later editor or verifier to use that same worktree. Web search defaults to disabled; a research job can explicitly request `cached` or `live`.
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

Set the key locally in your terminal; keep it out of Git and workflow inputs. `cwf doctor` reports only whether a key is present. `cwf doctor --jev --live` makes a small Jev probe plus the existing Codex model probes.

`cwf init` includes a `jev` configuration. Set `jev.enabled` to true to enable it for a repository. `--jev` and `--no-jev` override it for a new run. The configurable fast, standard and deep profiles select both model and reasoning effort. Defaults are Luna/high, Sol/high and Sol/xhigh. Planning, verification and final review have a standard tier floor. Existing role overrides are fallback profiles; change `jev.profiles` to override the dynamically selected profiles.

Jev receives each job's prompt, role and label through TypeSafe's hosted API. It does not receive repository files automatically; include relevant evidence in prompts or decision state. Decisions below the configurable confidence threshold (initially 0.8), missing keys, malformed responses, timeouts and service errors use the explicit fallback and appear in the log. The threshold is a starting policy, not a measured accuracy guarantee. Missing keys use fixed role routing. Once saved, a decision is reused for identical inputs on resume, including fallback decisions; start a new run to reconsider them.

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
