export interface WirePoint {
  x: unknown;
  y: unknown;
}

export interface WireRectangle extends WirePoint {
  width: unknown;
  height: unknown;
}

export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function drawPolygonPath(
  context: CanvasRenderingContext2D,
  points: Array<{ x: number; y: number }>,
): void {
  context.beginPath();
  if (!points.length) return;
  context.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) context.lineTo(point.x, point.y);
  context.closePath();
}

export function point(value: WirePoint): { x: number; y: number } {
  return { x: numeric(value.x), y: numeric(value.y) };
}

export function rectangle(value: WireRectangle): Rectangle {
  return {
    x: numeric(value.x),
    y: numeric(value.y),
    width: numeric(value.width),
    height: numeric(value.height),
  };
}

export function numeric(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

export function tupleRectangle(
  value: unknown,
  fallback: { width: number; height: number },
): Rectangle {
  const rectangle = Array.isArray(value) ? value : [];
  return {
    x: Number(rectangle[0] ?? 0),
    y: Number(rectangle[1] ?? 0),
    width: Number(rectangle[2] ?? fallback.width),
    height: Number(rectangle[3] ?? fallback.height),
  };
}

export function dashPattern(style: unknown, width: number): number[] {
  const unit = Math.max(1, width);
  switch (Number(style)) {
    case 1:
      return [3 * unit, unit];
    case 2:
      return [unit, unit];
    case 3:
      return [3 * unit, unit, unit, unit];
    case 4:
      return [3 * unit, unit, unit, unit, unit, unit];
    default:
      return [];
  }
}

export function argb(value: unknown): string {
  const unsigned = numeric(value) >>> 0;
  const alpha = ((unsigned >>> 24) & 0xff) / 255;
  return `rgba(${(unsigned >>> 16) & 0xff}, ${(unsigned >>> 8) & 0xff}, ${unsigned & 0xff}, ${alpha})`;
}

export function simpleOpacity(values: number[] | undefined): number | undefined {
  if (values?.length !== 25) return undefined;
  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 5; column += 1) {
      const index = row * 5 + column;
      if (index === 18) continue;
      const expected = row === column ? 256 : 0;
      if (Number(values[index]) !== expected) return undefined;
    }
  }
  const opacity = Number(values[18]) / 256;
  return Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : undefined;
}

export function applyColorMatrix(context: CanvasRenderingContext2D, values: number[]): void {
  const image = context.getImageData(0, 0, context.canvas.width, context.canvas.height);
  const matrix = values.map((value) => Number(value) / 256);
  for (let index = 0; index < image.data.length; index += 4) {
    const input = [
      image.data[index] / 255,
      image.data[index + 1] / 255,
      image.data[index + 2] / 255,
      image.data[index + 3] / 255,
      1,
    ];
    for (let channel = 0; channel < 4; channel += 1) {
      let output = 0;
      for (let component = 0; component < 5; component += 1)
        output += input[component] * matrix[component * 5 + channel];
      image.data[index + channel] = Math.round(Math.max(0, Math.min(1, output)) * 255);
    }
  }
  context.putImageData(image, 0, 0);
}
