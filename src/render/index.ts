import type { Signature, SvgOptions } from '../capture/index.js';
import { transformPoint } from '../capture/index.js';
import { validateColor } from '../capture/svg.js';
import { invariant, StuError } from '../errors.js';
import type { RgbaImage } from '../protocol/images.js';

/** Browser-only helpers are kept out of the core public declarations. */
export function toSVGBlob(signature: Signature, options: SvgOptions = {}): Blob {
  return new Blob([signature.toSVG(options)], { type: 'image/svg+xml' });
}

export function drawSignature(
  context: CanvasRenderingContext2D,
  signature: Signature,
  options: SvgOptions = {},
): void {
  const width = options.width ?? context.canvas.width,
    height = options.height ?? context.canvas.height;
  const lineWidth = options.strokeWidth ?? 2;
  invariant(
    [width, height, lineWidth].every((value) => Number.isFinite(value) && value > 0),
    'Invalid render dimensions',
  );
  const color = validateColor(options.color ?? '#17212b');
  context.save();
  try {
    context.clearRect(0, 0, width, height);
    if (options.background) {
      context.fillStyle = validateColor(options.background);
      context.fillRect(0, 0, width, height);
    }
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = lineWidth;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    for (const stroke of signature.strokes) {
      context.beginPath();
      stroke.forEach((point, i) => {
        const p = transformPoint(point, signature.metadata.dimensions, {
          width,
          height,
          ...(options.rotation === undefined ? {} : { rotation: options.rotation }),
        });
        if (stroke.length === 1) {
          context.arc(p.x, p.y, lineWidth / 2, 0, Math.PI * 2);
          context.fill();
        } else if (i === 0) context.moveTo(p.x, p.y);
        else context.lineTo(p.x, p.y);
      });
      if (stroke.length > 1) context.stroke();
    }
  } finally {
    context.restore();
  }
}

export async function toPNGBlob(signature: Signature, options: SvgOptions = {}): Promise<Blob> {
  if (typeof document === 'undefined')
    throw new StuError('UNSUPPORTED_BROWSER', 'PNG export requires a browser canvas');
  const width = options.width ?? signature.metadata.dimensions.width,
    height = options.height ?? signature.metadata.dimensions.height;
  invariant(
    [width, height].every((value) => Number.isInteger(value) && value > 0 && value <= 16384) &&
      width * height <= 16_777_216,
    'PNG dimensions exceed the canvas allocation limit',
  );
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new StuError('UNSUPPORTED_BROWSER', 'Canvas 2D is unavailable');
  drawSignature(context, signature, options);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new StuError('INVALID_STATE', 'PNG encoding failed')),
      'image/png',
    ),
  );
}

export function imageFromCanvas(canvas: HTMLCanvasElement | OffscreenCanvas): RgbaImage {
  const context = canvas.getContext('2d') as
    CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!context) throw new StuError('UNSUPPORTED_BROWSER', 'Canvas 2D is unavailable');
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  return { width: image.width, height: image.height, data: image.data };
}

export function createObjectURL(blob: Blob): { readonly url: string; dispose(): void } {
  const url = URL.createObjectURL(blob);
  let revoked = false;
  return {
    url,
    dispose() {
      if (!revoked) {
        URL.revokeObjectURL(url);
        revoked = true;
      }
    },
  };
}
