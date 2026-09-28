import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * En local la PWA y la API se sirven por el MISMO origen (este servidor de Vite hace de proxy).
 * Así funciona igual con localhost o detrás de un túnel HTTPS para probar en celulares.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, '');
  const api = `http://127.0.0.1:${env.API_PORT || 8787}`;
  // xfwd: la API recibe la IP real del cliente (X-Forwarded-For) para sus límites por IP.
  const toApi = { target: api, xfwd: true };
  const proxy = {
    '/v1': toApi,
    '/go': toApi,
    '/health': toApi,
    // Login del panel (Supabase Auth) por el mismo origen: funciona desde el celular vía túnel.
    '/auth/v1': env.SUPABASE_URL || 'http://127.0.0.1:54321',
  };
  return {
    plugins: [react(), tailwindcss()],
    define: {
      'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify(env.SUPABASE_PUBLISHABLE_KEY ?? ''),
    },
    server: { port: 5173, host: true, allowedHosts: true, proxy },
    preview: { port: 4173, host: true, allowedHosts: true, proxy },
  };
});
