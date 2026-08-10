export function sfntFont(
  names: Array<{ nameId: 1 | 16; value: string; platform?: 0 | 1 | 3 }>,
  options: { weight?: number; width?: number; italic?: boolean } = {},
): Uint8Array {
  const encoded = names.map(({ nameId, value, platform = 3 }, index) => ({
    nameId,
    platform,
    language: 0x0409 + index,
    bytes: Uint8Array.from(
      Array.from({ length: value.length }, (_, unit) => value.charCodeAt(unit)).flatMap((unit) => [
        unit >> 8,
        unit & 0xff,
      ]),
    ),
  }));
  const nameLength =
    6 + encoded.length * 12 + encoded.reduce((sum, item) => sum + item.bytes.length, 0);
  const nameOffset = 44;
  const os2Offset = nameOffset + nameLength;
  const output = new Uint8Array(os2Offset + 64);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x0001_0000);
  view.setUint16(4, 2);
  setTable(view, 12, 0x6e61_6d65, nameOffset, nameLength);
  setTable(view, 28, 0x4f53_2f32, os2Offset, 64);
  view.setUint16(nameOffset + 2, encoded.length);
  view.setUint16(nameOffset + 4, 6 + encoded.length * 12);
  let stringOffset = 0;
  for (const [index, item] of encoded.entries()) {
    const record = nameOffset + 6 + index * 12;
    view.setUint16(record, item.platform);
    view.setUint16(record + 2, item.platform === 3 ? 1 : 0);
    view.setUint16(record + 4, item.language);
    view.setUint16(record + 6, item.nameId);
    view.setUint16(record + 8, item.bytes.length);
    view.setUint16(record + 10, stringOffset);
    output.set(item.bytes, nameOffset + 6 + encoded.length * 12 + stringOffset);
    stringOffset += item.bytes.length;
  }
  view.setUint16(os2Offset + 4, options.weight ?? 400);
  view.setUint16(os2Offset + 6, options.width ?? 5);
  view.setUint16(os2Offset + 62, options.italic ? 1 : 0);
  return output;
}

function setTable(
  view: DataView,
  record: number,
  tag: number,
  offset: number,
  length: number,
): void {
  view.setUint32(record, tag);
  view.setUint32(record + 8, offset);
  view.setUint32(record + 12, length);
}
