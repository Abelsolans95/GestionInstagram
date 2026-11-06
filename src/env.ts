import { existsSync } from 'node:fs';

/**
 * Carga `.env` si existe (desarrollo local). En Railway no hay `.env`: las variables
 * vienen del panel del servicio. Se importa antes que cualquier otra cosa.
 */
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}
