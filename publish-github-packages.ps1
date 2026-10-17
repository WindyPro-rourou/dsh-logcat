#requires -Version 7
<#
  Publish @windypro-rourou/dsh-logcat to the GitHub Packages npm registry
  (https://npm.pkg.github.com), mirroring what is already on npmjs.org.

  Requires a GitHub token with: write:packages (plus read:packages and repo).
  Classic PAT: Settings → Developer settings → Tokens (classic) → scopes.
  Granular PAT: Repository access (this repo) + "Packages: Read and write".

  Usage:
    $env:GH_TOKEN = "ghp_xxx"      # or github_pat_xxx
    ./publish-github-packages.ps1

  Auto-load: when GH_TOKEN is not already set, the script dot-sources the portable
  DSH loader ($env:DSH_HOME\env\load-secrets.ps1, or $env:DSH_SECRETS), so a
  machine with the portable secrets in place needs no manual export at all.

  Notes:
    - GitHub Packages keeps only the `latest` dist-tag; `preview` exists on npmjs.org only.
    - Installing from this registry always requires auth, even for public packages.
#>
$ErrorActionPreference = 'Stop'

# Auto-load credentials when the session does not carry them yet.
if (-not $env:GH_TOKEN) {
  $loader = $null
  if ($env:DSH_HOME) { $loader = Join-Path $env:DSH_HOME 'env\load-secrets.ps1' }
  if (-not $loader -and $env:DSH_SECRETS) { $loader = $env:DSH_SECRETS }
  if ($loader -and (Test-Path -LiteralPath $loader)) { . $loader -Quiet }
}

if (-not $env:GH_TOKEN) { throw 'set GH_TOKEN to a PAT with write:packages before running this script' }

$manifest = Get-Content (Join-Path $PSScriptRoot 'package.json') -Raw | ConvertFrom-Json
$ownerScope = $manifest.name.Split('/')[0]            # e.g. @windypro-rourou
$registry = 'https://npm.pkg.github.com'

Write-Host "publishing $($manifest.name)@$($manifest.version) to $registry as $ownerScope" -ForegroundColor Cyan

# Scope the registry to the owner and pass the token through the process
# environment only — never write credentials into a file.
[Environment]::SetEnvironmentVariable('npm_config_registry', $registry)
[Environment]::SetEnvironmentVariable("npm_config_${ownerScope}:registry", $registry)
[Environment]::SetEnvironmentVariable('npm_config_//npm.pkg.github.com/:_authToken', $env:GH_TOKEN)

& npm.cmd publish --registry=$registry
if ($LASTEXITCODE -ne 0) { throw "npm publish failed with exit code $LASTEXITCODE" }

Write-Host 'verifying…' -ForegroundColor Cyan
& npm.cmd view $manifest.name version --registry=$registry
if ($LASTEXITCODE -ne 0) { throw "verification failed (npm view exit $LASTEXITCODE)" }

Write-Host "done: $($manifest.name)@$($manifest.version) is on GitHub Packages" -ForegroundColor Green
