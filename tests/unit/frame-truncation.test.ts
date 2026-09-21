import { describe, it, expect } from 'vitest';

describe('Frame Truncation Bug Analysis', () => {
  it('should demonstrate the mathematical basis of the frame truncation bug', () => {
    const expectedFrames = 27910;
    const fps = 30;
    const quantizedDuration = expectedFrames / fps;
    const decimalDuration = 930.3;
    const frameDuration = 1 / fps;
    const durationDelta = quantizedDuration - decimalDuration;
    const frameDelta = durationDelta / frameDuration;

    expect(quantizedDuration).toBeCloseTo(930.333333, 3);
    expect(frameDelta).toBeCloseTo(1, 1);
  });

  it('should calculate quantized duration correctly', () => {
    const testCases = [
      { frames: 31, fps: 30 },
      { frames: 27910, fps: 30 },
      { frames: 900, fps: 30 },
    ];

    for (const { frames, fps } of testCases) {
      const duration = frames / fps;
      const recalculated = Math.round(duration * fps);
      expect(recalculated).toBe(frames);
    }
  });
});
