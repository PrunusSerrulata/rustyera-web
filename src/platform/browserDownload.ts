export function downloadBrowserBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.hidden = true;

  const cleanup = (): void => {
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  // Firefox for iOS inspects document-level link clicks before handing blob downloads to its
  // native download manager. Keep the link connected for the click so it can retain the name.
  try {
    document.body.append(anchor);
    anchor.click();
  } catch (error) {
    cleanup();
    throw error;
  }
  setTimeout(cleanup, 0);
}
