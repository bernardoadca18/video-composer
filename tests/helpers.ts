import path from 'node:path';

import type { AppConfig } from '../src/core/config.js';
import { fingerprint } from '../src/core/identity.js';
import type {
  MediaAssetMetadata,
  ProductionTimelineV1,
  RenderManifestV1,
} from '../src/domain/contracts.js';
import { buildRenderManifest } from '../src/domain/manifest.js';
import { youtube1080p30V1 } from '../src/domain/profiles.js';

export const WORKFLOW_ID = '10000000-0000-4000-8000-000000000001';
export const TIMELINE_ID = '20000000-0000-4000-8000-000000000001';
export const PROJECT_ID = '30000000-0000-4000-8000-000000000001';
export const SESSION_ID = '40000000-0000-4000-8000-000000000001';
export const MEDIA_ID = '50000000-0000-4000-8000-000000000001';
export const AUDIO_SHA = 'a'.repeat(64);
export const MEDIA_SHA = 'b'.repeat(64);

export const testConfig = (root: string): AppConfig => ({
  host: '127.0.0.1',
  port: 0,
  dataRoot: root,
  databasePath: path.join(root, 'db', 'renders.sqlite'),
  sourceCacheRoot: path.join(root, 'cache', 'source'),
  proxyCacheRoot: path.join(root, 'cache', 'proxies'),
  narrationCacheRoot: path.join(root, 'cache', 'narration'),
  musicCacheRoot: path.join(root, 'cache', 'music'),
  programAudioCacheRoot: path.join(root, 'cache', 'program-audio'),
  workRoot: path.join(root, 'work'),
  outputRoot: path.join(root, 'outputs'),
  orchestratorBaseUrl: 'http://orchestrator.test',
  mediaIndexerBaseUrl: 'http://media-indexer.test',
  httpTimeoutMs: 1_000,
  assetDownloadIdleTimeoutMs: 1_000,
  maxQueueSize: 10,
  renderWorkerConcurrency: 1,
  remotionConcurrency: 1,
  maxRenderDurationSeconds: 14_400,
  maxPlacements: 1_000,
  maxSourceAssets: 100,
  sourceCacheMaxAgeDays: 30,
  sourceCacheMaxBytes: 1_000_000_000,
  outputRetentionDays: 30,
  ffmpegBinary: 'ffmpeg',
  ffprobeBinary: 'ffprobe',
  internalAssetBaseUrl: 'http://127.0.0.1:18013',
  logLevel: 'silent',
});

export const mediaMetadata = (overrides: Partial<MediaAssetMetadata> = {}): MediaAssetMetadata => ({
  id: MEDIA_ID,
  project_id: PROJECT_ID,
  media_kind: 'video',
  original_filename: 'gameplay.mp4',
  content_type: 'video/mp4',
  byte_size: 1234,
  sha256: MEDIA_SHA,
  duration_seconds: 60,
  format_name: 'mov,mp4',
  video_codec: 'h264',
  audio_codec: 'aac',
  fps: 60,
  width: 1920,
  height: 1080,
  ...overrides,
});

export const productionTimeline = (
  overrides: Partial<ProductionTimelineV1> = {},
): ProductionTimelineV1 => ({
  id: TIMELINE_ID,
  workflow_id: WORKFLOW_ID,
  schema_version: 'production_timeline_schema_v1',
  strategy_version: 'production_timeline_v1',
  fingerprint: fingerprint({ timeline: 1 }),
  status: 'completed',
  duration_seconds: 6,
  tracks: {
    narration: {
      kind: 'narration',
      timeline_start_seconds: 0,
      timeline_end_seconds: 6,
      source_start_seconds: 0,
      source_end_seconds: 6,
      audio_url: `/workflow/${WORKFLOW_ID}/audio`,
      audio_sha256: AUDIO_SHA,
      sample_rate: 48_000,
      channels: 1,
      byte_size: 100,
    },
    primary_visual: {
      placements: [
        {
          id: '60000000-0000-4000-8000-000000000001',
          order: 0,
          timeline_start_seconds: 0,
          timeline_end_seconds: 3,
          source: {
            source_type: 'gameplay',
            project_id: PROJECT_ID,
            session_id: SESSION_ID,
            media_id: MEDIA_ID,
            candidate_start_seconds: 10,
            candidate_end_seconds: 16,
            source_start_seconds: 10,
            source_end_seconds: 13,
          },
          playback_rate: 1,
          transition: 'cut',
        },
        {
          id: '60000000-0000-4000-8000-000000000002',
          order: 1,
          timeline_start_seconds: 3,
          timeline_end_seconds: 6,
          source: {
            source_type: 'gameplay',
            project_id: PROJECT_ID,
            session_id: SESSION_ID,
            media_id: MEDIA_ID,
            candidate_start_seconds: 20,
            candidate_end_seconds: 26,
            source_start_seconds: 20,
            source_end_seconds: 23,
          },
          playback_rate: 1,
          transition: 'cut',
        },
      ],
    },
  },
  gaps: [],
  visual_coverage_ratio: 1,
  ...overrides,
});

export const renderManifest = (root: string): RenderManifestV1 =>
  buildRenderManifest(
    productionTimeline(),
    new Map([[MEDIA_ID, mediaMetadata()]]),
    youtube1080p30V1,
    'final',
    testConfig(root),
  ).manifest;
