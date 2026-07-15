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

## Safe harbor

Follow this policy in good faith and we will treat your research as authorized.
We will work with you to fix the issue. We will not take legal action against
you. If someone else brings a claim against you for work done under this policy,
we will say plainly that you were authorized.

Good faith means four things:

- You do not read, change, or delete data that is not yours.
- You do not degrade the service for other people.
- You give us time to fix the problem before you tell anyone else.
- You stop and tell us the moment you find someone else's data.

## A note on how the CLI handles your code

The Vibgrate CLI runs **locally and offline by default**:

- There is **no telemetry** in the default path.
- Your code is parsed **on your machine**. It does not leave. The code graph,
  drift reports, and MCP server all read local files (such as `graph.json`).
- The local MCP server (`vg serve`) exposes **read-only** tools.
- The code graph needs **no API key** and makes no network calls.

Some commands do reach the network — fetching version-correct library docs, for
one. Those are explicit and opt-in. Push a scan to Vibgrate Cloud and what leaves
your machine is metadata: package names, versions, findings, a score. A closed
schema checks it on arrival.

**The remediation agent is the one exception across Vibgrate.** When you ask it
to write a fix, it clones your repository into an isolated virtual machine we
control, makes the change, and hands you a pull request. It only runs when you
ask. See <https://vibgrate.com/subprocessors> for who handles what.

Find a path where code or sensitive data leaves your machine without you asking?
That is a security issue. Report it through the process above.

More on Vibgrate's security posture: <https://vibgrate.com/security>.
