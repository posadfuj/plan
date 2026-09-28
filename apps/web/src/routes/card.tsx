import { useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api, type ApiError, type Card } from '../api';
import { CardView } from '../components/card-view';
import { Alert, Page, PoweredBy, Spinner } from '../components/ui';
import { forgetToken, rememberCard } from '../storage';

export function CardPage() {
  const { token } = useParams({ strict: false }) as { token: string };
  const [card, setCard] = useState<Card | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<Card>(`/v1/public/cards/${encodeURIComponent(token)}`)
        .then((c) => {
          if (!alive) return;
          setCard(c);
          rememberCard(c.organization.id, token);
        })
        .catch((e: ApiError) => {
          if (!alive) return;
          if (e.status === 404) {
            // La URL pudo quedar vieja: al recuperar la tarjeta en otro celular se genera una nueva.
            forgetToken(token);
            setError(
              'Este enlace de tarjeta ya no funciona. Si recuperaste tu tarjeta en otro celular, usa el enlace nuevo; si no, pídela en caja o con tu correo desde el QR del local.',
            );
          } else setError(e.message);
        });
    void load();
    const onFocus = () => void load(); // al volver a la pestaña, saldo actualizado
    window.addEventListener('focus', onFocus);
    return () => {
      alive = false;
      window.removeEventListener('focus', onFocus);
    };
  }, [token]);

  if (error)
    return (
      <Page>
        <Alert tone="error">{error}</Alert>
        <PoweredBy />
      </Page>
    );
  if (!card) return <Spinner />;

  return <CardView card={card} scanUrl={`${window.location.origin}${card.scanPath}`} />;
}
