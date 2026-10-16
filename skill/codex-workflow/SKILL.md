---
name: codex-workflow
description: "Plan, run, inspect, and resume scripted Codex workflows using the local codex-workflow CLI, including parallel audits, model routing, and isolated verified patches. Use when the user requests this workflow runner or a saved scripted workflow."
---

# Codex Workflow

Use the installed `codex-workflow` command (`cwf` is an alias). Run `codex-workflow --help` if the local CLI options are needed.

For a human in an interactive terminal, `cwf` or `cwf start "task"` prompts for the task, mode, workflow review and execution. This is real Codex work. `demo` is only a simulation. In noninteractive command tools use the explicit plan/review/run flow below. Normal `codex` use remains independent and unaffected.

Run commands from the intended Git repository, or specify `--repo` with its absolute path. Use `--plain` in Codex's command tools, or `--json` when parsing events. The interactive dashboard runs in a real terminal; it is not a native Codex panel.

New runs default to Manual. Preserve the user's choice of models for every job: use `--manual --agents-file <reviewed-map.json>` for noninteractive execution, or let the user run `--manual` in their terminal picker. The JSON file maps exact job IDs to `{model,effort}`. Missing assignments block that job visibly. Use `--auto` only when the user explicitly chooses automatic assignment; `--jev` alone does not grant that choice. Manual disables Jev requests and uses explicit fallbacks for workflow decisions. Saved manual selections survive resume; changed downstream prompts prompt again.

For an audit, use `codex-workflow run audit --target <relative-path> --plain`. Add `--question` for the user's focus. Add `--fix` when the user requested fixes; this prepares patches in dedicated worktrees. It does not apply them to the main checkout. Edit runs require a clean working tree; preserve existing user work instead of resetting or stashing it automatically.

For a custom repeatable task, use `codex-workflow plan "<task>" --out <workflow.mjs> --plain`, inspect the generated source, and then run the reviewed script with `codex-workflow run <workflow.mjs> --plain`. Scripts are trusted local Node.js code. The worker sandboxes do not sandbox the coordinator script.

The CLI prints a run ID and report path. Read the report and relevant patch files before summarizing the outcome. Keep failed jobs, unverified findings, unfinished fixes, and blocked checks visible. `partial` is not successful completion of the requested work.

Use `codex-workflow show <run-id>` to inspect results and `codex-workflow resume <run-id> --plain` to retry unfinished work. Resume uses the saved script, input, and routing settings; it refuses changed repositories. Start a new run for changed inputs. Avoid retrying a persistent failure without addressing its cause.

When the user asks to apply a reviewed patch, use `codex-workflow apply <run-id> --task <edit-job-id>`. This requires a recorded passing independent verifier and checks for conflicts. Review the resulting main-checkout diff and run appropriate integration checks. Multiple individually valid patches can conflict or fail together; do not represent per-patch verification as combined integration verification.

Models are assigned by role from `.codex-workflow.json`, or per-run `--model ROLE=MODEL` and `--effort ROLE=EFFORT`. Honor the user's model choices. If a model is unavailable, report it and select another only within the user's authorization. Do not silently claim fallback or token savings.

The worker processes already perform the delegated tasks. Do not create an additional subagent swarm around the runner unless the user asks for one.

For Jev model and reasoning routing, add `--jev` or enable `jev.enabled` in repository config. Read the TypeSafe skill when designing new Jev questions. `TYPESAFE_API_KEY` must be supplied through the environment; never put credentials in scripts, arguments, Git, or chat. Jev receives job prompts and explicit decision state. Missing keys, service errors and low confidence visibly use fallback profiles. Reports record decisions and Jev usage separately. Verification and apply gates remain mandatory. For semantic workflow branches, use `decide(state,{id,instructions,choices,fallback})` with bounded loops and an explicit fallback; reserve the `route-` id prefix for the runtime.
