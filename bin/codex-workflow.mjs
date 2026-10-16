#!/usr/bin/env node
import { main } from '../dist/cli.js';
main().catch(error => { console.error(`codex-workflow: ${error.message}`); process.exitCode = 1; }).finally(() => {
  process.stdin.pause();
  // Readline can leave a terminal handle referenced after switching between prompts and raw mode.
  if (process.stdin.isTTY) process.stdin.unref?.();
  for (const stream of [process.stdout, process.stderr]) {
    if (stream.isTTY) stream.write('', () => stream.unref?.());
  }
});
