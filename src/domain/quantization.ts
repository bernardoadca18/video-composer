export const MICROSECONDS_PER_SECOND = 1_000_000n;

export class QuantizationError extends Error {}

export const secondsToMicroseconds = (seconds: number): bigint => {
  if (!Number.isFinite(seconds) || seconds < 0) throw new QuantizationError('invalid_seconds');
  const scaled = Math.round(seconds * Number(MICROSECONDS_PER_SECOND));
  if (!Number.isSafeInteger(scaled)) throw new QuantizationError('seconds_out_of_range');
  return BigInt(scaled);
};

const nearestFrame = (microseconds: bigint, fps: number): bigint =>
  (microseconds * BigInt(fps) + MICROSECONDS_PER_SECOND / 2n) / MICROSECONDS_PER_SECOND;

const ceilingFrame = (microseconds: bigint, fps: number): bigint =>
  (microseconds * BigInt(fps) + MICROSECONDS_PER_SECOND - 1n) / MICROSECONDS_PER_SECOND;

export interface QuantizedBoundaries {
  durationInFrames: number;
  frameAt: (seconds: number) => number;
}

export const quantizeBoundaries = (
  durationSeconds: number,
  boundariesSeconds: readonly number[],
  fps: number,
): QuantizedBoundaries => {
  if (!Number.isInteger(fps) || fps <= 0) throw new QuantizationError('invalid_fps');
  const durationUs = secondsToMicroseconds(durationSeconds);
  if (durationUs <= 0n) throw new QuantizationError('invalid_duration');
  const durationFramesBig = ceilingFrame(durationUs, fps);
  const durationInFrames = Number(durationFramesBig);
  const map = new Map<string, number>();
  const values = new Set<bigint>([0n, durationUs]);
  for (const value of boundariesSeconds) {
    const microseconds = secondsToMicroseconds(value);
    if (microseconds < 0n || microseconds > durationUs) {
      throw new QuantizationError('boundary_out_of_range');
    }
    values.add(microseconds);
  }
  const ordered = [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  let previous = 0;
  for (const value of ordered) {
    const frame = value === durationUs ? durationInFrames : Number(nearestFrame(value, fps));
    if (frame < previous) throw new QuantizationError('non_monotonic_quantization');
    map.set(value.toString(), frame);
    previous = frame;
  }
  return {
    durationInFrames,
    frameAt: (seconds: number): number => {
      const key = secondsToMicroseconds(seconds).toString();
      const frame = map.get(key);
      if (frame === undefined) throw new QuantizationError('unknown_boundary');
      return frame;
    },
  };
};
