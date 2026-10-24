#Requires -Version 7.4
<#
.SYNOPSIS
  Rehearses switching T3 Code to another version, on a copy of the data.

.DESCRIPTION
  Copies the T3 home's userdata into a scratch folder, starts the given t3 CLI
  on the copy, bound to 127.0.0.1 on a spare port, and passes when the server
  answers without migration, decode or settings errors in its log.

  The copy is inert, because the server would otherwise resume running
  threads, fire scheduled tasks, poll pull requests and start agents in real
  worktrees:
  - It gets a fresh environment id and none of the source's secrets: no
    T3 Connect sign-in, peer link tokens, provider logins or signing keys.
  - Its settings switch off every provider instance, restart continuation,
    automatic pulls, auto-settle, storage cleanup and project scripts.
  - Its scheduled tasks are disabled and its queued effects dropped.
  - The server runs offline, behind a proxy nobody listens on, with a scratch
    profile and none of this session's environment variables.
  If any of this can't be checked, or the target version can't read the inert
  settings in a first run without data, the rehearsal stops before starting on
  the copy. The server still finds git and the agent CLIs, because it rebuilds
  PATH from the registry: it reads the projects' repositories, as T3 Code does
  on every start, and checks the CLIs' versions, but it starts no agent.

  The scratch folder holds your threads and is deleted at the end.

.EXAMPLE
  pwsh -File scripts/t4/rehearse-switch.ps1 -T3 C:\Temp\t3-0.1.1-win32-x64\t3.exe

.EXAMPLE
  pwsh -File scripts/t4/rehearse-switch.ps1 -T3 .\t3.exe -UndoPeerLinks -Browse
#>
[CmdletBinding()]
param(
  # The target version's CLI: t3.exe from its release's t3-<version>-win32-x64.zip.
  [Parameter(Mandatory)] [string] $T3,
  # T3 home to copy. A backup folder from install-t4.ps1 works too.
  [string] $Source = $(if ($env:T3CODE_HOME) { $env:T3CODE_HOME } else { Join-Path $HOME '.t3' }),
  # Apply undo-peer-link-migrations.ps1 to the copy first.
  [switch] $UndoPeerLinks,
  # After the checks, keep the server running and print a pairing URL, to
  # check in a browser that threads load.
  [switch] $Browse,
  # Keep the scratch folder.
  [switch] $Keep,
  [int] $TimeoutSeconds = 600
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$failurePattern = @(
  'MigrationError', 'would skip required schema migrations', 'Cannot upgrade V2 preview',
  'PersistenceDecodeError', 'EventStoreReadEventsError', 'ProjectionStoreReadError',
  'ProjectionStoreApplyEventError', 'failed to parse settings\.json'
) -join '|'
$builtInProviders = 'codex', 'claudeAgent', 'cursor', 'grok', 'opencode', 'antigravity', 'pi', 'muse'

function Fail([string] $message) {
  [Console]::Error.WriteLine("rehearse-switch: $message")
  exit 1
}

function Invoke-Node([string] $script, [string[]] $arguments) {
  $output = node --no-warnings -e $script -- @arguments
  if ($LASTEXITCODE -ne 0) { throw "node exited with code $LASTEXITCODE" }
  $output
}

function Copy-Database([string] $from, [string] $to) {
  Invoke-Node @'
const { DatabaseSync, backup } = require("node:sqlite");
const [from, to] = process.argv.slice(1);
const db = new DatabaseSync(from, { readOnly: true });
// One step copies every page in a single read transaction, so the copy is
// consistent while T3 Code keeps writing. Smaller steps restart on each write.
// Node 24.22 rejects SQLite's -1 (all pages), so ask for the most a rate allows.
backup(db, to, { rate: 2147483647 }).finally(() => db.close());
'@ $from, $to | Out-Null
}

function Copy-Userdata([string] $from, [string] $to) {
  New-Item -ItemType Directory -Path $to | Out-Null
  # Identity, credentials and runtime state stay behind; the databases are
  # copied through SQLite.
  $skip = 'environment-id', 'anonymous-id', 'server-runtime.json', 'server-owner.sqlite*', 'clerk-tokens.json',
    'desktop-settings.json', 'client-settings.json', 'saved-environments.json', 'connection-catalog.json',
    '*.sqlite', '*.sqlite-wal', '*.sqlite-shm', '*-journal'
  Get-ChildItem -LiteralPath $from -File -Force |
    Where-Object { $name = $_.Name; -not ($skip | Where-Object { $name -like $_ }) } |
    Copy-Item -Destination $to
  foreach ($folder in 'attachments', 'themes') {
    if (Test-Path -LiteralPath (Join-Path $from $folder)) { Copy-Item -LiteralPath (Join-Path $from $folder) -Destination $to -Recurse }
  }
  foreach ($database in 'statev2.sqlite', 'state.sqlite') {
    if (Test-Path -LiteralPath (Join-Path $from $database)) { Copy-Database (Join-Path $from $database) (Join-Path $to $database) }
  }
  Set-Content -LiteralPath (Join-Path $to 'environment-id') -Value "$([guid]::NewGuid())`n" -NoNewline
}

function Get-InertSettings([string] $scratchDir) {
  [ordered]@{
    continueThreadsAfterServerUpdate = $false
    defaultAutoPull = $false
    projectAutoPullOverrides = @{}
    # Its fetch interval is 0: no git fetch or pull while a browser is connected.
    backgroundActivity = [ordered]@{ schemaVersion = 1; profile = 'battery-saver'; overrides = @{} }
    sidebarAutoSettleOnMerge = $false
    sidebarAutoSettleAfterDays = $null
    autoResumeLimitedThreads = $false
    snoozeLimitedThreads = $false
    compactIdleThreads = $false
    enableProviderUpdateChecks = $false
    worktreeCleanup = [ordered]@{ mode = 'off' }
    storageCleanup = [ordered]@{
      worktreeAfterDays = $null; worktreeSettledAfterDays = $null; worktreeOnMerge = $false
      worktreeOnDelete = $false; worktreeUnchanged = $false; browserArtifactsAfterDays = $null; logsAfterDays = $null
    }
    # Storage cleanup only deletes inside these.
    worktreesDirectory = Join-Path $scratchDir 'worktrees'
    previousWorktreesDirectories = @()
    defaultProjectScripts = @()
    projectScriptOverrides = @{}
    projectSettingsOverrides = @{}
    # Unfolded, the projects' own scripts and pull settings from the database apply.
    projectSettingsFolded = $true
    usageLimitSources = @{}
  }
}

function Set-InertSettings([string] $path, [string] $scratchDir) {
  $settings = if (Test-Path -LiteralPath $path) { Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -AsHashtable } else { [ordered]@{} }
  $instances = $settings['providerInstances'] ?? [ordered]@{}
  foreach ($id in $builtInProviders) { if (-not $instances.Contains($id)) { $instances[$id] = [ordered]@{ driver = $id } } }
  foreach ($instance in $instances.Values) {
    $instance['enabled'] = $false
    # Paths and variables leading to the real provider homes and credentials.
    $instance.Remove('config')
    $instance.Remove('environment')
  }
  $settings['providerInstances'] = $instances
  # The old shape is migrated into providerInstances at startup.
  $settings.Remove('providers')
  $settings.Remove('observability')
  $inert = Get-InertSettings $scratchDir
  foreach ($key in $inert.Keys) { $settings[$key] = $inert[$key] }
  $settings | ConvertTo-Json -Depth 64 | Set-Content -LiteralPath $path
}

function Test-InertSettings([string] $path, [string] $scratchDir) {
  $settings = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -AsHashtable
  $problems = @()
  $instances = $settings['providerInstances']
  foreach ($id in $builtInProviders) { if (-not $instances -or -not $instances.Contains($id)) { $problems += "provider $id has no entry" } }
  foreach ($id in @($instances.Keys)) {
    $instance = $instances[$id]
    if ($instance['enabled'] -ne $false -or $instance.Contains('config') -or $instance.Contains('environment')) { $problems += "provider $id is not off" }
  }
  foreach ($key in 'providers', 'observability') { if ($settings.Contains($key)) { $problems += "$key is set" } }
  $inert = Get-InertSettings $scratchDir
  foreach ($key in $inert.Keys) {
    $expected = $inert[$key] | ConvertTo-Json -Depth 8 -Compress
    $actual = if ($settings.Contains($key)) { $settings[$key] | ConvertTo-Json -Depth 8 -Compress } else { '<missing>' }
    if ($actual -ne $expected) { $problems += "$key is $actual" }
  }
  $problems
}

function Set-InertDatabase([string] $path) {
  $counts = Invoke-Node @'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
const has = (table) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
const count = (table, where) =>
  has(table) ? db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get().n : 0;
db.exec("BEGIN");
if (has("scheduled_tasks")) db.exec("UPDATE scheduled_tasks SET enabled = 0, next_run_at = NULL");
// Pending effects run at startup: checkpoints, rollbacks and title generation in real worktrees.
if (has("orchestration_v2_effect_outbox"))
  db.exec("DELETE FROM orchestration_v2_effect_outbox WHERE status IN ('pending', 'running')");
db.exec("COMMIT");
console.log(JSON.stringify({
  scheduledTasks: count("scheduled_tasks", "enabled <> 0 OR next_run_at IS NOT NULL"),
  queuedEffects: count("orchestration_v2_effect_outbox", "status IN ('pending', 'running')"),
}));
db.close();
'@ $path | ConvertFrom-Json
  if ($counts.scheduledTasks -ne 0 -or $counts.queuedEffects -ne 0) {
    Fail "refusing to start: the copy still has $($counts.scheduledTasks) active scheduled tasks and $($counts.queuedEffects) queued effects"
  }
}

function New-ServerEnvironment([string] $copyHome, [string] $scratchDir) {
  $profileDir = Join-Path $scratchDir 'profile'
  $folders = @{ USERPROFILE = $profileDir; HOME = $profileDir; APPDATA = "$profileDir\AppData\Roaming"; LOCALAPPDATA = "$profileDir\AppData\Local"; TEMP = "$profileDir\Temp"; TMP = "$profileDir\Temp" }
  foreach ($folder in $folders.Values) { New-Item -ItemType Directory -Force -Path $folder | Out-Null }
  # Only PATH is kept: the server rebuilds it from the registry anyway, so
  # git and the agent CLIs stay reachable. Tokens in this session stay out.
  $environment = @{}
  foreach ($name in [Environment]::GetEnvironmentVariables().Keys) { if ($name -ne 'Path') { $environment[$name] = $null } }
  foreach ($name in 'SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT', 'OS', 'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION') {
    $environment[$name] = [Environment]::GetEnvironmentVariable($name)
  }
  foreach ($name in $folders.Keys) { $environment[$name] = $folders[$name] }
  # Pull requests are polled whatever the settings say, with the gh login from
  # the system keyring. A proxy nobody listens on keeps the server and its git
  # and gh offline.
  $environment['NODE_USE_ENV_PROXY'] = '1'
  foreach ($name in 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY') { $environment[$name] = 'http://127.0.0.1:9' }
  $environment['NO_PROXY'] = 'localhost,127.0.0.1,::1'
  $environment['T3CODE_HOME'] = $copyHome
  $environment['T3CODE_TELEMETRY_ENABLED'] = 'false'
  $environment
}

function Get-FreePort {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try { $listener.LocalEndpoint.Port } finally { $listener.Stop() }
}

# The server keeps writing its logs while they are read.
function Read-Lines([string] $path, [string] $pattern) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  $stream = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite, Delete')
  try {
    $reader = [IO.StreamReader]::new($stream)
    while ($null -ne ($line = $reader.ReadLine())) {
      if ($line -match $pattern) { [pscustomobject]@{ File = Split-Path $path -Leaf; Line = $line.Trim() } }
    }
  } finally { $stream.Dispose() }
}

# The trace file is large, so it is only read for the final verdict.
function Find-Failures($server, [switch] $WithTrace) {
  $logs = @($server.Stdout, $server.Stderr)
  if ($WithTrace) {
    $logs += @(Get-ChildItem -Path (Join-Path $server.Home 'userdata\logs') -Filter 'server.trace.ndjson*' -ErrorAction SilentlyContinue).FullName
  }
  @(foreach ($log in $logs) { Read-Lines $log $failurePattern })
}

function Start-Server([string] $name, [string] $copyHome, [string] $scratchDir) {
  $port = Get-FreePort
  $server = [pscustomobject]@{
    Name = $name; Home = $copyHome; Port = $port; Process = $null
    Stdout = Join-Path $scratchDir "$name.out.log"; Stderr = Join-Path $scratchDir "$name.err.log"
  }
  # Start-Process joins arguments without quoting them.
  $server.Process = Start-Process -FilePath $T3 -PassThru -NoNewWindow -WorkingDirectory $scratchDir `
    -ArgumentList "serve --host 127.0.0.1 --port $port --base-dir `"$copyHome`"" `
    -Environment (New-ServerEnvironment $copyHome $scratchDir) `
    -RedirectStandardOutput $server.Stdout -RedirectStandardError $server.Stderr
  $script:servers += $server
  $server
}

# Returns when the server answers, exits, logs a failure or times out.
function Wait-Server($server) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ($true) {
    if ((Find-Failures $server).Count -gt 0) { return 'failed' }
    if ($server.Process.HasExited) { return 'exited' }
    try {
      Invoke-WebRequest "http://127.0.0.1:$($server.Port)/" -TimeoutSec 5 -SkipHttpErrorCheck | Out-Null
      return 'ready'
    } catch { }
    if ((Get-Date) -gt $deadline) { return 'timeout' }
    Start-Sleep -Milliseconds 500
  }
}

function Stop-Server($server) {
  if ($server.Process -and -not $server.Process.HasExited) {
    taskkill.exe /PID $server.Process.Id /T /F *> $null
    $server.Process.WaitForExit(15000) | Out-Null
  }
}

# A log entry's details follow it on indented lines.
function Write-Notes([string] $path, [string] $pattern) {
  $inNote = $false
  foreach ($line in Read-Lines $path '') {
    if ($line.Line -match $pattern) { $inNote = $true; Write-Host "  note: $($line.Line)" }
    elseif ($inNote -and $line.Line -match '^\s|^[\]}]') { Write-Host "        $($line.Line)" }
    else { $inNote = $false }
  }
}

# The console log names a failure once; the trace repeats it in every span it
# passes through, so it is shown only when the console has nothing.
function Write-Failures($failures) {
  $console = @($failures | Where-Object { $_.File -notlike 'server.trace*' })
  $shown = if ($console) { $console } else { $failures }
  foreach ($line in $shown.Line | Select-Object -Unique -First 10) {
    Write-Host "  $($line.Substring(0, [Math]::Min(600, $line.Length)))"
  }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'needs Node 24 or newer on PATH, for node:sqlite' }
node --no-warnings -e "process.exit(typeof require('node:sqlite').backup === 'function' ? 0 : 1)"
if ($LASTEXITCODE -ne 0) { Fail 'needs Node 24 or newer: this node:sqlite has no backup()' }
$T3 = (Resolve-Path -LiteralPath $T3).Path
$targetVersion = (& $T3 --version).Trim()
if ($LASTEXITCODE -ne 0) { Fail "$T3 does not run" }
$sourceData = Join-Path $Source 'userdata'
if (-not (Test-Path -LiteralPath (Join-Path $sourceData 'statev2.sqlite'))) { Fail "no T3 Code database in $sourceData" }

$scratch = Join-Path ([IO.Path]::GetTempPath()) ('t4-rehearsal-' + [IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $scratch | Out-Null
$servers = @()
try {
  Write-Host "Copying $sourceData..."
  $copyHome = Join-Path $scratch 'home'
  $copyData = Join-Path $copyHome 'userdata'
  Copy-Userdata $sourceData $copyData
  $settingsPath = Join-Path $copyData 'settings.json'
  Set-InertSettings $settingsPath $scratch
  $problems = @(Test-InertSettings $settingsPath $scratch)
  if ($problems) { Fail ("refusing to start: the copy's settings are not inert: " + ($problems -join '; ')) }
  Set-InertDatabase (Join-Path $copyData 'statev2.sqlite')
  if ($UndoPeerLinks) {
    & (Join-Path $PSScriptRoot 'undo-peer-link-migrations.ps1') -T3Home $copyHome -Apply -SkipBackup
    if ($LASTEXITCODE -ne 0) { Fail 'undo-peer-link-migrations.ps1 failed on the copy' }
  }

  # The target falls back to defaults for a settings file it can't read, and
  # by default providers and auto-settle are on. It reads the inert settings
  # first without any data.
  Write-Host "Checking that $targetVersion reads the inert settings..."
  $preflightData = Join-Path $scratch 'preflight\userdata'
  New-Item -ItemType Directory -Path $preflightData | Out-Null
  Copy-Item -LiteralPath $settingsPath -Destination $preflightData
  $preflight = Start-Server 'preflight' (Split-Path $preflightData) $scratch
  $state = Wait-Server $preflight
  if ($state -eq 'ready') {
    Start-Sleep -Seconds 3
    if ((Find-Failures $preflight -WithTrace).Count -gt 0) { $state = 'failed' }
  }
  Stop-Server $preflight
  if ($state -ne 'ready') {
    Write-Host "FAIL: $targetVersion did not start on the copy's inert settings without data ($state), so it was not started on the copy."
    Write-Failures (Find-Failures $preflight -WithTrace)
    exit 1
  }
  $problems = @(Test-InertSettings (Join-Path $preflightData 'settings.json') $scratch)
  if ($problems) { Fail ("refusing to start: $targetVersion rewrote the inert settings: " + ($problems -join '; ')) }

  Write-Host "Starting $targetVersion on the copy..."
  $started = Get-Date
  $server = Start-Server 'rehearsal' $copyHome $scratch
  $state = Wait-Server $server
  if ($state -eq 'ready') {
    # Startup work such as recovery logs its errors shortly after the server answers.
    Start-Sleep -Seconds 15
  }
  $seconds = [int]((Get-Date) - $started).TotalSeconds
  $failures = Find-Failures $server -WithTrace
  if ($state -eq 'ready' -and $failures.Count -gt 0) { $state = 'failed' }
  Write-Notes $server.Stdout 'Migrations ran successfully|diverges from this build'
  if ($state -ne 'ready') {
    Write-Host "FAIL: $targetVersion on a copy of $Source ($state after $seconds s)."
    Write-Failures $failures
    if ($failures.Line -match 'recorded: PeerLinks') {
      Write-Host '  The target uses the peer-link stack''s migration ids. Rehearse again with -UndoPeerLinks;'
      Write-Host '  if that passes, run undo-peer-link-migrations.ps1 before switching.'
    }
    exit 1
  }
  Write-Host "PASS: $targetVersion started on a copy of $Source in $seconds s, without migration, decode or settings errors."

  if ($Browse) {
    $pairing = Read-Lines $server.Stdout 'Pairing URL: (\S+)' | Select-Object -First 1
    Write-Host "Check that threads load: $(($pairing.Line -split ' ')[-1])"
    Read-Host 'Press Enter to stop the server and delete the copy' | Out-Null
    $failures = Find-Failures $server -WithTrace
    if ($failures.Count -gt 0) {
      Write-Host 'FAIL: errors were logged while browsing:'
      Write-Failures $failures
      exit 1
    }
  }
} finally {
  foreach ($server in $servers) { Stop-Server $server }
  if ($Keep) {
    Write-Host "Kept $scratch"
  } else {
    # The server's files can stay locked for a moment after it exits.
    for ($attempt = 1; (Test-Path -LiteralPath $scratch) -and $attempt -le 10; $attempt++) {
      Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
      if (Test-Path -LiteralPath $scratch) { Start-Sleep -Seconds 1 }
    }
    if (Test-Path -LiteralPath $scratch) { Write-Warning "Could not delete $scratch; it holds a copy of your data." }
  }
}
