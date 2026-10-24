#Requires -Version 7.4
<#
.SYNOPSIS
  Undoes the peer-link stack's migrations before a switch to an official
  release that uses their ids for other migrations.

.DESCRIPTION
  Drops the table peer_environment_links and the index
  orchestration_v2_projection_turn_items_waiting_link_idx, deletes the stack's
  migrations from effect_sql_migrations, found by name whatever their ids, and
  removes the link tokens from the secret store. Link the machines again after
  the switch.

  Only needed when rehearse-switch.ps1 fails because the database "would skip
  required schema migrations". Without -Apply it only reports what it would
  change. With -Apply, T3 Code must be stopped; the database and the link
  tokens are backed up first.

.EXAMPLE
  pwsh -File scripts/t4/undo-peer-link-migrations.ps1

.EXAMPLE
  pwsh -File scripts/t4/undo-peer-link-migrations.ps1 -Apply
#>
[CmdletBinding()]
param(
  [string] $T3Home = $(if ($env:T3CODE_HOME) { $env:T3CODE_HOME } else { Join-Path $HOME '.t3' }),
  # Change the data. Without it, nothing is changed.
  [switch] $Apply,
  # Don't back up first; for copies of the data.
  [switch] $SkipBackup
)

$ErrorActionPreference = 'Stop'

# Keep in step with forkMigrationNames in apps/server/src/persistence/reconcileForkMigrations.ts.
$stackMigrations = @('PeerLinks', 'PeerLinkFence', 'WaitingLinkRequestIndex') -join ','
$userdata = Join-Path $T3Home 'userdata'
$database = Join-Path $userdata 'statev2.sqlite'
$secrets = Join-Path $userdata 'secrets'

function Fail([string] $message) {
  [Console]::Error.WriteLine("undo-peer-link-migrations: $message")
  exit 1
}

function Invoke-Node([string] $script, [string[]] $arguments) {
  $output = node --no-warnings -e $script -- @arguments
  if ($LASTEXITCODE -ne 0) { throw "node exited with code $LASTEXITCODE" }
  $output
}

function Get-StackState {
  $state = Invoke-Node @'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1], { readOnly: true });
const stack = process.argv[2].split(",");
const inStack = `name IN (${stack.map(() => "?").join(", ")})`;
const exists = (type, name) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get(type, name) !== undefined;
const table = exists("table", "peer_environment_links");
console.log(JSON.stringify({
  migrations: db.prepare(
    `SELECT migration_id AS id, name FROM effect_sql_migrations WHERE ${inStack} ORDER BY migration_id`,
  ).all(...stack),
  later: db.prepare(
    `SELECT migration_id AS id, name FROM effect_sql_migrations
     WHERE NOT ${inStack}
       AND migration_id > (SELECT min(migration_id) FROM effect_sql_migrations WHERE ${inStack})
     ORDER BY migration_id`,
  ).all(...stack, ...stack),
  table,
  index: exists("index", "orchestration_v2_projection_turn_items_waiting_link_idx"),
  links: table
    ? db.prepare("SELECT label, secret_name AS secretName FROM peer_environment_links").all()
    : [],
  linkRequestThreads: exists("table", "orchestration_v2_projection_turn_items")
    ? db.prepare(
        "SELECT count(DISTINCT thread_id) AS n FROM orchestration_v2_projection_turn_items WHERE type = 'link_request'",
      ).get().n
    : 0,
}));
db.close();
'@ @($database, $stackMigrations) | ConvertFrom-Json
  # Each link names its token; tokens of links that failed halfway have no row.
  $tokens = @(foreach ($link in $state.links) { Join-Path $secrets "$($link.secretName).bin" }) +
    @(Get-ChildItem -Path $secrets -Filter 'peer-link-*.bin' -File -ErrorAction SilentlyContinue).FullName
  $state | Add-Member -NotePropertyName tokens -NotePropertyValue @($tokens | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Sort-Object -Unique)
  $state
}

function Test-InUse([string] $path) {
  if (-not (Test-Path -LiteralPath $path)) { return $false }
  try { [IO.File]::Open($path, 'Open', 'ReadWrite', 'None').Dispose(); $false }
  catch [IO.IOException] { $true }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'needs Node 24 or newer on PATH, for node:sqlite' }
if (-not (Test-Path -LiteralPath $database)) { Fail "no T3 Code database at $database" }

$state = Get-StackState
# Without the stack's rows, a build would skip the ids below a later migration,
# so a database that moved past the stack keeps them.
$foreign = @($state.later)
if ($foreign) {
  Fail ('migrations after the peer-link stack''s are not the stack''s: ' + (($foreign | ForEach-Object { "$($_.id)_$($_.name)" }) -join ', '))
}
if (-not $state.migrations -and -not $state.table -and -not $state.index -and -not $state.tokens) {
  Write-Host "Nothing to undo: $database has none of the peer-link stack's migrations."
  exit 0
}

$migrations = @($state.migrations | ForEach-Object { "$($_.id)_$($_.name)" })
$links = @($state.links | ForEach-Object { $_.label })
Write-Host "Peer-link stack in ${database}:"
Write-Host "  migrations: $(if ($migrations) { $migrations -join ', ' } else { 'none' })"
Write-Host "  table peer_environment_links: $(if (-not $state.table) { 'none' } elseif ($links) { "links to $($links -join ', ')" } else { 'no links' })"
Write-Host "  index orchestration_v2_projection_turn_items_waiting_link_idx: $(if ($state.index) { 'present' } else { 'none' })"
Write-Host "  link tokens in ${secrets}: $($state.tokens.Count)"
if ($state.linkRequestThreads -gt 0) {
  Write-Host "  warning: $($state.linkRequestThreads) threads hold link request cards, which a build without the stack may fail to read. This script leaves them."
}
if (-not $Apply) {
  Write-Host 'Dry run: nothing changed. Run again with -Apply, with T3 Code stopped.'
  exit 0
}

foreach ($file in "$database", "$database-wal") {
  if (Test-InUse $file) { Fail "$file is open. Quit T3 Code, and any t3 server on this T3 home, then run again." }
}

if (-not $SkipBackup) {
  $backup = Join-Path $T3Home ('backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-undo-peer-links\userdata')
  New-Item -ItemType Directory -Path (Join-Path $backup 'secrets') | Out-Null
  Get-ChildItem -LiteralPath $userdata -Filter 'statev2.sqlite*' -File | Copy-Item -Destination $backup
  foreach ($token in $state.tokens) { Copy-Item -LiteralPath $token -Destination (Join-Path $backup 'secrets') }
  Write-Host "Backed up the database and link tokens to $backup"
}

Invoke-Node @'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
const stack = process.argv[2].split(",");
db.exec("BEGIN IMMEDIATE");
try {
  db.exec("DROP INDEX IF EXISTS orchestration_v2_projection_turn_items_waiting_link_idx");
  db.exec("DROP TABLE IF EXISTS peer_environment_links");
  db.prepare(
    `DELETE FROM effect_sql_migrations WHERE name IN (${stack.map(() => "?").join(", ")})`,
  ).run(...stack);
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}
db.close();
'@ @($database, $stackMigrations) | Out-Null
foreach ($token in $state.tokens) { Remove-Item -LiteralPath $token -Force }

$after = Get-StackState
if ($after.migrations -or $after.table -or $after.index -or $after.tokens) { Fail 'the peer-link stack is still partly there; restore the backup' }
Write-Host 'Undid the peer-link stack''s migrations and removed the link tokens. Link the machines again after the switch.'
