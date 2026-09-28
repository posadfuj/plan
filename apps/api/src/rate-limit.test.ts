import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rate-limit';

describe('límite de intentos', () => {
  it('permite hasta el límite y luego indica cuánto esperar; la ventana se reinicia', () => {
    const l = new RateLimiter();
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) expect(l.hit('ip', 3, 60_000, t).ok).toBe(true);
    expect(l.hit('ip', 3, 60_000, t + 1000)).toEqual({ ok: false, retryAfter: 59 });
    expect(l.hit('otra-ip', 3, 60_000, t).ok).toBe(true);
    expect(l.hit('ip', 3, 60_000, t + 60_000).ok).toBe(true);
  });
});
