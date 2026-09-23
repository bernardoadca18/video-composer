import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ProductionTimelineSchema,
  StaticImagePresentationV2Schema,
} from '../../src/domain/contracts.js';
import { imageTransformAt } from '../../src/domain/image-motion.js';
import { buildRenderManifest } from '../../src/domain/manifest.js';
import { youtube1080p30V1 } from '../../src/domain/profiles.js';
import { mediaMetadata, testConfig } from '../helpers.js';

const motion = () => ({
  policy_version: 'static_image_presentation_v2' as const,
  fit: 'cover' as const,
  background: 'black' as const,
  transform: {
    start_scale: 1.12,
    end_scale: 1.18,
    start_x: -0.04,
    end_x: 0.04,
    start_y: 0,
    end_y: 0,
    easing: 'linear' as const,
  },
});
type Fixture = {
  schema_version: string;
  tracks: {
    primary_visual: {
      placements: Array<{ source: Record<string, unknown>; presentation: unknown }>;
    };
  };
};
const raw = (): Fixture =>
  JSON.parse(
    readFileSync(
      new URL('../fixtures/production_timeline_v2_contract.json', import.meta.url),
      'utf8',
    ),
  ) as Fixture;
const fixture = () => {
  const f = raw();
  f.schema_version = 'production_timeline_schema_v3';
  const image = f.tracks.primary_visual.placements[1]!;
  delete image.source.image_semantic_index_id;
  image.presentation = motion();
  return f;
};
describe('asset timeline and frozen transforms', () => {
  it('adds V3 without relaxing V2', () => {
    expect(ProductionTimelineSchema.safeParse(fixture()).success).toBe(true);
    const f = fixture();
    f.schema_version = 'production_timeline_schema_v2';
    expect(ProductionTimelineSchema.safeParse(f).success).toBe(false);
    expect(ProductionTimelineSchema.safeParse(raw()).success).toBe(true);
  });
  it('allows a real optional semantic identity', () => {
    const f = fixture();
    f.tracks.primary_visual.placements[1]!.source.image_semantic_index_id =
      raw().tracks.primary_visual.placements[1]!.source.image_semantic_index_id;
    expect(ProductionTimelineSchema.safeParse(f).success).toBe(true);
  });
  it.each([NaN, Infinity, 0, -1, 3])('rejects invalid scale %s', (value) => {
    const p = motion();
    p.transform.start_scale = value;
    expect(StaticImagePresentationV2Schema.safeParse(p).success).toBe(false);
  });
  it('rejects uncovered edges', () => {
    const p = motion();
    p.transform.start_x = 0.5;
    expect(StaticImagePresentationV2Schema.safeParse(p).success).toBe(false);
  });
  it('executes first, middle and final frames exactly', () => {
    expect(imageTransformAt(motion(), 0)).toBe('translate(-4%, 0%) scale(1.12)');
    expect(imageTransformAt(motion(), 0.5)).toBe('translate(0%, 0%) scale(1.15)');
    expect(imageTransformAt(motion(), 1)).toBe('translate(4%, 0%) scale(1.18)');
  });
  it('materializes V3 in a new manifest with deterministic identity', () => {
    const t = ProductionTimelineSchema.parse(fixture());
    const assets = new Map(
      t.tracks.primary_visual.placements.map((p) => [
        p.source.media_id,
        mediaMetadata({
          id: p.source.media_id,
          project_id: p.source.project_id,
          ...(p.source.source_type === 'static_image'
            ? {
                media_kind: 'image',
                sha256: p.source.expected_sha256,
                byte_size: p.source.expected_byte_size,
                content_type: p.source.content_type,
              }
            : {}),
        }),
      ]),
    );
    const result = buildRenderManifest(
      t,
      assets,
      youtube1080p30V1,
      'final',
      testConfig('/tmp/storyboard-test'),
    );
    expect(result.manifest.schema_version).toBe('render_manifest_v5');
    expect(
      buildRenderManifest(t, assets, youtube1080p30V1, 'final', testConfig('/tmp/storyboard-test'))
        .manifestFingerprint,
    ).toBe(result.manifestFingerprint);
  });
});
