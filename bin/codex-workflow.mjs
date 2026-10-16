#!/usr/bin/env node
import { main } from '../dist/cli.js';
main().catch(error => { console.error(`codex-workflow: ${error.message}`); process.exitCode = 1; }).finally(async () => {
  process.stdin.pause();
  // Flush output before closing: Windows can retain terminal handles after readline/raw-mode transitions.
  await Promise.all([process.stdout, process.stderr].map(stream => new Promise(resolve => stream.write('', resolve))));
  process.exit(process.exitCode ?? 0);
});
