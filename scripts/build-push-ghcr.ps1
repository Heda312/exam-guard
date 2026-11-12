# Build and push the ExamGuard images to GHCR from your own machine.
#
# Use this when GitHub Actions is unavailable (for example, a locked billing
# account). It produces the same images the workflow would:
#
#   ghcr.io/<owner>/exam-guard-api:latest
#   ghcr.io/<owner>/exam-guard-web:latest
#
# Usage (PowerShell):
#   $env:GHCR_OWNER = "heda312"
#   $env:GHCR_TOKEN = "<PAT with write:packages>"
#   .\scripts\build-push-ghcr.ps1
#
# Usage (bash):
#   GHCR_OWNER=heda312 GHCR_TOKEN=... ./scripts/build-push-ghcr.sh

[CmdletBinding()]
param(
    [string]$Owner = $env:GHCR_OWNER,
    [string]$Token = $env:GHCR_TOKEN,
    [string]$Tag = $(if ($env:IMAGE_TAG) { $env:IMAGE_TAG } else { "latest" }),
    [string]$Registry = "ghcr.io",
    [string[]]$Platforms = @("linux/amd64", "linux/arm64")
)

$ErrorActionPreference = "Stop"

function Fail($message) {
    Write-Host "[FAIL] $message" -ForegroundColor Red
    exit 1
}

if (-not $Owner) { Fail "GHCR_OWNER belum diset (contoh: `$env:GHCR_OWNER='heda312')" }
if (-not $Token) { Fail "GHCR_TOKEN belum diset (PAT dengan scope write:packages)" }

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Fail "docker tidak ditemukan di PATH"
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
    Write-Host "==> Login ke $Registry sebagai $Owner" -ForegroundColor Cyan
    $Token | docker login $Registry -u $Owner --password-stdin
    if ($LASTEXITCODE -ne 0) { Fail "docker login gagal" }

    $apiImage = "$Registry/$Owner/exam-guard-api:$Tag"
    $webImage = "$Registry/$Owner/exam-guard-web:$Tag"
    $platformList = $Platforms -join ","

    # buildx is required for multi-arch builds.
    docker buildx create --name examguard-builder --use 2>$null | Out-Null
    docker buildx inspect --bootstrap | Out-Null

    Write-Host "==> Build & push $apiImage ($platformList)" -ForegroundColor Cyan
    docker buildx build `
        --platform $platformList `
        --file Dockerfile `
        --tag $apiImage `
        --push `
        .
    if ($LASTEXITCODE -ne 0) { Fail "build API gagal" }

    Write-Host "==> Build & push $webImage ($platformList)" -ForegroundColor Cyan
    docker buildx build `
        --platform $platformList `
        --file web.Dockerfile `
        --tag $webImage `
        --push `
        .
    if ($LASTEXITCODE -ne 0) { Fail "build web gagal" }

    Write-Host ""
    Write-Host "[PASS] Image ter-push:" -ForegroundColor Green
    Write-Host "  $apiImage"
    Write-Host "  $webImage"
    Write-Host ""
    Write-Host "Langkah berikutnya:" -ForegroundColor Cyan
    Write-Host "  1. GitHub -> Packages -> pilih package -> Package settings"
    Write-Host "     -> Change visibility (public) ATAU tambahkan credential di Portainer."
    Write-Host "  2. Portainer: Stacks -> Add stack -> paste deploy/portainer-stack.yml"
    Write-Host "     dengan IMAGE_TAG=$Tag"
}
finally {
    Pop-Location
}
