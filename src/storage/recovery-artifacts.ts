import { copyFile, mkdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { AppConfig } from '../core/config.js';

export interface RecoveryMetadata {
  render_id: string;
  manifest_fingerprint: string;
  render_fingerprint: string;
  created_at: string;
  stage: 'video_rendered' | 'mux_completed' | 'validation_failed' | 'completed';
  error?: {
    category: string;
    message: string;
  };
  validation_diagnostics?: {
    expected_frame_count: number;
    actual_frame_count: number | null;
    frame_delta: number | null;
    expected_duration_seconds: number;
    actual_duration_seconds: number | null;
    duration_delta_seconds: number | null;
    duration_tolerance_seconds: number;
    expected_fps: number;
    actual_fps: number | null;
    video_codec: string | null;
    pixel_format: string | null;
    width: number | null;
    height: number | null;
    audio_codec: string | null;
    audio_sample_rate: number | null;
    audio_channels: number | null;
    mismatches?: string[];
  };
}

const RECOVERY_DIR = 'recovery';

const getRecoveryDir = (config: AppConfig): string => path.join(config.dataRoot, RECOVERY_DIR);

const getRenderRecoveryDir = (config: AppConfig, renderId: string): string =>
  path.join(getRecoveryDir(config), renderId);

export const ensureRecoveryDir = async (config: AppConfig, renderId: string): Promise<string> => {
  const dir = getRenderRecoveryDir(config, renderId);
  await mkdir(dir, { recursive: true });
  return dir;
};

export const saveRecoveryMetadata = async (
  config: AppConfig,
  renderId: string,
  metadata: RecoveryMetadata,
): Promise<void> => {
  const dir = await ensureRecoveryDir(config, renderId);
  const metadataPath = path.join(dir, 'metadata.json');
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
};

export const loadRecoveryMetadata = async (
  config: AppConfig,
  renderId: string,
): Promise<RecoveryMetadata | null> => {
  const dir = getRenderRecoveryDir(config, renderId);
  const metadataPath = path.join(dir, 'metadata.json');
  try {
    const content = await readFile(metadataPath, 'utf-8');
    return JSON.parse(content) as RecoveryMetadata;
  } catch {
    return null;
  }
};

export const preserveVideoOnly = async (
  config: AppConfig,
  renderId: string,
  videoPath: string,
  metadata: Omit<RecoveryMetadata, 'stage'>,
): Promise<string> => {
  const dir = await ensureRecoveryDir(config, renderId);
  const targetPath = path.join(dir, 'video-only.mp4');
  await copyFile(videoPath, targetPath);
  await saveRecoveryMetadata(config, renderId, {
    ...metadata,
    stage: 'video_rendered',
  });
  return targetPath;
};

export const preserveCandidate = async (
  config: AppConfig,
  renderId: string,
  candidatePath: string,
  metadata: Omit<RecoveryMetadata, 'stage'>,
): Promise<string> => {
  const dir = await ensureRecoveryDir(config, renderId);
  const targetPath = path.join(dir, 'candidate.mp4');
  await copyFile(candidatePath, targetPath);
  await saveRecoveryMetadata(config, renderId, {
    ...metadata,
    stage: 'mux_completed',
  });
  return targetPath;
};

export const markValidationFailed = async (
  config: AppConfig,
  renderId: string,
  error: { category: string; message: string },
): Promise<void> => {
  const existing = await loadRecoveryMetadata(config, renderId);
  if (!existing) return;
  await saveRecoveryMetadata(config, renderId, {
    ...existing,
    stage: 'validation_failed',
    error,
  });
};

export const markCompleted = async (config: AppConfig, renderId: string): Promise<void> => {
  const existing = await loadRecoveryMetadata(config, renderId);
  if (!existing) return;
  await saveRecoveryMetadata(config, renderId, {
    ...existing,
    stage: 'completed',
  });
};

export const hasVideoOnly = async (
  config: AppConfig,
  renderId: string,
): Promise<{ exists: boolean; path: string }> => {
  const dir = getRenderRecoveryDir(config, renderId);
  const videoPath = path.join(dir, 'video-only.mp4');
  try {
    const s = await stat(videoPath);
    return { exists: s.isFile(), path: videoPath };
  } catch {
    return { exists: false, path: videoPath };
  }
};

export const hasCandidate = async (
  config: AppConfig,
  renderId: string,
): Promise<{ exists: boolean; path: string }> => {
  const dir = getRenderRecoveryDir(config, renderId);
  const candidatePath = path.join(dir, 'candidate.mp4');
  try {
    const s = await stat(candidatePath);
    return { exists: s.isFile(), path: candidatePath };
  } catch {
    return { exists: false, path: candidatePath };
  }
};

export const canReuseVideoOnly = async (
  config: AppConfig,
  renderId: string,
  renderFingerprint: string,
): Promise<{ reusable: boolean; path: string }> => {
  const metadata = await loadRecoveryMetadata(config, renderId);
  const { exists, path } = await hasVideoOnly(config, renderId);
  if (!exists || !metadata) {
    return { reusable: false, path };
  }
  return {
    reusable: metadata.render_fingerprint === renderFingerprint,
    path,
  };
};

export const canReuseCandidate = async (
  config: AppConfig,
  renderId: string,
  manifestFingerprint: string,
): Promise<{ reusable: boolean; path: string }> => {
  const metadata = await loadRecoveryMetadata(config, renderId);
  const { exists, path } = await hasCandidate(config, renderId);
  if (!exists || !metadata) {
    return { reusable: false, path };
  }
  return {
    reusable: metadata.manifest_fingerprint === manifestFingerprint,
    path,
  };
};

export const cleanupRecoveryArtifacts = async (
  config: AppConfig,
  renderId: string,
): Promise<void> => {
  const dir = getRenderRecoveryDir(config, renderId);
  await rm(dir, { recursive: true, force: true });
};

export const cleanupIntermediateRecovery = async (
  config: AppConfig,
  renderId: string,
): Promise<void> => {
  const dir = getRenderRecoveryDir(config, renderId);
  const videoOnlyPath = path.join(dir, 'video-only.mp4');
  const candidatePath = path.join(dir, 'candidate.mp4');
  await unlink(videoOnlyPath).catch(() => undefined);
  await unlink(candidatePath).catch(() => undefined);
};

// TTL-based cleanup for old recovery artifacts
export const cleanupOldRecoveryArtifacts = async (
  config: AppConfig,
  maxAgeDays: number,
): Promise<number> => {
  const recoveryDir = getRecoveryDir(config);
  let cleaned = 0;
  try {
    const entries = await import('node:fs/promises').then((fs) => fs.readdir(recoveryDir));
    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

    for (const entry of entries) {
      const entryPath = path.join(recoveryDir, entry);
      const metadataPath = path.join(entryPath, 'metadata.json');
      try {
        const content = await readFile(metadataPath, 'utf-8');
        const metadata = JSON.parse(content) as RecoveryMetadata;
        const createdAt = new Date(metadata.created_at).getTime();

        // Only clean up completed or old failed artifacts
        if (
          metadata.stage === 'completed' ||
          (metadata.stage === 'validation_failed' && now - createdAt > maxAgeMs)
        ) {
          await rm(entryPath, { recursive: true, force: true });
          cleaned += 1;
        }
      } catch {
        // Invalid or missing metadata, skip
      }
    }
  } catch {
    // Recovery dir doesn't exist
  }
  return cleaned;
};
