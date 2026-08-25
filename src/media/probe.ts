import { z } from 'zod';

import { ComposerError } from '../core/errors.js';
import { runProcess } from './process.js';

const StreamSchema = z.object({
  index: z.number().int(),
  codec_type: z.string(),
  codec_name: z.string().optional(),
  pix_fmt: z.string().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  sample_rate: z.string().optional(),
  channels: z.number().int().optional(),
  avg_frame_rate: z.string().optional(),
  r_frame_rate: z.string().optional(),
  duration: z.string().optional(),
  nb_frames: z.string().optional(),
});

const ProbeSchema = z.object({
  streams: z.array(StreamSchema),
  format: z.object({ duration: z.string().optional(), size: z.string().optional() }),
});

export type ProbeResult = z.infer<typeof ProbeSchema>;
export type ProbeStream = ProbeResult['streams'][number];

export const rational = (value: string | undefined): number | null => {
  if (!value) return null;
  const [numerator, denominator] = value.split('/').map(Number);
  if (
    numerator === undefined ||
    denominator === undefined ||
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator === 0
  ) {
    return null;
  }
  return numerator / denominator;
};

export const mediaDuration = (probe: ProbeResult): number | null => {
  const formatDuration = Number(probe.format.duration);
  if (Number.isFinite(formatDuration) && formatDuration > 0) return formatDuration;
  const durations = probe.streams.map((item) => Number(item.duration)).filter((item) => item > 0);
  return durations.length ? Math.max(...durations) : null;
};

export const probeMedia = async (ffprobe: string, filePath: string): Promise<ProbeResult> => {
  const result = await runProcess(
    ffprobe,
    ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', filePath],
    'ffprobe_failure',
  );
  try {
    return ProbeSchema.parse(JSON.parse(result.stdout));
  } catch {
    throw new ComposerError('media_validation_failure', 'Invalid ffprobe response');
  }
};

export const validateNarration = async (
  ffprobe: string,
  filePath: string,
  expectedDuration: number,
): Promise<void> => {
  const probe = await probeMedia(ffprobe, filePath);
  const audio = probe.streams.filter((item) => item.codec_type === 'audio');
  const duration = mediaDuration(probe);
  if (audio.length !== 1 || duration === null || Math.abs(duration - expectedDuration) > 0.1) {
    throw new ComposerError('narration_validation_failure', 'Narration WAV is invalid');
  }
  if (Number(audio[0]?.sample_rate) !== 48_000) {
    throw new ComposerError('narration_validation_failure', 'Narration must be 48 kHz');
  }
};
