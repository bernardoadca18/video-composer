import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { buildRenderResourcePlan } from '../src/benchmark/resource-plan.js';
import { loadConfig } from '../src/core/config.js';
import { sha256File } from '../src/core/identity.js';
import { RenderManifestSchema } from '../src/domain/contracts.js';
import { mediaDuration, probeMediaWithFrameCount, rational } from '../src/media/probe.js';
import { RemotionVideoRenderer } from '../src/remotion/renderer.js';

const execFileAsync = promisify(execFile);

const valueAfter = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const valuesAfter = (name: string): string[] => {
  const index = process.argv.indexOf(name);
  if (index < 0) return [];
  const values: string[] = [];
  for (let current = index + 1; current < process.argv.length; current += 1) {
    const value = process.argv[current]!;
    if (value.startsWith('--')) break;
    values.push(value);
  }
  return values;
};

const processTreeRssKiB = async (rootPid: number): Promise<number> => {
  const procEntries = await import('node:fs/promises').then((fs) => fs.readdir('/proc'));
  const processes = new Map<number, { parent: number; rssKiB: number }>();
  await Promise.all(
    procEntries
      .filter((entry) => /^\d+$/.test(entry))
      .map(async (entry) => {
        const pid = Number(entry);
        try {
          const [status, statm] = await Promise.all([
            readFile(`/proc/${pid}/status`, 'utf8'),
            readFile(`/proc/${pid}/statm`, 'utf8'),
          ]);
          const parent = Number(/^PPid:\s+(\d+)$/m.exec(status)?.[1] ?? -1);
          const residentPages = Number(statm.split(/\s+/)[1] ?? 0);
          processes.set(pid, { parent, rssKiB: residentPages * 4 });
        } catch {
          // A process may exit while /proc is sampled.
        }
      }),
  );
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, details] of processes) {
      if (!descendants.has(pid) && descendants.has(details.parent)) {
        descendants.add(pid);
        changed = true;
      }
    }
  }
  return [...descendants].reduce((total, pid) => total + (processes.get(pid)?.rssKiB ?? 0), 0);
};

const systemGpuMemoryUsedMiB = async (): Promise<number | null> => {
  try {
    const { stdout } = await execFileAsync('nvidia-smi', [
      '--query-gpu=memory.used',
      '--format=csv,noheader,nounits',
    ]);
    const values = stdout
      .split(/\r?\n/)
      .map((value) => Number(value.trim()))
      .filter(Number.isFinite);
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  } catch {
    return null;
  }
};

// RemotionVideoRenderer writes the video-only intermediate. Production muxes
// narration afterward; validating it as a final audio-bearing MP4 is incorrect.
const validateVideoIntermediate = async (
  config: ReturnType<typeof loadConfig>,
  filePath: string,
  manifest: ReturnType<typeof RenderManifestSchema.parse>,
) => {
  const details = await stat(filePath);
  const probe = await probeMediaWithFrameCount(config.ffprobeBinary, filePath);
  const videos = probe.streams.filter((stream) => stream.codec_type === 'video');
  const audios = probe.streams.filter((stream) => stream.codec_type === 'audio');
  const video = videos[0];
  const fps = rational(video?.avg_frame_rate ?? video?.r_frame_rate);
  const duration = mediaDuration(probe);
  const frameCount = video?.nb_read_frames ? Number(video.nb_read_frames) : null;
  const tolerance = 1 / manifest.render_profile.fps + 0.005;
  if (
    details.size <= 0 ||
    videos.length !== 1 ||
    audios.length !== 0 ||
    video?.codec_name !== 'h264' ||
    video.pix_fmt !== 'yuv420p' ||
    video.width !== manifest.render_profile.width ||
    video.height !== manifest.render_profile.height ||
    fps === null ||
    Math.abs(fps - manifest.render_profile.fps) > 0.001 ||
    duration === null ||
    Math.abs(duration - manifest.duration_seconds) > tolerance ||
    frameCount !== manifest.duration_in_frames
  ) {
    throw new Error(`Invalid Remotion video intermediate: ${filePath}`);
  }
  return {
    sha256: await sha256File(filePath),
    byteSize: details.size,
    durationSeconds: duration,
    width: video.width,
    height: video.height,
    fps,
    frameCount,
    videoCodec: video.codec_name,
    pixelFormat: video.pix_fmt,
    audioStreams: audios.length,
  };
};

const main = async (): Promise<void> => {
  const manifestArgument = valueAfter('--manifest');
  if (!manifestArgument) {
    throw new Error(
      'Usage: npm run benchmark:resources -- --manifest FILE --concurrency 1 2 current [--output DIR] [--run]',
    );
  }
  const config = loadConfig();
  const run = process.argv.includes('--run');
  const plan = buildRenderResourcePlan({
    manifestPath: manifestArgument,
    outputDirectory:
      valueAfter('--output') ?? path.join(config.dataRoot, 'benchmarks', 'render-resources'),
    concurrencies: valuesAfter('--concurrency').length
      ? valuesAfter('--concurrency')
      : ['1', 'current'],
    configuredConcurrency: config.remotionConcurrency,
    run,
  });
  const manifest = RenderManifestSchema.parse(
    JSON.parse(await readFile(plan.manifestPath, 'utf8')),
  );
  process.stdout.write(
    `${JSON.stringify({ ...plan, manifestIdentity: manifest.production_timeline_fingerprint }, null, 2)}\n`,
  );
  if (!run) {
    process.stdout.write(
      'PLAN ONLY: no Remotion bundle, Chromium process, or render was started.\n',
    );
    return;
  }
  await mkdir(plan.outputDirectory, { recursive: true });
  const results: Record<string, unknown>[] = [];
  for (const benchmarkCase of plan.cases) {
    const caseConfig = { ...config, remotionConcurrency: benchmarkCase.concurrency };
    const renderer = new RemotionVideoRenderer(caseConfig);
    let peakRssKiB = await processTreeRssKiB(process.pid);
    const baselineSystemGpuMemoryUsedMiB = await systemGpuMemoryUsedMiB();
    let peakSystemGpuMemoryUsedMiB = baselineSystemGpuMemoryUsedMiB;
    let sampleRunning = false;
    const sample = async (): Promise<void> => {
      if (sampleRunning) return;
      sampleRunning = true;
      try {
        const [rss, gpuMemory] = await Promise.all([
          processTreeRssKiB(process.pid),
          systemGpuMemoryUsedMiB(),
        ]);
        peakRssKiB = Math.max(peakRssKiB, rss);
        if (gpuMemory !== null) {
          peakSystemGpuMemoryUsedMiB = Math.max(peakSystemGpuMemoryUsedMiB ?? 0, gpuMemory);
        }
      } finally {
        sampleRunning = false;
      }
    };
    const sampler = setInterval(() => {
      void sample();
    }, 500);
    const started = performance.now();
    try {
      await renderer.initialize();
      await renderer.render(manifest, benchmarkCase.outputPath, () => undefined);
    } finally {
      clearInterval(sampler);
      while (sampleRunning) await new Promise((resolve) => setTimeout(resolve, 10));
      await sample();
    }
    const validated = await validateVideoIntermediate(
      caseConfig,
      benchmarkCase.outputPath,
      manifest,
    );
    const wallSeconds = (performance.now() - started) / 1000;
    const result = {
      concurrency: benchmarkCase.concurrency,
      wallSeconds,
      realtimeFactor: wallSeconds / manifest.duration_seconds,
      peakRssKiB,
      baselineSystemGpuMemoryUsedMiB,
      peakSystemGpuMemoryUsedMiB,
      peakSystemGpuMemoryDeltaMiB:
        baselineSystemGpuMemoryUsedMiB !== null && peakSystemGpuMemoryUsedMiB !== null
          ? peakSystemGpuMemoryUsedMiB - baselineSystemGpuMemoryUsedMiB
          : null,
      outputPath: benchmarkCase.outputPath,
      output: validated,
    };
    results.push(result);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
  const reportPath = path.join(plan.outputDirectory, 'report.json');
  const temporary = `${reportPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ plan, results }, null, 2)}\n`, 'utf8');
  await rename(temporary, reportPath);
};

await main();
