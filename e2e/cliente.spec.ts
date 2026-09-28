/**
 * Flujo completo del cliente en un celular:
 * QR/NFC del local → landing → registro → membresía → tarjeta web → QR individual,
 * más duplicados y recuperación de la tarjeta.
 */
import { expect, test, type Page } from '@playwright/test';
import { decodeQr, randomEmail, randomPhone, waitForEmail } from './helpers';

const LINK = 'BRB2K'; // Barbería Pedro (datos de prueba)
const shots = (page: Page, name: string) =>
  page.screenshot({ path: `e2e/artifacts/${test.info().project.name}-${name}.png`, fullPage: true });

async function register(
  page: Page,
  data: { name: string; phone: string; email?: string; birthday?: string },
  channel: 'q' | 'n' = 'q',
) {
  await page.goto(`/go/${LINK}?c=${channel}`);
  await expect(page).toHaveURL(new RegExp(`/join/${LINK}\\?c=${channel === 'q' ? 'qr' : 'nfc'}&v=\\d+`));
  await expect(page.getByRole('heading', { name: 'Barbería Pedro' })).toBeVisible();
  await page.getByLabel('Nombre y apellido', { exact: true }).fill(data.name);
  await page.getByLabel('Celular', { exact: true }).fill(data.phone);
  if (data.email) await page.getByLabel('Correo (opcional)').fill(data.email);
  if (data.birthday) await page.getByLabel('Cumpleaños (opcional)').pressSequentially(data.birthday);
  await page.getByRole('checkbox').first().check();
}

test('registro desde el QR del local hasta la tarjeta web con QR individual', async ({ page, browser }) => {
  const phone = randomPhone();
  await register(page, {
    name: 'Valeria Torres',
    phone: `${phone.slice(0, 3)} ${phone.slice(3, 6)} ${phone.slice(6)}`,
    birthday: '07031991', // se escriben solo números; la pantalla pone las barras
  });
  await expect(page.getByLabel('Cumpleaños (opcional)')).toHaveValue('07/03/1991');
  await expect(page.getByLabel('Cumpleaños (opcional)')).toHaveAttribute('placeholder', 'dd/mm/aaaa');
  await shots(page, '1-landing');
  await page.getByRole('button', { name: 'Crear mi tarjeta' }).click();

  await expect(page).toHaveURL(/\/m\/[0-9A-Za-z]{22}$/);
  const cardUrl = page.url();
  const cardToken = cardUrl.split('/m/')[1]!;
  await expect(page.getByRole('heading', { name: 'Barbería Pedro' })).toBeVisible();
  await expect(page.getByTestId('customer-name')).toHaveText('Valeria Torres');
  await expect(page.getByTestId('balance')).toContainText('0 sellos');
  await expect(page.getByTestId('progress')).toHaveText('0 de 10 sellos');
  await expect(page.getByTestId('next-reward')).toContainText('Corte gratis');
  await expect(page.getByTestId('short-code')).toHaveText(/^[23456789A-Z]{6}$/);
  await expect(page.getByTestId('powered-by')).toContainText('Powered by Aiment Wallet');
  await expect(page.getByRole('button', { name: /Agregar a Apple Wallet/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Agregar a Google Wallet/ })).toBeDisabled();
  await expect(page.getByTestId('wallet-buttons').getByText('Próximamente', { exact: true })).toHaveCount(2);
  await shots(page, '2-tarjeta');

  // El QR que ve la caja (leído desde la pantalla, como una cámara)
  const qr = await decodeQr(page.getByTestId('qr'));
  expect(qr).toMatch(new RegExp(`^${new URL(cardUrl).origin}/s/[0-9A-Za-z]{22}$`));
  expect(qr).not.toContain(cardToken);
  expect(qr).not.toContain('/m/');

  // Otra persona escanea el QR con su cámara: no ve nombre, saldo ni la URL privada
  const stranger = await browser.newContext();
  const other = await stranger.newPage();
  const bodies: string[] = [];
  other.on('response', async (r) => {
    if (r.url().includes('/v1/')) bodies.push(await r.text().catch(() => ''));
  });
  await other.goto(qr);
  await expect(other.getByTestId('scan-message')).toHaveText(
    'Presenta este código en caja de Barbería Pedro.',
  );
  const html = await other.content();
  for (const secret of ['Valeria', 'Torres', cardToken, 'sellos']) {
    expect(html).not.toContain(secret);
    expect(bodies.join('\n')).not.toContain(secret);
  }
  await other.screenshot({
    path: `e2e/artifacts/${test.info().project.name}-3-qr-escaneado-por-otra-persona.png`,
  });
  await stranger.close();

  // Volver a escanear el QR del local: el celular recuerda la tarjeta (sin crear otra)
  await page.goto(`/go/${LINK}?c=n`);
  await expect(page.getByText('Ya tienes una tarjeta en este negocio.')).toBeVisible();
  await page.getByRole('link', { name: 'Abrir mi tarjeta' }).click();
  await expect(page).toHaveURL(cardUrl);
});

test('el mismo celular en otro dispositivo no crea una segunda tarjeta', async ({ page, browser }) => {
  const phone = randomPhone();
  await register(page, { name: 'Jorge Ruiz', phone });
  await page.getByRole('button', { name: 'Crear mi tarjeta' }).click();
  await expect(page).toHaveURL(/\/m\//);

  const ctx = await browser.newContext();
  const second = await ctx.newPage();
  await register(second, { name: 'Otro Nombre', phone: `+51${phone}` });
  await second.getByRole('button', { name: 'Crear mi tarjeta' }).click();
  await expect(second.getByText('Este celular ya tiene una tarjeta en este negocio.')).toBeVisible();
  await expect(second).toHaveURL(/\/join\//); // no se entrega ninguna tarjeta
  await second.screenshot({
    path: `e2e/artifacts/${test.info().project.name}-4-duplicado.png`,
    fullPage: true,
  });
  await ctx.close();
});

test('recuperar la tarjeta por correo en un celular nuevo (enlace de un solo uso)', async ({
  page,
  browser,
}) => {
  const email = randomEmail('recupera');
  await register(page, { name: 'Camila Paredes', phone: randomPhone(), email });
  await page.getByRole('button', { name: 'Crear mi tarjeta' }).click();
  await expect(page).toHaveURL(/\/m\//);
  const cardUrl = page.url();

  // "Cambió de celular": contexto nuevo sin nada guardado
  const ctx = await browser.newContext();
  const phone2 = await ctx.newPage();
  await phone2.goto(`/recuperar/${LINK}`);
  await phone2.getByPlaceholder('correo@ejemplo.com o 987 654 321').fill(email);
  await phone2.getByRole('button', { name: 'Enviarme el enlace' }).click();
  await expect(phone2.getByText('Si los datos coinciden')).toBeVisible();
  await phone2.screenshot({
    path: `e2e/artifacts/${test.info().project.name}-5-recuperar.png`,
    fullPage: true,
  });

  const text = await waitForEmail(email);
  const link = /(https?:\/\/\S+\/r\/[0-9A-Za-z]{22})/.exec(text)![1]!;
  expect(text).not.toContain(cardUrl.split('/m/')[1]);
  const path = new URL(link).pathname;
  await phone2.goto(path);
  // La misma tarjeta, con una URL nueva (se rota al recuperar).
  await expect(phone2).toHaveURL(/\/m\/[0-9A-Za-z]{22}$/);
  expect(new URL(phone2.url()).pathname).not.toBe(new URL(cardUrl).pathname);
  await expect(phone2.getByTestId('customer-name')).toHaveText('Camila Paredes');

  // La URL anterior deja de abrir la tarjeta (p. ej. el celular perdido).
  await page.reload();
  await expect(page.getByText('Este enlace de tarjeta ya no funciona')).toBeVisible();

  // El mismo enlace ya no sirve
  const ctx3 = await browser.newContext();
  const phone3 = await ctx3.newPage();
  await phone3.goto(path);
  await expect(phone3.getByText('Este enlace ya no es válido')).toBeVisible();
  await ctx.close();
  await ctx3.close();
});

test('recuperar en el local: el dueño muestra un QR y el cliente lo escanea', async ({ page, browser }) => {
  test.skip(
    !process.env.E2E_AUTH,
    'Requiere Supabase Auth local (pnpm local:setup); en CI se cubre con tests de integración',
  );
  const phone = randomPhone();
  await register(page, { name: 'Luis Mendoza', phone });
  await page.getByRole('button', { name: 'Crear mi tarjeta' }).click();
  await expect(page).toHaveURL(/\/m\//);
  const cardPath = new URL(page.url()).pathname;

  const ownerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  await owner.goto('/panel');
  await owner.getByPlaceholder('Correo').fill('dueno.barberia@aiment.test');
  await owner.getByPlaceholder('Contraseña').fill(process.env.SEED_USER_PASSWORD ?? 'aiment-demo-2026');
  await owner.getByRole('button', { name: 'Entrar' }).click();
  await expect(owner.getByText('QR y NFC del mostrador')).toBeVisible();
  await expect(owner.getByRole('img', { name: `QR de registro ${LINK}` })).toBeVisible();
  await owner.getByPlaceholder('Celular o nombre').fill(phone);
  await owner.getByRole('button', { name: 'Buscar' }).click();
  await owner.getByRole('button', { name: 'QR de recuperación' }).click();
  const recoveryQr = owner.getByTestId('recovery-qr');
  await expect(recoveryQr).toBeVisible();
  await owner.screenshot({
    path: `e2e/artifacts/${test.info().project.name}-6-panel-recuperacion.png`,
    fullPage: true,
  });
  const url = await decodeQr(recoveryQr.locator('div').first());

  const clientCtx = await browser.newContext();
  const client = await clientCtx.newPage();
  await client.goto(new URL(url).pathname);
  await expect(client).toHaveURL(/\/m\/[0-9A-Za-z]{22}$/);
  expect(new URL(client.url()).pathname).not.toBe(cardPath); // URL nueva
  await expect(client.getByTestId('customer-name')).toHaveText('Luis Mendoza');
  await ownerCtx.close();
  await clientCtx.close();
});
