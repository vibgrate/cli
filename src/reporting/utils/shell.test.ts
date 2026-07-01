import { describe, it, expect } from 'vitest';
import { unsetEnvCommand } from './shell.js';

describe('unsetEnvCommand', () => {
  it('uses POSIX unset for bash/zsh/sh/ksh', () => {
    expect(unsetEnvCommand('VIBGRATE_DSN', { platform: 'linux', shell: '/bin/bash' })).toBe('unset VIBGRATE_DSN');
    expect(unsetEnvCommand('VIBGRATE_DSN', { platform: 'darwin', shell: '/bin/zsh' })).toBe('unset VIBGRATE_DSN');
    expect(unsetEnvCommand('VIBGRATE_DSN', { platform: 'linux', shell: '/usr/bin/ksh' })).toBe('unset VIBGRATE_DSN');
  });

  it('uses fish syntax for the fish shell', () => {
    expect(unsetEnvCommand('VIBGRATE_DSN', { platform: 'linux', shell: '/usr/bin/fish' })).toBe('set -e VIBGRATE_DSN');
  });

  it('uses unsetenv for csh/tcsh', () => {
    expect(unsetEnvCommand('VIBGRATE_DSN', { platform: 'linux', shell: '/bin/csh' })).toBe('unsetenv VIBGRATE_DSN');
    expect(unsetEnvCommand('VIBGRATE_DSN', { platform: 'linux', shell: '/usr/local/bin/tcsh' })).toBe('unsetenv VIBGRATE_DSN');
  });

  it('falls back to POSIX unset when the shell is unknown/empty', () => {
    expect(unsetEnvCommand('VIBGRATE_DSN', { platform: 'linux', shell: '' })).toBe('unset VIBGRATE_DSN');
  });

  it('shows both PowerShell and cmd.exe forms on Windows', () => {
    const out = unsetEnvCommand('VIBGRATE_DSN', { platform: 'win32' });
    expect(out).toContain('Remove-Item Env:VIBGRATE_DSN');
    expect(out).toContain('set VIBGRATE_DSN=');
  });
});
