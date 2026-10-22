// @effect-diagnostics nodeBuiltinImport:off - Drives install-t4.ps1 and install-t4.sh through their shells on a scratch T3 home.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { describe, expect, it } from "vite-plus/test";

const script = NodePath.join(import.meta.dirname, "install-t4.ps1");
const shellScript = NodePath.join(import.meta.dirname, "install-t4.sh");
const isWindows = HostProcess.Platform.defaultValue() === "win32";
const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

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

describe.skipIf(!isWindows)("install-t4.ps1 backups", () => {
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

const thread = (id: string, title: string, activityRunStatus: string | null, extra = {}) => ({
  id,
  title,
  activityRunStatus,
  status: activityRunStatus ?? "completed",
  pendingRuntimeRequest: null,
  latestVisibleMessage: { text: 'Said "done" in {"threads": []}, \\ and ] [' },
  goal: { title: "Not a thread", activityRunStatus: "running" },
  pendingBackgroundTasks: [],
  ...extra,
});

const snapshot = {
  schemaVersion: 2,
  snapshotSequence: 7,
  threads: [
    thread("t1", 'Fix "the" {bug}', "running"),
    thread("t2", "Pinned, warm and idle", null),
    thread("t3", "Waits for approval", "waiting", {
      pendingRuntimeRequest: { id: "r1", kind: "approval", blocking: true },
    }),
    thread("t4", "From an older server", null, { activityRunStatus: undefined }),
  ],
  archivedThreads: [thread("t5", "Archived, still starting", "starting")],
  projects: [{ id: "p1", title: "activityRunStatus" }],
};
const busy = [
  '"Fix "the" {bug}" (running)',
  '"Waits for approval" (waiting)',
  '"Archived, still starting" (starting)',
];

// A server that answers the shell snapshot request as T3 Code does, given the token.
const withServer = async <A>(body: unknown, run: (home: string) => Promise<A>) => {
  const server = NodeHttp.createServer((request, response) => {
    const authorized =
      request.headers.authorization === "Bearer test-token" &&
      request.headers["x-t3-orchestration-protocol"] === "2";
    response.statusCode = !authorized
      ? 401
      : request.url === "/api/orchestration/shell"
        ? 200
        : 404;
    response.end(authorized ? JSON.stringify(body) : "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t4-install-work-"));
  try {
    const address = server.address() as { port: number };
    await NodeFSP.mkdir(NodePath.join(home, "userdata"));
    // No process has this id, so no terminal runs under it.
    await NodeFSP.writeFile(
      NodePath.join(home, "userdata", "server-runtime.json"),
      JSON.stringify({ version: 1, pid: 2147483646, origin: `http://127.0.0.1:${address.port}` }),
    );
    return await run(home);
  } finally {
    server.close();
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
};

const runningWorkPs1 = (home: string, token: string) =>
  execFile(
    "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `. '${script.replaceAll("'", "''")}'; $r = Get-RunningWork ([pscustomobject]@{ token = '${token}' }); if ($r) { $r.Work } else { 'not asked' }`,
    ],
    { env: { ...process.env, T3CODE_HOME: home }, encoding: "utf8" },
  ).then(({ stdout }) => stdout.trim().split(/\r?\n/).filter(Boolean));

describe.skipIf(!isWindows)("install-t4.ps1 running work", () => {
  it("lists the threads with a turn in progress, not idle warm ones", async () => {
    await withServer(snapshot, async (home) => {
      expect(await runningWorkPs1(home, "test-token")).toEqual(busy);
    });
  });

  it("can't tell without the server's answer", async () => {
    await withServer(snapshot, async (home) => {
      expect(await runningWorkPs1(home, "wrong-token")).toEqual(["not asked"]);
    });
  });
});

const runningWorkSh = (home: string, token: string) =>
  execFile(
    "sh",
    [
      "-c",
      `INSTALL_T4_FUNCTIONS_ONLY=1 . "$0"; token=${token}; work="$T3CODE_HOME"; if out="$(running_work)"; then printf '%s\\n' "$out"; else echo 'not asked'; fi`,
      shellScript.replaceAll("\\", "/"),
    ],
    { env: { ...process.env, T3CODE_HOME: home }, encoding: "utf8" },
  ).then(({ stdout }) => stdout.trim().split(/\r?\n/).filter(Boolean));

describe.skipIf(isWindows)("install-t4.sh running work", () => {
  it("lists the threads with a turn in progress, not idle warm ones", async () => {
    await withServer(snapshot, async (home) => {
      expect(await runningWorkSh(home, "test-token")).toEqual(busy);
    });
  });

  it("can't tell without the server's answer", async () => {
    await withServer(snapshot, async (home) => {
      expect(await runningWorkSh(home, "wrong-token")).toEqual(["not asked"]);
    });
    await withServer({ error: "not a snapshot" }, async (home) => {
      expect(await runningWorkSh(home, "test-token")).toEqual(["not asked"]);
    });
  });
});
