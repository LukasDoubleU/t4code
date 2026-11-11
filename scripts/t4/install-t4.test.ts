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

// A server that answers the shell snapshot request as T3 Code does, given the token,
// and with serverVersion its public environment descriptor.
const withServer = async <A>(
  body: unknown,
  run: (home: string) => Promise<A>,
  serverVersion?: string,
) => {
  const server = NodeHttp.createServer((request, response) => {
    if (serverVersion !== undefined && request.url === "/.well-known/t3/environment") {
      response.end(JSON.stringify({ environmentId: "e1", serverVersion }));
      return;
    }
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
      JSON.stringify({
        version: 1,
        pid: 2147483646,
        origin: `http://127.0.0.1:${address.port}`,
        ...(serverVersion === undefined ? {} : { serverVersion }),
      }),
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

const oldVersion = "0.1.9-t4.1";
const newVersion = "0.1.10-t4.1";

const stub = (path: string, body: string) =>
  NodeFSP.writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });

// Runs install-t4.sh on a T3 home whose service runs oldVersion by its unit
// and launcher, with newVersion unpacked and the newest release. curl answers
// GitHub itself; systemctl and t3 only log their calls.
const installSh = async (home: string) => {
  const stubs = NodePath.join(home, "stubs");
  const unit = NodePath.join(home, ".config", "systemd", "user", "t3code.service");
  const versions = NodePath.join(home, "runtime", "versions");
  const log = NodePath.join(home, "calls.log");
  await NodeFSP.mkdir(stubs);
  await NodeFSP.mkdir(NodePath.dirname(unit), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(home, "bin"));
  for (const version of [oldVersion, newVersion]) {
    await NodeFSP.mkdir(NodePath.join(versions, version), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(versions, version, ".install-complete"), `${version}\n`);
    await stub(
      NodePath.join(versions, version, "t3"),
      `printf 't3 ${version} %s\\n' "$*" >> "$T3CODE_HOME/calls.log"
if [ "$1 $2 $3" = "auth session issue" ]; then printf '{\\n  "sessionId": "s1",\\n  "token": "test-token"\\n}\\n'; fi`,
    );
  }
  await NodeFSP.symlink(
    NodePath.join(versions, oldVersion, "t3"),
    NodePath.join(home, "bin", "t3"),
  );
  await NodeFSP.writeFile(
    unit,
    [
      "[Service]",
      `Environment=T3CODE_HOME=${home}`,
      `ExecStart=${versions}/${oldVersion}/t3 __service-launcher`,
      "",
    ].join("\n"),
  );
  await stub(
    NodePath.join(stubs, "systemctl"),
    `printf 'systemctl %s\\n' "$*" >> "$T3CODE_HOME/calls.log"`,
  );
  await stub(
    NodePath.join(stubs, "uname"),
    `if [ "$1" = -m ]; then echo x86_64; else echo Linux; fi`,
  );
  const realCurl = (await execFile("sh", ["-c", "command -v curl"])).stdout.trim();
  await stub(
    NodePath.join(stubs, "curl"),
    `for arg; do url="$arg"; done
case "$url" in
  https://api.github.com/*)
    while [ $# -gt 0 ]; do if [ "$1" = --output ]; then out="$2"; fi; shift; done
    printf '{"tag_name":"t4-v${newVersion}"}' > "$out"
    printf 200 ;;
  *) exec '${realCurl}' "$@" ;;
esac`,
  );
  const { stdout } = await execFile("sh", [shellScript], {
    env: {
      ...process.env,
      HOME: home,
      PATH: `${stubs}:${process.env.PATH}`,
      T3CODE_HOME: home,
      T3CODE_INSTALL_BIN_DIR: NodePath.join(home, "bin"),
      // Set when this runs inside T3 Code's service, where the script refuses to restart it.
      T3_BOOT_SERVICE_UNIT: "",
    },
    encoding: "utf8",
  });
  return {
    stdout,
    unit: await NodeFSP.readFile(unit, "utf8"),
    launcher: await NodeFSP.readlink(NodePath.join(home, "bin", "t3")),
    calls: (await NodeFSP.readFile(log, "utf8")).trim().split("\n"),
  };
};

describe.skipIf(isWindows)("install-t4.sh after a built-in update", () => {
  it("points the unit and launcher at the version the service already runs, without a restart", async () => {
    await withServer(
      snapshot,
      async (home) => {
        const result = await installSh(home);
        const versions = NodePath.join(home, "runtime", "versions");
        expect(result.unit).toContain(`ExecStart=${versions}/${newVersion}/t3 __service-launcher`);
        expect(result.unit).not.toContain(oldVersion);
        expect(result.launcher).toBe(NodePath.join(versions, newVersion, "t3"));
        expect(result.calls).toEqual([
          "systemctl --user is-active --quiet t3code.service",
          "systemctl --user daemon-reload",
        ]);
        expect(result.stdout).toContain(`already runs ${newVersion}`);
      },
      newVersion,
    );
  });

  it("restarts the service when it runs an older version", async () => {
    await withServer(
      { threads: [] },
      async (home) => {
        const result = await installSh(home);
        expect(result.calls).toContain("systemctl --user stop t3code.service");
        expect(result.calls).toContain(`t3 ${newVersion} service install --allow-downgrade`);
        expect(result.launcher).toBe(NodePath.join(home, "runtime", "versions", newVersion, "t3"));
      },
      oldVersion,
    );
  });
});
