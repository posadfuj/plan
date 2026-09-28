/**
 * Panel del dueño en un celular (semana 5): un negocio nuevo, de cero a su primera tarjeta y su primera
 * visita en caja, sin tocar código. Alta (panel maestro) → invitación → marca con logo desde la galería →
 * programa → sucursales → trabajador por sucursal → publicación → caja autorizada → cliente → gestión.
 *
 * Con Supabase Auth local (E2E_AUTH=1) todo pasa por la interfaz, incluida la invitación por correo
 * (Mailpit). En CI (sin Supabase Auth) el negocio se crea con el mismo servicio y la sesión se firma
 * como la de Supabase; el resto del recorrido es igual.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { SEED } from '@aiment/db/seed-data';
import {
  createBusinessInDb,
  decodeQr,
  panelLogin,
  photoPng,
  randomEmail,
  randomPhone,
  superadminApi,
  waitForEmail,
} from './helpers';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `e2e/artifacts/${test.info().project.name}-panel-${name}.png`, fullPage: true });
const nav = (page: Page, label: string) =>
  page.getByRole('navigation', { name: 'Secciones del panel' }).getByRole('link', { name: label }).click();
const PASSWORD = 'burbujas-2026';

test('de cero a la primera tarjeta sin tocar código', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);
  const project = test.info().project.name;
  const bizName = `Lavandería Burbujas ${project} ${Date.now() % 100000}`;
  const ownerEmail = randomEmail('duena');
  let admin: Page | null = null;

  // --- 1. Alta del negocio e invitación a la dueña ---------------------------------
  if (process.env.E2E_AUTH) {
    admin = await (await browser.newContext()).newPage();
    await panelLogin(admin, SEED.superadmin, '/admin');
    const form = admin.getByTestId('new-org');
    await form.getByLabel('Nombre del negocio').fill(bizName);
    await form.getByLabel('Rubro').selectOption({ label: 'Lavandería / lavado de autos' });
    await form.getByRole('combobox', { name: /^Plan/ }).selectOption('multi');
    await form.getByLabel('Nombre del dueño').fill('Marta Peña');
    await form.getByLabel('Correo del dueño').fill(ownerEmail);
    await form.getByRole('button', { name: 'Crear e invitar' }).click();
    await expect(admin.getByText('Enviamos la invitación al dueño')).toBeVisible();
    await shot(admin, '0-admin-alta');
    const mail = await waitForEmail(ownerEmail);
    const link = mail.match(/https?:\/\/\S+\/panel\/acceso\?t=[0-9a-f]+&k=\w+/)![0];
    const u = new URL(link);
    await page.goto(`${u.pathname}${u.search}`);
    await expect(page.getByText('Crea tu contraseña')).toBeVisible();
    expect(new URL(page.url()).search).toBe(''); // el código no queda en la barra de direcciones
    await page.getByPlaceholder('Contraseña nueva').fill(PASSWORD);
    await page.getByPlaceholder('Repite la contraseña').fill(PASSWORD);
    await page.getByRole('button', { name: 'Guardar y entrar' }).click();
  } else {
    const biz = await createBusinessInDb(bizName, ownerEmail);
    await panelLogin(page, biz.owner);
  }
  const start = Date.now();
  await expect(page.getByTestId('panel-org-name')).toHaveText(bizName);
  await expect(page.getByText('En preparación', { exact: true })).toBeVisible();
  await expect(page.getByTestId('checklist')).toContainText('Sube tu logo');
  await expect(page.getByTestId('online-notice')).toContainText('conexión a internet');
  await shot(page, '1-inicio');

  // --- 2. Marca: logo desde la "galería", color, frase, condiciones y contacto ---------
  await nav(page, 'Marca');
  const photo = photoPng(join(tmpdir(), `aiment-logo-${project}.png`));
  await page.getByTestId('logo-input').setInputFiles(photo);
  await expect(page.getByText('Logo actualizado.')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Logo actual' })).toBeVisible();
  const logoSrc = await page.getByRole('img', { name: 'Logo actual' }).getAttribute('src');
  const logo = await page.request.get(logoSrc!);
  expect(logo.headers()['content-type']).toMatch(/image\/(png|jpeg)/);
  expect((await logo.body()).length).toBeLessThan(700 * 1024); // la foto de 1200 px se achicó a 512 px

  await page.getByLabel('Código del color').fill('#FDE68A');
  await expect(page.getByTestId('contrast-check')).toContainText('se verán poco');
  await page
    .getByTestId('contrast-check')
    .getByRole('button', { name: /^Usar #/ })
    .click();
  await page.getByLabel('Código del color').fill('#0E7490');
  await expect(page.getByTestId('contrast-check')).toContainText('Buen contraste');
  await page.getByLabel('Frase corta').fill('Tu ropa lista en 24 horas');
  await page.getByLabel('Condiciones').fill('Un sello por servicio de lavado. Premio válido por 90 días.');
  await page.getByLabel('Teléfono o WhatsApp').fill('+51 987 654 321');
  await page.getByLabel('Instagram').fill('@burbujas.pe');
  await expect(page.getByTestId('card-preview')).toContainText('Tu ropa lista en 24 horas');
  await page.getByRole('button', { name: 'Guardar marca' }).click();
  await expect(page.getByText('Marca guardada.')).toBeVisible();
  await shot(page, '2-marca');

  // --- 3. Programa: meta, bienvenida, límites y premio -------------------------------
  await nav(page, 'Programa');
  await expect(page.getByTestId('template-picker')).toBeVisible(); // sin clientes: se puede cambiar de plantilla
  const rule = page.getByTestId('rule-form');
  await rule.getByLabel('Meta (').fill('6');
  await rule.getByLabel('Tipo de bienvenida').selectOption('units');
  await rule.getByLabel('Unidades de bienvenida').fill('1');
  await rule.getByLabel('Minutos entre dos sumas').fill('60');
  await expect(rule.getByText('Vencimiento por inactividad: desactivado')).toBeVisible();
  await rule.getByRole('button', { name: 'Guardar regla' }).click();
  await expect(page.getByText('Regla guardada.')).toBeVisible();
  const rewards = page.getByTestId('rewards');
  await rewards.getByRole('button', { name: 'Editar' }).first().click();
  await rewards.getByLabel('Nombre del premio').fill('Lavado + secado gratis');
  await rewards.getByRole('button', { name: 'Guardar premio' }).click();
  await expect(rewards).toContainText('Lavado + secado gratis');
  await expect(page.getByTestId('card-preview')).toContainText('3 de 6');
  await shot(page, '3-programa');

  // --- 4. Sucursales: dirección y una segunda sede (plan Multi) ----------------------
  await nav(page, 'Sucursales');
  const main = page.getByTestId('branch-card').first();
  await main.getByRole('button', { name: 'Editar' }).click();
  await page.getByLabel('Nombre').fill('Sede Centro');
  await page.getByLabel('Dirección').fill('Jr. de la Unión 456, Lima');
  await page.getByRole('button', { name: 'Guardar', exact: true }).click();
  await expect(page.getByText('Sucursal actualizada.')).toBeVisible();
  await page.getByRole('button', { name: '+ Agregar sucursal' }).click();
  await page.getByLabel('Nombre').fill('Sede Norte');
  await page.getByLabel('Dirección').fill('Av. Túpac Amaru 1200, Comas');
  await page.getByRole('button', { name: 'Guardar', exact: true }).click();
  await expect(page.getByText('Sucursal "Sede Norte" creada')).toBeVisible();
  const norte = page.getByTestId('branch-card').filter({ hasText: 'Sede Norte' });
  await expect(norte.getByRole('img', { name: /QR de registro/ })).toBeVisible();
  const norteQrUrl = (await norte.getByText(/^QR: /).textContent())!.replace('QR: ', '').trim();
  await expect(page.getByTestId('branch-usage')).toContainText('2 de 10 sucursales');
  await shot(page, '4-sucursales');

  // --- 5. Equipo: trabajadora solo para Sede Norte y PIN de la dueña -----------------
  await nav(page, 'Equipo');
  const staffCard = page.getByTestId('team-staff');
  await staffCard.getByLabel('Nombre', { exact: true }).fill('Rosa');
  await staffCard.getByLabel('PIN (4 a 6 números)').fill('4826');
  await staffCard.getByLabel('Solo en…').check();
  await staffCard.getByTestId('staff-branches').getByLabel('Sede Norte').check();
  await staffCard.getByRole('button', { name: 'Agregar' }).click();
  await expect(page.getByText('Rosa ya puede entrar a la caja con su PIN.')).toBeVisible();
  await expect(page.getByTestId('staff-row').filter({ hasText: 'Rosa' })).toContainText('Sede Norte');
  await expect(page.getByTestId('staff-usage')).toContainText('1 de 50 trabajadores');
  await page.getByRole('button', { name: 'Definir mi PIN' }).click();
  await page.getByLabel('Nuevo PIN').fill('3571');
  await page.getByRole('button', { name: 'Guardar PIN' }).click();
  await expect(page.getByText('PIN actualizado para Marta Peña.')).toBeVisible();
  await shot(page, '5-equipo');

  // --- 6. Aiment publica el negocio ---------------------------------------------------
  if (admin) {
    await admin.reload();
    await admin
      .getByTestId('org-row')
      .filter({ hasText: bizName })
      .getByRole('button', { name: 'Publicar' })
      .click();
    await expect(admin.getByText(`${bizName} publicado: su QR ya registra clientes.`)).toBeVisible();
  } else {
    const orgs = (await superadminApi(baseURL!, 'GET', '/v1/admin/orgs')) as {
      organizations: { id: string; name: string }[];
    };
    const id = orgs.organizations.find((o) => o.name === bizName)!.id;
    await superadminApi(baseURL!, 'POST', `/v1/admin/orgs/${id}/activate`);
  }

  // --- 7. Caja de Sede Norte autorizada con QR y turno de Rosa -----------------------
  await page.reload();
  await expect(page.getByText('Publicado', { exact: true })).toBeVisible();
  await nav(page, 'Cajas');
  await page.getByPlaceholder('Ej.: Celular del mostrador').fill('Tablet Norte');
  await page.getByLabel('Sucursal de la caja').selectOption({ label: 'Sede Norte' });
  await page.getByRole('button', { name: 'Generar QR' }).click();
  const pairingUrl = await decodeQr(page.getByTestId('pairing-qr').locator('div').first());
  const caja = await (await browser.newContext({ ...test.info().project.use })).newPage();
  await caja.goto(new URL(pairingUrl).pathname);
  await expect(caja.getByText('¿Quién atiende?')).toBeVisible();
  await caja.getByRole('button', { name: 'Rosa' }).click();
  for (const d of '4826') await caja.getByRole('button', { name: d, exact: true }).click();
  await caja.getByRole('button', { name: 'Entrar' }).click();
  await expect(caja.getByTestId('shift-name')).toHaveText('Turno: Rosa');
  // Sin internet la caja lo avisa de inmediato (no hay modo sin conexión en el MVP).
  await caja.context().setOffline(true);
  await expect(caja.getByTestId('offline-banner')).toContainText('Sin conexión a internet');
  await shot(caja, '6b-caja-sin-conexion');
  await caja.context().setOffline(false);
  await expect(caja.getByTestId('offline-banner')).toBeHidden();

  // --- 8. Primer cliente desde el QR de Sede Norte ------------------------------------
  const customer = await (await browser.newContext({ ...test.info().project.use })).newPage();
  await customer.goto(new URL(norteQrUrl).pathname + new URL(norteQrUrl).search);
  await expect(customer.getByRole('heading', { name: bizName })).toBeVisible();
  await expect(customer.getByText('Tu ropa lista en 24 horas')).toBeVisible();
  await expect(customer.getByText('Junta 6 sellos y gana: Lavado + secado gratis.')).toBeVisible();
  await customer.getByLabel('Nombre y apellido', { exact: true }).fill('Ñusta Quispe');
  await customer.getByLabel('Celular', { exact: true }).fill(randomPhone());
  await customer.getByRole('checkbox').first().check();
  await customer.getByRole('button', { name: 'Crear mi tarjeta' }).click();
  await expect(customer).toHaveURL(/\/m\/[0-9A-Za-z]{22}$/);
  const configMs = Date.now() - start;
  const header = customer.locator('header').first();
  await expect(header).toHaveCSS('background-color', 'rgb(14, 116, 144)');
  await expect(header.locator('img')).toBeVisible(); // logo
  await expect(customer.getByTestId('brand-conditions')).toContainText('Condiciones del programa');
  await expect(customer.getByTestId('brand-contact')).toContainText('@burbujas.pe');
  await shot(customer, '6-tarjeta-cliente');

  // --- 9. Primera visita en caja (búsqueda por código) --------------------------------
  const shortCode = (await customer.getByTestId('short-code').textContent())!.trim();
  await caja.getByPlaceholder('987 654 321 o ABC234').fill(shortCode);
  await caja.getByRole('button', { name: 'Buscar' }).click();
  await expect(caja.getByTestId('customer-name')).toHaveText('Ñusta Quispe');
  await caja.getByTestId('earn').click();
  await expect(caja.getByTestId('feedback')).toContainText('+');
  await customer.reload();
  await expect(customer.getByTestId('balance')).toContainText('2 sellos'); // visita + bono de bienvenida
  await shot(caja, '7-caja');

  // --- 10. La dueña ve a su cliente, lo bloquea y lo desbloquea ----------------------
  await nav(page, 'Clientes');
  await page.getByLabel('Buscar cliente').fill('Ñusta');
  await page.getByRole('button', { name: /Ñusta Quispe/ }).click();
  const detail = page.getByTestId('customer-detail');
  await expect(detail.getByTestId('detail-balance')).toContainText('2 sellos');
  await expect(detail.getByTestId('movements')).toContainText('Rosa');
  await detail.getByRole('button', { name: 'Bloquear' }).click();
  await detail.getByLabel('Motivo').fill('Prueba de bloqueo');
  await detail.getByRole('button', { name: 'Bloquear' }).last().click();
  await expect(page.getByText('Cliente bloqueado.')).toBeVisible();
  await customer.reload();
  await expect(customer.getByTestId('card-blocked')).toBeVisible();
  await caja.getByRole('button', { name: 'Cerrar', exact: true }).click();
  await caja.getByPlaceholder('987 654 321 o ABC234').fill(shortCode);
  await caja.getByRole('button', { name: 'Buscar' }).click();
  await expect(caja.getByTestId('customer-blocked')).toBeVisible();
  await shot(page, '8-cliente');
  await detail.getByRole('button', { name: 'Desbloquear' }).click();
  await expect(page.getByText('Cliente desbloqueado')).toBeVisible();

  // --- 11. Inicio: configuración completa ----------------------------------------------
  await nav(page, 'Inicio');
  await expect(page.getByTestId('checklist')).toContainText('Configuración completa');
  await shot(page, '9-inicio-completo');

  mkdirSync('e2e/artifacts', { recursive: true });
  writeFileSync(
    `e2e/artifacts/${project}-panel-tiempo.json`,
    JSON.stringify({ configuracionHastaPrimeraTarjetaMs: configMs }),
  );
  test.info().annotations.push({ type: 'configuración (ms)', description: String(configMs) });
  expect(configMs).toBeLessThan(15 * 60_000);
});

test('límites del plan Start en el panel (sucursales y trabajadores)', async ({ page }) => {
  await panelLogin(
    page,
    { id: SEED.orgs.veterinaria.owner.id, email: SEED.orgs.veterinaria.owner.email },
    '/panel/sucursales',
  );
  await expect(page.getByText('Tu plan Start permite 1 sucursal')).toBeVisible();
  await expect(page.getByTestId('branch-usage')).toContainText('1 de 1 sucursal');
  await nav(page, 'Equipo');
  await expect(page.getByTestId('staff-usage')).toContainText(/de 3 trabajadores · plan Start/);
  await shot(page, '10-limites-plan');
});

// Regresión: en Chrome 153 (el de CI) window.scrollTo devuelve una Promise; el panel la devolvía como
// "limpieza" de un efecto y al cambiar de sección se caía. Se simula para probarlo con cualquier Chromium.
test('cambiar de sección no rompe el panel cuando scrollTo devuelve una Promise', async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.scrollTo.bind(window) as (...a: unknown[]) => void;
    (window as unknown as { scrollTo: (...a: unknown[]) => Promise<void> }).scrollTo = (...a) => {
      original(...a);
      return Promise.resolve();
    };
  });
  await panelLogin(page, SEED.orgs.veterinaria.owner, '/panel/sucursales');
  await expect(page.getByTestId('branch-usage')).toBeVisible();
  for (const [label, testId] of [
    ['Equipo', 'staff-usage'],
    ['Clientes', 'customers'],
    ['Inicio', 'plan-usage'],
  ] as const) {
    await nav(page, label);
    await expect(page.getByTestId(testId)).toBeVisible();
  }
  await expect(page.getByTestId('app-error')).toHaveCount(0);
});
