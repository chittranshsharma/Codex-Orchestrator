import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentPicker } from '../dist/selection.js';
import { renderSelection, clean } from '../dist/dashboard.js';
const request = { options: { id: 'scan', role: 'scan' }, prompt: 'Inspect code safely. '.repeat(40), profiles: [{ model: 'fast', effort: 'high' }, { model: 'deep', effort: 'xhigh' }] };
test('picker supports profile selection, effort, custom model, prompt view and confirmation', async () => {
  const picker = new AgentPicker(); let completed = false;
  const result = picker.select(request, new AbortController().signal).then(r => { completed = true; return r; });
  picker.key('', { name: 'down' }); picker.key('', { name: 'e' });
  picker.key('', { name: 'tab' }); picker.key('', { name: 'return' });
  assert.equal(completed, false);
  picker.key('', { name: 'tab' }); picker.key('', { name: 'm' }); picker.key('custom-model', { name: '' });
  picker.key('', { name: 'return' }); assert.equal(completed, false);
  picker.key('', { name: 'return' });
  assert.deepEqual(await result, { model: 'custom-model', effort: 'max' }); assert.equal(picker.request, undefined);
});
test('picker cancellation cleans up and both views fit small terminals', async () => {
  const picker = new AgentPicker(), controller = new AbortController();
  const result = picker.select(request, controller.signal);
  for (const [width,height] of [[24,12],[40,16],[80,24],[110,42]]) {
    for (const showPrompt of [false,true]) {
      picker.showPrompt = showPrompt;
      const lines = renderSelection(picker,width,height).split('\n');
      assert.ok(lines.length <= height);
      assert.ok(lines.every(line => clean(line).length <= width));
    }
  }
  controller.abort(); await assert.rejects(result); assert.equal(picker.request, undefined);
});
