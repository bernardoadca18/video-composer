export type InternalErrorDiagnostics = Record<string, string | number | boolean | null | undefined>;

interface ComposerErrorOptions {
  cause?: unknown;
  diagnostics?: InternalErrorDiagnostics;
}

export class ComposerError extends Error {
  public readonly diagnostics: InternalErrorDiagnostics;

  constructor(
    public readonly category: string,
    message: string,
    public readonly httpStatus = 500,
    options: ComposerErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ComposerError';
    this.diagnostics = options.diagnostics ?? {};
  }
}

export const internalError = (
  error: unknown,
): {
  name: string;
  message: string;
  stack: string | null;
  diagnostics: InternalErrorDiagnostics;
} => {
  const diagnostics = error instanceof ComposerError ? error.diagnostics : {};
  let current = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && current.cause !== undefined && !seen.has(current.cause)) {
    seen.add(current);
    current = current.cause;
  }
  if (current instanceof Error) {
    return {
      name: current.name || current.constructor.name,
      message: current.message,
      stack: current.stack ?? null,
      diagnostics,
    };
  }
  return {
    name: typeof current,
    message: String(current),
    stack: null,
    diagnostics,
  };
};

export const publicError = (
  error: unknown,
): { category: string; message: string; status: number } => {
  if (error instanceof ComposerError) {
    return { category: error.category, message: error.message, status: error.httpStatus };
  }
  return { category: 'internal_error', message: 'Video Composer operation failed', status: 500 };
};
