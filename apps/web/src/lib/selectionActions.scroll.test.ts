import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { observeSelectionActions } from "./selectionActions";

function event(type: string, values: Record<string, unknown> = {}) {
  return Object.assign(new Event(type, { cancelable: true }), values);
}

function createSelectionSurface() {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const view = Object.assign(new EventTarget(), {
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
  const document = Object.assign(new EventTarget(), {
    defaultView: view,
    activeElement: null as EventTarget | null,
  });
  const element = Object.assign(new EventTarget(), {
    ownerDocument: document,
    contains: (target: unknown): boolean => target === element,
    closest: () => null,
  });
  const onSelection = vi.fn();
  const onDismiss = vi.fn();
  const actions = observeSelectionActions({
    element: element as unknown as HTMLElement,
    restoreAfterScroll: true,
    onSelection,
    onDismiss,
  });
  document.addEventListener("selectionchange", actions.selectionChanged);
  const down = () => {
    const press = event("pointerdown", { button: 0, isPrimary: true });
    Object.defineProperty(press, "target", { value: element });
    document.dispatchEvent(press);
    element.dispatchEvent(press);
  };
  const key = (key: string) => {
    const keyEvent = event("keydown", { key });
    Object.defineProperty(keyEvent, "target", { value: document });
    document.dispatchEvent(keyEvent);
  };
  const up = ({ x = 300, y = 200 } = {}) => {
    view.dispatchEvent(event("pointerup", { isPrimary: true, button: 0 }));
    view.dispatchEvent(event("mouseup", { clientX: x, clientY: y, detail: 1, button: 0 }));
  };
  const scroll = () => element.dispatchEvent(event("scroll"));
  const flush = (milliseconds = 0) => {
    vi.advanceTimersByTime(milliseconds);
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(0);
  };
  return { element, onSelection, onDismiss, down, key, up, scroll, flush };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("selection actions while the timeline scrolls", () => {
  it("follows a scroll the user did not make without hiding the actions", () => {
    const surface = createSelectionSurface();
    surface.down();
    surface.up({ x: 420, y: 310 });
    surface.flush();
    surface.onDismiss.mockClear();

    surface.scroll();
    surface.scroll();
    expect(surface.onDismiss).not.toHaveBeenCalled();
    surface.flush();
    expect(surface.onSelection.mock.calls).toEqual([[{ x: 420, y: 310 }], [null]]);

    surface.element.dispatchEvent(event("wheel"));
    surface.flush(500);
    surface.scroll();
    surface.flush();
    expect(surface.onDismiss).not.toHaveBeenCalled();
    expect(surface.onSelection).toHaveBeenCalledTimes(3);
  });

  it.each(["wheel", "touchmove", "PageDown"])(
    "hides the actions while a %s scroll settles",
    (input) => {
      const surface = createSelectionSurface();
      surface.down();
      surface.up();
      surface.flush();
      surface.onDismiss.mockClear();

      if (input === "PageDown") surface.key(input);
      else surface.element.dispatchEvent(event(input));
      surface.scroll();
      expect(surface.onDismiss).toHaveBeenCalledWith("cancel");
      surface.flush(149);
      expect(surface.onSelection).toHaveBeenCalledOnce();
      surface.flush(1);
      expect(surface.onSelection).toHaveBeenLastCalledWith(null);
    },
  );

  it("does not bring back dismissed actions on a scroll the user did not make", () => {
    const surface = createSelectionSurface();
    surface.down();
    surface.up();
    surface.flush();
    surface.key("Escape");
    surface.scroll();
    surface.flush(1000);
    expect(surface.onSelection).toHaveBeenCalledOnce();
  });
});
