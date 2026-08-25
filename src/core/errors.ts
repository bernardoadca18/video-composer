export class ComposerError extends Error {
  constructor(
    public readonly category: string,
    message: string,
    public readonly httpStatus = 500,
  ) {
    super(message);
  }
}

export const publicError = (
  error: unknown,
): { category: string; message: string; status: number } => {
  if (error instanceof ComposerError) {
    return { category: error.category, message: error.message, status: error.httpStatus };
  }
  return { category: 'internal_error', message: 'Video Composer operation failed', status: 500 };
};
