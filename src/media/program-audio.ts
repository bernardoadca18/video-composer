import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { AppConfig } from '../core/config.js';
import { ComposerError } from '../core/errors.js';
import { fingerprint, sha256File } from '../core/identity.js';
import type { AudioMixPlan, RenderManifestV4 } from '../domain/contracts.js';
import type { CachedFile } from '../storage/atomic-cache.js';
import { withFileLock } from '../storage/atomic-cache.js';
import { probeMedia, mediaDuration } from './probe.js';
import { runProcess } from './process.js';

export interface LoudnessMeasurement {
  integratedLufs: number;
  truePeakDbtp: number;
  loudnessRangeLu: number;
  threshold: number;
  offset: number;
}

export interface ProgramAudioResult {
  path: string;
  mixPath: string;
  normalizedMusicCacheHit: boolean | null;
  mixCacheHit: boolean;
  masterCacheHit: boolean;
  mixSha256: string;
  masterSha256: string;
  before: LoudnessMeasurement;
  after: LoudnessMeasurement;
  toolIdentity: string;
}

interface AudioCacheMetadata {
  schema: 'program_audio_cache_v1';
  sha256: string;
  byteSize: number;
  durationSeconds: number;
  channels: 2;
  sampleRate: 48000;
  measurement?: LoudnessMeasurement;
}

const finite = (value: unknown, field: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ComposerError('program_master_failed', `Invalid loudness measurement: ${field}`);
  }
  return parsed;
};

const parseLoudnorm = (stderr: string): LoudnessMeasurement => {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new ComposerError('program_master_failed', 'FFmpeg loudness measurement failed');
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(stderr.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new ComposerError('program_master_failed', 'FFmpeg loudness response is invalid');
  }
  return {
    integratedLufs: finite(raw.input_i, 'integrated loudness'),
    truePeakDbtp: finite(raw.input_tp, 'true peak'),
    loudnessRangeLu: finite(raw.input_lra, 'loudness range'),
    threshold: finite(raw.input_thresh, 'threshold'),
    offset: finite(raw.target_offset, 'offset'),
  };
};

const validateStereoWav = async (
  config: AppConfig,
  filePath: string,
  expectedDuration: number,
): Promise<void> => {
  const probe = await probeMedia(config.ffprobeBinary, filePath);
  const audio = probe.streams.filter((item) => item.codec_type === 'audio');
  const duration = mediaDuration(probe);
  if (
    audio.length !== 1 ||
    audio[0]?.codec_name?.startsWith('pcm_') !== true ||
    Number(audio[0]?.sample_rate) !== 48_000 ||
    audio[0]?.channels !== 2 ||
    duration === null ||
    Math.abs(duration - expectedDuration) > 0.02
  ) {
    throw new ComposerError('program_audio_validation_failed', 'Program WAV is invalid');
  }
};

const cachedAudio = async (
  config: AppConfig,
  key: string,
  durationSeconds: number,
  build: (temporary: string) => Promise<LoudnessMeasurement | undefined>,
): Promise<{ file: CachedFile; cacheHit: boolean; measurement?: LoudnessMeasurement }> => {
  const target = path.join(config.programAudioCacheRoot, `${key}.wav`);
  const sidecar = `${target}.json`;
  return await withFileLock(`${target}.lock`, async () => {
    try {
      const metadata = JSON.parse(await readFile(sidecar, 'utf8')) as AudioCacheMetadata;
      const details = await stat(target);
      if (
        metadata.schema === 'program_audio_cache_v1' &&
        details.isFile() &&
        details.size === metadata.byteSize &&
        (await sha256File(target)) === metadata.sha256
      ) {
        await validateStereoWav(config, target, durationSeconds);
        return {
          file: {
            path: target,
            cacheHit: true,
            byteSize: details.size,
            sha256: metadata.sha256,
          },
          cacheHit: true,
          ...(metadata.measurement ? { measurement: metadata.measurement } : {}),
        };
      }
    } catch {
      await unlink(target).catch(() => undefined);
      await unlink(sidecar).catch(() => undefined);
    }
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp.wav`;
    const temporarySidecar = `${sidecar}.${randomUUID()}.tmp`;
    try {
      const measurement = await build(temporary);
      await validateStereoWav(config, temporary, durationSeconds);
      const details = await stat(temporary);
      const sha256 = await sha256File(temporary);
      const metadata: AudioCacheMetadata = {
        schema: 'program_audio_cache_v1',
        sha256,
        byteSize: details.size,
        durationSeconds,
        channels: 2,
        sampleRate: 48_000,
        ...(measurement ? { measurement } : {}),
      };
      await writeFile(temporarySidecar, JSON.stringify(metadata), { flag: 'wx' });
      await rename(temporary, target);
      await rename(temporarySidecar, sidecar);
      return {
        file: { path: target, cacheHit: false, byteSize: details.size, sha256 },
        cacheHit: false,
        ...(measurement ? { measurement } : {}),
      };
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      await unlink(temporarySidecar).catch(() => undefined);
      throw error;
    }
  });
};

const loudnessFilter = (target: number, peak: number, lra: number): string =>
  `loudnorm=I=${target}:TP=${peak}:LRA=${lra}:print_format=json`;

export const measureLoudness = async (
  config: AppConfig,
  filePath: string,
  plan: AudioMixPlan,
): Promise<LoudnessMeasurement> => {
  const result = await runProcess(
    config.ffmpegBinary,
    [
      '-hide_banner',
      '-nostats',
      '-i',
      filePath,
      '-af',
      loudnessFilter(
        plan.program_master.target_lufs,
        plan.program_master.max_true_peak_dbtp,
        plan.program_master.target_lra,
      ),
      '-f',
      'null',
      '-',
    ],
    'program_master_failed',
  );
  return parseLoudnorm(result.stderr);
};

const normalizeTwoPass = async (
  config: AppConfig,
  input: string,
  output: string,
  target: number,
  peak: number,
  lra: number,
  category: string,
): Promise<LoudnessMeasurement> => {
  const measured = parseLoudnorm(
    (
      await runProcess(
        config.ffmpegBinary,
        [
          '-hide_banner',
          '-nostats',
          '-i',
          input,
          '-af',
          loudnessFilter(target, peak, lra),
          '-f',
          'null',
          '-',
        ],
        category,
      )
    ).stderr,
  );
  const filter =
    `loudnorm=I=${target}:TP=${peak}:LRA=${lra}` +
    `:measured_I=${measured.integratedLufs}:measured_TP=${measured.truePeakDbtp}` +
    `:measured_LRA=${measured.loudnessRangeLu}:measured_thresh=${measured.threshold}` +
    `:offset=${measured.offset}:linear=true:print_format=json`;
  await runProcess(
    config.ffmpegBinary,
    [
      '-hide_banner',
      '-nostats',
      '-y',
      '-i',
      input,
      '-af',
      filter,
      '-ar',
      '48000',
      '-ac',
      '2',
      '-c:a',
      'pcm_s24le',
      output,
    ],
    category,
  );
  return measured;
};

const n = (value: number): string => value.toFixed(6);
const dbAmplitude = (value: number): number => 10 ** (value / 20);
const escapeExpression = (value: string): string => value.replaceAll(',', '\\,');

const duckExpression = (plan: AudioMixPlan): string => {
  const ratio = dbAmplitude(plan.ducking.ducked_gain_db - plan.ducking.base_gain_db);
  const expressions = plan.ducking.speech_regions.map((region) => {
    const attackStart = Math.max(0, region.start_seconds - plan.ducking.attack_seconds);
    const releaseEnd = Math.min(
      plan.duration_seconds,
      region.end_seconds + plan.ducking.release_seconds,
    );
    const attackDuration = Math.max(0.000001, region.start_seconds - attackStart);
    const releaseDuration = Math.max(0.000001, releaseEnd - region.end_seconds);
    return (
      `if(between(t,${n(attackStart)},${n(region.start_seconds)}),` +
      `1-(1-${n(ratio)})*(t-${n(attackStart)})/${n(attackDuration)},` +
      `if(between(t,${n(region.start_seconds)},${n(region.end_seconds)}),${n(ratio)},` +
      `if(between(t,${n(region.end_seconds)},${n(releaseEnd)}),` +
      `${n(ratio)}+(1-${n(ratio)})*(t-${n(region.end_seconds)})/${n(releaseDuration)},1)))`
    );
  });
  return expressions.length ? `min(${expressions.join(',')})` : '1';
};

const musicEnvelope = (plan: AudioMixPlan): string => {
  if (!plan.music.enabled) return '0';
  const duck = duckExpression(plan);
  return plan.music.segments
    .map((segment) => {
      const gain = dbAmplitude(plan.ducking.base_gain_db + segment.gain_adjustment_db);
      const fadeInEnd = segment.start_seconds + segment.fade_in_seconds;
      const fadeOutStart = segment.end_seconds - segment.fade_out_seconds;
      const fadeIn =
        segment.fade_in_seconds > 0
          ? `if(lt(t,${n(fadeInEnd)}),(t-${n(segment.start_seconds)})/${n(segment.fade_in_seconds)},1)`
          : '1';
      const fadeOut =
        segment.fade_out_seconds > 0
          ? `if(gt(t,${n(fadeOutStart)}),(${n(segment.end_seconds)}-t)/${n(segment.fade_out_seconds)},1)`
          : '1';
      return (
        `if(between(t,${n(segment.start_seconds)},${n(segment.end_seconds)}),` +
        `${n(gain)}*${fadeIn}*${fadeOut}*${duck},0)`
      );
    })
    .join('+');
};

export class ProgramAudioProcessor {
  private toolIdentity: string | null = null;

  constructor(private readonly config: AppConfig) {}

  private async ffmpegIdentity(): Promise<string> {
    if (this.toolIdentity) return this.toolIdentity;
    const result = await runProcess(this.config.ffmpegBinary, ['-version'], 'ffmpeg_unavailable');
    this.toolIdentity = fingerprint({ first_line: result.stdout.split('\n')[0] ?? 'unknown' });
    return this.toolIdentity;
  }

  async prepare(
    manifest: RenderManifestV4,
    narrationPath: string,
    musicSource: CachedFile | null,
  ): Promise<ProgramAudioResult> {
    const plan = manifest.audio_mix_plan;
    const toolIdentity = await this.ffmpegIdentity();
    let normalizedMusicPath: string | null = null;
    let normalizedMusicCacheHit: boolean | null = null;
    if (plan.music.enabled) {
      const musicPlan = plan.music;
      if (!musicSource) {
        throw new ComposerError('music_asset_unavailable', 'Music asset is unavailable');
      }
      const normalizationKey = fingerprint({
        source_sha256: musicPlan.asset.sha256,
        policy: musicPlan.normalization_policy,
        target_lufs: musicPlan.normalization_target_lufs,
        tool_identity: toolIdentity,
      });
      const normalized = await cachedAudio(
        this.config,
        `music-${normalizationKey}`,
        musicPlan.asset.duration_seconds,
        async (temporary) => {
          await normalizeTwoPass(
            this.config,
            musicSource.path,
            temporary,
            musicPlan.normalization_target_lufs,
            -2,
            11,
            'music_normalization_failed',
          );
          return undefined;
        },
      );
      normalizedMusicPath = normalized.file.path;
      normalizedMusicCacheHit = normalized.cacheHit;
    }

    const mixKey = fingerprint({
      narration_sha256: plan.narration.sha256,
      audio_mix_plan_fingerprint: plan.fingerprint,
      normalized_music_sha256: normalizedMusicPath ? await sha256File(normalizedMusicPath) : null,
      mix_policy: 'program_mix_pcm_v1',
      tool_identity: toolIdentity,
    });
    const mixed = await cachedAudio(
      this.config,
      `mix-${mixKey}`,
      plan.duration_seconds,
      async (temporary) => {
        const args = ['-hide_banner', '-nostats', '-y', '-i', narrationPath];
        if (plan.music.enabled && normalizedMusicPath) {
          if (plan.music.loop_policy === 'repeat_from_start_v1') args.push('-stream_loop', '-1');
          args.push('-i', normalizedMusicPath);
          const envelope = escapeExpression(musicEnvelope(plan));
          args.push(
            '-filter_complex',
            `[0:a]atrim=0:${n(plan.duration_seconds)},aresample=48000,` +
              `aformat=sample_fmts=fltp:channel_layouts=mono,pan=stereo|c0=c0|c1=c0[n];` +
              `[1:a]atrim=0:${n(plan.duration_seconds)},asetpts=PTS-STARTPTS,aresample=48000,` +
              `aformat=sample_fmts=fltp:channel_layouts=stereo,` +
              `volume='${envelope}':eval=frame[m];` +
              `[n][m]amix=inputs=2:duration=first:normalize=0,` +
              `atrim=0:${n(plan.duration_seconds)}[a]`,
            '-map',
            '[a]',
          );
        } else {
          args.push(
            '-filter_complex',
            `[0:a]atrim=0:${n(plan.duration_seconds)},aresample=48000,` +
              'aformat=sample_fmts=fltp:channel_layouts=mono,pan=stereo|c0=c0|c1=c0[a]',
            '-map',
            '[a]',
          );
        }
        args.push('-ar', '48000', '-ac', '2', '-c:a', 'pcm_s24le', temporary);
        await runProcess(this.config.ffmpegBinary, args, 'program_mix_failed');
        return await measureLoudness(this.config, temporary, plan);
      },
    );
    const before = mixed.measurement ?? (await measureLoudness(this.config, mixed.file.path, plan));

    const masterKey = fingerprint({
      mixed_sha256: mixed.file.sha256,
      audio_mix_plan_fingerprint: plan.fingerprint,
      program_master: plan.program_master,
      tool_identity: toolIdentity,
    });
    const mastered = await cachedAudio(
      this.config,
      `master-${masterKey}`,
      plan.duration_seconds,
      async (temporary) => {
        await normalizeTwoPass(
          this.config,
          mixed.file.path,
          temporary,
          plan.program_master.target_lufs,
          plan.program_master.max_true_peak_dbtp,
          plan.program_master.target_lra,
          'program_master_failed',
        );
        const measurement = await measureLoudness(this.config, temporary, plan);
        if (
          Math.abs(measurement.integratedLufs - plan.program_master.target_lufs) > 0.6 ||
          measurement.truePeakDbtp > plan.program_master.max_true_peak_dbtp + 0.1
        ) {
          throw new ComposerError(
            'program_audio_validation_failed',
            'Program master violates loudness policy',
          );
        }
        return measurement;
      },
    );
    const after =
      mastered.measurement ?? (await measureLoudness(this.config, mastered.file.path, plan));
    return {
      path: mastered.file.path,
      mixPath: mixed.file.path,
      normalizedMusicCacheHit,
      mixCacheHit: mixed.cacheHit,
      masterCacheHit: mastered.cacheHit,
      mixSha256: mixed.file.sha256,
      masterSha256: mastered.file.sha256,
      before,
      after,
      toolIdentity,
    };
  }

  async mux(
    videoPath: string,
    audioPath: string,
    outputPath: string,
    plan: AudioMixPlan,
  ): Promise<void> {
    // Calculate quantized video duration from frame count
    const videoDurationSeconds = plan.duration_seconds;
    await this.muxPcm(
      videoPath,
      audioPath,
      outputPath,
      videoDurationSeconds,
      plan.output.channels,
    );
  }

  async muxNarration(
    videoPath: string,
    narrationPath: string,
    outputPath: string,
    durationSeconds: number,
  ): Promise<void> {
    await this.muxPcm(videoPath, narrationPath, outputPath, durationSeconds, 1);
  }

  private async muxPcm(
    videoPath: string,
    audioPath: string,
    outputPath: string,
    videoDurationSeconds: number,
    channels: 1 | 2,
  ): Promise<void> {
    // Video stream is authoritative - never truncate it.
    // Audio is padded/trimmed to match quantized video duration.
    // This preserves exact frame count from Remotion render.
    await runProcess(
      this.config.ffmpegBinary,
      [
        '-hide_banner',
        '-nostats',
        '-y',
        '-i',
        videoPath,
        '-i',
        audioPath,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c:v',
        'copy',
        '-filter_complex',
        `[1:a]atrim=0:${n(videoDurationSeconds)},apad=whole_dur=0:${n(videoDurationSeconds)},aformat=sample_rates=48000:channel_layouts=${channels === 2 ? 'stereo' : 'mono'}[a]`,
        '-map',
        '[a]',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-ar',
        '48000',
        '-ac',
        String(channels),
        '-movflags',
        '+faststart',
        outputPath,
      ],
      'program_audio_validation_failed',
    );
  }
}
