import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { mediaDuration, probeMedia } from '../src/media/probe.js';
import { runProcess } from '../src/media/process.js';

const inputIndex = process.argv.indexOf('--input');
const outputIndex = process.argv.indexOf('--output');
if (inputIndex < 0 || !process.argv[inputIndex + 1]) {
  throw new Error('Usage: npm run extract:frames -- --input video.mp4 [--output directory]');
}
const input = path.resolve(process.argv[inputIndex + 1]!);
const output = path.resolve(
  outputIndex >= 0 ? process.argv[outputIndex + 1]! : 'data/debug-frames',
);
await mkdir(output, { recursive: true });
const duration = mediaDuration(await probeMedia('ffprobe', input));
if (!duration) throw new Error('Input duration is unavailable');
const timestamps = [
  0.1,
  duration * 0.25,
  duration * 0.5,
  duration * 0.75,
  Math.max(0, duration - 0.1),
];
for (const [index, timestamp] of timestamps.entries()) {
  await runProcess(
    'ffmpeg',
    [
      '-v',
      'error',
      '-ss',
      timestamp.toFixed(6),
      '-i',
      input,
      '-frames:v',
      '1',
      '-y',
      path.join(output, `${String(index).padStart(2, '0')}-${timestamp.toFixed(3)}.png`),
    ],
    'frame_extraction_failure',
  );
}
process.stdout.write(`${JSON.stringify({ input, output, duration, timestamps }, null, 2)}\n`);
