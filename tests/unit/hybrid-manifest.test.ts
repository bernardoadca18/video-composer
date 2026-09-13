import { describe, expect, it } from 'vitest';

import { fingerprint } from '../../src/core/identity.js';
import type { MediaAssetMetadata, ProductionTimelineV2 } from '../../src/domain/contracts.js';
import { buildRenderManifest } from '../../src/domain/manifest.js';
import { youtube1080p30V1 } from '../../src/domain/profiles.js';
import {
  AUDIO_SHA,
  MEDIA_ID,
  MEDIA_SHA,
  PROJECT_ID,
  SESSION_ID,
  TIMELINE_ID,
  WORKFLOW_ID,
  mediaMetadata,
  testConfig,
} from '../helpers.js';
import { presentation as presentationSpec } from './presentation-contract.test.js';

const IMAGE_ID = '50000000-0000-4000-8000-000000000002';
const IMAGE_INDEX_ID = '50000000-0000-4000-8000-000000000003';
const IMAGE_SHA = 'c'.repeat(64);

const hybridTimeline = (
  motion: 'none' | 'slow_zoom_in' | 'slow_zoom_out' = 'slow_zoom_in',
  fit: 'cover' | 'contain' = 'contain',
): ProductionTimelineV2 => ({
  id: TIMELINE_ID,
  workflow_id: WORKFLOW_ID,
  schema_version: 'production_timeline_schema_v2',
  strategy_version: 'production_timeline_v2',
  fingerprint: fingerprint({ hybrid: true }),
  status: 'completed',
  duration_seconds: 6,
  tracks: {
    narration: {
      kind: 'narration',
      timeline_start_seconds: 0,
      timeline_end_seconds: 6,
      source_start_seconds: 0,
      source_end_seconds: 6,
      audio_url: `/workflow/${WORKFLOW_ID}/audio`,
      audio_sha256: AUDIO_SHA,
      sample_rate: 48_000,
      channels: 1,
      byte_size: 100,
    },
    primary_visual: {
      placements: [
        {
          id: '60000000-0000-4000-8000-000000000001',
          order: 0,
          timeline_start_seconds: 0,
          timeline_end_seconds: 3,
          source: {
            source_type: 'video_segment',
            project_id: PROJECT_ID,
            session_id: SESSION_ID,
            media_id: MEDIA_ID,
            candidate_start_seconds: 10,
            candidate_end_seconds: 20,
            source_start_seconds: 10,
            source_end_seconds: 13,
          },
          playback_rate: 1,
          presentation: null,
          transition: 'cut',
        },
        {
          id: '60000000-0000-4000-8000-000000000002',
          order: 1,
          timeline_start_seconds: 3,
          timeline_end_seconds: 6,
          source: {
            source_type: 'static_image',
            project_id: PROJECT_ID,
            media_id: IMAGE_ID,
            image_semantic_index_id: IMAGE_INDEX_ID,
            expected_sha256: IMAGE_SHA,
            expected_byte_size: 321,
            content_type: 'image/png',
          },
          playback_rate: null,
          presentation: {
            policy_version: 'static_image_presentation_v1',
            fit,
            background: fit === 'contain' ? 'blurred_fill' : 'black',
            motion,
            zoom_amount: motion === 'none' ? 0 : 0.04,
          },
          transition: 'cut',
        },
      ],
    },
  },
  gaps: [],
  visual_coverage_ratio: 1,
});

const imageMetadata = (changes: Partial<MediaAssetMetadata> = {}): MediaAssetMetadata => ({
  id: IMAGE_ID,
  project_id: PROJECT_ID,
  media_kind: 'image',
  original_filename: 'official.png',
  content_type: 'image/png',
  byte_size: 321,
  sha256: IMAGE_SHA,
  duration_seconds: null,
  format_name: 'png',
  video_codec: null,
  audio_codec: null,
  fps: null,
  width: 1080,
  height: 1350,
  ...changes,
});

const build = (timeline = hybridTimeline(), image = imageMetadata()) =>
  buildRenderManifest(
    timeline,
    new Map([
      [MEDIA_ID, mediaMetadata({ media_kind: 'video', sha256: MEDIA_SHA })],
      [IMAGE_ID, image],
    ]),
    youtube1080p30V1,
    'final',
    testConfig('/tmp/video-composer-hybrid-manifest'),
  );

describe('hybrid render manifest', () => {
  it('keeps video temporal and image non-temporal contracts distinct', () => {
    const result = build();
    expect(result.manifest.schema_version).toBe('render_manifest_v2');
    expect(result.manifest.composer_strategy_version).toBe('video_composer_v2_hybrid_sources');
    const image = result.manifest.placements[1]!;
    expect(image.source.source_type).toBe('static_image');
    expect(image.source).not.toHaveProperty('source_start_microseconds');
    expect(image.frame_duration).toBe(90);
  });

  it('keeps hybrid source presentation composable with overlay presentation V3', () => {
    const timeline = hybridTimeline();
    const result = buildRenderManifest(
      timeline,
      new Map([
        [MEDIA_ID, mediaMetadata({ media_kind: 'video', sha256: MEDIA_SHA })],
        [IMAGE_ID, imageMetadata()],
      ]),
      youtube1080p30V1,
      'final',
      testConfig('/tmp/video-composer-hybrid-presentation'),
      presentationSpec(),
    );
    expect(result.manifest.schema_version).toBe('render_manifest_v3');
    expect(result.manifest.source_timeline_schema_version).toBe('production_timeline_schema_v2');
    expect(result.manifest.placements[1]).toMatchObject({
      presentation: { policy_version: 'static_image_presentation_v1' },
    });
    expect(result.manifest.presentation.captions.cues).toHaveLength(1);
  });

  it.each([
    ['contain', 'slow_zoom_in'],
    ['cover', 'slow_zoom_out'],
    ['contain', 'none'],
  ] as const)('accepts deterministic %s/%s presentation', (fit, motion) => {
    expect(build(hybridTimeline(motion, fit)).manifest.placements[1]).toMatchObject({
      presentation: { fit, motion },
    });
  });

  it('fails closed on checksum, byte size, kind, and content type mismatch', () => {
    expect(() => build(hybridTimeline(), imageMetadata({ sha256: 'd'.repeat(64) }))).toThrow(
      'Static image contract is invalid',
    );
    expect(() => build(hybridTimeline(), imageMetadata({ byte_size: 999 }))).toThrow();
    expect(() => build(hybridTimeline(), imageMetadata({ media_kind: 'video' }))).toThrow();
    expect(() => build(hybridTimeline(), imageMetadata({ content_type: 'image/jpeg' }))).toThrow();
  });

  it('renders a frozen hold without duplicating upstream editorial limits', () => {
    const timeline = hybridTimeline();
    timeline.duration_seconds = 12;
    timeline.tracks.narration!.timeline_end_seconds = 12;
    timeline.tracks.narration!.source_end_seconds = 12;
    timeline.tracks.primary_visual.placements[1]!.timeline_end_seconds = 12;
    expect(build(timeline).manifest.placements[1]).toMatchObject({ frame_duration: 270 });
  });
});
