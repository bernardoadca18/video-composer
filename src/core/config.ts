import path from 'node:path';

import { z } from 'zod';

const EnvironmentSchema = z.object({
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8013),
  DATA_ROOT: z.string().min(1).default('./data'),
  ORCHESTRATOR_BASE_URL: z.url().default('http://localhost:8011'),
  MEDIA_INDEXER_BASE_URL: z.url().default('http://localhost:8012'),
  HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  ASSET_DOWNLOAD_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  DERIVATIVE_WAIT_TIMEOUT_MS: z.coerce.number().int().positive().default(1_800_000),
  DERIVATIVE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
  ALLOW_FULL_SOURCE_FALLBACK: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  MAX_QUEUE_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  RENDER_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  REMOTION_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  REMOTION_MEDIA_CACHE_BYTES: z.coerce.number().int().positive().default(536_870_912),
  REMOTION_OFFTHREAD_VIDEO_CACHE_BYTES: z.coerce.number().int().positive().default(536_870_912),
  REMOTION_OFFTHREAD_VIDEO_THREADS: z.coerce.number().int().min(1).max(4).default(1),
  MAX_RENDER_DURATION_SECONDS: z.coerce.number().positive().max(86_400).default(14_400),
  MAX_PLACEMENTS: z.coerce.number().int().positive().max(10_000).default(1_000),
  MAX_SOURCE_ASSETS: z.coerce.number().int().positive().max(1_000).default(100),
  SOURCE_CACHE_MAX_AGE_DAYS: z.coerce.number().positive().default(30),
  SOURCE_CACHE_MAX_BYTES: z.coerce.number().int().positive().default(536_870_912_000),
  DISK_SAFETY_RESERVE_BYTES: z.coerce.number().int().positive().default(10_737_418_240),
  OUTPUT_RETENTION_DAYS: z.coerce.number().positive().default(30),
  FFMPEG_BINARY: z.string().min(1).default('ffmpeg'),
  FFPROBE_BINARY: z.string().min(1).default('ffprobe'),
  INTERNAL_ASSET_BASE_URL: z.url().default('http://127.0.0.1:8013'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export interface AppConfig {
  host: string;
  port: number;
  dataRoot: string;
  databasePath: string;
  sourceCacheRoot: string;
  proxyCacheRoot: string;
  narrationCacheRoot: string;
  musicCacheRoot: string;
  programAudioCacheRoot: string;
  workRoot: string;
  outputRoot: string;
  recoveryRoot: string;
  orchestratorBaseUrl: string;
  mediaIndexerBaseUrl: string;
  httpTimeoutMs: number;
  assetDownloadIdleTimeoutMs: number;
  derivativeWaitTimeoutMs: number;
  derivativePollIntervalMs: number;
  allowFullSourceFallback: boolean;
  maxQueueSize: number;
  renderWorkerConcurrency: number;
  remotionConcurrency: number;
  remotionMediaCacheBytes: number;
  remotionOffthreadVideoCacheBytes: number;
  remotionOffthreadVideoThreads: number;
  maxRenderDurationSeconds: number;
  maxPlacements: number;
  maxSourceAssets: number;
  sourceCacheMaxAgeDays: number;
  sourceCacheMaxBytes: number;
  diskSafetyReserveBytes: number;
  outputRetentionDays: number;
  ffmpegBinary: string;
  ffprobeBinary: string;
  internalAssetBaseUrl: string;
  logLevel: string;
}

export const loadConfig = (environment: NodeJS.ProcessEnv = process.env): AppConfig => {
  const value = EnvironmentSchema.parse(environment);
  const dataRoot = path.resolve(value.DATA_ROOT);
  return {
    host: value.HOST,
    port: value.PORT,
    dataRoot,
    databasePath: path.join(dataRoot, 'db', 'renders.sqlite'),
    sourceCacheRoot: path.join(dataRoot, 'cache', 'source'),
    proxyCacheRoot: path.join(dataRoot, 'cache', 'proxies'),
    narrationCacheRoot: path.join(dataRoot, 'cache', 'narration'),
    musicCacheRoot: path.join(dataRoot, 'cache', 'music'),
    programAudioCacheRoot: path.join(dataRoot, 'cache', 'program-audio'),
    workRoot: path.join(dataRoot, 'work'),
    outputRoot: path.join(dataRoot, 'outputs'),
    recoveryRoot: path.join(dataRoot, 'recovery'),
    orchestratorBaseUrl: value.ORCHESTRATOR_BASE_URL.replace(/\/$/, ''),
    mediaIndexerBaseUrl: value.MEDIA_INDEXER_BASE_URL.replace(/\/$/, ''),
    httpTimeoutMs: value.HTTP_TIMEOUT_MS,
    assetDownloadIdleTimeoutMs: value.ASSET_DOWNLOAD_IDLE_TIMEOUT_MS,
    derivativeWaitTimeoutMs: value.DERIVATIVE_WAIT_TIMEOUT_MS,
    derivativePollIntervalMs: value.DERIVATIVE_POLL_INTERVAL_MS,
    allowFullSourceFallback: value.ALLOW_FULL_SOURCE_FALLBACK,
    maxQueueSize: value.MAX_QUEUE_SIZE,
    renderWorkerConcurrency: value.RENDER_WORKER_CONCURRENCY,
    remotionConcurrency: value.REMOTION_CONCURRENCY,
    remotionMediaCacheBytes: value.REMOTION_MEDIA_CACHE_BYTES,
    remotionOffthreadVideoCacheBytes: value.REMOTION_OFFTHREAD_VIDEO_CACHE_BYTES,
    remotionOffthreadVideoThreads: value.REMOTION_OFFTHREAD_VIDEO_THREADS,
    maxRenderDurationSeconds: value.MAX_RENDER_DURATION_SECONDS,
    maxPlacements: value.MAX_PLACEMENTS,
    maxSourceAssets: value.MAX_SOURCE_ASSETS,
    sourceCacheMaxAgeDays: value.SOURCE_CACHE_MAX_AGE_DAYS,
    sourceCacheMaxBytes: value.SOURCE_CACHE_MAX_BYTES,
    diskSafetyReserveBytes: value.DISK_SAFETY_RESERVE_BYTES,
    outputRetentionDays: value.OUTPUT_RETENTION_DAYS,
    ffmpegBinary: value.FFMPEG_BINARY,
    ffprobeBinary: value.FFPROBE_BINARY,
    internalAssetBaseUrl: value.INTERNAL_ASSET_BASE_URL.replace(/\/$/, ''),
    logLevel: value.LOG_LEVEL,
  };
};
