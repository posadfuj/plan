/** Panel del dueño: enlaces impresos (QR/NFC) y recuperación de tarjeta en el local. */
import { can } from '@aiment/core';
import { issueInStoreRecovery, linkQr, listLinks } from '@aiment/enrollment';
import { Hono } from 'hono';
import { isUuid, requireOrgMember, requirePermission, requireUser } from '../auth/middleware';
import type { AppEnv } from '../context';
import { HttpError, notFound } from '../errors';

export const linkRoutes = new Hono<AppEnv>()
  .use(requireUser, requireOrgMember)

  .get('/links', requirePermission('links.manage'), async (c) =>
    c.json({ links: await listLinks(c.var.deps.db, c.var.orgId, c.var.deps.publicBaseUrl) }),
  )

  .get('/links/:linkId/qr', requirePermission('links.manage'), async (c) => {
    const linkId = c.req.param('linkId');
    if (!isUuid(linkId)) throw notFound();
    const format = c.req.query('format') === 'png' ? 'png' : 'svg';
    const qr = await linkQr(c.var.deps.db, c.var.orgId, linkId, c.var.deps.publicBaseUrl, format);
    c.header('Content-Type', qr.contentType);
    c.header('Content-Disposition', `inline; filename="qr-${linkId.slice(0, 8)}.${format}"`);
    return c.body(typeof qr.body === 'string' ? qr.body : new Uint8Array(qr.body));
  })

  .post('/memberships/:membershipId/recovery', requirePermission('membership.recovery'), async (c) => {
    const membershipId = c.req.param('membershipId');
    if (!isUuid(membershipId)) throw notFound();
    const actor = c.var.actor;
    if (actor.kind !== 'member' || !can(actor, 'membership.recovery', actor.orgId))
      throw new HttpError(403, 'forbidden', 'Acción no permitida');
    const out = await issueInStoreRecovery(
      { db: c.var.deps.db, mailer: c.var.deps.mailer, publicBaseUrl: c.var.deps.publicBaseUrl },
      c.var.orgId,
      membershipId,
      { orgUserId: actor.orgUserId, actorType: actor.role === 'staff' ? 'staff' : 'owner' },
    );
    c.header('Cache-Control', 'no-store');
    return c.json(out, 201);
  });
