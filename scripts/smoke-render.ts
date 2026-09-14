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
const programAudioEnabled = process.env.SMOKE_PROGRAM_AUDIO === '1';
const hybrid = process.env.SMOKE_HYBRID === '1' || programAudioEnabled;
const presentationEnabled = process.env.SMOKE_PRESENTATION === '1' || programAudioEnabled;
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

const differentialMeanVolume = async (
  filePath: string,
  start: number,
  duration: number,
): Promise<number> => {
  const result = await runProcess(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostats',
      '-ss',
      String(start),
      '-t',
      String(duration),
      '-i',
      filePath,
      '-af',
      'pan=mono|c0=c0-c1,volumedetect',
      '-f',
      'null',
      '-',
    ],
    'smoke_audio_analysis_failure',
  );
  const match = /mean_volume:\s*(-?[0-9.]+) dB/.exec(result.stderr);
  if (!match) throw new Error('Differential music measurement is unavailable');
  return Number(match[1]);
};

interface RegionStats {
  mean_rgb: [number, number, number];
  bright_pixels: number;
  pixel_count: number;
}

const extractRegionStats = async (
  filePath: string,
  seconds: number,
  region: { x: number; y: number; width: number; height: number },
): Promise<RegionStats> =>
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
      `crop=${region.width}:${region.height}:${region.x}:${region.y}`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ]);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const value = Buffer.concat(stdout);
      const pixelCount = region.width * region.height;
      if (code !== 0 || value.length !== pixelCount * 3) {
        reject(
          new Error(
            `frame region extraction failed: ${Buffer.concat(stderr).toString('utf8').trim()}`,
          ),
        );
        return;
      }
      const sums = [0, 0, 0];
      let brightPixels = 0;
      for (let offset = 0; offset < value.length; offset += 3) {
        const red = value[offset]!;
        const green = value[offset + 1]!;
        const blue = value[offset + 2]!;
        sums[0]! += red;
        sums[1]! += green;
        sums[2]! += blue;
        if (red >= 90 && green >= 90 && blue >= 90) brightPixels += 1;
      }
      resolve({
        mean_rgb: sums.map((sum) => Math.round(sum / pixelCount)) as [number, number, number],
        bright_pixels: brightPixels,
        pixel_count: pixelCount,
      });
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
  const musicPath = path.join(temporary, 'music.wav');
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
        programAudioEnabled
          ? 'aevalsrc=if(between(t\\,0.5\\,3)+between(t\\,7\\,9)\\,0.18*sin(2*PI*440*t)\\,0):s=48000:d=12'
          : `sine=frequency=440:sample_rate=48000:duration=${hybrid ? 12 : 6}`,
        '-c:a',
        'pcm_s16le',
        '-y',
        narrationPath,
      ],
      'smoke_fixture_failure',
    );
  }
  if (programAudioEnabled) {
    await runProcess(
      'ffmpeg',
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'aevalsrc=0.12*sin(2*PI*220*t)|0.12*sin(2*PI*330*t):s=48000:d=12',
        '-c:a',
        'pcm_s24le',
        '-y',
        musicPath,
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
  const musicSha = programAudioEnabled ? await sha256File(musicPath) : null;
  const musicStat = programAudioEnabled ? await stat(musicPath) : null;
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
  const presentationContent = {
    schema_version: 'presentation_spec_v1',
    strategy_version: 'longform_presentation_v1',
    profile_id: 'longform_professional_v1',
    captions: {
      policy_version: 'caption_policy_v1',
      preset: 'subtle_longform_v1',
      cues: [
        {
          text: 'Synthetic narration caption',
          start_seconds: 0.2,
          end_seconds: Math.min(duration, 2.2),
          preset: 'subtle_longform_v1',
        },
      ],
    },
    section_titles: [
      {
        text: 'Synthetic section',
        start_seconds: duration / 2,
        end_seconds: Math.min(duration, duration / 2 + 2.4),
        preset: 'minimal_section_v1',
      },
    ],
    branding: {
      preset: 'text_watermark_v1',
      enabled: true,
      text: 'NEOVIDS SMOKE',
      placement: 'top_right',
      opacity: 0.5,
    },
    transitions: [
      {
        type: 'fade_to_black',
        boundary_seconds: duration / 2,
        duration_seconds: 0.3,
        preset: 'section_boundary_fade_v1',
      },
    ],
  };
  const presentation = presentationEnabled
    ? { ...presentationContent, fingerprint: fingerprint(presentationContent) }
    : null;
  const audioMixContent =
    programAudioEnabled && musicSha && musicStat
      ? {
          schema_version: 'audio_mix_plan_v1',
          strategy_version: 'longform_program_audio_v1',
          profile_id: 'music_mix_profile_v1_candidate',
          duration_seconds: duration,
          narration: {
            sha256: narrationSha,
            duration_seconds: duration,
            sample_rate: 48_000,
            channels: 1,
          },
          music: {
            enabled: true,
            asset: {
              asset_id: 'synthetic-smoke-v1',
              sha256: musicSha,
              byte_size: musicStat.size,
              content_type: 'audio/wav',
              format: 'wav',
              duration_seconds: duration,
              sample_rate: 48_000,
              channels: 2,
              integrated_lufs: -21.4,
              true_peak_dbtp: -18.4,
              moods: ['analytical'],
              styles: ['documentary'],
              energy: 0.4,
              vocals: false,
              loopable: true,
              source_owner: 'NeoVids synthetic smoke',
              source_reference: 'FFmpeg deterministic dual-tone fixture',
              license_type: 'owned',
              monetization_allowed: true,
              attribution_required: false,
              attribution_text: null,
            },
            source_start_seconds: 0,
            source_end_seconds: duration,
            loop_policy: 'no_loop_v1',
            normalization_policy: 'music_loudnorm_v1',
            normalization_target_lufs: -23,
            segments: [
              {
                start_seconds: 0,
                end_seconds: duration,
                gain_adjustment_db: 0,
                fade_in_seconds: 0.25,
                fade_out_seconds: 0.25,
                transition_preset: 'smooth_v1',
              },
            ],
          },
          ducking: {
            policy_version: 'speech_envelope_v1',
            base_gain_db: -9,
            ducked_gain_db: -20,
            attack_seconds: 0.25,
            release_seconds: 0.5,
            merge_gap_seconds: 0.35,
            speech_regions: [
              { start_seconds: 0.5, end_seconds: 3 },
              { start_seconds: 7, end_seconds: 9 },
            ],
          },
          program_master: {
            profile_id: 'youtube_program_master_v1_candidate',
            policy_version: 'ffmpeg_loudnorm_two_pass_v1',
            target_lufs: -14,
            max_true_peak_dbtp: -1,
            target_lra: 11,
          },
          output: {
            profile_id: 'youtube_1080p30_program_audio_v1',
            codec: 'aac',
            bitrate: '192k',
            sample_rate: 48_000,
            channels: 2,
          },
        }
      : null;
  const audioMixPlan = audioMixContent
    ? { ...audioMixContent, fingerprint: fingerprint(audioMixContent) }
    : null;
  const upstream = Fastify({ logger: false });
  upstream.get(`/workflow/${WORKFLOW_ID}/production-timeline`, async () => timeline);
  upstream.get(`/workflow/${WORKFLOW_ID}/composer-render-input`, async () => ({
    schema_version: programAudioEnabled ? 'composer_render_input_v2' : 'composer_render_input_v1',
    production_timeline: timeline,
    presentation,
    ...(audioMixPlan ? { audio_mix_plan: audioMixPlan } : {}),
  }));
  upstream.get(
    `/workflow/${WORKFLOW_ID}/audio`,
    async (_request, reply) => await reply.type('audio/wav').send(createReadStream(narrationPath)),
  );
  upstream.get(
    `/workflow/${WORKFLOW_ID}/music-assets/synthetic-smoke-v1`,
    async (_request, reply) => await reply.type('audio/wav').send(createReadStream(musicPath)),
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
        'Idempotency-Key': presentationEnabled
          ? programAudioEnabled
            ? 'program-audio-engine-smoke'
            : 'presentation-engine-smoke'
          : hybrid
            ? 'hybrid-engine-smoke'
            : 'stage16-engine-smoke',
      },
      body: JSON.stringify({
        workflow_id: WORKFLOW_ID,
        render_profile: programAudioEnabled
          ? 'youtube_1080p30_program_audio_v1'
          : 'youtube_1080p30_v1',
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
        : presentationEnabled
          ? programAudioEnabled
            ? 'program-audio-engine-render.mp4'
            : 'presentation-engine-render.mp4'
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
    const frameCount = Number(video.nb_frames);
    const expectedFrameCount = Math.ceil(duration * 30);
    if (!Number.isInteger(frameCount) || frameCount !== expectedFrameCount) {
      throw new Error(`Frame count mismatch: ${frameCount} != ${expectedFrameCount}`);
    }
    const overlayValidation = presentationEnabled
      ? {
          captions: await extractRegionStats(outputPath, 1, {
            x: 300,
            y: 840,
            width: 1320,
            height: 190,
          }),
          section_title: await extractRegionStats(outputPath, duration / 2 + 1, {
            x: 70,
            y: 90,
            width: 1250,
            height: 190,
          }),
          branding: await extractRegionStats(outputPath, segment + 1, {
            x: 1420,
            y: 40,
            width: 400,
            height: 110,
          }),
          fade_to_black: await extractPixel(outputPath, duration / 2),
        }
      : null;
    if (
      overlayValidation &&
      (overlayValidation.captions.bright_pixels < 100 ||
        overlayValidation.section_title.bright_pixels < 100 ||
        overlayValidation.branding.bright_pixels < 50 ||
        Math.max(...overlayValidation.fade_to_black) > 20)
    ) {
      throw new Error(
        `Presentation overlay inspection failed: ${JSON.stringify(overlayValidation)}`,
      );
    }
    const programAudioMetrics = programAudioEnabled
      ? ((completed.metrics as Record<string, unknown>).programAudio as Record<string, unknown>)
      : null;
    const duckingMeasurement = programAudioEnabled
      ? {
          speech_mean_db: await differentialMeanVolume(outputPath, 1.2, 0.8),
          pause_mean_db: await differentialMeanVolume(outputPath, 4.2, 0.8),
        }
      : null;
    if (
      programAudioEnabled &&
      (audio.channels !== 2 ||
        !programAudioMetrics ||
        !duckingMeasurement ||
        duckingMeasurement.pause_mean_db - duckingMeasurement.speech_mean_db < 7)
    ) {
      throw new Error(
        `Program Audio validation failed: ${JSON.stringify({ audio, programAudioMetrics, duckingMeasurement })}`,
      );
    }
    const cacheResponse = await fetch(`${baseUrl}/v1/renders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': presentationEnabled
          ? programAudioEnabled
            ? 'program-audio-cache-smoke'
            : 'presentation-cache-smoke'
          : hybrid
            ? 'hybrid-cache-smoke'
            : 'stage16-cache-smoke',
      },
      body: JSON.stringify({
        workflow_id: WORKFLOW_ID,
        render_profile: programAudioEnabled
          ? 'youtube_1080p30_program_audio_v1'
          : 'youtube_1080p30_v1',
        mode: 'preview',
      }),
    });
    const cacheCreated = (await cacheResponse.json()) as { id: string };
    const cacheCompleted = await waitForRender(baseUrl, cacheCreated.id);
    const engineMetrics = completed.metrics as Record<string, unknown>;
    const cacheMetrics = cacheCompleted.metrics as Record<string, unknown>;
    const expectedPresentationFingerprint = presentation?.fingerprint ?? null;
    if (
      presentationEnabled &&
      (completed.presentation_fingerprint !== expectedPresentationFingerprint ||
        cacheCompleted.presentation_fingerprint !== expectedPresentationFingerprint ||
        completed.production_timeline_fingerprint !==
          cacheCompleted.production_timeline_fingerprint ||
        engineMetrics.composerStrategyVersion !==
          (programAudioEnabled
            ? 'video_composer_v4_program_audio'
            : 'video_composer_v3_presentation') ||
        cacheMetrics.composerStrategyVersion !==
          (programAudioEnabled
            ? 'video_composer_v4_program_audio'
            : 'video_composer_v3_presentation'))
    ) {
      throw new Error(
        `Presentation identity validation failed: ${JSON.stringify({ completed, cacheCompleted })}`,
      );
    }
    const result = {
      smoke: realNarrationUrl
        ? 'REAL_NARRATION_RENDER_SMOKE'
        : presentationEnabled
          ? programAudioEnabled
            ? 'PROGRAM_AUDIO_RENDER_SMOKE'
            : 'PRESENTATION_RENDER_SMOKE'
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
      audio_channels: audio.channels,
      duration_seconds: mediaDuration(outputProbe),
      frame_count: frameCount,
      expected_frame_count: expectedFrameCount,
      byte_size: (await stat(outputPath)).size,
      sha256: await sha256File(outputPath),
      wall_seconds: wallSeconds,
      render_factor: wallSeconds / duration,
      engine_metrics: completed.metrics,
      second_render_cache_metrics: cacheCompleted.metrics,
      manifest_schema_version: presentationEnabled
        ? programAudioEnabled
          ? 'render_manifest_v4'
          : 'render_manifest_v3'
        : hybrid
          ? 'render_manifest_v2'
          : 'render_manifest_v1',
      presentation_strategy_version: presentationEnabled
        ? presentationContent.strategy_version
        : null,
      presentation_fingerprint: completed.presentation_fingerprint ?? null,
      audio_mix_plan_fingerprint: completed.audio_mix_plan_fingerprint ?? null,
      program_audio_metrics: programAudioMetrics,
      ducking_measurement: duckingMeasurement,
      manifest_fingerprint: completed.manifest_fingerprint,
      render_fingerprint: completed.render_fingerprint,
      second_manifest_fingerprint: cacheCompleted.manifest_fingerprint,
      second_render_fingerprint: cacheCompleted.render_fingerprint,
      content_fingerprints_stable: {
        production_timeline:
          completed.production_timeline_fingerprint ===
          cacheCompleted.production_timeline_fingerprint,
        presentation:
          completed.presentation_fingerprint === cacheCompleted.presentation_fingerprint,
        audio_mix_plan:
          completed.audio_mix_plan_fingerprint === cacheCompleted.audio_mix_plan_fingerprint,
      },
      inspected_pixels: {
        video_one: beginning,
        image_one: imageOne,
        video_two: videoTwo,
        image_two: ending,
      },
      overlay_validation: overlayValidation,
      gameplay_audio_streams_in_proxy: 0,
      final_audio_streams: outputProbe.streams.filter((item) => item.codec_type === 'audio').length,
    };
    await writeFile(
      path.join(
        persistentRoot,
        realNarrationUrl
          ? 'real-narration.json'
          : presentationEnabled
            ? programAudioEnabled
              ? 'program-audio-engine.json'
              : 'presentation-engine.json'
            : hybrid
              ? 'hybrid-engine.json'
              : 'engine.json',
      ),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const composerLogs = Buffer.concat(childLogs).toString('utf8').trim();
    if (composerLogs) {
      process.stderr.write(
        `VIDEO_COMPOSER_CHILD_LOGS_BEGIN\n${composerLogs}\nVIDEO_COMPOSER_CHILD_LOGS_END\n`,
      );
    }
    throw error;
  } finally {
    child?.kill('SIGTERM');
    await upstream.close();
  }
};

await main();
