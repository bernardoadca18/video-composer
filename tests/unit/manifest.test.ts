import { describe, expect, it } from 'vitest';

import { buildRenderManifest } from '../../src/domain/manifest.js';
import { youtube1080p30V1 } from '../../src/domain/profiles.js';
import { MEDIA_ID, mediaMetadata, productionTimeline, testConfig } from '../helpers.js';

const build = (timeline = productionTimeline(), mode: 'preview' | 'final' = 'final') =>
  buildRenderManifest(
    timeline,
    new Map([[MEDIA_ID, mediaMetadata()]]),
    youtube1080p30V1,
    mode,
    testConfig('/tmp/video-composer-manifest'),
  );

describe('render manifest', () => {
  it('separates final frame time from exact source microseconds', () => {
    const first = build().manifest.placements[0]!;
    const second = build().manifest.placements[1]!;

    expect(first.frame_start).toBe(0);
    expect(first.frame_duration).toBe(90);
    expect(second.frame_start).toBe(90);
    expect(first.source.source_start_microseconds).toBe(10_000_000);
    expect(first.source.source_end_microseconds).toBe(13_000_000);
    expect(build().manifest.duration_in_frames).toBe(180);
  });

  it('uses the versioned proxy profile and keeps 1080p proxy intent in the manifest', () => {
    const built = build();
    const placement = built.manifest.placements[0]!;
    expect(built.manifest.proxy_strategy_version).toBe('proxy_strategy_v2');
    expect(placement.source.proxy_profile_identity).toMatch(/^[a-f0-9]{64}$/);
    expect(placement.source.derivative_source_start_microseconds).toBe(
      placement.source.source_start_microseconds,
    );
    expect(placement.source.proxy_trim_start_frame).toBe(0);
  });

  it('is deterministic and source content participates in identity', () => {
    const first = build();
    const repeated = build();
    const changed = buildRenderManifest(
      productionTimeline(),
      new Map([[MEDIA_ID, mediaMetadata({ sha256: 'c'.repeat(64) })]]),
      youtube1080p30V1,
      'final',
      testConfig('/tmp/video-composer-manifest'),
    );

    expect(repeated).toEqual(first);
    expect(changed.renderFingerprint).not.toBe(first.renderFingerprint);
  });

  it('rejects gaps in final mode but renders them in preview mode', () => {
    const base = productionTimeline();
    const timeline = productionTimeline({
      status: 'completed_with_gaps',
      visual_coverage_ratio: 0.5,
      tracks: {
        ...base.tracks,
        primary_visual: { placements: [base.tracks.primary_visual.placements[0]!] },
      },
      gaps: [
        {
          id: '70000000-0000-4000-8000-000000000001',
          order: 0,
          timeline_start_seconds: 3,
          timeline_end_seconds: 6,
          reason: 'source_unresolved',
          severity: 'required',
        },
      ],
    });

    expect(() => build(timeline, 'final')).toThrow('Final mode requires full coverage');
    expect(build(timeline, 'preview').manifest.gaps[0]?.frame_start).toBe(90);
  });

  it.each([
    ['schema_version', 'future_schema'],
    ['status', 'failed'],
  ])('rejects invalid timeline %s', (field, value) => {
    expect(() => build(productionTimeline({ [field]: value }))).toThrow();
  });

  it('rejects unsupported feature and invalid or collapsing ranges', () => {
    const timeline = productionTimeline();
    timeline.tracks.primary_visual.placements[0]!.playback_rate = 2;
    expect(() => build(timeline)).toThrow('Unsupported placement');

    const overlap = productionTimeline();
    overlap.tracks.primary_visual.placements[1]!.timeline_start_seconds = 2;
    overlap.tracks.primary_visual.placements[1]!.source.source_end_seconds = 24;
    expect(() => build(overlap)).toThrow('Invalid placement ranges');

    const tiny = productionTimeline({ duration_seconds: 0.01 });
    tiny.tracks.narration!.timeline_end_seconds = 0.01;
    tiny.tracks.narration!.source_end_seconds = 0.01;
    tiny.tracks.primary_visual.placements = [
      {
        ...tiny.tracks.primary_visual.placements[0]!,
        timeline_end_seconds: 0.001,
        source: {
          ...tiny.tracks.primary_visual.placements[0]!.source,
          candidate_end_seconds: 11,
          source_end_seconds: 10.001,
        },
      },
    ];
    tiny.gaps = [
      {
        id: '70000000-0000-4000-8000-000000000002',
        order: 0,
        timeline_start_seconds: 0.001,
        timeline_end_seconds: 0.01,
        reason: 'tiny',
        severity: 'background',
      },
    ];
    tiny.visual_coverage_ratio = 0.1;
    expect(() => build(tiny, 'preview')).toThrow('Placement collapsed or overlaps');
  });
});
