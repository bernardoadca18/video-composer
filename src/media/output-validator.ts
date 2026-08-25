import { stat } from 'node:fs/promises';

import type { AppConfig } from '../core/config.js';
import { ComposerError } from '../core/errors.js';
import { sha256File } from '../core/identity.js';
import type { RenderManifest } from '../domain/contracts.js';
import { mediaDuration, probeMedia, rational } from './probe.js';

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
}

export const validateOutput = async (
  config: AppConfig,
  filePath: string,
  manifest: RenderManifest,
): Promise<ValidatedOutput> => {
  const details = await stat(filePath).catch(() => null);
  if (!details?.isFile() || details.size <= 0) {
    throw new ComposerError('output_validation_failure', 'Rendered output is missing');
  }
  const probe = await probeMedia(config.ffprobeBinary, filePath);
  const videos = probe.streams.filter((item) => item.codec_type === 'video');
  const audios = probe.streams.filter((item) => item.codec_type === 'audio');
  const video = videos[0];
  const audio = audios[0];
  const duration = mediaDuration(probe);
  const fps = rational(video?.avg_frame_rate ?? video?.r_frame_rate);
  const frameCount = video?.nb_frames ? Number(video.nb_frames) : null;
  const tolerance = 1 / manifest.render_profile.fps + 0.005;
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
  if (duration === null || Math.abs(duration - manifest.duration_seconds) > tolerance) {
    mismatches.push(
      `duration(${duration?.toFixed(6) ?? 'missing'}!=${manifest.duration_seconds.toFixed(6)})`,
    );
  }
  if (frameCount !== null && frameCount !== manifest.duration_in_frames) {
    mismatches.push('frame_count');
  }
  if (mismatches.length > 0 || !video || !audio || duration === null || fps === null) {
    throw new ComposerError(
      'output_validation_failure',
      `Rendered MP4 profile mismatch: ${mismatches.join(',')}`,
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
  };
};
