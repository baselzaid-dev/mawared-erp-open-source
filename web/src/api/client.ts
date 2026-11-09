import { sessionMemory } from '@/auth/sessionMemory';
import type { SessionTokens } from '@/auth/types';

type ApiErrorBody = {
  error?: string;
  code?: string | number;
  message?: string;
  messageKey?: string;
};

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').trim().replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly messageKey?: string,
  ) {
    super(messageKey ?? code);
    this.name = 'ApiError';
  }
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function request<T>(
  path: string,
  init: RequestInit = {},
  accessToken?: string,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body) headers.set('Content-Type', 'application/json');
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, 'NetworkError');
  }

  const body = await parseResponseBody(response);
  if (!response.ok) {
    const error = (body ?? {}) as ApiErrorBody;
    throw new ApiError(
      response.status,
      String(error.error ?? error.code ?? 'RequestFailed'),
      error.messageKey ?? error.message,
    );
  }
  return body as T;
}

let refreshInFlight: Promise<SessionTokens> | null = null;

async function refreshSession(refreshToken: string): Promise<SessionTokens> {
  if (!refreshInFlight) {
    refreshInFlight = request<{ token: string; refreshToken: string }>(
      '/api/auth/refresh',
      {
        method: 'POST',
        body: JSON.stringify({ refreshToken }),
      },
    )
      .then((response) => {
        const tokens = {
          accessToken: response.token,
          refreshToken: response.refreshToken,
        };
        sessionMemory.set(tokens);
        return tokens;
      })
      .catch((error) => {
        sessionMemory.clear();
        throw error;
      })
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

export async function authenticatedRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const tokens = sessionMemory.get();
  if (!tokens) throw new ApiError(401, 'SessionMissing');

  try {
    return await request<T>(path, init, tokens.accessToken);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
    const refreshed = await refreshSession(tokens.refreshToken);
    return request<T>(path, init, refreshed.accessToken);
  }
}

export interface DownloadedFile {
  blob: Blob;
  filename: string;
}

/** Only allow a server-supplied filename that is already safe to write to disk. */
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

function filenameFrom(disposition: string | null, fallback: string): string {
  if (!disposition) return fallback;
  const match = /filename\*?=\s*(?:UTF-8''|")?([^";]+)/i.exec(disposition);
  const raw = match?.[1]?.trim();
  return raw && SAFE_FILENAME.test(raw) ? raw : fallback;
}

async function downloadOnce(
  path: string,
  init: RequestInit,
  accessToken: string,
  fallbackFilename: string,
): Promise<DownloadedFile> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  headers.set('Authorization', `Bearer ${accessToken}`);

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, 'NetworkError');
  }

  if (!response.ok) {
    const body = (await parseResponseBody(response)) as ApiErrorBody | null;
    throw new ApiError(
      response.status,
      String(body?.error ?? body?.code ?? 'RequestFailed'),
      body?.messageKey ?? body?.message,
    );
  }

  return {
    blob: await response.blob(),
    filename: filenameFrom(response.headers.get('Content-Disposition'), fallbackFilename),
  };
}

/**
 * Downloads a file the backend generated. Export authorization, row caps and
 * spreadsheet-formula neutralization all stay on the server — the client never
 * builds an export itself.
 */
export async function authenticatedDownload(
  path: string,
  init: RequestInit,
  fallbackFilename: string,
): Promise<DownloadedFile> {
  const tokens = sessionMemory.get();
  if (!tokens) throw new ApiError(401, 'SessionMissing');
  try {
    return await downloadOnce(path, init, tokens.accessToken, fallbackFilename);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
    const refreshed = await refreshSession(tokens.refreshToken);
    return downloadOnce(path, init, refreshed.accessToken, fallbackFilename);
  }
}
