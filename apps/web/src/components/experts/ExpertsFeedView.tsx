import { useAtomValue } from "@effect/atom-react";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { resolveComposerDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";
import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  agentMessageSenderLabel,
  resolveUserMessagePresentation,
} from "@t3tools/client-runtime/user-message";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type OrchestrationV2ThreadTailMessage,
  type ThreadId,
} from "@t3tools/contracts";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { Link } from "@tanstack/react-router";
import {
  CalendarClockIcon,
  ChevronDownIcon,
  MessagesSquareIcon,
  ReplyIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, useRef, useState, type ReactNode } from "react";

import { composerSubmissionIntentForKey } from "../../composer-logic";
import { isElectron } from "../../env";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useClientSettings, useEnvironmentSettings } from "../../hooks/useSettings";
import { useSoftwareKeyboardOpen } from "../../hooks/useSoftwareKeyboardOpen";
import { cn, newMessageId } from "../../lib/utils";
import { observeResize } from "../../lib/observeResize";
import {
  useDelegatedUnderParent,
  useProject,
  useQuietThreadShell,
  useServerConfigs,
  useThreadShells,
} from "../../state/entities";
import { useEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { useExpertTails } from "../../state/expertsFeed";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";
import { useUiStateStore } from "../../uiStateStore";
import ChatMarkdown from "../ChatMarkdown";
import { resolveThreadLastVisitedAt, resolveThreadStatusPill } from "../Sidebar.logic";
import { ThreadStatusLabel } from "../ThreadStatusIndicators";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { expertKey, mergeExpertTails, selectFeedExperts } from "./ExpertsFeed.logic";

// Leaving the bottom by less than this still follows new replies.
const STICK_TO_BOTTOM_PX = 48;

export function ExpertsFeedView() {
  const threads = useThreadShells();
  const delegatedUnderParent = useDelegatedUnderParent();
  const serverConfigs = useServerConfigs();
  // A snoozed expert comes back within the minute it wakes.
  useNowMinute();
  const experts = selectFeedExperts({ threads, delegatedUnderParent, serverConfigs });
  const tails = useExpertTails(experts.map(expertKey));
  const entries = mergeExpertTails(
    experts.flatMap((expert, index) => {
      const tail = tails[index];
      return tail?.status === "ready" ? [{ expert, messages: tail.messages }] : [];
    }),
  );
  const loading = tails.some((tail) => tail.status === "loading");
  const unreadable = experts.filter((_, index) => tails[index]?.status === "failed");
  const [replyingKey, setReplyingKey] = useState<string | null>(null);

  const stickRef = useRef(true);
  const listRef = (list: HTMLOListElement | null) => {
    const scroller = list?.parentElement;
    if (!list || !scroller) return;
    const follow = () => {
      if (stickRef.current) scroller.scrollTop = scroller.scrollHeight;
    };
    follow();
    return observeResize(list, follow);
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader electron={isElectron}>
        <WorkspaceBreadcrumb ariaLabel="Experts feed">
          <WorkspaceBreadcrumbItem current>
            <h1 className="truncate">Experts</h1>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
      </WorkspacePageHeader>
      {experts.length === 0 ? (
        <Empty className="flex-1">
          <EmptyHeader className="max-w-md">
            <EmptyTitle>No experts yet</EmptyTitle>
            <EmptyDescription>
              Pin a thread to make it an expert. Its replies show up here, with the other experts'.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div
          className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both"
          data-testid="experts-feed"
          onScroll={(event) => {
            const scroller = event.currentTarget;
            stickRef.current =
              scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <
              STICK_TO_BOTTOM_PX;
          }}
        >
          <ol ref={listRef} className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
            {unreadable.length > 0 ? (
              <li className="text-xs text-muted-foreground">
                Replies of {unreadable.map((expert) => expert.title).join(", ")} could not be
                loaded.
              </li>
            ) : null}
            {entries.length === 0 && loading ? (
              <li className="flex justify-center py-8">
                <Spinner />
              </li>
            ) : null}
            {entries.map((entry) => (
              <FeedEntry
                key={entry.key}
                entryKey={entry.key}
                environmentId={entry.expert.environmentId}
                threadId={entry.expert.id}
                message={entry.message}
                latest={entry.latest}
                replying={replyingKey === entry.key}
                onReplyingChange={setReplyingKey}
              />
            ))}
          </ol>
        </div>
      )}
    </SidebarInset>
  );
}

const FeedEntry = memo(function FeedEntry(props: {
  readonly entryKey: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly message: OrchestrationV2ThreadTailMessage;
  readonly latest: boolean;
  readonly replying: boolean;
  readonly onReplyingChange: (entryKey: string | null) => void;
}) {
  const { environmentId, threadId, message } = props;
  // The quiet shell keeps rows still while their expert streams.
  const expert = useQuietThreadShell({ environmentId, threadId });
  const environment = useEnvironment(environmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const canReply = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const localLastVisitedAt = useUiStateStore(
    (state) =>
      state.threadLastVisitedAtById[scopedThreadKey(scopeThreadRef(environmentId, threadId))],
  );
  if (expert === null) return null;
  const status = props.latest
    ? resolveThreadStatusPill({
        thread: {
          ...expert,
          lastVisitedAt: resolveThreadLastVisitedAt(expert.lastVisitedAt, localLastVisitedAt),
        },
      })
    : null;
  const machine = environmentId === primaryEnvironmentId ? null : (environment?.label ?? null);
  const threadLink = {
    to: "/$environmentId/$threadId",
    params: { environmentId, threadId },
  } as const;

  return (
    <li className="flex min-w-0 flex-col gap-1.5" data-testid="experts-feed-entry">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <Link
          {...threadLink}
          className="min-w-0 truncate font-medium text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          {expert.title}
        </Link>
        {machine ? <span className="shrink-0 text-muted-foreground">{machine}</span> : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <time dateTime={message.createdAt} className="shrink-0 text-muted-foreground" />
            }
          >
            {formatDayAwareTimestamp(message.createdAt, timestampFormat)}
          </TooltipTrigger>
          <TooltipPopup side="top">
            {formatChatTimestampTooltip(message.createdAt, timestampFormat)}
          </TooltipPopup>
        </Tooltip>
        {status ? <ThreadStatusLabel status={status} /> : null}
        <div className="min-w-0 flex-1" />
        {canReply && !props.replying ? (
          <Button
            size="xs"
            variant="ghost-muted"
            onClick={() => props.onReplyingChange(props.entryKey)}
          >
            <ReplyIcon />
            Reply
          </Button>
        ) : null}
      </div>
      <FeedMessageBody expert={expert} message={message} />
      {message.textTruncated ? (
        <Link
          {...threadLink}
          className="self-start text-xs text-muted-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          Read the rest in the thread
        </Link>
      ) : null}
      {props.replying ? (
        <ReplyComposer expert={expert} onClose={() => props.onReplyingChange(null)} />
      ) : null}
    </li>
  );
});

function FeedMessageBody(props: {
  readonly expert: EnvironmentThreadShell;
  readonly message: OrchestrationV2ThreadTailMessage;
}) {
  const { expert, message } = props;
  const project = useProject(scopeProjectRef(expert.environmentId, expert.projectId));
  const presentation = resolveUserMessagePresentation({
    id: message.messageId,
    role: message.role,
    text: message.text,
    ...(message.createdBy === undefined ? {} : { createdBy: message.createdBy }),
    ...(message.creationSource === undefined ? {} : { creationSource: message.creationSource }),
    ...(message.scheduledTaskId === undefined ? {} : { scheduledTaskId: message.scheduledTaskId }),
  });
  if (message.role === "assistant") {
    return (
      <Clamped>
        <ChatMarkdown
          text={message.text}
          cwd={expert.worktreePath ?? project?.workspaceRoot}
          threadRef={scopeThreadRef(expert.environmentId, expert.id)}
          environmentId={expert.environmentId}
          isStreaming={message.streaming}
        />
      </Clamped>
    );
  }
  const text = replaceComposerContextReferences(presentation.text, (reference) => reference.label);
  if (presentation.attribution === null) {
    return (
      <div className="rounded-2xl bg-message px-3 py-2 text-sm text-message-foreground">
        <Clamped>
          <p className="whitespace-pre-wrap wrap-break-word">
            <span className="text-muted-foreground">You: </span>
            {text}
          </p>
        </Clamped>
      </div>
    );
  }
  return presentation.attribution === "agent" ? (
    <AgentMessage expert={expert} message={message} text={text} />
  ) : (
    <FoldedMessage
      icon={presentation.attribution === "automation" ? CalendarClockIcon : MessagesSquareIcon}
      label={presentation.attribution === "automation" ? "Automation" : "T3 Code"}
      text={text}
    />
  );
}

function AgentMessage(props: {
  readonly expert: EnvironmentThreadShell;
  readonly message: OrchestrationV2ThreadTailMessage;
  readonly text: string;
}) {
  const { senderThreadId, sentFrom } = props.message;
  const senderEnvironment = useEnvironment(sentFrom?.environmentId ?? null);
  // A sender on a linked machine is known by name only unless this client is connected there.
  const sender = useQuietThreadShell(
    senderThreadId !== undefined
      ? { environmentId: props.expert.environmentId, threadId: senderThreadId }
      : sentFrom && senderEnvironment
        ? { environmentId: sentFrom.environmentId, threadId: sentFrom.threadId }
        : null,
  );
  return (
    <FoldedMessage
      icon={MessagesSquareIcon}
      label={agentMessageSenderLabel({
        senderTitle: sender?.title,
        sentFrom,
        environmentLabel: senderEnvironment?.label,
      })}
      text={props.text}
    />
  );
}

/** A message another agent or an automation sent: one line naming the sender until opened. */
function FoldedMessage(props: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly text: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const Icon = props.icon;
  const summary =
    props.text
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "";
  return (
    <div className="min-w-0 rounded-2xl bg-message text-sm text-message-foreground">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full min-w-0 items-center gap-1.5 px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-ring"
      >
        <Icon className="size-4 shrink-0 stroke-2 text-muted-foreground" />
        <span className="max-w-1/2 shrink-0 truncate text-muted-foreground">{props.label}</span>
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>
      {expanded ? (
        <p className="max-h-96 overflow-auto px-3 pb-3 whitespace-pre-wrap wrap-break-word">
          {props.text}
        </p>
      ) : null}
    </div>
  );
}

/** Long text shows its start until "Show more". */
function Clamped(props: { readonly children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const measureRef = (element: HTMLDivElement | null) => {
    // Measured only while clamped; expanding keeps the last answer so "Show less" stays.
    if (!element || expanded) return;
    return observeResize(element, () => {
      setOverflows(element.scrollHeight > element.clientHeight + 1);
    });
  };
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <div
        ref={measureRef}
        className={cn("w-full min-w-0", !expanded && "max-h-72 overflow-hidden")}
      >
        {props.children}
      </div>
      {overflows ? (
        <Button
          size="xs"
          variant="ghost-muted"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show more"}
        </Button>
      ) : null}
    </div>
  );
}

function reportFailure(title: string, result: Parameters<typeof isAtomCommandInterrupted>[0]) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    ...(error instanceof Error ? { description: error.message } : {}),
  });
}

/** Sends into the expert's own thread, as typing there would: same modes, same steer or queue. */
function ReplyComposer(props: {
  readonly expert: EnvironmentThreadShell;
  readonly onClose: () => void;
}) {
  const { expert } = props;
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const followUpBehavior = useEnvironmentSettings(
    expert.environmentId,
    (settings) => settings.followUpBehavior,
  );
  const sendShortcut = useClientSettings((settings) => settings.sendShortcut);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const isSoftwareKeyboardOpen = useSoftwareKeyboardOpen();
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const running = threadRuntimeIsActive(expert.runtime);
  const message = text.trim();

  const send = async (alternate: boolean) => {
    if (message.length === 0 || sending) return;
    setSending(true);
    const result = await startTurn({
      environmentId: expert.environmentId,
      input: {
        threadId: expert.id,
        message: { messageId: newMessageId(), role: "user", text: message, attachments: [] },
        runtimeMode: expert.runtimeMode,
        interactionMode: expert.interactionMode,
        dispatchMode: resolveComposerDispatchMode({
          running,
          alternateModifier: alternate,
          activeTurnDefault: followUpBehavior,
        }),
      },
    });
    setSending(false);
    if (result._tag === "Failure") {
      reportFailure(`Could not send to ${expert.title}`, result);
      return;
    }
    props.onClose();
  };

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        autoFocus
        value={text}
        disabled={sending}
        aria-label={`Reply to ${expert.title}`}
        placeholder={`Reply to ${expert.title}`}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            props.onClose();
            return;
          }
          const intent = composerSubmissionIntentForKey({
            event: event.nativeEvent,
            keybindings,
            isSoftwareKeyboardOpen,
            isDraftThread: false,
            isRunning: running,
            sendShortcut,
            prompt: text,
          });
          if (intent !== "foreground" && intent !== "alternate") return;
          event.preventDefault();
          void send(intent === "alternate");
        }}
      />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={props.onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={message.length === 0 || sending}
          onClick={() => void send(false)}
        >
          {running ? (followUpBehavior === "queue" ? "Queue" : "Steer") : "Send"}
        </Button>
      </div>
    </div>
  );
}
