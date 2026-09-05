import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError, shortDate, type CardOnFile } from '../api';
import { useOperator } from '../App';
import { ErrorNote } from './ui';

/**
 * The card on file, and the one rule the whole payment arrangement rests on.
 *
 * NO CARD NUMBER EVER REACHES THIS COMPONENT. The processor's own element
 * takes the details inside the customer's browser and hands back an opaque
 * reference — `pm_...`, `tok_...` — and that reference, a brand and the last
 * four digits are the entire payload. A PAN in this request would drag the
 * whole project into PCI DSS scope and buy nothing at all; see
 * src/lib/payments.ts for the three guards that now refuse one on the way in,
 * on the way to the database and on the way back out.
 *
 * WHY THAT IS STRUCTURAL HERE AND NOT A CONVENTION. This file has no card
 * number field, no state holding one and no way to acquire one. `mount` below
 * is the only node the processor's element would ever own, it is a bare div,
 * and nothing reads out of it — not its value, not its text, not its
 * children. The request body is built from three named pieces of state a few
 * lines further down and there is no path from that node to any of them. Being
 * unable to send a card number is a property of what is written here, not a
 * promise about how carefully somebody edits it later.
 */
export default function PaymentMethod() {
  const op = useOperator();
  const [card, setCard] = useState<CardOnFile | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [ref, setRef] = useState('');
  const [brand, setBrand] = useState('');
  const [last4, setLast4] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  /**
   * THE SEAM. The processor's element mounts here and nowhere else.
   *
   * It is empty today because no processor is wired up — nothing in this
   * codebase can take a card yet, which is why the panel below says so rather
   * than drawing a card form that would be a lie. When one is added, its
   * element attaches to this node and hands back a reference through its own
   * callback; the invariant that must survive that change is the one stated at
   * the top of this file: nothing reads out of this node, ever. The moment
   * something does, the guard in the Worker starts refusing this form's
   * requests, which is the failure working as designed rather than a bug.
   */
  const mount = useRef<HTMLDivElement | null>(null);

  const refId = useId();
  const refHintId = useId();
  const brandId = useId();
  const last4Id = useId();

  const load = useCallback(async () => {
    setLoading(true); setLoadError(null);
    try {
      setCard((await api.paymentMethod()).card);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not check your card.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      // Three fields, named one at a time. Not a spread of form state, not a
      // FormData sweep of the panel: either of those would pick up whatever
      // the processor's element puts inside itself the day one is mounted.
      await api.savePaymentMethod({
        ref: ref.trim(),
        brand: brand.trim() || undefined,
        last4: last4.trim() || undefined,
      });
      setAdding(false); setSaved(true);
      setRef(''); setBrand(''); setLast4('');
      await load();
    } catch (e) {
      setError(refusalSentence(e));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return null;

  return (
    <section className="stack">
      <span className="eyebrow">Card on file</span>

      {loadError && <ErrorNote error={loadError} onRetry={load} />}

      {card && !adding && (
        <div className="card stack" style={{ gap: 4 }}>
          <span className="name" style={{ fontSize: 15 }}>
            {card.payment_brand ?? 'Card'}
            {card.payment_last4 ? ` ending ${card.payment_last4}` : ''}
          </span>
          {card.payment_added_at && (
            <span className="muted">Added {shortDate(card.payment_added_at, op)}</span>
          )}
        </div>
      )}

      {saved && !adding && <div className="notice">Card saved.</div>}

      <p className="muted" style={{ margin: 0 }}>
        Nothing is charged to it for using the site. It is there for one thing:
        cancelling a job late.
      </p>

      {!adding && (
        <div>
          <button className="btn quiet" type="button" onClick={() => {
            setAdding(true); setSaved(false); setError(null);
          }}>
            {card ? 'Replace this card' : 'Add a card'}
          </button>
        </div>
      )}

      {adding && (
        <form className="card stack" onSubmit={save}>
          {/* The seam, and the honest description of it. A disabled-looking
              card form with a "card number" field would say the opposite of
              what is true: this site cannot take a card number, and the box
              that could is not built. */}
          <div className="stack" style={{ gap: 6 }}>
            <strong style={{ fontSize: 13 }}>Where the card goes</strong>
            <div className="pay-seam" ref={mount}>
              <p style={{ margin: 0 }}>
                The payment provider's own card form belongs here. It is not
                connected yet, so there is nowhere on this site to type a card
                number — and this site would refuse one if there were. When it
                is connected, the card is typed into the provider's box and
                never reaches us; what comes back is the reference below.
              </p>
            </div>
          </div>

          {error && <div className="error">{error}</div>}

          <label htmlFor={refId}>
            The provider's reference
            <input id={refId} required value={ref} autoComplete="off"
              spellCheck={false} aria-describedby={refHintId}
              onChange={(e) => setRef(e.target.value)}
              placeholder="pm_1PqRsT…" />
          </label>
          <p className="faint" id={refHintId} style={{ margin: 0 }}>
            The handle the payment provider gives back once it has taken the
            card. It has letters in it and it is not printed on anything —
            there is no number you can copy off a card that belongs in this box.
          </p>

          <div className="field-row">
            <label htmlFor={brandId}>
              Brand
              <input id={brandId} value={brand} autoComplete="off"
                onChange={(e) => setBrand(e.target.value)} placeholder="Visa" />
            </label>
            <label htmlFor={last4Id}>
              Last four digits
              {/* Four digits are not a card number and are not in scope. The
                  slice is here so a paste of sixteen cannot even be typed;
                  the Worker cuts it to four again regardless. */}
              <input id={last4Id} value={last4} inputMode="numeric"
                autoComplete="off" maxLength={4}
                onChange={(e) => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="4242" />
            </label>
          </div>

          <div className="field-row">
            <button className="btn quiet" type="button" disabled={busy}
              onClick={() => { setAdding(false); setError(null); }}>
              Cancel
            </button>
            <button className="btn" type="submit" disabled={busy || !ref.trim()}>
              {busy ? 'Saving…' : 'Save the reference'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/**
 * The Worker's refusals, said to a person rather than to a developer.
 *
 * `raw_card` and `card_data` come from the guard in src/lib/payments.ts, which
 * fires on ANY request body carrying something shaped like a card or bank
 * detail — so this sentence has to do two jobs: tell somebody what to do
 * instead, and say plainly that nothing was stored, because "your card was
 * rejected" is otherwise read as "you now have a card number sitting in a log
 * somewhere".
 */
function refusalSentence(e: unknown): string {
  const code = e instanceof ApiError ? e.code : undefined;

  if (code === 'raw_card' || code === 'card_data') {
    return 'That is a card number or a bank detail, not a payment reference. '
      + 'Nothing was saved and nothing was written down. This site never takes '
      + 'card details at all — the payment provider takes them and gives back a '
      + 'reference, and that reference is the only thing this box accepts.';
  }
  if (code === 'not_a_ref') {
    return 'A payment reference has letters in it. That was only digits, so it '
      + 'is not one — nothing was saved. Copy the reference the payment '
      + 'provider gave back, not anything printed on the card.';
  }
  if (code === 'no_card') return 'Paste the provider\'s reference first.';
  return e instanceof Error ? e.message : 'That did not save. Try again.';
}
