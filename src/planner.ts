export const authoringReference = `Write a self-contained JavaScript ES module for Codex Workflow.
Export const meta = { name: 'short-kebab-name', description: 'what it does' }.
Export default async function({ args, agent, pipeline, parallel, phase, log, repeat, acceptPatch }) { ... }.
Do not import modules, read files, run processes, access network APIs, or use process/global state in the script.
The script coordinates agents. Agents perform repository reads, edits, and commands.
agent(prompt, { id, role, label?, schema?, workspace?, timeoutMs?, webSearch? }) returns a JSON value with schema, or text otherwise.
Every id must be unique, stable, and match /^[a-zA-Z0-9_-]{1,100}$/.
Roles: plan for decomposition, scan for fast read-only inspection, edit for isolated edits, verify for independent read-only verification, review for final synthesis.
Models and effort are assigned automatically from these roles by user configuration.
When Jev is enabled, it selects fast, standard or deep model/effort profiles before each job. Role profiles are fallbacks.
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
No more than 30 initial targets and 100 total jobs. Group dependent files where appropriate.
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
