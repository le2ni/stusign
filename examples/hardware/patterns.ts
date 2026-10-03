import type { ImageFormat, RgbaImage } from 'stusign/protocol';

/** Use exact black/white or primary colors so the reference needs no lossy conversion. */
export function pattern(width: number, height: number, format: ImageFormat): RgbaImage {
  const mono = format === 'mono' || format === 'mono-zlib';
  const colors = mono
    ? [
        [0, 0, 0],
        [255, 255, 255],
        [0, 0, 0],
        [255, 255, 255],
        [0, 0, 0],
      ]
    : [
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
        [0, 0, 0],
        [255, 255, 255],
      ];
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const border = y < 5 || y >= height - 5 || x < 5 || x >= width - 5;
      const color = colors[Math.min(4, Math.floor((x * 5) / width))]!;
      data.set(border ? [0, 0, 0, 255] : [...color, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

export function whiteImage(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) };
}

export function overlay(base: RgbaImage, patch: RgbaImage, x: number, y: number): RgbaImage {
  const data = new Uint8ClampedArray(base.data);
  for (let row = 0; row < patch.height; row++) {
    data.set(
      patch.data.subarray(row * patch.width * 4, (row + 1) * patch.width * 4),
      ((y + row) * base.width + x) * 4,
    );
  }
  return { width: base.width, height: base.height, data };
}
