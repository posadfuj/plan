/**
 * Prepara una base de datos de test aislada (aiment_test) en el mismo servidor Postgres:
 * la crea desde cero, aplica migraciones, crea el rol de la API y carga los datos de prueba.
 * No toca la base de desarrollo.
 */
import type { TestProject } from 'vitest/node';
import postgres from 'postgres';
import { loadRootEnv } from '@aiment/config';
import { ensureAppRole, runMigrations, seedDatabase } from '@aiment/db/admin';

export default async function setup(project: TestProject) {
  loadRootEnv();
  const baseAdmin = process.env.DATABASE_ADMIN_URL;
  if (!baseAdmin) throw new Error('Tests de integración: falta DATABASE_ADMIN_URL (ver .env.example)');
  const appUser = process.env.APP_DB_USER ?? 'aiment_api';
  const appPassword = process.env.APP_DB_PASSWORD ?? 'aiment-test-password';

  const adminUrl = new URL(baseAdmin);
  adminUrl.pathname = '/aiment_test';
  const apiUrl = new URL(adminUrl);
  apiUrl.username = appUser;
  apiUrl.password = appPassword;

  const root = postgres(baseAdmin, { max: 1, onnotice: () => {} });
  await root.unsafe('DROP DATABASE IF EXISTS aiment_test WITH (FORCE)');
  await root.unsafe('CREATE DATABASE aiment_test');
  await root.end();

  await runMigrations(adminUrl.toString());
  await ensureAppRole(adminUrl.toString(), appUser, appPassword);
  await seedDatabase(adminUrl.toString());

  project.provide('adminUrl', adminUrl.toString());
  project.provide('apiDbUrl', apiUrl.toString());
}
