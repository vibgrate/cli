import { describe, it, expect } from 'vitest';
import { isSecretPath, redactText, secretRefusal } from './secrets.js';

describe('isSecretPath', () => {
  it('flags env, key, and credential files', () => {
    for (const p of ['.env', '.env.local', 'app/.env.production', 'certs/server.pem', 'id_rsa', 'deploy/id_ed25519', '.npmrc', '.aws/credentials', 'config/secrets.yaml', 'private.key']) {
      expect(isSecretPath(p)).toBe(true);
    }
  });
  it('does not flag ordinary source files', () => {
    for (const p of ['src/index.ts', 'README.md', 'env.ts', 'src/keyboard.ts', 'package.json']) {
      expect(isSecretPath(p)).toBe(false);
    }
  });
  it('has an actionable refusal message', () => {
    expect(secretRefusal('.env')).toContain('.env');
    expect(secretRefusal('.env')).toMatch(/refusing/i);
  });
});

describe('redactText', () => {
  it('masks NAME_KEY=value assignments but keeps the name', () => {
    const out = redactText('OPENAI_API_KEY=sk-abcdefghijklmnop\nDB_PASSWORD: "hunter2secret"');
    expect(out).toContain('OPENAI_API_KEY=***redacted***');
    expect(out).toContain('DB_PASSWORD');
    expect(out).not.toContain('hunter2secret');
  });
  it('masks token shapes and URL basic-auth', () => {
    expect(redactText('key ghp_0123456789abcdefghij here')).not.toContain('0123456789abcdefghij');
    expect(redactText('postgres://user:s3cr3tpassword@host/db')).toContain('user:***redacted***@');
  });
  it('leaves ordinary code untouched', () => {
    const code = 'const total = price * qty;\nreturn total;';
    expect(redactText(code)).toBe(code);
  });
});
