#requires -Version 7
<#
  Publish @windypro-rourou/dsh-logcat to the npmjs.org registry (the primary channel).

  Usage:
    ./publish-npm.ps1
    ./publish-npm.ps1 --tag latest      # extra args are forwarded to `npm publish`

  Credentials: uses $env:NPM_TOKEN (a granular/automation token with publish rights).
  Auto-load: when NPM_TOKEN is not already set, the script dot-sources the portable
  DSH loader ($env:DSH_HOME\env\load-secrets.ps1, or $env:DSH_SECRETS), so no
  manual export is needed on a machine that has the portable secrets.

  Notes:
    - The token must be a bypass-2FA / automation token; otherwise npm rejects the
      PUT with 403 (E403 "Two-factor authentication ... required").
    - npm may answer "being processed and may take a few minutes" after a
      successful publish; the version shows up on the registry shortly after.
#>
$ErrorActionPreference = 'Stop'

if (-not $env:NPM_TOKEN) {
  $loader = $null
  if ($env:DSH_HOME) { $loader = Join-Path $env:DSH_HOME 'env\load-secrets.ps1' }
  if (-not $loader -and $env:DSH_SECRETS) { $loader = $env:DSH_SECRETS }
  if ($loader -and (Test-Path -LiteralPath $loader)) { . $loader -Quiet }
}

if (-not $env:NPM_TOKEN) { throw 'set NPM_TOKEN to an npm publish token (bypass-2FA / automation) before running this script' }

$manifest = Get-Content (Join-Path $PSScriptRoot 'package.json') -Raw | ConvertFrom-Json
$registry = 'https://registry.npmjs.org'

Write-Host "publishing $($manifest.name)@$($manifest.version) to $registry" -ForegroundColor Cyan

[Environment]::SetEnvironmentVariable('npm_config_//registry.npmjs.org/:_authToken', $env:NPM_TOKEN)
[Environment]::SetEnvironmentVariable('npm_config_registry', $registry)

# Forward any extra arguments (e.g. --tag latest) to npm publish.
& npm.cmd publish @args
if ($LASTEXITCODE -ne 0) { throw "npm publish failed with exit code $LASTEXITCODE" }

Write-Host 'verifying…' -ForegroundColor Cyan
& npm.cmd view $manifest.name version --registry=$registry
if ($LASTEXITCODE -ne 0) { throw "verification failed (npm view exit $LASTEXITCODE)" }

Write-Host "done: $($manifest.name)@$($manifest.version) is on npmjs.org" -ForegroundColor Green
