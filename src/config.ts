import { z } from 'zod';

/**
 * Configuración desde variables de entorno. Se valida una vez al arrancar (servidor o comando):
 * si falta algo obligatorio, el proceso no arranca y dice qué falta.
 */
const nonEmpty = z.string().trim().min(1);

/**
 * Secretos y tokens: sin espacios ni saltos de línea dentro. Si hay uno, casi siempre es que al
 * pegar en el Raw Editor de Railway se han juntado dos variables en una.
 */
const secret = nonEmpty.refine((v) => !/\s/.test(v), {
  message: 'contiene espacios o saltos de línea: ¿se han juntado dos variables al pegarlas? Déjala solo con su valor',
});

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
    IG_APP_SECRET: secret,
    IG_ACCESS_TOKEN: secret,
    /**
     * ID de tu cuenta de Instagram. Para gestionar varias cuentas, sus IDs separados por comas: la
     * primera es la principal (la de los prompts de prompts/*.md).
     */
    IG_USER_ID: z
      .string()
      .trim()
      .regex(/^\d+(\s*,\s*\d+)*$/, 'debe ser numérico (o varios separados por comas)'),
    WEBHOOK_VERIFY_TOKEN: secret,
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
    ANTHROPIC_API_KEY: secret,
    /**
     * Solo si la API key no pertenece a un workspace (Anthropic responde "This API key is not
     * scoped to a workspace…"): ID del workspace (wrkspc_…) que se envía en anthropic-workspace-id.
     */
    ANTHROPIC_WORKSPACE_ID: z
      .string()
      .trim()
      .optional()
      .refine((v) => !v || !/\s/.test(v), { message: 'no puede contener espacios' }),
    CLAUDE_MODEL: nonEmpty.default('claude-haiku-5-5'),

    // Respuestas
    REPLY_DELAY_MIN: z.coerce.number().int().min(0).default(60),
    REPLY_DELAY_MAX: z.coerce.number().int().min(0).default(300),
    MAX_REPLIES_PER_HOUR: z.coerce.number().int().min(1).default(60),
    REVIEW_MODE: bool.default(true),
    /** Dar me gusta a los comentarios que se responden (ver writeClient.likeComment). */
    LIKE_REPLIED_COMMENTS: bool.default(false),
    /** No responder comentarios más antiguos que esto (horas). Vacío o 0 = responder todos. */
    MAX_REPLY_AGE_HOURS: z.coerce.number().min(0).default(0),

    // Informes y página de revisión
    REPORT_TOKEN: secret.refine((v) => v.length >= 16, { message: 'usa un token largo (16+ caracteres)' }),

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

export interface AccountConfig {
  /** ID de la cuenta de Instagram (el de /me/assigned_instagram_accounts). */
  id: string;
  /** IG_ACCESS_TOKEN_<id> si existe; si no, IG_ACCESS_TOKEN. */
  accessToken: string;
}

/**
 * Cuentas de IG_USER_ID (sin repetir). Cada una usa IG_ACCESS_TOKEN_<id> si existe (por si el token
 * de una cuenta no sirve para las demás) y, si no, IG_ACCESS_TOKEN.
 */
function parseAccounts(ids: string, defaultToken: string, env: NodeJS.ProcessEnv): AccountConfig[] {
  const unique = [...new Set(ids.split(',').map((x) => x.trim()).filter(Boolean))];
  const problems: string[] = [];
  const accounts = unique.map((id) => {
    const own = env[`IG_ACCESS_TOKEN_${id}`]?.trim();
    if (own !== undefined && own !== '' && /\s/.test(own)) {
      problems.push(`  - IG_ACCESS_TOKEN_${id}: contiene espacios o saltos de línea: déjala solo con su valor`);
    }
    return { id, accessToken: own || defaultToken };
  });
  if (problems.length) throw new Error(`Configuración inválida. Revisa las variables de entorno:\n${problems.join('\n')}`);
  return accounts;
}

export interface AppConfig {
  nodeEnv: Env['NODE_ENV'];
  port: number;
  host: string;
  logLevel: Env['LOG_LEVEL'];
  databasePath: string;
  webhook: { appSecret: string; verifyToken: string };
  meta: {
    appId: string | null;
    /** Token y cuenta principal (la primera de IG_USER_ID). */
    accessToken: string;
    igUserId: string;
    /** Todas las cuentas gestionadas, la principal primero. */
    accounts: AccountConfig[];
    apiVersion: string;
    graphUrl: string;
    login: 'unified' | 'instagram';
  };
  claude: { apiKey: string; model: string; workspaceId: string | null };
  replies: {
    delayMinSec: number;
    delayMaxSec: number;
    maxPerHour: number;
    reviewMode: boolean;
    maxAgeHours: number;
    likeComments: boolean;
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
  const accounts = parseAccounts(e.IG_USER_ID, e.IG_ACCESS_TOKEN, env);
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    databasePath: e.DATABASE_PATH,
    webhook: { appSecret: e.IG_APP_SECRET, verifyToken: e.WEBHOOK_VERIFY_TOKEN },
    meta: {
      appId: e.IG_APP_ID || null,
      accessToken: accounts[0]!.accessToken,
      igUserId: accounts[0]!.id,
      accounts,
      apiVersion: e.META_API_VERSION,
      graphUrl: (
        e.META_GRAPH_URL ?? (e.META_LOGIN === 'instagram' ? 'https://graph.instagram.com' : 'https://graph.facebook.com')
      ).replace(/\/+$/, ''),
      login: e.META_LOGIN,
    },
    claude: { apiKey: e.ANTHROPIC_API_KEY, model: e.CLAUDE_MODEL, workspaceId: e.ANTHROPIC_WORKSPACE_ID || null },
    replies: {
      delayMinSec: e.REPLY_DELAY_MIN,
      delayMaxSec: e.REPLY_DELAY_MAX,
      maxPerHour: e.MAX_REPLIES_PER_HOUR,
      reviewMode: e.REVIEW_MODE,
      maxAgeHours: e.MAX_REPLY_AGE_HOURS,
      likeComments: e.LIKE_REPLIED_COMMENTS,
    },
    reportToken: e.REPORT_TOKEN,
    poll: { intervalSec: e.POLL_INTERVAL_SECONDS, mediaCount: e.POLL_MEDIA_COUNT },
  };
}
