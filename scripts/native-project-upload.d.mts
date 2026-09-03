export interface UploadElement {
  waitForExist(options: { timeout: number; interval: number }): Promise<unknown>;
  addValue(value: string): Promise<unknown>;
}
export interface UploadBrowser {
  execute(
    callback: (element: HTMLInputElement) => UploadAttributes,
    element: UploadElement,
  ): Promise<UploadAttributes>;
  $(selector: string): Promise<UploadElement>;
}
export interface UploadAttributes {
  type: string;
  multiple: boolean;
  directory: boolean;
  accept: string;
}
export function prepareNativeProjectUpload(browser: {
  execute(callback: () => void): Promise<unknown>;
}): Promise<{ ok: true; provider: string }>;
export function uploadNativeProject(
  browser: UploadBrowser,
  paths: { project: string; projectFile?: string },
): Promise<{ provider: string; attributes: UploadAttributes }>;
