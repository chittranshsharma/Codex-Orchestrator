# Verification — Codex Workflow 0.1.0

Verified on October 16, 2026, on Windows with Node v24.21.0, Git 2.56.0.windows.2, and @openai/codex-sdk 0.163.0. The installed standalone Codex CLI is 0.162.1; the SDK has its own bundled runtime. Authentication used the existing ChatGPT login.

## Automated checks


21 tests passed, 0 failed. The TypeScript build passed. The Codex skill validator passed.

Coverage includes concurrency, per-role model routing, prefix replay, downstream cache invalidation, visible partial failures, cancellation, pause/resume, locking, schema validation, repository changes before/during a run, dirty-tree protection, real Git worktrees, new-file patch capture, verification gates, patch tampering, conflict refusal, duplicate application refusal, bounded retries, no-progress stopping, reserved IDs, CLI option validation, and terminal width/height constraints.

## Real model checks

Both gpt-6.1-sol and gpt-6-luna returned schema-valid results through the Codex SDK using the signed-in account.

## Real audit → fix → verify → apply pilot

An isolated fixture exported sum(a,b) using a-b. Before the run, its two existing tests failed. The actual bundled audit workflow ran with --fix, using these jobs:

| Job | Role | Requested model | Outcome |
| --- | --- | --- | --- |
| scan-0 | scan | gpt-6-luna | completed |
| finding-0 | verify | gpt-6.1-sol | completed |
| fix-0-0 | edit | gpt-6.1-sol | completed |
| patch-0-0 | verify | gpt-6.1-sol | completed |
| review | review | gpt-6.1-sol | completed |

The scanner identified one concrete finding. A separate verifier reproduced both failures. The editor changed a-b to a+b in its dedicated worktree. Another verifier independently inspected the diff and ran the tests successfully. The original checkout stayed clean and retained a-b until the explicit apply command. Replaying the completed run reused its saved result. Applying the recorded, verified patch succeeded; the original checkout's two tests then passed.

Run: 20261016075117-6d54e8ae. Total reported input-plus-output tokens: 242712; cached input tokens: 156544 (a subset of input, not an additional charge category). This is a tiny correctness pilot, not a cost/speed benchmark or proof of large-repository reliability.

See [the audit report](verification/live-audit-report.md) and [the patch](verification/live-audit.patch).

## Real workflow authoring pilot

The plan command used gpt-6.1-sol to generate a self-contained workflow with one scan and one independent verifier. The saved script passed syntax checking and was inspected before execution. Its actual execution completed successfully: scan used gpt-6-luna, verification used gpt-6.1-sol, and the verifier reported supported explanation and passing tests.

Run: 20261016075612-c697e0d2. See [the generated source](verification/generated-workflow.mjs) and [its report](verification/generated-workflow-report.md).

## Terminal and installation

The real interactive TUI completed a simulation in a Windows pseudo-terminal. It rendered agent updates and restored the cursor and normal screen on exit. CLI behavior also passed from a separate working directory. The preview image is explicitly a simulation with zero model usage, not a screenshot of the paid pilot. The terminal commands and Codex skill were installed locally; no package was published.

## Remaining limits

No large-codebase throughput or cost comparison was performed. Linux/macOS execution was not tested. Coordinator scripts are trusted local JavaScript and are not securely sandboxed. Worktrees isolate code edits but share Git metadata and operating-system resources. The runner does not reproduce Claude's full UI, automatic subscription-reset waits, or full stalled-stream recovery. Interrupted requests can consume tokens without a final usage event. Review generated scripts and patches before execution/application; run combined integration tests before shipping multiple patches.
# Jev integration (0.2.0)

Added native TypeSafe HTTP Choice routing, conservative confidence fallbacks, bounded request timeouts, recorded decisions and usage, replay caching, and the bundled `jev-review` example. Automated tests cover the API contract, malformed responses, missing keys, HTTP errors, cancellation, actual timeout handling, runtime routing, verifier tier floor, resume caching, and target selection with independent verification. The existing isolation and patch verification tests also pass.

The current suite has 25 tests, including the Jev review workflow selection check. No TypeSafe key was available during development. Live Jev inference, routing quality, and token savings have not been measured. Use `cwf doctor --jev --live` after setting `TYPESAFE_API_KEY` for connectivity; evaluate representative tasks before tuning thresholds. Earlier evidence above describes the 0.1.0 Codex pilots, not live Jev tests. Local machine paths in published pilot reports are omitted.
