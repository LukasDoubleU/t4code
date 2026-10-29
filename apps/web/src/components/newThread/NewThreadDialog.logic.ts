import {
  getCloneDirectoryName,
  normalizePastedCloneUrl,
} from "@t3tools/client-runtime/operations/projects";
import {
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "@t3tools/client-runtime/state/filesystem";
import {
  ensureBrowseDirectoryPath,
  getBrowseDirectoryPath,
  hasTrailingPathSeparator,
} from "@t3tools/client-runtime/state/projects";
import type { EnvironmentId, FilesystemBrowseResult, ScopedProjectRef } from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";

import { isWindowsPlatform } from "../../lib/utils";

export type NewThreadDialogStep = "machine" | "project" | "folder" | "clone" | "new-project";

export interface NewThreadMachine {
  readonly environmentId: EnvironmentId;
  readonly isConnected: boolean;
}

/**
 * The machine the dialog opens on: the only connected one, else the current
 * thread's, else the one picked last. Null means the user has to choose.
 */
export function resolveInitialMachine(input: {
  readonly machines: ReadonlyArray<NewThreadMachine>;
  readonly currentEnvironmentId: EnvironmentId | null;
  readonly lastEnvironmentId: EnvironmentId | null;
}): EnvironmentId | null {
  const connected = input.machines.filter((machine) => machine.isConnected);
  if (connected.length === 1) return connected[0]!.environmentId;
  for (const candidate of [input.currentEnvironmentId, input.lastEnvironmentId]) {
    if (candidate !== null && connected.some((machine) => machine.environmentId === candidate)) {
      return candidate;
    }
  }
  return null;
}

interface ProjectGroupLike<TProject> {
  readonly displayName: string;
  readonly memberProjects: ReadonlyArray<TProject>;
}

/**
 * One machine's projects in sidebar order, with the current project first so
 * Enter starts the thread Ctrl+N used to.
 */
export function machineProjects<
  TProject extends { readonly environmentId: EnvironmentId; readonly id: string },
>(input: {
  readonly groups: ReadonlyArray<ProjectGroupLike<TProject>>;
  readonly environmentId: EnvironmentId;
  readonly currentProjectRef: ScopedProjectRef | null;
  readonly isHidden: (project: TProject) => boolean;
}): Array<{ readonly project: TProject; readonly displayName: string }> {
  const entries = input.groups.flatMap((group) =>
    group.memberProjects
      .filter(
        (project) => project.environmentId === input.environmentId && !input.isHidden(project),
      )
      .map((project) => ({ project, displayName: group.displayName })),
  );
  const current = input.currentProjectRef;
  const currentIndex =
    current === null || current.environmentId !== input.environmentId
      ? -1
      : entries.findIndex((entry) => entry.project.id === current.projectId);
  if (currentIndex <= 0) return entries;
  return [entries[currentIndex]!, ...entries.toSpliced(currentIndex, 1)];
}

const SUGGESTED_ROOT_LIMIT = 5;

/**
 * Folders worth offering before anything is typed: the configured base folder,
 * where this machine's projects already live (most used first), the new
 * projects root, then home.
 */
export function suggestedFolderRoots(input: {
  readonly addProjectBaseDirectory: string;
  readonly newProjectsRoot: string | null;
  readonly projectRoots: ReadonlyArray<string>;
}): string[] {
  const parentCounts = new Map<string, number>();
  for (const root of input.projectRoots) {
    const parent = getBrowseDirectoryPath(root.trim().replace(/[\\/]+$/, ""));
    if (parent.length === 0) continue;
    parentCounts.set(parent, (parentCounts.get(parent) ?? 0) + 1);
  }
  const projectParents = [...parentCounts.entries()]
    .toSorted((left, right) => right[1] - left[1])
    .map(([parent]) => parent);
  const candidates = [
    input.addProjectBaseDirectory,
    ...projectParents,
    input.newProjectsRoot ?? "",
    "~/",
  ].map((candidate) => ensureBrowseDirectoryPath(candidate));
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const candidate of candidates) {
    const key = normalizeProjectPathForComparison(candidate);
    if (candidate.length === 0 || seen.has(key)) continue;
    seen.add(key);
    roots.push(candidate);
  }
  return roots.slice(0, SUGGESTED_ROOT_LIMIT);
}

/** Repositories under a suggested root that are not projects yet. */
export function newRepositoriesIn(
  browse: FilesystemBrowseResult | null,
  projectRoots: ReadonlyArray<string>,
): FilesystemBrowseResult["entries"] {
  if (browse === null) return [];
  const added = new Set(projectRoots.map((root) => normalizeProjectPathForComparison(root)));
  return browse.entries.filter(
    (entry) =>
      entry.isGitRepo === true &&
      !entry.name.startsWith(".") &&
      !added.has(normalizeProjectPathForComparison(entry.fullPath)),
  );
}

export interface FolderTarget {
  readonly path: string;
  readonly isGitRepo: boolean;
}

/**
 * Reads a typed folder path against the listing of its parent: the folders
 * that complete it, and the existing folder it names, which Enter adds.
 */
export function resolveFolderQuery(input: {
  readonly query: string;
  readonly platform: string;
  readonly browse: FilesystemBrowseResult | null;
}) {
  const browsePath = getFilesystemBrowsePath(input.query, input.platform);
  if (!browsePath.isBrowsing) {
    return { browsePath, entries: [], target: null };
  }
  const listing = input.browse?.entries ?? [];
  const { visibleEntries } = filterFilesystemBrowseEntries(listing, browsePath.filterQuery);
  let target: FolderTarget | null = null;
  if (input.browse !== null) {
    if (hasTrailingPathSeparator(input.query)) {
      // The listing is of the folder itself, hidden entries included.
      target = {
        path: input.browse.parentPath,
        isGitRepo: listing.some((entry) => entry.name === ".git"),
      };
    } else {
      const caseSensitive = !isWindowsPlatform(input.platform);
      const exact = listing.find((entry) =>
        caseSensitive
          ? entry.name === browsePath.filterQuery
          : entry.name.toLowerCase() === browsePath.filterQuery.toLowerCase(),
      );
      if (exact) target = { path: exact.fullPath, isGitRepo: exact.isGitRepo === true };
    }
  }
  return { browsePath, entries: visibleEntries, target };
}

/** Accepts `owner/repo` (GitHub), HTTPS and SSH clone URLs. */
export function parseCloneRepository(
  raw: string,
): { readonly remoteUrl: string; readonly directoryName: string } | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) return null;
  const remoteUrl = normalizePastedCloneUrl(trimmed);
  const isUrl =
    /^[a-z][a-z0-9+.-]*:\/\//i.test(remoteUrl) || /^[^/\\:\s]+@[^/\\:\s]+:/.test(remoteUrl);
  if (!isUrl) return null;
  const directoryName = getCloneDirectoryName(remoteUrl);
  return directoryName.length === 0 ? null : { remoteUrl, directoryName };
}
