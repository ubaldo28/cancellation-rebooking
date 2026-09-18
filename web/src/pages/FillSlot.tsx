import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  api, durationLabel, lateLabel, money, timeRange,
  type Candidate, type CreatedOffer, type Gap,
} from '../api';
import { useOperator } from '../App';
import { Empty, ErrorNote, Icon, Spinner } from '../components/ui';
import { useDocumentTitle } from '../lib/title';
import '../styles-openings.css';

const key = (c: Candidate) => `${c.kind}:${c.client_id}:${c.lead_id ?? ''}`;

/**
 * WHY NOBODY FITS, IN WORDS THAT ARE ACTUALLY TRUE.
 *
 * This screen used to say "Clients need a mobile number and SMS consent, and
 * the job has to fit the time available." Every part of that except the last
 * clause was wrong, and wrong in the most expensive way an empty state can be:
 * it was an instruction. An operator who read it went looking for a place to
 * type their customers' numbers, and there is none — a customer who books
 * through this site is stored with no number on purpose, because the promise
 * is that no contact details change hands. Even if they had found one, nothing
 * here can send a text; there is no SMS provider and there is not going to be.
 * So the advice could not be followed, and following it would not have helped.
 *
 * What is true is what the Worker's filters now ask for: somebody who booked
 * this operator through Round The Way (which is what gives them a conversation
 * to be messaged in and an account to be emailed at), who has not opted out,
 * who is not already in the diary, who was not offered something recently, and
 * whose usual job fits the hole.
 *
 * WRITTEN OUT TWICE. The Worker says the same sentence as the `reason` on a
 * send that finds nobody — see NOBODY_TO_OFFER in src/lib/rank.ts — because
 * this page can arrive at the same fact by two routes and must not describe it
 * two ways. test/two-trees.test.ts pins the pair character for character.
 */
export const NOBODY_TO_OFFER =
  'Nobody fits this slot. It can only be offered to customers who booked you '
  + 'through Round The Way — the offer lands in the conversation you already '
  + 'have with them, and in their email. It also needs someone who is not '
  + 'already in your diary, was not offered a slot recently, and whose usual '
  + 'job fits the time.';

export default function FillSlot() {
  useDocumentTitle('Fill this slot');
  const { gapId = '' } = useParams();
  const op = useOperator();
  const navigate = useNavigate();

  const [gap, setGap] = useState<Gap | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [offers, setOffers] = useState<CreatedOffer[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const { gap, candidates } = await api.candidates(gapId);
      setGap(gap);
      setCandidates(candidates);
      // Preselect the operator's wave size — the ranking already put the best first.
      setPicked(new Set(candidates.slice(0, op?.offers_per_wave ?? 3).map(key)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this slot.');
    } finally {
      setLoading(false);
    }
  }, [gapId, op?.offers_per_wave]);

  useEffect(() => { void load(); }, [load]);

  const chosen = useMemo(
    () => candidates.filter((c) => picked.has(key(c))),
    [candidates, picked],
  );

  function toggle(c: Candidate) {
    const k = key(c);
    setPicked((prev) => {
      const next = new Set(prev);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });
  }

  async function send() {
    setSending(true); setError(null);
    try {
      const res = await api.sendOffers(gapId, chosen.map((c) => ({
        kind: c.kind, client_id: c.client_id, lead_id: c.lead_id,
      })));
      if (res.offers.length === 0) {
        setError(res.reason ?? NOBODY_TO_OFFER);
      } else {
        setOffers(res.offers);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send.');
    } finally {
      setSending(false);
    }
  }

  if (offers) {
    return <SentWave offers={offers} gap={gap} />;
  }

  return (
    <>
      <header className="page-head">
        {/* The same control as PostOpening's, wearing the same class rather
            than the same four inline styles written out again. */}
        <Link to="/app" className="row po-back">
          <Icon name="back" size={20} stroke={1.9} />
          <span style={{ fontWeight: 500 }}>Fill this slot</span>
        </Link>
        {gap && (
          <>
            <div className="slot" style={{ fontSize: 22 }}>
              {timeRange(gap.starts_at, gap.ends_at, op)}
            </div>
            <span className="muted">{durationLabel(gap.ends_at - gap.starts_at)} open</span>
          </>
        )}
      </header>

      <main className="main stack">
        {error && <ErrorNote error={error} onRetry={load} />}
        {loading && <Spinner label="Ranking your clients" />}

        {!loading && candidates.length === 0 && !error && (
          <Empty>{NOBODY_TO_OFFER}</Empty>
        )}

        {!loading && candidates.length > 0 && (
          <>
            <div className="spread">
              <span className="eyebrow">Best fits</span>
              <span className="muted">{picked.size} of {candidates.length} selected</span>
            </div>

            {candidates.map((c) => {
              const on = picked.has(key(c));
              const late = lateLabel(c.overdue_days);
              return (
                <button key={key(c)} className={`pick${on ? ' on' : ''}`} onClick={() => toggle(c)}>
                  <span className="box">
                    {on && <Icon name="tick" size={13} color="#fff" stroke={3.2} />}
                  </span>
                  <span className="grow stack" style={{ gap: 7 }}>
                    <span className="spread">
                      <span className="name">{c.first_name}</span>
                      <span className="price" style={{ color: on ? 'var(--accent)' : 'var(--muted)' }}>
                        {c.price_cents > 0 ? money(c.price_cents, op) : ''}
                      </span>
                    </span>
                    <span className="muted">{c.title}</span>
                    <span className="chips">
                      {c.reasons.map((r, i) => (
                        <span key={i} className={`chip ${chipTone(r)}`}>{r}</span>
                      ))}
                      {late && !c.reasons.some((r) => r.includes('late') || r.includes('due')) && (
                        <span className="chip neutral">{late}</span>
                      )}
                    </span>
                  </span>
                </button>
              );
            })}

            <div className="stack" style={{ marginTop: 6 }}>
              <button className="btn block" disabled={picked.size === 0 || sending} onClick={send}>
                {/* "Preparing…" was honest when the button only built `sms:`
                    links for the operator to tap afterwards. The Worker does
                    the sending now, so the word is the one that describes what
                    is happening while they wait. */}
                {sending ? 'Sending…'
                  : picked.size === 0 ? 'Select someone to send to'
                  : `Send to ${picked.size}`}
              </button>
              <p className="faint" style={{ textAlign: 'center', margin: 0 }}>
                First to confirm gets it. The rest are told it's gone.
              </p>
              {/* Nothing caught the rejection here, so a dismiss that failed
                  left an unhandled promise in the console and the operator on
                  a page that had not changed and had not said why. The error
                  box above already has a Try again next to it. */}
              <button className="btn quiet block sm" disabled={sending}
                onClick={() => {
                  void (async () => {
                    try {
                      await api.dismissGap(gapId);
                      navigate('/app');
                    } catch (e) {
                      setError(e instanceof Error ? e.message
                        : 'Could not leave this slot empty.');
                    }
                  })();
                }}>
                Leave this slot empty
              </button>
            </div>
          </>
        )}
      </main>
    </>
  );
}

function chipTone(reason: string): 'good' | 'neutral' | 'warn' {
  if (/no address|no repeat|short notice|no-show/i.test(reason)) return 'warn';
  if (/on the way|weeks late|days late|due today/i.test(reason)) return 'good';
  const mins = reason.match(/^(\d+) min extra/);
  if (mins) return Number(mins[1]) <= 8 ? 'good' : 'warn';
  return 'neutral';
}

// ---------------------------------------------------------------------------
// What was sent, and where it went.
//
// THIS SCREEN USED TO BE A TO-DO LIST. It said "Send from your phone", handed
// the operator one `sms:` link per offer and counted how many they had tapped,
// because the Worker did not send anything itself. Two things were wrong with
// it. The links were built from a phone number this product deliberately never
// stores for a customer it introduced, so on a live marketplace booking they
// were `sms:` with nothing after it. And the offer rows had already been
// written as 'sent' before the operator tapped anything, so a wave they never
// got round to sending looked identical in the database to one they did.
//
// The Worker now delivers each offer into the conversation the customer
// already has with this business and emails them about it, so there is nothing
// left to do here. This screen exists to say what happened — who was asked,
// what they were told, and whether the email went — and then to get out of the
// way.
// ---------------------------------------------------------------------------
function SentWave({ offers, gap }: {
  offers: CreatedOffer[];
  gap: Gap | null;
}) {
  const op = useOperator();

  return (
    <>
      <header className="page-head">
        <h1 style={{ fontSize: 21 }}>Sent</h1>
        <p className="muted" style={{ marginTop: 6 }}>
          Each one is in your conversation with them, with an email to let them
          know. First to confirm gets the slot.
        </p>
      </header>

      <main className="main stack">
        <div className="spread">
          <span className="eyebrow">{offers.length} asked</span>
          {/* The slot these messages are about. It used to read "Expires" and
              then the second comma-separated field of a time range whose two
              ends were the same instant — which came out as a bare date and
              was not an expiry of anything. Nothing in the offer payload
              carries an expiry, so the honest thing to print is the slot. */}
          {gap && <span className="muted">{timeRange(gap.starts_at, gap.ends_at, op)}</span>}
        </div>

        {offers.map((o) => (
          <div key={o.offer_id} className="card stack">
            <div className="row">
              <div className="grow stack" style={{ gap: 2 }}>
                <span className="name" style={{ fontSize: 15 }}>{o.first_name}</span>
                {/* Said plainly rather than left to assume. The message is in
                    their conversation either way; whether anything pinged them
                    about it is the part the operator cannot see for
                    themselves, and "we emailed them" when nothing left would
                    be the site lying about its own delivery. */}
                <span className="muted" style={{ fontSize: 12 }}>
                  {o.emailed
                    ? 'In their messages, and emailed'
                    : 'In their messages — no email went, so they see it next time they open it'}
                </span>
              </div>
              <Icon name="tick" size={18} color="var(--accent)" stroke={2.6} />
            </div>
            <div className="sms">{o.message}</div>
          </div>
        ))}

        <div className="notice">
          Nothing to send by hand, and no phone numbers change hands. Replies
          come back in Messages.
        </div>

        <Link to="/app/messages" className="btn ghost block">Go to Messages</Link>
        <Link to="/app" className="btn ghost block">Done</Link>
      </main>
    </>
  );
}
