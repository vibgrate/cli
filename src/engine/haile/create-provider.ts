/**
 * IP BOUNDARY — the factory lives in the optional `@vibgrate/haile` module.
 * The public CLI loads that module through haile-provider.ts.
 *
 * A missing module means the provider is absent. Never a TypeScript lexicon.
 */
export function createHaileProvider(): null {
  return null;
}
