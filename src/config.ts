import { z } from 'zod';

/**
 * Configuración desde variables de entorno. Se valida una vez al arrancar (servidor o comando):
 * si falta algo obligatorio, el proceso no arranca y dice qué falta.
 */
const nonEmpty = z.string().trim().min(1);

const bool = z
  .string()
  .trim()
  .toLowerCase()
  .transform((v, ctx) => {
    if (['true', '1', 'yes', 'si', 'sí'].includes(v)) return true;
    if (['false', '0', 'no', ''].includes(v)) return false;
    ctx.addIssue({ code: 'custom', message: 'debe ser true o false' });
    return z.NEVER;
  });

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    // En Railway: volumen montado en /data y DATABASE_PATH=/data/app.db
    DATABASE_PATH: z.string().trim().min(1).default('./data/app.db'),

    // Meta / Instagram (Instagram API con Instagram Login)
    IG_APP_ID: z.string().trim().optional(),
    IG_APP_SECRET: nonEmpty,
    IG_ACCESS_TOKEN: nonEmpty,
    IG_USER_ID: z.string().trim().regex(/^\d+$/, 'debe ser numérico (user_id de GET /me)'),
    WEBHOOK_VERIFY_TOKEN: nonEmpty,
    META_API_VERSION: z.string().trim().regex(/^v\d+\.\d+$/, 'formato vNN.N').default('v27.0'),
    /**
     * Cómo está configurada la app de Meta:
     *  - unified:   "API setup with Unified login" (graph.facebook.com, token de usuario del sistema)
     *  - instagram: "API setup with Instagram login" (graph.instagram.com, token de usuario de Instagram)
     */
    META_LOGIN: z.enum(['unified', 'instagram']).default('unified'),
    /** Solo para forzar otro host (pruebas). Por defecto depende de META_LOGIN. */
    META_GRAPH_URL: z.string().trim().url().optional(),

    // Claude
    ANTHROPIC_API_KEY: nonEmpty,
    CLAUDE_MODEL: nonEmpty.default('claude-haiku-5-5'),

    // Respuestas
    REPLY_DELAY_MIN: z.coerce.number().int().min(0).default(60),
    REPLY_DELAY_MAX: z.coerce.number().int().min(0).default(300),
    MAX_REPLIES_PER_HOUR: z.coerce.number().int().min(1).default(60),
    REVIEW_MODE: bool.default(true),
    /** No responder comentarios más antiguos que esto (horas). Vacío o 0 = responder todos. */
    MAX_REPLY_AGE_HOURS: z.coerce.number().min(0).default(0),

    // Informes y página de revisión
    REPORT_TOKEN: z.string().trim().min(16, 'usa un token largo (16+ caracteres)'),

    // Plan B: leer comentarios recientes periódicamente si los webhooks no llegan. 0 = apagado.
    POLL_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(0),
    POLL_MEDIA_COUNT: z.coerce.number().int().min(1).max(25).default(5),
  })
  .refine((e) => e.REPLY_DELAY_MAX >= e.REPLY_DELAY_MIN, {
    message: 'REPLY_DELAY_MAX debe ser >= REPLY_DELAY_MIN',
    path: ['REPLY_DELAY_MAX'],
  })
  .refine((e) => e.POLL_INTERVAL_SECONDS === 0 || e.POLL_INTERVAL_SECONDS >= 30, {
    message: 'POLL_INTERVAL_SECONDS debe ser 0 (apagado) o >= 30',
    path: ['POLL_INTERVAL_SECONDS'],
  });

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  nodeEnv: Env['NODE_ENV'];
  port: number;
  host: string;
  logLevel: Env['LOG_LEVEL'];
  databasePath: string;
  webhook: { appSecret: string; verifyToken: string };
  meta: {
    appId: string | null;
    accessToken: string;
    igUserId: string;
    apiVersion: string;
    graphUrl: string;
    login: 'unified' | 'instagram';
  };
  claude: { apiKey: string; model: string };
  replies: {
    delayMinSec: number;
    delayMaxSec: number;
    maxPerHour: number;
    reviewMode: boolean;
    maxAgeHours: number;
  };
  reportToken: string;
  poll: { intervalSec: number; mediaCount: number };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(raíz)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuración inválida. Revisa las variables de entorno:\n${problems}`);
  }
  const e = parsed.data;
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    databasePath: e.DATABASE_PATH,
    webhook: { appSecret: e.IG_APP_SECRET, verifyToken: e.WEBHOOK_VERIFY_TOKEN },
    meta: {
      appId: e.IG_APP_ID || null,
      accessToken: e.IG_ACCESS_TOKEN,
      igUserId: e.IG_USER_ID,
      apiVersion: e.META_API_VERSION,
      graphUrl: (
        e.META_GRAPH_URL ?? (e.META_LOGIN === 'instagram' ? 'https://graph.instagram.com' : 'https://graph.facebook.com')
      ).replace(/\/+$/, ''),
      login: e.META_LOGIN,
    },
    claude: { apiKey: e.ANTHROPIC_API_KEY, model: e.CLAUDE_MODEL },
    replies: {
      delayMinSec: e.REPLY_DELAY_MIN,
      delayMaxSec: e.REPLY_DELAY_MAX,
      maxPerHour: e.MAX_REPLIES_PER_HOUR,
      reviewMode: e.REVIEW_MODE,
      maxAgeHours: e.MAX_REPLY_AGE_HOURS,
    },
    reportToken: e.REPORT_TOKEN,
    poll: { intervalSec: e.POLL_INTERVAL_SECONDS, mediaCount: e.POLL_MEDIA_COUNT },
  };
}
