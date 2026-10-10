/**
 * `test` con un control automático: si el navegador bloquea algo por la política de seguridad (CSP),
 * la prueba falla (un logo o un QR bloqueado podría pasar inadvertido). Cubre también los contextos
 * extra que abren las pruebas (cliente y caja a la vez). La CSP solo se aplica con `vite preview`
 * (CI); con `pnpm dev` no hay política y el control no encuentra nada.
 */
import { expect, test as base, type BrowserContext, type Page } from '@playwright/test';

export const test = base.extend<{ cspGuard: void }>({
  cspGuard: [
    async ({ context, browser }, use) => {
      const violations: string[] = [];
      const watch = (ctx: BrowserContext) => {
        const onPage = (page: Page) =>
          page.on('console', (msg) => {
            if (/Content Security Policy/i.test(msg.text())) violations.push(msg.text());
          });
        ctx.pages().forEach(onPage);
        ctx.on('page', onPage);
      };
      watch(context);
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (...args) => {
        const ctx = await newContext(...args);
        watch(ctx);
        return ctx;
      };
      await use();
      browser.newContext = newContext;
      expect(violations, 'el navegador bloqueó recursos por la CSP').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
