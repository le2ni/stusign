import { describe, expect, it } from 'vitest';
import { ReviewGate, verdict } from '../examples/hardware/review.js';
import { overlay, pattern, whiteImage } from '../examples/hardware/patterns.js';

describe('guided hardware review', () => {
  it('waits for an explicit answer before the next device action', async () => {
    const review = new ReviewGate<string>();
    const controller = new AbortController();
    const sent: number[] = [];
    const decisions: string[] = [];
    const run = (async () => {
      for (const id of [1, 2]) {
        sent.push(id);
        decisions.push(await review.wait(controller.signal));
      }
    })();
    await Promise.resolve();
    expect(sent).toEqual([1]);
    expect(decisions).toEqual([]);
    review.answer('differs');
    await Promise.resolve();
    expect(sent).toEqual([1, 2]);
    expect(decisions).toEqual(['differs']);
    review.answer('matches');
    await run;
    expect(decisions).toEqual(['differs', 'matches']);
    expect(review.answer('matches')).toBe(false);
  });

  it('stops a waiting review and never carries the answer into another test', async () => {
    const review = new ReviewGate<string>();
    const controller = new AbortController();
    const pending = review.wait(controller.signal);
    controller.abort(new Error('Stopped'));
    await expect(pending).rejects.toThrow('Stopped');
    expect(review.answer('matches')).toBe(false);
    const next = review.wait(new AbortController().signal);
    review.answer('not-checked');
    await expect(next).resolves.toBe('not-checked');
  });

  it('rejects concurrent reviews and already cancelled tests', async () => {
    const review = new ReviewGate<string>();
    const controller = new AbortController();
    const pending = review.wait(controller.signal);
    expect(() => review.wait(controller.signal)).toThrow('already waiting');
    review.answer('matches');
    await pending;
    controller.abort(new Error('Stopped'));
    await expect(review.wait(controller.signal)).rejects.toThrow('Stopped');
  });

  it('requires both device success and human confirmation for a pass', () => {
    expect(verdict('running')).toBe('pending');
    expect(verdict('passed')).toBe('pending');
    expect(verdict('passed', 'matches')).toBe('passed');
    expect(verdict('passed', 'differs')).toBe('failed');
    expect(verdict('passed', 'not-checked')).toBe('skipped');
    expect(verdict('passed', 'cancelled')).toBe('cancelled');
    expect(verdict('failed', 'matches')).toBe('failed');
    expect(verdict('failed', 'acknowledged')).toBe('failed');
    expect(verdict('skipped', 'matches')).toBe('skipped');
  });
});

describe('tablet comparison images', () => {
  const pixel = (image: ReturnType<typeof pattern>, x: number, y: number): number[] => [
    ...image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4),
  ];

  it('shows the requested color order in both color formats and a real black border', () => {
    for (const format of ['bgr24', 'rgb565'] as const) {
      const image = pattern(800, 480, format);
      expect([80, 240, 400, 560, 720].map((x) => pixel(image, x, 240))).toEqual([
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [0, 0, 255, 255],
        [0, 0, 0, 255],
        [255, 255, 255, 255],
      ]);
      for (const [x, y] of [
        [400, 0],
        [400, 479],
        [0, 240],
        [799, 240],
      ]) {
        expect(pixel(image, x!, y!)).toEqual([0, 0, 0, 255]);
      }
    }
  });

  it('uses an unambiguous black/white preview for monochrome, including compression', () => {
    const mono = pattern(800, 480, 'mono');
    expect(pattern(800, 480, 'mono-zlib')).toEqual(mono);
    expect([80, 240, 400, 560, 720].map((x) => pixel(mono, x, 240)[0])).toEqual([
      0, 255, 0, 255, 0,
    ]);
    for (let i = 0; i < mono.data.length; i += 4) {
      if (mono.data[i] !== mono.data[i + 1] || mono.data[i] !== mono.data[i + 2]) {
        throw new Error('A color pixel entered the monochrome preview');
      }
    }
  });

  it('composes a partial update while preserving every pixel outside the odd-width area', () => {
    const base = whiteImage(160, 100);
    const patch = pattern(101, 53, 'mono');
    const combined = overlay(base, patch, 17, 23);
    expect(base.data.every((byte) => byte === 255)).toBe(true);
    for (let y = 0; y < base.height; y++) {
      for (let x = 0; x < base.width; x++) {
        expect(pixel(combined, x, y)).toEqual(
          x >= 17 && x < 118 && y >= 23 && y < 76
            ? pixel(patch, x - 17, y - 23)
            : [255, 255, 255, 255],
        );
      }
    }
  });
});
