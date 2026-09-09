/** Explicit diagnostic only, outside action timing. Count metadata without reading byte payloads. */
export function performancePresentationInventory(
  presentation: any,
): Record<string, number | boolean> {
  const resources = presentation.resources;
  const sprites = resources.sprites ?? [];
  const canvases = resources.canvases ?? [];
  const limit = 100_000;
  let remaining = limit;
  let frames = 0;
  let commands = 0;
  let encodedBytes = 0;
  let truncated = false;
  const reserve = () => {
    if (remaining === 0) {
      truncated = true;
      return false;
    }
    remaining -= 1;
    return true;
  };
  for (let index = 0; index < sprites.length && reserve(); index += 1) {
    const sprite = sprites[index];
    frames += sprite.frames?.length ?? 0;
  }
  for (let index = 0; index < canvases.length && reserve(); index += 1) {
    const canvas = canvases[index];
    commands += canvas.commands?.length ?? 0;
    const entries = canvas.commands ?? [];
    for (let commandIndex = 0; commandIndex < entries.length && reserve(); commandIndex += 1) {
      const command = entries[commandIndex];
      if (command.type === "load_encoded_image") encodedBytes += command.encoded?.length ?? 0;
    }
  }
  return {
    sprites: sprites.length,
    spriteFrames: frames,
    canvases: canvases.length,
    canvasCommands: commands,
    embeddedImageBytes: encodedBytes,
    lines: presentation.lines.length,
    htmlDocuments: presentation.htmlIsland.length,
    sceneLayers: presentation.scene.layers.length,
    truncated,
  };
}
