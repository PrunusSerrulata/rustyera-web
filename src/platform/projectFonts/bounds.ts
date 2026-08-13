interface TableRangeLike {
  start: number;
  end: number;
}

export function decodeUtf16Be(view: DataView, offset: number, length: number): string {
  let result = "";
  for (let index = 0; index < length; index += 2)
    result += String.fromCharCode(view.getUint16(offset + index));
  return result.replaceAll("\0", "").trim();
}

export function requireRange(
  view: DataView,
  offset: number,
  length: number,
  message: string,
): void {
  if (offset < 0 || length < 0 || offset > view.byteLength - length) throw new Error(message);
}

export function requireSubrange(
  table: TableRangeLike,
  offset: number,
  length: number,
  message: string,
): void {
  if (offset < table.start || length < 0 || offset > table.end - length) throw new Error(message);
}

export function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new Error("字体偏移溢出");
  return result;
}

export function checkedMultiply(left: number, right: number): number {
  const result = left * right;
  if (!Number.isSafeInteger(result)) throw new Error("字体长度溢出");
  return result;
}
