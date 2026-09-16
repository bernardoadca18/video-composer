import { describe, expect, it } from 'vitest';

import { buildDiskPlan, requireDiskCapacity } from '../../src/storage/disk-plan.js';

describe('disk preflight', () => {
  it('passes only when capacity includes temporary files and reserve', () => {
    const plan = buildDiskPlan({
      filesystemFreeBytes: 30_000,
      filesystemTotalBytes: 100_000,
      reusableCachedBytes: 0,
      missingFullSourceBytes: 0,
      estimatedDerivativeBytes: 2_000,
      estimatedTempBytes: 2_000,
      estimatedRemotionBytes: 4_000,
      estimatedOutputBytes: 1_000,
      reclaimableCacheBytes: 0,
      safetyReserveBytes: 10_000,
    });
    expect(plan.requiredAdditionalBytes).toBe(9_000);
    expect(plan.ready).toBe(true);
    expect(() => requireDiskCapacity(plan)).not.toThrow();
  });

  it('fails before work when the retained reserve would be crossed', () => {
    const plan = buildDiskPlan({
      filesystemFreeBytes: 14_000,
      filesystemTotalBytes: 100_000,
      reusableCachedBytes: 0,
      missingFullSourceBytes: 0,
      estimatedDerivativeBytes: 2_000,
      estimatedTempBytes: 2_000,
      estimatedRemotionBytes: 4_000,
      estimatedOutputBytes: 1_000,
      reclaimableCacheBytes: 0,
      safetyReserveBytes: 10_000,
    });
    expect(plan.ready).toBe(false);
    expect(() => requireDiskCapacity(plan)).toThrow(/Insufficient disk capacity/);
  });
});
