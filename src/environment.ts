import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

let fileKey: string | undefined;
let selectedFile: string | undefined;
let explicitSelection = false;
export const jevKey = () => process.env.TYPESAFE_API_KEY || fileKey;
export const jevEnvPath = (root: string) => join(root, 'jev.env');
export const jevEnvSource = () => explicitSelection ? selectedFile : undefined;

export async function loadJevEnv(root: string, explicitFile?: string): Promise<void> {
  fileKey = undefined;
  explicitSelection = Boolean(explicitFile);
  selectedFile = explicitFile ? resolve(explicitFile) : jevEnvPath(root);
  try {
    const text = await readFile(selectedFile, 'utf8');
    if (text.length > 16384) throw new Error('Jev env file exceeds 16 KB');
    // Read only this credential. Never inject arbitrary .env variables into worker processes.
    fileKey = parseEnv(text).TYPESAFE_API_KEY?.trim() || undefined;
  } catch (error) {
    if (explicitFile || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
export async function setupJevEnv(root: string): Promise<string> {
  await mkdir(root, { recursive: true });
  const path = jevEnvPath(root);
  try { await writeFile(path, '# Local Jev credential. Keep this file outside repositories.\nTYPESAFE_API_KEY=\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  return path;
}
export function workerEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !['TYPESAFE_API_KEY', 'CWF_ENV_FILE'].includes(key.toUpperCase()))) as Record<string, string>;
}
