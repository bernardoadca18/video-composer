import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import type { FastifyReply, FastifyRequest } from 'fastify';

const rangePattern = /^bytes=(\d*)-(\d*)$/;

export const sendControlledFile = async (
  request: FastifyRequest,
  reply: FastifyReply,
  filePath: string,
  contentType: string,
  downloadName?: string,
): Promise<FastifyReply> => {
  const details = await stat(filePath).catch(() => null);
  if (!details?.isFile()) return await reply.code(404).send({ error: 'artifact_not_found' });
  reply.header('Accept-Ranges', 'bytes').header('Content-Type', contentType);
  if (downloadName) reply.header('Content-Disposition', `attachment; filename="${downloadName}"`);
  const rawRange = request.headers.range;
  if (!rawRange) {
    reply.header('Content-Length', details.size);
    return await reply.send(createReadStream(filePath));
  }
  const match = rangePattern.exec(rawRange);
  if (!match) {
    return await reply.code(416).header('Content-Range', `bytes */${details.size}`).send();
  }
  const requestedStart = match[1] ? Number(match[1]) : null;
  const requestedEnd = match[2] ? Number(match[2]) : null;
  const start = requestedStart ?? Math.max(0, details.size - (requestedEnd ?? 0));
  let end = requestedStart === null ? details.size - 1 : (requestedEnd ?? details.size - 1);
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    start >= details.size
  ) {
    return await reply.code(416).header('Content-Range', `bytes */${details.size}`).send();
  }
  end = Math.min(end, details.size - 1);
  reply
    .code(206)
    .header('Content-Length', end - start + 1)
    .header('Content-Range', `bytes ${start}-${end}/${details.size}`);
  return await reply.send(createReadStream(filePath, { start, end }));
};
