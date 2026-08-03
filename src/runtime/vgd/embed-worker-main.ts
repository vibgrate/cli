/**
 * Entry point for the vgd embedding worker child process.
 *
 * Kept separate from `embed-worker.ts` so that module can be imported by tests
 * without starting a readline loop on stdin.
 */
import { runEmbedWorker } from './embed-worker.js';

runEmbedWorker();
