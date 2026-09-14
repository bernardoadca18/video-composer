import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { fingerprint } from '../../src/core/identity.js';
import {
  AudioMixPlanSchema,
  ComposerRenderInputSchema,
  type AudioMixPlan,
} from '../../src/domain/contracts.js';
import { buildRenderManifest } from '../../src/domain/manifest.js';
import { youtube1080p30ProgramAudioV1, youtube1080p30V1 } from '../../src/domain/profiles.js';
import { MEDIA_ID, mediaMetadata, productionTimeline, testConfig } from '../helpers.js';
import { presentation } from './presentation-contract.test.js';

const audioPlan = (overrides: Record<string, unknown> = {}): AudioMixPlan => {
  const content = {
    schema_version: 'audio_mix_plan_v1' as const,
    strategy_version: 'longform_program_audio_v1' as const,
    profile_id: 'music_mix_profile_v1_candidate' as const,
    duration_seconds: 6,
    narration: {
      sha256: 'a'.repeat(64),
      duration_seconds: 6,
      sample_rate: 48_000 as const,
      channels: 1 as const,
    },
    music: {
      enabled: true as const,
      asset: {
        asset_id: 'synthetic-01',
        sha256: 'c'.repeat(64),
        byte_size: 1234,
        content_type: 'audio/wav' as const,
        format: 'wav' as const,
        duration_seconds: 6,
        sample_rate: 48_000,
        channels: 2,
        integrated_lufs: -23,
        true_peak_dbtp: -3,
        moods: ['analytical'],
        styles: ['documentary'],
        energy: 0.4,
        vocals: false as const,
        loopable: true,
        source_owner: 'NeoVids test',
        source_reference: 'deterministic synthetic fixture',
        license_type: 'owned' as const,
        monetization_allowed: true as const,
        attribution_required: false,
        attribution_text: null,
      },
      source_start_seconds: 0 as const,
      source_end_seconds: 6,
      loop_policy: 'no_loop_v1' as const,
      normalization_policy: 'music_loudnorm_v1' as const,
      normalization_target_lufs: -23 as const,
      segments: [
        {
          start_seconds: 0,
          end_seconds: 6,
          gain_adjustment_db: 0,
          fade_in_seconds: 0.2,
          fade_out_seconds: 0.2,
          transition_preset: 'smooth_v1' as const,
        },
      ],
    },
    ducking: {
      policy_version: 'speech_envelope_v1' as const,
      base_gain_db: -9,
      ducked_gain_db: -20,
      attack_seconds: 0.25,
      release_seconds: 0.5,
      merge_gap_seconds: 0.35,
      speech_regions: [{ start_seconds: 0.5, end_seconds: 2 }],
    },
    program_master: {
      profile_id: 'youtube_program_master_v1_candidate' as const,
      policy_version: 'ffmpeg_loudnorm_two_pass_v1' as const,
      target_lufs: -14 as const,
      max_true_peak_dbtp: -1 as const,
      target_lra: 11 as const,
    },
    output: {
      profile_id: 'youtube_1080p30_program_audio_v1' as const,
      codec: 'aac' as const,
      bitrate: '192k' as const,
      sample_rate: 48_000 as const,
      channels: 2 as const,
    },
    ...overrides,
  };
  return AudioMixPlanSchema.parse({ ...content, fingerprint: fingerprint(content) });
};

describe('AudioMixPlan V1 contract', () => {
  const metadata = new Map([[MEDIA_ID, mediaMetadata()]]);
  const config = testConfig('/tmp/program-audio-contract');

  it('strictly parses composer input V2 without accepting paths, URLs or filters', () => {
    const plan = audioPlan();
    expect(
      ComposerRenderInputSchema.parse({
        schema_version: 'composer_render_input_v2',
        production_timeline: productionTimeline(),
        presentation: presentation(),
        audio_mix_plan: plan,
      }).schema_version,
    ).toBe('composer_render_input_v2');
    expect(() => AudioMixPlanSchema.parse({ ...plan, path: '/tmp/music.wav' })).toThrow();
    expect(() =>
      AudioMixPlanSchema.parse({ ...plan, filtergraph: 'volume=100;amovie=/etc/passwd' }),
    ).toThrow();
  });

  it('shares one canonical fingerprint fixture with the Orchestrator', () => {
    const fixture = AudioMixPlanSchema.parse(
      JSON.parse(
        readFileSync(
          new URL('../fixtures/audio_mix_plan_v1_contract.json', import.meta.url),
          'utf8',
        ),
      ),
    );
    const { fingerprint: declared, ...content } = fixture;
    expect(fingerprint(content)).toBe(declared);
  });

  it('produces V4 and changes identity for every audible decision', () => {
    const render = (plan: AudioMixPlan) =>
      buildRenderManifest(
        productionTimeline(),
        metadata,
        youtube1080p30ProgramAudioV1,
        'final',
        config,
        presentation(),
        plan,
      );
    const base = audioPlan();
    const built = render(base);
    expect(built.manifest.schema_version).toBe('render_manifest_v4');
    const changedGainContent = {
      ...base,
      music: {
        ...base.music,
        segments: base.music.enabled
          ? [{ ...base.music.segments[0]!, gain_adjustment_db: 1 }]
          : [],
      },
    };
    const { fingerprint: ignored, ...changedWithoutFingerprint } = changedGainContent;
    void ignored;
    const changedGain = AudioMixPlanSchema.parse({
      ...changedWithoutFingerprint,
      fingerprint: fingerprint(changedWithoutFingerprint),
    });
    expect(render(changedGain).renderFingerprint).not.toBe(built.renderFingerprint);
    expect(
      buildRenderManifest(
        productionTimeline(),
        metadata,
        youtube1080p30ProgramAudioV1,
        'final',
        config,
        null,
        base,
      ).manifest,
    ).toMatchObject({ schema_version: 'render_manifest_v4', presentation: null });
  });

  it('rejects forged identities, invalid loops and legacy/profile crossovers', () => {
    const plan = audioPlan();
    expect(() =>
      buildRenderManifest(
        productionTimeline(),
        metadata,
        youtube1080p30ProgramAudioV1,
        'final',
        config,
        presentation(),
        { ...plan, fingerprint: 'f'.repeat(64) },
      ),
    ).toThrow(/fingerprint/);
    expect(() =>
      buildRenderManifest(
        productionTimeline(),
        metadata,
        youtube1080p30V1,
        'final',
        config,
        presentation(),
        plan,
      ),
    ).toThrow(/Program Audio/);
    if (!plan.music.enabled) throw new Error('fixture');
    const music = plan.music;
    expect(() =>
      AudioMixPlanSchema.parse({
        ...plan,
        music: {
          ...music,
          loop_policy: 'repeat_from_start_v1',
          asset: { ...music.asset, loopable: false },
        },
      }),
    ).toThrow(/loopable/);
  });
});

export { audioPlan };
