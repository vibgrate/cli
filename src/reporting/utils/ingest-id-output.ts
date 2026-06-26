/** Machine-parseable ingest id for CI, AMI, and other automation (plain stdout, no ANSI). */
export function emitIngestIdLine(ingestId: string, options?: { unchanged?: boolean }): void {
  console.log(`VIBGRATE_INGEST_ID=${ingestId}`);
  if (options?.unchanged) {
    console.log('VIBGRATE_INGEST_UNCHANGED=1');
  }
}
