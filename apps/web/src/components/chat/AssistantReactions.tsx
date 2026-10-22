import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type OrchestrationV2MessageReactionEmoji,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { PlayIcon, ThumbsUpIcon } from "lucide-react";
import { useState } from "react";

import { newMessageId } from "~/lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useServerConfigs } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  goAheadText,
  latestReplyItemId,
  reactableReply,
  thumbsUpAction,
  type ReactableReply,
} from "./AssistantReactions.logic";

const GO_AHEAD_LABEL = "👍 Go ahead: starts a turn";

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    ...(error instanceof Error ? { description: error.message } : {}),
  });
}

/** Reactions on the replies of threads in `environmentId`, and "Go ahead". */
export function useReplyReactions(environmentId: EnvironmentId | null) {
  const serverConfigs = useServerConfigs();
  const supported =
    environmentId !== null &&
    serverConfigs.get(environmentId)?.environment.capabilities.messageReactions === true;
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const setReaction = useOrchestrationCommand(threadEnvironment.setMessageReaction, {
    reportFailure: false,
  });
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });

  const react = async (
    reply: ReactableReply,
    emoji: OrchestrationV2MessageReactionEmoji,
    reacted: boolean,
  ) => {
    if (environmentId === null) return;
    const result = await setReaction({
      environmentId,
      input: { threadId: reply.threadId, itemId: reply.itemId, emoji, reacted },
    });
    reportFailure(reacted ? `Could not react ${emoji}` : `Could not remove ${emoji}`, result);
  };

  // Sends through the queue like any message, so it starts a turn now or after the running one.
  const goAhead = async (reply: ReactableReply, timestampFormat: TimestampFormat) => {
    if (environmentId === null) return;
    const thread = appAtomRegistry.get(
      environmentThreadDetails.threadAtom(scopeThreadRef(environmentId, reply.threadId)),
    )?.projection;
    if (thread === undefined) return;
    reportFailure(
      "Could not react 👍",
      await setReaction({
        environmentId,
        input: {
          threadId: reply.threadId,
          itemId: reply.itemId,
          emoji: "👍",
          reacted: true,
          goAhead: true,
        },
      }),
    );
    const text = goAheadText({
      latest: latestReplyItemId(thread.turnItems, reply.threadId) === reply.itemId,
      repliedAt: reply.repliedAt,
      timestampFormat,
    });
    reportFailure(
      "Could not send Go ahead",
      await startTurn({
        environmentId,
        input: {
          threadId: reply.threadId,
          message: { messageId: newMessageId(), role: "user", text, attachments: [] },
          runtimeMode: thread.thread.runtimeMode,
          interactionMode: thread.thread.interactionMode,
          dispatchMode: "queue",
        },
      }),
    );
  };

  return { available: supported && canOperate, react, goAhead };
}

/** 👍 and Go ahead with the reply's footer actions, revealed on hover like them. */
export function AssistantReactionActions(props: {
  readonly environmentId: EnvironmentId;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem | undefined;
  readonly reactions: ReadonlyArray<OrchestrationV2MessageReactionEmoji> | undefined;
  readonly timestampFormat: TimestampFormat;
}) {
  const { available, react, goAhead } = useReplyReactions(props.environmentId);
  const [busy, setBusy] = useState(false);
  const reply = reactableReply(props.projectedItem);
  if (!available || reply === null) return null;
  const thumbsUp = thumbsUpAction(props.reactions);
  const run = (action: () => Promise<void>) => {
    setBusy(true);
    void action().finally(() => setBusy(false));
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={busy}
              aria-pressed={thumbsUp.reacted}
              aria-label={thumbsUp.label}
              onClick={() => run(() => react(reply, "👍", !thumbsUp.reacted))}
            />
          }
        >
          <ThumbsUpIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup side="top">{thumbsUp.label}</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={busy}
              aria-label={GO_AHEAD_LABEL}
              onClick={() => run(() => goAhead(reply, props.timestampFormat))}
            />
          }
        >
          <PlayIcon className="size-3 fill-current text-success" />
        </TooltipTrigger>
        <TooltipPopup side="top">{GO_AHEAD_LABEL}</TooltipPopup>
      </Tooltip>
    </>
  );
}

/** The reply's reactions as chips, visible without hover. Clicking one removes it. */
export function AssistantReactionChips(props: {
  readonly environmentId: EnvironmentId;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem | undefined;
  readonly reactions: ReadonlyArray<OrchestrationV2MessageReactionEmoji> | undefined;
}) {
  if (props.reactions === undefined || props.reactions.length === 0) return null;
  return <ReactionChips {...props} reactions={props.reactions} />;
}

function ReactionChips(props: {
  readonly environmentId: EnvironmentId;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem | undefined;
  readonly reactions: ReadonlyArray<OrchestrationV2MessageReactionEmoji>;
}) {
  const { available, react } = useReplyReactions(props.environmentId);
  const reply = reactableReply(props.projectedItem);
  const removable = available && reply !== null;

  return props.reactions.map((emoji) => (
    <Tooltip key={emoji}>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="micro"
            variant="outline"
            disabled={!removable}
            aria-label={`Remove ${emoji}`}
            onClick={() => {
              if (reply !== null) void react(reply, emoji, false);
            }}
          />
        }
      >
        {emoji}
      </TooltipTrigger>
      <TooltipPopup side="top">
        {removable ? `Remove ${emoji}` : `You reacted ${emoji}`}
      </TooltipPopup>
    </Tooltip>
  ));
}
