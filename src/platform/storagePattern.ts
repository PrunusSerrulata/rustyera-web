export type StoragePatternProfile = "emuera.em" | "emuera.skia.snake";
const MAXIMUM_BYTES = 4096;
const MAXIMUM_STEPS = 1_048_576;
const encoder = new TextEncoder();

function bounded(value: string, scalarText = false): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    encoder.encode(value).length > MAXIMUM_BYTES
  )
    throw new DOMException("存储枚举模式或文件名超过限额或无效", "DataError");
  if (
    scalarText &&
    Array.from(value).some((unit) => {
      const point = unit.codePointAt(0)!;
      return point >= 0xd800 && point <= 0xdfff;
    })
  )
    throw new DOMException("存储枚举模式或文件名包含无效Unicode标量", "DataError");
  return value;
}

// ECMAScript's non-Unicode IgnoreCase canonicalization operates on UTF-16 units. In particular,
// long-s/Kelvin and multi-unit uppercase expansions must not acquire Unicode-mode equivalence.
function legacyCase(unit: string): string {
  const upper = unit.toUpperCase();
  return upper.length !== 1 || (unit.charCodeAt(0) >= 128 && upper.charCodeAt(0) < 128)
    ? unit
    : upper;
}

/** Compile once per listing; '*' and '?' are the only syntax, with bounded greedy backtracking. */
export function storagePattern(
  pattern: string | null | undefined,
  profile: StoragePatternProfile,
): (name: string) => boolean {
  const snake = profile === "emuera.skia.snake";
  const normalize = (value: string) =>
    snake ? bounded(bounded(value, true).normalize("NFC").toLowerCase(), true) : bounded(value);
  const normalized = normalize(pattern ?? "");
  const tokens = snake ? Array.from(normalized) : normalized.split("").map(legacyCase);
  return (name: string): boolean => {
    const normalizedName = normalize(name);
    if (!tokens.length) return true;
    const units = snake ? Array.from(normalizedName) : normalizedName.split("").map(legacyCase);
    const dot = (value: string) => snake || !["\n", "\r", "\u2028", "\u2029"].includes(value);
    let input = 0;
    let cursor = 0;
    let star = -1;
    let retry = 0;
    let steps = 0;
    const step = () => {
      if (++steps > MAXIMUM_STEPS)
        throw new DOMException("存储枚举模式超过匹配工作限额", "DataError");
    };
    while (input < units.length) {
      step();
      if (
        cursor < tokens.length &&
        (tokens[cursor] === "?"
          ? dot(units[input])
          : tokens[cursor] !== "*" && tokens[cursor] === units[input])
      ) {
        cursor += 1;
        input += 1;
      } else if (tokens[cursor] === "*") {
        star = cursor;
        cursor += 1;
        retry = input;
      } else if (star >= 0 && retry < units.length && dot(units[retry])) {
        retry += 1;
        input = retry;
        cursor = star + 1;
      } else return false;
    }
    while (tokens[cursor] === "*") {
      step();
      cursor += 1;
    }
    return cursor === tokens.length;
  };
}
