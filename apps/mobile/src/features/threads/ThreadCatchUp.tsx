import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  closeThreadCatchUp,
  isThreadCatchUpStale,
  requestThreadCatchUp,
  requestThreadCatchUpAction,
  subscribeThreadCatchUpAction,
  threadCatchUpAtom,
  threadCatchUpBasis,
} from "@t3tools/client-runtime/state/thread-catch-up";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { memo, useContext, useEffect, useEffectEvent } from "react";
import { Pressable, View } from "react-native";

import type { AppBarMenu } from "../../components/ui/AppBar.types";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useRemoteEnvironmentRuntime } from "../../state/use-remote-environment-registry";
import { useAtomCommand } from "../../state/use-atom-command";

export interface ThreadCatchUpHeader {
  readonly threadKey: string;
  /** Older servers cannot write briefs, and a read-only session may not run a model there. */
  readonly catchUpAvailable: boolean;
}

export function useThreadCatchUpHeader(
  thread: { readonly environmentId: EnvironmentId; readonly id: ThreadId } | null,
): ThreadCatchUpHeader | null {
  const environmentId = thread?.environmentId ?? null;
  const supported =
    useRemoteEnvironmentRuntime(environmentId)?.serverConfig?.threadCatchUp === true;
  const permitted = useAtomValue(
    orchestrationEnvironment.catchUpThread.permissionAtom(environmentId),
  );
  return thread === null
    ? null
    : {
        threadKey: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        catchUpAvailable: supported && permitted,
      };
}

const jumpToMyLastMessage = (header: ThreadCatchUpHeader) => () =>
  requestThreadCatchUpAction("jump-to-my-last-message", header.threadKey);
const catchMeUp = (header: ThreadCatchUpHeader) => () =>
  requestThreadCatchUpAction("catch-up", header.threadKey);

/** The iOS liquid glass header item. */
export function threadCatchUpHeaderItem(header: ThreadCatchUpHeader) {
  return {
    accessibilityLabel: "Catch up",
    icon: { name: "doc.text", type: "sfSymbol" as const },
    identifier: "thread-right-catch-up",
    label: "Catch up",
    menu: {
      items: [
        ...(header.catchUpAvailable
          ? [
              {
                description: "A short brief on what happened",
                icon: { name: "doc.text", type: "sfSymbol" as const },
                label: "Catch me up",
                onPress: catchMeUp(header),
                type: "action" as const,
              },
            ]
          : []),
        {
          icon: { name: "arrow.turn.left.up", type: "sfSymbol" as const },
          label: "Jump to my last message",
          onPress: jumpToMyLastMessage(header),
          type: "action" as const,
        },
      ],
      title: "Catch up",
    },
    sharesBackground: true,
    type: "menu" as const,
    variant: "plain" as const,
  };
}

/** The same menu in Android's app bar and in iOS headers without liquid glass. */
export function threadCatchUpAppBarMenu(header: ThreadCatchUpHeader): AppBarMenu {
  return {
    title: "Catch up",
    icon: "doc.text",
    items: [
      ...(header.catchUpAvailable
        ? [
            {
              id: "catch-me-up",
              title: "Catch me up",
              subtitle: "A short brief on what happened",
              onPress: catchMeUp(header),
            },
          ]
        : []),
      {
        id: "jump-to-my-last-message",
        title: "Jump to my last message",
        onPress: jumpToMyLastMessage(header),
      },
    ],
  };
}

/** The brief, over the top of the thread. It only appears after the user asks for it. */
export const ThreadCatchUpCard = memo(function ThreadCatchUpCard(props: {
  readonly environmentId: EnvironmentId;
  readonly thread: EnvironmentThreadShell;
  readonly top: number;
}) {
  const registry = useContext(RegistryContext);
  const threadKey = scopedThreadKey(scopeThreadRef(props.environmentId, props.thread.id));
  const catchUpAvailable =
    useThreadCatchUpHeader({ environmentId: props.environmentId, id: props.thread.id })
      ?.catchUpAvailable === true;
  const state = useAtomValue(threadCatchUpAtom(threadKey));
  const basis = threadCatchUpBasis(props.thread);
  const catchUp = useAtomCommand(orchestrationEnvironment.catchUpThread, {
    reportFailure: false,
  });
  const request = useEffectEvent(() => {
    if (!catchUpAvailable) return;
    void requestThreadCatchUp({
      registry,
      threadKey,
      basis,
      generate: async () => {
        const result = await catchUp({
          environmentId: props.environmentId,
          input: { threadId: props.thread.id },
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens on the catch-up action bus while mounted.
  useEffect(
    () => subscribeThreadCatchUpAction("catch-up", threadKey, () => request()),
    [threadKey],
  );

  if (!state.open) return null;
  const { brief } = state;
  const stale = isThreadCatchUpStale(state, basis);
  return (
    <View
      pointerEvents="box-none"
      style={{ position: "absolute", top: props.top, left: 12, right: 12 }}
    >
      <View className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
        <View className="flex-row items-center gap-2">
          <Text className="flex-1 font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
            Catch me up
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss brief"
            hitSlop={10}
            onPress={() => closeThreadCatchUp(registry, threadKey)}
          >
            <SymbolView name="xmark" size={14} tintColorClassName="accent-foreground-muted" />
          </Pressable>
        </View>
        {brief === null ? (
          state.loading ? (
            <View className="flex-row items-center gap-2">
              <AppActivityIndicator colorClassName="accent-foreground-muted" />
              <Text className="font-sans text-sm text-foreground-secondary">Writing a brief…</Text>
            </View>
          ) : null
        ) : (
          <>
            <BriefPart label="Needs you">
              {brief.needsYou ?? "Nothing needs you right now."}
            </BriefPart>
            <BriefPart label="What happened">
              {brief.happened.length === 0
                ? "Nothing new."
                : brief.happened.map((line) => `• ${line}`).join("\n")}
            </BriefPart>
            {brief.next.length > 0 ? <BriefPart label="What's next">{brief.next}</BriefPart> : null}
          </>
        )}
        {brief !== null && state.loading ? (
          <Text className="font-sans text-xs text-foreground-muted">Updating…</Text>
        ) : stale ? (
          <View className="flex-row flex-wrap items-center gap-2.5">
            <Text className="font-sans text-xs text-foreground-muted">
              New activity since this brief.
            </Text>
            <Button label="Refresh" tone="text" onPress={() => request()} />
          </View>
        ) : null}
        {state.error !== null && !state.loading ? (
          <View className="flex-row flex-wrap items-center gap-2.5">
            <Text className="font-sans text-xs text-warning-foreground">{state.error}</Text>
            <Button label="Retry" tone="text" onPress={() => request()} />
          </View>
        ) : null}
      </View>
    </View>
  );
});

function BriefPart(props: { readonly label: string; readonly children: string }) {
  return (
    <View className="gap-0.5">
      <Text className="font-sans text-xs text-foreground-muted">{props.label}</Text>
      <Text className="font-sans text-sm leading-normal text-foreground">{props.children}</Text>
    </View>
  );
}
