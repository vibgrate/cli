#!/usr/bin/env node
// Set a GHCR container package's visibility to public.
//
// GITHUB_TOKEN from Actions often lacks package-admin on org packages, so this
// tries PACKAGES_ADMIN_TOKEN (if exported as GH_TOKEN) and prints the exact
// org-owner UI path when the API refuses. Callers treat a non-zero exit as
// "owner click still required", not as a failed publish — the artifact is
// already on the registry.
//
// Usage:
//   GH_TOKEN=… node scripts/ghcr-set-visibility.mjs --owner vibgrate --package cli
//   GH_TOKEN=… node scripts/ghcr-set-visibility.mjs --owner vibgrate --package charts/vibgrate
//
// Exit 0 if the package is public (or was just made public).
// Exit 2 if the API could not flip visibility (owner action required).
// Exit 1 on usage / unexpected errors.

import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

export function visibilityUrl(owner, packageName) {
  // GHCR stores Helm OCI charts as container packages. Nested names
  // (`charts/vibgrate`) must be percent-encoded as a single path segment.
  const encoded = encodeURIComponent(packageName);
  return `https://api.github.com/orgs/${owner}/packages/container/${encoded}/visibility`;
}

export function packageSettingsUrl(owner, packageName) {
  return `https://github.com/orgs/${owner}/packages/container/${packageName}/settings`;
}

export async function setPackagePublic({ owner, packageName, token, fetchImpl = fetch }) {
  if (!owner || !packageName) {
    throw new Error('setPackagePublic: owner and packageName are required');
  }
  if (!token) {
    return {
      ok: false,
      status: 0,
      reason: 'no token',
      settingsUrl: packageSettingsUrl(owner, packageName),
    };
  }
  const url = visibilityUrl(owner, packageName);
  const res = await fetchImpl(url, {
    method: 'PUT',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ visibility: 'public' }),
  });
  if (res.ok) {
    return { ok: true, status: res.status, settingsUrl: packageSettingsUrl(owner, packageName) };
  }
  const body = await res.text().catch(() => '');
  return {
    ok: false,
    status: res.status,
    reason: body.slice(0, 400) || res.statusText,
    settingsUrl: packageSettingsUrl(owner, packageName),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const owner = arg('--owner');
  const packageName = arg('--package');
  if (!owner || !packageName) {
    console.error('usage: node scripts/ghcr-set-visibility.mjs --owner <org> --package <name>');
    process.exit(1);
  }
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  const result = await setPackagePublic({ owner, packageName, token });
  if (result.ok) {
    console.log(`GHCR package ghcr.io/${owner}/${packageName} is public.`);
    process.exit(0);
  }
  console.error(`Could not set ghcr.io/${owner}/${packageName} public (HTTP ${result.status}).`);
  if (result.reason) console.error(result.reason);
  console.error(`Owner action: ${result.settingsUrl} → Change visibility → Public.`);
  process.exit(2);
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
