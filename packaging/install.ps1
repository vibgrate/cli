# vg installer (irm | iex) for Windows PowerShell.
# Installs @vibgrate/cli (provides the `vg` command). Requires Node.js >= 20.
# Never call `exit` here: under `irm … | iex` the body runs in the caller's
# session, so `exit` would close the user's terminal. `throw` stops the script
# and leaves the host open.
$ErrorActionPreference = 'Stop'
$pkg = '@vibgrate/cli'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'vg: Node.js >= 20 is required (https://nodejs.org).'
}
$nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) {
  throw "vg: Node.js >= 20 is required (found $(node --version)). Upgrade at https://nodejs.org."
}
if (Get-Command npm -ErrorAction SilentlyContinue) {
  Write-Host "vg: installing $pkg globally via npm…"
  npm install -g $pkg
  if ($LASTEXITCODE -ne 0) { throw 'vg: npm install failed.' }
  Write-Host "vg: done. Run 'vg' in a project to build its code map."
} else {
  throw 'vg: npm not found. Install Node.js with npm from https://nodejs.org, then rerun.'
}
