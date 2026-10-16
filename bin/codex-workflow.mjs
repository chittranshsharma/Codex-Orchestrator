#!/usr/bin/env node
import { main } from '../dist/cli.js';
main().catch(error => { console.error(`codex-workflow: ${error.message}`); process.exitCode = 1; });
