// Valores que la configuración global de tests (scripts/test-global-setup.ts) entrega a cada suite.
import 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    adminUrl: string;
    apiDbUrl: string;
  }
}
