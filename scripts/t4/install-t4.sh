#!/bin/sh
# Installs or updates the server of this fork of T3 Code, the `t3` CLI, on
# Linux x64, for the current user; it needs no root.
#
#   sh install-t4.sh                        newest release
#   sh install-t4.sh --version 0.1.2-t4.14  a given release, as a version or tag
#   sh install-t4.sh --dry-run              download and check only, show the rest
#
# Finds a release of the fork, downloads its Linux archive, checks it against
# the release's SHA256SUMS and unpacks it into
# <T3 home>/runtime/versions/<version>, the layout of upstream's install.sh and
# `t3 update`. Then it stops the background service, backs up the files in
# the T3 home's userdata, points the `t3` launcher at the new version,
# switches the service to it and removes all but the newest install backups.
# scripts/t4/README.md describes each step.
#
# Environment: T3CODE_HOME (default ~/.t3), T3CODE_INSTALL_BIN_DIR, where the
# `t3` launcher goes (default ~/.local/bin).
set -eu

repo="LukasDoubleU/t4code"
# Tags and asset names of the fork's release workflow, t4-release.yml.
tag_prefix="t4-v"
platform_key="linux-x64"
checksums_asset="SHA256SUMS"

t3_home="${T3CODE_HOME:-$HOME/.t3}"
userdata="$t3_home/userdata"
versions_dir="$t3_home/runtime/versions"
bin_dir="${T3CODE_INSTALL_BIN_DIR:-$HOME/.local/bin}"
# Where `t3 service install` writes the systemd user unit.
service_unit="$HOME/.config/systemd/user/t3code.service"

usage() {
  cat <<'EOF'
Usage: install-t4.sh [options]

  --version <version>   Release to install, as a version (0.1.2-t4.14) or a tag
                        (t4-v0.1.2-t4.14). Defaults to the newest release.
  --dry-run             Download and check the archive, then only show what
                        would change.
  --force               Restart the background service without asking, even
                        while agents or terminals run in it.
  --skip-backup         Don't back up userdata before installing.
  --keep-backups <n>    Install backups to keep after a successful install
                        (default 3); older ones are removed.
EOF
}

fail() {
  printf 'install-t4: %s\n' "$1" >&2
  exit 1
}

say() {
  printf '%s\n' "$1"
}

version=
dry_run=false
force=false
skip_backup=false
keep_backups=3
while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || fail "--version needs a value"; version="$2"; shift 2 ;;
    --version=*) version="${1#*=}"; shift ;;
    --dry-run) dry_run=true; shift ;;
    --force) force=true; shift ;;
    --skip-backup) skip_backup=true; shift ;;
    --keep-backups) [ $# -ge 2 ] || fail "--keep-backups needs a value"; keep_backups="$2"; shift 2 ;;
    --keep-backups=*) keep_backups="${1#*=}"; shift ;;
    -h | --help) usage; exit 0 ;;
    *) fail "unknown option $1; see --help" ;;
  esac
done
case "$keep_backups" in '' | *[!0-9]*) fail "--keep-backups must be a whole number" ;; esac
[ "$keep_backups" -ge 1 ] || fail "--keep-backups must be at least 1"

[ "$(uname -s)" = Linux ] || fail "this installs the Linux server; on Windows, use install-t4.ps1"
case "$(uname -m)" in
  x86_64 | amd64) ;;
  *) fail "releases have a Linux build for x86_64 only, not $(uname -m)" ;;
esac
for tool in curl sha256sum tar; do
  command -v "$tool" > /dev/null 2>&1 || fail "$tool is required"
done

work="$(mktemp -d "${TMPDIR:-/tmp}/install-t4.XXXXXX")"
staging=
service_stopped=false
cleanup() {
  status=$?
  rm -rf "$work"
  if [ -n "$staging" ]; then rm -rf "$staging"; fi
  if [ "$status" -ne 0 ] && "$service_stopped"; then
    printf 'install-t4: starting the background service again\n' >&2
    systemctl --user start t3code.service || true
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Sets http_status; a request that never got an answer leaves 000.
get() {
  if [ "${3:-}" = progress ] && [ -t 2 ]; then quiet=--progress-bar; else quiet=--silent; fi
  http_status="$(curl "$quiet" --show-error --location --connect-timeout 30 \
    --output "$2" --write-out '%{http_code}' "$1")" || true
  if [ -z "$http_status" ]; then http_status=000; fi
}

# The resolved directory, or nothing when it doesn't exist.
real_dir() {
  (cd -P -- "$1" 2> /dev/null && pwd) || true
}

# --- Find the release -------------------------------------------------------

api="https://api.github.com/repos/$repo/releases"
if [ -n "$version" ]; then
  requested="${version#t4-}"
  release_url="$api/tags/$tag_prefix${requested#v}"
else
  release_url="$api/latest"
fi
get "$release_url" "$work/release.json"
case "$http_status" in
  200) ;;
  404) fail "$repo has no release${version:+ $version}" ;;
  *) fail "could not look up the release at $release_url (HTTP $http_status)" ;;
esac
tag="$(sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' "$work/release.json" | head -n 1)"
release_version="${tag#"$tag_prefix"}"
case "$tag" in "$tag_prefix"*) ;; *) fail "release ${tag:-?} is not tagged $tag_prefix<version>" ;; esac
case "$release_version" in '' | *[!0-9A-Za-z.+-]*) fail "release $tag has no usable version" ;; esac
archive="t3-$release_version-$platform_key.tar.gz"
download_url="https://github.com/$repo/releases/download/$tag"
target_dir="$versions_dir/$release_version"

# --- What is installed ------------------------------------------------------

# The launcher points into runtime/versions/<version>.
installed=
if launcher_target="$(readlink "$bin_dir/t3" 2> /dev/null)"; then
  case "$launcher_target" in
    */runtime/versions/*/t3) installed="${launcher_target%/t3}"; installed="${installed##*/}" ;;
  esac
fi

# The unit's name is per user, not per T3 home: a unit that serves another
# home belongs to another install and is left alone.
service_installed=false
service_active=false
service_version=
if [ -f "$service_unit" ]; then
  unit_home="$(sed -n 's/^Environment=T3CODE_HOME=//p' "$service_unit" | head -n 1)"
  unit_home="${unit_home#\"}"
  unit_home="${unit_home%\"}"
  real_unit_home="$(real_dir "$unit_home")"
  if [ -n "$real_unit_home" ] && [ "$real_unit_home" = "$(real_dir "$t3_home")" ]; then
    service_installed=true
    service_version="$(sed -n 's|^ExecStart="\{0,1\}.*/runtime/versions/\([^/]*\)/t3.*|\1|p' "$service_unit" | head -n 1)"
    if systemctl --user is-active --quiet t3code.service 2> /dev/null; then service_active=true; fi
  else
    say "The background service serves ${unit_home:-another T3 home}, so it is left alone."
  fi
fi

# A version already unpacked there, by this script, `t3 update` or the service,
# is used as it is, as they do.
unpacked=false
if [ "$(cat "$target_dir/.install-complete" 2> /dev/null)" = "$release_version" ]; then unpacked=true; fi

if [ "$installed" = "$release_version" ] && "$unpacked" &&
  { ! "$service_installed" || [ "$service_version" = "$release_version" ]; }; then
  say "The T4 Code server $release_version is already installed."
  exit 0
fi
say "Installing the T4 Code server $release_version ($tag)${installed:+ over $installed}."

# Agents and terminals in T3 Code inherit the unit's environment. Restarting
# the service from one of them would end this script halfway.
if "$service_installed" && [ "${T3_BOOT_SERVICE_UNIT:-}" = t3code.service ]; then
  fail "this runs inside T3 Code's background service, which the update restarts. Run it from an SSH session or another terminal outside T3 Code."
fi

# --- Download, check and unpack ---------------------------------------------

if "$unpacked"; then
  say "Version $release_version is already unpacked in $target_dir."
else
  say "Downloading $archive..."
  get "$download_url/$checksums_asset" "$work/$checksums_asset"
  case "$http_status" in
    200) ;;
    404) fail "release $tag has no $checksums_asset" ;;
    *) fail "could not download $checksums_asset (HTTP $http_status)" ;;
  esac
  get "$download_url/$archive" "$work/$archive" progress
  case "$http_status" in
    200) ;;
    404) fail "release $tag has no Linux build ($archive)" ;;
    *) fail "could not download $archive (HTTP $http_status)" ;;
  esac
  expected="$(awk -v name="$archive" '($2 == name || $2 == "*" name) && length($1) == 64 { print tolower($1); exit }' "$work/$checksums_asset")"
  [ -n "$expected" ] || fail "$archive is not listed in $checksums_asset"
  actual="$(sha256sum "$work/$archive" | cut -d ' ' -f 1)"
  [ "$actual" = "$expected" ] || fail "checksum mismatch for $archive"
  say "Checksum OK."

  # Beside the running version, so a build that doesn't run here stops the
  # install before anything else changes.
  if "$dry_run"; then
    say "Would unpack $archive into $target_dir"
  else
    mkdir -p "$versions_dir"
    staging="$(mktemp -d "$versions_dir/.staging-XXXXXX")"
    tar -xzf "$work/$archive" -C "$staging" --strip-components=1
    version_output="$("$staging/t3" --version 2>&1)" || true
    case "$version_output" in
      *"$release_version"*) ;;
      # The executable is Node's official build, which links libatomic.
      *libatomic*) fail "the downloaded t3 needs libatomic, which minimal images lack (Debian and Ubuntu: sudo apt install libatomic1): $version_output" ;;
      *) fail "the downloaded t3 does not run on this machine: $version_output" ;;
    esac
    printf '%s\n' "$release_version" > "$staging/.install-complete"
    rm -rf "$target_dir"
    mv "$staging" "$target_dir"
    staging=
    say "Unpacked it into $target_dir"
  fi
fi

# --- Stop the service -------------------------------------------------------

if "$service_active"; then
  # Agents and terminals run in t3code-<name>-<id>.scope units of their own.
  scopes="$(systemctl --user list-units --type=scope --state=running --plain --no-legend 't3code-*.scope' 2> /dev/null |
    awk '{ print $1 }')" || scopes=
  if [ -n "$scopes" ]; then
    names="$(printf '%s\n' "$scopes" | sed 's/^t3code-\(.*\)-[^-]*\.scope$/\1/' | sort | uniq -c |
      awk '{ printf "%s%s x%s", sep, $2, $1; sep = ", " }')"
    say "The T4 Code server is running agents or terminals ($names). Restarting it stops them."
    if ! "$force" && ! "$dry_run"; then
      [ -t 0 ] || fail "cancelled; pass --force to restart it anyway"
      printf 'Restart the T4 Code server now? [y/N] '
      read -r answer || answer=
      case "$answer" in
        y | Y | yes | Yes | YES) ;;
        *) fail "cancelled; the T4 Code server keeps running" ;;
      esac
    fi
  fi
  if "$dry_run"; then
    say "Would stop the background service."
  else
    say "Stopping the background service..."
    service_stopped=true
    systemctl --user stop t3code.service
  fi
fi

# What a new version migrates is the database and the settings files beside
# it, so they are backed up while nothing writes them.
if ! "$dry_run" && [ -d "$userdata" ]; then
  real_userdata="$(real_dir "$userdata")"
  for database in statev2.sqlite state.sqlite; do
    # Only this user's processes are readable, which covers its servers.
    holder="$(find /proc/[0-9]*/fd -maxdepth 1 -lname "$real_userdata/$database" -print -quit 2> /dev/null)" || true
    if [ -n "$holder" ]; then
      pid="${holder#/proc/}"
      pid="${pid%%/*}"
      fail "$database is still open by process $pid ($(cat "/proc/$pid/comm" 2> /dev/null || echo '?')), likely a t3 server started by hand on this T3 home. Stop it and run again."
    fi
  done
fi

# --- Back up userdata -------------------------------------------------------

# The version that wrote the files names the backup, as in install-t4.ps1.
writer="${service_version:-$installed}"
backups_dir="$t3_home/backups"
backed_up=false
if ! "$skip_backup" && [ -d "$userdata" ]; then
  backup="$backups_dir/$(date +%Y%m%d-%H%M%S)${writer:+-$writer}/userdata"
  backed_up=true
  if "$dry_run"; then
    say "Would back up userdata to $backup"
  else
    (umask 077 && mkdir -p "$backup")
    # The subfolders (attachments, logs, secrets) are left alone, as an update leaves them.
    for file in "$userdata"/* "$userdata"/.[!.]* "$userdata"/..?*; do
      if [ -f "$file" ]; then cp -p "$file" "$backup/"; fi
    done
    say "Backed up userdata to $backup"
  fi
fi

# --- Switch to the new version ----------------------------------------------

if "$dry_run"; then
  say "Would point $bin_dir/t3 at $target_dir/t3"
else
  mkdir -p "$bin_dir"
  ln -sfn "$target_dir/t3" "$bin_dir/t3"
  # A service finds the launchers it must not prune through this list.
  launcher="$(real_dir "$bin_dir")/t3"
  launchers="$t3_home/runtime/launchers"
  grep -qxF "$launcher" "$launchers" 2> /dev/null || printf '%s\n' "$launcher" >> "$launchers"
fi

if "$service_installed"; then
  if "$dry_run"; then
    say "Would switch the background service to $release_version and start it."
  else
    say "Switching the background service to $release_version..."
    "$target_dir/t3" service install --allow-downgrade
    # A unit that already named this version is left as it was, stopped above.
    systemctl --user is-active --quiet t3code.service || systemctl --user start t3code.service
    service_stopped=false
  fi
fi

if ! "$dry_run"; then say "Installed the T4 Code server $release_version."; fi

# --- Remove old backups -----------------------------------------------------

# Backups are named <time>-<version>, or <time> when no version was
# installed. Other folders in backups are left alone, such as the
# <time>-undo-peer-links backups of undo-peer-link-migrations.ps1. A dry run
# lists what a real run would remove, which also counts the backup it makes.
keep="$keep_backups"
if "$dry_run" && "$backed_up"; then keep=$((keep - 1)); fi
if [ -d "$backups_dir" ]; then
  for folder in "$backups_dir"/*/; do
    folder="${folder%/}"
    printf '%s\n' "${folder##*/}"
  done | grep -E '^[0-9]{8}-[0-9]{6}(-[0-9]+\.[0-9]+\.[0-9]+[^[:space:]]*)?$' |
    grep -v -- '-undo-peer-links$' | sort -r | tail -n +"$((keep + 1))" |
    while IFS= read -r name; do
      if "$dry_run"; then
        say "Would remove old backup $backups_dir/$name"
      elif rm -rf "${backups_dir:?}/$name"; then
        say "Removed old backup $backups_dir/$name"
      else
        # The install already succeeded, so a backup that can't be removed only warns.
        printf 'install-t4: could not remove old backup %s\n' "$backups_dir/$name" >&2
      fi
    done
fi

if "$dry_run"; then
  say "Dry run: nothing was changed."
  exit 0
fi
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) say "Add $bin_dir to your PATH to run t3." ;;
esac
if ! "$service_installed"; then
  say "Run \`t3 service install\` to keep the server running in the background."
fi
