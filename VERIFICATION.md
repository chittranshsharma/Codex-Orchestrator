# Verification — Codex Workflow 0.1.0

## Current release: 0.5.0

40 automated tests pass locally. New coverage includes persistent chat thread reuse, follow-ups across ON/OFF transitions, saved-session resumption, queued workflow outcome context, chat ownership locks, cancellation, concurrent-turn rejection, malformed plans, and in-chat patch ownership/repository checks. Existing independent-verifier and conflict gates remain in force. Unsupported primitive structured-output roots are now rejected locally before a model call, and planner instructions specify object roots or plain text.

A real Windows terminal chat (`chat-0c56f082-be8f-4490-b11f-c02069e571d3`) used the same Codex thread (`01a14455-017f-7d32-b4cd-2ab89c71672c`) for direct prompts, follow-up recall, read-only workflow planning, switching back to direct chat, and resumption after closing the terminal. A worker in run `20261016105411-f07b3284` returned the remembered codeword. After resuming the chat, the lead recalled the original word and correctly reported that the latest workflow completed. The preceding failed primitive-schema run remained visible rather than being presented as successful. Terminal mode toggles and exit were also exercised after resuming.

OFF mode uses workspace-write in the current checkout; ON mode uses a read-only planning turn followed by the existing isolated workflow runtime. The lead receives recorded workflow outcomes and report paths for follow-ups; long results are explicitly shortened. Jev live inference remains unverified without credentials.

## Current release: 0.4.0

33 automated tests pass locally. The GitHub matrix also passed on Windows (Node 22 and 24), Ubuntu (Node 22), and macOS (Node 22): workflow run `38884621621`. These are controlled runtime tests; real account-backed model pilots remain Windows-only.

The guided `start` launcher was exercised in a real terminal against the Codex SDK. Planning run `20261016095818-a6be6eb8` generated a minimal workflow, the source was displayed for review, typing RUN launched execution run `20261016095844-1c880693`, and its real scan worker returned READY. A repeat (`20261016100013-a4710f56`) also returned READY. Tests verify that source is only launched after exact confirmation and that changes during review block execution. The executable flushes stdout/stderr before explicitly exiting to avoid retained Windows terminal handles after switching between readline and dashboard input.

Live Jev inference and savings remain unverified without a TypeSafe key. The demo command is an optional simulation; start/plan/run use real Codex jobs.

## Current update: 0.3.0

31 automated tests pass. Manual assignment is the default for new runs, with an explicit Auto mode. Tests cover approval before launch, serialized prompts under parallel scheduling, exact per-job assignment files, missing assignment refusal, resume selections, cancellation before worktree creation, picker controls, and small terminal layouts. The TypeSafe response contract was checked against the current official HTTP reference. Response bodies are now bounded while streaming, and cancellation is respected even without credentials. Full interactive manual demo completed in a Windows terminal with seven selected jobs. Terminal previews use simulated data. No TypeSafe key was configured: live Jev inference and routing quality remain unverified.

The earlier pilot evidence below refers to 0.1.0, and the Jev section at the end describes 0.2.0.

The installed 0.3.0 CLI completed both seven-job Auto and per-job-map Manual simulations. A real manual Codex smoke check (run `20261016095315-e6baec6a`) selected `gpt-6-luna/high` from an explicit job map and returned schema-valid `{ "ok": true }`. This verifies the manual path through the SDK, not model routing quality or live Jev behavior.

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
