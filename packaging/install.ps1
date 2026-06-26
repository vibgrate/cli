# vg installer (irm | iex) for Windows PowerShell.
# Installs @vibgrate/cli (provides the `vg` command). Requires Node.js >= 20.
$ErrorActionPreference = 'Stop'
$pkg = '@vibgrate/cli'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error 'vg: Node.js >= 20 is required (https://nodejs.org).'
  exit 1
}
if (Get-Command npm -ErrorAction SilentlyContinue) {
  Write-Host "vg: installing $pkg globally via npm…"
  npm install -g $pkg
  Write-Host "vg: done. Run 'vg' in a project to build its code map."
} else {
  Write-Error "vg: npm not found. Use: npx $pkg vg"
  exit 1
}
