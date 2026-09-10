import * as fs from 'node:fs';
import { TEST_CACHE_DIR } from '../vitest.config.js';

/**
 * Per-run home for the content-addressed store (see vitest.config.ts):
 * created before the first test, removed after the last, so a run leaves
 * nothing behind in the OS temp dir and never touches the real cache tree.
 */
export default function setup(): () => void {
  fs.mkdirSync(TEST_CACHE_DIR, { recursive: true });
  return () => {
    fs.rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
  };
}
