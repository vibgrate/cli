/**
 * Compose architecture-map overlays. Engine computes; hosts only render.
 *
 * Does not invent an "Architecture Health Score". Overlay meta reports
 * source + painted counts and honest empty copy — never a 0-as-healthy KPI.
 */
import type { VgGraph } from '../../schema.js';
import type {
  ArchOverlayKind,
  ArchOverlayState,
  ArchOverlays,
  ArchOverview,
  ArchSlice,
} from './arch-types.js';
import { withOverviewChurn, withSliceChurn } from './churn-annotations.js';
import { withOverviewDrift, withSliceDrift } from './drift-annotations.js';
import { loadOverlayContext, type OverlayContext } from './overlay-context.js';
import { withOverviewOwnership, withSliceOwnership } from './ownership-annotations.js';
import { withOverviewVulnBadges, withVulnBadges } from './vuln-annotations.js';

const EMPTY: Record<ArchOverlayKind, { missing: string; none: string }> = {
  vulns: {
    missing: 'No reachability from a connected scan. Run vg scan online with a workspace connection.',
    none: 'No reachable vulnerabilities on this map.',
  },
  drift: {
    missing: 'No scan drift yet. Run vg to produce a scan artifact.',
    none: 'No drifted dependencies on this map.',
  },
  ownership: {
    missing: 'No CODEOWNERS file in this repository.',
    none: 'CODEOWNERS does not match any card on this map.',
  },
  churn: {
    missing: 'Git history is not available.',
    none: 'No commit history for files on this map.',
  },
};

export function withArchOverviewOverlays(overview: ArchOverview, root: string, graph?: VgGraph | null): ArchOverview {
  const ctx = loadOverlayContext(root, graph);
  let next = withOverviewVulnBadges(overview, ctx.reachability);
  next = withOverviewDrift(next, ctx);
  next = withOverviewOwnership(next, ctx);
  next = withOverviewChurn(next, ctx);
  return { ...next, overlays: summarizeOverview(next, ctx) };
}

export function withArchSliceOverlays(slice: ArchSlice, root: string, graph?: VgGraph | null): ArchSlice {
  const ctx = loadOverlayContext(root, graph);
  let next = withVulnBadges(slice, ctx.reachability);
  next = withSliceDrift(next, ctx);
  next = withSliceOwnership(next, ctx);
  next = withSliceChurn(next, ctx);
  return { ...next, overlays: summarizeSlice(next, ctx) };
}

function summarizeOverview(overview: ArchOverview, ctx: OverlayContext): ArchOverlays {
  return {
    vulns: state(
      'vulns',
      hasVulnSource(ctx),
      overview.packages.filter((p) => p.vulnerabilities?.length).length,
    ),
    drift: state('drift', hasDriftSource(ctx), overview.packages.filter((p) => p.drift).length),
    ownership: state('ownership', ctx.owners !== null, overview.packages.filter((p) => p.owners?.teams.length).length),
    churn: state('churn', ctx.churn !== null, overview.packages.filter((p) => p.churn).length),
  };
}

function summarizeSlice(slice: ArchSlice, ctx: OverlayContext): ArchOverlays {
  const cards = slice.columns.flatMap((c) => c.cards);
  return {
    vulns: state('vulns', hasVulnSource(ctx), cards.filter((c) => c.vulnerabilities?.length).length),
    drift: state('drift', hasDriftSource(ctx), cards.filter((c) => c.drift).length),
    ownership: state('ownership', ctx.owners !== null, cards.filter((c) => c.owners?.teams.length).length),
    churn: state('churn', ctx.churn !== null, cards.filter((c) => c.churn).length),
  };
}

function hasVulnSource(ctx: OverlayContext): boolean {
  return ctx.artifact?.reachability != null;
}

function hasDriftSource(ctx: OverlayContext): boolean {
  if (!ctx.artifact) return false;
  if (ctx.projects.length) return true;
  return Array.isArray(ctx.artifact.projects);
}

function state(kind: ArchOverlayKind, source: boolean, painted: number): ArchOverlayState {
  const copy = EMPTY[kind];
  return {
    kind,
    source,
    painted,
    empty: source ? copy.none : copy.missing,
  };
}

