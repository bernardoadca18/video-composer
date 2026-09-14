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
  provenance: z.record(z.string(), z.unknown()).optional(),
};

export const TimelineGameplaySourceSchema = z
  .object({
    source_type: z.literal('gameplay'),
    ...VideoSourceFields,
  })
  .strict();

export const TimelineVideoSegmentSourceSchema = z
  .object({
    source_type: z.literal('video_segment'),
    ...VideoSourceFields,
  })
  .strict();

export const TimelineStaticImageSourceSchema = z
  .object({
    source_type: z.literal('static_image'),
    project_id: Id,
    media_id: Id,
    image_semantic_index_id: Id,
    expected_sha256: Sha256,
    expected_byte_size: z.number().int().nonnegative(),
    content_type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    provenance: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const StaticImagePresentationSchema = z
  .object({
    policy_version: z.literal('static_image_presentation_v1'),
    fit: z.enum(['cover', 'contain']),
    background: z.enum(['black', 'blurred_fill']),
    motion: z.enum(['none', 'slow_zoom_in', 'slow_zoom_out']),
    zoom_amount: z.number().finite().min(0).max(0.1),
  })
  .strict();

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

const CaptionTextSchema = z
  .string()
  .min(1)
  .max(85)
  .refine((value) => {
    const lines = value.split('\n');
    return lines.length <= 2 && lines.every((line) => line.length > 0 && line.length <= 42);
  }, 'Caption text exceeds subtle_longform_v1 line limits');

export const CaptionCueSchema = z
  .object({
    text: CaptionTextSchema,
    start_seconds: Seconds,
    end_seconds: z.number().finite().positive(),
    preset: z.literal('subtle_longform_v1'),
  })
  .strict()
  .refine((value) => value.end_seconds > value.start_seconds, 'Invalid caption range');

export const CaptionsPresentationSchema = z
  .object({
    policy_version: z.literal('caption_policy_v1'),
    preset: z.literal('subtle_longform_v1'),
    cues: z.array(CaptionCueSchema).max(5000),
  })
  .strict()
  .superRefine((value, context) => {
    for (let index = 1; index < value.cues.length; index += 1) {
      if (value.cues[index]!.start_seconds < value.cues[index - 1]!.end_seconds) {
        context.addIssue({
          code: 'custom',
          message: 'Caption cues overlap',
          path: ['cues', index],
        });
      }
    }
  });

export const SectionTitlePresentationSchema = z
  .object({
    text: z.string().trim().min(1).max(120),
    start_seconds: Seconds,
    end_seconds: z.number().finite().positive(),
    preset: z.literal('minimal_section_v1'),
  })
  .strict()
  .refine((value) => value.end_seconds > value.start_seconds, 'Invalid section title range');

const BrandingDisabledSchema = z
  .object({ preset: z.literal('branding_disabled_v1'), enabled: z.literal(false) })
  .strict();

const BrandingTextWatermarkSchema = z
  .object({
    preset: z.literal('text_watermark_v1'),
    enabled: z.literal(true),
    text: z.string().trim().min(1).max(40),
    placement: z.enum(['top_left', 'top_right', 'bottom_left', 'bottom_right']),
    opacity: z.number().finite().min(0.2).max(0.8),
  })
  .strict();

export const BrandingPresentationSchema = z.discriminatedUnion('preset', [
  BrandingDisabledSchema,
  BrandingTextWatermarkSchema,
]);

export const TransitionPresentationSchema = z
  .object({
    type: z.literal('fade_to_black'),
    boundary_seconds: z.number().finite().positive(),
    duration_seconds: z.number().finite().min(0.1).max(1),
    preset: z.literal('section_boundary_fade_v1'),
  })
  .strict();

export const PresentationSpecSchema = z
  .object({
    schema_version: z.literal('presentation_spec_v1'),
    strategy_version: z.literal('longform_presentation_v1'),
    profile_id: z.literal('longform_professional_v1'),
    fingerprint: Sha256,
    captions: CaptionsPresentationSchema,
    section_titles: z.array(SectionTitlePresentationSchema).max(100),
    branding: BrandingPresentationSchema,
    transitions: z.array(TransitionPresentationSchema).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    for (let index = 1; index < value.section_titles.length; index += 1) {
      if (
        value.section_titles[index]!.start_seconds < value.section_titles[index - 1]!.end_seconds
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Section titles overlap',
          path: ['section_titles', index],
        });
      }
    }
    for (let index = 1; index < value.transitions.length; index += 1) {
      const previous = value.transitions[index - 1]!;
      const current = value.transitions[index]!;
      if (
        current.boundary_seconds - current.duration_seconds / 2 <
        previous.boundary_seconds + previous.duration_seconds / 2
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Transitions overlap',
          path: ['transitions', index],
        });
      }
    }
  });

export const ComposerRenderInputSchema = z
  .object({
    schema_version: z.literal('composer_render_input_v1'),
    production_timeline: ProductionTimelineSchema,
    presentation: PresentationSpecSchema.nullable(),
  })
  .strict();

const RenderPresentationSchema = z
  .object({
    schema_version: z.literal('presentation_spec_v1'),
    strategy_version: z.literal('longform_presentation_v1'),
    profile_id: z.literal('longform_professional_v1'),
    fingerprint: Sha256,
    captions: z
      .object({
        policy_version: z.literal('caption_policy_v1'),
        preset: z.literal('subtle_longform_v1'),
        cues: z.array(
          z
            .object({
              text: CaptionTextSchema,
              frame_start: z.number().int().nonnegative(),
              frame_duration: z.number().int().positive(),
              preset: z.literal('subtle_longform_v1'),
            })
            .strict(),
        ),
      })
      .strict(),
    section_titles: z.array(
      z
        .object({
          text: z.string().trim().min(1).max(120),
          frame_start: z.number().int().nonnegative(),
          frame_duration: z.number().int().positive(),
          preset: z.literal('minimal_section_v1'),
        })
        .strict(),
    ),
    branding: BrandingPresentationSchema,
    transitions: z.array(
      z
        .object({
          type: z.literal('fade_to_black'),
          frame_start: z.number().int().nonnegative(),
          boundary_frame: z.number().int().positive(),
          duration_frames: z.number().int().positive(),
          preset: z.literal('section_boundary_fade_v1'),
        })
        .strict(),
    ),
  })
  .strict();

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
export type PresentationSpec = z.infer<typeof PresentationSpecSchema>;
export type ComposerRenderInput = z.infer<typeof ComposerRenderInputSchema>;

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

export const RenderManifestV3Schema = z
  .object({
    schema_version: z.literal('render_manifest_v3'),
    composer_strategy_version: z.literal('video_composer_v3_presentation'),
    proxy_strategy_version: z.literal('clip_proxy_v1'),
    source_timeline_schema_version: z.enum([
      'production_timeline_schema_v1',
      'production_timeline_schema_v2',
    ]),
    workflow_id: Id,
    production_timeline_id: Id,
    production_timeline_fingerprint: Sha256,
    mode: z.enum(['preview', 'final']),
    duration_seconds: z.number().finite().positive(),
    duration_in_frames: z.number().int().positive(),
    render_profile: RenderProfileSchema,
    narration: RenderNarrationSchema,
    source_assets: z.array(
      z.union([
        z
          .object({
            media_id: Id,
            project_id: Id,
            sha256: Sha256,
            byte_size: z.number().int().nonnegative(),
            content_type: z.string().nullable(),
          })
          .strict(),
        z
          .object({
            media_id: Id,
            project_id: Id,
            media_kind: z.enum(['video', 'image']),
            sha256: Sha256,
            byte_size: z.number().int().nonnegative(),
            content_type: z.string().nullable(),
          })
          .strict(),
      ]),
    ),
    placements: z.array(
      z.union([
        z
          .object({
            ...RenderPlacementBase,
            source: RenderVideoSourceV1Schema,
            playback_rate: z.literal(1),
          })
          .strict(),
        z
          .object({
            ...RenderPlacementBase,
            source: RenderVideoSourceV2Schema,
            playback_rate: z.literal(1),
            presentation: z.null(),
          })
          .strict(),
        z
          .object({
            ...RenderPlacementBase,
            source: RenderImageSourceV2Schema,
            playback_rate: z.null(),
            presentation: StaticImagePresentationSchema,
          })
          .strict(),
      ]),
    ),
    gaps: z.array(RenderGapSchema),
    presentation: RenderPresentationSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const duration = value.duration_in_frames;
    for (const [collection, items] of [
      ['captions', value.presentation.captions.cues],
      ['section_titles', value.presentation.section_titles],
    ] as const) {
      items.forEach((item, index) => {
        if (item.frame_start + item.frame_duration > duration) {
          context.addIssue({
            code: 'custom',
            message: `${collection} item exceeds render duration`,
            path: ['presentation', collection, index],
          });
        }
      });
    }
    value.presentation.transitions.forEach((item, index) => {
      if (
        item.frame_start >= item.boundary_frame ||
        item.frame_start + item.duration_frames > duration ||
        item.boundary_frame >= item.frame_start + item.duration_frames
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Transition has an invalid frame range',
          path: ['presentation', 'transitions', index],
        });
      }
    });
  });

export const RenderManifestSchema = z.union([
  RenderManifestV1Schema,
  RenderManifestV2Schema,
  RenderManifestV3Schema,
]);
export type RenderManifest = z.infer<typeof RenderManifestSchema>;
export type RenderManifestV1 = z.infer<typeof RenderManifestV1Schema>;
export type RenderManifestV2 = z.infer<typeof RenderManifestV2Schema>;
export type RenderManifestV3 = z.infer<typeof RenderManifestV3Schema>;
