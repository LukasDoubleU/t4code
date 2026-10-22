#Requires -Version 7
<#
.SYNOPSIS
  Installs or updates this fork of T3 Code on Windows.

.DESCRIPTION
  Finds a release of the fork, downloads its Windows installer and checks it
  against the release's SHA256SUMS, asks T4 Code whether turns run, quits it
  once none does or the user agrees, backs up the files in the
  T3 home's userdata, runs the installer silently, removes all but the newest
  install backups and starts the app again.

.EXAMPLE
  pwsh -File scripts/t4/install-t4.ps1

.EXAMPLE
  pwsh -File scripts/t4/install-t4.ps1 -WhatIf

.EXAMPLE
  pwsh -File scripts/t4/install-t4.ps1 -Wait 60
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
  # Minutes to wait for running turns and terminal commands to finish before quitting T4 Code.
  [ValidateRange(0, [int]::MaxValue)]
  [int] $Wait = 0,
  # Quit T4 Code without asking, even while turns or terminal commands run in
  # it, or when it can't be asked.
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

# The installed app's own t3 CLI, run as plain Node the way the app runs its
# server, so it opens the database at the version the server runs. Its output,
# or nothing when it fails. The executable is a GUI app, which PowerShell
# doesn't wait for when it is called directly.
function Invoke-AppCli($app, [string[]] $arguments) {
  $archive = Join-Path $app.Dir 'resources\server.asar'
  if (-not (Test-Path -LiteralPath $archive)) { return $null }
  $output = [IO.Path]::GetTempFileName()
  $errors = [IO.Path]::GetTempFileName()
  $env:ELECTRON_RUN_AS_NODE = '1'
  try {
    # Windows paths can't contain quotes, so quoting each argument is enough.
    $quoted = @(Join-Path $archive 'apps\server\dist\bin.mjs') + $arguments | ForEach-Object { '"{0}"' -f $_ }
    $run = Start-Process -FilePath $app.Exe -ArgumentList $quoted -Wait -PassThru -NoNewWindow `
      -RedirectStandardOutput $output -RedirectStandardError $errors -WhatIf:$false
    if ($run.ExitCode -eq 0) { Get-Content -LiteralPath $output -Raw }
  } finally {
    $env:ELECTRON_RUN_AS_NODE = $null
    Remove-Item -LiteralPath $output, $errors -Force -ErrorAction SilentlyContinue -WhatIf:$false
  }
}

# A short-lived token that only reads, for asking the server what runs in it.
function Open-ServerSession($app) {
  $issued = Invoke-AppCli $app @('auth', 'session', 'issue', '--base-dir', $t3Home, '--scope', 'orchestration:read',
    '--ttl', "$($Wait + 10)m", '--label', 'install-t4', '--json')
  if (-not $issued) { return $null }
  try { $issued | ConvertFrom-Json } catch { $null }
}

function Close-ServerSession($app, $session) {
  if ($session) { Invoke-AppCli $app @('auth', 'session', 'revoke', '--base-dir', $t3Home, $session.sessionId) | Out-Null }
}

# What quitting would interrupt, as .Work, or $null when the server can't be
# asked. Threads count while their turn is preparing, starting, running or
# waiting for an answer; a provider session kept warm between turns is no turn.
function Get-RunningWork($session) {
  try {
    $state = Get-Content -LiteralPath (Join-Path $userdata 'server-runtime.json') -Raw | ConvertFrom-Json
    $snapshot = Invoke-RestMethod "$($state.origin)/api/orchestration/shell" -TimeoutSec 30 -Headers @{
      authorization = "Bearer $($session.token)"
      'x-t3-orchestration-protocol' = '2'
    }
  } catch { return $null }
  if ($null -eq $snapshot.threads) { return $null }
  $turns = @($snapshot.threads) + @($snapshot.archivedThreads) | Where-Object activityRunStatus |
    ForEach-Object { '"{0}" ({1})' -f $_.title, $_.activityRunStatus }
  # Terminals are shells the server starts without a command, unlike those
  # provider CLIs start through. One counts while its shell has a child, a
  # command running in it; a shell at its prompt doesn't, as a warm session doesn't.
  $processes = @(Get-CimInstance Win32_Process)
  $commands = $processes | Where-Object {
    $_.ParentProcessId -eq $state.pid -and $_.Name -match '^(pwsh|powershell|cmd|bash|sh|zsh|fish|nu)\.exe$' -and
    $_.CommandLine -notmatch '(?i)\s[/-](c|k|lc|command|file|encodedcommand)(\s|$)'
  } | ForEach-Object {
    $shell = $_
    $child = $processes | Where-Object {
      $_.ParentProcessId -eq $shell.ProcessId -and $_.Name -notin 'conhost.exe', 'OpenConsole.exe'
    } | Select-Object -First 1
    if ($child) { "a terminal ($($shell.Name)) running $($child.Name)" }
  }
  [pscustomobject]@{ Work = @(@($turns) + @($commands) | Where-Object { $_ }) }
}

# Waits up to -Wait minutes for running work to finish, then asks before
# quitting what still runs, or when the server can't be asked.
function Confirm-Quit($app) {
  $session = Open-ServerSession $app
  $running = $null
  try {
    $deadline = (Get-Date).AddMinutes($Wait)
    $waiting = $false
    while ($session -and ($running = Get-RunningWork $session) -and $running.Work.Count -gt 0 -and
      -not $WhatIfPreference -and (Get-Date) -lt $deadline) {
      if (-not $waiting) {
        Write-Host "Waiting for T4 Code to finish (-Wait $Wait):"
        $running.Work | ForEach-Object { Write-Host "  $_" }
        $waiting = $true
      }
      Start-Sleep -Seconds 15
    }
  } finally {
    Close-ServerSession $app $session
  }
  if (-not $running) {
    Write-Host 'Could not ask T4 Code what runs in it. Quitting stops any turns and terminal commands.'
    $advice = 'pass -Force to quit it anyway'
  } elseif ($running.Work.Count -gt 0) {
    Write-Host 'T4 Code is running:'
    $running.Work | ForEach-Object { Write-Host "  $_" }
    Write-Host 'Quitting stops them.'
    $advice = 'pass -Wait <minutes> to let them finish, or -Force to quit it anyway'
  } else {
    if ($waiting) { Write-Host 'They finished.' }
    return
  }
  if ($Force -or $WhatIfPreference) { return }
  if ([Console]::IsInputRedirected) { Fail "cancelled; $advice" }
  if ((Read-Host 'Quit T4 Code now? [y/N]') -notmatch '^y(es)?$') { Fail 'cancelled; T4 Code keeps running' }
}

function Wait-AppExit($app, [int] $seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-AppProcesses $app) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
}

function Stop-App($app) {
  $processes = @(Get-AppProcesses $app)
  if ($processes.Count -eq 0) { return }
  Confirm-Quit $app
  if (-not $PSCmdlet.ShouldProcess('T4 Code', 'Quit')) { return }

  # --quit makes the running app quit the way Quit in its tray menu does. It
  # travels through the app's single-instance lock, which finds the app by a
  # window in this Windows session; over SSH, the app runs in another session.
  Write-Host 'Quitting T4 Code...'
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
    Write-Host 'Ending T4 Code, which stays open in the tray or in another session.'
    foreach ($process in Get-AppProcesses $app) {
      taskkill.exe /PID $process.ProcessId /T /F *> $null
    }
    Wait-AppExit $app 15
    if (Get-AppProcesses $app) { Fail 'T4 Code did not quit' }
  }
  Write-Host 'Quit T4 Code.'
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
  Write-Host "T4 Code $releaseVersion is already installed."
  exit 0
}
Write-Host "Installing T4 Code $releaseVersion ($($release.tag_name))$(if ($app) { " over $($app.Version)" })."

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
  Write-Host "Installed T4 Code $releaseVersion."
  Remove-OldBackups $KeepBackups
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue -WhatIf:$false
}

if ($env:SSH_CONNECTION -or $env:SSH_CLIENT) {
  # An app started from an SSH session runs outside the desktop session.
  Write-Host 'Connected over SSH, so T4 Code was not started: start it on that machine.'
} else {
  # Started through Explorer, the app belongs to no console: started directly, it stays attached
  # to this script's window, and closing that window ends T4 Code and every running agent.
  Start-Process -FilePath (Join-Path $env:WINDIR 'explorer.exe') -ArgumentList ('"{0}"' -f $app.Exe)
  Write-Host 'Started T4 Code. This window can be closed.'
}
