/**
 * Empaqueta la API, el worker y los scripts de base de datos para producción: un archivo .js por
 * proceso en dist/server/ (sin tsx ni TypeScript en el servidor). Lo usa el Dockerfile.
 *
 * Queda fuera del paquete solo lo que trae binarios nativos (@node-rs/argon2): la imagen lo
 * instala aparte para Linux.
 */
import { build } from 'esbuild';

export const NATIVE_EXTERNALS = ['@node-rs/argon2'];

await build({
  entryPoints: {
    api: 'apps/api/src/server.ts',
    worker: 'apps/worker/src/main.ts',
    migrate: 'packages/db/src/scripts/migrate.ts',
    roles: 'packages/db/src/scripts/roles.ts',
  },
  outdir: 'dist/server',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  splitting: true, // código compartido entre los procesos en un chunk común
  sourcemap: true, // trazas de error legibles en Sentry y en los logs
  external: NATIVE_EXTERNALS,
  // Algunas dependencias son CommonJS y usan require(): en un paquete ESM hay que dárselo.
  banner: {
    js: "import { createRequire as __awCreateRequire } from 'node:module'; const require = __awCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});
