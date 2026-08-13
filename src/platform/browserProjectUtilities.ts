import type { ProjectReloadScope } from "@/core/types";
import { safePath } from "@/platform/browserProjectFilesystem";

type ProjectReloadSelector =
  { type: "all" } | { type: "folder"; path: string } | { type: "script"; path: string };

export function isScriptCategory(category: string): boolean {
  return category === "erb" || category === "erh";
}

export function projectReloadScopeMatches(
  selector: ProjectReloadSelector,
  relativePath: string,
  category: string,
): boolean {
  if (selector.type === "all") return true;
  if (!isScriptCategory(category)) return false;
  const path = relativePath.replaceAll("\\", "/").normalize("NFC");
  return selector.type === "script"
    ? path === selector.path
    : path === selector.path || path.startsWith(`${selector.path}/`);
}

export function projectReloadSelector(scope: ProjectReloadScope): ProjectReloadSelector {
  if (scope.type === "all") return scope;
  const path = safePath(scope.path).normalize("NFC");
  if (!path) throw new Error("重新加载目标不能为空");
  return { type: scope.type, path };
}

export function saveSlotName(slot: number): string {
  if (!Number.isInteger(slot) || slot < 0 || slot > 99)
    throw new Error("存档槽位必须介于 00 和 99");
  return `save${slot.toString().padStart(2, "0")}.sav`;
}

export async function runBounded(
  tasks: Array<() => Promise<void>>,
  maximumConcurrency: number,
  progress?: (completed: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  let completed = 0;
  const errors: unknown[] = new Array(tasks.length);
  const worker = async () => {
    while (next < tasks.length && !signal?.aborted) {
      const index = next++;
      try {
        await tasks[index]();
      } catch (error) {
        errors[index] = error;
      } finally {
        completed += 1;
        if (
          completed === tasks.length ||
          Math.floor((completed * 30) / tasks.length) >
            Math.floor(((completed - 1) * 30) / tasks.length)
        )
          progress?.(completed, tasks.length);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(tasks.length, maximumConcurrency) }, () => worker()),
  );
  throwIfAborted(signal);
  const firstError = errors.find((error) => error !== undefined);
  if (firstError !== undefined) throw firstError;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("Export cancelled", "AbortError");
}

export function decodeProjectSource(bytes: Uint8Array, relativePath: string): string {
  if (relativePath.replaceAll("\\", "/").toLowerCase() === "reraconfig.toml") {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
    } catch {
      throw new Error("reraconfig.toml 不是有效的 UTF-8 文件");
    }
  }
  for (const encoding of ["utf-8", "shift_jis", "gbk"]) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
    } catch {
      // Try the next legacy encoding accepted by the other frontend.
    }
  }
  throw new Error(`${relativePath} 不是有效的 UTF-8、Windows-31J 或 GBK 文件`);
}

export function decodeProtocolBytes(value: ArrayLike<number | bigint>): Uint8Array {
  return Uint8Array.from(value, (item) => {
    const byte = Number(item);
    if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) throw new Error("存储操作包含无效字节");
    return byte;
  });
}

export function normalizeResourceManifest(text: string): string {
  return text.replace(/([^\r\n]*)(\r\n|\r|\n|$)/g, (_line, body: string, ending: string) => {
    if (!body) return ending;
    const fields = body.split(",");
    const value = fields[1];
    const stripped = value?.replace(/^[ \t]+|[ \t]+$/g, "") ?? "";
    if (value && stripped && stripped.toLowerCase() !== "anime") {
      const leading = value.match(/^[ \t]*/)?.[0] ?? "";
      const trailing = value.match(/[ \t]*$/)?.[0] ?? "";
      fields[1] = `${leading}${stripped.normalize("NFC")}${trailing}`;
    }
    return `${fields.join(",")}${ending}`;
  });
}

export function storageDirectoryName(namespace: string): string {
  const names: Record<string, string> = {
    project: "project",
    save: "sav",
    global_save: "sav",
    data: "data",
    log: "logs",
  };
  return names[namespace] ?? "data";
}
