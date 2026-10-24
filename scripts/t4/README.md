# Fork scripts

Scripts that only this fork carries, for installing its builds and switching versions without losing data. The Windows scripts need PowerShell 7; the two version-switch scripts need 7.4 and Node 24 on `PATH`, for `node:sqlite`. `install-t4.sh` installs the server on Linux and needs only `sh`, `curl`, `sha256sum` and `tar`. All of them use `T3CODE_HOME` when it is set, `~/.t3` otherwise.

## Install or update: `install-t4.ps1`

```powershell
pwsh -File scripts/t4/install-t4.ps1            # newest release
pwsh -File scripts/t4/install-t4.ps1 -WhatIf    # download and check only, show the rest
```

1. Finds the newest release of this repository, the one GitHub marks as latest, or the one named with `-Version`, as a tag (`t4-v0.1.2-t4.1`) or a version (`0.1.2-t4.1`).
2. Downloads its installer, `T3-Code-<version>-x64.exe`, and checks it against the release's `SHA256SUMS`. The tag prefix and asset names are set at the top of the script, matching the release workflow.
3. Quits T4 Code. First it asks the app's server what quitting would stop and names it: threads whose turn is preparing, starting, running or waiting for an answer, and terminals with a command running. Agent sessions kept warm between turns and terminals at their prompt don't count. If something runs, or the server can't be asked, it asks you first; `-Wait <minutes>` waits that long for the work to finish, and `-Force` skips the question.
4. Backs up the files in `userdata` to `~/.t3/backups/<time>-<installed version>/userdata`: the databases with their `-wal` and `-shm` files, settings and keybindings. The installer leaves the subfolders alone. `-SkipBackup` skips this step.
5. Runs the installer silently.
6. Once the install succeeded, removes old install backups and prints each one it removes. It keeps the newest three; `-KeepBackups <n>` keeps another number. Other folders in `backups` stay, such as the `-undo-peer-links` backups of `undo-peer-link-migrations.ps1`.
7. Starts the app again. Over SSH, it prints a hint instead: an app started from an SSH session doesn't appear on the desktop.

**Quitting.** The script starts the installed app with `--quit`. The single-instance lock hands that to the running app, which quits as Quit in its tray menu does. A launch with `--quit` never starts the app, so it also works by hand, for example before `undo-peer-link-migrations.ps1 -Apply`. It only reaches an app in the same Windows session: over SSH, the app runs in another session, so there it is ended right away. Builds from before `--quit` show their window instead. Closing it quits a build without a tray icon; one with a tray icon hides again and is ended after up to 15 seconds. The database survives being ended like a crash; agents that were running in the app stop either way.

A file downloaded with PowerShell carries no "from the internet" mark, so SmartScreen doesn't ask. The build is still unsigned.

**Restore a backup:** quit T4 Code, delete `statev2.sqlite-wal` and `statev2.sqlite-shm` in `userdata`, copy the backup's files over `userdata`, then install the version that wrote them. Its version is in the backup's folder name. A backup folder is a complete T3 home, so `rehearse-switch.ps1 -Source <backup folder>` checks it first.

## Linux server: `install-t4.sh`

Runs the fork's server headless on a Linux x64 machine, so threads keep running around the clock while the desktop app and other machines connect to it. It installs for the current user and needs no root.

```sh
curl -fsSLO https://raw.githubusercontent.com/LukasDoubleU/t4code/t4/scripts/t4/install-t4.sh
sh install-t4.sh             # newest release
sh install-t4.sh --dry-run   # download and check only, show the rest
sh install-t4.sh --wait 60   # let running turns finish first, for up to an hour
```

1. Finds the newest release of this repository, or the one named with `--version`, as a tag or a version, like `install-t4.ps1`.
2. Downloads its Linux archive, `t3-<version>-linux-x64.tar.gz`, checks it against the release's `SHA256SUMS` and unpacks it into `~/.t3/runtime/versions/<version>`, beside the running version: the layout of upstream's `install.sh` and `t3 update`, so `t3 service install` and `t3 update` reuse it. A version already unpacked there isn't downloaded again.
3. Stops the background service if it runs. First it asks the server what the restart would stop and names it, as `install-t4.ps1` does. If something runs, or the server can't be asked, it asks you first, and without a terminal to ask in it stops; `--wait <minutes>` waits that long for the work to finish, and `--force` skips the question. From a terminal or agent inside T3 Code on that machine it refuses, because the restart would end it halfway: run it over SSH.
4. Backs up the files in `userdata` to `~/.t3/backups/<time>-<installed version>/userdata`, as `install-t4.ps1` does; `--skip-backup` skips this. It stops if a `t3` server started by hand still has the database open.
5. Points the `t3` launcher, `~/.local/bin/t3`, at the new version. `T3CODE_INSTALL_BIN_DIR` puts the launcher elsewhere.
6. Switches the background service to the new version with that version's `t3 service install`, which starts it again.
7. Removes old install backups, keeping the newest three; `--keep-backups <n>` keeps another number.

**First install.** Run `t3 service install` afterwards: a systemd user service that starts at boot and keeps running after logout. It listens on `127.0.0.1:3773`; for other machines to reach it, set `T3CODE_HOST` in `~/.t3/service.env` to an address they can reach, such as the LAN or tailnet address, and run `t3 service restart`. Upstream's [background service](../../docs/user/background-service.md) guide covers the service and that file. On minimal images the `t3` executable also needs `libatomic1`; the script says so when it is missing.

**Pair the desktop app.** On the server, `t3 pair` prints a one-time pairing link, `t3 pair --tailscale` one with a Tailscale HTTPS address. In the desktop app, open **Settings → Connections**, choose **Add environment** and paste it. See upstream's [remote access](../../docs/user/remote-access.md) guide for the other ways to connect.

**T3 Connect.** For links between this server and your other machines, sign the server in to T3 Connect with `t3 connect`, then run `t3 service restart`: the running service only picks up the sign-in after a restart. Three things trip up a headless install:

- `t3 connect` asks whether to download the relay client and waits for an answer, so run it in a terminal: over SSH use `ssh -t`, or it hangs without a prompt.
- Its device approval expires after ten minutes; open the link and confirm the code promptly, or run it again.
- After the restart, `journalctl --user -u t3code.service` should say that T3 Connect is reachable from other devices.

**Update** by running the script again after a release; it backs up `userdata` first. Unattended, `--wait <minutes>` lets running turns finish instead of stopping them; if they haven't by then, the update stops, or with `--force` goes ahead. `t3 update` on the server, and the update a client offers for a connected server, take this repository's releases as well, never upstream's, but make no backup. The repository and tag prefix they use are set in `packages/shared/src/cliRelease.ts`.

**Restore a backup:** stop the service (`systemctl --user stop t3code.service`), delete `statev2.sqlite-wal` and `statev2.sqlite-shm` in `userdata`, copy the backup's files over `userdata`, then install the version that wrote them with `--version` and start the service with `t3 service restart`.

## Switch versions safely

Rehearse every switch on a copy first: from one fork build to the next, and from the fork to an official release.

### Rehearse: `rehearse-switch.ps1`

```powershell
pwsh -File scripts/t4/rehearse-switch.ps1 -T3 <folder>\t3.exe
```

`-T3` is the target version's CLI, from its release's `t3-<version>-win32-x64.zip`. The script copies `userdata` into a scratch folder, starts `t3 serve` on the copy at a spare port on 127.0.0.1, and reports **PASS** when the server answers without migration, decode or settings errors in its log. Notes list the migrations the target ran and any it doesn't know. The scratch folder is deleted at the end.

- `-Browse` keeps the server running after the checks and prints a pairing URL. Open it and check that threads load: the automatic checks only cover what the server reads at startup.
- `-Source <T3 home>` copies another T3 home, for example a backup folder.
- `-UndoPeerLinks` applies `undo-peer-link-migrations.ps1` to the copy first.
- `-Keep` keeps the scratch folder. It holds your threads; delete it when done.

**The copy is inert.** On a copy of real data, the server would otherwise resume running threads, fire scheduled tasks, poll pull requests and start agents in real worktrees. So the script:

- gives the copy a fresh `environment-id` and copies none of the secrets: no T3 Connect sign-in, peer link tokens, provider logins or signing keys;
- switches off in the copy's `settings.json` every provider instance, restart continuation (`continueThreadsAfterServerUpdate`), automatic pulls and fetches, auto-settle, storage and worktree cleanup, limit recovery and project scripts;
- disables the copy's scheduled tasks and drops its queued effects;
- runs the server offline, behind a proxy nobody listens on, with a scratch profile and without this session's environment variables;
- first starts the target on the inert settings without any data, and stops if it can't read them.

If any of this fails, the rehearsal stops before starting on the copy. The server still finds git and the agent CLIs, because it rebuilds `PATH` from the registry: it reads the projects' repositories, as T3 Code does on every start, and checks the CLIs' versions, but it doesn't pull, fetch or start an agent.

### Migrations 068–070: `undo-peer-link-migrations.ps1`

The peer-link stack adds migrations 068 (`peer_environment_links`), 069 (its `fenced` column) and 070 (the index `orchestration_v2_projection_turn_items_waiting_link_idx`). Official `v0.1.1` and `v0.1.2` stop at 067 and only warn about ids they don't know. An official release that uses 068 for something else refuses to start, because the database "would skip required schema migrations". If upstream ships the stack with the same ids and names, nothing is needed.

When a rehearsal fails that way:

1. Rehearse again with `-UndoPeerLinks`. It should pass.
2. Run `pwsh -File scripts/t4/undo-peer-link-migrations.ps1`. It only reports what it would change.
3. Quit T4 Code and run it again with `-Apply`. It backs up the database and link tokens to `~/.t3/backups/<time>-undo-peer-links`, drops the table and index, deletes migrations 68–70 from `effect_sql_migrations`, and removes the link tokens from the secret store.
4. Switch, then link the machines again.

The script refuses when migrations above 067 aren't the stack's, for example after a switch already happened.

## Icon: `export-t4-icons.ts`

```powershell
vp run icons:export:t4
```

The fork's T4 icon is drawn in `assets/prod/t4`: `icon.svg` for 48 px and up, and `icon-16.svg`, `icon-24.svg` and `icon-32.svg`, fitted to the pixel grid so the tray and the favicon stay sharp. The script renders them over the production Windows, web and Linux icons in `assets/prod` that the builds package; macOS and iOS keep upstream's. It needs only Node and the repository's dependencies.

Upstream's `vp run icons:export` renders the T3 mark over the same files, so don't run it here. When an upstream merge conflicts on one of them, keep the fork's version and run this script again.

## Upstream watch: `upstream.json`

The workflow `t4-upstream-watch.yml` runs daily and can be started by hand. It comments on the upkeep issue named in `upstream.json` when upstream publishes a stable release newer than `base`, or when a carried upstream PR's state differs from the one last reported, or from the one recorded here if none was. Each change is reported once. A release comment lists which carried PRs the release contains.

Keep `upstream.json` current as part of the upkeep:

- After merging a release, set `base` to its tag and remove the PRs that shipped in it.
- When the fork starts or stops carrying an upstream PR, add or remove it with its current state: `open`, `closed` or `merged`.

The logic is in `.github/scripts/t4-upstream-watch.cjs`, which needs only Node. `--dry-run` prints the comment instead of posting it, and `--config <file>` tries another config, for example one with an older `base`:

```sh
node --test .github/scripts/t4-upstream-watch.test.cjs
node .github/scripts/t4-upstream-watch.cjs --dry-run --repo <owner>/t4code
```

Without `--dry-run` it posts with `GITHUB_TOKEN`; leave that to the workflow. A dry run uses `GITHUB_TOKEN` for its reads when it is set, and reads anonymously otherwise.
