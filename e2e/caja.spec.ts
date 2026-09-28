/**
 * Caja en un celular (semana 4): autorizar el dispositivo, entrar con PIN, ESCANEAR CLIENTE con la
 * cámara, sumar, excepción con PIN del dueño, anular, recuperación en caja y cerrar turno.
 *
 * La cámara es simulada: Chromium recibe un video con el QR que muestra la tarjeta del cliente,
 * así el escáner de la caja lee el código igual que con una cámara real.
 * Se mide el tiempo de cada operación con la CPU 4× más lenta y red móvil (Android de gama media).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type PlaywrightWorkerArgs,
} from '@playwright/test';
import { SEED } from '@aiment/db/seed-data';
import { decodeQr, pairingCodeFromDb, panelLogin, qrVideo, randomPhone } from './helpers';

const LINK = 'BRB2K'; // Barbería Pedro
const STAFF_PIN = '2580'; // PIN de los trabajadores del seed
const OWNER_PIN = '1470'; // PIN del dueño del seed

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `e2e/artifacts/${test.info().project.name}-caja-${name}.png`, fullPage: true });

async function registerCustomer(page: Page, name: string) {
  await page.goto(`/go/${LINK}?c=q`);
  await page.getByLabel('Nombre y apellido', { exact: true }).fill(name);
  await page.getByLabel('Celular', { exact: true }).fill(randomPhone());
  await page.getByRole('checkbox').first().check();
  await page.getByRole('button', { name: 'Crear mi tarjeta' }).click();
  await expect(page).toHaveURL(/\/m\/[0-9A-Za-z]{22}$/);
}

/** Navegador de la caja: mismo celular emulado, con cámara simulada que muestra `qrText`. */
async function cashierBrowser(playwright: PlaywrightWorkerArgs['playwright'], qrText: string) {
  // Ruta solo ASCII: Chromium no abre la cámara simulada si la ruta tiene tildes (p. ej. "límites").
  const video = join(tmpdir(), `aiment-camara-${test.info().project.name}-${Date.now()}.y4m`);
  await qrVideo(qrText, video);
  const browser: Browser = await playwright.chromium.launch({
    ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}),
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${video}`,
    ],
  });
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = test.info().project.use;
  const context: BrowserContext = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    viewport,
    userAgent,
    deviceScaleFactor,
    isMobile,
    hasTouch,
    locale: 'es-PE',
    permissions: ['camera'],
  });
  const page = await context.newPage();
  // Android de gama media: CPU 4× más lenta y red móvil.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 80,
    downloadThroughput: (6 * 1024 * 1024) / 8,
    uploadThroughput: (2 * 1024 * 1024) / 8,
  });
  return { browser, page };
}

async function timed<T>(fn: () => Promise<T>): Promise<number> {
  const t = Date.now();
  await fn();
  return Date.now() - t;
}

test('dispositivo sin autorizar: la caja no abre', async ({ page }) => {
  await page.goto('/caja');
  await expect(page.getByTestId('device-not-authorized')).toBeVisible();
});

test('flujo de caja completo con cámara, PIN, límites y anulación', async ({ page, playwright }) => {
  test.setTimeout(120_000);
  const times: Record<string, number> = {};

  // 1. El cliente se registra y muestra su tarjeta; la caja "ve" ese QR con su cámara.
  await registerCustomer(page, 'Andrea Salazar');
  const cardUrl = page.url();
  const scanUrl = await decodeQr(page.getByTestId('qr'));
  const { browser, page: caja } = await cashierBrowser(playwright, scanUrl);

  try {
    // 2. El dueño autorizó este celular (QR de un solo uso).
    const code = await pairingCodeFromDb('barberia', 'Celular del mostrador');
    await caja.goto(`/caja/vincular/${code}`);
    await expect(caja.getByText('quedó autorizado como "Celular del mostrador"')).toBeVisible();
    await shot(caja, '1-autorizado');
    await expect(caja.getByText('¿Quién atiende?')).toBeVisible();

    // 3. Turno: nombre + PIN.
    await caja.getByRole('button', { name: 'Jhon (caja)' }).click();
    for (const d of STAFF_PIN) await caja.getByRole('button', { name: d, exact: true }).click();
    await shot(caja, '2-pin');
    await caja.getByRole('button', { name: 'Entrar' }).click();
    await expect(caja.getByTestId('shift-name')).toHaveText('Turno: Jhon (caja)');

    // Botones grandes (≥ 56 px) para usar con una mano.
    const scanButton = caja.getByRole('button', { name: /ESCANEAR CLIENTE/ });
    expect((await scanButton.boundingBox())!.height).toBeGreaterThanOrEqual(56);

    // 4. ESCANEAR CLIENTE → la cámara lee el QR → ficha del cliente.
    times.escanearHastaFicha = await timed(async () => {
      await scanButton.click();
      await expect(caja.getByTestId('customer-name')).toHaveText('Andrea Salazar', { timeout: 15_000 });
    });
    await expect(caja.getByTestId('cashier-balance')).toContainText('0 sellos');
    await shot(caja, '3-ficha');
    const earnButton = caja.getByTestId('earn');
    expect((await earnButton.boundingBox())!.height).toBeGreaterThanOrEqual(56);

    // 5. Sumar visita.
    times.sumarVisita = await timed(async () => {
      await earnButton.click();
      await expect(caja.getByTestId('feedback')).toContainText('+1 sello');
    });
    await expect(caja.getByTestId('cashier-balance')).toContainText('1 sellos');
    await shot(caja, '4-sumado');

    // La tarjeta del cliente se actualiza.
    await page.reload();
    await expect(page.getByTestId('balance')).toContainText('1 sellos');

    // 6. Segunda visita el mismo día → límite → excepción con PIN del dueño.
    await earnButton.click();
    await expect(caja.getByTestId('limit')).toContainText('Este cliente ya sumó hace poco');
    await caja.getByTestId('override-reason').fill('Vino por la tarde otra vez');
    for (const d of '9999') await caja.getByRole('button', { name: d, exact: true }).click();
    await caja.getByRole('button', { name: 'Autorizar' }).click();
    await expect(caja.getByTestId('limit')).toContainText('PIN del dueño o del administrador incorrecto');
    await shot(caja, '5-limite');
    times.excepcionConPin = await timed(async () => {
      for (const d of OWNER_PIN) await caja.getByRole('button', { name: d, exact: true }).click();
      await caja.getByRole('button', { name: 'Autorizar' }).click();
      await expect(caja.getByTestId('cashier-balance')).toContainText('2 sellos');
    });

    // 7. Anular el último movimiento propio (con motivo).
    await caja.getByRole('button', { name: 'Anular' }).first().click();
    times.anular = await timed(async () => {
      await caja.getByRole('button', { name: 'Registré de más' }).click();
      await expect(caja.getByTestId('feedback')).toContainText('Anulado');
    });
    await expect(caja.getByTestId('cashier-balance')).toContainText('1 sellos');
    await shot(caja, '6-anulado');

    // 8. Buscar por celular o código (cuando la cámara falla).
    const shortCode = (await page.getByTestId('short-code').textContent())!.trim();
    await caja.getByRole('button', { name: 'Cerrar', exact: true }).click();
    times.buscarPorCodigo = await timed(async () => {
      await caja.getByPlaceholder('987 654 321 o ABC234').fill(shortCode);
      await caja.getByRole('button', { name: 'Buscar' }).click();
      await expect(caja.getByTestId('customer-name')).toHaveText('Andrea Salazar');
    });

    // 9. Recuperación en caja: el cliente escanea el QR con su celular nuevo.
    await caja.getByRole('button', { name: /QR de recuperación/ }).click();
    const recoveryQr = caja.getByTestId('recovery-qr');
    await expect(recoveryQr).toBeVisible();
    await shot(caja, '7-recuperacion');
    const recoveryUrl = await decodeQr(recoveryQr.locator('div').first());
    const newPhone = await (await page.context().browser()!.newContext()).newPage();
    await newPhone.goto(new URL(recoveryUrl).pathname);
    await expect(newPhone.getByTestId('customer-name')).toHaveText('Andrea Salazar');
    await expect(newPhone.getByTestId('balance')).toContainText('1 sellos');
    await page.goto(cardUrl); // el celular anterior ya no abre la tarjeta
    await expect(page.getByText('Este enlace de tarjeta ya no funciona')).toBeVisible();

    // 10. Cerrar turno.
    await caja.getByRole('button', { name: 'Cerrar turno' }).click();
    await expect(caja.getByText('¿Quién atiende?')).toBeVisible();
  } finally {
    await browser.close();
  }

  // Menos de 5 s por operación en un Android de gama media (CPU 4× más lenta, red móvil).
  mkdirSync('e2e/artifacts', { recursive: true });
  writeFileSync(
    `e2e/artifacts/${test.info().project.name}-caja-tiempos.json`,
    JSON.stringify(times, null, 2),
  );
  test.info().annotations.push({ type: 'tiempos (ms)', description: JSON.stringify(times) });
  for (const [op, ms] of Object.entries(times)) expect(ms, op).toBeLessThan(5_000);
});

test('el dueño autoriza el dispositivo desde su panel', async ({ page, browser }) => {
  await panelLogin(page, SEED.orgs.barberia.owner, '/panel/cajas');
  await page.getByPlaceholder('Ej.: Celular del mostrador').fill('Tablet de la barra');
  await page.getByRole('button', { name: 'Generar QR' }).click();
  const qr = page.getByTestId('pairing-qr');
  await expect(qr).toBeVisible();
  await shot(page, '0-panel-autorizar');
  const url = await decodeQr(qr.locator('div').first());

  const tablet = await (await browser.newContext()).newPage();
  await tablet.goto(new URL(url).pathname);
  await expect(tablet.getByText('quedó autorizado como "Tablet de la barra"')).toBeVisible();
  await expect(tablet.getByText('¿Quién atiende?')).toBeVisible();
  // El mismo QR no sirve dos veces.
  const other = await (await browser.newContext()).newPage();
  await other.goto(new URL(url).pathname);
  await expect(other.getByText('ya no es válido')).toBeVisible();
  // El panel ve el dispositivo y lo puede revocar.
  await page.reload();
  await expect(page.getByTestId('register-admin').getByText('Tablet de la barra').first()).toBeVisible();
  await shot(page, '0-panel-dispositivos');
});
