import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  canCreateProjectInEnvironment,
  getCloneDestinationPath,
} from "@t3tools/client-runtime/operations/projects";
import { getFilesystemBrowsePath } from "@t3tools/client-runtime/state/filesystem";
import { pickableProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import {
  appendBrowsePathSegment,
  ensureBrowseDirectoryPath,
  findProjectByPath,
  inferProjectTitleFromPath,
  isScratchProject,
} from "@t3tools/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { connectionStatusText } from "@t3tools/client-runtime/connection";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  type EnvironmentId,
  type ProjectId,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronRightIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  MessageSquareDashedIcon,
} from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";

import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useNewProject } from "../../hooks/useNewProject";
import { useScratchProject } from "../../hooks/useScratchProject";
import { useStableCallback } from "../../hooks/useStableCallback";
import { resolveThreadActionProjectRef } from "../../lib/chatThreadActions";
import { newProjectId } from "../../lib/utils";
import { useProjects, waitForProject } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { filesystemEnvironment, useFilesystemReadAccess } from "../../state/filesystem";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { resolveEnvironmentOptionLabel } from "../BranchToolbar.logic";
import {
  ADDON_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteSubmenuItem,
  errorMessage,
  filterCommandPaletteGroups,
  getEnvironmentBrowsePlatform,
  ITEM_ICON_CLASS,
} from "../CommandPalette.logic";
import { CommandPaletteContent } from "../CommandPaletteContent";
import { useEnvironmentLookups, useSortedProjectGroups } from "../CommandPaletteLookups";
import { CommandPaletteResults } from "../CommandPaletteResults";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import { CommandDialog, CommandDialogPopup, CommandFooterAction } from "../ui/command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  machineProjects,
  newRepositoriesIn,
  type NewThreadDialogStep,
  parseCloneRepository,
  resolveFolderQuery,
  resolveInitialMachine,
  suggestedFolderRoots,
} from "./NewThreadDialog.logic";
import {
  closeNewThreadDialog,
  type NewThreadDialogRequest,
  rememberNewThreadMachine,
  useNewThreadDialogStore,
} from "./newThreadDialogStore";
import { useNativeProjectFolderPicker } from "./useNativeProjectFolderPicker";

type DialogItem = CommandPaletteActionItem | CommandPaletteSubmenuItem;

interface CloneDestination {
  readonly remoteUrl: string;
  readonly directoryName: string;
  readonly repositoryInput: string;
}

const CHEVRON = (
  <ChevronRightIcon className="-me-0.5 ms-auto size-4 shrink-0 text-muted-foreground/70" />
);

function reportFailure(title: string, error: unknown) {
  toastManager.add(stackedThreadToast({ type: "error", title, description: errorMessage(error) }));
}

export function NewThreadDialogHost() {
  const request = useNewThreadDialogStore((state) => state.request);
  return request ? <NewThreadDialog request={request} /> : null;
}

function NewThreadDialog({ request }: { request: NewThreadDialogRequest }) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { environments } = useEnvironments();
  const projects = useProjects();
  const { environmentLabelById } = useEnvironmentLookups();
  const projectGroups = useSortedProjectGroups(environmentLabelById);
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const { scratchEnvironmentId, scratchWorkspaceRootFor, openScratchProject } = useScratchProject();
  const createNewProject = useNewProject();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const startProjectClone = useAtomCommand(sourceControlEnvironment.startProjectClone, {
    reportFailure: false,
  });
  const folderPicker = useNativeProjectFolderPicker();

  const machines = environments
    .map((environment) => {
      const isPrimary = environment.entry.target._tag === "PrimaryConnectionTarget";
      return {
        environmentId: environment.environmentId,
        label: resolveEnvironmentOptionLabel({
          isPrimary,
          environmentId: environment.environmentId,
          runtimeLabel: environment.label,
        }),
        isPrimary,
        machine: resolveEnvironmentMachineKind(environment.serverConfig),
        isConnected: canCreateProjectInEnvironment(environment.connection.phase),
        status: connectionStatusText(environment.connection),
      };
    })
    .toSorted(
      (left, right) =>
        Number(right.isPrimary) - Number(left.isPrimary) || left.label.localeCompare(right.label),
    );
  const contextualProjectRef = resolveThreadActionProjectRef({
    activeDraftThread,
    activeThread: activeThread ?? undefined,
    defaultProjectRef,
    handleNewThread,
  });

  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(() =>
    resolveInitialMachine({
      machines,
      currentEnvironmentId: activeThread?.environmentId ?? activeDraftThread?.environmentId ?? null,
      lastEnvironmentId: useNewThreadDialogStore.getState().lastEnvironmentId,
    }),
  );
  const [step, setStep] = useState<NewThreadDialogStep>(() =>
    environmentId === null ? "machine" : "project",
  );
  const [query, setQuery] = useState("");
  const [cloneDestination, setCloneDestination] = useState<CloneDestination | null>(null);
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  // State lags a render behind, so a quick second Enter would run an action twice.
  const busyRef = useRef(false);

  const environment = environments.find((entry) => entry.environmentId === environmentId) ?? null;
  const currentMachine = machines.find((machine) => machine.environmentId === environmentId);
  const machineLabel = currentMachine?.label ?? "this machine";
  const platform = getEnvironmentBrowsePlatform(environment?.serverConfig?.environment.platform.os);
  const newProjectsRoot = environment?.serverConfig?.newProjectsRoot ?? null;
  const machineProjectRoots = projects
    .filter((project) => project.environmentId === environmentId)
    .map((project) => project.workspaceRoot);
  const folderRoots = suggestedFolderRoots({
    addProjectBaseDirectory: environment?.serverConfig?.settings.addProjectBaseDirectory ?? "",
    newProjectsRoot,
    projectRoots: machineProjectRoots,
  });
  const cloneParent = folderRoots[0] ?? "~/";

  // Folder paths are typed in the folder step and when choosing a clone destination.
  const isFolderStep = step === "folder" || (step === "clone" && cloneDestination !== null);
  const browseAccess = useFilesystemReadAccess(isFolderStep ? environmentId : null);
  const typedPath = getFilesystemBrowsePath(query, platform, isFolderStep);
  const isPathQuery = typedPath.isBrowsing;
  const browseQuery = useEnvironmentQuery(
    environmentId !== null &&
      browseAccess.canReadFiles &&
      isPathQuery &&
      typedPath.directoryPath.length > 0
      ? filesystemEnvironment.browse({
          environmentId,
          input: { partialPath: typedPath.directoryPath },
        })
      : null,
  );
  const repositoryRoot = step === "folder" && !isPathQuery ? (folderRoots[0] ?? null) : null;
  const repositoryBrowse = useEnvironmentQuery(
    environmentId !== null && browseAccess.canReadFiles && repositoryRoot !== null
      ? filesystemEnvironment.browse({ environmentId, input: { partialPath: repositoryRoot } })
      : null,
  );
  const folder = resolveFolderQuery({
    query: isFolderStep ? query : "",
    platform,
    browse: browseQuery.data,
  });

  const close = () => closeNewThreadDialog();

  const goTo = (next: NewThreadDialogStep, nextQuery = "") => {
    setStep(next);
    setQuery(nextQuery);
    setCloneDestination(null);
    setHighlightedItemValue(null);
  };

  const chooseMachine = (id: EnvironmentId) => {
    setEnvironmentId(id);
    rememberNewThreadMachine(id);
    goTo("project");
  };

  const goBack = (): boolean => {
    if (step === "clone" && cloneDestination !== null) {
      setQuery(cloneDestination.repositoryInput);
      setCloneDestination(null);
      setHighlightedItemValue(null);
      return true;
    }
    if (step === "folder" || step === "clone" || step === "new-project") {
      goTo("project");
      return true;
    }
    if (step === "project" && machines.length > 1) {
      goTo("machine");
      return true;
    }
    return false;
  };

  // Every terminal action closes the dialog only once it has worked, so a
  // failure leaves the user where they were. Stable so the rows built during
  // render never read the busy ref themselves.
  const runExclusive = useStableCallback(async (action: () => Promise<boolean>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setIsBusy(true);
    const result = await settlePromise(action);
    busyRef.current = false;
    setIsBusy(false);
    if (result._tag === "Failure") {
      reportFailure("Could not start the thread", squashAtomCommandFailure(result));
      return;
    }
    if (result.value) close();
  });

  const startThreadIn = (projectEnvironmentId: EnvironmentId, projectId: ProjectId) =>
    runExclusive(async () => {
      rememberNewThreadMachine(projectEnvironmentId);
      await handleNewThread(scopeProjectRef(projectEnvironmentId, projectId));
      return true;
    });

  // A folder that is already a project opens a new thread there instead.
  const openFolderAsProject = async (
    targetEnvironmentId: EnvironmentId,
    path: string,
  ): Promise<boolean> => {
    const existing = findProjectByPath(
      projects.filter((project) => project.environmentId === targetEnvironmentId),
      path,
    );
    if (existing) {
      rememberNewThreadMachine(targetEnvironmentId);
      await handleNewThread(scopeProjectRef(existing.environmentId, existing.id));
      return true;
    }
    if (!readEnvironmentScope(targetEnvironmentId, AuthOrchestrationOperateScope)) {
      reportFailure("Cannot add project", new Error("This connection cannot add projects."));
      return false;
    }
    const projectId = newProjectId();
    const created = await createProject({
      environmentId: targetEnvironmentId,
      input: {
        projectId,
        title: inferProjectTitleFromPath(path),
        workspaceRoot: path,
        createWorkspaceRootIfMissing: false,
        defaultModelSelection: null,
      },
    });
    if (created._tag === "Failure") {
      if (!isAtomCommandInterrupted(created)) {
        reportFailure("Failed to add project", squashAtomCommandFailure(created));
      }
      return false;
    }
    rememberNewThreadMachine(targetEnvironmentId);
    await handleNewThread(scopeProjectRef(targetEnvironmentId, projectId));
    return true;
  };

  const addFolder = (targetEnvironmentId: EnvironmentId, path: string) =>
    runExclusive(() => openFolderAsProject(targetEnvironmentId, path));

  const clone = (remoteUrl: string, destinationPath: string) =>
    runExclusive(async () => {
      if (environmentId === null) return false;
      if (
        !readEnvironmentScope(environmentId, AuthSourceControlWriteScope) ||
        !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
      ) {
        reportFailure(
          "Clone unavailable",
          new Error("This connection needs permission to write source control and add projects."),
        );
        return false;
      }
      rememberNewThreadMachine(environmentId);
      const projectId = newProjectId();
      const started = await startProjectClone({
        environmentId,
        input: {
          projectId,
          title: inferProjectTitleFromPath(destinationPath),
          createdAt: new Date().toISOString(),
          remoteUrl,
          destinationPath,
        },
      });
      if (started._tag === "Failure") {
        if (!isAtomCommandInterrupted(started)) {
          reportFailure("Clone failed", squashAtomCommandFailure(started));
        }
        return false;
      }
      // The clone keeps running on the machine and reports its progress and
      // any failure in the thread, so the dialog closes now rather than after
      // the project arrives.
      close();
      const projectRef = scopeProjectRef(environmentId, projectId);
      await waitForProject(projectRef, 3_000).catch(() => null);
      await handleNewThread(projectRef);
      return true;
    });

  const pickNativeFolder = async () => {
    if (environmentId === null || busyRef.current) return;
    // The OS dialog needs an absolute path, which `~` is not.
    const picked = await folderPicker.pick({
      environmentId,
      platform,
      initialPath:
        browseQuery.data?.parentPath ?? folderRoots.find((root) => !root.startsWith("~")),
    });
    if (picked) await addFolder(picked.environmentId, picked.path);
  };

  const descendInto = (name: string) => {
    setQuery(appendBrowsePathSegment(query, name));
    setHighlightedItemValue(null);
  };

  const cloneTargetPath =
    cloneDestination === null
      ? null
      : getCloneDestinationPath(ensureBrowseDirectoryPath(query), cloneDestination.directoryName);

  // Enter on a typed path that names a folder: add it, or clone into it.
  const submitTypedPath = () => {
    if (environmentId === null) return;
    if (step === "folder" && folder.target) void addFolder(environmentId, folder.target.path);
    if (step === "clone" && cloneDestination && cloneTargetPath && query.trim().length > 0) {
      void clone(cloneDestination.remoteUrl, cloneTargetPath);
    }
  };

  const handleQueryChange = (nextQuery: string) => {
    setHighlightedItemValue(null);
    // A path or clone URL typed into the project list skips its menu row.
    if (step === "project") {
      if (getFilesystemBrowsePath(nextQuery, platform).isBrowsing) {
        setStep("folder");
      } else if (/^(?:[a-z][a-z0-9+.-]*:\/\/|[^/\\:\s]+@[^/\\:\s]+:)/i.test(nextQuery.trim())) {
        setStep("clone");
      }
    }
    setQuery(nextQuery);
  };

  // Typed paths and clone URLs are input, not a filter over the rows.
  const filtersRows =
    step === "machine" || step === "project" || (step === "folder" && !isPathQuery);
  const visibleGroups = filterCommandPaletteGroups({
    activeGroups: buildGroups().filter((group) => group.items.length > 0),
    query: filtersRows ? query : "",
    isInSubmenu: true,
    projectSearchItems: [],
    threadSearchItems: [],
  }).filter((group) => group.items.length > 0);

  function buildGroups(): CommandPaletteGroup[] {
    switch (step) {
      case "machine":
        return [
          {
            value: "machines",
            label: "Machines",
            items: machines.map((machine) => ({
              kind: "action",
              value: `machine:${machine.environmentId}`,
              searchTerms: [machine.label, machine.isPrimary ? "this device" : ""],
              title: machine.label,
              description: machine.isConnected
                ? machine.isPrimary
                  ? "This device"
                  : undefined
                : machine.status,
              disabled: !machine.isConnected,
              icon: <EnvironmentMachineIcon kind={machine.machine} className={ITEM_ICON_CLASS} />,
              ...(machine.environmentId === environmentId
                ? { titleTrailingContent: <CheckIcon className="ms-auto size-4 shrink-0" /> }
                : {}),
              keepOpen: true,
              run: async () => chooseMachine(machine.environmentId),
            })),
          },
        ];
      case "project":
        return projectStepGroups();
      case "folder":
        return folderStepGroups();
      case "clone":
        return cloneStepGroups();
      case "new-project": {
        const name = query.trim();
        return [
          {
            value: "new-project",
            label: "",
            items:
              name.length === 0 || environmentId === null
                ? []
                : [
                    {
                      kind: "action",
                      value: "new-project:create",
                      searchTerms: [],
                      title: `Create ${name}`,
                      description: `New Git repository in ${newProjectsRoot} on ${machineLabel}`,
                      icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
                      run: () =>
                        runExclusive(() =>
                          createNewProject({ environmentId, name, publishTo: null }),
                        ),
                    },
                  ],
          },
        ];
      }
    }
  }

  function projectStepGroups(): CommandPaletteGroup[] {
    if (environmentId === null) return [];
    const projectItems: DialogItem[] = machineProjects({
      groups: pickableProjectGroups(projectGroups),
      environmentId,
      currentProjectRef: contextualProjectRef,
      isHidden: (project) =>
        isScratchProject(project, scratchWorkspaceRootFor(project.environmentId)),
    }).map(({ project, displayName }) => ({
      kind: "action",
      value: `project:${project.id}`,
      searchTerms: [displayName, project.title, project.workspaceRoot],
      title: displayName,
      description: project.workspaceRoot,
      icon: <ProjectFavicon project={project} className={ITEM_ICON_CLASS} />,
      run: () => startThreadIn(project.environmentId, project.id),
    }));
    const scratchTarget = scratchEnvironmentId(environmentId);
    if (scratchTarget !== null) {
      projectItems.push({
        kind: "action",
        value: "project:none",
        searchTerms: ["no project", "without project", "none"],
        title: "No project",
        icon: <MessageSquareDashedIcon className={ITEM_ICON_CLASS} />,
        run: () =>
          runExclusive(async () => {
            const project = await openScratchProject(scratchTarget);
            if (project === null) return false;
            await handleNewThread(scopeProjectRef(project.environmentId, project.id));
            return true;
          }),
      });
    }
    const addItems: DialogItem[] = [
      {
        kind: "action",
        value: "add:folder",
        searchTerms: ["open folder", "add project", "local", "directory", "browse", "existing"],
        title: "Open folder…",
        description: `A folder on ${machineLabel}`,
        icon: <FolderOpenIcon className={ITEM_ICON_CLASS} />,
        titleTrailingContent: CHEVRON,
        keepOpen: true,
        run: async () => goTo("folder"),
      },
      {
        kind: "action",
        value: "add:clone",
        searchTerms: ["clone repository", "git", "url", "github", "remote", "ssh", "https"],
        title: "Clone repository…",
        description: "owner/repo, an HTTPS or an SSH URL",
        icon: <FolderGit2Icon className={ITEM_ICON_CLASS} />,
        titleTrailingContent: CHEVRON,
        keepOpen: true,
        run: async () => goTo("clone"),
      },
    ];
    if (newProjectsRoot !== null) {
      addItems.push({
        kind: "action",
        value: "add:new",
        searchTerms: ["new project", "create", "empty", "git init"],
        title: "New project…",
        description: `A new Git repository in ${newProjectsRoot}`,
        icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
        titleTrailingContent: CHEVRON,
        keepOpen: true,
        run: async () => goTo("new-project"),
      });
    }
    const projectsGroup = {
      value: "projects",
      label: machines.length > 1 ? `Projects on ${machineLabel}` : "Projects",
      items: projectItems,
    };
    const addGroup = { value: "add", label: "Add a project", items: addItems };
    const machineGroup = {
      value: "machine",
      label: "",
      items:
        machines.length > 1
          ? [
              {
                kind: "action" as const,
                value: "machine:switch",
                searchTerms: ["switch machine", "environment", "remote", "server"],
                title: "Switch machine",
                description: machineLabel,
                icon: (
                  <EnvironmentMachineIcon
                    kind={currentMachine?.machine ?? "server"}
                    className={ITEM_ICON_CLASS}
                  />
                ),
                titleTrailingContent: CHEVRON,
                keepOpen: true,
                run: async () => goTo("machine"),
              },
            ]
          : [],
    };
    return request.intent === "add-project"
      ? [addGroup, projectsGroup, machineGroup]
      : [projectsGroup, addGroup, machineGroup];
  }

  function folderStepGroups(): CommandPaletteGroup[] {
    if (environmentId === null) return [];
    if (isPathQuery) {
      return [
        {
          value: "folders",
          label: "Folders",
          items: folder.entries.map((entry) => ({
            kind: "action",
            value: `folder:${entry.fullPath}`,
            searchTerms: [],
            title: entry.name,
            ...(entry.isGitRepo ? { description: "Git repository" } : {}),
            icon: entry.isGitRepo ? (
              <FolderGit2Icon className={ITEM_ICON_CLASS} />
            ) : (
              <FolderIcon className={ITEM_ICON_CLASS} />
            ),
            keepOpen: true,
            run: async () => {
              if (entry.isGitRepo) await addFolder(environmentId, entry.fullPath);
              else descendInto(entry.name);
            },
          })),
        },
      ];
    }
    return [
      {
        value: "places",
        label: "Places",
        items: folderRoots.map((root) => ({
          kind: "action",
          value: `place:${root}`,
          searchTerms: [root],
          title: root,
          icon: <FolderIcon className={ITEM_ICON_CLASS} />,
          titleTrailingContent: CHEVRON,
          keepOpen: true,
          run: async () => {
            setQuery(root);
            setHighlightedItemValue(null);
          },
        })),
      },
      {
        value: "repositories",
        label: repositoryRoot === null ? "Repositories" : `Repositories in ${repositoryRoot}`,
        items: newRepositoriesIn(repositoryBrowse.data, machineProjectRoots).map((entry) => ({
          kind: "action",
          value: `repository:${entry.fullPath}`,
          searchTerms: [entry.name, entry.fullPath],
          title: entry.name,
          description: entry.fullPath,
          icon: <FolderGit2Icon className={ITEM_ICON_CLASS} />,
          run: () => addFolder(environmentId, entry.fullPath),
        })),
      },
    ];
  }

  function cloneStepGroups(): CommandPaletteGroup[] {
    if (environmentId === null) return [];
    if (cloneDestination !== null) {
      return [
        {
          value: "folders",
          label: "Folders",
          items: folder.entries.map((entry) => ({
            kind: "action",
            value: `folder:${entry.fullPath}`,
            searchTerms: [],
            title: entry.name,
            icon: <FolderIcon className={ITEM_ICON_CLASS} />,
            keepOpen: true,
            run: async () => descendInto(entry.name),
          })),
        },
      ];
    }
    const parsed = parseCloneRepository(query);
    if (parsed === null) return [];
    const destinationPath = getCloneDestinationPath(cloneParent, parsed.directoryName);
    return [
      {
        value: "clone",
        label: "",
        items: [
          {
            kind: "action",
            value: "clone:start",
            searchTerms: [],
            title: `Clone ${query.trim()}`,
            description: `Into ${destinationPath} on ${machineLabel}`,
            icon: <FolderGit2Icon className={ITEM_ICON_CLASS} />,
            run: () => clone(parsed.remoteUrl, destinationPath),
          },
          {
            kind: "action",
            value: "clone:elsewhere",
            searchTerms: [],
            title: "Clone into another folder…",
            icon: <FolderIcon className={ITEM_ICON_CLASS} />,
            titleTrailingContent: CHEVRON,
            keepOpen: true,
            run: async () => {
              setCloneDestination({ ...parsed, repositoryInput: query });
              setQuery(cloneParent);
              setHighlightedItemValue(null);
            },
          },
        ],
      },
    ];
  }

  const browseStatus = (() => {
    if (!isFolderStep || !isPathQuery) return null;
    if (browseAccess.error) return browseAccess.error;
    if (browseQuery.error) return browseQuery.error;
    if (browseQuery.isPending && browseQuery.data === null) return "Loading folders…";
    if (step === "clone" && cloneTargetPath !== null) return `Enter clones into ${cloneTargetPath}`;
    if (folder.target) {
      return `Enter adds ${folder.target.path}${folder.target.isGitRepo ? " (Git repository)" : ""}`;
    }
    if (folder.browsePath.filterQuery.length > 0 && !browseQuery.isPending) {
      return `No folder named “${folder.browsePath.filterQuery}” here`;
    }
    return null;
  })();

  const placeholder = (() => {
    switch (step) {
      case "machine":
        return "Choose a machine…";
      case "project":
        return `Search projects on ${machineLabel}, or type a path or clone URL…`;
      case "folder":
        return `Type a folder path on ${machineLabel}, e.g. ~/code/app`;
      case "clone":
        return cloneDestination === null
          ? "owner/repo, https://… or git@…"
          : `Folder to clone ${cloneDestination.directoryName} into`;
      case "new-project":
        return "Name the new project";
    }
  })();

  const emptyStateMessage = (() => {
    switch (step) {
      case "machine":
        return "No machine is connected. Add one in Settings → Connections.";
      case "project":
        return "No matching projects.";
      case "folder":
        return isPathQuery ? "No folders here." : "No matching folders.";
      case "clone":
        return cloneDestination === null
          ? "Paste owner/repo, an HTTPS or an SSH clone URL."
          : "No folders here.";
      case "new-project":
        return "Type a name and press Enter.";
    }
  })();

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Backspace" && query === "" && goBack()) {
      event.preventDefault();
      return;
    }
    if (!isFolderStep || !isPathQuery) return;
    const preventBaseUI = () => {
      (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
      event.preventDefault();
    };
    if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      const entry =
        folder.entries.find(
          (candidate) => `folder:${candidate.fullPath}` === highlightedItemValue,
        ) ?? folder.entries[0];
      preventBaseUI();
      if (entry) descendInto(entry.name);
      return;
    }
    if (event.key === "Enter" && highlightedItemValue === null) {
      preventBaseUI();
      submitTypedPath();
    }
  };

  const footerActionLabel = (() => {
    if (!isFolderStep || !isPathQuery || highlightedItemValue !== null) return "Select";
    if (step === "clone") return "Clone";
    return folder.target ? "Add" : undefined;
  })();

  return (
    <CommandDialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <CommandDialogPopup
        aria-label="New thread"
        className="overflow-hidden"
        // Global shortcuts pause while this is open, as they do for the palette.
        data-command-palette="true"
        data-testid="new-thread-dialog"
        onBackdropPointerDown={close}
      >
        <CommandPaletteContent
          key={`${step}-${cloneDestination === null ? "" : "destination"}-${isPathQuery}`}
          aria-label="New thread"
          autoHighlight={isFolderStep && isPathQuery ? false : "always"}
          escapeLabel="Close"
          footerActionLabel={footerActionLabel}
          footerTrailing={
            step === "folder" && folderPicker.canPick(environmentId) ? (
              <CommandFooterAction disabled={isBusy} onClick={() => void pickNativeFolder()}>
                Browse…
              </CommandFooterAction>
            ) : null
          }
          inputProps={{
            placeholder,
            ...(step === "machine" || (step === "project" && machines.length <= 1)
              ? {}
              : {
                  startAddon: (
                    <button
                      type="button"
                      className="flex cursor-pointer items-center"
                      aria-label="Back"
                      onClick={() => goBack()}
                    >
                      <ArrowLeftIcon className={ADDON_ICON_CLASS} />
                    </button>
                  ),
                }),
            onKeyDown: handleKeyDown,
          }}
          mode="none"
          onItemHighlighted={(value, eventDetails) => {
            // While a path is typed only the keyboard or pointer highlights a
            // row, so Enter keeps meaning "this path".
            if (eventDetails.reason === "none" && isFolderStep && isPathQuery) return;
            setHighlightedItemValue(typeof value === "string" ? value : null);
          }}
          onValueChange={handleQueryChange}
          showBackHint={step !== "machine" && !(step === "project" && machines.length <= 1)}
          value={query}
        >
          {browseStatus ? (
            <div role="status" className="px-4 pt-2 text-muted-foreground text-xs">
              {browseStatus}
            </div>
          ) : null}
          <CommandPaletteResults
            groups={visibleGroups}
            highlightedItemValue={highlightedItemValue}
            isActionsOnly={false}
            keybindings={keybindings}
            onExecuteItem={(item) => {
              if (item.kind !== "action" || item.disabled) return;
              void item
                .run()
                .catch((error: unknown) => reportFailure("Something went wrong", error));
            }}
            emptyStateMessage={emptyStateMessage}
          />
        </CommandPaletteContent>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
