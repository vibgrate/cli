/**
 * Human labels for the code map chrome.
 *
 * Taxonomy slugs stay on the wire (`controller`, `persist`). The map never
 * prints them, or a confidence percentage, to an operator.
 */
export const ROLE_LABEL: Record<string, string> = {
  controller: 'HTTP handler',
  transport: 'HTTP handler',
  user_interface: 'Interface',
  cross_cutting: 'Login check',
  application_service: 'Service',
  use_case: 'Service',
  domain_model: 'Data model',
  domain_service: 'Domain rule',
  port: 'Contract',
  repository: 'Data access',
  persistence: 'Data access',
  infrastructure: 'Infrastructure',
  adapter: 'Adapter',
  integration: 'Integration',
  utility: 'Helper',
  test_support: 'Test helper',
  unknown: 'Unclassified',
  entry_point: 'Entry',
  worker: 'Worker',
  messaging: 'Messaging',
};

export const PURPOSE_LABEL: Record<string, string> = {
  persist: 'Writes data',
  query: 'Reads data',
  network_io: 'Talks over HTTP',
  respond: 'Answers a request',
  authenticate: 'Checks who you are',
  authorise: 'Checks permission',
  authorize: 'Checks permission',
  validate: 'Checks input',
  render: 'Draws the UI',
  encrypt: 'Encrypts',
  decrypt: 'Decrypts',
  publish: 'Publishes an event',
  subscribe: 'Listens for events',
  consume: 'Listens for events',
  cache: 'Caches',
  log: 'Logs',
  orchestrate: 'Orchestrates',
  file_io: 'Reads or writes files',
};

export const KIND_LABEL: Record<string, string> = {
  route: 'HTTP handler',
  function: 'Function',
  method: 'Method',
  class: 'Type',
  interface: 'Contract',
  property: 'Field',
  file: 'File',
  module: 'Module',
  package: 'Package',
  test: 'Test',
  component: 'Component',
  document: 'Document',
  external: 'External',
  resource: 'Infrastructure',
  workload: 'Workload',
  job: 'Job',
  step: 'Step',
  image: 'Image',
  chart: 'Helm chart',
};

export const LANE_FOR_ROLE: Record<string, string> = {
  controller: 'Handlers',
  transport: 'Handlers',
  user_interface: 'Handlers',
  cross_cutting: 'Guards',
  application_service: 'Services',
  use_case: 'Services',
  port: 'Services',
  domain_model: 'Models',
  domain_service: 'Models',
  repository: 'Models',
  persistence: 'Models',
  infrastructure: 'Models',
  adapter: 'Models',
  integration: 'Models',
};

export const ROLE_COLOR: Record<string, string> = {
  controller: '#38bdf8',
  transport: '#38bdf8',
  user_interface: '#38bdf8',
  cross_cutting: '#fb923c',
  application_service: '#22c55e',
  use_case: '#22c55e',
  domain_model: '#94a3b8',
  domain_service: '#94a3b8',
  port: '#fbbf24',
  repository: '#a78bfa',
  persistence: '#a78bfa',
  infrastructure: '#64748b',
  adapter: '#64748b',
};

export const KIND_COLOR: Record<string, string> = {
  route: '#38bdf8',
  function: '#38bdf8',
  method: '#22c55e',
  class: '#22c55e',
  interface: '#fbbf24',
  property: '#94a3b8',
  file: '#a78bfa',
  test: '#22c55e',
  component: '#38bdf8',
};

export const PURPOSE_CONFIDENCE_FLOOR = 0.6;
export const PURPOSE_CHIP_CAP = 3;

export function roleLabel(role: string | undefined): string {
  if (!role) return 'Unclassified';
  return ROLE_LABEL[role] ?? titleize(role);
}

export function purposeLabel(purpose: string | undefined): string {
  if (!purpose) return '';
  return PURPOSE_LABEL[purpose] ?? titleize(purpose);
}

export function kindLabel(kind: string | undefined): string {
  if (!kind) return 'Symbol';
  return KIND_LABEL[kind] ?? titleize(kind);
}

export function titleize(slug: string): string {
  return slug.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function policyLabel(policy: string | undefined): string {
  if (!policy) return 'Architecture rules';
  if (policy.startsWith('layered')) return 'Layered — handlers talk to services';
  if (policy.startsWith('hexagonal')) return 'Hexagonal — handlers only delegate';
  return titleize(policy.replace(/-v\d+$/, ''));
}
