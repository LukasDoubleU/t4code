// @effect-diagnostics nodeBuiltinImport:off - Drives install-t4.ps1's backup pruning through pwsh on a scratch T3 home.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const script = NodePath.join(import.meta.dirname, "install-t4.ps1");

const installBackups = [
  "20261001-090000",
  "20261002-090000-0.1.1",
  "20261003-090000-0.1.2-t4.1",
  "20261004-090000-0.1.2-t4.2",
  "20261005-090000-0.1.2-t4.3",
];
const otherFolders = [
  "20261001-080000-undo-peer-links",
  "20261009-080000-undo-peer-links",
  "notes",
];

// Dot-sourcing only defines the script's functions. They take ShouldProcess,
// and with it -WhatIf, from their caller, as they do from the script.
const removeOldBackups = (home: string, keep: number, whatIf: boolean) =>
  NodeChildProcess.execFileSync(
    "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `function Invoke-Prune { [CmdletBinding(SupportsShouldProcess)] param() . '${script.replaceAll("'", "''")}'; Remove-OldBackups ${keep} }; Invoke-Prune${whatIf ? " -WhatIf" : ""}`,
    ],
    { env: { ...process.env, T3CODE_HOME: home }, encoding: "utf8" },
  );

describe.skipIf(HostProcess.Platform.defaultValue() !== "win32")("install-t4.ps1 backups", () => {
  it.each([false, true])(
    "removes only install backups beyond the newest three (-WhatIf: %s)",
    async (whatIf) => {
      const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t4-install-backups-"));
      try {
        const backups = NodePath.join(home, "backups");
        const folders = [...installBackups, ...otherFolders];
        await Promise.all(
          folders.map((name) =>
            NodeFSP.mkdir(NodePath.join(backups, name, "userdata"), { recursive: true }),
          ),
        );

        const output = removeOldBackups(home, 3, whatIf);

        const old = installBackups.slice(0, 2);
        expect(folders.filter((name) => output.includes(NodePath.join(backups, name)))).toEqual(
          old,
        );
        expect(output.includes("Removed old backup")).toBe(!whatIf);
        expect((await NodeFSP.readdir(backups)).toSorted()).toEqual(
          folders.filter((name) => whatIf || !old.includes(name)).toSorted(),
        );
      } finally {
        await NodeFSP.rm(home, { recursive: true, force: true });
      }
    },
  );
});
