import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]),
    );
  }
  return value;
};

export const canonicalJson = (value: unknown): string => JSON.stringify(normalize(value));

export const sha256Text = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

export const fingerprint = (value: unknown): string => sha256Text(canonicalJson(value));

export const sha256File = async (filePath: string): Promise<string> =>
  await new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(filePath);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolve(hash.digest('hex')));
  });
