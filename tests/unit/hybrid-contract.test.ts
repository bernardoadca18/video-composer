import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  ProductionTimelineSchema,
  ProductionTimelineV1Schema,
} from '../../src/domain/contracts.js';

type ContractFixture = {
  schema_version: string;
  tracks: {
    primary_visual: {
      placements: Array<{
        source: Record<string, unknown>;
        presentation: Record<string, unknown> | null;
      }>;
    };
  };
};

const loadFixture = (): ContractFixture =>
  JSON.parse(
    readFileSync(
      new URL('../fixtures/production_timeline_v2_contract.json', import.meta.url),
      'utf8',
    ),
  ) as ContractFixture;

const imagePlacement = (fixture: ContractFixture) => fixture.tracks.primary_visual.placements[1]!;

describe('cross-service ProductionTimeline contract', () => {
  it('accepts the canonical Orchestrator-equivalent video-to-image fixture', () => {
    const parsed = ProductionTimelineSchema.parse(loadFixture());
    expect(parsed.schema_version).toBe('production_timeline_schema_v2');
    if (parsed.schema_version !== 'production_timeline_schema_v2') {
      throw new Error('expected V2 fixture');
    }
    expect(parsed.tracks.primary_visual.placements.map((item) => item.source.source_type)).toEqual([
      'video_segment',
      'static_image',
    ]);
  });

  it.each(['image/jpeg', 'image/png', 'image/webp'] as const)(
    'accepts synchronized MIME %s',
    (mime) => {
      const fixture = loadFixture();
      imagePlacement(fixture).source.content_type = mime;
      expect(ProductionTimelineSchema.safeParse(fixture).success).toBe(true);
    },
  );

  it.each([
    ['cover', 'black', 'none'],
    ['cover', 'black', 'slow_zoom_in'],
    ['cover', 'black', 'slow_zoom_out'],
    ['contain', 'blurred_fill', 'none'],
    ['contain', 'blurred_fill', 'slow_zoom_in'],
    ['contain', 'blurred_fill', 'slow_zoom_out'],
  ] as const)('accepts presentation %s/%s/%s', (fit, background, motion) => {
    const fixture = loadFixture();
    Object.assign(imagePlacement(fixture).presentation!, { fit, background, motion });
    expect(ProductionTimelineSchema.safeParse(fixture).success).toBe(true);
  });

  it.each([
    ['content_type', 'image/gif'],
    ['fit', 'stretch'],
    ['background', 'white'],
    ['motion', 'pan'],
    ['policy_version', 'static_image_presentation_v0'],
  ] as const)('rejects invalid image contract value %s=%s', (field, value) => {
    const fixture = loadFixture();
    if (field === 'content_type') {
      imagePlacement(fixture).source[field] = value;
    } else {
      imagePlacement(fixture).presentation![field] = value;
    }
    expect(ProductionTimelineSchema.safeParse(fixture).success).toBe(false);
  });

  it.each(['gameplay', 'unknown_source'])('rejects %s as a V2 source type', (sourceType) => {
    const fixture = loadFixture();
    fixture.tracks.primary_visual.placements[0]!.source.source_type = sourceType;
    expect(ProductionTimelineSchema.safeParse(fixture).success).toBe(false);
  });

  it('rejects temporal fields on static images and missing ranges on video', () => {
    const temporalImage = loadFixture();
    imagePlacement(temporalImage).source.source_start_seconds = 0;
    expect(ProductionTimelineSchema.safeParse(temporalImage).success).toBe(false);

    const incompleteVideo = loadFixture();
    delete incompleteVideo.tracks.primary_visual.placements[0]!.source.source_end_seconds;
    expect(ProductionTimelineSchema.safeParse(incompleteVideo).success).toBe(false);
  });

  it('keeps V1 gameplay-only', () => {
    const v1 = loadFixture();
    v1.schema_version = 'production_timeline_schema_v1';
    v1.tracks.primary_visual.placements = [
      {
        ...v1.tracks.primary_visual.placements[0]!,
        source: {
          ...v1.tracks.primary_visual.placements[0]!.source,
          source_type: 'gameplay',
        },
        presentation: null,
      },
    ];
    expect(ProductionTimelineV1Schema.safeParse(v1).success).toBe(true);
    v1.tracks.primary_visual.placements[0]!.source.source_type = 'static_image';
    expect(ProductionTimelineV1Schema.safeParse(v1).success).toBe(false);
  });
});
