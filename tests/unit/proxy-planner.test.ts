import { describe, expect, it } from 'vitest';

import { intervalUnionMicroseconds, planProxyDerivatives } from '../../src/domain/proxy-planner.js';
import { proxyProfileForRender } from '../../src/domain/proxy-profile.js';

const profile = proxyProfileForRender({ width: 1920, height: 1080, fps: 30 });

describe('proxy derivative planner', () => {
  it('accounts required coverage as the exact union for partial overlap', () => {
    const intervals = [
      { sourceStartMicroseconds: 10_000_000, sourceEndMicroseconds: 30_000_000 },
      { sourceStartMicroseconds: 20_000_000, sourceEndMicroseconds: 40_000_000 },
    ];
    expect(intervalUnionMicroseconds(intervals)).toBe(30_000_000);
    const plan = planProxyDerivatives(
      intervals.map((interval, index) => ({
        ...interval,
        placementId: String(index),
        sourceSha256: 'a'.repeat(64),
      })),
      profile,
    );
    expect(plan.requiredSourceSeconds).toBe(30);
    expect(plan.derivativeSeconds).toBe(30);
  });

  it('coalesces exact overlaps and preserves each placement trim offset', () => {
    const plan = planProxyDerivatives(
      [
        {
          placementId: 'a',
          sourceSha256: 'a'.repeat(64),
          sourceStartMicroseconds: 1_000_000,
          sourceEndMicroseconds: 3_000_000,
        },
        {
          placementId: 'b',
          sourceSha256: 'a'.repeat(64),
          sourceStartMicroseconds: 1_500_000,
          sourceEndMicroseconds: 2_500_000,
        },
      ],
      profile,
    );
    expect(plan.derivatives).toHaveLength(1);
    expect(plan.derivatives[0]).toMatchObject({
      sourceStartMicroseconds: 1_000_000,
      sourceEndMicroseconds: 3_000_000,
      placementIds: ['a', 'b'],
    });
    expect(plan.placements.get('b')).toMatchObject({
      trimStartMicroseconds: 500_000,
      trimEndMicroseconds: 1_500_000,
      trimStartFrame: 15,
    });
  });

  it('uses union coverage for containment and multiple nested intervals', () => {
    const plan = planProxyDerivatives(
      [
        [0, 10_000_000],
        [1_000_000, 9_000_000],
        [2_000_000, 3_000_000],
        [4_000_000, 5_000_000],
      ].map(([sourceStartMicroseconds, sourceEndMicroseconds], index) => ({
        placementId: String(index),
        sourceSha256: 'a'.repeat(64),
        sourceStartMicroseconds: sourceStartMicroseconds!,
        sourceEndMicroseconds: sourceEndMicroseconds!,
      })),
      profile,
    );
    expect(plan.derivatives).toHaveLength(1);
    expect(plan.requiredSourceSeconds).toBe(10);
    expect(plan.derivativeSeconds).toBe(10);
  });

  it.each([
    ['adjacency', 20_000_000, true],
    ['gap just below threshold', 20_999_999, true],
    ['gap exactly at threshold', 21_000_000, true],
    ['gap just above threshold', 21_000_001, false],
  ])('%s follows the inclusive max-gap policy', (_label, secondStart, merged) => {
    const plan = planProxyDerivatives(
      [
        {
          placementId: 'a',
          sourceSha256: 'a'.repeat(64),
          sourceStartMicroseconds: 0,
          sourceEndMicroseconds: 20_000_000,
        },
        {
          placementId: 'b',
          sourceSha256: 'a'.repeat(64),
          sourceStartMicroseconds: secondStart,
          sourceEndMicroseconds: secondStart + 20_000_000,
        },
      ],
      profile,
    );
    expect(plan.derivatives.length === 1).toBe(merged);
  });

  it('maps non-frame-aligned source boundaries with the shared nearest-frame policy', () => {
    const plan = planProxyDerivatives(
      [
        {
          placementId: 'wide',
          sourceSha256: 'a'.repeat(64),
          sourceStartMicroseconds: 100_001,
          sourceEndMicroseconds: 2_000_019,
        },
        {
          placementId: 'trimmed',
          sourceSha256: 'a'.repeat(64),
          sourceStartMicroseconds: 150_018,
          sourceEndMicroseconds: 1_999_983,
        },
      ],
      profile,
    );
    expect(plan.placements.get('trimmed')).toMatchObject({
      derivativeStartMicroseconds: 100_001,
      derivativeEndMicroseconds: 2_000_019,
      trimStartMicroseconds: 50_017,
      trimEndMicroseconds: 1_899_982,
      trimStartFrame: 2,
    });
  });

  it('preserves an interval ending exactly at the source end supplied by the timeline', () => {
    const plan = planProxyDerivatives(
      [
        {
          placementId: 'end',
          sourceSha256: 'a'.repeat(64),
          sourceStartMicroseconds: 58_500_001,
          sourceEndMicroseconds: 60_000_000,
        },
      ],
      profile,
    );
    expect(plan.derivatives[0]).toMatchObject({
      sourceStartMicroseconds: 58_500_001,
      sourceEndMicroseconds: 60_000_000,
    });
  });

  it('merges controlled adjacency but rejects a distant interval', () => {
    const plan = planProxyDerivatives(
      [
        {
          placementId: 'a',
          sourceSha256: 'a'.repeat(64),
          sourceStartMicroseconds: 0,
          sourceEndMicroseconds: 2_000_000,
        },
        {
          placementId: 'b',
          sourceSha256: 'a'.repeat(64),
          sourceStartMicroseconds: 2_500_000,
          sourceEndMicroseconds: 4_000_000,
        },
        {
          placementId: 'c',
          sourceSha256: 'a'.repeat(64),
          sourceStartMicroseconds: 600_000_000,
          sourceEndMicroseconds: 602_000_000,
        },
      ],
      profile,
    );
    expect(plan.derivatives).toHaveLength(2);
    expect(plan.placements.get('a')?.derivativeKey).toBe(plan.placements.get('b')?.derivativeKey);
    expect(plan.placements.get('a')?.derivativeKey).not.toBe(
      plan.placements.get('c')?.derivativeKey,
    );
  });

  it('changes identity when a material profile field changes', () => {
    const alternate = proxyProfileForRender({ width: 1280, height: 720, fps: 30 });
    const source = [
      {
        placementId: 'a',
        sourceSha256: 'a'.repeat(64),
        sourceStartMicroseconds: 0,
        sourceEndMicroseconds: 1_000_000,
      },
    ];
    expect(planProxyDerivatives(source, profile).derivatives[0]?.key).not.toBe(
      planProxyDerivatives(source, alternate).derivatives[0]?.key,
    );
  });
});
