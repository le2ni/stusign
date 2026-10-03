import { invariant } from '../errors.js';
import { transformPoint } from './index.js';
import type { Signature } from './index.js';

export interface SvgOptions {
  readonly width?: number;
  readonly height?: number;
  readonly color?: string;
  readonly background?: string;
  readonly strokeWidth?: number;
  readonly rotation?: 0 | 90 | 180 | 270;
}

export function validateColor(color: string): string {
  invariant(/^#[0-9a-f]{6}$/i.test(color), 'Color must be #RRGGBB');
  return color;
}

export function signatureSvg(signature: Signature, options: SvgOptions = {}): string {
  const width = options.width ?? signature.metadata.dimensions.width,
    height = options.height ?? signature.metadata.dimensions.height;
  const strokeWidth = options.strokeWidth ?? 2;
  invariant(
    [width, height, strokeWidth].every((value) => Number.isFinite(value) && value > 0),
    'SVG dimensions and stroke width must be positive',
  );
  const color = validateColor(options.color ?? '#17212b');
  const n = (value: number): string => Number(value.toFixed(3)).toString();
  const output = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(width)} ${n(height)}" width="${n(width)}" height="${n(height)}">`,
  ];
  if (options.background)
    output.push(`<rect width="100%" height="100%" fill="${validateColor(options.background)}"/>`);
  for (const stroke of signature.strokes) {
    const points = stroke.map((sample) =>
      transformPoint(sample, signature.metadata.dimensions, {
        width,
        height,
        ...(options.rotation === undefined ? {} : { rotation: options.rotation }),
      }),
    );
    if (points.length === 1)
      output.push(
        `<circle cx="${n(points[0]!.x)}" cy="${n(points[0]!.y)}" r="${n(strokeWidth / 2)}" fill="${color}"/>`,
      );
    else
      output.push(
        `<path d="${points.map((point, i) => `${i ? 'L' : 'M'}${n(point.x)} ${n(point.y)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="${n(strokeWidth)}" stroke-linecap="round" stroke-linejoin="round"/>`,
      );
  }
  output.push('</svg>');
  return output.join('');
}
