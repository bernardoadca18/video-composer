import type { IdentifiedProxyProfile } from './proxy-profile.js';
import { proxyFingerprint } from './proxy-profile.js';
import { microsecondsToNearestFrame } from './quantization.js';

export interface ProxyInterval {
  placementId: string;
  sourceSha256: string;
  sourceStartMicroseconds: number;
  sourceEndMicroseconds: number;
}

export interface ProxyPlannerPolicy {
  maxGapMicroseconds: number;
  maxMergedDurationMicroseconds: number;
  maxExtraEncodedMicroseconds: number;
  maxOverfetchRatio: number;
}

export const defaultProxyPlannerPolicy: ProxyPlannerPolicy = {
  maxGapMicroseconds: 1_000_000,
  maxMergedDurationMicroseconds: 120_000_000,
  maxExtraEncodedMicroseconds: 5_000_000,
  maxOverfetchRatio: 1.15,
};

export interface PlannedDerivative {
  key: string;
  sourceSha256: string;
  sourceStartMicroseconds: number;
  sourceEndMicroseconds: number;
  profileIdentity: string;
  placementIds: string[];
}

export interface PlannedPlacement {
  derivativeKey: string;
  derivativeStartMicroseconds: number;
  derivativeEndMicroseconds: number;
  trimStartMicroseconds: number;
  trimEndMicroseconds: number;
  trimStartFrame: number;
}

export interface ProxyPlan {
  derivatives: PlannedDerivative[];
  placements: Map<string, PlannedPlacement>;
  requiredSourceSeconds: number;
  derivativeSeconds: number;
}

export const intervalUnionMicroseconds = (
  intervals: readonly Pick<ProxyInterval, 'sourceStartMicroseconds' | 'sourceEndMicroseconds'>[],
): number => {
  const sorted = [...intervals].sort(
    (left, right) =>
      left.sourceStartMicroseconds - right.sourceStartMicroseconds ||
      left.sourceEndMicroseconds - right.sourceEndMicroseconds,
  );
  let total = 0;
  let start: number | null = null;
  let end: number | null = null;
  for (const interval of sorted) {
    if (interval.sourceEndMicroseconds <= interval.sourceStartMicroseconds)
      throw new Error('invalid_proxy_interval');
    if (start === null || end === null) {
      start = interval.sourceStartMicroseconds;
      end = interval.sourceEndMicroseconds;
    } else if (interval.sourceStartMicroseconds <= end) {
      end = Math.max(end, interval.sourceEndMicroseconds);
    } else {
      total += end - start;
      start = interval.sourceStartMicroseconds;
      end = interval.sourceEndMicroseconds;
    }
  }
  return start === null || end === null ? 0 : total + end - start;
};

const canMerge = (
  current: PlannedDerivative,
  next: ProxyInterval,
  coveredMicroseconds: number,
  policy: ProxyPlannerPolicy,
): boolean => {
  const gap = Math.max(0, next.sourceStartMicroseconds - current.sourceEndMicroseconds);
  const mergedEnd = Math.max(current.sourceEndMicroseconds, next.sourceEndMicroseconds);
  const mergedDuration = mergedEnd - current.sourceStartMicroseconds;
  const additionalCovered = Math.max(
    0,
    next.sourceEndMicroseconds -
      Math.max(next.sourceStartMicroseconds, current.sourceEndMicroseconds),
  );
  const nextCovered = coveredMicroseconds + additionalCovered;
  const extra = Math.max(0, mergedDuration - nextCovered);
  return (
    gap <= policy.maxGapMicroseconds &&
    mergedDuration <= policy.maxMergedDurationMicroseconds &&
    extra <= policy.maxExtraEncodedMicroseconds &&
    mergedDuration / nextCovered <= policy.maxOverfetchRatio
  );
};

export const planProxyDerivatives = (
  intervals: readonly ProxyInterval[],
  profile: IdentifiedProxyProfile,
  policy: ProxyPlannerPolicy = defaultProxyPlannerPolicy,
): ProxyPlan => {
  const derivatives: PlannedDerivative[] = [];
  const placements = new Map<string, PlannedPlacement>();
  const groups = new Map<string, ProxyInterval[]>();
  for (const interval of intervals) {
    if (interval.sourceEndMicroseconds <= interval.sourceStartMicroseconds) {
      throw new Error('invalid_proxy_interval');
    }
    const group = groups.get(interval.sourceSha256) ?? [];
    group.push(interval);
    groups.set(interval.sourceSha256, group);
  }
  for (const [sourceSha256, group] of [...groups].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const sorted = [...group].sort(
      (left, right) =>
        left.sourceStartMicroseconds - right.sourceStartMicroseconds ||
        left.sourceEndMicroseconds - right.sourceEndMicroseconds ||
        left.placementId.localeCompare(right.placementId),
    );
    let members: ProxyInterval[] = [];
    let coveredMicroseconds = 0;
    const flush = (): void => {
      if (members.length === 0) return;
      const start = Math.min(...members.map((item) => item.sourceStartMicroseconds));
      const end = Math.max(...members.map((item) => item.sourceEndMicroseconds));
      const key = proxyFingerprint(sourceSha256, start, end, profile);
      derivatives.push({
        key,
        sourceSha256,
        sourceStartMicroseconds: start,
        sourceEndMicroseconds: end,
        profileIdentity: profile.identity,
        placementIds: members.map((item) => item.placementId).sort(),
      });
      for (const item of members) {
        const trimStart = item.sourceStartMicroseconds - start;
        placements.set(item.placementId, {
          derivativeKey: key,
          derivativeStartMicroseconds: start,
          derivativeEndMicroseconds: end,
          trimStartMicroseconds: trimStart,
          trimEndMicroseconds: item.sourceEndMicroseconds - start,
          trimStartFrame: microsecondsToNearestFrame(trimStart, profile.fps),
        });
      }
      members = [];
      coveredMicroseconds = 0;
    };
    for (const interval of sorted) {
      if (members.length === 0) {
        members = [interval];
        coveredMicroseconds = interval.sourceEndMicroseconds - interval.sourceStartMicroseconds;
        continue;
      }
      const current: PlannedDerivative = {
        key: '',
        sourceSha256,
        sourceStartMicroseconds: members[0]!.sourceStartMicroseconds,
        sourceEndMicroseconds: Math.max(...members.map((item) => item.sourceEndMicroseconds)),
        profileIdentity: profile.identity,
        placementIds: [],
      };
      if (canMerge(current, interval, coveredMicroseconds, policy)) {
        members.push(interval);
        coveredMicroseconds = intervalUnionMicroseconds(members);
      } else {
        flush();
        members = [interval];
        coveredMicroseconds = interval.sourceEndMicroseconds - interval.sourceStartMicroseconds;
      }
    }
    flush();
  }
  const requiredMicroseconds = [...groups.values()].reduce(
    (total, group) => total + intervalUnionMicroseconds(group),
    0,
  );
  const derivativeMicroseconds = derivatives.reduce(
    (total, item) => total + item.sourceEndMicroseconds - item.sourceStartMicroseconds,
    0,
  );
  return {
    derivatives,
    placements,
    requiredSourceSeconds: requiredMicroseconds / 1_000_000,
    derivativeSeconds: derivativeMicroseconds / 1_000_000,
  };
};
