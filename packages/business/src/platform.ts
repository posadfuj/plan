/**
 * Panel maestro (superadmin): alta de un negocio con su sucursal, programa desde una plantilla e
 * invitación al dueño; estados draft → live → suspended; cambio de plan.
 * El superadmin nunca ve datos de clientes (modo soporte auditado: fase 2).
 */
import { findTemplate, parseRule, PROGRAM_TEMPLATES } from '@aiment/core';
import { schema, withSystemTx, type Db, type Tx } from '@aiment/db';
import { EMAIL_RE, isUniqueViolation, newShortCode } from '@aiment/enrollment';
import type { Mailer } from '@aiment/mail';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { BusinessError, notFound } from './errors';

const {
  organizations,
  plans,
  branches,
  users,
  organizationUsers,
  loyaltyPrograms,
  programRuleVersions,
  rewards,
  shortLinks,
  auditLogs,
} = schema;

/**
 * Administración de cuentas del proveedor de login (Supabase Auth). Un único módulo lo implementa;
 * cambiar de proveedor no toca este archivo.
 */
export interface AuthAdmin {
  /**
   * Crea (o reutiliza) la cuenta del correo y devuelve un código de acceso de un solo uso para el
   * enlace del correo de invitación. `type` indica cómo se canjea (invite = cuenta nueva).
   */
  createAccessLink(
    email: string,
    fullName: string,
  ): Promise<{ userId: string; tokenHash: string; type: 'invite' | 'magiclink' }>;
}

export interface PlatformDeps {
  db: Db;
  mailer: Mailer;
  publicBaseUrl: string;
  authAdmin: AuthAdmin | null;
}

const orgRef = sql.raw('"organizations"."id"');

export async function listOrganizations(db: Db) {
  return withSystemTx(db, (tx) =>
    tx
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        category: organizations.category,
        status: organizations.status,
        plan: organizations.planCode,
        planName: plans.name,
        limits: plans.limits,
        createdAt: organizations.createdAt,
        branches: sql<number>`(select count(*)::int from app.branches b where b.organization_id = ${orgRef} and b.status = 'active')`,
        staff: sql<number>`(select count(*)::int from app.organization_users u where u.organization_id = ${orgRef} and u.role = 'staff' and u.status = 'active')`,
        customers: sql<number>`(select count(*)::int from app.customers c where c.organization_id = ${orgRef})`,
        movements30d: sql<number>`(select count(*)::int from app.ledger_entries l where l.organization_id = ${orgRef} and l.created_at > now() - interval '30 days')`,
        walletPasses: sql<number>`(select count(*)::int from app.wallet_passes w where w.organization_id = ${orgRef} and w.status = 'active')`,
        owner: sql<
          string | null
        >`(select us.email from app.organization_users ou join app.users us on us.id = ou.user_id where ou.organization_id = ${orgRef} and ou.role = 'owner' order by ou.created_at limit 1)`,
      })
      .from(organizations)
      .innerJoin(plans, eq(plans.code, organizations.planCode))
      .orderBy(organizations.name),
  );
}

export async function listPlans(db: Db) {
  const rows = await withSystemTx(db, (tx) =>
    tx
      .select({ code: plans.code, name: plans.name, limits: plans.limits })
      .from(plans)
      .where(eq(plans.active, true))
      .orderBy(asc(plans.code)),
  );
  return {
    plans: rows,
    templates: PROGRAM_TEMPLATES.map((t) => ({ key: t.key, label: t.label, mode: t.mode })),
  };
}

export async function platformAudit(db: Db) {
  return withSystemTx(db, (tx) =>
    tx
      .select({
        id: auditLogs.id,
        organizationId: auditLogs.organizationId,
        organization: organizations.name,
        action: auditLogs.action,
        after: auditLogs.after,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .leftJoin(organizations, eq(organizations.id, auditLogs.organizationId))
      .where(eq(auditLogs.actorType, 'superadmin'))
      .orderBy(desc(auditLogs.createdAt))
      .limit(100),
  );
}

export const createBusinessInput = z
  .object({
    name: z
      .string()
      .trim()
      .transform((s) => s.replace(/\s+/g, ' '))
      .pipe(z.string().min(2, 'Escribe el nombre del negocio').max(60)),
    template: z.string().refine((k) => !!findTemplate(k), 'Elige el rubro'),
    planCode: z.string().min(1).max(20),
    ownerEmail: z.string().trim().toLowerCase().regex(EMAIL_RE, 'Correo del dueño inválido').max(120),
    ownerName: z
      .string()
      .trim()
      .transform((s) => s.replace(/\s+/g, ' '))
      .pipe(z.string().min(2, 'Escribe el nombre del dueño').max(60)),
  })
  .strict();

function slugify(name: string) {
  const base = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return base.length >= 2 ? base : `negocio-${base}`.replace(/-$/, '');
}

async function uniqueSlug(tx: Tx, name: string) {
  const base = slugify(name);
  for (let i = 1; i < 100; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    const [taken] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, slug));
    if (!taken) return slug;
  }
  throw new BusinessError(409, 'slug_taken', 'Ya hay demasiados negocios con ese nombre');
}

async function insertLink(tx: Tx, orgId: string, branchId: string) {
  for (let i = 0; i < 5; i++) {
    const slug = newShortCode(6);
    try {
      await tx.execute(sql`savepoint new_link`);
      await tx.insert(shortLinks).values({ slug, organizationId: orgId, branchId, target: `/join/${slug}` });
      await tx.execute(sql`release savepoint new_link`);
      return slug;
    } catch (err) {
      await tx.execute(sql`rollback to savepoint new_link`);
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new Error('No se pudo generar un código de enlace único');
}

function invitationUrl(publicBaseUrl: string, link: { tokenHash: string; type: string }) {
  const q = new URLSearchParams({ t: link.tokenHash, k: link.type });
  return `${publicBaseUrl.replace(/\/$/, '')}/panel/acceso?${q}`;
}

async function sendInvitation(
  deps: PlatformDeps,
  to: { email: string; name: string },
  orgName: string,
  link: { tokenHash: string; type: string },
) {
  await deps.mailer.send({
    to: to.email,
    subject: `Tu panel de ${orgName} en Aiment Wallet`,
    text: [
      `Hola, ${to.name.split(' ')[0]}:`,
      '',
      `Ya está creado el programa de fidelización de ${orgName}. Entra a tu panel con este enlace para`,
      'crear tu contraseña y configurar tu marca, tu programa, tu equipo y tus cajas:',
      '',
      invitationUrl(deps.publicBaseUrl, link),
      '',
      'El enlace es personal, sirve una sola vez y vence en 24 horas. Si vence, pide uno nuevo a Aiment.',
      '',
      '— Aiment Wallet',
    ].join('\n'),
  });
}

/**
 * Crea el negocio en estado borrador (draft): el dueño ya puede entrar y configurar, pero su QR todavía
 * no registra clientes ni se pueden autorizar cajas hasta que Aiment lo publica (live).
 */
export async function createBusiness(deps: PlatformDeps, superadminId: string, raw: unknown) {
  const input = createBusinessInput.parse(raw);
  if (!deps.authAdmin)
    throw new BusinessError(
      503,
      'invitations_unavailable',
      'Falta configurar SUPABASE_SECRET_KEY para invitar dueños',
    );
  const t = findTemplate(input.template)!;
  const rule = parseRule(t.mode, t.rule);

  const [plan] = await withSystemTx(deps.db, (tx) =>
    tx
      .select({ code: plans.code })
      .from(plans)
      .where(and(eq(plans.code, input.planCode), eq(plans.active, true))),
  );
  if (!plan) throw new BusinessError(422, 'invalid_plan', 'Elige un plan');

  // Primero la cuenta de login (servicio externo); si falla, no se crea nada en la base.
  const link = await deps.authAdmin.createAccessLink(input.ownerEmail, input.ownerName);

  const org = await withSystemTx(deps.db, async (tx) => {
    const [existingUser] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, input.ownerEmail));
    if (existingUser && existingUser.id !== link.userId)
      throw new BusinessError(409, 'email_conflict', 'Ese correo pertenece a otra cuenta');
    if (!existingUser)
      await tx.insert(users).values({ id: link.userId, email: input.ownerEmail, fullName: input.ownerName });

    const [o] = await tx
      .insert(organizations)
      .values({
        slug: await uniqueSlug(tx, input.name),
        name: input.name,
        category: t.key,
        status: 'draft',
        planCode: plan.code,
        branding: { primaryColor: t.primaryColor, poweredBy: true },
      })
      .returning({ id: organizations.id, name: organizations.name, slug: organizations.slug });
    const orgId = o!.id;
    const [b] = await tx
      .insert(branches)
      .values({ organizationId: orgId, name: 'Sede principal' })
      .returning({ id: branches.id });
    const [owner] = await tx
      .insert(organizationUsers)
      .values({ organizationId: orgId, userId: link.userId, displayName: input.ownerName, role: 'owner' })
      .returning({ id: organizationUsers.id });
    const [p] = await tx
      .insert(loyaltyPrograms)
      .values({
        organizationId: orgId,
        name: `Club ${input.name}`,
        mode: t.mode,
        unitLabel: t.unitLabel,
        status: 'active',
      })
      .returning({ id: loyaltyPrograms.id });
    const [v] = await tx
      .insert(programRuleVersions)
      .values({
        organizationId: orgId,
        programId: p!.id,
        version: 1,
        earnRule: rule.earnRule,
        goal: rule.goal,
        welcomeBonus: rule.welcomeBonus,
        limits: rule.limits,
        expirationMonths: rule.expirationMonths,
        createdBy: owner!.id,
      })
      .returning({ id: programRuleVersions.id });
    await tx.update(loyaltyPrograms).set({ currentVersionId: v!.id }).where(eq(loyaltyPrograms.id, p!.id));
    for (const [i, r] of t.rewards.entries())
      await tx.insert(rewards).values({
        organizationId: orgId,
        programId: p!.id,
        kind: r.kind,
        name: r.name,
        cost: r.kind === 'catalog' ? r.cost! : null,
        validityDays: r.validityDays ?? null,
        sortOrder: i,
      });
    const slug = await insertLink(tx, orgId, b!.id);
    await tx.insert(auditLogs).values({
      organizationId: orgId,
      actorType: 'superadmin',
      actorId: superadminId,
      action: 'org.created',
      entityType: 'organization',
      entityId: orgId,
      after: {
        name: input.name,
        template: t.key,
        plan: plan.code,
        ownerEmail: input.ownerEmail,
        linkSlug: slug,
      },
    });
    return o!;
  }).catch((err) => {
    if (isUniqueViolation(err, 'organization_users_org_user_uniq'))
      throw new BusinessError(409, 'owner_conflict', 'Ese dueño ya está en este negocio');
    throw err;
  });

  await sendInvitation(deps, { email: input.ownerEmail, name: input.ownerName }, org.name, link);
  return { organization: { ...org, status: 'draft' as const }, invitation: { sentTo: input.ownerEmail } };
}

/** Reenvía el acceso al dueño (el enlace anterior vence o ya se usó). */
export async function resendOwnerInvitation(deps: PlatformDeps, superadminId: string, orgId: string) {
  if (!deps.authAdmin)
    throw new BusinessError(
      503,
      'invitations_unavailable',
      'Falta configurar SUPABASE_SECRET_KEY para invitar dueños',
    );
  const [owner] = await withSystemTx(deps.db, (tx) =>
    tx
      .select({ email: users.email, name: organizationUsers.displayName, orgName: organizations.name })
      .from(organizationUsers)
      .innerJoin(users, eq(users.id, organizationUsers.userId))
      .innerJoin(organizations, eq(organizations.id, organizationUsers.organizationId))
      .where(and(eq(organizationUsers.organizationId, orgId), eq(organizationUsers.role, 'owner')))
      .orderBy(asc(organizationUsers.createdAt))
      .limit(1),
  );
  if (!owner) throw notFound();
  const link = await deps.authAdmin.createAccessLink(owner.email, owner.name);
  await sendInvitation(deps, owner, owner.orgName, link);
  await withSystemTx(deps.db, (tx) =>
    tx.insert(auditLogs).values({
      organizationId: orgId,
      actorType: 'superadmin',
      actorId: superadminId,
      action: 'org.owner_invited',
      entityType: 'organization',
      entityId: orgId,
      after: { email: owner.email },
    }),
  );
  return { sentTo: owner.email };
}

/** Publica un negocio en borrador: su QR/NFC empieza a registrar clientes y se pueden autorizar cajas. */
export async function activateBusiness(db: Db, superadminId: string, orgId: string) {
  return withSystemTx(db, async (tx) => {
    const [org] = await tx
      .select({ status: organizations.status })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .for('update');
    if (!org) throw notFound();
    if (org.status !== 'draft')
      throw new BusinessError(409, 'not_draft', 'Solo se publica un negocio en preparación (borrador)');
    const [ready] = await tx
      .select({ ok: sql<boolean>`true` })
      .from(loyaltyPrograms)
      .where(
        and(
          eq(loyaltyPrograms.organizationId, orgId),
          eq(loyaltyPrograms.status, 'active'),
          sql`${loyaltyPrograms.currentVersionId} is not null`,
        ),
      );
    if (!ready) throw new BusinessError(409, 'not_ready', 'El negocio no tiene un programa activo');
    await tx
      .update(organizations)
      .set({ status: 'live', updatedAt: new Date() })
      .where(eq(organizations.id, orgId));
    await tx.insert(auditLogs).values({
      organizationId: orgId,
      actorType: 'superadmin',
      actorId: superadminId,
      action: 'org.published',
      entityType: 'organization',
      entityId: orgId,
      before: { status: 'draft' },
      after: { status: 'live' },
    });
    return { id: orgId, status: 'live' as const };
  });
}

export async function changePlan(db: Db, superadminId: string, orgId: string, planCode: unknown) {
  return withSystemTx(db, async (tx) => {
    const [plan] = await tx
      .select({ code: plans.code, name: plans.name, limits: plans.limits })
      .from(plans)
      .where(and(eq(plans.code, String(planCode ?? '')), eq(plans.active, true)));
    if (!plan) throw new BusinessError(422, 'invalid_plan', 'Elige un plan');
    const [org] = await tx
      .select({ plan: organizations.planCode })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .for('update');
    if (!org) throw notFound();
    if (org.plan === plan.code)
      throw new BusinessError(409, 'no_change', `El negocio ya está en el plan ${plan.name}`);
    await tx
      .update(organizations)
      .set({ planCode: plan.code, updatedAt: new Date() })
      .where(eq(organizations.id, orgId));
    await tx.insert(auditLogs).values({
      organizationId: orgId,
      actorType: 'superadmin',
      actorId: superadminId,
      action: 'org.plan_changed',
      entityType: 'organization',
      entityId: orgId,
      before: { plan: org.plan },
      after: { plan: plan.code },
    });
    // Bajar de plan no desactiva nada: solo impide agregar más sucursales o trabajadores.
    return { id: orgId, plan: plan.code, limits: plan.limits };
  });
}
