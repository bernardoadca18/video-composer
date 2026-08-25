import { mkdirSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import type { RenderManifest } from '../domain/contracts.js';

export type RenderStatus =
  'queued' | 'preparing_assets' | 'rendering' | 'validating' | 'completed' | 'failed';

export interface RenderJob {
  id: string;
  workflowId: string;
  productionTimelineId: string;
  productionTimelineFingerprint: string;
  renderProfile: string;
  renderProfileIdentity: string;
  mode: 'preview' | 'final';
  status: RenderStatus;
  phase: RenderStatus;
  progress: number;
  framesRendered: number;
  totalFrames: number;
  idempotencyKey: string | null;
  requestFingerprint: string;
  renderFingerprint: string;
  manifestFingerprint: string;
  manifest: RenderManifest;
  outputPath: string | null;
  output: Record<string, unknown> | null;
  metrics: Record<string, unknown> | null;
  errorCategory: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

interface Row {
  id: string;
  workflow_id: string;
  production_timeline_id: string;
  production_timeline_fingerprint: string;
  render_profile: string;
  render_profile_identity: string;
  mode: 'preview' | 'final';
  status: RenderStatus;
  phase: RenderStatus;
  progress: number;
  frames_rendered: number;
  total_frames: number;
  idempotency_key: string | null;
  request_fingerprint: string;
  render_fingerprint: string;
  manifest_fingerprint: string;
  manifest_json: string;
  output_path: string | null;
  output_json: string | null;
  metrics_json: string | null;
  error_category: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

const rowToJob = (row: Row): RenderJob => ({
  id: row.id,
  workflowId: row.workflow_id,
  productionTimelineId: row.production_timeline_id,
  productionTimelineFingerprint: row.production_timeline_fingerprint,
  renderProfile: row.render_profile,
  renderProfileIdentity: row.render_profile_identity,
  mode: row.mode,
  status: row.status,
  phase: row.phase,
  progress: row.progress,
  framesRendered: row.frames_rendered,
  totalFrames: row.total_frames,
  idempotencyKey: row.idempotency_key,
  requestFingerprint: row.request_fingerprint,
  renderFingerprint: row.render_fingerprint,
  manifestFingerprint: row.manifest_fingerprint,
  manifest: JSON.parse(row.manifest_json) as RenderManifest,
  outputPath: row.output_path,
  output: row.output_json ? (JSON.parse(row.output_json) as Record<string, unknown>) : null,
  metrics: row.metrics_json ? (JSON.parse(row.metrics_json) as Record<string, unknown>) : null,
  errorCategory: row.error_category,
  errorMessage: row.error_message,
  createdAt: row.created_at,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  updatedAt: row.updated_at,
});

export interface CreateRenderJob {
  id: string;
  workflowId: string;
  productionTimelineId: string;
  productionTimelineFingerprint: string;
  renderProfile: string;
  renderProfileIdentity: string;
  mode: 'preview' | 'final';
  idempotencyKey: string | null;
  requestFingerprint: string;
  renderFingerprint: string;
  manifestFingerprint: string;
  manifest: RenderManifest;
}

export class RenderJobRepository {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initialize();
  }

  private initialize(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version > 1) throw new Error('unsupported_database_schema');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS render_jobs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        production_timeline_id TEXT NOT NULL,
        production_timeline_fingerprint TEXT NOT NULL,
        render_profile TEXT NOT NULL,
        render_profile_identity TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('preview', 'final')),
        status TEXT NOT NULL CHECK (status IN (
          'queued', 'preparing_assets', 'rendering', 'validating', 'completed', 'failed'
        )),
        phase TEXT NOT NULL,
        progress REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
        frames_rendered INTEGER NOT NULL DEFAULT 0 CHECK (frames_rendered >= 0),
        total_frames INTEGER NOT NULL CHECK (total_frames > 0),
        idempotency_key TEXT UNIQUE,
        request_fingerprint TEXT NOT NULL,
        render_fingerprint TEXT NOT NULL UNIQUE,
        manifest_fingerprint TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        output_path TEXT,
        output_json TEXT,
        metrics_json TEXT,
        error_category TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_render_jobs_workflow_created
        ON render_jobs (workflow_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS ix_render_jobs_status_created
        ON render_jobs (status, created_at);
      PRAGMA user_version = 1;
    `);
  }

  close(): void {
    this.db.close();
  }

  create(input: CreateRenderJob): RenderJob {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO render_jobs (
          id, workflow_id, production_timeline_id, production_timeline_fingerprint,
          render_profile, render_profile_identity, mode, status, phase, total_frames,
          idempotency_key, request_fingerprint, render_fingerprint, manifest_fingerprint,
          manifest_json, created_at, updated_at
        ) VALUES (
          @id, @workflowId, @productionTimelineId, @productionTimelineFingerprint,
          @renderProfile, @renderProfileIdentity, @mode, 'queued', 'queued', @totalFrames,
          @idempotencyKey, @requestFingerprint, @renderFingerprint, @manifestFingerprint,
          @manifestJson, @now, @now
        )`,
      )
      .run({
        ...input,
        totalFrames: input.manifest.duration_in_frames,
        manifestJson: JSON.stringify(input.manifest),
        now,
      });
    return this.get(input.id)!;
  }

  get(id: string): RenderJob | null {
    const row = this.db.prepare('SELECT * FROM render_jobs WHERE id = ?').get(id) as
      Row | undefined;
    return row ? rowToJob(row) : null;
  }

  byIdempotencyKey(key: string): RenderJob | null {
    const row = this.db.prepare('SELECT * FROM render_jobs WHERE idempotency_key = ?').get(key) as
      Row | undefined;
    return row ? rowToJob(row) : null;
  }

  byRenderFingerprint(value: string): RenderJob | null {
    const row = this.db
      .prepare('SELECT * FROM render_jobs WHERE render_fingerprint = ?')
      .get(value) as Row | undefined;
    return row ? rowToJob(row) : null;
  }

  recoverable(): RenderJob[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM render_jobs
           WHERE status IN ('queued', 'preparing_assets', 'rendering', 'validating')
           ORDER BY created_at`,
        )
        .all() as Row[]
    ).map(rowToJob);
  }

  completedBefore(timestamp: string): RenderJob[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM render_jobs
           WHERE status = 'completed' AND completed_at < ?
           ORDER BY completed_at`,
        )
        .all(timestamp) as Row[]
    ).map(rowToJob);
  }

  expireOutput(id: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE render_jobs SET status = 'failed', phase = 'failed', output_path = NULL,
          output_json = NULL, error_category = 'output_expired',
          error_message = 'Rendered output expired by retention policy', updated_at = ?
         WHERE id = ? AND status = 'completed'`,
      )
      .run(now, id);
  }

  updateProgress(id: string, status: RenderStatus, progress: number, framesRendered = 0): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE render_jobs SET
           status = ?, phase = ?, progress = ?, frames_rendered = ?,
           started_at = COALESCE(started_at, ?), updated_at = ?
         WHERE id = ?`,
      )
      .run(status, status, progress, framesRendered, now, now, id);
  }

  complete(
    id: string,
    outputPath: string,
    output: Record<string, unknown>,
    metrics: Record<string, unknown>,
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE render_jobs SET status = 'completed', phase = 'completed', progress = 1,
          frames_rendered = total_frames, output_path = ?, output_json = ?, metrics_json = ?,
          error_category = NULL, error_message = NULL, completed_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(outputPath, JSON.stringify(output), JSON.stringify(metrics), now, now, id);
  }

  fail(id: string, category: string, message: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE render_jobs SET status = 'failed', phase = 'failed',
          error_category = ?, error_message = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(category, message, now, now, id);
  }

  requeue(id: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE render_jobs SET status = 'queued', phase = 'queued', progress = 0,
          frames_rendered = 0, output_path = NULL, output_json = NULL, metrics_json = NULL,
          error_category = NULL, error_message = NULL, started_at = NULL, completed_at = NULL,
          updated_at = ? WHERE id = ?`,
      )
      .run(now, id);
  }
}
