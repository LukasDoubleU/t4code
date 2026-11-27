import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PeerLinkKeybindingsPreview } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { CopyIcon } from "lucide-react";
import { useId, useState } from "react";

import { m as resolveMessage } from "~/i18n/messages";
import { peerLinkEnvironment, useLinkedEnvironments } from "~/state/peerLinks";
import { useAtomCommand } from "~/state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";

type Comparison =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly environmentId: EnvironmentId }
  | { readonly kind: "ready"; readonly preview: PeerLinkKeybindingsPreview }
  | { readonly kind: "failed"; readonly environmentId: EnvironmentId; readonly message: string };

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error
    ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
    : String(error);
}

/**
 * Replaces `environmentId`'s keybindings with those of a machine it links to, once. Shown only
 * when it links to one; links go one way, so these are the machines it can ask.
 */
export function CopyKeybindingsFromLink({
  environmentId,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
}) {
  const gt = useGT();
  const linked = useLinkedEnvironments(environmentId);
  const previewKeybindings = useAtomCommand(peerLinkEnvironment.previewKeybindings, {
    reportFailure: false,
  });
  const copyKeybindings = useAtomCommand(peerLinkEnvironment.copyKeybindings, {
    reportFailure: false,
  });
  const labelId = useId();
  const [open, setOpen] = useState(false);
  const [comparison, setComparison] = useState<Comparison>({ kind: "idle" });
  const [copying, setCopying] = useState(false);
  if (linked.size === 0) return null;
  const machines = [...linked].map(([id, label]) => ({ id, label }));
  const selected =
    comparison.kind === "ready"
      ? comparison.preview.environmentId
      : comparison.kind === "idle"
        ? null
        : comparison.environmentId;

  const compare = async (target: EnvironmentId) => {
    setComparison({ kind: "loading", environmentId: target });
    const result = await previewKeybindings({ environmentId, input: { environmentId: target } });
    // A later pick answers for itself.
    setComparison((current) =>
      current.kind !== "loading" || current.environmentId !== target
        ? current
        : result._tag === "Success"
          ? { kind: "ready", preview: result.value }
          : { kind: "failed", environmentId: target, message: failureMessage(result) },
    );
  };

  const handleOpenChange = (next: boolean) => {
    if (!next && copying) return;
    setOpen(next);
    if (!next) {
      setComparison({ kind: "idle" });
      return;
    }
    const only = machines.length === 1 ? machines[0] : undefined;
    if (only) void compare(only.id);
  };

  const copy = async () => {
    if (comparison.kind !== "ready") return;
    const { preview } = comparison;
    setCopying(true);
    const result = await copyKeybindings({
      environmentId,
      input: { environmentId: preview.environmentId },
    });
    setCopying(false);
    if (result._tag === "Success") {
      const { copied, skipped, backupPath, label } = result.value;
      toastManager.add({
        type: "success",
        title: gt("Copied keybindings from {label}", { label }),
        description: [
          gt("{copied, plural, one {# keybinding copied.} other {# keybindings copied.}}", {
            copied,
          }),
          skipped > 0
            ? gt(
                "{skipped, plural, one {# skipped: its command is unknown to this version.} other {# skipped: their commands are unknown to this version.}}",
                { skipped },
              )
            : null,
          backupPath !== null
            ? gt("To undo, restore the previous file from {path}.", { path: backupPath })
            : null,
        ]
          .filter((line) => line !== null)
          .join(" "),
      });
      setOpen(false);
      setComparison({ kind: "idle" });
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Could not copy keybindings"),
        description: failureMessage(result),
      });
    }
  };

  const preview = comparison.kind === "ready" ? comparison.preview : null;
  return (
    <>
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={() => handleOpenChange(true)}
      >
        <CopyIcon aria-hidden className="size-4" />
        <T>Copy from a linked machine</T>
      </Button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              <T>Copy keybindings from a linked machine</T>
            </DialogTitle>
            <DialogDescription>
              <T>
                This machine's custom keybindings are replaced by the other machine's. This is a
                one-time copy: later changes there are not synced.
              </T>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-4">
              {machines.length > 1 ? (
                <div className="space-y-1.5">
                  <span id={labelId} className="block text-xs font-medium text-foreground">
                    <T>Machine</T>
                  </span>
                  <Select
                    value={selected}
                    disabled={copying}
                    onValueChange={(next) => {
                      if (next !== null) void compare(next as EnvironmentId);
                    }}
                  >
                    <SelectTrigger aria-labelledby={labelId}>
                      <SelectValue>
                        {(value: string | null) =>
                          machines.find((machine) => machine.id === value)?.label ??
                          gt("Choose a machine")
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      {machines.map((machine) => (
                        <SelectItem key={machine.id} value={machine.id}>
                          {machine.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              ) : null}
              {comparison.kind === "loading" ? (
                <p className="text-sm text-muted-foreground">
                  <T>Comparing keybindings…</T>
                </p>
              ) : comparison.kind === "failed" ? (
                <Alert variant="error">
                  <AlertDescription>{comparison.message}</AlertDescription>
                </Alert>
              ) : preview !== null ? (
                <div className="space-y-2 text-sm">
                  <p>
                    {preview.differing === 0
                      ? gt("This machine already has the same keybindings as {label}.", {
                          label: preview.label,
                        })
                      : gt(
                          "{differing, plural, one {# keybinding differs from {label}.} other {# keybindings differ from {label}.}}",
                          { differing: preview.differing, label: preview.label },
                        )}
                  </p>
                  {preview.skipped > 0 ? (
                    <p className="text-muted-foreground">
                      {gt(
                        "{skipped, plural, one {# keybinding there is for a command this version does not know. It is skipped.} other {# keybindings there are for commands this version does not know. They are skipped.}}",
                        { skipped: preview.skipped },
                      )}
                    </p>
                  ) : null}
                  {preview.differing > 0 ? (
                    <p className="text-muted-foreground">
                      <T>The current file is kept beside it as keybindings.json.bak.</T>
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter variant="bare">
            <DialogClose disabled={copying} render={<Button variant="outline" type="button" />}>
              <T>Cancel</T>
            </DialogClose>
            <Button
              type="button"
              disabled={copying || preview === null || preview.differing === 0}
              onClick={() => void copy()}
            >
              {copying
                ? gt("Copying…")
                : preview === null
                  ? gt("Replace keybindings")
                  : gt("Replace with {label}''s", { label: preview.label })}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
