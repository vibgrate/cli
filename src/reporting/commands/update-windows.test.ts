import { describe, it, expect } from 'vitest';
import { buildDeferredUpdateScript, isFileLockError } from './update-windows.js';

/** The failure this module exists for, as npm actually prints it. */
const EBUSY_OUTPUT = [
  'npm error code EBUSY',
  'npm error syscall copyfile',
  "npm error path C:\\Users\\me\\AppData\\Roaming\\nvm\\v24.14.1\\node_modules\\@vibgrate\\cli\\node_modules\\@msgpackr-extract\\msgpackr-extract-win32-x64\\node.napi.node",
  'npm error errno -4082',
  "npm error EBUSY: resource busy or locked, copyfile '...node.napi.node' -> '...node.napi.node'",
].join('\n');

describe('isFileLockError', () => {
  it('recognises the EBUSY copyfile failure from a Windows self-update', () => {
    expect(isFileLockError(EBUSY_OUTPUT)).toBe(true);
  });

  it('recognises EPERM and the plain-English lock message', () => {
    expect(isFileLockError('npm error code EPERM\nnpm error EPERM: operation not permitted, rename')).toBe(true);
    expect(isFileLockError('The process cannot access the file because it is being used by another process.')).toBe(
      true,
    );
    expect(isFileLockError('npm error code ETXTBSY')).toBe(true);
  });

  it('does not claim unrelated failures are lock errors', () => {
    expect(isFileLockError('npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/…')).toBe(
      false,
    );
    expect(isFileLockError('npm error code ENOTFOUND\nnpm error network request to … failed')).toBe(false);
    expect(isFileLockError('')).toBe(false);
  });
});

describe('buildDeferredUpdateScript', () => {
  const script = buildDeferredUpdateScript({
    pid: 4321,
    command: 'npm install -g --allow-scripts=@vibgrate/cli @vibgrate/cli@2026.805.2',
    logPath: 'C:\\Temp\\vg-update.log',
    waitSeconds: 30,
  });

  it('waits for the scheduling process to exit before installing', () => {
    expect(script).toContain('set "VG_PID=4321"');
    expect(script).toContain('tasklist /FI "PID eq %VG_PID%" /NH');
    expect(script.indexOf('tasklist')).toBeLessThan(script.indexOf('call npm install'));
    expect(script).toContain('for /l %%i in (1,1,30) do (');
  });

  it('delays with ping, not timeout — timeout needs a console the detached script has not got', () => {
    expect(script).toContain('ping -n 2 127.0.0.1 >nul');
    expect(script).not.toContain('timeout /t');
  });

  it('runs the install with call and logs both streams', () => {
    expect(script).toContain(
      'call npm install -g --allow-scripts=@vibgrate/cli @vibgrate/cli@2026.805.2 >> "%VG_LOG%" 2>&1',
    );
    expect(script).toContain('set "VG_LOG=C:\\Temp\\vg-update.log"');
    expect(script).toContain('if errorlevel 1 (');
  });

  it('uses CRLF line endings so cmd.exe parses it', () => {
    expect(script.startsWith('@echo off\r\n')).toBe(true);
    expect(script).not.toMatch(/[^\r]\n/);
  });
});
