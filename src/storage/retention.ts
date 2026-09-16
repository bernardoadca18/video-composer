import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

interface Entry {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface CleanupResult {
  deletedFiles: number;
  deletedBytes: number;
  remainingBytes: number;
}

const files = async (root: string): Promise<Entry[]> => {
  const names = await readdir(root).catch(() => []);
  const entries = await Promise.all(
    names.map(async (name) => {
      const filePath = path.join(root, name);
      const details = await stat(filePath).catch(() => null);
      return details?.isFile()
        ? { path: filePath, size: details.size, mtimeMs: details.mtimeMs }
        : null;
    }),
  );
  return entries.filter((value): value is Entry => value !== null);
};

export const cleanupCache = async (
  roots: readonly string[],
  maximumAgeDays: number,
  maximumBytes: number,
  protectedPaths: ReadonlySet<string>,
  protectedRoots: readonly string[] = [],
): Promise<CleanupResult> => {
  const entries = (await Promise.all(roots.map(files)))
    .flat()
    .sort((left, right) => left.mtimeMs - right.mtimeMs);
  const cutoff = Date.now() - maximumAgeDays * 86_400_000;
  let remainingBytes = entries.reduce((total, item) => total + item.size, 0);
  let deletedFiles = 0;
  let deletedBytes = 0;
  for (const item of entries) {
    if (
      protectedPaths.has(item.path) ||
      protectedRoots.some((root) => item.path.startsWith(`${root}${path.sep}`)) ||
      item.path.endsWith('.lock') ||
      (item.mtimeMs >= cutoff && remainingBytes <= maximumBytes)
    ) {
      continue;
    }
    await unlink(item.path).catch(() => undefined);
    remainingBytes -= item.size;
    deletedFiles += 1;
    deletedBytes += item.size;
  }
  return { deletedFiles, deletedBytes, remainingBytes };
};
