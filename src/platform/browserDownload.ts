const IOS_FIREFOX_USER_AGENT = /FxiOS\//;
export const BROWSER_FILE_SAVE_EVENT = "rustyera-browser-file-save";

export interface BrowserFileSaveRequest {
  file: File;
}

export function downloadBrowserBlob(name: string, blob: Blob): void {
  const sharedFile = fileShareCandidate(name, blob);
  if (sharedFile) {
    window.dispatchEvent(
      new CustomEvent<BrowserFileSaveRequest>(BROWSER_FILE_SAVE_EVENT, {
        detail: { file: sharedFile },
      }),
    );
    return;
  }

  downloadObjectUrl(name, blob);
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

function downloadObjectUrl(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.hidden = true;
  const cleanup = (): void => {
    anchor.remove();
    URL.revokeObjectURL(url);
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
