// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * Minimum supported Clerk SDK versions for billing and org features.
 * Keep in sync with Clerk release notes when bumping dashboard dependencies.
 */
export const CLERK_SDK_MINIMUM_VERSIONS: Record<string, string> = {
  '@clerk/clerk-js': '6.3.2',
  '@clerk/nextjs': '7.0.6',
  '@clerk/react-router': '3.0.6',
  '@clerk/tanstack-react-start': '1.0.6',
  '@clerk/expo': '3.1.4',
  '@clerk/astro': '3.0.6',
  '@clerk/chrome-extension': '3.1.4',
  '@clerk/express': '2.0.6',
  '@clerk/fastify': '3.1.4',
  '@clerk/hono': '0.1.4',
  '@clerk/nuxt': '2.0.6',
  '@clerk/react': '6.1.2',
  '@clerk/vue': '2.0.6',
};

/** Legacy package names that should migrate to a modern Clerk SDK. */
export const CLERK_LEGACY_PACKAGES: Record<string, string> = {
  '@clerk/clerk-react': '@clerk/react',
};
