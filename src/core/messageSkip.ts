interface SkippableWait {
  wait_id: unknown;
  kind: string;
  stop_message_skip?: boolean;
}

export function isMessageSkipWait(wait: SkippableWait | null | undefined): wait is SkippableWait {
  return wait?.kind === "enter_key" && !wait.stop_message_skip;
}
