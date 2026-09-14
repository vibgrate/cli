import { describe, it, expect } from 'vitest';
import { isSecretShapedKey } from './secret-keys.js';

describe('isSecretShapedKey', () => {
  // The twelve examples pinned on both sides of the contract
  // (packages/vibgrate-haile/docs/facts.md §2.3). Do not change one without the other.
  it.each([
    ['master_password', true],
    ['DB_PASSWD', true],
    ['client_secret', true],
    ['api_key', true],
    ['ApiKey', true],
    ['github_token', true],
    ['private_key', true],
    ['aws_access_key', true],
    ['credentials', true],
    ['password_file', false],
    ['secret_name', false],
    ['token_ttl', false],
  ])('%s → %s', (key, expected) => {
    expect(isSecretShapedKey(key)).toBe(expected);
  });

  it('is a plain substring test, not a word match', () => {
    expect(isSecretShapedKey('mysecretvalue')).toBe(true);
    expect(isSecretShapedKey('acl')).toBe(false);
    expect(isSecretShapedKey('bucket')).toBe(false);
  });

  it('treats every benign suffix as not secret-shaped', () => {
    for (const suffix of ['_file', '_path', '_url', '_uri', '_name', '_id', '_enabled', '_ttl', '_expiry', '_header', '_length', '_count']) {
      expect(isSecretShapedKey(`secret${suffix}`)).toBe(false);
    }
  });
});
