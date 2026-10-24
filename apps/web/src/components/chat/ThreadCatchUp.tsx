import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  closeThreadCatchUp,
  isThreadCatchUpStale,
  requestThreadCatchUp,
  requestThreadCatchUpAction,
  subscribeThreadCatchUpAction,
  threadCatchUpAtom,
  threadCatchUpBasis,
} from "@t3tools/client-runtime/state/thread-catch-up";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { CornerLeftUpIcon, NewspaperIcon, XIcon } from "lucide-react";
import { memo, useContext, useEffect, useEffectEvent } from "react";

import { useQuietThreadShell } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Older servers cannot write briefs, and a read-only session may not run a model there. */
export function useThreadCatchUpAvailable(environmentId: EnvironmentId | null): boolean {
  const supported = useEnvironment(environmentId)?.serverConfig?.threadCatchUp === true;
  const permitted = useAtomValue(
    orchestrationEnvironment.catchUpThread.permissionAtom(environmentId),
  );
  return supported && permitted;
}

export function ThreadCatchUpControls(props: { readonly threadRef: ScopedThreadRef }) {
  const catchUpAvailable = useThreadCatchUpAvailable(props.threadRef.environmentId);
  const threadKey = scopedThreadKey(props.threadRef);
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Jump to my last message"
              onClick={() => requestThreadCatchUpAction("jump-to-my-last-message", threadKey)}
            />
          }
        >
          <CornerLeftUpIcon />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Jump to my last message</TooltipPopup>
      </Tooltip>
      {catchUpAvailable ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Catch me up"
                onClick={() => requestThreadCatchUpAction("catch-up", threadKey)}
              />
            }
          >
            <NewspaperIcon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Catch me up</TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}

/** The brief, at the top of the thread. It only appears after the user asks for it. */
export const ThreadCatchUpCard = memo(function ThreadCatchUpCard(props: {
  readonly threadRef: ScopedThreadRef;
}) {
  const { threadRef } = props;
  const registry = useContext(RegistryContext);
  const threadKey = scopedThreadKey(threadRef);
  const state = useAtomValue(threadCatchUpAtom(threadKey));
  const available = useThreadCatchUpAvailable(threadRef.environmentId);
  const shell = useQuietThreadShell(threadRef);
  const basis = shell === null ? null : threadCatchUpBasis(shell);
  const catchUp = useAtomCommand(orchestrationEnvironment.catchUpThread, {
    reportFailure: false,
  });
  const request = useEffectEvent(() => {
    if (!available || basis === null) return;
    void requestThreadCatchUp({
      registry,
      threadKey,
      basis,
      generate: async () => {
        const result = await catchUp({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        });
        if (result._tag === "Success") return { ok: true, brief: result.value };
        const error = squashAtomCommandFailure(result);
        return {
          ok: false,
          message: error instanceof Error ? error.message : "Could not write a brief.",
        };
      },
    });
  });
  useEffect(
    () => subscribeThreadCatchUpAction("catch-up", threadKey, () => request()),
    [threadKey],
  );

  if (!state.open) return null;
  const { brief } = state;
  const stale = basis !== null && isThreadCatchUpStale(state, basis);
  return (
    <div className="pointer-events-auto mx-auto w-full max-w-[min(48rem,calc(100%-2rem))] pt-3">
      <Alert
        variant="info"
        surface="glass"
        controlAlignment="first-line"
        role="region"
        aria-label="Catch me up"
      >
        <NewspaperIcon />
        <AlertTitle>Catch me up</AlertTitle>
        <AlertDescription>
          {brief === null ? (
            state.loading ? (
              <p className="flex items-center gap-2">
                <Spinner size="sm" />
                Writing a brief…
              </p>
            ) : null
          ) : (
            <dl className="flex flex-col gap-1.5 text-foreground">
              <div>
                <dt className="text-muted-foreground text-xs">Needs you</dt>
                <dd>{brief.needsYou ?? "Nothing needs you right now."}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs">What happened</dt>
                <dd>
                  {brief.happened.length === 0 ? (
                    "Nothing new."
                  ) : (
                    <ul className="list-disc ps-4">
                      {brief.happened.map((line, index) => (
                        <li key={index}>{line}</li>
                      ))}
                    </ul>
                  )}
                </dd>
              </div>
              {brief.next.length > 0 ? (
                <div>
                  <dt className="text-muted-foreground text-xs">What's next</dt>
                  <dd>{brief.next}</dd>
                </div>
              ) : null}
            </dl>
          )}
          {brief !== null && state.loading ? (
            <p className="flex items-center gap-2 text-xs">
              <Spinner size="xs" />
              Updating…
            </p>
          ) : stale ? (
            <p className="flex items-center gap-2 text-xs">
              New activity since this brief.
              <Button variant="outline" size="xs" onClick={() => request()}>
                Refresh
              </Button>
            </p>
          ) : null}
          {state.error !== null && !state.loading ? (
            <p className="flex items-center gap-2 text-xs">
              {state.error}
              <Button variant="outline" size="xs" onClick={() => request()}>
                Retry
              </Button>
            </p>
          ) : null}
        </AlertDescription>
        <AlertAction>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Dismiss brief"
            onClick={() => closeThreadCatchUp(registry, threadKey)}
          >
            <XIcon />
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
});
