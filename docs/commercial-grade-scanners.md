# Commercial-Grade Scanner Expansion

This document describes the newly added scanner families, their output schema, and configuration toggles for disabling each scanner.

## New scanner families

### 1) `runtimeConfiguration`
Detects runtime and bootstrap configuration signals:
- Environment variables
- Feature flags
- Hidden config files
- `.env` files
- Secret injection path hints
- Container entrypoint/CMD overrides
- Startup arguments
- JVM flags and memory tuning
- Thread pool settings

### 2) `dataStores`
Detects SQL/NoSQL technologies and schema-related evidence:
- Database engine detection (SQL + NoSQL)
- Connection strings
- Pool/replication/read-replica/failover settings
- Collation/encoding/query timeout defaults
- Manual indexes, tables, views, procedures, triggers, RLS policies
- Other service endpoints (Redis, Kafka, AMQP, Elasticsearch)

### 3) `apiSurface`
Detects external API and integration surface:
- Integration endpoints/URLs
- OpenAPI / Swagger specification extraction (JSON/YAML/YML)
- API version pins (including spec version metadata)
- Query parameter usage
- Webhooks and callback endpoints
- Token expiry policies
- Rate limit overrides and custom headers
- CORS policies
- OAuth scope and token signals

### 4) `operationalResilience`
Detects implicit defaults and reliability behavior:
- Implicit timeouts/retries
- Default pagination/locale/currency/timezone/encoding
- Session stores/distributed locks/job schedulers
- Idempotency/rate-limiting/circuit-breaker indicators
- A/B toggles, regional rules, beta groups, licensing, kill switches
- Connector retry/polling/mapping/schema-registry/DLQ patterns
- Data masking/transformation/timezone handling
- Encryption settings
- Hardcoded secret and password-like assignment signals

### 5) `assetBranding`
Detects visual identity assets for dashboard visibility:
- Favicon assets (with base64 payload embedded in artifact)
- Product logo file discovery

### 6) `ossGovernance`
Detects open-source governance metadata:
- Direct dependency count
- Transitive dependency count (heuristic)
- CVE/vulnerability text signals
- License risk text signals

## Config toggles (`vibgrate.config.ts`)

```ts
import type { VibgrateConfig } from '@vibgrate/cli';

const config: VibgrateConfig = {
  scanners: {
    runtimeConfiguration: { enabled: true },
    dataStores: { enabled: true },
    apiSurface: { enabled: true },
    operationalResilience: { enabled: true },
    assetBranding: { enabled: true },
    ossGovernance: { enabled: true },
  },
};

export default config;
```

Disable any scanner with `enabled: false`.

## Output schema additions (`artifact.extended`)

- `runtimeConfiguration`
- `dataStores`
- `apiSurface`
- `operationalResilience`
- `assetBranding`
- `ossGovernance`

Each block is optional and only present when scanner is enabled and run.

## Dashboard additions

The scan dashboard now includes dedicated cards in Deep Analysis (Drift tab):
- Runtime Configuration
- Data Stores & Schema
- API Integrations
- Operational Resilience
- Branding Assets
- Open-Source Governance

These panels are grouped by scanner family and render structured, truncated evidence lists for readability.

## Reliability notes

- Scanners are deterministic regex+heuristic extractors designed to be safe for broad monorepo scans.
- Results are deduplicated and sorted.
- Large files are bounded by scanner size guardrails.
- All scanners can be disabled independently.
