import { z } from 'zod';

const Id = z.string().uuid();
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const Seconds = z.number().finite().nonnegative();

const VideoSourceFields = {
  project_id: Id,
  session_id: Id,
  media_id: Id,
  candidate_start_seconds: Seconds,
  candidate_end_seconds: z.number().finite().positive(),
  source_start_seconds: Seconds,
  source_end_seconds: z.number().finite().positive(),
};

export const TimelineGameplaySourceSchema = z.object({
  source_type: z.literal('gameplay'),
  ...VideoSourceFields,
});

export const TimelineVideoSegmentSourceSchema = z.object({
  source_type: z.literal('video_segment'),
  ...VideoSourceFields,
});

export const TimelineStaticImageSourceSchema = z.object({
  source_type: z.literal('static_image'),
  project_id: Id,
  media_id: Id,
  image_semantic_index_id: Id,
  expected_sha256: Sha256,
  expected_byte_size: z.number().int().nonnegative(),
  content_type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
});

export const StaticImagePresentationSchema = z.object({
  policy_version: z.literal('static_image_presentation_v1'),
  fit: z.enum(['cover', 'contain']),
  background: z.enum(['black', 'blurred_fill']),
  motion: z.enum(['none', 'slow_zoom_in', 'slow_zoom_out']),
  zoom_amount: z.number().finite().min(0).max(0.1),
});

export const TimelinePlacementV1Schema = z.object({
  id: Id,
  order: z.number().int().nonnegative(),
  timeline_start_seconds: Seconds,
  timeline_end_seconds: z.number().finite().positive(),
  source: TimelineGameplaySourceSchema,
  playback_rate: z.number().finite(),
  presentation: z.null().optional(),
  transition: z.string(),
});

export const TimelineVideoPlacementV2Schema = z.object({
  id: Id,
  order: z.number().int().nonnegative(),
  timeline_start_seconds: Seconds,
  timeline_end_seconds: z.number().finite().positive(),
  source: TimelineVideoSegmentSourceSchema,
  playback_rate: z.literal(1),
  presentation: z.null().optional(),
  transition: z.literal('cut'),
});

export const TimelineImagePlacementV2Schema = z.object({
  id: Id,
  order: z.number().int().nonnegative(),
  timeline_start_seconds: Seconds,
  timeline_end_seconds: z.number().finite().positive(),
  source: TimelineStaticImageSourceSchema,
  playback_rate: z.null(),
  presentation: StaticImagePresentationSchema,
  transition: z.literal('cut'),
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

const TimelineBase = {
  id: Id,
  workflow_id: Id,
  strategy_version: z.string(),
  fingerprint: Sha256,
  status: z.string(),
  duration_seconds: z.number().finite().positive(),
  gaps: z.array(TimelineGapSchema),
  visual_coverage_ratio: z.number().finite().min(0).max(1),
};

export const ProductionTimelineV1Schema = z.object({
  ...TimelineBase,
  schema_version: z.literal('production_timeline_schema_v1'),
  tracks: z.object({
    narration: NarrationTrackSchema.nullable(),
    primary_visual: z.object({ placements: z.array(TimelinePlacementV1Schema) }),
  }),
});

export const ProductionTimelineV2Schema = z.object({
  ...TimelineBase,
  schema_version: z.literal('production_timeline_schema_v2'),
  tracks: z.object({
    narration: NarrationTrackSchema.nullable(),
    primary_visual: z.object({
      placements: z.array(
        z.union([TimelineVideoPlacementV2Schema, TimelineImagePlacementV2Schema]),
      ),
    }),
  }),
});

export const ProductionTimelineSchema = z.union([
  ProductionTimelineV1Schema,
  ProductionTimelineV2Schema,
]);

export const MediaAssetMetadataSchema = z.object({
  id: Id,
  project_id: Id,
  media_kind: z.enum(['video', 'image']).default('video'),
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
export type ProductionTimelineV1 = z.infer<typeof ProductionTimelineV1Schema>;
export type ProductionTimelineV2 = z.infer<typeof ProductionTimelineV2Schema>;
export type TimelinePlacement =
  | z.infer<typeof TimelinePlacementV1Schema>
  | z.infer<typeof TimelineVideoPlacementV2Schema>
  | z.infer<typeof TimelineImagePlacementV2Schema>;
export type MediaAssetMetadata = z.infer<typeof MediaAssetMetadataSchema>;
export type RenderRequest = z.infer<typeof RenderRequestSchema>;

const RenderProfileSchema = z.object({
  name: z.literal('youtube_1080p30_v1'),
  identity: Sha256,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().int().positive(),
  fit_mode: z.literal('contain'),
  background_color: z.string(),
});

const RenderNarrationSchema = z.object({
  sha256: Sha256,
  byte_size: z.number().int().positive().nullable(),
  sample_rate: z.number().int().positive().nullable(),
  channels: z.number().int().positive().nullable(),
  asset_key: Sha256,
  asset_url: z.url(),
  frame_start: z.literal(0),
  frame_duration: z.number().int().positive(),
});

const RenderGapSchema = z.object({
  id: Id,
  order: z.number().int().nonnegative(),
  frame_start: z.number().int().nonnegative(),
  frame_duration: z.number().int().positive(),
  reason: z.string(),
  severity: z.string(),
});

const RenderPlacementBase = {
  id: Id,
  order: z.number().int().nonnegative(),
  frame_start: z.number().int().nonnegative(),
  frame_duration: z.number().int().positive(),
  timeline_start_microseconds: z.number().int().nonnegative(),
  timeline_end_microseconds: z.number().int().positive(),
  transition: z.literal('cut'),
};

const RenderVideoSourceV1Schema = z.object({
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
});

const RenderVideoSourceV2Schema = RenderVideoSourceV1Schema.extend({
  source_type: z.literal('video_segment'),
});

const RenderImageSourceV2Schema = z.object({
  source_type: z.literal('static_image'),
  project_id: Id,
  media_id: Id,
  image_semantic_index_id: Id,
  sha256: Sha256,
  byte_size: z.number().int().nonnegative(),
  content_type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  asset_url: z.url(),
});

export const RenderManifestV1Schema = z.object({
  schema_version: z.literal('render_manifest_v1'),
  composer_strategy_version: z.literal('video_composer_v1'),
  proxy_strategy_version: z.literal('clip_proxy_v1'),
  workflow_id: Id,
  production_timeline_id: Id,
  production_timeline_fingerprint: Sha256,
  mode: z.enum(['preview', 'final']),
  duration_seconds: z.number().finite().positive(),
  duration_in_frames: z.number().int().positive(),
  render_profile: RenderProfileSchema,
  narration: RenderNarrationSchema,
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
      ...RenderPlacementBase,
      source: RenderVideoSourceV1Schema,
      playback_rate: z.literal(1),
    }),
  ),
  gaps: z.array(RenderGapSchema),
});

export const RenderManifestV2Schema = z.object({
  schema_version: z.literal('render_manifest_v2'),
  composer_strategy_version: z.literal('video_composer_v2_hybrid_sources'),
  proxy_strategy_version: z.literal('clip_proxy_v1'),
  workflow_id: Id,
  production_timeline_id: Id,
  production_timeline_fingerprint: Sha256,
  mode: z.enum(['preview', 'final']),
  duration_seconds: z.number().finite().positive(),
  duration_in_frames: z.number().int().positive(),
  render_profile: RenderProfileSchema,
  narration: RenderNarrationSchema,
  source_assets: z.array(
    z.object({
      media_id: Id,
      project_id: Id,
      media_kind: z.enum(['video', 'image']),
      sha256: Sha256,
      byte_size: z.number().int().nonnegative(),
      content_type: z.string().nullable(),
    }),
  ),
  placements: z.array(
    z.union([
      z.object({
        ...RenderPlacementBase,
        source: RenderVideoSourceV2Schema,
        playback_rate: z.literal(1),
        presentation: z.null(),
      }),
      z.object({
        ...RenderPlacementBase,
        source: RenderImageSourceV2Schema,
        playback_rate: z.null(),
        presentation: StaticImagePresentationSchema,
      }),
    ]),
  ),
  gaps: z.array(RenderGapSchema),
});

export const RenderManifestSchema = z.union([RenderManifestV1Schema, RenderManifestV2Schema]);
export type RenderManifest = z.infer<typeof RenderManifestSchema>;
export type RenderManifestV1 = z.infer<typeof RenderManifestV1Schema>;
export type RenderManifestV2 = z.infer<typeof RenderManifestV2Schema>;
