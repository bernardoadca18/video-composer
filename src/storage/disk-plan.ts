import { statfs } from 'node:fs/promises';

import { ComposerError } from '../core/errors.js';

export interface DiskPlanInput {
  filesystemFreeBytes: number;
  filesystemTotalBytes: number;
  reusableCachedBytes: number;
  missingFullSourceBytes: number;
  estimatedDerivativeBytes: number;
  estimatedTempBytes: number;
  estimatedRemotionBytes: number;
  estimatedOutputBytes: number;
  reclaimableCacheBytes: number;
  safetyReserveBytes: number;
}

export interface DiskPlan extends DiskPlanInput {
  requiredAdditionalBytes: number;
  usableBytes: number;
  ready: boolean;
}

export const buildDiskPlan = (input: DiskPlanInput): DiskPlan => {
  const requiredAdditionalBytes =
    input.missingFullSourceBytes +
    input.estimatedDerivativeBytes +
    input.estimatedTempBytes +
    input.estimatedRemotionBytes +
    input.estimatedOutputBytes -
    input.reusableCachedBytes;
  const usableBytes =
    Math.max(0, input.filesystemFreeBytes - input.safetyReserveBytes) + input.reclaimableCacheBytes;
  return {
    ...input,
    requiredAdditionalBytes: Math.max(0, requiredAdditionalBytes),
    usableBytes,
    ready: usableBytes >= Math.max(0, requiredAdditionalBytes),
  };
};

export const createDiskPlan = async (
  dataRoot: string,
  input: Omit<DiskPlanInput, 'filesystemFreeBytes' | 'filesystemTotalBytes'>,
): Promise<DiskPlan> => {
  const filesystem = await statfs(dataRoot);
  const blockSize = Number(filesystem.bsize);
  return buildDiskPlan({
    ...input,
    filesystemFreeBytes: Number(filesystem.bavail) * blockSize,
    filesystemTotalBytes: Number(filesystem.blocks) * blockSize,
  });
};

export const requireDiskCapacity = (plan: DiskPlan): void => {
  if (plan.ready) return;
  throw new ComposerError(
    'insufficient_disk_capacity',
    'Insufficient disk capacity for render',
    409,
    {
      diagnostics: {
        filesystem_free_bytes: plan.filesystemFreeBytes,
        required_additional_bytes: plan.requiredAdditionalBytes,
        usable_bytes: plan.usableBytes,
        safety_reserve_bytes: plan.safetyReserveBytes,
      },
    },
  );
};
