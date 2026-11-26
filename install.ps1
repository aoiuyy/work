<#
.SYNOPSIS
  Automatic 1-Click Installer for @local/work-v2 into DeepSeek Harness (DSH).
  Designed for autonomous AI Agents & human engineers on Machine 2 / remote machines.
.PARAMETER TargetProfileDir
  Path to DSH profile directory (e.g. C:\DSH\.dsh\profiles\web or D:\Software\ds-harness\.dsh\profiles\web).
.PARAMETER LinkMode
  'copy' (default, standalone copy immune to deleting Downloads) or 'junction' (dev link).
#>
[CmdletBinding()]
param(
  [string]$TargetProfileDir = "",
  [ValidateSet("junction", "copy")]
  [string]$LinkMode = "copy",
  [switch]$DryRun = $false
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "====================================================================" -ForegroundColor Cyan
Write-Host " [Work v2.0.1] Automatic 1-Click Installer for DSH (@local/work-v2)" -ForegroundColor Cyan
Write-Host " Source: $ScriptDir" -ForegroundColor Gray
Write-Host "====================================================================" -ForegroundColor Cyan

# 1. Auto-discover DSH Desktop / Web Profile directory
if (-not $TargetProfileDir) {
  $Candidates = @(
    $env:DSH_PROFILE_DIR,
    "C:\DSH\.dsh\profiles\desktop",
    "$env:USERPROFILE\.dsh\profiles\desktop",
    "$env:LOCALAPPDATA\ds-harness\.dsh\profiles\desktop",
    (Join-Path $ScriptDir "..\..\.dsh\profiles\desktop"),
    (Join-Path $ScriptDir "..\..\..\.dsh\profiles\desktop"),
    "C:\DSH\.dsh\profiles\web",
    "D:\Software\ds-harness\.dsh\profiles\web",
    "$env:USERPROFILE\.dsh\profiles\web",
    "$env:LOCALAPPDATA\ds-harness\.dsh\profiles\web",
    (Join-Path $ScriptDir "..\..\.dsh\profiles\web"),
    (Join-Path $ScriptDir "..\..\..\.dsh\profiles\web")
  )

  foreach ($Candidate in $Candidates) {
    if ($Candidate -and (Test-Path $Candidate)) {
      $TargetProfileDir = (Resolve-Path $Candidate).Path
      break
    }
  }
}

if (-not $TargetProfileDir) {
  Write-Warning "Default DSH web profile directory not found."
  Write-Host "Please specify: .\install.ps1 -TargetProfileDir <path_to_dsh_profile_web>" -ForegroundColor Yellow
  exit 1
}

Write-Host "[1/4] DSH Profile Path: $TargetProfileDir" -ForegroundColor Green

# 2. Prepare dependencies if node_modules is missing
$LocalNodeModules = Join-Path $ScriptDir "node_modules"
if (-not (Test-Path $LocalNodeModules)) {
  Write-Host "[2/4] Installing minimal runtime dependencies..." -ForegroundColor Cyan
  Push-Location $ScriptDir
  try {
    npm install --omit=dev --no-audit --no-fund
  } catch {
    Write-Warning "npm install had warnings, continuing..."
  } finally {
    Pop-Location
  }
} else {
  Write-Host "[2/4] Dependencies verified (node_modules present)." -ForegroundColor Green
}

# 3. Setup node_modules/@local junction/copy
$LocalScopeDir = Join-Path $TargetProfileDir "node_modules\@local"
$DestinationPluginDir = Join-Path $LocalScopeDir "work-v2"

if (-not (Test-Path $LocalScopeDir)) {
  New-Item -ItemType Directory -Path $LocalScopeDir -Force | Out-Null
}

if (Test-Path $DestinationPluginDir) {
  Write-Host "[3/4] Updating existing installation..." -ForegroundColor Yellow
  $Item = Get-Item $DestinationPluginDir
  if ($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    cmd /c rmdir "$DestinationPluginDir" 2>$null
  } else {
    Remove-Item -Path $DestinationPluginDir -Recurse -Force
  }
}

if ($LinkMode -eq "junction" -and $env:OS -like "*Windows*") {
  cmd /c mklink /J "$DestinationPluginDir" "$ScriptDir" | Out-Null
  Write-Host "[3/4] Created NTFS Junction link." -ForegroundColor Green
} else {
  Copy-Item -Path $ScriptDir -Destination $DestinationPluginDir -Recurse -Force
  Write-Host "[3/4] Copied plugin files into DSH." -ForegroundColor Green
}

# 4. Register in profile package.json (bundles & dependencies)
$ProfilePkgPath = Join-Path $TargetProfileDir "package.json"
if (Test-Path $ProfilePkgPath) {
  try {
    $pkgJson = Get-Content $ProfilePkgPath -Raw | ConvertFrom-Json
    $modified = $false

    if (-not $pkgJson.dependencies) {
      $pkgJson | Add-Member -MemberType NoteProperty -Name "dependencies" -Value ([PSCustomObject]@{})
    }
    if (-not $pkgJson.dependencies.'@local/work-v2') {
      $pkgJson.dependencies | Add-Member -MemberType NoteProperty -Name "@local/work-v2" -Value "link:$DestinationPluginDir" -Force
      $modified = $true
    }

    if ($pkgJson.dsh -and $pkgJson.dsh.profile -and ($null -ne $pkgJson.dsh.profile.PSObject.Properties['bundles'])) {
      $bundleList = [System.Collections.ArrayList]@()
      foreach ($item in @($pkgJson.dsh.profile.bundles)) {
        if ($item) { [void]$bundleList.Add([string]$item) }
      }
      if (-not $bundleList.Contains("@local/work-v2")) {
        [void]$bundleList.Add("@local/work-v2")
        $pkgJson.dsh.profile.bundles = @($bundleList.ToArray())
        $modified = $true
      }
    }

    if ($modified) {
      $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
      [System.IO.File]::WriteAllText($ProfilePkgPath, (($pkgJson | ConvertTo-Json -Depth 10) + "`n"), $utf8NoBom)
      Write-Host "[4/4] Registered @local/work-v2 in profile package.json." -ForegroundColor Green
    } else {
      Write-Host "[4/4] Already registered in profile package.json." -ForegroundColor Green
    }
  } catch {
    Write-Warning "Could not update profile package.json automatically: $_"
  }
}

# 5. Run native smoke test if tests/ is present
$TestExit = 0
if (Test-Path (Join-Path $ScriptDir "tests\index.test.js")) {
  Write-Host "Running native test suite..." -ForegroundColor Cyan
  Set-Location $ScriptDir
  try {
    & node --test tests/index.test.js
    $TestExit = $LASTEXITCODE
  } catch {
    $TestExit = 1
  }
}

if ($TestExit -eq 0) {
  Write-Host "`n====================================================================" -ForegroundColor Green
  Write-Host " [SUCCESS] @local/work-v2 is ready for use in DSH!" -ForegroundColor Green
  Write-Host " Restart DSH Desktop or Web to load Work." -ForegroundColor Cyan
  Write-Host "====================================================================" -ForegroundColor Green
} else {
  Write-Warning "Tests completed with code $TestExit. Check logs above."
}
