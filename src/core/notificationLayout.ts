export function oldestOverflowCount(
  notificationHeights: number[],
  reservedHeight: number,
  gap: number,
  availableHeight: number,
): number {
  let usedHeight = Math.max(0, reservedHeight);
  let retained = 0;

  for (let index = notificationHeights.length - 1; index >= 0; index -= 1) {
    const height = Math.max(0, notificationHeights[index] ?? 0);
    const nextHeight = usedHeight + (usedHeight > 0 ? gap : 0) + height;
    if (nextHeight > availableHeight) break;
    usedHeight = nextHeight;
    retained += 1;
  }

  return notificationHeights.length - retained;
}
