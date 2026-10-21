#Requires -Version 7
<#
.SYNOPSIS
  Installs or updates this fork of T3 Code on Windows.

.DESCRIPTION
  Finds a release of the fork, downloads its Windows installer and checks it
  against the release's SHA256SUMS, quits T3 Code, backs up the files in the
  T3 home's userdata, runs the installer silently, removes all but the newest
  install backups and starts the app again.

.EXAMPLE
  pwsh -File scripts/t4/install-t4.ps1

.EXAMPLE
  pwsh -File scripts/t4/install-t4.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  # Release to install, as a tag or a version. Defaults to the newest release.
  [string] $Version,
  # Don't back up userdata before installing.
  [switch] $SkipBackup,
  # Install backups to keep after a successful install; older ones are removed.
  [ValidateRange(1, [int]::MaxValue)]
  [int] $KeepBackups = 3,
  # Quit T3 Code without asking, even while agents or terminals run in it.
  [switch] $Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# T3 Code's terminals and agents inherit this from its server. It would make
# the app's executable, started for --quit or the restart, run as plain Node.
$env:ELECTRON_RUN_AS_NODE = $null

$repo = 'LukasDoubleU/t4code'
# Tags and asset names of the fork's release workflow, t4-release.yml.
$tagPrefix = 't4-v'
$installerAsset = '^T3-Code-(?<version>.+)-x64\.exe$'
$checksumsAsset = 'SHA256SUMS'

$t3Home = if ($env:T3CODE_HOME) { $env:T3CODE_HOME } else { Join-Path $HOME '.t3' }
$userdata = Join-Path $t3Home 'userdata'

function Fail([string] $message) {
  [Console]::Error.WriteLine("install-t4: $message")
  exit 1
}

function Find-Release {
  $headers = @{ 'User-Agent' = 'install-t4'; Accept = 'application/vnd.github+json' }
  $api = "https://api.github.com/repos/$repo/releases"
  $tags = @($Version, ($tagPrefix + ($Version -replace '^(t4-)?v', ''))) | Select-Object -Unique
  $urls = if ($Version) { $tags | ForEach-Object { "$api/tags/$_" } } else { "$api/latest" }
  foreach ($url in $urls) {
    try { return Invoke-RestMethod $url -Headers $headers }
    catch { if ($_.Exception.Response.StatusCode -ne 404) { throw } }
  }
  Fail "$repo has no release$(if ($Version) { " $Version" })"
}

# The installer registers the app under its uninstall key, named T3 Code by
# official builds and older fork builds and T4 Code by newer ones; the
# executable's name differs between builds.
function Find-InstalledApp {
  $entry = Get-ItemProperty -ErrorAction SilentlyContinue -Path @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
  ) | Where-Object { $_.DisplayName -match '^T[34] Code' -and $_.DisplayIcon } | Select-Object -First 1
  if (-not $entry) { return $null }
  $exe = ($entry.DisplayIcon -replace ',\d+$', '').Trim('"')
  [pscustomobject]@{ Exe = $exe; Dir = Split-Path $exe; Version = $entry.DisplayVersion }
}

function Test-Under([string] $path, [string[]] $dirs) {
  $path -and @($dirs | Where-Object { $path.StartsWith("$_\", [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
}

function Get-AppProcesses($app) {
  Get-CimInstance Win32_Process | Where-Object { Test-Under $_.ExecutablePath $app.Dir }
}

# Agents and terminals are direct children of the app's processes. Its own
# helpers ship with the app or live in the T3 home's tools (the T3 Connect
# tunnel, the headless browser); git and gh run briefly for the server itself.
function Get-AgentProcesses($app, $appProcesses) {
  $ids = @($appProcesses.ProcessId)
  $helpers = @($app.Dir, (Join-Path $t3Home 'tools'))
  Get-CimInstance Win32_Process | Where-Object {
    $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids -and
    $_.Name -notin 'conhost.exe', 'git.exe', 'gh.exe' -and -not (Test-Under $_.ExecutablePath $helpers)
  }
}

function Wait-AppExit($app, [int] $seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-AppProcesses $app) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
}

function Stop-App($app) {
  $processes = @(Get-AppProcesses $app)
  if ($processes.Count -eq 0) { return }
  $agents = @(Get-AgentProcesses $app $processes)
  if ($agents.Count -gt 0) {
    $names = ($agents | Group-Object Name | ForEach-Object { "$($_.Name) x$($_.Count)" }) -join ', '
    Write-Host "T3 Code is running agents or terminals ($names). Quitting stops them."
    if (-not $Force -and -not $WhatIfPreference -and (Read-Host 'Quit T3 Code now? [y/N]') -notmatch '^y(es)?$') {
      Fail 'cancelled; T3 Code keeps running'
    }
  }
  if (-not $PSCmdlet.ShouldProcess('T3 Code', 'Quit')) { return }

  # --quit makes the running app quit the way Quit in its tray menu does. It
  # travels through the app's single-instance lock, which finds the app by a
  # window in this Windows session; over SSH, the app runs in another session.
  Write-Host 'Quitting T3 Code...'
  if ($processes.SessionId -contains (Get-Process -Id $PID).SessionId) {
    Start-Process -FilePath $app.Exe -ArgumentList '--quit'
    Wait-AppExit $app 15
  }
  # Builds from before --quit show their window instead. Closing it quits
  # builds without a tray icon; builds with one hide in the tray again. Those,
  # and an app in another session, are ended, which the database survives like
  # a crash.
  if (Get-AppProcesses $app) {
    $closed = 0
    foreach ($process in Get-Process -Id $processes.ProcessId -ErrorAction SilentlyContinue) {
      if ($process.MainWindowHandle -ne 0 -and $process.CloseMainWindow()) { $closed++ }
    }
    if ($closed -gt 0) { Wait-AppExit $app 15 }
  }
  if (Get-AppProcesses $app) {
    Write-Host 'Ending T3 Code, which stays open in the tray or in another session.'
    foreach ($process in Get-AppProcesses $app) {
      taskkill.exe /PID $process.ProcessId /T /F *> $null
    }
    Wait-AppExit $app 15
    if (Get-AppProcesses $app) { Fail 'T3 Code did not quit' }
  }
  Write-Host 'Quit T3 Code.'
}

function Test-InUse([string] $path) {
  if (-not (Test-Path $path)) { return $false }
  try { [IO.File]::Open($path, 'Open', 'ReadWrite', 'None').Dispose(); $false }
  catch [IO.IOException] { $true }
}

# The installer leaves the subfolders alone (attachments, logs, secrets); what
# a new version migrates is the database and the settings files beside it.
function Backup-Userdata([string] $installedVersion) {
  $name = (Get-Date -Format 'yyyyMMdd-HHmmss') + $(if ($installedVersion) { "-$installedVersion" })
  $target = Join-Path $t3Home "backups\$name\userdata"
  if (-not $PSCmdlet.ShouldProcess($target, 'Back up userdata')) { return $null }
  New-Item -ItemType Directory -Path $target | Out-Null
  Get-ChildItem -LiteralPath $userdata -File -Force | Copy-Item -Destination $target
  Write-Host "Backed up userdata to $target"
  $target
}

# Backup-Userdata names its folders <time>-<installed version>, or <time> when
# no version was installed. Other folders in backups are left alone, such as
# the <time>-undo-peer-links backups of undo-peer-link-migrations.ps1.
function Remove-OldBackups([int] $keep) {
  $old = Get-ChildItem -LiteralPath (Join-Path $t3Home 'backups') -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d{8}-\d{6}(-\d+\.\d+\.\d+\S*)?$' -and $_.Name -notlike '*-undo-peer-links' } |
    Sort-Object Name -Descending | Select-Object -Skip $keep
  foreach ($folder in $old) {
    if (-not $PSCmdlet.ShouldProcess($folder.FullName, 'Remove old backup')) { continue }
    # The install already succeeded, so a backup that can't be removed only warns.
    try {
      Remove-Item -LiteralPath $folder.FullName -Recurse -Force
      Write-Host "Removed old backup $($folder.FullName)"
    } catch {
      Write-Warning "Could not remove old backup $($folder.FullName): $($_.Exception.Message)"
    }
  }
}

# Dot-sourcing the script only defines its functions, for tests.
if ($MyInvocation.InvocationName -eq '.') { return }

$release = Find-Release
$installer = $release.assets | Where-Object { $_.name -match $installerAsset } | Select-Object -First 1
$checksums = $release.assets | Where-Object { $_.name -eq $checksumsAsset } | Select-Object -First 1
if (-not $installer) { Fail "release $($release.tag_name) has no Windows installer" }
if (-not $checksums) { Fail "release $($release.tag_name) has no $checksumsAsset" }
$releaseVersion = [regex]::Match($installer.name, $installerAsset).Groups['version'].Value

$app = Find-InstalledApp
if ($app -and $app.Version -eq $releaseVersion) {
  Write-Host "T3 Code $releaseVersion is already installed."
  exit 0
}
Write-Host "Installing T3 Code $releaseVersion ($($release.tag_name))$(if ($app) { " over $($app.Version)" })."

# -WhatIf still downloads and checks the installer.
$work = Join-Path ([IO.Path]::GetTempPath()) ('install-t4-' + [IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $work -WhatIf:$false | Out-Null
try {
  $installerPath = Join-Path $work $installer.name
  $checksumsPath = Join-Path $work $checksumsAsset
  Write-Host ('Downloading {0} ({1:F0} MB)...' -f $installer.name, ($installer.size / 1MB))
  Invoke-WebRequest $checksums.browser_download_url -OutFile $checksumsPath -Headers @{ 'User-Agent' = 'install-t4' }
  Invoke-WebRequest $installer.browser_download_url -OutFile $installerPath -Headers @{ 'User-Agent' = 'install-t4' }
  $listed = Select-String -LiteralPath $checksumsPath -Pattern "^([0-9a-fA-F]{64})\s+\*?$([regex]::Escape($installer.name))$" |
    Select-Object -First 1
  if (-not $listed) { Fail "$($installer.name) is not listed in $checksumsAsset" }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $installerPath).Hash -ne $listed.Matches[0].Groups[1].Value) {
    Fail "checksum mismatch for $($installer.name)"
  }
  Write-Host 'Checksum OK.'

  if ($app) { Stop-App $app }
  if (-not $WhatIfPreference) {
    foreach ($file in 'statev2.sqlite', 'state.sqlite') {
      # Windows releases the handles of an ended process with a short delay.
      for ($attempt = 1; ($inUse = Test-InUse (Join-Path $userdata $file)) -and $attempt -le 10; $attempt++) { Start-Sleep -Seconds 1 }
      if ($inUse) {
        Fail "$file is still open, likely by a T3 Code background service or a t3 server on this T3 home. Stop it and run again."
      }
    }
  }

  $backup = $null
  $backingUp = -not $SkipBackup -and (Test-Path -LiteralPath $userdata)
  if ($backingUp) {
    $backup = Backup-Userdata $(if ($app) { $app.Version })
  }

  if (-not $PSCmdlet.ShouldProcess($installer.name, 'Run the installer silently')) {
    # Lists what a real run would remove, which also counts the backup it makes.
    if ($WhatIfPreference) { Remove-OldBackups ($KeepBackups - [int]$backingUp) }
    exit 0
  }
  $run = Start-Process -FilePath $installerPath -ArgumentList '/S' -Wait -PassThru
  $app = Find-InstalledApp
  if ($run.ExitCode -ne 0 -or -not $app -or $app.Version -ne $releaseVersion) {
    Fail ("the installer failed (exit code $($run.ExitCode))" + $(if ($backup) { "; the backup is in $backup" }))
  }
  Write-Host "Installed T3 Code $releaseVersion."
  Remove-OldBackups $KeepBackups
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue -WhatIf:$false
}

if ($env:SSH_CONNECTION -or $env:SSH_CLIENT) {
  # An app started from an SSH session runs outside the desktop session.
  Write-Host 'Connected over SSH, so T3 Code was not started: start it on that machine.'
} else {
  Start-Process -FilePath $app.Exe
  Write-Host 'Started T3 Code.'
}
