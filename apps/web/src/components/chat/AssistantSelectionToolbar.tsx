import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  MessageId,
  TurnItemId,
  type AssistantCitation,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { QuoteIcon } from "lucide-react";
import { use, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  captureAssistantTextSelection,
  type AssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";
import {
  isSelectionRectVisible,
  observeSelectionActions,
  resolveSelectionActionPosition,
  type SelectionActionPoint,
} from "~/lib/selectionActions";
import { Button } from "../ui/button";
import { AssistantSelectionReactions } from "./AssistantPassageReactions";
import { selectionToolbarState } from "./AssistantPassageReactions.logic";
import { useReplyReactions } from "./AssistantReactions";
import { BackgroundThreadContext } from "./backgroundThread";

function captureCitation(
  viewport: HTMLElement,
  threadRef: ScopedThreadRef,
  selection: Selection | null,
) {
  const captured = captureAssistantTextSelection(viewport, selection);
  const messageId = captured?.source.dataset.assistantCitationSource;
  if (!captured || !messageId) return null;
  const citation: AssistantCitation = {
    version: 1,
    ...threadRef,
    messageId: MessageId.make(messageId),
    ...captured.selector,
  };
  const sourceAnchor: AssistantCitationSourceAnchor = {
    source: captured.source,
    range: captured.range,
    viewport,
  };
  // Set on a finished reply of the thread itself, the one kind a reaction can go on.
  const reactionItem = captured.source.dataset.assistantReactionItem;
  const reactionItemId = reactionItem ? TurnItemId.make(reactionItem) : null;
  return { citation, sourceAnchor, reactionItemId };
}

/** The assistant text selected in the timeline, if the Cite button could cite it. */
export function selectedAssistantCitation(threadRef: ScopedThreadRef) {
  const selection = window.getSelection();
  const node = selection?.anchorNode;
  const viewport = (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>(
    "[data-assistant-citation-viewport]",
  );
  const selected = viewport ? captureCitation(viewport, threadRef, selection) : null;
  return selected && selected.citation.text.length <= ASSISTANT_CITATION_MAX_TEXT_LENGTH
    ? selected
    : null;
}

export function AssistantSelectionToolbar({
  viewport,
  threadRef,
  onCite,
}: {
  viewport: HTMLElement | null;
  threadRef: ScopedThreadRef;
  onCite: (citation: AssistantCitation, sourceAnchor: AssistantCitationSourceAnchor) => boolean;
}) {
  const [selection, setSelection] = useState<{
    citation: AssistantCitation;
    position: SelectionActionPoint;
    lastLine: DOMRect;
    sourceAnchor: AssistantCitationSourceAnchor;
    reactionItemId: TurnItemId | null;
  } | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const reactions = useReplyReactions(threadRef.environmentId);
  const actionsRef = useRef<ReturnType<typeof observeSelectionActions> | null>(null);
  const backgroundThread = use(BackgroundThreadContext);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the toolbar DOM node and clamps its position inside the window before paint
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar || !selection) return;
    const rect = toolbar.getBoundingClientRect();
    toolbar.style.left = `${Math.max(8, Math.min(selection.position.x, window.innerWidth - rect.width - 8))}px`;
    toolbar.style.top = `${Math.max(8, Math.min(selection.position.y, window.innerHeight - rect.height - 8))}px`;
  }, [selection]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to document selectionchange and keydown to track text selections in the viewport
  useEffect(() => {
    if (!viewport) return;
    const clear = () => setSelection(null);
    const update = (pointer: SelectionActionPoint | null) => {
      const captured = captureCitation(viewport, threadRef, window.getSelection());
      if (!captured) {
        clear();
        return;
      }
      const { citation, sourceAnchor, reactionItemId } = captured;
      const { range } = sourceAnchor;
      const rect = range.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      if (!isSelectionRectVisible(rect, [viewportRect])) {
        clear();
        return;
      }
      // A selection can cross blocks with different clipping ancestors.
      const common = range.commonAncestorContainer;
      const walker = document.createTreeWalker(common, NodeFilter.SHOW_TEXT);
      let node = common.nodeType === Node.TEXT_NODE ? common : walker.nextNode();
      let visible = false;
      for (; node && !visible; node = walker.nextNode()) {
        if (!range.intersectsNode(node)) continue;
        if (node.parentElement && getComputedStyle(node.parentElement).userSelect === "none")
          continue;
        const fragment = document.createRange();
        fragment.selectNodeContents(node);
        if (node === range.startContainer) {
          fragment.setStart(node, range.startOffset);
        }
        if (node === range.endContainer) {
          fragment.setEnd(node, range.endOffset);
        }
        if (!fragment.toString().trim()) continue;
        const lines = Array.from(fragment.getClientRects());
        if (!lines.some((line) => isSelectionRectVisible(line, [viewportRect]))) continue;
        const clips: Pick<DOMRect, "left" | "right" | "top" | "bottom">[] = [viewportRect];
        for (
          let element = node.parentElement;
          element && element !== viewport;
          element = element.parentElement
        ) {
          const style = getComputedStyle(element);
          const clipX = style.overflowX !== "visible";
          const clipY = style.overflowY !== "visible";
          if (!clipX && !clipY) continue;
          const bounds = element.getBoundingClientRect();
          const left = bounds.left + element.clientLeft;
          const top = bounds.top + element.clientTop;
          clips.push({
            left: clipX ? left : -Infinity,
            right: clipX ? left + element.clientWidth : Infinity,
            top: clipY ? top : -Infinity,
            bottom: clipY ? top + element.clientHeight : Infinity,
          });
        }
        visible = lines.some((line) => isSelectionRectVisible(line, clips));
      }
      if (!visible) {
        clear();
        return;
      }
      const rects = range.getClientRects();
      const lastLine = rects.item(rects.length - 1) ?? rect;
      const pointerOnText =
        pointer !== null &&
        Array.from(rects).some(
          (line) =>
            pointer.x >= line.left - 8 &&
            pointer.x <= line.right + 8 &&
            pointer.y >= line.top - 8 &&
            pointer.y <= line.bottom + 8,
        );
      setSelection((previous) => {
        // The same selection, moved by a scroll: keep the button where it was on the text.
        const followed =
          pointer === null &&
          previous !== null &&
          previous.citation.messageId === citation.messageId &&
          previous.citation.start === citation.start &&
          previous.citation.end === citation.end
            ? {
                x: previous.position.x + lastLine.right - previous.lastLine.right,
                y: previous.position.y + lastLine.bottom - previous.lastLine.bottom,
              }
            : null;
        return {
          sourceAnchor,
          citation,
          reactionItemId,
          lastLine,
          position: resolveSelectionActionPosition({
            bounds: viewportRect,
            selectionRect: lastLine,
            pointer: pointerOnText ? pointer : followed,
            viewport: { width: window.innerWidth, height: window.innerHeight },
          }),
        };
      });
    };
    const actions = observeSelectionActions({
      element: viewport,
      getActionElement: () => toolbarRef.current,
      restoreAfterScroll: true,
      onSelection: update,
      onDismiss: clear,
    });
    actionsRef.current = actions;
    const focusActions = (event: KeyboardEvent) => {
      const toolbar = toolbarRef.current;
      if (
        event.key !== "Tab" ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing ||
        event.defaultPrevented ||
        !toolbar ||
        toolbar.contains(event.target as Node)
      ) {
        return;
      }
      const firstAction = toolbar.querySelector<HTMLButtonElement>("button:not(:disabled)");
      if (!firstAction) return;
      event.preventDefault();
      event.stopPropagation();
      firstAction.focus({ preventScroll: true });
    };
    // Tab belongs to the foreground chat; a background timeline only follows its selection.
    if (!backgroundThread) document.addEventListener("keydown", focusActions, true);
    document.addEventListener("selectionchange", actions.selectionChanged);
    return () => {
      document.removeEventListener("keydown", focusActions, true);
      document.removeEventListener("selectionchange", actions.selectionChanged);
      actions.dispose();
      actionsRef.current = null;
    };
  }, [backgroundThread, threadRef, viewport]);

  if (!selection) return null;
  const { tooLong, citeLabel, reactionItemId } = selectionToolbarState({
    text: selection.citation.text,
    reactionItemId: selection.reactionItemId,
    reactionsAvailable: reactions.available,
  });
  const dismiss = () => {
    actionsRef.current?.cancel();
    setSelection(null);
  };
  const release = () => {
    window.getSelection()?.removeAllRanges();
    dismiss();
  };
  const cite = () => {
    if (tooLong || !onCite(selection.citation, selection.sourceAnchor)) return false;
    release();
    return true;
  };
  return createPortal(
    <div
      ref={toolbarRef}
      role="group"
      aria-label="Selected text"
      className="fixed z-50 flex max-w-[calc(100vw-1rem)] items-center gap-1"
      style={{ left: selection.position.x, top: selection.position.y }}
      onPointerDown={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          dismiss();
        }
      }}
    >
      <Button
        type="button"
        size="xs"
        variant="glass"
        disabled={tooLong}
        aria-label={citeLabel}
        onClick={cite}
      >
        <QuoteIcon aria-hidden="true" className="size-3.5" />
        {tooLong ? "Shorten selection" : "Cite"}
      </Button>
      {reactionItemId === null ? null : (
        <AssistantSelectionReactions
          reactions={reactions}
          reply={{ threadId: threadRef.threadId, itemId: reactionItemId }}
          citation={selection.citation}
          disabled={tooLong}
          onDone={release}
        />
      )}
    </div>,
    document.body,
  );
}
