/** Marca: nombre, logo, color (con chequeo de contraste), frase, condiciones y contacto, con vista previa. */
import { checkBrandColor, HEX_COLOR_RE, textOn } from '@aiment/core/branding';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../api';
import { Alert } from '../components/ui';
import { prepareLogo } from './image';
import { CardPreview, previewCard, type ProgramData } from './preview';
import { Card, errorText, Field, inputCls, SmallButton, useAction, usePanel } from './shared';

export function BrandSection() {
  const { settings, call, reload, role } = usePanel();
  const b = settings.branding;
  const [form, setForm] = useState({
    name: settings.name,
    primaryColor: b.primaryColor,
    tagline: b.tagline ?? '',
    conditions: b.conditions ?? '',
    phone: b.contact.phone ?? '',
    email: b.contact.email ?? '',
    website: b.contact.website ?? '',
    instagram: b.contact.instagram ?? '',
  });
  const [program, setProgram] = useState<ProgramData | null>(null);
  const { msg, setMsg, busy, run } = useAction();
  const [logoBusy, setLogoBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const canEdit = role !== 'staff';

  useEffect(() => {
    void call<ProgramData>('/program').then(setProgram);
  }, [call]);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const validColor = HEX_COLOR_RE.test(form.primaryColor);
  const check = validColor ? checkBrandColor(form.primaryColor) : null;

  async function save(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      await call('/settings', {
        method: 'PATCH',
        json: {
          name: form.name,
          primaryColor: form.primaryColor,
          tagline: form.tagline,
          conditions: form.conditions,
          contact: { phone: form.phone, email: form.email, website: form.website, instagram: form.instagram },
        },
      });
      await reload();
    }, 'Marca guardada. Tus clientes ya la ven en su tarjeta.');
  }

  async function upload(file: File | undefined) {
    if (!file) return;
    setMsg(null);
    setLogoBusy(true);
    try {
      const blob = await prepareLogo(file);
      await call('/settings/logo', { method: 'PUT', body: blob, headers: { 'content-type': blob.type } });
      await reload();
      setMsg({ tone: 'ok', text: 'Logo actualizado.' });
    } catch (err) {
      setMsg({ tone: 'error', text: err instanceof ApiError ? errorText(err) : (err as Error).message });
    } finally {
      setLogoBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  const preview =
    program &&
    previewCard(
      {
        name: form.name || settings.name,
        branding: {
          ...b,
          primaryColor: validColor ? form.primaryColor.toUpperCase() : b.primaryColor,
          textColor: textOn(validColor ? form.primaryColor : b.primaryColor),
          tagline: form.tagline.trim() || null,
          conditions: form.conditions.trim() || null,
          contact: {
            phone: form.phone.trim() || null,
            email: form.email.trim() || null,
            website: form.website.trim() || null,
            instagram: form.instagram.trim().replace(/^@/, '') || null,
          },
        },
      },
      { ...program, goal: program.rule?.goal ?? null },
    );

  return (
    <div className="grid gap-4 md:grid-cols-[1fr_320px]">
      <div className="space-y-4">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <Card title="Logo" testId="logo-card">
          <div className="flex items-center gap-4">
            {b.logoUrl ? (
              <img
                src={b.logoUrl}
                alt="Logo actual"
                className="h-16 w-16 rounded-xl bg-white object-cover ring-1 ring-gray-200"
              />
            ) : (
              <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-gray-100 text-xs text-gray-500">
                Sin logo
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <label className="inline-flex min-h-11 cursor-pointer items-center rounded-xl bg-gray-900 px-3 text-sm font-semibold text-white">
                {logoBusy ? 'Subiendo…' : b.hasLogo ? 'Cambiar logo' : 'Subir logo'}
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/*"
                  className="sr-only"
                  disabled={!canEdit || logoBusy}
                  data-testid="logo-input"
                  onChange={(e) => void upload(e.target.files?.[0])}
                />
              </label>
              {b.hasLogo && (
                <SmallButton
                  tone="danger"
                  disabled={busy}
                  onClick={() =>
                    void run(() => call('/settings/logo', { method: 'DELETE' }).then(reload), 'Logo quitado.')
                  }
                >
                  Quitar
                </SmallButton>
              )}
            </div>
          </div>
          <p className="mt-2 text-xs text-gray-500">
            PNG, JPG o una foto del celular. Se ajusta sola a 512 px. Mejor si es cuadrado y con fondo claro.
          </p>
        </Card>

        <form onSubmit={save} className="space-y-4">
          <Card title="Nombre y color">
            <div className="space-y-3">
              <Field label="Nombre del negocio">
                <input
                  className={inputCls}
                  value={form.name}
                  onChange={set('name')}
                  maxLength={60}
                  required
                  disabled={!canEdit}
                />
              </Field>
              <Field
                label="Frase corta (opcional)"
                hint="Aparece bajo tu nombre. Ej.: «Tu ropa lista en 24 horas»."
              >
                <input
                  className={inputCls}
                  value={form.tagline}
                  onChange={set('tagline')}
                  maxLength={80}
                  disabled={!canEdit}
                />
              </Field>
              <Field label="Color de tu marca">
                <div className="flex gap-2">
                  <input
                    type="color"
                    aria-label="Elegir color"
                    className="h-12 w-14 shrink-0 cursor-pointer rounded-xl border border-gray-300 bg-white p-1"
                    value={validColor ? form.primaryColor : '#000000'}
                    onChange={set('primaryColor')}
                    disabled={!canEdit}
                  />
                  <input
                    className={`${inputCls} font-mono uppercase`}
                    aria-label="Código del color"
                    value={form.primaryColor}
                    onChange={set('primaryColor')}
                    maxLength={7}
                    placeholder="#1F2937"
                    disabled={!canEdit}
                  />
                </div>
              </Field>
              {!validColor && (
                <Alert tone="error">Escribe el color como #RRGGBB (por ejemplo, #0E7490).</Alert>
              )}
              {check && (
                <div data-testid="contrast-check">
                  {check.level === 'ok' ? (
                    <p className="text-xs text-emerald-700">
                      ✓ Buen contraste: el texto y los sellos se leen bien (texto {check.textRatio.toFixed(1)}
                      :1, sellos {check.onWhiteRatio.toFixed(1)}:1).
                    </p>
                  ) : (
                    <Alert tone="info">
                      Este color es claro: los sellos y la barra de progreso se verán poco sobre el fondo
                      blanco ({check.onWhiteRatio.toFixed(1)}:1; se recomienda 3:1).{' '}
                      <button
                        type="button"
                        className="font-semibold underline"
                        onClick={() => setForm((f) => ({ ...f, primaryColor: check.suggestion! }))}
                      >
                        Usar {check.suggestion}
                      </button>
                    </Alert>
                  )}
                </div>
              )}
            </div>
          </Card>

          <Card title="Condiciones del programa">
            <Field
              label="Condiciones (opcional)"
              hint="Se muestran en el registro y en la tarjeta del cliente."
            >
              <textarea
                className="min-h-28 w-full rounded-xl border border-gray-300 bg-white p-3 text-base"
                value={form.conditions}
                onChange={set('conditions')}
                maxLength={1000}
                placeholder="Ej.: Un sello por servicio. Premio válido por 90 días. No acumulable con otras promociones."
                disabled={!canEdit}
              />
            </Field>
          </Card>

          <Card title="Contacto">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Teléfono o WhatsApp">
                <input
                  className={inputCls}
                  type="tel"
                  value={form.phone}
                  onChange={set('phone')}
                  maxLength={25}
                  placeholder="+51 987 654 321"
                  disabled={!canEdit}
                />
              </Field>
              <Field label="Instagram">
                <input
                  className={inputCls}
                  value={form.instagram}
                  onChange={set('instagram')}
                  maxLength={31}
                  placeholder="@tunegocio"
                  disabled={!canEdit}
                />
              </Field>
              <Field label="Página web">
                <input
                  className={inputCls}
                  type="url"
                  value={form.website}
                  onChange={set('website')}
                  maxLength={200}
                  placeholder="https://"
                  disabled={!canEdit}
                />
              </Field>
              <Field label="Correo">
                <input
                  className={inputCls}
                  type="email"
                  value={form.email}
                  onChange={set('email')}
                  maxLength={120}
                  disabled={!canEdit}
                />
              </Field>
            </div>
          </Card>

          {canEdit && (
            <button
              type="submit"
              disabled={busy || !validColor}
              className="min-h-12 w-full rounded-xl bg-gray-900 px-4 font-semibold text-white disabled:opacity-50"
            >
              {busy ? 'Guardando…' : 'Guardar marca'}
            </button>
          )}
        </form>
      </div>
      <aside className="md:sticky md:top-16 md:self-start">{preview && <CardPreview card={preview} />}</aside>
    </div>
  );
}
