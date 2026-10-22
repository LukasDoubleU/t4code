<p align="center"><img src="assets/prod/t4/icon.svg" width="96" alt="T4 Code icon"></p>

# T4 Code

T4 Code is a personal fork of [T3 Code](https://github.com/pingdotgg/t3code), the open-source GUI for Claude Code, Codex and other coding agents. It is built for running many agents across several machines and subscriptions: threads that reach across machines, an app that keeps running in the tray, a sidebar made for long-lived threads, and a hint which account to use next.

It is based on upstream `v0.1.1` and follows upstream releases. Only Windows builds are published.

> [!NOTE]
> T4 Code is not affiliated with T3 Tools or the T3 Code team. Please don't report its problems upstream.

## What's different from T3 Code

**Across machines**

- **Linked environments.** Link two machines in **Settings → Connections**, and agents on one launch, message, wait on and stop threads on the other; `delegate_task` runs a task there and reports back. Both machines need T4 Code. [Link another environment](./docs/user/remote-access.md#link-another-environment)
- **Find threads by name.** Agents find pinned threads across projects and linked machines, and resolve a bare thread ID on whichever machine has it. **Copy thread ID** is in the thread menu and the command palette.

**Long-lived threads**

- **Memory for pinned threads.** A pinned thread keeps a memory file that its agent reads after every compaction and keeps current. A brain icon on the card shows it; **Open memory** opens the file. [Keep a memory](./docs/user/thread-sidebar.md#keep-a-memory-for-a-pinned-thread)
- **Background section.** Threads that agents start on their own wait there and come forward only while they need you: a question, an approval or a failed run. The **Status** sort puts the same things first. [Keep agents' threads in the background](./docs/user/thread-sidebar.md#keep-agents-threads-in-the-background)
- **Sidebar.** Group threads by project, sort by last message, both in one menu; compact cards; the Background and Settled shelves stay at the bottom. [Sort and group threads](./docs/user/thread-sidebar.md#sort-and-group-threads)

**Several accounts**

- **Use next.** **Usage → Limits** ranks your Claude and Codex accounts by the room they have left, and new threads start on the recommended one. Agents see the same ranking in `orchestrator_capabilities`. [Track subscription limits](./docs/user/usage.md#track-subscription-limits)

**Chat**

- Every message shows its time, relative by default (`Worked for 26s · 10m ago`). A reply longer than the screen shows it at its end too.
- **Readable citations.** Cite a passage of a reply and comment on it: the agent receives the quote in place with your comment after it, and your sent message shows the quote. [Quote an assistant response](./docs/user/composer.md#quote-an-assistant-response)
- **Reactions.** React 👍 to a reply, or 👍 or 👎 to a passage you select in it, without starting a turn; the agent learns it with your next message. **Go ahead** approves the reply or the passage and starts a turn. [React to a response](./docs/user/composer.md#react-to-a-response)
- The new-thread picker (<kbd>Ctrl</kbd>+<kbd>N</kbd>) lists projects by name.

**Windows desktop**

- Keeps running in the tray when the window closes; **Quit** in the tray menu stops it.
- Its own name and icon, and Catppuccin (Mocha and Latte, Rosewater accent) as the default theme.
- Updates come from this repository's releases.

## Install

> [!WARNING]
> T4 Code replaces T3 Code on a machine. It uses the same data folder (`~/.t3`), so your threads, settings and T3 Connect sign-in carry over, and the two can't run side by side. The builds are unsigned.

1. Install and sign in to at least one agent CLI, for example [Claude Code](https://claude.com/product/claude-code) (`claude auth login`) or [Codex](https://developers.openai.com/codex/cli) (`codex login`). See [Install and first run](./docs/user/install.md).
2. Download `T3-Code-<version>-x64.exe` from the [latest release](https://github.com/LukasDoubleU/t4code/releases/latest) and run it. Windows SmartScreen may warn first, because the installer is unsigned. The installer and the program folder keep T3 Code's names, so existing shortcuts and updates carry over.
3. Later versions arrive through the app's update check.

From a clone, `pwsh -File scripts/t4/install-t4.ps1` does the same in one step: it checks the download against `SHA256SUMS`, quits the app, backs up your data and installs. Each release also has the `t3` command-line tool as `t3-<version>-win32-x64.zip`.

Versions read `0.1.2-t4.N`: the upstream patch after the base, plus the fork's build number.

### Linux server

Each release also has the server for Linux x64, `t3-<version>-linux-x64.tar.gz`, to run headless on a machine that keeps threads running while the desktop app connects to it. `scripts/t4/install-t4.sh` installs and updates it for the current user; [`scripts/t4/README.md`](./scripts/t4/README.md#linux-server-install-t4sh) covers the background service and pairing.

### Back to T3 Code

Install the official `v0.1.1` over T4 Code: everything stays, and it only warns about the three database migrations the fork adds. For a later official release, rehearse the switch first; [`scripts/t4/README.md`](./scripts/t4/README.md) explains how.

## Following upstream

T4 Code merges each upstream release rather than rebasing, and drops a change once upstream ships it. Until then it carries these upstream pull requests:

| Change                       | Upstream                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------ |
| Linked environments          | `#16653`, `#16654`, `#16655`, `#16684`, `#16695`, `#16698`, `#16719`, `#17130` |
| Tray                         | `#19176`                                                                       |
| Group threads by project     | `#21039`                                                                       |
| Sort threads by last message | `#22032`                                                                       |

Everything else is a fork patch, tracked in this repository's issues. A daily workflow comments on the upkeep issue (#13) when upstream publishes a release or a carried pull request changes state.

## Documentation

The docs in [docs/](./docs) are upstream's, with the fork's features added.

- [Install and first run](./docs/user/install.md)
- [Working with threads](./docs/user/thread-sidebar.md)
- [Usage and limits](./docs/user/usage.md)
- [Remote access and linked environments](./docs/user/remote-access.md)
- [Connect Claude Code, Codex and other agents over MCP](./docs/user/outside-agents.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Appearance](./docs/user/appearance.md)
- [Updating](./docs/user/updating.md)
- Multiple accounts: [Claude](./docs/user/providers-claude.md) · [Codex](./docs/user/providers-codex.md)
- [Fork scripts: install, rehearse a switch, undo the fork's migrations](./scripts/t4/README.md)

## Build from source

Install [Vite+](https://viteplus.dev/guide/) for the `vp` command, then run `vp i` and `vp run dev`. Start reading at [docs/internals/overview.md](./docs/internals/overview.md). Releases are built by `.github/workflows/t4-release.yml` from a `t4-v*` tag.

This fork follows its owner's needs and doesn't take contributions. For T3 Code itself, see upstream.

## License

MIT, like T3 Code. See [LICENSE](./LICENSE).
