import { readFile } from 'node:fs/promises';
import { hash } from './storage.js';

export async function reviewAndLaunch(options: {
  path: string; preview: (source: string) => void;
  confirm: () => Promise<string>; launch: (source: string) => Promise<void>;
}): Promise<boolean> {
  const source = await readFile(options.path, 'utf8');
  options.preview(source);
  if ((await options.confirm()).trim() !== 'RUN') return false;
  if (hash(await readFile(options.path, 'utf8')) !== hash(source)) throw new Error('Workflow changed during review. Inspect it again before running.');
  await options.launch(source);
  return true;
}
