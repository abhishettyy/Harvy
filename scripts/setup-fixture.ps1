# Copies the demo fixture out of the GoAgent repo and makes it a standalone git repo.
# GoAgent agents work in git worktrees of the project, so the fixture must be its own
# repository with at least one commit, not a folder inside GoAgent's repo.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts\setup-fixture.ps1 [-Target <dir>] [-Force]
param(
  [string]$Target = "D:\GoAgent-fixtures\profile-app",
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$source = Join-Path $PSScriptRoot "..\fixtures\profile-app" | Resolve-Path

if (Test-Path $Target) {
  if (-not $Force) {
    throw "$Target already exists. Pass -Force to delete it and start over."
  }
  Remove-Item -Recurse -Force $Target
}
New-Item -ItemType Directory -Force $Target | Out-Null

# Copy sources only: no dependencies, databases, local env files or git metadata.
robocopy $source $Target /E /XD node_modules .git /XF *.sqlite .env .goagent-test-results.json /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }

Push-Location $Target
try {
  git init -q -b main
  git add -A
  git -c user.name="GoAgent" -c user.email="goagent@localhost" commit -q -m "Fixture baseline"
  if ($LASTEXITCODE -ne 0) { throw "git commit failed" }
  pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }
} finally {
  Pop-Location
}

Write-Host "Fixture ready at $Target. Add this folder as a project in T3 Code."
