import type { Env } from '../types';
import { badRequest, notFound, now } from './util';

/**
 * Licences, insurance, and what California asks of each trade.
 *
 * Two different kinds of thing live in this file and it matters that they stay
 * apart. TRADE_RULES is the requirement: the same for every business in a
 * trade, set by the state, and nothing to do with anyone here. The credentials
 * are one business's claim about itself.
 *
 * NOTHING IN THIS FILE VERIFIES A LICENCE. There is no call to CSLB, BSIS, BAR
 * or the Structural Pest Control Board, and no function is named as though
 * there were. The platform records what a business asserts and shows it with
 * the authority's name next to it, so the customer who wants certainty can look
 * the number up in a public register themselves. A `verifyLicence()` here would
 * promise a check nobody does, and the people relying on it would be the
 * customers.
 */

/** Above this, in labour and materials together, a job is contractor work. */
export const CONTRACTOR_THRESHOLD_CENTS = 100_000;

/** The same figure in the words the rule is written in, for messages and UI. */
export const CONTRACTOR_THRESHOLD_LABEL = '$1,000';

export interface TradeRule {
  /**
   * 'required'        — a licence is needed to do this work at all.
   * 'over_threshold'  — contractor work above CONTRACTOR_THRESHOLD_CENTS; below
   *                     it, an unlicensed person must advertise as unlicensed.
   * 'none'            — no state licence is recorded as required for this work.
   */
  license: 'required' | 'over_threshold' | 'none';
  /** Short code, matching license_kind: 'cslb', 'bsis', 'bar', 'spcb', 'bhgs'. */
  authority?: string;
  /** The authority in full, as it is written on its own licences. */
  authority_name?: string;
  /** Plain English, shown to the operator as-is. */
  why: string;
}

const CSLB = 'Contractors State License Board (CSLB)';
const BHGS = 'Bureau of Household Goods and Services (BHGS)';
const BBC = 'Board of Barbering and Cosmetology';
const VMB = 'Veterinary Medical Board';

/**
 * Contractor work: licensed above $1,000 a job, and an unlicensed person below
 * that has to say so in their advertising.
 */
const contractor = (opening: string): TradeRule => ({
  license: 'over_threshold',
  authority: 'cslb',
  authority_name: CSLB,
  why: `${opening} A California contractor's licence is required for any single `
    + `job worth more than ${CONTRACTOR_THRESHOLD_LABEL}, counting labour and `
    + `materials together. At or under that figure you may work without one, but `
    + `you must state that you are unlicensed wherever you advertise.`,
});

const licensed = (
  authority: string, authority_name: string, opening: string,
): TradeRule => ({
  license: 'required',
  authority,
  authority_name,
  why: `${opening} That is required to do the work at all, whatever a job is worth.`,
});

/**
 * California's registration for anyone who repairs electronics or major
 * appliances for other people's money.
 *
 * Worth its own helper rather than reusing `licensed`, because the word
 * matters to the person reading it: this is a REGISTRATION, not a trade
 * licence. There is no exam, no apprenticeship and no trade test — it is a
 * form and a fee. An operator told they need a "licence" for fixing phone
 * screens reasonably assumes years of qualification they do not have and
 * closes the page; told they need to register, they register.
 *
 * The law is Business and Professions Code section 9840 ("It shall be unlawful
 * to act as a service dealer without first having registered") over the
 * definition in 9801, which names "cellular device, such as a telephone or
 * tablet" outright. The only exemptions are employees of a registered dealer,
 * C-7/C-10 contractors inside their own scope, car dealers fitting equipment,
 * and commercial or industrial gear. There is NO exemption for a sole trader,
 * for a small business, or for cheap jobs — which is exactly why this cannot
 * be filed as "no state licence required" and left for somebody to find out
 * about from a letter.
 */
const registered = (opening: string): TradeRule => ({
  license: 'required',
  authority: 'bhgs',
  authority_name: BHGS,
  why: `${opening} It is a registration rather than a trade licence -- a form and `
    + `a fee, with no exam -- but it is required before you take money for the `
    + `work, and it applies to a sole trader exactly as it does to a shop.`,
});

/** For the trades where no state licence is generally required. */
const noLicence = (why: string): TradeRule => ({ license: 'none', why });

const NO_STATE_LICENCE = noLicence(
  'No California state licence is generally required for this work. Your local '
  + 'business registration, your taxes and anything specific to how you work are '
  + 'still yours to keep in order.',
);

/**
 * The answer for a trade none of the rules above name — including a trade
 * typed in free text that nobody has looked at yet.
 *
 * It is 'none', and it is never 'required'. A wrong "you need a licence" stops
 * a legitimate business from publishing over something we made up, and the
 * person it stops has no way to argue with it. The honest version says which
 * rules were checked and leaves the rest with them.
 */
const UNLISTED = noLicence(
  'None of the licensing rules recorded here name this work, so this page asks '
  + 'nothing of you. Whatever does apply to how you actually work is still your '
  + 'responsibility.',
);

/**
 * Trade string to rule.
 *
 * The keys are the trade strings the app actually uses — the sign-up list, the
 * seeded businesses, and both names for the same work where there are two
 * ("bin cleaning" and "trash can cleaning").
 */
export const TRADE_RULES: Record<string, TradeRule> = {
  // --- licensed outright ---------------------------------------------------
  'mobile locksmith': licensed('bsis', 'Bureau of Security and Investigative Services (BSIS)',
    'Locksmiths in California are licensed by the Bureau of Security and '
    + 'Investigative Services.'),
  'mobile oil change and mechanics': licensed('bar', 'Bureau of Automotive Repair (BAR)',
    'Anyone doing automotive repair for money in California must be registered '
    + 'with the Bureau of Automotive Repair as an Automotive Repair Dealer.'),
  'pest control': licensed('spcb', 'Structural Pest Control Board',
    'Structural pest control in California is licensed by the Structural Pest '
    + 'Control Board.'),
  'phone and tablet repair': registered(
    'Repairing phones, tablets and computers for money in California means '
    + 'registering as an electronic service dealer with the Bureau of Household '
    + 'Goods and Services. The law names cellular telephones and tablets '
    + 'specifically.'),

  // --- contractor work above $1,000 a job ----------------------------------
  'mobile pressure washing': contractor('Pressure washing is contractor work.'),
  'handyman and repair services': contractor('Handyman work is contractor work.'),
  'gutter cleaning': contractor('Gutter cleaning is contractor work.'),
  'tree and shrub trimming': contractor('Tree and shrub trimming is contractor work.'),
  'landscaping and gardening': contractor('Lawn and garden work is contractor work.'),
  'pool service': {
    license: 'over_threshold',
    authority: 'cslb',
    authority_name: CSLB,
    // Routine service and repair are not the same trade in the eyes of the
    // board, and most pool rounds are the first kind. Saying so keeps the rule
    // from reading as a licence demand for skimming leaves.
    why: 'Cleaning a pool and treating the water is not contractor work. Repair '
      + 'is — equipment, plumbing, resurfacing — and a California contractor\'s '
      + `licence is required once a single repair job is worth more than `
      + `${CONTRACTOR_THRESHOLD_LABEL} in labour and materials together. At or `
      + 'under that you may work without one, but you must state that you are '
      + 'unlicensed wherever you advertise.',
  },

  // --- no state licence generally required ---------------------------------
  'mobile car wash and detailing': NO_STATE_LICENCE,
  'junk removal': NO_STATE_LICENCE,
  'trash can cleaning': NO_STATE_LICENCE,
  'bin cleaning': NO_STATE_LICENCE,
  'window cleaning': NO_STATE_LICENCE,
  'carpet cleaning': NO_STATE_LICENCE,
  'house cleaning': NO_STATE_LICENCE,
  'mobile pet grooming': NO_STATE_LICENCE,
  'mobile notary': noLicence(
    'A notary is commissioned by the California Secretary of State. That is a '
    + 'commission, not a trade licence, and nothing on this page records it. No '
    + 'state trade licence applies to the work itself.',
  ),

  // Was filed here as NO_STATE_LICENCE, which was wrong and is the reason the
  // rule above exists. The Bureau of Household Goods and Services registers
  // service dealers for MAJOR HOME APPLIANCES on the same statute that covers
  // phones -- refrigerators, freezers, washers, dryers, ovens -- and there is
  // no small-operator exemption. Telling an appliance tech they needed nothing
  // was the platform putting a claim in their mouth that the state disagrees
  // with, and they would have found out from a letter.
  'appliance repair': registered(
    'Repairing major home appliances for money in California means registering '
    + 'as a service dealer with the Bureau of Household Goods and Services.'),

  // --- personal care --------------------------------------------------------
  //
  // Mobile hair and barbering is a real, licensed, everyday business in
  // California and this rule exists to record the licence, not to argue about
  // the trade. Whether a given job is done in a licensed mobile unit, in a
  // salon, or on location is the operator's call and their compliance to keep
  // -- the same as it is for every other trade in this file.
  //
  // That is the whole design of this module, stated at the top: NOTHING HERE
  // VERIFIES ANYTHING. It records what a business asserts and shows it with
  // the authority's name beside it so a customer can look the number up. An
  // earlier version of this rule editorialised about where the work may
  // happen, which is not the platform's call to make and is not what a
  // marketplace does.
  'mobile hair salon or barbershop': {
    license: 'required',
    authority: 'bbc',
    authority_name: BBC,
    why: 'Barbering and cosmetology are licensed in California, so add your '
      + 'Board licence number and customers will see it. If you work out of a '
      + 'vehicle, the Board licenses mobile units separately from the '
      + 'individual licence, and a unit works from a permanent base address '
      + 'within about 50 miles of it.',
  },

  // Massage is genuinely mixed and the honest answer says so. CAMTC
  // certification is VOLUNTARY at state level -- it is not a trade licence and
  // nobody is required to hold it to practise -- but a great many California
  // cities require their own permit, and some require CAMTC as the route to
  // it. Writing either "you need a licence" or "you need nothing" here would
  // be wrong for half the people reading it.
  'mobile spa and massage': noLicence(
    'There is no state licence for massage in California. Certification by '
    + 'CAMTC is voluntary and is not required to practise. What is NOT optional '
    + 'is your city: many require their own massage permit, and some will only '
    + 'issue one to a CAMTC-certified practitioner. Check with the city you '
    + 'work in before you take bookings, because that is the rule that will '
    + 'actually be enforced on you.',
  ),

  'mobile makeup artist': noLicence(
    'Makeup artistry on its own is not licensed by the state. The moment the '
    + 'work crosses into skin care -- facials, extractions, peels, lash '
    + 'extensions, anything treating the skin rather than covering it -- it '
    + 'becomes esthetics and needs a Board of Barbering and Cosmetology '
    + 'licence, and the same rule about working outside a licensed '
    + 'establishment applies.',
  ),

  // --- pets -----------------------------------------------------------------
  'mobile veterinary service': {
    license: 'required',
    authority: 'vmb',
    authority_name: VMB,
    why: 'Practising veterinary medicine in California requires a licence from '
      + 'the Veterinary Medical Board, and a mobile clinic must also be '
      + 'registered as a veterinary premises. Grooming and exercise are not '
      + 'veterinary medicine; diagnosis, treatment, vaccination and prescribing '
      + 'are.',
  },
  'mobile dog gym': NO_STATE_LICENCE,

  // --- food and drink -------------------------------------------------------
  //
  // No STATE trade licence, and that phrasing is doing a lot of work: food is
  // one of the most heavily permitted things anybody here will do, but it is
  // permitted by the county health department rather than by a state board, so
  // a rule that only checks state licensing would report "nothing required"
  // and be catastrophically misleading. The requirement is named in full even
  // though this file cannot record it.
  'food trucks': noLicence(
    'There is no state trade licence for this, but do not read that as "no '
    + 'permits". A mobile food facility in California needs a health permit '
    + 'from the county you operate in, a commissary agreement, food handler '
    + 'cards for staff and a manager certification, plus vehicle inspection. '
    + 'Los Angeles County issues its own. Get those before you take bookings.',
  ),
  'coffee and smoothie trucks': noLicence(
    'No state trade licence, but a mobile food facility permit from your county '
    + 'health department, a commissary agreement and food handler cards all '
    + 'apply. Los Angeles County issues its own permit.',
  ),
  'dessert trucks': noLicence(
    'No state trade licence, but a mobile food facility permit from your county '
    + 'health department, a commissary agreement and food handler cards all '
    + 'apply. Los Angeles County issues its own permit.',
  ),
  'mobile bar service': noLicence(
    'No state trade licence for the service itself. Alcohol is different: '
    + 'serving it needs the right ABC licence or a daily event permit, and who '
    + 'holds it depends on whether you are supplying the drink or pouring what '
    + 'the host bought. Alcohol server training is required for anyone pouring. '
    + 'Sort that out per event before you take a booking.',
  ),

  // --- everything else that is genuinely unlicensed --------------------------
  'bike repair service': NO_STATE_LICENCE,
  'tech support': NO_STATE_LICENCE,
  'personal fitness training': noLicence(
    'Personal training is not licensed by the state of California. Certification '
    + 'from a recognised body is what clients and insurers look for rather than '
    + 'anything the state requires.',
  ),
  'mobile photography and photo booths': NO_STATE_LICENCE,
  'tutoring': noLicence(
    'Tutoring is not licensed by the state. Working with children brings its own '
    + 'expectations around background checks, which are between you and the '
    + 'families who hire you.',
  ),
  'fashion boutique trucks': NO_STATE_LICENCE,
  'mobile bookstore': NO_STATE_LICENCE,
  "mobile farmer's market": noLicence(
    'Selling at a certified farmers market means registering with your county '
    + 'agricultural commissioner, and selling prepared food there brings the '
    + 'health permits with it. The stall itself needs no state trade licence.',
  ),

  // --- named in the app, named by none of the rules -------------------------
  'auto glass repair': UNLISTED,
  'dryer vent cleaning': UNLISTED,
  'mobile tyre fitting': UNLISTED,
};

/**
 * What a trade requires.
 *
 * Trade is free text on the operator record, so it is matched case- and
 * whitespace-insensitively, and anything unrecognised gets UNLISTED — 'none',
 * never 'required'.
 */
export function rulesFor(trade: string | null | undefined): TradeRule {
  return TRADE_RULES[(trade ?? '').trim().toLowerCase()] ?? UNLISTED;
}

// ---------------------------------------------------------------------------
// What one business says it holds
// ---------------------------------------------------------------------------

export interface Credentials {
  /** 'cslb' | 'bsis' | 'bar' | 'spcb' | 'none'. NULL means unanswered. */
  license_kind: string | null;
  license_number: string | null;
  license_state: string | null;
  license_expires_at: number | null;
  unlicensed_ack: number;
  insurer: string | null;
  policy_number: string | null;
  insurance_expires_at: number | null;
  insured_ack: number;
}

/**
 * A partial edit. A field left out is left alone; a field set to null is
 * cleared. That difference is the whole point — a form that only shows the
 * licence half must not wipe the insurance half by omission.
 */
export interface CredentialsInput {
  license_kind?: string | null;
  license_number?: string | null;
  license_state?: string | null;
  license_expires_at?: number | null;
  unlicensed_ack?: number | boolean;
  insurer?: string | null;
  policy_number?: string | null;
  insurance_expires_at?: number | null;
  insured_ack?: number | boolean;
}

/** The kinds the UI offers. Unknown text is refused rather than stored. */
export const LICENSE_KINDS = ['cslb', 'bsis', 'bar', 'spcb', 'none'] as const;

/** Only California is open, so this is the only issuer a licence can have. */
export const DEFAULT_LICENSE_STATE = 'CA';

const CREDENTIAL_FIELDS =
  `license_kind, license_number, license_state, license_expires_at, unlicensed_ack,
   insurer, policy_number, insurance_expires_at, insured_ack`;

const trimOrNull = (v: string | null | undefined): string | null =>
  (typeof v === 'string' && v.trim() ? v.trim() : null);

const flag = (v: number | boolean | null | undefined): number =>
  (v === true || v === 1 ? 1 : 0);

/** A date, in the one form that means the same thing in every timezone. */
const dateLabel = (seconds: number): string =>
  new Date(seconds * 1000).toISOString().slice(0, 10);

const row = (r: Credentials): Credentials => ({
  license_kind: r.license_kind ?? null,
  license_number: r.license_number ?? null,
  license_state: r.license_state ?? null,
  license_expires_at: r.license_expires_at ?? null,
  unlicensed_ack: r.unlicensed_ack ? 1 : 0,
  insurer: r.insurer ?? null,
  policy_number: r.policy_number ?? null,
  insurance_expires_at: r.insurance_expires_at ?? null,
  insured_ack: r.insured_ack ? 1 : 0,
});

/**
 * One operator's claim.
 *
 * These columns hang off the operator row, so the operator's own id is the
 * tenant scope, and it is in the WHERE clause of every statement in this file
 * exactly as operator_id is everywhere else. An id belonging to somebody else
 * reads nothing and writes nothing; it does not read their row and fail a check
 * afterwards.
 */
export async function getCredentials(env: Env, operatorId: string): Promise<Credentials> {
  const found = await env.DB.prepare(
    `SELECT ${CREDENTIAL_FIELDS} FROM operators WHERE id = ?`,
  ).bind(operatorId).first<Credentials>();

  if (!found) throw notFound('No such operator.');
  return row(found);
}

/** A number nobody could look up is not a licence number. */
function looksLikeANumber(value: string): boolean {
  const bare = value.replace(/[\s.-]/g, '');
  if (bare.length < 4) return false;
  // Every one of these authorities numbers its licences.
  if (!/\d/.test(bare)) return false;
  // "0000", "1111": a box filled in to get past the box.
  if (/^(.)\1*$/.test(bare)) return false;
  return true;
}

const kindOf = (v: string | null | undefined): string | null => {
  const k = trimOrNull(v)?.toLowerCase() ?? null;
  if (k === null) return null;
  if (!(LICENSE_KINDS as readonly string[]).includes(k)) {
    throw badRequest(`"${v}" is not a licence we know how to record.`, 'bad_license_kind');
  }
  return k;
};

const given = <T>(sent: T | undefined, current: T): T => (sent === undefined ? current : sent);

/**
 * Saves what the operator says they hold.
 *
 * The validation here is about the claim being usable, not about it being
 * true: a licence number nobody can look up and an expiry date that has already
 * passed are both worse than a blank field, because both read as a credential
 * on the public page. Whether the number belongs to this business is not
 * something this platform knows.
 */
export async function saveCredentials(
  env: Env, operatorId: string, input: CredentialsInput,
): Promise<Credentials> {
  const current = await getCredentials(env, operatorId);

  const kind = kindOf(given(input.license_kind, current.license_kind));
  const holdsLicence = kind !== null && kind !== 'none';

  // 'none' clears the number and the date with it. A licence number sitting
  // under "no state licence" is a claim nobody made, and it would still be
  // there to show on a page.
  const number = holdsLicence
    ? trimOrNull(given(input.license_number, current.license_number)) : null;
  const state = holdsLicence
    ? (trimOrNull(given(input.license_state, current.license_state)) ?? DEFAULT_LICENSE_STATE)
    : null;
  const expiresAt = holdsLicence ? given(input.license_expires_at, current.license_expires_at) : null;

  if (holdsLicence && !number) {
    throw badRequest(
      'Enter your licence number, exactly as it is printed on the licence.',
      'license_number_required');
  }
  if (number && !looksLikeANumber(number)) {
    throw badRequest(
      'That does not look like a licence number. Enter it as it is printed on '
      + 'the licence, so a customer can look it up.',
      'bad_license_number');
  }
  if (expiresAt != null && expiresAt < now()) {
    throw badRequest(
      'That licence expiry date has already passed. Enter the date on the '
      + 'licence you hold now.',
      'license_expired');
  }

  const insurer = trimOrNull(given(input.insurer, current.insurer));
  const policyNumber = trimOrNull(given(input.policy_number, current.policy_number));
  const insuranceExpiresAt = given(input.insurance_expires_at, current.insurance_expires_at);

  if (insuranceExpiresAt != null && insuranceExpiresAt < now()) {
    throw badRequest(
      'That insurance expiry date has already passed. Enter the date on the '
      + 'cover you hold now.',
      'insurance_expired');
  }

  // updated_at moves on every save, which is what dates the claim to the day
  // the operator made it.
  await env.DB.prepare(
    `UPDATE operators
        SET license_kind = ?, license_number = ?, license_state = ?,
            license_expires_at = ?, unlicensed_ack = ?,
            insurer = ?, policy_number = ?, insurance_expires_at = ?,
            insured_ack = ?, updated_at = ?
      WHERE id = ?`,
  ).bind(
    kind, number, state, expiresAt ?? null,
    flag(given(input.unlicensed_ack, current.unlicensed_ack)),
    insurer, policyNumber, insuranceExpiresAt ?? null,
    flag(given(input.insured_ack, current.insured_ack)),
    now(), operatorId,
  ).run();

  return getCredentials(env, operatorId);
}

/**
 * Why this profile is not ready to go public, in the operator's own language.
 *
 * Every line is something they can fix, and says how. These are the platform's
 * own rules about what it will list — not a legal opinion, and not a finding
 * about the business. Where the state requires something, the requirement is
 * named along with the authority that set it.
 */
export async function publishBlockers(env: Env, operatorId: string): Promise<string[]> {
  const found = await env.DB.prepare(
    `SELECT trade, ${CREDENTIAL_FIELDS} FROM operators WHERE id = ?`,
  ).bind(operatorId).first<Credentials & { trade: string | null }>();

  if (!found) throw notFound('No such operator.');

  const held = row(found);
  const rule = rulesFor(found.trade);
  const authority = rule.authority_name ?? 'the licensing authority';
  const t = now();

  const hasLicence = Boolean(
    held.license_kind && held.license_kind !== 'none' && held.license_number);
  const licenceExpired = held.license_expires_at != null && held.license_expires_at < t;

  const blockers: string[] = [];

  if (rule.license === 'required' && !hasLicence) {
    blockers.push(
      `This work needs a licence from the ${authority}. Add your licence number `
      + 'before your page goes public.');
  }

  if (rule.license === 'over_threshold' && !hasLicence && held.unlicensed_ack !== 1) {
    blockers.push(
      `A single job over ${CONTRACTOR_THRESHOLD_LABEL} in labour and materials `
      + `needs a licence from the ${authority}. Add your licence number, or `
      + 'confirm that you will advertise as unlicensed and keep every job at or '
      + `under ${CONTRACTOR_THRESHOLD_LABEL}.`);
  }

  if (hasLicence && licenceExpired) {
    blockers.push(
      `The licence you entered expired on ${dateLabel(held.license_expires_at!)}. `
      + 'Add a current one before your page goes public.');
  }

  // Cover lapses on its own, with nobody doing anything, so a policy entered
  // last year can be on a public page today and be worth nothing.
  const insuranceClaimed = Boolean(
    held.insurer || held.policy_number || held.insured_ack === 1
    || held.insurance_expires_at != null);

  if (insuranceClaimed && held.insurance_expires_at != null
      && held.insurance_expires_at < t) {
    blockers.push(
      `The insurance you entered expired on ${dateLabel(held.insurance_expires_at)}. `
      + 'Enter your current cover, or take the old cover off your page.');
  }

  return blockers;
}
