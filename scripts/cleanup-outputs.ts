import { unlink } from 'node:fs/promises';
import path from 'node:path';

import { loadConfig } from '../src/core/config.js';
import { RenderJobRepository } from '../src/jobs/repository.js';

const config = loadConfig();
const repository = new RenderJobRepository(config.databasePath);
let deleted = 0;
try {
  const cutoff = new Date(Date.now() - config.outputRetentionDays * 86_400_000).toISOString();
  for (const job of repository.completedBefore(cutoff)) {
    await unlink(path.join(config.outputRoot, `${job.id}.mp4`)).catch(() => undefined);
    repository.expireOutput(job.id);
    deleted += 1;
  }
  process.stdout.write(`${JSON.stringify({ cutoff, deleted }, null, 2)}\n`);
} finally {
  repository.close();
}
