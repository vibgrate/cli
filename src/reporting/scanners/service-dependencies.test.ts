import { describe, it, expect } from 'vitest';
import { scanServiceDependencies } from './service-dependencies.js';
import type { ProjectScan, DependencyRow } from '../../core-open/index.js';

function makeDep(pkg: string, version: string | null = '1.0.0'): DependencyRow {
  return {
    package: pkg,
    currentSpec: version ? `^${version}` : '^0.0.0',
    resolvedVersion: version,
    latestStable: version,
    majorsBehind: 0,
    drift: 'current',
    section: 'dependencies',
  };
}

function makeProject(name: string, deps: DependencyRow[]): ProjectScan {
  return {
    type: 'node',
    name,
    path: `/test/${name}`,
    frameworks: [],
    dependencies: deps,
    dependencyAgeBuckets: { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 },
  };
}

describe('scanServiceDependencies', () => {
  it('returns empty arrays for empty projects', () => {
    const result = scanServiceDependencies([]);
    expect(result.payment).toEqual([]);
    expect(result.auth).toEqual([]);
    expect(result.email).toEqual([]);
    expect(result.cloud).toEqual([]);
    expect(result.databases).toEqual([]);
    expect(result.messaging).toEqual([]);
    expect(result.observability).toEqual([]);
    expect(result.crm).toEqual([]);
    expect(result.storage).toEqual([]);
    expect(result.search).toEqual([]);
  });

  it('returns empty when no matching packages', () => {
    const project = makeProject('clean', [
      makeDep('express'),
      makeDep('lodash'),
    ]);
    const result = scanServiceDependencies([project]);
    for (const category of Object.values(result)) {
      expect(category).toEqual([]);
    }
  });

  // ── Payment ──

  it('detects payment SDKs', () => {
    const project = makeProject('shop', [
      makeDep('stripe', '14.0.0'),
      makeDep('@stripe/stripe-js', '2.0.0'),
    ]);
    const result = scanServiceDependencies([project]);
    expect(result.payment).toHaveLength(2);
    const stripe = result.payment.find((p) => p.package === 'stripe');
    expect(stripe).toBeDefined();
    expect(stripe!.name).toBe('Stripe');
    expect(stripe!.version).toBe('14.0.0');
  });

  it('detects braintree and paypal', () => {
    const project = makeProject('payments', [
      makeDep('braintree', '3.0.0'),
      makeDep('@paypal/checkout-server-sdk', '1.0.0'),
    ]);
    const result = scanServiceDependencies([project]);
    expect(result.payment.map((p) => p.name)).toContain('Braintree');
    expect(result.payment.map((p) => p.name)).toContain('PayPal');
  });

  // ── Auth ──

  it('detects auth SDKs', () => {
    const project = makeProject('secure', [
      makeDep('passport', '0.7.0'),
      makeDep('jsonwebtoken', '9.0.0'),
      makeDep('next-auth', '4.24.0'),
    ]);
    const result = scanServiceDependencies([project]);
    expect(result.auth).toHaveLength(3);
    expect(result.auth.map((p) => p.name)).toContain('Passport.js');
    expect(result.auth.map((p) => p.name)).toContain('JWT');
    expect(result.auth.map((p) => p.name)).toContain('NextAuth');
  });

  it('detects auth0 and clerk', () => {
    const project = makeProject('auth', [
      makeDep('auth0'),
      makeDep('@clerk/clerk-sdk-node'),
      makeDep('@clerk/react', '6.1.2'),
      makeDep('@okta/okta-auth-js'),
    ]);
    const result = scanServiceDependencies([project]);
    expect(result.auth.map((p) => p.name)).toContain('Auth0');
    expect(result.auth.map((p) => p.name)).toContain('Clerk (Node)');
    expect(result.auth.map((p) => p.name)).toContain('Clerk (React)');
    expect(result.auth.map((p) => p.name)).toContain('Okta');
  });

  // ── Email ──

  it('detects email SDKs', () => {
    const project = makeProject('email', [
      makeDep('@sendgrid/mail'),
      makeDep('nodemailer'),
      makeDep('resend'),
    ]);
    const result = scanServiceDependencies([project]);
    expect(result.email).toHaveLength(3);
    expect(result.email.map((p) => p.name)).toContain('SendGrid');
    expect(result.email.map((p) => p.name)).toContain('Nodemailer');
    expect(result.email.map((p) => p.name)).toContain('Resend');
  });

  // ── Cloud ──

  it('detects cloud SDKs', () => {
    const project = makeProject('infra', [
      makeDep('@aws-sdk/client-s3'),
      makeDep('@azure/identity'),
      makeDep('@google-cloud/storage'),
    ]);
    const result = scanServiceDependencies([project]);
    expect(result.cloud).toHaveLength(3);
    expect(result.cloud.map((p) => p.name)).toContain('AWS S3');
    expect(result.cloud.map((p) => p.name)).toContain('Azure Identity');
    expect(result.cloud.map((p) => p.name)).toContain('GCP Storage');
  });

  it('detects aws-sdk v2 in cloud', () => {
    const project = makeProject('legacy', [makeDep('aws-sdk', '2.1595.0')]);
    const result = scanServiceDependencies([project]);
    expect(result.cloud.map((p) => p.name)).toContain('AWS SDK v2');
  });

  // ── Databases ──

  it('detects database SDKs', () => {
    const project = makeProject('db', [
      makeDep('pg'),
      makeDep('@prisma/client'),
      makeDep('ioredis'),
      makeDep('mongodb'),
    ]);
    const result = scanServiceDependencies([project]);
    expect(result.databases).toHaveLength(4);
    expect(result.databases.map((p) => p.name)).toContain('PostgreSQL');
    expect(result.databases.map((p) => p.name)).toContain('Prisma');
    expect(result.databases.map((p) => p.name)).toContain('Redis (ioredis)');
    expect(result.databases.map((p) => p.name)).toContain('MongoDB');
  });

  it('detects ORM and query builder packages', () => {
    const project = makeProject('data', [
      makeDep('drizzle-orm'),
      makeDep('typeorm'),
      makeDep('sequelize'),
      makeDep('knex'),
    ]);
    const result = scanServiceDependencies([project]);
    expect(result.databases.map((p) => p.name)).toContain('Drizzle');
    expect(result.databases.map((p) => p.name)).toContain('TypeORM');
    expect(result.databases.map((p) => p.name)).toContain('Sequelize');
    expect(result.databases.map((p) => p.name)).toContain('Knex');
  });

  // ── Messaging ──

  it('detects messaging SDKs', () => {
    const project = makeProject('queue', [
      makeDep('@aws-sdk/client-sqs'),
      makeDep('kafkajs'),
      makeDep('bullmq'),
    ]);
    const result = scanServiceDependencies([project]);
    expect(result.messaging).toHaveLength(3);
    expect(result.messaging.map((p) => p.name)).toContain('AWS SQS');
    expect(result.messaging.map((p) => p.name)).toContain('Kafka');
    expect(result.messaging.map((p) => p.name)).toContain('BullMQ');
  });

  it('detects rabbitmq via amqplib', () => {
    const project = makeProject('mq', [makeDep('amqplib')]);
    const result = scanServiceDependencies([project]);
    expect(result.messaging.map((p) => p.name)).toContain('RabbitMQ');
  });

  // ── Observability ──

  it('detects observability SDKs', () => {
    const project = makeProject('monitor', [
      makeDep('@sentry/node'),
      makeDep('@opentelemetry/api'),
      makeDep('dd-trace'),
      makeDep('winston'),
    ]);
    const result = scanServiceDependencies([project]);
    expect(result.observability).toHaveLength(4);
    expect(result.observability.map((p) => p.name)).toContain('Sentry (Node)');
    expect(result.observability.map((p) => p.name)).toContain('OpenTelemetry API');
    expect(result.observability.map((p) => p.name)).toContain('Datadog');
    expect(result.observability.map((p) => p.name)).toContain('Winston');
  });

  // ── CRM ──

  it('detects CRM and communication SDKs', () => {
    const project = makeProject('integrations', [
      makeDep('@slack/web-api'),
      makeDep('hubspot-api-client'),
      makeDep('discord.js'),
    ]);
    const result = scanServiceDependencies([project]);
    expect(result.crm).toHaveLength(3);
    expect(result.crm.map((p) => p.name)).toContain('Slack Web API');
    expect(result.crm.map((p) => p.name)).toContain('HubSpot');
    expect(result.crm.map((p) => p.name)).toContain('Discord');
  });

  // ── Storage ──

  it('detects storage SDKs', () => {
    const project = makeProject('files', [
      makeDep('minio'),
      makeDep('cloudinary'),
      makeDep('@supabase/storage-js'),
    ]);
    const result = scanServiceDependencies([project]);
    expect(result.storage).toHaveLength(3);
    expect(result.storage.map((p) => p.name)).toContain('MinIO');
    expect(result.storage.map((p) => p.name)).toContain('Cloudinary');
    expect(result.storage.map((p) => p.name)).toContain('Supabase Storage');
  });

  // ── Search ──

  it('detects search SDKs', () => {
    const project = makeProject('search', [
      makeDep('@elastic/elasticsearch'),
      makeDep('algoliasearch'),
      makeDep('meilisearch'),
      makeDep('typesense'),
    ]);
    const result = scanServiceDependencies([project]);
    expect(result.search).toHaveLength(4);
    expect(result.search.map((p) => p.name)).toContain('Elasticsearch');
    expect(result.search.map((p) => p.name)).toContain('Algolia');
    expect(result.search.map((p) => p.name)).toContain('Meilisearch');
    expect(result.search.map((p) => p.name)).toContain('Typesense');
  });

  // ── Cross-cutting ──

  it('uses first version found across projects', () => {
    const p1 = makeProject('a', [makeDep('stripe', '12.0.0')]);
    const p2 = makeProject('b', [makeDep('stripe', '14.0.0')]);
    const result = scanServiceDependencies([p1, p2]);
    expect(result.payment).toHaveLength(1);
    expect(result.payment[0]!.version).toBe('12.0.0');
  });

  it('handles null versions', () => {
    const project = makeProject('nullver', [makeDep('stripe', null)]);
    const result = scanServiceDependencies([project]);
    expect(result.payment[0]!.version).toBeNull();
  });

  it('sorts items alphabetically by display name within category', () => {
    const project = makeProject('sorted', [
      makeDep('winston'),
      makeDep('dd-trace'),
      makeDep('@sentry/node'),
      makeDep('pino'),
    ]);
    const result = scanServiceDependencies([project]);
    const names = result.observability.map((p) => p.name);
    expect(names).toEqual([...names].sort());
  });

  it('detects packages shared between cloud and storage', () => {
    // @aws-sdk/client-s3 appears in both cloud and storage categories
    const project = makeProject('dual', [makeDep('@aws-sdk/client-s3', '3.600.0')]);
    const result = scanServiceDependencies([project]);
    expect(result.cloud.map((p) => p.name)).toContain('AWS S3');
    expect(result.storage.map((p) => p.name)).toContain('AWS S3');
  });

  it('handles many dependencies across multiple categories', () => {
    const project = makeProject('full', [
      makeDep('stripe'),
      makeDep('passport'),
      makeDep('@sendgrid/mail'),
      makeDep('@aws-sdk/client-s3'),
      makeDep('pg'),
      makeDep('kafkajs'),
      makeDep('@sentry/node'),
      makeDep('@slack/web-api'),
      makeDep('minio'),
      makeDep('algoliasearch'),
    ]);
    const result = scanServiceDependencies([project]);
    expect(result.payment.length).toBeGreaterThan(0);
    expect(result.auth.length).toBeGreaterThan(0);
    expect(result.email.length).toBeGreaterThan(0);
    expect(result.cloud.length).toBeGreaterThan(0);
    expect(result.databases.length).toBeGreaterThan(0);
    expect(result.messaging.length).toBeGreaterThan(0);
    expect(result.observability.length).toBeGreaterThan(0);
    expect(result.crm.length).toBeGreaterThan(0);
    expect(result.storage.length).toBeGreaterThan(0);
    expect(result.search.length).toBeGreaterThan(0);
  });
});
