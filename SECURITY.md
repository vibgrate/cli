# Security Policy

## Supported versions

The Vibgrate CLI follows a rolling release model. Security fixes land on the
latest published version of [`@vibgrate/cli`](https://www.npmjs.com/package/@vibgrate/cli).

| Version            | Supported          |
| ------------------ | ------------------ |
| Latest release     | :white_check_mark: |
| Previous releases  | :x:                |

Please upgrade to the latest version before reporting a vulnerability, and
verify the issue still reproduces there.

## Reporting a vulnerability

**Please do not open public GitHub issues, pull requests, or discussions for
security vulnerabilities.** Public disclosure before a fix is available puts
users at risk.

Instead, report privately to:

**[security@vibgrate.com](mailto:security@vibgrate.com)**

Please include:

- A description of the vulnerability and its impact
- Steps to reproduce (a minimal proof of concept is ideal)
- The affected version(s) and your environment (OS, Node.js version)
- Any suggested remediation, if you have one

If you prefer, you may also use GitHub's private
["Report a vulnerability"](https://github.com/vibgrate/cli/security/advisories/new)
flow.

## Response expectations

- **Acknowledgement:** within 3 business days of your report.
- **Triage and initial assessment:** within 7 business days.
- **Fix or mitigation plan:** communicated as soon as the severity and scope are
  understood; timelines depend on complexity.
- **Disclosure:** we coordinate public disclosure with you after a fix is
  released. We are happy to credit reporters who wish to be named.

## A note on how the CLI handles your code

The Vibgrate CLI is designed to run **locally and offline by default**:

- There is **no telemetry** in the default path.
- Your source code is parsed and analyzed **on your machine**. In the default
  workflow, source never leaves the machine — the code graph, drift reports, and
  MCP server all operate against local artifacts (e.g. `graph.json`).
- The local MCP server (`vg serve`) exposes **read-only** tools.
- The deterministic code graph requires **no API key** and makes no network
  calls.

Some optional commands (for example, fetching version-correct library
documentation) may make outbound network requests; these are explicit and
opt-in. If you discover a path where source or sensitive data is transmitted
unexpectedly in the default workflow, please treat it as a security issue and
report it via the process above.
