const JUMP_TO_MY_LAST_MESSAGE_EVENT = "t3:thread-jump-to-my-last-message";
const THREAD_CATCH_UP_EVENT = "t3:thread-catch-up";

// The header, command palette and keybindings ask one thread's timeline or card to act. More than
// one thread can be open at once, so each request names its thread.
function request(event: string, threadKey: string): void {
  window.dispatchEvent(new CustomEvent<string>(event, { detail: threadKey }));
}

function subscribe(event: string, threadKey: string, listener: () => void): () => void {
  const handle = (incoming: Event) => {
    if ((incoming as CustomEvent<string>).detail === threadKey) listener();
  };
  window.addEventListener(event, handle);
  return () => window.removeEventListener(event, handle);
}

export function requestJumpToMyLastMessage(threadKey: string): void {
  request(JUMP_TO_MY_LAST_MESSAGE_EVENT, threadKey);
}

export function subscribeJumpToMyLastMessage(threadKey: string, listener: () => void) {
  return subscribe(JUMP_TO_MY_LAST_MESSAGE_EVENT, threadKey, listener);
}

export function requestThreadCatchUpOpen(threadKey: string): void {
  request(THREAD_CATCH_UP_EVENT, threadKey);
}

export function subscribeThreadCatchUpOpen(threadKey: string, listener: () => void) {
  return subscribe(THREAD_CATCH_UP_EVENT, threadKey, listener);
}
