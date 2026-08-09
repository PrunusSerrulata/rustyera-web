export interface MessageWait {
  wait_id: unknown;
  kind: "enter_key" | "any_key";
  stop_message_skip?: boolean;
}

export type MessageWaitIntent = { type: "enter" } | { type: "any_key"; value: string };

export function isMessageContinuationWait(wait: unknown): wait is MessageWait {
  if (typeof wait !== "object" || wait == null) return false;
  const kind = (wait as { kind?: unknown }).kind;
  return kind === "enter_key" || kind === "any_key";
}

export function isMessageSkipWait(wait: unknown): wait is MessageWait {
  return (
    isMessageContinuationWait(wait) && !(wait as { stop_message_skip?: boolean }).stop_message_skip
  );
}

export function messageWaitIntent(wait: MessageWait): MessageWaitIntent {
  return wait.kind === "any_key" ? { type: "any_key", value: "\n" } : { type: "enter" };
}
