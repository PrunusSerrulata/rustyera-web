const IOS_FIREFOX_USER_AGENT = /FxiOS\//;
export const BROWSER_FILE_SAVE_EVENT = "rustyera-browser-file-save";

export interface BrowserFileSaveRequest {
  file: File;
  release?: () => void;
}

export function downloadBrowserBlob(name: string, blob: Blob, release?: () => void): void {
  const releaseOnce = once(release);
  const sharedFile = fileShareCandidate(name, blob);
  if (sharedFile) {
    window.dispatchEvent(
      new CustomEvent<BrowserFileSaveRequest>(BROWSER_FILE_SAVE_EVENT, {
        detail: { file: sharedFile, release: releaseOnce },
      }),
    );
    return;
  }

  downloadObjectUrl(name, blob, releaseOnce);
}

function once(action?: () => void): (() => void) | undefined {
  if (!action) return undefined;
  let called = false;
  return () => {
    if (called) return;
    called = true;
    action();
  };
}

function fileShareCandidate(name: string, blob: Blob): File | undefined {
  if (
    !IOS_FIREFOX_USER_AGENT.test(navigator.userAgent) ||
    !window.isSecureContext ||
    typeof navigator.share !== "function" ||
    typeof navigator.canShare !== "function"
  ) {
    return undefined;
  }
  try {
    const file = new File([blob], name, {
      type: blob.type || "application/octet-stream",
      lastModified: Date.now(),
    });
    return navigator.canShare({ files: [file] }) ? file : undefined;
  } catch {
    return undefined;
  }
}

function downloadObjectUrl(name: string, blob: Blob, release?: () => void): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.hidden = true;
  const cleanup = (): void => {
    anchor.remove();
    URL.revokeObjectURL(url);
    release?.();
  };
  try {
    document.body.append(anchor);
    anchor.click();
  } catch (error) {
    cleanup();
    throw error;
  }
  setTimeout(cleanup, 0);
}
