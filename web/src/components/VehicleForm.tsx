import { useCallback, useEffect, useId, useState } from 'react';
import { api, ApiError, type Vehicle, type VehicleKindOption } from '../api';
import '../styles-parts.css';

/**
 * The van, as the customer will see it.
 *
 * Required before openings go up, and the form says so rather than letting
 * somebody discover it from a blocked listing. It is thirty seconds of typing
 * and it is what a person standing behind their own front door checks before
 * they open it to somebody they have never met.
 *
 * The plate is stored exactly as typed. It is read by a human against a real
 * van and never matched programmatically, so normalising it could only make
 * the stored version stop looking like the thing on the bumper.
 */
export default function VehicleForm() {
  const [v, setV] = useState<Vehicle>({
    make: '', model: '', color: '', plate: '', kind: null,
  });
  /**
   * The shapes, from the Worker rather than from a list typed out here. See
   * /api/public/vehicle-kinds — a form with its own copy of the list is a form
   * that will one day offer a choice the server rejects.
   */
  const [kinds, setKinds] = useState<VehicleKindOption[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The stem of the ids tying each shape button to its own name and hint. It
   * comes from React rather than from the slug alone because this form is
   * rendered inside the sign-up wizard as well as in Settings, and two copies
   * on one page would otherwise both answer to id="van-hint".
   */
  const ids = useId();

  const load = useCallback(async () => {
    // Two independent reads. The list of shapes is public and the operator's
    // own vehicle is not, so a failure on either must not take the other down
    // with it: allSettled rather than Promise.all.
    const [mine, list] = await Promise.allSettled([api.vehicle(), api.vehicleKinds()]);
    if (mine.status === 'fulfilled') {
      setV({
        make: mine.value.vehicle.make ?? '', model: mine.value.vehicle.model ?? '',
        color: mine.value.vehicle.color ?? '', plate: mine.value.vehicle.plate ?? '',
        kind: mine.value.vehicle.kind ?? null,
      });
    }
    if (list.status === 'fulfilled') setKinds(list.value.kinds);
    setLoaded(true);
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!loaded) return null;

  const complete = !!v.make?.trim() && !!v.color?.trim() && !!v.plate?.trim();

  // Editing a field takes "Saved." down with it. It used to stay up while the
  // operator retyped the plate, which says the thing on screen is stored when
  // it is not — on the one form a customer checks against a real van.
  const edit = (patch: Partial<Vehicle>) => { setSaved(false); setV({ ...v, ...patch }); };

  return (
    <section className="stack">
      <span className="eyebrow">Your vehicle</span>
      <p className="muted" style={{ margin: 0 }}>
        Customers are told what to look for before you arrive. Make, colour and
        plate are needed before your openings go up.
      </p>

      <form className="card stack" onSubmit={(e) => {
        e.preventDefault();
        setBusy(true); setError(null); setSaved(false);
        void (async () => {
          try {
            await api.saveVehicle(v);
            setSaved(true);
          } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Could not save that.');
          } finally { setBusy(false); }
        })();
      }}>
        <div className="field-row">
          <label>Make
            <input value={v.make ?? ''} placeholder="Ford"
              onChange={(e) => edit({ make: e.target.value })} /></label>
          <label>Model (optional)
            <input value={v.model ?? ''} placeholder="Transit"
              onChange={(e) => edit({ model: e.target.value })} /></label>
        </div>
        <div className="field-row">
          <label>Colour
            <input value={v.color ?? ''} placeholder="White"
              onChange={(e) => edit({ color: e.target.value })} /></label>
          <label>Plate
            <input value={v.plate ?? ''} placeholder="8ABC123"
              onChange={(e) => edit({ plate: e.target.value })} /></label>
        </div>

        {/* WHAT SHAPE IT IS.
            Not derivable from the make and model: "Ford Transit" is a van and
            "Ford F-150" is a pickup, and the only way to know is to ask. It is
            what a customer at a window actually says, and it is what the front
            page draws driving across the map — so a junk removal firm towing a
            trailer shows a trailer, and does not show somebody else's van.

            Buttons rather than a dropdown: five options, and a dropdown hides
            all of them behind a tap while making the whole thing look longer
            than it is.

            EVERY HINT IS ON THE PAGE, because the hint is the thing that tells
            these five apart. "A high-sided car. Not a van: the back is seats or
            a boot" is the entire difference between two of the options, and it
            used to live in a `title` — which a phone never shows at all, which
            a screen reader may or may not read, and which no keyboard can reach.
            The paragraph underneath only ever printed the hint belonging to the
            option already chosen, so the sentence a person needed in order to
            choose arrived after they had chosen. That is WCAG 2.1 AA 1.3.1:
            information carried by the layout was not available in text anybody
            could get at, and 4.1.2, because the name and description of each
            button did not carry it either.

            Each button now names itself from its label and is described by its
            own hint, and the hint is on screen either way — a description a
            reader is set not to announce is still a sentence sitting under the
            words it explains. The aria-labelledby is what keeps the label the
            button's NAME: without it the name is the label and the hint run
            together, and "Van Transit, Sprinter, ProMaster, or a smaller panel
            van" is a worse thing to hear five times over than "Van". */}
        {kinds.length > 0 && (
          <fieldset className="kind-pick">
            <legend>What do you drive?</legend>
            <div className="kind-row" role="group">
              {kinds.map((k) => (
                <button key={k.slug} type="button"
                  className={`kind-chip${v.kind === k.slug ? ' on' : ''}`}
                  aria-pressed={v.kind === k.slug}
                  aria-labelledby={`${ids}-name-${k.slug}`}
                  aria-describedby={`${ids}-hint-${k.slug}`}
                  onClick={() => edit({ kind: v.kind === k.slug ? null : k.slug })}>
                  <span id={`${ids}-name-${k.slug}`}>{k.label}</span>
                  <span id={`${ids}-hint-${k.slug}`} className="kind-hint">{k.hint}</span>
                </button>
              ))}
            </div>
            <p className="faint" style={{ margin: '8px 0 0' }}>
              Shown on the map, and told to the customer before you arrive.
            </p>
          </fieldset>
        )}

        {!complete && (
          <p className="faint" style={{ margin: 0 }}>
            Make, colour and plate are the three a customer actually checks.
          </p>
        )}
        {saved && <div className="notice">Saved.</div>}
        {error && <div className="error">{error}</div>}

        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save vehicle'}
        </button>
      </form>
    </section>
  );
}
