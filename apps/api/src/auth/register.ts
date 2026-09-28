/**
 * Autenticación de la caja: dispositivo autorizado (cookie de 180 días) + turno abierto con PIN
 * (cookie de 12 horas). Ambas cookies son httpOnly y SameSite=Strict, y solo viajan a /v1/staff.
 */
import { can, type OrgAction } from '@aiment/core';
import {
  DEVICE_COOKIE_DAYS,
  SHIFT_HOURS,
  deviceNotAuthorized,
  resolveDevice,
  resolveShift,
  shiftRequired,
} from '@aiment/staff';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../context';
import { HttpError } from '../errors';

export const DEVICE_COOKIE = 'aw_device';
export const SHIFT_COOKIE = 'aw_shift';
const COOKIE_PATH = '/v1/staff';

function secure(c: Context<AppEnv>): boolean {
  return c.var.deps.config.secureCookies ?? c.var.deps.publicBaseUrl.startsWith('https://');
}

export function setDeviceCookie(c: Context<AppEnv>, secret: string) {
  setCookie(c, DEVICE_COOKIE, secret, {
    httpOnly: true,
    secure: secure(c),
    sameSite: 'Strict',
    path: COOKIE_PATH,
    maxAge: DEVICE_COOKIE_DAYS * 86_400,
  });
}

export function setShiftCookie(c: Context<AppEnv>, token: string) {
  setCookie(c, SHIFT_COOKIE, token, {
    httpOnly: true,
    secure: secure(c),
    sameSite: 'Strict',
    path: COOKIE_PATH,
    maxAge: SHIFT_HOURS * 3600,
  });
}

export function clearShiftCookie(c: Context<AppEnv>) {
  deleteCookie(c, SHIFT_COOKIE, { path: COOKIE_PATH, secure: secure(c) });
}

/** Exige un dispositivo de caja autorizado (no revocado, negocio activo). */
export const requireDevice = createMiddleware<AppEnv>(async (c, next) => {
  const device = await resolveDevice(c.var.deps.db, getCookie(c, DEVICE_COOKIE));
  if (!device) throw deviceNotAuthorized();
  c.set('device', device);
  c.set('orgId', device.orgId);
  await next();
});

/** Exige además un turno abierto en ESE dispositivo. Define el actor de caja. */
export const requireShift = createMiddleware<AppEnv>(async (c, next) => {
  const device = c.var.device;
  const shift = await resolveShift(c.var.deps.db, device, getCookie(c, SHIFT_COOKIE));
  if (!shift) {
    clearShiftCookie(c);
    throw shiftRequired();
  }
  c.set('shift', shift);
  c.set('actor', {
    kind: 'register',
    orgId: device.orgId,
    orgUserId: shift.orgUserId,
    role: shift.role,
    deviceId: device.deviceId,
    branchId: device.branchId,
    sessionId: shift.sessionId,
  });
  await next();
});

export const requireRegisterPermission = (action: OrgAction) =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (!can(c.var.actor, action, c.var.orgId))
      throw new HttpError(403, 'forbidden', 'Tu rol no permite esta acción en caja');
    await next();
  });
