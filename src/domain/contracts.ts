import { z } from 'zod';

const Id = z.string().uuid();
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const Seconds = z.number().finite().nonnegative();

export const TimelineSourceSchema = z.object({
  source_type: z.string(),
  project_id: Id,
  session_id: Id,
  media_id: Id,
  candidate_start_seconds: Seconds,
  candidate_end_seconds: z.number().finite().positive(),
  source_start_seconds: Seconds,
  source_end_seconds: z.number().finite().positive(),
});

export const TimelinePlacementSchema = z.object({
  id: Id,
  order: z.number().int().nonnegative(),
  timeline_start_seconds: Seconds,
  timeline_end_seconds: z.number().finite().positive(),
  source: TimelineSourceSchema,
  playback_rate: z.number().finite(),
  transition: z.string(),
});

export const TimelineGapSchema = z.object({
  id: Id,
  order: z.number().int().nonnegative(),
  timeline_start_seconds: Seconds,
  timeline_end_seconds: z.number().finite().positive(),
  reason: z.string(),
  severity: z.string(),
});

export const NarrationTrackSchema = z.object({
  kind: z.literal('narration'),
  timeline_start_seconds: Seconds,
  timeline_end_seconds: z.number().finite().positive(),
  source_start_seconds: Seconds,
  source_end_seconds: z.number().finite().positive(),
  audio_url: z.string().startsWith('/workflow/'),
  audio_sha256: Sha256,
  sample_rate: z.number().int().positive().nullable(),
  channels: z.number().int().positive().nullable(),
  byte_size: z.number().int().positive().nullable(),
});

export const ProductionTimelineSchema = z.object({
  id: Id,
  workflow_id: Id,
  schema_version: z.string(),
  strategy_version: z.string(),
  fingerprint: Sha256,
  status: z.string(),
  duration_seconds: z.number().finite().positive(),
  tracks: z.object({
    narration: NarrationTrackSchema.nullable(),
    primary_visual: z.object({ placements: z.array(TimelinePlacementSchema) }),
  }),
  gaps: z.array(TimelineGapSchema),
  visual_coverage_ratio: z.number().finite().min(0).max(1),
});

export const MediaAssetMetadataSchema = z.object({
  id: Id,
  project_id: Id,
  original_filename: z.string().min(1),
  content_type: z.string().nullable(),
  byte_size: z.number().int().nonnegative(),
  sha256: Sha256,
  duration_seconds: z.number().finite().positive().nullable(),
  format_name: z.string().nullable(),
  video_codec: z.string().nullable(),
  audio_codec: z.string().nullable(),
  fps: z.number().finite().positive().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
});

export const RenderRequestSchema = z.object({
  workflow_id: Id,
  render_profile: z.string().default('youtube_1080p30_v1'),
  mode: z.enum(['preview', 'final']).default('final'),
});

export type ProductionTimeline = z.infer<typeof ProductionTimelineSchema>;
export type TimelinePlacement = z.infer<typeof TimelinePlacementSchema>;
export type MediaAssetMetadata = z.infer<typeof MediaAssetMetadataSchema>;
export type RenderRequest = z.infer<typeof RenderRequestSchema>;

export const RenderManifestSchema = z.object({
  schema_version: z.literal('render_manifest_v1'),
  composer_strategy_version: z.literal('video_composer_v1'),
  proxy_strategy_version: z.literal('clip_proxy_v1'),
  workflow_id: Id,
  production_timeline_id: Id,
  production_timeline_fingerprint: Sha256,
  mode: z.enum(['preview', 'final']),
  duration_seconds: z.number().finite().positive(),
  duration_in_frames: z.number().int().positive(),
  render_profile: z.object({
    name: z.literal('youtube_1080p30_v1'),
    identity: Sha256,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().int().positive(),
    fit_mode: z.literal('contain'),
    background_color: z.string(),
  }),
  narration: z.object({
    sha256: Sha256,
    byte_size: z.number().int().positive().nullable(),
    sample_rate: z.number().int().positive().nullable(),
    channels: z.number().int().positive().nullable(),
    asset_key: Sha256,
    asset_url: z.url(),
    frame_start: z.literal(0),
    frame_duration: z.number().int().positive(),
  }),
  source_assets: z.array(
    z.object({
      media_id: Id,
      project_id: Id,
      sha256: Sha256,
      byte_size: z.number().int().nonnegative(),
      content_type: z.string().nullable(),
    }),
  ),
  placements: z.array(
    z.object({
      id: Id,
      order: z.number().int().nonnegative(),
      frame_start: z.number().int().nonnegative(),
      frame_duration: z.number().int().positive(),
      timeline_start_microseconds: z.number().int().nonnegative(),
      timeline_end_microseconds: z.number().int().positive(),
      source: z.object({
        project_id: Id,
        session_id: Id,
        media_id: Id,
        sha256: Sha256,
        candidate_start_microseconds: z.number().int().nonnegative(),
        candidate_end_microseconds: z.number().int().positive(),
        source_start_microseconds: z.number().int().nonnegative(),
        source_end_microseconds: z.number().int().positive(),
        proxy_key: Sha256,
        proxy_url: z.url(),
      }),
      playback_rate: z.literal(1),
      transition: z.literal('cut'),
    }),
  ),
  gaps: z.array(
    z.object({
      id: Id,
      order: z.number().int().nonnegative(),
      frame_start: z.number().int().nonnegative(),
      frame_duration: z.number().int().positive(),
      reason: z.string(),
      severity: z.string(),
    }),
  ),
});

export type RenderManifest = z.infer<typeof RenderManifestSchema>;
