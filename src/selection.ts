import type { AgentOptions, Config, ModelProfile } from './types.js';
import { EventEmitter } from 'node:events';
export interface SelectionRequest {
  options: AgentOptions; prompt: string; profiles: ModelProfile[];
}
export type Selector = (request: SelectionRequest, signal: AbortSignal) => Promise<ModelProfile>;
export function selectionProfiles(config: Config, role: AgentOptions['role']): ModelProfile[] {
  const profiles = [config.roles[role], ...Object.values(config.roles), ...Object.values(config.jev?.profiles ?? {})];
  return profiles.filter((profile, index) => profiles.findIndex(p => p.model === profile.model && p.effort === profile.effort) === index);
}
export function validateProfile(value: ModelProfile): ModelProfile {
  if (!value || typeof value.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(value.model)
    || !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value.effort)) throw new Error('Choose a valid model ID and reasoning effort');
  return { model: value.model, effort: value.effort };
}
export class AgentPicker extends EventEmitter {
  request?: SelectionRequest;
  index = 0; effort: ModelProfile['effort'] = 'high'; custom = ''; editing = false; error = '';
  showPrompt = false; promptOffset = 0;
  private finish?: (profile: ModelProfile) => void;
  select: Selector = (request, signal) => new Promise((resolve, reject) => {
    signal.throwIfAborted();
    this.request = request; this.index = 0; this.effort = request.profiles[0]!.effort;
    this.custom = ''; this.editing = false; this.error = ''; this.showPrompt = false; this.promptOffset = 0;
    const cleanup = () => { signal.removeEventListener('abort', abort); this.request = undefined; this.finish = undefined; this.emit('update'); };
    const abort = () => { cleanup(); reject(signal.reason); };
    this.finish = profile => { cleanup(); resolve(profile); };
    signal.addEventListener('abort', abort, { once: true }); this.emit('update');
  });
  key(text: string, key: { name?: string; ctrl?: boolean }): void {
    if (!this.request) return;
    if (this.editing) {
      if (key.name === 'escape') { this.editing = false; this.custom = ''; }
      else if (key.name === 'return') this.editing = false;
      else if (key.name === 'backspace') this.custom = this.custom.slice(0, -1);
      else if (!key.ctrl && /^[a-zA-Z0-9._:/-]+$/.test(text) && this.custom.length + text.length <= 120) this.custom += text;
    } else if (key.name === 'tab') this.showPrompt = !this.showPrompt;
    else if (this.showPrompt && key.name === 'down') this.promptOffset = Math.min(this.request.prompt.length, this.promptOffset + 80);
    else if (this.showPrompt && key.name === 'up') this.promptOffset = Math.max(0, this.promptOffset - 80);
    else if (key.name === 'up' || key.name === 'down') {
      this.index = (this.index + (key.name === 'up' ? -1 : 1) + this.request.profiles.length) % this.request.profiles.length;
      this.effort = this.request.profiles[this.index]!.effort; this.custom = '';
    } else if (key.name === 'm') { this.editing = true; this.custom = ''; }
    else if (key.name === 'e') {
      const efforts: ModelProfile['effort'][] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
      this.effort = efforts[(efforts.indexOf(this.effort) + 1) % efforts.length]!;
    } else if (key.name === 'return' && !this.showPrompt) {
      try { this.finish?.(validateProfile({ model: this.custom || this.request.profiles[this.index]!.model, effort: this.effort })); }
      catch (error) { this.error = String(error); }
    }
    this.emit('update');
  }
}
