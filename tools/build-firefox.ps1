<#
    Builds installable Firefox packages.

    Produces two archives with the same code and both engine builds:

      dist/chess-assist-firefox.xpi
      dist/chess-assist-android-nightly.xpi

    They differ only in what each store accepts, not in what the extension can
    do: the phone package carries the full NNUE build too, so a phone runs the
    same engine as a desktop. What changes at runtime is the transposition
    table (64 MB instead of 256 MB on a mobile user agent); if the system kills
    the heavy build, the background page falls back to Lite on its own.

    Both archives have manifest.json at the archive root. Firefox Nightly
    rejects an add-on whose manifest sits inside a sub-folder.

    The script is ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less
    UTF-8 script as ANSI, which corrupts non-ASCII string literals.
#>

param(
  [string]$OutDir = (Join-Path $PSScriptRoot '..\dist')
)

$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

$common = @(
  'manifest.json',
  'background',
  'content',
  'engine',
  'icons',
  'popup',
  'licenses',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'README.md'
)

# Present in the repository but not used by any build.
$excludeAny = @('stockfish-chess-lichess.json')

function New-Stage {
  param([string]$Name)
  $path = Join-Path $env:TEMP ('ca-build-' + $Name + '-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $path | Out-Null
  return $path
}

function Copy-Project {
  param(
    [string]$Destination,
    [string[]]$ExcludeFiles
  )

  foreach ($item in $common) {
    $src = Join-Path $root $item
    if (-not (Test-Path -LiteralPath $src)) { continue }
    Copy-Item -LiteralPath $src -Destination $Destination -Recurse -Force
  }

  # Robocopy treats positional names as file masks, which silently drops whole
  # directories. Copy first, then prune the files that must not ship.
  foreach ($name in $ExcludeFiles) {
    Get-ChildItem -LiteralPath $Destination -Recurse -File -Filter $name |
      Remove-Item -Force
  }
}

function New-Archive {
  param(
    [string]$Stage,
    [string]$ArchivePath
  )

  if (Test-Path -LiteralPath $ArchivePath) { Remove-Item -LiteralPath $ArchivePath -Force }

  Add-Type -AssemblyName System.IO.Compression.FileSystem

  # Entries are written one by one instead of with CreateFromDirectory, because
  # on .NET Framework that helper stores Windows separators ("popup\popup.html").
  # Firefox resolves the forward-slash paths from the manifest, so a backslash
  # entry is a miss: the extension installs, then every page in a sub-folder
  # reports "file not found".
  $zip = [System.IO.Compression.ZipFile]::Open($ArchivePath, 'Create')
  try {
    $prefix = $Stage.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    $files = Get-ChildItem -LiteralPath $Stage -Recurse -File | Sort-Object FullName
    foreach ($file in $files) {
      $name = $file.FullName.Substring($prefix.Length).Replace('\', '/')
      [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $zip,
        $file.FullName,
        $name,
        [System.IO.Compression.CompressionLevel]::Optimal
      )
    }
  } finally {
    $zip.Dispose()
  }
}

function Assert-Manifest {
  param([string]$Path)

  $manifest = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  if ($manifest.manifest_version -ne 2) {
    throw 'manifest_version must stay 2: Firefox for Android has no background service workers.'
  }
  if (-not $manifest.browser_specific_settings.gecko.id) {
    throw 'browser_specific_settings.gecko.id is required for an unsigned install.'
  }
  if (-not $manifest.options_ui -or -not $manifest.options_ui.page) {
    throw 'options_ui is required: on Android that is the only reachable settings page.'
  }
  return $manifest
}

function Get-ArchiveNames {
  param([string]$ArchivePath)

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
  try {
    # A backslash here means the archive was written by code that folded the
    # platform separator into the entry name. Firefox then opens the .xpi,
    # finds manifest.json at the root, and reports every nested file as
    # missing. Fail the build instead of shipping that.
    foreach ($entry in $zip.Entries) {
      if ($entry.FullName.Contains([char]92)) {
        throw "${ArchivePath}: entry ${entry.FullName} uses a backslash separator"
      }
    }
    return @($zip.Entries | ForEach-Object { $_.FullName })
  } finally {
    $zip.Dispose()
  }
}

function Assert-Entries {
  param(
    [string]$ArchivePath,
    [string[]]$MustHave,
    [string[]]$MustNotHave
  )

  $names = Get-ArchiveNames -ArchivePath $ArchivePath

  if ($names -notcontains 'manifest.json') {
    throw "${ArchivePath}: manifest.json is not at the archive root"
  }
  foreach ($needed in $MustHave) {
    $hit = @($names | Where-Object { $_ -like $needed })
    if ($hit.Count -eq 0) { throw "${ArchivePath}: missing ${needed}" }
  }
  foreach ($banned in $MustNotHave) {
    $hit = @($names | Where-Object { $_ -like $banned })
    if ($hit.Count -gt 0) { throw "${ArchivePath}: contains ${banned}" }
  }
  return $names.Count
}

$manifest = Assert-Manifest (Join-Path $root 'manifest.json')
$version = $manifest.version
Write-Host "Chess Assist ${version}"

$desktopStage = New-Stage 'desktop'
$androidStage = New-Stage 'android'

try {
  Copy-Project -Destination $desktopStage -ExcludeFiles $excludeAny
  Copy-Project -Destination $androidStage -ExcludeFiles $excludeAny

  $desktopXpi = Join-Path $OutDir 'chess-assist-firefox.xpi'
  $androidXpi = Join-Path $OutDir 'chess-assist-android-nightly.xpi'

  New-Archive -Stage $desktopStage -ArchivePath $desktopXpi
  New-Archive -Stage $androidStage -ArchivePath $androidXpi

  $desktopCount = Assert-Entries -ArchivePath $desktopXpi -MustHave @(
    'manifest.json',
    'engine/stockfish-19-single.wasm',
    'engine/stockfish.wasm',
    'content/content.js',
    'popup/popup.html'
  ) -MustNotHave $excludeAny

  $androidCount = Assert-Entries -ArchivePath $androidXpi -MustHave @(
    'manifest.json',
    'engine/stockfish-19-single.wasm',
    'engine/stockfish-19-single.js',
    'engine/stockfish.wasm',
    'engine/stockfish.js',
    'content/content.js',
    'content/automove.js',
    'popup/popup.html'
  ) -MustNotHave $excludeAny

  $report = @(
    @{ Path = $desktopXpi; Entries = $desktopCount; Label = 'desktop / full NNUE + Lite' },
    @{ Path = $androidXpi; Entries = $androidCount; Label = 'Android Nightly / full NNUE + Lite' }
  )

  foreach ($item in $report) {
    $size = [math]::Round((Get-Item -LiteralPath $item.Path).Length / 1MB, 1)
    $hash = (Get-FileHash -LiteralPath $item.Path -Algorithm SHA256).Hash
    Write-Host ''
    Write-Host ("{0}" -f $item.Label)
    Write-Host ("  {0}" -f $item.Path)
    Write-Host ("  {0} MB, {1} files" -f $size, $item.Entries)
    Write-Host ("  SHA256 {0}" -f $hash)
  }

  $desktopHash = (Get-FileHash -LiteralPath $desktopXpi -Algorithm SHA256).Hash
  $androidHash = (Get-FileHash -LiteralPath $androidXpi -Algorithm SHA256).Hash
  Write-Host ''
  if ($desktopHash -eq $androidHash) {
    Write-Host 'The two archives are identical: the phone runs the same extension as the desktop.'
  } else {
    Write-Host 'WARNING: archives differ; the phone is meant to match the desktop.'
  }

  Write-Host ''
  Write-Host 'Done. Android install: about:config -> xpinstall.signatures.required = false,'
  Write-Host 'then Settings -> About Firefox Nightly -> tap the logo 5 times ->'
  Write-Host 'Install extension from file.'
} finally {
  Remove-Item -LiteralPath $desktopStage -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $androidStage -Recurse -Force -ErrorAction SilentlyContinue
}
