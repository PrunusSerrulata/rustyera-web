export const MIN_COLUMN_WIDTH = 16;
export const MAX_COLUMN_WIDTH = 24;
export const TARGET_COLUMN_COUNT = 5;

export interface ColumnGroupLayout {
  columnWidth: number;
  columns: number;
}

export function responsiveColumnGroupLayout(
  viewportColumns: number,
  preferredColumns: readonly number[],
): ColumnGroupLayout {
  const available = finitePositiveInteger(viewportColumns);
  const cellCount = Math.max(1, preferredColumns.length);
  const preferred = Math.max(
    MIN_COLUMN_WIDTH,
    Math.min(MAX_COLUMN_WIDTH, ...preferredColumns.map(finitePositiveInteger)),
  );
  const targetWidth = MAX_COLUMN_WIDTH * TARGET_COLUMN_COUNT;

  if (available < targetWidth) {
    // Preserve five cells by compacting them to the readable minimum first. Once
    // that no longer fits, reduce the row capacity and use the widest safe cells.
    const capacity = Math.min(
      TARGET_COLUMN_COUNT,
      Math.max(1, Math.floor(available / MIN_COLUMN_WIDTH)),
    );
    const columns = Math.min(cellCount, capacity);
    const availablePerColumn = Math.max(1, Math.floor(available / columns));
    const effectiveMinimum = Math.min(MIN_COLUMN_WIDTH, availablePerColumn);
    return {
      columnWidth: Math.max(
        effectiveMinimum,
        Math.min(MAX_COLUMN_WIDTH, preferred, availablePerColumn),
      ),
      columns,
    };
  }

  // Wide viewports keep maximum-width cells and spend extra space on more columns.
  return {
    columnWidth: MAX_COLUMN_WIDTH,
    columns: Math.min(cellCount, Math.max(1, Math.floor(available / MAX_COLUMN_WIDTH))),
  };
}

function finitePositiveInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}
