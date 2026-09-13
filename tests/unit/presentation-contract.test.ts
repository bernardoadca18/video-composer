import { describe, expect, it } from 'vitest';

import { fingerprint } from '../../src/core/identity.js';
import {
  ComposerRenderInputSchema,
  type PresentationSpec,
  PresentationSpecSchema,
} from '../../src/domain/contracts.js';
import { productionTimeline } from '../helpers.js';

const presentation = (overrides: Record<string, unknown> = {}): PresentationSpec => {
  const content = {
    schema_version: 'presentation_spec_v1' as const,
    strategy_version: 'longform_presentation_v1' as const,
    profile_id: 'longform_professional_v1' as const,
    captions: {
      policy_version: 'caption_policy_v1' as const,
      preset: 'subtle_longform_v1' as const,
      cues: [
        {
          text: 'Uma legenda discreta',
          start_seconds: 0.2,
          end_seconds: 1.8,
          preset: 'subtle_longform_v1' as const,
        },
      ],
    },
    section_titles: [],
    branding: { preset: 'branding_disabled_v1' as const, enabled: false as const },
    transitions: [],
    ...overrides,
  };
  return PresentationSpecSchema.parse({ ...content, fingerprint: fingerprint(content) });
};

describe('PresentationSpec V1 contract', () => {
  it('parses the mirrored cross-service fixture with its canonical identity', () => {
    const raw = JSON.parse(
      readFileSync(
        new URL('../fixtures/presentation_spec_v1_contract.json', import.meta.url),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const parsed = PresentationSpecSchema.parse(raw);
    const { fingerprint: declared, ...content } = parsed;
    expect(fingerprint(content)).toBe(declared);
  });

  it('strictly accepts the frozen package and rejects unknown fields', () => {
    expect(
      ComposerRenderInputSchema.parse({
        schema_version: 'composer_render_input_v1',
        production_timeline: productionTimeline(),
        presentation: presentation(),
      }).presentation,
    ).not.toBeNull();
    expect(() =>
      PresentationSpecSchema.parse({ ...presentation(), css: 'position:fixed' }),
    ).toThrow();
    expect(() =>
      ComposerRenderInputSchema.parse({
        schema_version: 'composer_render_input_v1',
        production_timeline: productionTimeline(),
        presentation: presentation(),
        url: 'https://example.test/logo.png',
      }),
    ).toThrow();
  });

  it('rejects unknown presets, arbitrary asset fields and malformed ranges', () => {
    const base = presentation();
    expect(() =>
      PresentationSpecSchema.parse({
        ...base,
        branding: { preset: 'logo_v1', enabled: true, path: '/tmp/logo.png' },
      }),
    ).toThrow();
    expect(() =>
      PresentationSpecSchema.parse({
        ...base,
        captions: {
          ...base.captions,
          cues: [{ ...base.captions.cues[0], end_seconds: 0.1 }],
        },
      }),
    ).toThrow();
    expect(() =>
      PresentationSpecSchema.parse({
        ...base,
        captions: {
          ...base.captions,
          cues: [
            base.captions.cues[0],
            { ...base.captions.cues[0], start_seconds: 1.7, end_seconds: 2.2 },
          ],
        },
      }),
    ).toThrow();
  });

  it('has a stable content fingerprint sensitive to word and timing changes', () => {
    const first = presentation();
    const repeated = presentation();
    const changedWord = presentation({
      captions: {
        ...first.captions,
        cues: [{ ...first.captions.cues[0], text: 'Uma legenda diferente' }],
      },
    });
    const changedTiming = presentation({
      captions: {
        ...first.captions,
        cues: [{ ...first.captions.cues[0], end_seconds: 1.9 }],
      },
    });
    expect(first.fingerprint).toBe(repeated.fingerprint);
    expect(changedWord.fingerprint).not.toBe(first.fingerprint);
    expect(changedTiming.fingerprint).not.toBe(first.fingerprint);
  });
});

export { presentation };
import { readFileSync } from 'node:fs';
