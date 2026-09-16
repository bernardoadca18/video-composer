import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { loadConfig } from '../src/core/config.js';
import { requiredProxyKeysForFrameRange } from '../src/domain/frame-range.js';
import { RenderJobRepository } from '../src/jobs/repository.js';
import { RemotionVideoRenderer } from '../src/remotion/renderer.js';

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const integer = (name: string, fallback?: number): number => {
  const value = argument(name);
  if (value === undefined && fallback !== undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`Invalid ${name}`);
  return parsed;
};

const renderId = argument('--render-id');
if (!renderId) {
  throw new Error(
    'Usage: tsx scripts/smoke-render-window.ts --render-id UUID --frame N [--before 30] [--after 30]',
  );
}
const frame = integer('--frame');
const before = integer('--before', 30);
const after = integer('--after', 30);
const config = loadConfig();
const repository = new RenderJobRepository(config.databasePath);
try {
  const job = repository.get(renderId);
  if (!job) throw new Error('Render job not found');
  const start = Math.max(0, frame - before);
  const end = Math.min(job.manifest.duration_in_frames - 1, frame + after);
  const proxyKeys = requiredProxyKeysForFrameRange(job.manifest, [start, end]);
  const unavailable: string[] = [];
  await Promise.all(
    proxyKeys.map(async (key) => {
      try {
        await access(path.join(config.proxyCacheRoot, `${key}.mp4`));
      } catch {
        unavailable.push(key);
      }
    }),
  );
  if (unavailable.length) {
    throw new Error(`Required proxies unavailable: ${unavailable.join(',')}`);
  }
  const directory = path.join(config.dataRoot, 'smoke');
  await mkdir(directory, { recursive: true });
  const outputPath = path.join(directory, `${renderId}-frames-${start}-${end}.mp4`);
  const renderer = new RemotionVideoRenderer(config);
  await renderer.initialize();
  const started = performance.now();
  let latest = { renderedFrames: 0, encodedFrames: 0 };
  await renderer.render(
    job.manifest,
    outputPath,
    (progress) => {
      latest = progress;
    },
    { renderId, frameRange: [start, end] },
  );
  process.stdout.write(
    `${JSON.stringify({
      smoke_version: 'targeted_remotion_window_v1',
      render_id: renderId,
      target_frame: frame,
      frame_range: [start, end],
      output_path: outputPath,
      wall_seconds: (performance.now() - started) / 1000,
      ...latest,
    })}\n`,
  );
} finally {
  repository.close();
}
