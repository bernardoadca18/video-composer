import path from 'node:path';

import { loadConfig } from '../src/core/config.js';
import { RenderJobRepository } from '../src/jobs/repository.js';
import { cleanupCache } from '../src/storage/retention.js';

const config = loadConfig();
const repository = new RenderJobRepository(config.databasePath);
try {
  const protectedPaths = new Set<string>();
  for (const job of repository.recoverable()) {
    protectedPaths.add(
      path.join(config.narrationCacheRoot, `${job.manifest.narration.asset_key}.wav`),
    );
    for (const asset of job.manifest.source_assets) {
      protectedPaths.add(path.join(config.sourceCacheRoot, `${asset.sha256}.media`));
    }
    for (const placement of job.manifest.placements) {
      protectedPaths.add(path.join(config.proxyCacheRoot, `${placement.source.proxy_key}.mp4`));
    }
  }
  const result = await cleanupCache(
    [config.sourceCacheRoot, config.proxyCacheRoot, config.narrationCacheRoot],
    config.sourceCacheMaxAgeDays,
    config.sourceCacheMaxBytes,
    protectedPaths,
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  repository.close();
}
