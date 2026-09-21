import { stat } from 'node:fs/promises';

import type { AppConfig } from '../core/config.js';
import { ComposerError, type InternalErrorDiagnostics } from '../core/errors.js';
import { sha256File } from '../core/identity.js';
import type { RenderManifest } from '../domain/contracts.js';
import { mediaDuration, probeMediaWithFrameCount, rational } from './probe.js';

export interface ValidatedOutput {
  sha256: string;
  byteSize: number;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  frameCount: number | null;
  videoCodec: string;
  audioCodec: string;
  audioSampleRate: number;
  audioChannels: number;
}

export interface ValidationDiagnostics {
  expected_frame_count: number;
  actual_frame_count: number | null;
  frame_delta: number | null;
  expected_duration_seconds: number;
  actual_duration_seconds: number | null;
  duration_delta_seconds: number | null;
  duration_tolerance_seconds: number;
  expected_fps: number;
  actual_fps: number | null;
  video_codec: string | null;
  pixel_format: string | null;
  width: number | null;
  height: number | null;
  audio_codec: string | null;
  audio_sample_rate: number | null;
  audio_channels: number | null;
  mismatches?: string[];
}

const logValidationDiagnostics = (diagnostics: ValidationDiagnostics): void => {
  console.info(
    JSON.stringify({
      level: 'error',
      event: 'output_validation_diagnostics',
      ...diagnostics,
    }),
  );
};

export const validateOutput = async (
  config: AppConfig,
  filePath: string,
  manifest: RenderManifest,
): Promise<ValidatedOutput> => {
  const details = await stat(filePath).catch(() => null);
  if (!details?.isFile() || details.size <= 0) {
    throw new ComposerError('output_validation_failure', 'Rendered output is missing');
  }
  // Use frame-counting probe for accurate validation
  const probe = await probeMediaWithFrameCount(config.ffprobeBinary, filePath);
  const videos = probe.streams.filter((item) => item.codec_type === 'video');
  const audios = probe.streams.filter((item) => item.codec_type === 'audio');
  const video = videos[0];
  const audio = audios[0];
  const duration = mediaDuration(probe);
  const fps = rational(video?.avg_frame_rate ?? video?.r_frame_rate);
  const tolerance = 1 / manifest.render_profile.fps + 0.005;

  // Use nb_read_frames preferentially for authoritative frame count
  const frameCountFromRead = video?.nb_read_frames ? Number(video.nb_read_frames) : null;
  const frameCount = frameCountFromRead ?? (video?.nb_frames ? Number(video.nb_frames) : null);

  // Prepare diagnostics for logging
  const diagnostics: ValidationDiagnostics = {
    expected_frame_count: manifest.duration_in_frames,
    actual_frame_count: frameCount,
    frame_delta: frameCount !== null ? frameCount - manifest.duration_in_frames : null,
    expected_duration_seconds: manifest.duration_seconds,
    actual_duration_seconds: duration,
    duration_delta_seconds: duration !== null ? duration - manifest.duration_seconds : null,
    duration_tolerance_seconds: tolerance,
    expected_fps: manifest.render_profile.fps,
    actual_fps: fps,
    video_codec: video?.codec_name ?? null,
    pixel_format: video?.pix_fmt ?? null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    audio_codec: audio?.codec_name ?? null,
    audio_sample_rate: audio?.sample_rate ? Number(audio.sample_rate) : null,
    audio_channels: audio?.channels ?? null,
  };

  const mismatches: string[] = [];
  if (videos.length !== 1) mismatches.push('video_stream_count');
  if (audios.length !== 1) mismatches.push('audio_stream_count');
  if (!video || video.codec_name !== 'h264') mismatches.push('video_codec');
  if (!video || video.pix_fmt !== 'yuv420p') {
    mismatches.push(`pixel_format(${video?.pix_fmt ?? 'missing'})`);
  }
  if (
    !video ||
    video.width !== manifest.render_profile.width ||
    video.height !== manifest.render_profile.height
  ) {
    mismatches.push('resolution');
  }
  if (fps === null || Math.abs(fps - manifest.render_profile.fps) > 0.001) {
    mismatches.push('fps');
  }
  if (!audio || audio.codec_name !== 'aac') mismatches.push('audio_codec');
  if (!audio || Number(audio.sample_rate) !== 48_000) mismatches.push('audio_sample_rate');
  const expectedChannels = manifest.schema_version === 'render_manifest_v4' ? 2 : 1;
  if (!audio || audio.channels !== expectedChannels) mismatches.push('audio_channels');
  if (duration === null || Math.abs(duration - manifest.duration_seconds) > tolerance) {
    mismatches.push(
      `duration(${duration?.toFixed(6) ?? 'missing'}!=${manifest.duration_seconds.toFixed(6)})`,
    );
  }
  if (frameCount !== null && frameCount !== manifest.duration_in_frames) {
    mismatches.push('frame_count');
  }
  // When exact frame count is required but not available, fail closed
  if (frameCount === null) {
    mismatches.push('frame_count_unavailable');
  }

  if (mismatches.length > 0 || !video || !audio || duration === null || fps === null) {
    // Include mismatches in diagnostics
    diagnostics.mismatches = mismatches;
    // Always log detailed diagnostics on validation failure
    logValidationDiagnostics(diagnostics);
    throw new ComposerError(
      'output_validation_failure',
      `Rendered MP4 profile mismatch: ${mismatches.join(',')}`,
      500,
      { diagnostics: diagnostics as unknown as InternalErrorDiagnostics },
    );
  }

  return {
    sha256: await sha256File(filePath),
    byteSize: details.size,
    durationSeconds: duration,
    width: video.width!,
    height: video.height!,
    fps,
    frameCount,
    videoCodec: video.codec_name!,
    audioCodec: audio.codec_name!,
    audioSampleRate: Number(audio.sample_rate),
    audioChannels: audio.channels!,
  };
};
