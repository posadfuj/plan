/**
 * Flujo público del cliente: enlace del local (/go) → landing (/join) → registro → tarjeta web (/m)
 * y página del QR de caja (/s). Nada de esto requiere sesión: se accede por códigos o tokens.
 *
 * Tokens de una membresía (nunca se mezclan):
 *  - web card token    → URL privada de la tarjeta (/m/...). Da acceso a nombre, saldo e historial.
 *                        En la base solo se guarda su hash (web_card_token_hash); se rota al recuperar.
 *  - member_scan_token → contenido del QR que escanea la caja (/s/...). Por sí solo no muestra datos.
 */
import { createHash } from 'node:crypto';
import { normalizePhone, publicBranding } from '@aiment/core';
import { schema, withSystemTx, withTenantTx, type Db, type Tx } from '@aiment/db';
import type { Mailer } from '@aiment/mail';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { EnrollmentError, notFound } from './errors';
import { requestEmailRecoveryForMembership } from './recovery';
import { hashToken, isToken, newShortCode, newToken } from './tokens';

const {
  shortLinks,
  organizations,
  branches,
  loyaltyPrograms,
  programRuleVersions,
  rewards,
  consentVersions,
  customers,
  customerConsents,
  memberships,
  channelVisits,
  earnedRewards,
  ledgerEntries,
  eventOutbox,
} = schema;

export interface PublicDeps {
  db: Db;
  mailer: Mailer;
  /** Base configurada (nunca la cabecera Host) para enlaces que salen por correo. */
  publicBaseUrl: string;
  log?: (msg: string) => void;
}

const SLUG_RE = /^[23456789A-Z]{4,8}$/;

// ---------------------------------------------------------------------------
// /go/:slug → registrar visita y redirigir
// ---------------------------------------------------------------------------
export type Channel = 'qr' | 'nfc' | 'direct' | 'unknown';
export function parseChannel(c: string | undefined): Channel {
  return c === 'q' || c === 'qr' ? 'qr' : c === 'n' || c === 'nfc' ? 'nfc' : c ? 'unknown' : 'direct';
}

/** Hash diario del visitante: sirve para contar visitas únicas sin guardar la IP. */
export function visitorHash(ip: string, userAgent: string, salt: string, day = new Date()): string {
  return createHash('sha256')
    .update(`${salt}|${day.toISOString().slice(0, 10)}|${ip}|${userAgent}`)
    .digest('hex')
    .slice(0, 32);
}

export async function resolveShortLink(
  db: Db,
  slug: string,
  visit: { channel: Channel; visitorHash: string | null },
): Promise<{ target: string; visitId: number } | null> {
  const code = slug.toUpperCase();
  if (!SLUG_RE.test(code)) return null;
  return withSystemTx(db, async (tx) => {
    const [link] = await tx
      .select({ id: shortLinks.id, orgId: shortLinks.organizationId, target: shortLinks.target })
      .from(shortLinks)
      .innerJoin(organizations, eq(organizations.id, shortLinks.organizationId))
      .where(
        and(eq(shortLinks.slug, code), eq(shortLinks.status, 'active'), eq(organizations.status, 'live')),
      );
    if (!link) return null;
    const [v] = await tx
      .insert(channelVisits)
      .values({
        organizationId: link.orgId,
        shortLinkId: link.id,
        channel: visit.channel,
        visitorHash: visit.visitorHash,
      })
      .returning({ id: channelVisits.id });
    return { target: link.target, visitId: v!.id };
  });
}

// ---------------------------------------------------------------------------
// /join/:code → datos públicos del negocio para la landing
// ---------------------------------------------------------------------------
async function latestConsents(tx: Tx, orgId: string) {
  const rows = await tx
    .select({
      id: consentVersions.id,
      kind: consentVersions.kind,
      version: consentVersions.version,
      body: consentVersions.bodyMd,
      orgId: consentVersions.organizationId,
    })
    .from(consentVersions)
    .where(or(isNull(consentVersions.organizationId), eq(consentVersions.organizationId, orgId)))
    .orderBy(desc(consentVersions.version));
  const pick = (kind: 'terms' | 'privacy' | 'marketing') =>
    rows.find((r) => r.kind === kind && r.orgId === orgId) ??
    rows.find((r) => r.kind === kind && r.orgId === null) ??
    null;
  return { terms: pick('terms'), privacy: pick('privacy'), marketing: pick('marketing') };
}

interface LinkContext {
  linkId: string;
  orgId: string;
  branchId: string | null;
  orgName: string;
  branding: Record<string, unknown>;
  branchName: string | null;
  program: { id: string; name: string; mode: 'stamps' | 'points'; unitLabel: string; goal: number | null };
  consents: Awaited<ReturnType<typeof latestConsents>>;
}

async function loadLinkContext(db: Db, code: string): Promise<LinkContext | null> {
  const slug = code.toUpperCase();
  if (!SLUG_RE.test(slug)) return null;
  return withSystemTx(db, async (tx) => {
    const [row] = await tx
      .select({
        linkId: shortLinks.id,
        orgId: organizations.id,
        branchId: shortLinks.branchId,
        orgName: organizations.name,
        branding: organizations.branding,
        branchName: branches.name,
        programId: loyaltyPrograms.id,
        programName: loyaltyPrograms.name,
        mode: loyaltyPrograms.mode,
        unitLabel: loyaltyPrograms.unitLabel,
        goal: programRuleVersions.goal,
      })
      .from(shortLinks)
      .innerJoin(organizations, eq(organizations.id, shortLinks.organizationId))
      .leftJoin(branches, eq(branches.id, shortLinks.branchId))
      .innerJoin(
        loyaltyPrograms,
        and(eq(loyaltyPrograms.organizationId, organizations.id), eq(loyaltyPrograms.status, 'active')),
      )
      .innerJoin(programRuleVersions, eq(programRuleVersions.id, loyaltyPrograms.currentVersionId))
      .where(
        and(
          eq(shortLinks.slug, slug),
          eq(shortLinks.status, 'active'),
          eq(shortLinks.kind, 'registration'),
          eq(organizations.status, 'live'),
        ),
      );
    if (!row) return null;
    return {
      linkId: row.linkId,
      orgId: row.orgId,
      branchId: row.branchId,
      orgName: row.orgName,
      branding: (row.branding ?? {}) as Record<string, unknown>,
      branchName: row.branchName,
      program: {
        id: row.programId,
        name: row.programName,
        mode: row.mode,
        unitLabel: row.unitLabel,
        goal: row.goal,
      },
      consents: await latestConsents(tx, row.orgId),
    };
  });
}

export async function getJoinInfo(db: Db, code: string) {
  const ctx = await loadLinkContext(db, code);
  if (!ctx) throw notFound();
  const prizes = await withSystemTx(db, (tx) =>
    tx
      .select({ name: rewards.name, kind: rewards.kind, cost: rewards.cost })
      .from(rewards)
      .where(
        and(
          eq(rewards.programId, ctx.program.id),
          eq(rewards.active, true),
          inArray(rewards.kind, ['goal', 'catalog']),
        ),
      )
      .orderBy(asc(rewards.sortOrder), asc(rewards.cost)),
  );
  return {
    organization: { id: ctx.orgId, name: ctx.orgName, branding: publicBranding(ctx.branding) },
    branch: ctx.branchName,
    program: { ...ctx.program, id: undefined, rewards: prizes },
    consents: {
      terms: ctx.consents.terms && { version: ctx.consents.terms.version, body: ctx.consents.terms.body },
      privacy: ctx.consents.privacy && {
        version: ctx.consents.privacy.version,
        body: ctx.consents.privacy.body,
      },
      marketing: ctx.consents.marketing && {
        version: ctx.consents.marketing.version,
        body: ctx.consents.marketing.body,
      },
    },
    fields: { email: 'optional', birthDate: 'optional' },
  };
}

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------
const nameRe = /^[\p{L}][\p{L}\p{M}' .-]{1,79}$/u;
/**
 * Correo con letras de cualquier idioma (tildes, ñ) antes y después de la @.
 * La validación de zod solo aceptaba ASCII y rechazaba, p. ej., "peña@…".
 */
export const EMAIL_RE =
  /^[\p{L}\p{M}\p{N}!#$%&'*+/=?^_`{|}~-]+(\.[\p{L}\p{M}\p{N}!#$%&'*+/=?^_`{|}~-]+)*@([\p{L}\p{M}\p{N}]([\p{L}\p{M}\p{N}-]{0,61}[\p{L}\p{M}\p{N}])?\.)+[\p{L}]{2,24}$/u;
export const registerSchema = z.object({
  code: z.string().min(4).max(8),
  fullName: z
    .string()
    .trim()
    .transform((s) => s.replace(/\s+/g, ' '))
    .refine((s) => nameRe.test(s), 'Escribe tu nombre (solo letras)'),
  phone: z.string().min(6).max(25),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .regex(EMAIL_RE, 'Correo inválido')
    .max(120)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  /** dd/mm/aaaa (lo que escribe el cliente) o aaaa-mm-dd. */
  birthDate: z
    .string()
    .trim()
    .regex(/^(\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2})$/, 'Escribe tu cumpleaños como dd/mm/aaaa')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  acceptTerms: z.literal(true, { message: 'Debes aceptar los términos' }),
  acceptPrivacy: z.literal(true, { message: 'Debes aceptar la política de privacidad' }),
  acceptMarketing: z.boolean().default(false),
  channel: z.enum(['qr', 'nfc', 'direct', 'unknown']).default('direct'),
  visitId: z.number().int().positive().optional(),
});
export type RegisterInput = z.input<typeof registerSchema>;

export type RegisterResult =
  { status: 'created'; webCardToken: string } | { status: 'already_registered'; message: string };

const ALREADY =
  'Este celular ya tiene una tarjeta en este negocio. Si registraste un correo, te enviamos un enlace para abrirla; si no, pídela en caja.';

/** Convierte dd/mm/aaaa a aaaa-mm-dd (formato de la base). Deja pasar aaaa-mm-dd. */
export function toIsoDate(s: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : s;
}

function validBirthDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = toIsoDate(raw);
  const invalid = () =>
    new EnrollmentError(422, 'invalid_birth_date', 'Fecha de cumpleaños inválida (usa dd/mm/aaaa)');
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw invalid();
  const years = (Date.now() - d.getTime()) / (365.25 * 86_400_000);
  if (years < 10 || years > 110) throw invalid();
  return s;
}

function isUniqueViolation(err: unknown, constraint?: string): boolean {
  let e: unknown = err;
  for (let i = 0; i < 3 && e; i++) {
    const x = e as { code?: string; constraint_name?: string };
    if (x.code === '23505' && (!constraint || x.constraint_name === constraint)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

export async function registerCustomer(
  deps: PublicDeps,
  raw: unknown,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<RegisterResult> {
  const parsed = registerSchema.safeParse(raw);
  if (!parsed.success)
    throw new EnrollmentError(
      422,
      'invalid_registration',
      parsed.error.issues[0]?.message ?? 'Datos inválidos',
      {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    );
  const input = parsed.data;
  const phone = normalizePhone(input.phone);
  if (!phone)
    throw new EnrollmentError(422, 'invalid_phone', 'Escribe un celular válido (9 dígitos, empieza con 9)');
  const birthDate = validBirthDate(input.birthDate);

  const ctx = await loadLinkContext(deps.db, input.code);
  if (!ctx) throw notFound();
  if (!ctx.consents.terms || !ctx.consents.privacy)
    throw new EnrollmentError(409, 'consents_missing', 'El negocio aún no publicó sus términos');

  const onDuplicate = async (): Promise<RegisterResult> => {
    const [existing] = await withTenantTx(deps.db, ctx.orgId, (tx) =>
      tx
        .select({ membershipId: memberships.id })
        .from(customers)
        .innerJoin(memberships, eq(memberships.customerId, customers.id))
        .where(
          and(
            eq(customers.organizationId, ctx.orgId),
            eq(customers.phoneE164, phone),
            eq(customers.status, 'active'),
          ),
        ),
    );
    // Si el cliente registró un correo, le enviamos el enlace a ESE correo (no al que se escribió ahora).
    if (existing)
      await requestEmailRecoveryForMembership(deps, ctx.orgId, existing.membershipId).catch(() => undefined);
    return { status: 'already_registered', message: ALREADY };
  };

  try {
    return await withTenantTx(deps.db, ctx.orgId, async (tx) => {
      const [dup] = await tx
        .select({ id: customers.id })
        .from(customers)
        .where(
          and(
            eq(customers.organizationId, ctx.orgId),
            eq(customers.phoneE164, phone),
            eq(customers.status, 'active'),
          ),
        );
      if (dup) return null;

      const [customer] = await tx
        .insert(customers)
        .values({
          organizationId: ctx.orgId,
          fullName: input.fullName,
          phoneE164: phone,
          email: input.email ?? null,
          birthDate,
        })
        .returning({ id: customers.id });

      const consentRows = [
        { v: ctx.consents.terms!, granted: true },
        { v: ctx.consents.privacy!, granted: true },
        ...(ctx.consents.marketing ? [{ v: ctx.consents.marketing, granted: input.acceptMarketing }] : []),
      ];
      await tx.insert(customerConsents).values(
        consentRows.map((c) => ({
          organizationId: ctx.orgId,
          customerId: customer!.id,
          consentVersionId: c.v.id,
          granted: c.granted,
          channel: input.channel,
          ip: meta.ip && /^[0-9a-fA-F:.]+$/.test(meta.ip) ? meta.ip : null,
          userAgent: meta.userAgent?.slice(0, 300) ?? null,
        })),
      );

      let shortCode = newShortCode();
      for (let i = 0; i < 5; i++) {
        const [taken] = await tx
          .select({ id: memberships.id })
          .from(memberships)
          .where(and(eq(memberships.organizationId, ctx.orgId), eq(memberships.shortCode, shortCode)));
        if (!taken) break;
        shortCode = newShortCode();
      }
      const webCardToken = newToken();
      const [membership] = await tx
        .insert(memberships)
        .values({
          organizationId: ctx.orgId,
          programId: ctx.program.id,
          customerId: customer!.id,
          memberScanToken: newToken(),
          webCardTokenHash: hashToken(webCardToken),
          shortCode,
        })
        .returning({ id: memberships.id });

      if (input.visitId)
        await tx
          .update(channelVisits)
          .set({ convertedMembershipId: membership!.id })
          .where(
            and(
              eq(channelVisits.id, input.visitId),
              eq(channelVisits.organizationId, ctx.orgId),
              eq(channelVisits.shortLinkId, ctx.linkId),
              isNull(channelVisits.convertedMembershipId),
            ),
          );
      await tx.insert(eventOutbox).values({
        organizationId: ctx.orgId,
        type: 'customer.registered',
        aggregateId: membership!.id,
        payload: { channel: input.channel, branchId: ctx.branchId },
      });
      // Registrarse NO da puntos ni bono: el primer beneficio llega con la primera visita validada en caja.
      return { status: 'created' as const, webCardToken };
    }).then((r) => r ?? onDuplicate());
  } catch (err) {
    if (isUniqueViolation(err, 'customers_org_phone')) return onDuplicate(); // registro simultáneo del mismo celular
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Tarjeta web (/m/:webCardToken)
// ---------------------------------------------------------------------------
export async function getCard(db: Db, webCardToken: string) {
  if (!isToken(webCardToken)) throw notFound();
  return withSystemTx(db, async (tx) => {
    const [row] = await tx
      .select({
        membershipId: memberships.id,
        orgId: organizations.id,
        orgName: organizations.name,
        branding: organizations.branding,
        programId: loyaltyPrograms.id,
        programName: loyaltyPrograms.name,
        mode: loyaltyPrograms.mode,
        unitLabel: loyaltyPrograms.unitLabel,
        goal: programRuleVersions.goal,
        balance: memberships.balance,
        shortCode: memberships.shortCode,
        scanToken: memberships.memberScanToken,
        fullName: customers.fullName,
        memberSince: memberships.createdAt,
        status: memberships.status,
      })
      .from(memberships)
      .innerJoin(customers, eq(customers.id, memberships.customerId))
      .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
      .innerJoin(loyaltyPrograms, eq(loyaltyPrograms.id, memberships.programId))
      .innerJoin(programRuleVersions, eq(programRuleVersions.id, loyaltyPrograms.currentVersionId))
      .where(
        and(
          eq(memberships.webCardTokenHash, hashToken(webCardToken)),
          // Bloqueada por el negocio: la tarjeta abre, pero sin QR (no se puede operar en caja).
          inArray(memberships.status, ['active', 'blocked']),
          eq(customers.status, 'active'),
          eq(organizations.status, 'live'),
        ),
      );
    if (!row) throw notFound();

    const rewardList = await tx
      .select({ id: rewards.id, name: rewards.name, kind: rewards.kind, cost: rewards.cost })
      .from(rewards)
      .where(and(eq(rewards.programId, row.programId), eq(rewards.active, true)))
      .orderBy(asc(rewards.cost), asc(rewards.sortOrder));
    const available = await tx
      .select({ name: rewards.name, expiresAt: earnedRewards.expiresAt })
      .from(earnedRewards)
      .innerJoin(rewards, eq(rewards.id, earnedRewards.rewardId))
      .where(and(eq(earnedRewards.membershipId, row.membershipId), eq(earnedRewards.status, 'available')))
      .orderBy(asc(earnedRewards.createdAt));
    const history = await tx
      .select({
        kind: ledgerEntries.kind,
        delta: ledgerEntries.delta,
        balanceAfter: ledgerEntries.balanceAfter,
        at: ledgerEntries.createdAt,
      })
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.membershipId, row.membershipId), sql`${ledgerEntries.kind} <> 'convert'`))
      .orderBy(desc(ledgerEntries.createdAt))
      .limit(10);

    let progress: { current: number; target: number } | null = null;
    let nextReward: { name: string; remaining: number } | null = null;
    let redeemable: string[] = available.map((a) => a.name);
    if (row.mode === 'stamps' && row.goal) {
      progress = { current: row.balance, target: row.goal };
      const goalReward = rewardList.find((r) => r.kind === 'goal');
      if (goalReward) nextReward = { name: goalReward.name, remaining: row.goal - row.balance };
    } else {
      const catalog = rewardList.filter((r) => r.kind === 'catalog' && r.cost !== null);
      const next = catalog.find((r) => r.cost! > row.balance);
      if (next) {
        nextReward = { name: next.name, remaining: next.cost! - row.balance };
        progress = { current: row.balance, target: next.cost! };
      } else if (catalog.length) progress = { current: row.balance, target: catalog.at(-1)!.cost! };
      redeemable = [
        ...redeemable,
        ...catalog.filter((r) => r.cost! <= row.balance).map((r) => `${r.name} (${r.cost} ${row.unitLabel})`),
      ];
    }

    return {
      organization: {
        id: row.orgId,
        name: row.orgName,
        branding: publicBranding((row.branding ?? {}) as Record<string, unknown>),
      },
      program: { name: row.programName, mode: row.mode, unitLabel: row.unitLabel, goal: row.goal },
      customer: { name: row.fullName, memberSince: row.memberSince },
      balance: row.balance,
      progress,
      nextReward,
      redeemable,
      status: row.status as 'active' | 'blocked',
      /** Ruta del QR para la caja. La tarjeta arma la URL completa con su propio origen. */
      scanPath: `/s/${row.scanToken}`,
      shortCode: row.shortCode,
      history,
      wallet: { apple: { available: false }, google: { available: false } },
    };
  });
}

// ---------------------------------------------------------------------------
// Página del QR de caja (/s/:memberScanToken): sin datos personales
// ---------------------------------------------------------------------------
export async function getScanInfo(db: Db, scanToken: string) {
  if (!isToken(scanToken)) throw notFound();
  const [row] = await withSystemTx(db, (tx) =>
    tx
      .select({ orgName: organizations.name })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
      .where(
        and(
          eq(memberships.memberScanToken, scanToken),
          eq(memberships.status, 'active'),
          eq(organizations.status, 'live'),
        ),
      ),
  );
  if (!row) throw notFound();
  return { organizationName: row.orgName, message: `Presenta este código en caja de ${row.orgName}.` };
}

export { isUniqueViolation };
