import type { PartsPolicy } from '../api';
import '../styles-parts.css';

/**
 * The parts question on a service form.
 *
 * One component, used by the sign-up flow and by settings, because those two
 * forms drifting apart is how an operator ends up with a price list where half
 * the services promise something the other half do not.
 *
 * The wording is doing real work here. "Does this job need parts?" is the
 * obvious question and it is the wrong one: it gets a yes from anybody who
 * carries a filter, and a yes means nothing about who pays. The question that
 * matters is whether the operator can name the number before they arrive, so
 * that is the question the form asks, in those words.
 */

export interface PartsValue {
  parts_policy: PartsPolicy;
  parts_note: string;
  parts_low: string;
  parts_high: string;
}

export const EMPTY_PARTS: PartsValue = {
  parts_policy: 'none', parts_note: '', parts_low: '', parts_high: '',
};

/** Turns the form's strings into the fields the API takes. */
export const partsPayload = (v: PartsValue) => ({
  parts_policy: v.parts_policy,
  parts_note: v.parts_note.trim() || null,
  parts_estimate_low_cents: v.parts_policy === 'quoted' && v.parts_low
    ? Math.round(Number(v.parts_low) * 100) : null,
  parts_estimate_high_cents: v.parts_policy === 'quoted' && v.parts_high
    ? Math.round(Number(v.parts_high) * 100) : null,
});

const OPTIONS: Array<{ value: PartsPolicy; label: string; help: string }> = [
  {
    value: 'none',
    label: 'No parts — the price is the price',
    help: 'A wash, a cut, a haul-away. Nothing is ever added.',
  },
  {
    value: 'included',
    label: 'Parts included, already in my price',
    help: 'You carry what the job needs — oil and a filter, a cylinder, a belt '
      + '— and you have priced it in. The customer is told parts are covered.',
  },
  {
    value: 'quoted',
    label: 'I cannot price the part until I see the job',
    help: 'A diagnosis, a repair, anything where the part depends on what you '
      + 'find. The customer pays your labour up front, and when you know what '
      + 'is needed you send them the part price from the booking. Nothing is '
      + 'charged until they tap approve.',
  },
];

export default function PartsPolicyField(
  { value, onChange, currencySymbol = '$' }:
  { value: PartsValue; onChange: (v: PartsValue) => void; currencySymbol?: string },
) {
  const set = (patch: Partial<PartsValue>) => onChange({ ...value, ...patch });

  return (
    <fieldset className="parts-field">
      <legend>Parts</legend>

      {OPTIONS.map((o) => (
        <label key={o.value} className="parts-option">
          <input
            type="radio"
            name="parts_policy"
            checked={value.parts_policy === o.value}
            onChange={() => set({ parts_policy: o.value })}
          />
          <span>
            <strong>{o.label}</strong>
            <span className="faint"> {o.help}</span>
          </span>
        </label>
      ))}

      {value.parts_policy === 'quoted' && (
        <>
          {/* Optional, and the form says so, because an operator who genuinely
              cannot bound it should not be pushed into inventing a number that
              the customer will then hold them to. */}
          <div className="field-row">
            <label>
              Parts usually cost from (optional)
              <input type="number" min="0" step="1" value={value.parts_low}
                onChange={(e) => set({ parts_low: e.target.value })}
                placeholder={`${currencySymbol}60`} />
            </label>
            <label>
              up to
              <input type="number" min="0" step="1" value={value.parts_high}
                onChange={(e) => set({ parts_high: e.target.value })}
                placeholder={`${currencySymbol}200`} />
            </label>
          </div>
          <p className="faint" style={{ margin: 0 }}>
            A range makes people book. Without one they are staring at a blank
            and most of them close the page.
          </p>
        </>
      )}

      {value.parts_policy !== 'none' && (
        <label>
          What should the customer know? (optional)
          <input value={value.parts_note} maxLength={300}
            onChange={(e) => set({ parts_note: e.target.value })}
            placeholder={value.parts_policy === 'quoted'
              ? "Price covers the diagnosis and the labour. If it needs a part I'll send you the price before I fit anything."
              : 'Oil and filter included.'} />
        </label>
      )}

      {/* The platform never calculates tax. California does not tax repair
          labour but it does tax parts, and the rate varies by district across
          the county — so the business is the seller and the price they set is
          the price charged. Saying it here is what makes that true rather than
          assumed. It sits under the parts question because that is the only
          place tax is ever actually owed. */}
      <p className="faint" style={{ margin: 0 }}>
        The amounts you set are the whole amount the customer pays. If you owe
        sales tax on parts you supply, include it — we never add anything on
        top of your price.
      </p>
    </fieldset>
  );
}
