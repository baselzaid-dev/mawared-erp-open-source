import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { createApp, type AiProvider } from './src/app';
import { createAppLogger } from './src/appLogger';
import { installGracefulShutdown } from './src/gracefulShutdown';
import { assertRuntimeConfig } from './src/runtimeConfig';

const prisma = new PrismaClient();
const HOST = process.env.HOST || '127.0.0.1';
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const isProduction = process.env.NODE_ENV === 'production';
const startupLogger = createAppLogger({ isProduction });

function parseCorsOrigins(): string[] | undefined {
  const raw = process.env.CORS_ORIGINS;
  if (!raw) return undefined;
  const origins = raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return origins.length > 0 ? origins : undefined;
}

function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildAiProvider(): AiProvider | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return {
    async chat(message: string): Promise<string> {
      // Lazy import so environments without the key never load the SDK.
      const { GoogleGenAI } = await import('@google/genai');
      const genai = new GoogleGenAI({ apiKey });
      const response = await genai.models.generateContent({
        model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
        contents: message,
      });
      return response.text ?? '';
    },
  };
}

const corsOrigins = parseCorsOrigins() ?? (isProduction
  ? undefined
  : ['http://localhost:5173', 'http://127.0.0.1:5173']);
const proxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 0);
if (!Number.isSafeInteger(proxyHops) || proxyHops < 0) {
  throw new Error('TRUST_PROXY_HOPS must be a non-negative integer');
}

// Validate the configuration contract before anything binds a port. On a
// deployed tier an invalid required variable throws here, so the instance
// never becomes routable in a broken state. Findings name variables only —
// never their values. See `src/runtimeConfig.ts` for the tier rules.
assertRuntimeConfig(process.env, { isProduction, logger: startupLogger });

const app = createApp({
  prisma,
  aiProvider: buildAiProvider(),
  config: {
    jwtSecret: process.env.JWT_SECRET,
    accessTokenTtl: process.env.ACCESS_TOKEN_TTL || '15m',
    refreshTokenTtlDays: process.env.REFRESH_TOKEN_TTL_DAYS
      ? Number(process.env.REFRESH_TOKEN_TTL_DAYS)
      : 7,
    authRateLimitWindowMs: process.env.AUTH_RATE_LIMIT_WINDOW_MS
      ? positiveNumber('AUTH_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000)
      : 15 * 60 * 1000,
    authRateLimitMax: positiveNumber('AUTH_RATE_LIMIT_MAX', 10),
    mfaEncryptionKey: process.env.MFA_ENCRYPTION_KEY,
    mfaRateLimitMax: positiveNumber('MFA_RATE_LIMIT_MAX', 5),
    platformJwtSecret: process.env.PLATFORM_JWT_SECRET,
    platformAccessTokenTtl: process.env.PLATFORM_ACCESS_TOKEN_TTL || '10m',
    platformRefreshTokenTtlDays: process.env.PLATFORM_REFRESH_TOKEN_TTL_DAYS
      ? positiveNumber('PLATFORM_REFRESH_TOKEN_TTL_DAYS', 7)
      : 7,
    platformAuthRateLimitMax: positiveNumber('PLATFORM_AUTH_RATE_LIMIT_MAX', 10),
    platformProvisionRateLimitWindowMs: positiveNumber(
      'PLATFORM_PROVISION_RATE_LIMIT_WINDOW_MS',
      60 * 60 * 1000,
    ),
    platformProvisionRateLimitMax: positiveNumber('PLATFORM_PROVISION_RATE_LIMIT_MAX', 5),
    chatMessageRateLimitWindowMs: positiveNumber('CHAT_RATE_LIMIT_WINDOW_MS', 60_000),
    chatMessageRateLimitMax: positiveNumber('CHAT_RATE_LIMIT_MAX', 60),
    exportRateLimitWindowMs: positiveNumber('EXPORT_RATE_LIMIT_WINDOW_MS', 60_000),
    exportRateLimitMax: positiveNumber('EXPORT_RATE_LIMIT_MAX', 10),
    sensitiveRateLimitWindowMs: positiveNumber('SENSITIVE_RATE_LIMIT_WINDOW_MS', 60_000),
    sensitiveRateLimitMax: positiveNumber('SENSITIVE_RATE_LIMIT_MAX', 60),
    aiRateLimitWindowMs: positiveNumber('AI_RATE_LIMIT_WINDOW_MS', 60_000),
    aiRateLimitMax: positiveNumber('AI_RATE_LIMIT_MAX', 20),
    corsOrigins,
    trustProxyHops: proxyHops,
    isProduction,
  },
});

app.get('/', (_req, res) => {
  res.status(200).json({ ok: true, service: 'mawared-backend' });
});

const server = app.listen(PORT, HOST, () => {
  startupLogger.info('startup.listening', { port: PORT });
});

installGracefulShutdown({
  server,
  disconnect: () => prisma.$disconnect(),
  logger: startupLogger,
});
