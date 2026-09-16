import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { loadConfig } from '../src/core/config.js';
import { requiredProxyKeysForFrameRange } from '../src/domain/frame-range.js';
import { ClipProxyPreparer, type ProxyPlacement } from '../src/media/proxy.js';
import { argument, readWindowSnapshot, windowContext } from './window-context.js';
import { RemotionVideoRenderer } from '../src/remotion/renderer.js';

const config = loadConfig();
const context = windowContext(config);
const { renderId, frame } = context;
const [start, end] = context.range;
const preparedManifest = argument('--prepared-manifest');
const manifest = preparedManifest
  ? (await readWindowSnapshot(preparedManifest, context)).manifest
  : context.manifest;
{
  const proxyKeys = requiredProxyKeysForFrameRange(manifest, [start, end]);
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
  const directory = path.join(config.workRoot, 'smoke');
  await mkdir(directory, { recursive: true });
  const outputPath = path.join(directory, `${renderId}-frames-${start}-${end}.mp4`);
  const proxyMetadata: Record<string, { durationSeconds: number; width: number; height: number }> =
    {};
  const proxies = new ClipProxyPreparer(config);
  for (const placement of manifest.placements) {
    if (!('proxy_key' in placement.source) || !proxyKeys.includes(placement.source.proxy_key))
      continue;
    const inspected = await proxies.inspectCache(
      placement as ProxyPlacement,
      manifest.render_profile,
    );
    if (!inspected) throw new Error('Required proxy failed inspection');
    proxyMetadata[placement.source.proxy_key] = inspected;
  }
  const renderer = new RemotionVideoRenderer(config);
  await renderer.initialize();
  const started = performance.now();
  let latest = { renderedFrames: 0, encodedFrames: 0 };
  await renderer.render(
    manifest,
    outputPath,
    (progress) => {
      latest = progress;
    },
    { renderId, frameRange: [start, end], proxyMetadata },
  );
  process.stdout.write(
    `${JSON.stringify({
      smoke_version: 'targeted_remotion_window_v1',
      render_id: renderId,
      target_frame: frame,
      frame_range: [start, end],
      total_frames: end - start + 1,
      proxy_keys: proxyKeys,
      prepared_manifest: preparedManifest ?? null,
      output_path: outputPath,
      wall_seconds: (performance.now() - started) / 1000,
      ...latest,
    })}\n`,
  );
}
