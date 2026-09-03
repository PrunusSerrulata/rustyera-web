/* global HTMLInputElement, window */

// Keep the production file input and change handler. Only suppress the OS sheet:
// the installed browser's WebDriver supplies FileList and dispatches its native events.
export async function prepareNativeProjectUpload(browser) {
  await browser.execute(() => {
    const nativeClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
      if (this.type === "file") return;
      return nativeClick.call(this);
    };
    window.__RUSTYERA_COMPAT_PICKER_CLEANUP__ = () => {
      HTMLInputElement.prototype.click = nativeClick;
    };
  });
  return { ok: true, provider: "native-webdriver-file-upload" };
}

export async function uploadNativeProject(browser, { project, projectFile }) {
  const selector = projectFile
    ? 'input[type="file"][accept*=".reraproj"]'
    : 'input[type="file"][webkitdirectory]';
  const input = await browser.$(selector);
  await input.waitForExist({ timeout: 5_000, interval: 50 });
  const attributes = await browser.execute(
    (element) => ({
      type: element.type,
      multiple: element.multiple,
      directory: element.webkitdirectory,
      accept: element.accept,
    }),
    input,
  );
  if (attributes.type !== "file" || (!projectFile && !attributes.directory))
    throw new Error(`unexpected native upload input: ${JSON.stringify(attributes)}`);
  // addValue does not issue Element Clear, which is invalid for file inputs.
  await input.addValue(projectFile ?? project);
  return { provider: "native-webdriver-file-upload", attributes };
}
