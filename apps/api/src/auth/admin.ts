/**
 * Invitaciones de dueños con Supabase Auth (API de administración, clave secreta del servidor).
 * Único módulo que conoce al proveedor de login para crear cuentas (ADR 0001).
 * El correo lo envía Aiment Wallet (mismo remitente y textos que el resto); aquí solo se genera
 * el código de acceso de un solo uso que el panel canjea con verifyOtp.
 */
import type { AuthAdmin } from '@aiment/business';
import { createClient } from '@supabase/supabase-js';

export function createSupabaseAuthAdmin(opts: { supabaseUrl: string; secretKey: string }): AuthAdmin {
  const sb = createClient(opts.supabaseUrl, opts.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    async createAccessLink(email, fullName) {
      const invite = await sb.auth.admin.generateLink({
        type: 'invite',
        email,
        options: { data: { full_name: fullName } },
      });
      if (!invite.error)
        return {
          userId: invite.data.user.id,
          tokenHash: invite.data.properties.hashed_token,
          type: 'invite',
        };
      // La cuenta ya existe (p. ej., dueño de otro negocio): enlace de acceso normal.
      const magic = await sb.auth.admin.generateLink({ type: 'magiclink', email });
      if (magic.error) throw new Error(`Supabase Auth: ${magic.error.message}`);
      return { userId: magic.data.user.id, tokenHash: magic.data.properties.hashed_token, type: 'magiclink' };
    },
  };
}
