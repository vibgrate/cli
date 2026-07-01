/** Machine-parseable ingest id for CI, AMI, and other automation (plain stdout, no ANSI). */
export function emitIngestIdLine(ingestId: string, options?: { unchanged?: boolean }): void {
  console.log(`VIBGRATE_INGEST_ID=${ingestId}`);
  if (options?.unchanged) {
    console.log('VIBGRATE_INGEST_UNCHANGED=1');
  }
}

/**
 * Machine-parseable drift score for automation (plain stdout, no ANSI). The Vibgrate
 * remediation agent reads this to gate a run on before/after drift, rather than
 * scraping the human-formatted report. Emitted only when a consumer asks for it
 * (VIBGRATE_EMIT_MARKERS=1, set by the migration agent) so normal CLI output is
 * unchanged.
 */
export function emitDriftScoreLine(score: number): void {
  if (process.env.VIBGRATE_EMIT_MARKERS !== '1') return;
  console.log(`VIBGRATE_DRIFT_SCORE=${score}`);
}
