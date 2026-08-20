export interface RuntimeWasmAssetUrls {
  module: string;
  binary: string;
}

export function runtimeWasmAssetUrls(
  development: boolean,
  baseUrl: string,
  revision: string,
): RuntimeWasmAssetUrls {
  const directory = development ? "/__rustyera_wasm/" : `${baseUrl}wasm/`;
  const version = `?v=${encodeURIComponent(revision)}`;
  return {
    module: `${directory}era_web_wasm.js${version}`,
    binary: `${directory}era_web_wasm_bg.wasm${version}`,
  };
}
