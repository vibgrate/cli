import {
  sortCodedWarnings,
  splitStampedWarning,
  stampWarning,
  type CodedWarning,
} from '../core-open/warnings.js';
import { compareCodeUnit } from '../util/compare.js';

/**
 * Turn stored warning strings into the human list and the coded list.
 *
 * A stamped line is `{message} [VG_WARN_...]`. Lines with no known code
 * (for example a cache entry written by an older build) stay in `warnings`
 * and are omitted from `codedWarnings`. Coded rows are ordered by code,
 * then by message, in code-unit order. Plain lines use that same order.
 */
export function assembleEngineWarnings(stored: readonly string[]): {
  warnings: string[];
  codedWarnings: CodedWarning[];
} {
  const coded: CodedWarning[] = [];
  const plain: string[] = [];
  for (const line of stored) {
    const split = splitStampedWarning(line);
    if (split) coded.push(split);
    else plain.push(line);
  }
  const sorted = sortCodedWarnings(coded);
  const plainSorted = [...plain].sort(compareCodeUnit);
  return {
    warnings: [...sorted.map((warning) => stampWarning(warning.code, warning.message)), ...plainSorted],
    codedWarnings: sorted,
  };
}
