# Fork scripts (Windows)

Scripts that only this fork carries, for installing its builds and switching versions without losing data. They need PowerShell 7 and use `T3CODE_HOME` when it is set, `~/.t3` otherwise.

## Install or update: `install-t4.ps1`

```powershell
pwsh -File scripts/t4/install-t4.ps1            # newest release
pwsh -File scripts/t4/install-t4.ps1 -WhatIf    # download and check only, show the rest
```

1. Finds the newest release of this repository, the one GitHub marks as latest, or the one named with `-Version`, as a tag (`t4-v0.1.2-t4.1`) or a version (`0.1.2-t4.1`).
2. Downloads its installer, `T3-Code-<version>-x64.exe`, and checks it against the release's `SHA256SUMS`. The tag prefix and asset names are set at the top of the script, matching the release workflow.
3. Quits T3 Code. If agents or terminals are running in it, it asks first; `-Force` skips the question.
4. Backs up the files in `userdata` to `~/.t3/backups/<time>-<installed version>/userdata`: the databases with their `-wal` and `-shm` files, settings and keybindings. The installer leaves the subfolders alone. `-SkipBackup` skips this step.
5. Runs the installer silently and starts the app again. Over SSH, it prints a hint instead: an app started from an SSH session doesn't appear on the desktop.

Closing the window lets a build without a tray icon shut its server down. A build with one only hides in the tray, and over SSH there is no window to close, so after up to 15 seconds the app is ended. The database survives that like a crash; agents that were running in it stop.

A file downloaded with PowerShell carries no "from the internet" mark, so SmartScreen doesn't ask. The build is still unsigned.

**Restore a backup:** quit T3 Code, delete `statev2.sqlite-wal` and `statev2.sqlite-shm` in `userdata`, copy the backup's files over `userdata`, then install the version that wrote them. Its version is in the backup's folder name.
