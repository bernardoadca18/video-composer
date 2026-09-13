import { describe, expect, it } from 'vitest';

import { fingerprint } from '../../src/core/identity.js';
import type { PresentationSpec } from '../../src/domain/contracts.js';
import { buildRenderManifest } from '../../src/domain/manifest.js';
import { youtube1080p30V1 } from '../../src/domain/profiles.js';
import { PRESENTATION_LAYER_ORDER } from '../../src/remotion/presentation/PresentationLayers.js';
import { MEDIA_ID, mediaMetadata, productionTimeline, testConfig } from '../helpers.js';
import { presentation } from './presentation-contract.test.js';

const withFingerprint = (value: Omit<PresentationSpec, 'fingerprint'>): PresentationSpec => ({
  ...value,
  fingerprint: fingerprint(value),
});

describe('presentation render manifest identity', () => {
  const metadata = new Map([[MEDIA_ID, mediaMetadata()]]);
  const config = testConfig('/tmp/presentation-manifest');

  it('keeps deterministic overlay layer ordering', () => {
    expect(PRESENTATION_LAYER_ORDER).toEqual([
      'transitions',
      'section_titles',
      'captions',
      'branding',
    ]);
  });

  it('preserves legacy V1 identity when presentation is absent', () => {
    const omitted = buildRenderManifest(
      productionTimeline(),
      metadata,
      youtube1080p30V1,
      'final',
      config,
    );
    const explicitNull = buildRenderManifest(
      productionTimeline(),
      metadata,
      youtube1080p30V1,
      'final',
      config,
      null,
    );
    expect(explicitNull).toEqual(omitted);
    expect(omitted.manifest.schema_version).toBe('render_manifest_v1');
  });

  it('quantizes overlays into V3 without changing total duration', () => {
    const input = presentation({
      section_titles: [
        {
          text: 'A cidade reage',
          start_seconds: 2,
          end_seconds: 4.4,
          preset: 'minimal_section_v1',
        },
      ],
      transitions: [
        {
          type: 'fade_to_black',
          boundary_seconds: 2,
          duration_seconds: 0.3,
          preset: 'section_boundary_fade_v1',
        },
      ],
      branding: {
        preset: 'text_watermark_v1',
        enabled: true,
        text: 'NEOVIDS TEST',
        placement: 'top_right',
        opacity: 0.5,
      },
    });
    const result = buildRenderManifest(
      productionTimeline(),
      metadata,
      youtube1080p30V1,
      'final',
      config,
      input,
    );
    expect(result.manifest.schema_version).toBe('render_manifest_v3');
    expect(result.manifest.duration_in_frames).toBe(180);
    expect(result.manifest.presentation.captions.cues[0]).toMatchObject({
      frame_start: 6,
      frame_duration: 48,
    });
    expect(result.manifest.presentation.section_titles[0]).toMatchObject({
      frame_start: 60,
      frame_duration: 72,
    });
    expect(result.manifest.presentation.transitions[0]?.duration_frames).toBeGreaterThan(0);
  });

  it('changes render identity for captions, title, branding and transition changes', () => {
    const base = presentation();
    const render = (input: PresentationSpec) =>
      buildRenderManifest(productionTimeline(), metadata, youtube1080p30V1, 'final', config, input)
        .renderFingerprint;
    const content = ({ fingerprint: identity, ...rest }: PresentationSpec) => {
      void identity;
      return rest;
    };
    const variants = [
      withFingerprint({
        ...content(base),
        captions: {
          ...base.captions,
          cues: [{ ...base.captions.cues[0]!, text: 'Outra legenda' }],
        },
      }),
      withFingerprint({
        ...content(base),
        section_titles: [
          {
            text: 'Título explícito',
            start_seconds: 2,
            end_seconds: 4,
            preset: 'minimal_section_v1',
          },
        ],
      }),
      withFingerprint({
        ...content(base),
        branding: {
          preset: 'text_watermark_v1',
          enabled: true,
          text: 'TEST',
          placement: 'top_right',
          opacity: 0.5,
        },
      }),
      withFingerprint({
        ...content(base),
        transitions: [
          {
            type: 'fade_to_black',
            boundary_seconds: 3,
            duration_seconds: 0.3,
            preset: 'section_boundary_fade_v1',
          },
        ],
      }),
    ];
    expect(new Set([render(base), ...variants.map(render)]).size).toBe(5);
  });

  it('rejects a forged PresentationSpec fingerprint', () => {
    expect(() =>
      buildRenderManifest(productionTimeline(), metadata, youtube1080p30V1, 'final', config, {
        ...presentation(),
        fingerprint: 'f'.repeat(64),
      }),
    ).toThrow(/fingerprint/);
  });
});
