import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it } from "vite-plus/test";

import {
  machineProjects,
  newRepositoriesIn,
  parseCloneRepository,
  resolveFolderQuery,
  resolveInitialMachine,
  suggestedFolderRoots,
} from "./NewThreadDialog.logic";

const desktop = EnvironmentId.make("desktop");
const server = EnvironmentId.make("server");
const laptop = EnvironmentId.make("laptop");

describe("resolveInitialMachine", () => {
  const machines = [
    { environmentId: desktop, isConnected: true },
    { environmentId: server, isConnected: true },
    { environmentId: laptop, isConnected: false },
  ];

  it("opens on the only connected machine", () => {
    expect(
      resolveInitialMachine({
        machines: [
          { environmentId: desktop, isConnected: true },
          { environmentId: laptop, isConnected: false },
        ],
        currentEnvironmentId: laptop,
        lastEnvironmentId: null,
      }),
    ).toBe(desktop);
  });

  it("prefers the current thread's machine over the one picked last", () => {
    expect(
      resolveInitialMachine({ machines, currentEnvironmentId: server, lastEnvironmentId: desktop }),
    ).toBe(server);
  });

  it("falls back to the machine picked last, but never to a disconnected one", () => {
    expect(
      resolveInitialMachine({ machines, currentEnvironmentId: null, lastEnvironmentId: server }),
    ).toBe(server);
    expect(
      resolveInitialMachine({ machines, currentEnvironmentId: laptop, lastEnvironmentId: laptop }),
    ).toBeNull();
  });
});

describe("machineProjects", () => {
  const project = (environmentId: EnvironmentId, id: string, workspaceRoot = `/w/${id}`) => ({
    environmentId,
    id: ProjectId.make(id),
    workspaceRoot,
  });
  const groups = [
    { displayName: "Api", memberProjects: [project(desktop, "api"), project(server, "api-s")] },
    { displayName: "Web", memberProjects: [project(server, "web")] },
    { displayName: "Scratch", memberProjects: [project(server, "scratch", "/tmp/scratch")] },
  ];

  it("lists only that machine's projects, current one first, hidden ones left out", () => {
    const result = machineProjects({
      groups,
      environmentId: server,
      currentProjectRef: scopeProjectRef(server, ProjectId.make("web")),
      isHidden: (candidate) => candidate.workspaceRoot === "/tmp/scratch",
    });
    expect(result.map((entry) => [entry.displayName, entry.project.id])).toEqual([
      ["Web", "web"],
      ["Api", "api-s"],
    ]);
  });

  it("keeps sidebar order when the current project is on another machine", () => {
    const result = machineProjects({
      groups,
      environmentId: server,
      currentProjectRef: scopeProjectRef(desktop, ProjectId.make("api")),
      isHidden: () => false,
    });
    expect(result.map((entry) => entry.project.id)).toEqual(["api-s", "web", "scratch"]);
  });
});

describe("suggestedFolderRoots", () => {
  it("offers the base folder, where projects live most, the new projects root, then home", () => {
    expect(
      suggestedFolderRoots({
        addProjectBaseDirectory: "~/code",
        newProjectsRoot: "/home/me/new",
        projectRoots: ["/srv/one/a", "/home/me/work/b", "/home/me/work/c/"],
      }),
    ).toEqual(["~/code/", "/home/me/work/", "/srv/one/", "/home/me/new/", "~/"]);
  });

  it("lists each folder once", () => {
    expect(
      suggestedFolderRoots({
        addProjectBaseDirectory: "/home/me/work/",
        newProjectsRoot: null,
        projectRoots: ["/home/me/work/a"],
      }),
    ).toEqual(["/home/me/work/", "~/"]);
  });
});

describe("newRepositoriesIn", () => {
  it("offers repositories that are not projects yet", () => {
    expect(
      newRepositoriesIn(
        {
          parentPath: "/w",
          entries: [
            { name: "added", fullPath: "/w/added", isGitRepo: true },
            { name: "fresh", fullPath: "/w/fresh", isGitRepo: true },
            { name: "notes", fullPath: "/w/notes" },
            { name: ".hidden", fullPath: "/w/.hidden", isGitRepo: true },
          ],
        },
        ["/w/added/"],
      ).map((entry) => entry.name),
    ).toEqual(["fresh"]);
  });
});

describe("resolveFolderQuery", () => {
  const listing = {
    parentPath: "/home/me/work",
    entries: [
      { name: "app", fullPath: "/home/me/work/app", isGitRepo: true },
      { name: "apple", fullPath: "/home/me/work/apple" },
      { name: "docs", fullPath: "/home/me/work/docs" },
    ],
  };

  it("names the existing folder a typed path points at, so Enter can add it", () => {
    const result = resolveFolderQuery({ query: "~/work/app", platform: "Linux", browse: listing });
    expect(result.entries.map((entry) => entry.name)).toEqual(["app", "apple"]);
    expect(result.target).toEqual({ path: "/home/me/work/app", isGitRepo: true });
  });

  it("has no target for a path that does not exist", () => {
    expect(
      resolveFolderQuery({ query: "~/work/ap", platform: "Linux", browse: listing }).target,
    ).toBeNull();
    expect(
      resolveFolderQuery({ query: "~/work/APP", platform: "Linux", browse: listing }).target,
    ).toBeNull();
  });

  it("matches folder names without case on Windows", () => {
    expect(
      resolveFolderQuery({ query: "C:\\work\\APP", platform: "Win32", browse: listing }).target
        ?.path,
    ).toBe("/home/me/work/app");
  });

  it("targets the folder itself when the path ends in a separator", () => {
    const inside = {
      parentPath: "/home/me/work/app",
      entries: [
        { name: ".git", fullPath: "/home/me/work/app/.git" },
        { name: "src", fullPath: "/home/me/work/app/src" },
      ],
    };
    const result = resolveFolderQuery({ query: "~/work/app/", platform: "Linux", browse: inside });
    expect(result.entries.map((entry) => entry.name)).toEqual(["src"]);
    expect(result.target).toEqual({ path: "/home/me/work/app", isGitRepo: true });
  });

  it("is not a path query for plain text", () => {
    const result = resolveFolderQuery({ query: "app", platform: "Linux", browse: listing });
    expect(result.browsePath.isBrowsing).toBe(false);
    expect(result.target).toBeNull();
  });
});

describe("parseCloneRepository", () => {
  it.each([
    ["octocat/hello", "https://github.com/octocat/hello.git", "hello"],
    ["https://gitlab.com/group/sub/tool.git", "https://gitlab.com/group/sub/tool.git", "tool"],
    ["git@github.com:octocat/hello.git", "git@github.com:octocat/hello.git", "hello"],
    ["ssh://git@example.com:2222/team/api", "ssh://git@example.com:2222/team/api", "api"],
  ])("accepts %s", (input, remoteUrl, directoryName) => {
    expect(parseCloneRepository(input)).toEqual({ remoteUrl, directoryName });
  });

  it.each(["", "hello", "two words/repo", "https://github.com"])("rejects %j", (input) => {
    expect(parseCloneRepository(input)).toBeNull();
  });
});
