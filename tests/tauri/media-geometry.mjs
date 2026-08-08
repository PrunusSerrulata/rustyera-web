export async function establishReferenceWindow(width, height) {
  const deviceScale = await browser.execute(() => window.devicePixelRatio || 1);
  await browser.setWindowSize(Math.round(width * deviceScale), Math.round(height * deviceScale));
  await browser.pause(250);
}

export async function paintedImageBounds(imageSelector, clippingSelector = imageSelector) {
  return browser.execute(
    (sourceSelector, ownerSelector) => {
      const source = document.querySelector(sourceSelector);
      const owner = document.querySelector(ownerSelector);
      if (!(source instanceof HTMLImageElement) || !source.complete || source.naturalWidth <= 0)
        return null;
      const canvas = document.createElement("canvas");
      canvas.width = source.naturalWidth;
      canvas.height = source.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context?.drawImage(source, 0, 0);
      const pixels = context?.getImageData(0, 0, canvas.width, canvas.height).data;
      if (!pixels) return null;
      let left = canvas.width;
      let top = canvas.height;
      let right = -1;
      let bottom = -1;
      for (let y = 0; y < canvas.height; y += 1) {
        for (let x = 0; x < canvas.width; x += 1) {
          if (pixels[(y * canvas.width + x) * 4 + 3] === 0) continue;
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x + 1);
          bottom = Math.max(bottom, y + 1);
        }
      }
      if (right < 0 || bottom < 0) return null;
      const sourceBounds = source.getBoundingClientRect();
      const ownerBounds = owner?.getBoundingClientRect();
      const scaleX = sourceBounds.width / source.naturalWidth;
      const scaleY = sourceBounds.height / source.naturalHeight;
      return {
        left: Math.max(ownerBounds?.left ?? -Infinity, sourceBounds.left + left * scaleX),
        top: Math.max(ownerBounds?.top ?? -Infinity, sourceBounds.top + top * scaleY),
        right: Math.min(ownerBounds?.right ?? Infinity, sourceBounds.left + right * scaleX),
        bottom: Math.min(ownerBounds?.bottom ?? Infinity, sourceBounds.top + bottom * scaleY),
      };
    },
    imageSelector,
    clippingSelector,
  );
}
