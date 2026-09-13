import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';

import { fingerprint, sha256File } from '../src/core/identity.js';
import { mediaDuration, probeMedia, rational } from '../src/media/probe.js';
import { runProcess } from '../src/media/process.js';

const WORKFLOW_ID = '11111111-1111-4111-8111-111111111111';
const TIMELINE_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = '44444444-4444-4444-8444-444444444444';
const MEDIA_ID = '55555555-5555-4555-8555-555555555555';
const IMAGE_ID = '55555555-5555-4555-8555-555555555556';
const IMAGE_INDEX_ID = '77777777-7777-4777-8777-777777777777';
const IMAGE_2_ID = '55555555-5555-4555-8555-555555555557';
const IMAGE_2_INDEX_ID = '77777777-7777-4777-8777-777777777778';
const hybrid = process.env.SMOKE_HYBRID === '1';
const servicePort = Number(process.env.SMOKE_COMPOSER_PORT ?? 18013);
const upstreamPort = servicePort + 1;
const externalComposerUrl = process.env.SMOKE_EXTERNAL_COMPOSER_URL;

const waitForReady = async (url: string): Promise<void> => {
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // startup is still in progress
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Video Composer readiness timed out');
};

const waitForRender = async (baseUrl: string, id: string): Promise<Record<string, unknown>> => {
  const started = Date.now();
  while (Date.now() - started < 10 * 60_000) {
    const response = await fetch(`${baseUrl}/v1/renders/${id}`);
    const body = (await response.json()) as Record<string, unknown>;
    if (body.status === 'completed') return body;
    if (body.status === 'failed') throw new Error(`Render failed: ${JSON.stringify(body.error)}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Render timed out');
};

const extractPixel = async (filePath: string, seconds: number): Promise<number[]> =>
  await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-v',
      'error',
      '-ss',
      seconds.toFixed(3),
      '-i',
      filePath,
      '-frames:v',
      '1',
      '-vf',
      'scale=1:1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ]);
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const value = Buffer.concat(chunks);
      if (code === 0 && value.length >= 3) {
        resolve([value[0]!, value[1]!, value[2]!]);
      } else {
        reject(new Error('frame pixel extraction failed'));
      }
    });
  });

const main = async (): Promise<void> => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'neovids-stage16-smoke-'));
  const persistentRoot = path.resolve('data/smoke');
  await mkdir(persistentRoot, { recursive: true });
  const sourcePath = path.join(temporary, 'gameplay.mp4');
  const imagePath = path.join(temporary, 'still.png');
  const image2Path = path.join(temporary, 'still-landscape.png');
  const narrationPath = path.join(temporary, 'narration.wav');
  const realNarrationUrl = process.env.REAL_NARRATION_URL;
  if (realNarrationUrl) {
    const response = await fetch(realNarrationUrl);
    if (!response.ok) throw new Error(`Real narration download failed: ${response.status}`);
    await writeFile(narrationPath, Buffer.from(await response.arrayBuffer()));
  } else {
    await runProcess(
      'ffmpeg',
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=440:sample_rate=48000:duration=${hybrid ? 12 : 6}`,
        '-c:a',
        'pcm_s16le',
        '-y',
        narrationPath,
      ],
      'smoke_fixture_failure',
    );
  }
  const narrationProbe = await probeMedia('ffprobe', narrationPath);
  const duration = mediaDuration(narrationProbe);
  if (!duration) throw new Error('Narration duration is unavailable');
  const split = Math.round((duration / 2) * 1_000_000) / 1_000_000;
  const segment = hybrid ? duration / 4 : split;
  const secondDuration = duration - split;
  await runProcess(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=red:s=640x360:r=30:d=${split.toFixed(6)}`,
      '-f',
      'lavfi',
      '-i',
      `color=c=${hybrid ? 'green' : 'blue'}:s=640x360:r=30:d=${secondDuration.toFixed(6)}`,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=1000:sample_rate=48000:duration=${duration.toFixed(6)}`,
      '-filter_complex',
      '[0:v][1:v]concat=n=2:v=1:a=0[v]',
      '-map',
      '[v]',
      '-map',
      '2:a:0',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      '-y',
      sourcePath,
    ],
    'smoke_fixture_failure',
  );
  await runProcess(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=480x640',
      '-frames:v',
      '1',
      '-y',
      imagePath,
    ],
    'smoke_fixture_failure',
  );
  await runProcess(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=yellow:s=800x450',
      '-frames:v',
      '1',
      '-y',
      image2Path,
    ],
    'smoke_fixture_failure',
  );
  const [
    narrationSha,
    sourceSha,
    imageSha,
    image2Sha,
    narrationStat,
    sourceStat,
    imageStat,
    image2Stat,
  ] = await Promise.all([
    sha256File(narrationPath),
    sha256File(sourcePath),
    sha256File(imagePath),
    sha256File(image2Path),
    stat(narrationPath),
    stat(sourcePath),
    stat(imagePath),
    stat(image2Path),
  ]);
  const timeline = {
    id: TIMELINE_ID,
    workflow_id: WORKFLOW_ID,
    schema_version: hybrid ? 'production_timeline_schema_v2' : 'production_timeline_schema_v1',
    strategy_version: hybrid ? 'production_timeline_v2' : 'production_timeline_v1',
    fingerprint: fingerprint({ duration, narrationSha, sourceSha, imageSha, image2Sha, hybrid }),
    status: 'completed',
    duration_seconds: duration,
    tracks: {
      narration: {
        kind: 'narration',
        timeline_start_seconds: 0,
        timeline_end_seconds: duration,
        source_start_seconds: 0,
        source_end_seconds: duration,
        audio_url: `/workflow/${WORKFLOW_ID}/audio`,
        audio_sha256: narrationSha,
        sample_rate: 48000,
        channels: 1,
        byte_size: narrationStat.size,
      },
      primary_visual: {
        placements: hybrid
          ? [
              {
                id: '66666666-6666-4666-8666-666666666661',
                order: 0,
                timeline_start_seconds: 0,
                timeline_end_seconds: segment,
                source: {
                  source_type: 'video_segment',
                  project_id: PROJECT_ID,
                  session_id: SESSION_ID,
                  media_id: MEDIA_ID,
                  candidate_start_seconds: 0,
                  candidate_end_seconds: segment,
                  source_start_seconds: 0,
                  source_end_seconds: segment,
                },
                playback_rate: 1,
                presentation: null,
                transition: 'cut',
              },
              {
                id: '66666666-6666-4666-8666-666666666662',
                order: 1,
                timeline_start_seconds: segment,
                timeline_end_seconds: segment * 2,
                source: {
                  source_type: 'static_image',
                  project_id: PROJECT_ID,
                  media_id: IMAGE_ID,
                  image_semantic_index_id: IMAGE_INDEX_ID,
                  expected_sha256: imageSha,
                  expected_byte_size: imageStat.size,
                  content_type: 'image/png',
                },
                playback_rate: null,
                presentation: {
                  policy_version: 'static_image_presentation_v1',
                  fit: 'contain',
                  background: 'blurred_fill',
                  motion: 'slow_zoom_in',
                  zoom_amount: 0.04,
                },
                transition: 'cut',
              },
              {
                id: '66666666-6666-4666-8666-666666666663',
                order: 2,
                timeline_start_seconds: segment * 2,
                timeline_end_seconds: segment * 3,
                source: {
                  source_type: 'video_segment',
                  project_id: PROJECT_ID,
                  session_id: SESSION_ID,
                  media_id: MEDIA_ID,
                  candidate_start_seconds: split,
                  candidate_end_seconds: duration,
                  source_start_seconds: split,
                  source_end_seconds: split + segment,
                },
                playback_rate: 1,
                presentation: null,
                transition: 'cut',
              },
              {
                id: '66666666-6666-4666-8666-666666666664',
                order: 3,
                timeline_start_seconds: segment * 3,
                timeline_end_seconds: duration,
                source: {
                  source_type: 'static_image',
                  project_id: PROJECT_ID,
                  media_id: IMAGE_2_ID,
                  image_semantic_index_id: IMAGE_2_INDEX_ID,
                  expected_sha256: image2Sha,
                  expected_byte_size: image2Stat.size,
                  content_type: 'image/png',
                },
                playback_rate: null,
                presentation: {
                  policy_version: 'static_image_presentation_v1',
                  fit: 'cover',
                  background: 'black',
                  motion: 'slow_zoom_out',
                  zoom_amount: 0.04,
                },
                transition: 'cut',
              },
            ]
          : [
              {
                id: '66666666-6666-4666-8666-666666666661',
                order: 0,
                timeline_start_seconds: 0,
                timeline_end_seconds: split,
                source: {
                  source_type: 'gameplay',
                  project_id: PROJECT_ID,
                  session_id: SESSION_ID,
                  media_id: MEDIA_ID,
                  candidate_start_seconds: 0,
                  candidate_end_seconds: split,
                  source_start_seconds: 0,
                  source_end_seconds: split,
                },
                playback_rate: 1,
                transition: 'cut',
              },
              {
                id: '66666666-6666-4666-8666-666666666662',
                order: 1,
                timeline_start_seconds: split,
                timeline_end_seconds: duration,
                source: {
                  source_type: 'gameplay',
                  project_id: PROJECT_ID,
                  session_id: SESSION_ID,
                  media_id: MEDIA_ID,
                  candidate_start_seconds: split,
                  candidate_end_seconds: duration,
                  source_start_seconds: split,
                  source_end_seconds: duration,
                },
                playback_rate: 1,
                transition: 'cut',
              },
            ],
      },
    },
    gaps: [],
    visual_coverage_ratio: 1,
  };
  const upstream = Fastify({ logger: false });
  upstream.get(`/workflow/${WORKFLOW_ID}/production-timeline`, async () => timeline);
  upstream.get(
    `/workflow/${WORKFLOW_ID}/audio`,
    async (_request, reply) => await reply.type('audio/wav').send(createReadStream(narrationPath)),
  );
  upstream.get(`/media-assets/${MEDIA_ID}`, async () => ({
    id: MEDIA_ID,
    project_id: PROJECT_ID,
    media_kind: 'video',
    original_filename: 'gameplay.mp4',
    content_type: 'video/mp4',
    byte_size: sourceStat.size,
    sha256: sourceSha,
    duration_seconds: duration,
    format_name: 'mov,mp4',
    video_codec: 'h264',
    audio_codec: 'aac',
    fps: 30,
    width: 640,
    height: 360,
  }));
  upstream.get(
    `/media-assets/${MEDIA_ID}/content`,
    async (_request, reply) => await reply.type('video/mp4').send(createReadStream(sourcePath)),
  );
  upstream.get(`/media-assets/${IMAGE_ID}`, async () => ({
    id: IMAGE_ID,
    project_id: PROJECT_ID,
    media_kind: 'image',
    original_filename: 'still.png',
    content_type: 'image/png',
    byte_size: imageStat.size,
    sha256: imageSha,
    duration_seconds: null,
    format_name: 'png',
    video_codec: null,
    audio_codec: null,
    fps: null,
    width: 480,
    height: 640,
  }));
  upstream.get(
    `/media-assets/${IMAGE_ID}/content`,
    async (_request, reply) => await reply.type('image/png').send(createReadStream(imagePath)),
  );
  upstream.get(`/media-assets/${IMAGE_2_ID}`, async () => ({
    id: IMAGE_2_ID,
    project_id: PROJECT_ID,
    media_kind: 'image',
    original_filename: 'still-landscape.png',
    content_type: 'image/png',
    byte_size: image2Stat.size,
    sha256: image2Sha,
    duration_seconds: null,
    format_name: 'png',
    video_codec: null,
    audio_codec: null,
    fps: null,
    width: 800,
    height: 450,
  }));
  upstream.get(
    `/media-assets/${IMAGE_2_ID}/content`,
    async (_request, reply) => await reply.type('image/png').send(createReadStream(image2Path)),
  );
  await upstream.listen({
    host: process.env.SMOKE_UPSTREAM_HOST ?? '127.0.0.1',
    port: upstreamPort,
  });
  const serviceRoot = path.join(temporary, 'composer-data');
  const child = externalComposerUrl
    ? null
    : spawn(process.execPath, ['dist/main.js'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOST: '127.0.0.1',
          PORT: String(servicePort),
          DATA_ROOT: serviceRoot,
          ORCHESTRATOR_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
          MEDIA_INDEXER_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
          INTERNAL_ASSET_BASE_URL: `http://127.0.0.1:${servicePort}`,
          LOG_LEVEL: 'warn',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
  const childLogs: Buffer[] = [];
  child?.stdout.on('data', (chunk: Buffer) => childLogs.push(chunk));
  child?.stderr.on('data', (chunk: Buffer) => childLogs.push(chunk));
  const baseUrl = externalComposerUrl ?? `http://127.0.0.1:${servicePort}`;
  try {
    await waitForReady(`${baseUrl}/health/ready`);
    const requestStarted = performance.now();
    const createdResponse = await fetch(`${baseUrl}/v1/renders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': hybrid ? 'hybrid-engine-smoke' : 'stage16-engine-smoke',
      },
      body: JSON.stringify({
        workflow_id: WORKFLOW_ID,
        render_profile: 'youtube_1080p30_v1',
        mode: 'final',
      }),
    });
    const created = (await createdResponse.json()) as { id: string };
    if (createdResponse.status !== 202) throw new Error(JSON.stringify(created));
    const completed = await waitForRender(baseUrl, created.id);
    const wallSeconds = (performance.now() - requestStarted) / 1000;
    const outputResponse = await fetch(`${baseUrl}/v1/renders/${created.id}/video`);
    if (!outputResponse.ok) throw new Error('Output download failed');
    const outputPath = path.join(
      persistentRoot,
      realNarrationUrl
        ? 'real-narration-render.mp4'
        : hybrid
          ? 'hybrid-engine-render.mp4'
          : 'engine-render.mp4',
    );
    await writeFile(outputPath, Buffer.from(await outputResponse.arrayBuffer()));
    const outputProbe = await probeMedia('ffprobe', outputPath);
    const video = outputProbe.streams.find((item) => item.codec_type === 'video')!;
    const audio = outputProbe.streams.find((item) => item.codec_type === 'audio')!;
    const beginning = await extractPixel(outputPath, Math.min(1, segment / 2));
    const imageOne = hybrid
      ? await extractPixel(outputPath, segment + Math.min(1, segment / 2))
      : null;
    const videoTwo = hybrid
      ? await extractPixel(outputPath, segment * 2 + Math.min(1, segment / 2))
      : null;
    const ending = await extractPixel(
      outputPath,
      hybrid ? segment * 3 + Math.min(1, segment / 2) : split + Math.min(1, secondDuration / 2),
    );
    const visualsValid = hybrid
      ? beginning[0]! > beginning[2]! + 50 &&
        imageOne![2]! > imageOne![0]! + 50 &&
        videoTwo![1]! > videoTwo![0]! + 40 &&
        videoTwo![1]! > videoTwo![2]! + 40 &&
        ending[0]! > ending[2]! + 50 &&
        ending[1]! > ending[2]! + 50
      : beginning[0]! > beginning[2]! + 50 && ending[2]! > ending[0]! + 50;
    if (!visualsValid) {
      throw new Error(
        `Visual inspection failed: ${JSON.stringify({ beginning, imageOne, videoTwo, ending })}`,
      );
    }
    const cacheResponse = await fetch(`${baseUrl}/v1/renders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': hybrid ? 'hybrid-cache-smoke' : 'stage16-cache-smoke',
      },
      body: JSON.stringify({
        workflow_id: WORKFLOW_ID,
        render_profile: 'youtube_1080p30_v1',
        mode: 'preview',
      }),
    });
    const cacheCreated = (await cacheResponse.json()) as { id: string };
    const cacheCompleted = await waitForRender(baseUrl, cacheCreated.id);
    const result = {
      smoke: realNarrationUrl
        ? 'REAL_NARRATION_RENDER_SMOKE'
        : hybrid
          ? 'HYBRID_VISUAL_RENDER_SMOKE'
          : 'VIDEO_COMPOSER_ENGINE_SMOKE',
      status: 'PASS',
      render_id: created.id,
      output_path: outputPath,
      resolution: `${video.width}x${video.height}`,
      fps: rational(video.avg_frame_rate),
      video_codec: video.codec_name,
      pixel_format: video.pix_fmt,
      audio_codec: audio.codec_name,
      audio_sample_rate: Number(audio.sample_rate),
      duration_seconds: mediaDuration(outputProbe),
      byte_size: (await stat(outputPath)).size,
      sha256: await sha256File(outputPath),
      wall_seconds: wallSeconds,
      render_factor: wallSeconds / duration,
      engine_metrics: completed.metrics,
      second_render_cache_metrics: cacheCompleted.metrics,
      inspected_pixels: {
        video_one: beginning,
        image_one: imageOne,
        video_two: videoTwo,
        image_two: ending,
      },
      gameplay_audio_streams_in_proxy: 0,
      final_audio_streams: outputProbe.streams.filter((item) => item.codec_type === 'audio').length,
    };
    await writeFile(
      path.join(
        persistentRoot,
        realNarrationUrl ? 'real-narration.json' : hybrid ? 'hybrid-engine.json' : 'engine.json',
      ),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${Buffer.concat(childLogs).toString('utf8')}\n`);
    throw error;
  } finally {
    child?.kill('SIGTERM');
    await upstream.close();
  }
};

await main();
