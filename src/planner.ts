export const authoringReference = `Write a self-contained JavaScript ES module for Codex Workflow.
Export const meta = { name: 'short-kebab-name', description: 'what it does' }.
Export default async function({ args, agent, pipeline, parallel, phase, log, repeat, acceptPatch, decide }) { ... }.
Do not import modules, read files, run processes, access network APIs, or use process/global state in the script.
The script coordinates agents. Agents perform repository reads, edits, and commands.
agent(prompt, { id, role, model?, effort?, label?, schema?, workspace?, timeoutMs?, webSearch? }) returns a JSON value with schema, or text otherwise.
Honor user-requested models per task with model/effort options. Otherwise omit them so local routing chooses. Explicit models bypass Jev. Avoid premium gpt-6-astra and gpt-6.1-sol unless requested; these trigger a warning before calls.
If supplying schema, its root must have type:'object'. For plain text omit schema. Wrap array or primitive values in an object property; never use a primitive or array root schema. Specify required properties and additionalProperties:false for structured objects.
Every id must be unique, stable, and match /^[a-zA-Z0-9_-]{1,100}$/.
Roles: plan for decomposition, scan for fast read-only inspection, edit for isolated edits, verify for independent read-only verification, review for final synthesis.
Models and effort are assigned automatically from roles and local task metadata. Use short prompts, targeted reads, concise evidence and the fewest workers needed. Group dependent work. Do not add a synthesis worker when code can assemble the report. A question requiring no repository tools needs only a single scan worker.
In manual mode the user chooses a model and effort before each job can start. Never imply a job can bypass this selection. Manual decide() calls return their explicit fallback without a Jev request.
Jev is optional and hosted. Default routing sends metadata only; task-text sharing requires opt-in. Missing keys or service failures keep local role profiles. Explicit assignments override routing.
The API also includes decide(state,{id,instructions,choices:{key:'description',...},fallback:'key'}), returning {choice,confidence,probabilities,model,fallback,usage}.
Use decide for bounded semantic branches such as which target to inspect or whether to split/retry/stop, only when state contains enough evidence. Use stable unique decision ids (route- prefix reserved). Always supply an explicit conservative fallback. A decision never replaces a required verifier or authorizes patch application. Keep loops bounded with repeat.
Edit jobs automatically get a separate Git worktree. A later edit or verifier can use {workspace: 'completed-edit-id'} to inspect that worktree. Other jobs read the main repository.
parallel([() => agent(...), ...]) and pipeline(items, (item,index) => agent(...)) return arrays; failed branches are null and are recorded in the run report. Do not silently count null as a clean result.
Use phase('Title') before a stage, not inside concurrent callbacks. log(message) emits progress.
For patch acceptance: a separate verify job in the edit's workspace must return an object with passed:true only when its checks pass; then await acceptPatch(editId, verifierId).
repeat({maxRounds:5,noProgressRounds:2}, async round => ({done,progressKey,result})) stops on success, repeated lack of progress, or the round cap. Include previous verifier feedback in later edit prompts.
Keep each finding independently verified before reporting it as confirmed. Distinguish unverified from refuted.
For research, request webSearch:'live' on relevant read-only jobs and preserve URLs in structured outputs.
Only return the consolidated final result. Do not apply patches, merge, push, or deploy.
Use args for inputs. Do not use timestamps, randomness, environment variables, non-deterministic ordering, or mutate args.
Prefer at most 6 initial targets and 2 repair rounds; new runs default to 16 total jobs and a reported token scheduling budget. Group dependent files. Do not repeat scans just to produce a summary.
This module will be saved for human review before running. Keep it readable.`;

export const plannerWorkflow = `export const meta = {name:'plan-workflow',description:'Generate a workflow script for review'};
export default async function({args,agent,phase}) {
  phase('Plan');
  return agent(args.reference + '\\nTask: ' + args.request, {
    id:'author', role:'plan', label:'Write workflow script',
    schema:{type:'object',additionalProperties:false,required:['name','description','source'],properties:{
      name:{type:'string'},description:{type:'string'},source:{type:'string'}
    }}
  });
}`;
