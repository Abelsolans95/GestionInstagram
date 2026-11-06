import { z } from 'zod';

/**
 * Configuración desde variables de entorno.
 * Se valida una vez al arrancar: si falta algo obligatorio, el proceso no arranca.
 * Cada fase añade aquí las variables que necesita.
 */
const nonEmpty = z.string().trim().min(1);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // En Railway: volumen montado en /data y DATABASE_PATH=/data/app.db
  DATABASE_PATH: z.string().trim().min(1).default('./data/app.db'),

  // Webhook de Meta
  IG_APP_SECRET: nonEmpty,
  WEBHOOK_VERIFY_TOKEN: nonEmpty,
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  nodeEnv: Env['NODE_ENV'];
  port: number;
  host: string;
  logLevel: Env['LOG_LEVEL'];
  databasePath: string;
  webhook: {
    appSecret: string;
    verifyToken: string;
  };
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
    webhook: {
      appSecret: e.IG_APP_SECRET,
      verifyToken: e.WEBHOOK_VERIFY_TOKEN,
    },
  };
}
