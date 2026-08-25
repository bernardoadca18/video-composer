import { describe, expect, it } from 'vitest';

import { quantizeBoundaries } from '../../src/domain/quantization.js';

describe('frame quantization', () => {
  it('uses shared nearest-frame boundaries and a ceiling final frame', () => {
    const value = quantizeBoundaries(1.01, [0, 1 / 60, 0.5, 1.01], 30);

    expect(value.durationInFrames).toBe(31);
    expect(value.frameAt(0)).toBe(0);
    expect(value.frameAt(1 / 60)).toBe(1);
    expect(value.frameAt(0.5)).toBe(15);
    expect(value.frameAt(1.01)).toBe(31);
    expect(value.frameAt(0.5)).toBe(value.frameAt(0.5));
  });

  it('rejects invalid boundaries', () => {
    expect(() => quantizeBoundaries(1, [1.1], 30)).toThrow('boundary_out_of_range');
    expect(() => quantizeBoundaries(0, [], 30)).toThrow('invalid_duration');
  });
});
