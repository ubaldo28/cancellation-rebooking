import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Vehicle } from '../api';
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
  const [v, setV] = useState<Vehicle>({ make: '', model: '', color: '', plate: '' });
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.vehicle();
      setV({
        make: res.vehicle.make ?? '', model: res.vehicle.model ?? '',
        color: res.vehicle.color ?? '', plate: res.vehicle.plate ?? '',
      });
    } catch {
      // Nothing useful to show; the fields stay empty and saving still works.
    } finally { setLoaded(true); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!loaded) return null;

  const complete = !!v.make?.trim() && !!v.color?.trim() && !!v.plate?.trim();

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
              onChange={(e) => setV({ ...v, make: e.target.value })} /></label>
          <label>Model (optional)
            <input value={v.model ?? ''} placeholder="Transit"
              onChange={(e) => setV({ ...v, model: e.target.value })} /></label>
        </div>
        <div className="field-row">
          <label>Colour
            <input value={v.color ?? ''} placeholder="White"
              onChange={(e) => setV({ ...v, color: e.target.value })} /></label>
          <label>Plate
            <input value={v.plate ?? ''} placeholder="8ABC123"
              onChange={(e) => setV({ ...v, plate: e.target.value })} /></label>
        </div>

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
