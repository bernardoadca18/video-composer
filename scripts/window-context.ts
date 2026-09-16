import { readFile } from 'node:fs/promises';

import Database from 'better-sqlite3';

import type { AppConfig } from '../src/core/config.js';
import { fingerprint } from '../src/core/identity.js';
import { RenderManifestSchema, type RenderManifest } from '../src/domain/contracts.js';
import { boundedFrameRange } from '../src/domain/frame-range.js';

export const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const integer = (name: string, fallback?: number): number => {
  const raw = argument(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
};

export interface WindowSnapshot {
  render_id: string;
  historical_render_fingerprint: string;
  render_fingerprint: string;
  manifest_fingerprint: string;
  frame_range: [number, number];
  manifest: RenderManifest;
}

export const windowContext = (config: AppConfig) => {
  const renderId = argument('--render-id');
  if (!renderId) throw new Error('Required --render-id UUID --frame N [--before 30 --after 30]');
  const database = new Database(config.databasePath, { readonly: true, fileMustExist: true });
  try {
    const row = database
      .prepare(
        'SELECT manifest_json, render_fingerprint, manifest_fingerprint, render_profile, mode FROM render_jobs WHERE id = ?',
      )
      .get(renderId) as
      | {
          manifest_json: string;
          render_fingerprint: string;
          manifest_fingerprint: string;
          render_profile: string;
          mode: 'preview' | 'final';
        }
      | undefined;
    if (!row) throw new Error('Render job not found');
    const manifest = RenderManifestSchema.parse(JSON.parse(row.manifest_json));
    const frame = integer('--frame');
    const range = boundedFrameRange(
      manifest.duration_in_frames,
      frame,
      integer('--before', 30),
      integer('--after', 30),
    );
    return { renderId, frame, range, manifest, row };
  } finally {
    database.close();
  }
};

export const readWindowSnapshot = async (
  file: string,
  context: ReturnType<typeof windowContext>,
): Promise<WindowSnapshot> => {
  const snapshot = JSON.parse(await readFile(file, 'utf8')) as WindowSnapshot;
  snapshot.manifest = RenderManifestSchema.parse(snapshot.manifest);
  if (
    snapshot.render_id !== context.renderId ||
    snapshot.historical_render_fingerprint !== context.row.render_fingerprint ||
    snapshot.frame_range[0] !== context.range[0] ||
    snapshot.frame_range[1] !== context.range[1] ||
    snapshot.manifest.workflow_id !== context.manifest.workflow_id ||
    snapshot.manifest.production_timeline_fingerprint !==
      context.manifest.production_timeline_fingerprint ||
    snapshot.manifest.duration_in_frames !== context.manifest.duration_in_frames ||
    fingerprint(snapshot.manifest) !== snapshot.manifest_fingerprint
  )
    throw new Error('Prepared window snapshot does not match the historical job/window');
  return snapshot;
};
