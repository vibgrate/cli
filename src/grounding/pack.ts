import type { GroundingKind } from '../schema.js';

/**
 * The free knowledge pack shipped in the open CLI (VG-PACKAGE-AND-SCHEMA §6):
 * our own paraphrased guidance + openly-licensed standards (OWASP Top 10 2021,
 * CWE). Never verbatim proprietary text; every entry cites a public source.
 * Matching is deterministic (imports / called APIs / identifier keywords).
 */

export interface MatchRule {
  imports?: string[]; // module/package signals (substring match on import source)
  calls?: string[]; // called-API signals (callee short name)
  keywords?: string[]; // identifier/name signals (word part of the node name)
}

export interface PackEntry {
  id: string;
  topic: string;
  summary: string;
  citation: { title: string; url: string };
  kind: GroundingKind;
  rationale: 'recommended' | 'conjectured';
  match: MatchRule;
}

export interface KnowledgePack {
  id: string;
  version: string;
  license: string;
  entries: PackEntry[];
}

export const FREE_PACK: KnowledgePack = {
  id: 'vibgrate-free',
  version: '2026.06',
  license: 'CC-BY (standards summaries) + Apache-2.0 (own content)',
  entries: [
    {
      id: 'owasp-a01-access-control',
      topic: 'access-control',
      summary:
        'Enforce authorization on every request server-side; deny by default and check the user’s role and ownership, not just authentication.',
      citation: { title: 'OWASP Top 10 2021 A01: Broken Access Control', url: 'https://owasp.org/Top10/A01_2021-Broken_Access_Control/' },
      kind: 'should_follow',
      rationale: 'recommended',
      match: {
        keywords: ['auth', 'authorize', 'authorization', 'permission', 'role', 'access', 'acl', 'rbac', 'tenant'],
        imports: ['casl', 'accesscontrol', 'next-auth'],
      },
    },
    {
      id: 'owasp-a07-auth-failures',
      topic: 'authentication',
      summary:
        'Use vetted auth libraries, hash passwords with a strong adaptive function, rate-limit logins, and keep sessions short and rotated.',
      citation: { title: 'OWASP Top 10 2021 A07: Identification & Authentication Failures', url: 'https://owasp.org/Top10/A07_2021-Identification_and_Authentication_Failures/' },
      kind: 'should_follow',
      rationale: 'recommended',
      match: {
        keywords: ['login', 'authenticate', 'signin', 'session', 'jwt', 'password', 'credential'],
        imports: ['passport', 'jsonwebtoken', 'bcrypt', 'argon2', 'next-auth', 'lucia'],
      },
    },
    {
      id: 'owasp-a02-crypto-failures',
      topic: 'cryptography',
      summary:
        'Prefer well-reviewed primitives; never roll your own crypto; use authenticated encryption and a strong KDF; never hardcode keys.',
      citation: { title: 'OWASP Top 10 2021 A02: Cryptographic Failures', url: 'https://owasp.org/Top10/A02_2021-Cryptographic_Failures/' },
      kind: 'should_follow',
      rationale: 'recommended',
      match: { keywords: ['encrypt', 'decrypt', 'cipher', 'hash', 'hmac', 'crypto', 'sign', 'verify'], imports: ['crypto', 'bcrypt', 'argon2', 'node:crypto', 'tweetnacl'], calls: ['createCipheriv', 'createHash', 'randomBytes'] },
    },
    {
      id: 'owasp-a03-injection',
      topic: 'input-validation',
      summary:
        'Validate and parameterize all untrusted input; use parameterized queries and schema validation rather than string concatenation.',
      citation: { title: 'OWASP Top 10 2021 A03: Injection', url: 'https://owasp.org/Top10/A03_2021-Injection/' },
      kind: 'should_follow',
      rationale: 'recommended',
      match: { keywords: ['validate', 'sanitize', 'escape', 'schema', 'parse'], imports: ['zod', 'joi', 'yup', 'ajv', 'validator', 'class-validator'] },
    },
    {
      id: 'cwe-89-sql-injection',
      topic: 'sql-injection',
      summary:
        'Use parameterized queries / prepared statements or a query builder; never build SQL by concatenating user input.',
      citation: { title: 'CWE-89: SQL Injection', url: 'https://cwe.mitre.org/data/definitions/89.html' },
      kind: 'relevant_to',
      rationale: 'recommended',
      match: { keywords: ['sql', 'query', 'where', 'select'], imports: ['pg', 'mysql', 'mysql2', 'sqlite3', 'better-sqlite3', 'knex', 'sequelize', 'typeorm', 'prisma', 'drizzle'], calls: ['query', 'execute', 'raw'] },
    },
    {
      id: 'cwe-798-hardcoded-credentials',
      topic: 'secrets',
      summary:
        'Do not embed secrets/API keys/passwords in source; load them from a secrets manager or environment and keep them out of version control.',
      citation: { title: 'CWE-798: Use of Hard-coded Credentials', url: 'https://cwe.mitre.org/data/definitions/798.html' },
      kind: 'smells_like',
      rationale: 'conjectured',
      match: { keywords: ['secret', 'apikey', 'apikeys', 'token', 'credential', 'password', 'privatekey'] },
    },
    {
      id: 'cwe-502-deserialization',
      topic: 'deserialization',
      summary:
        'Avoid deserializing untrusted data and never eval it; prefer safe parsers and explicit schemas.',
      citation: { title: 'CWE-502: Deserialization of Untrusted Data', url: 'https://cwe.mitre.org/data/definitions/502.html' },
      kind: 'smells_like',
      rationale: 'conjectured',
      match: { keywords: ['deserialize', 'unserialize', 'eval'], calls: ['eval', 'Function', 'deserialize'] },
    },
    {
      id: 'owasp-a10-ssrf',
      topic: 'ssrf',
      summary:
        'Validate and allowlist outbound URLs built from user input to prevent server-side request forgery.',
      citation: { title: 'OWASP Top 10 2021 A10: Server-Side Request Forgery', url: 'https://owasp.org/Top10/A10_2021-Server-Side_Request_Forgery_%28SSRF%29/' },
      kind: 'relevant_to',
      rationale: 'recommended',
      match: { keywords: ['fetch', 'request', 'webhook', 'proxy'], imports: ['axios', 'node-fetch', 'got', 'undici', 'superagent'], calls: ['fetch', 'request', 'get', 'post'] },
    },
    {
      id: 'owasp-a09-logging',
      topic: 'logging',
      summary:
        'Log security-relevant events with enough context to detect and investigate, but never log secrets or PII.',
      citation: { title: 'OWASP Top 10 2021 A09: Security Logging & Monitoring Failures', url: 'https://owasp.org/Top10/A09_2021-Security_Logging_and_Monitoring_Failures/' },
      kind: 'relevant_to',
      rationale: 'recommended',
      match: { keywords: ['log', 'logger', 'audit', 'trace'], imports: ['winston', 'pino', 'bunyan', 'log4js'] },
    },
  ],
};
