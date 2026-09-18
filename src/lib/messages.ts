/**
 * Customer-facing copy, per language.
 *
 * Everything in here is read by the operator's CLIENT, not the operator. The
 * language comes from the client's own record where they have one, so a single
 * operator can write to one customer in English and the next in Spanish.
 *
 * THE OFFER COPY NO LONGER DESCRIBES A TEXT MESSAGE, because no text message
 * is sent. An offer now lands in the customer's conversation with that business
 * and is nudged by an email; see the top of ./offers.ts for why that had to
 * change and what the old version cost. The strings below said "Reply STOP to
 * opt out" and "Reply to the text if anything changes" — one an instruction to
 * a carrier that carries nothing for us, the other an instruction to answer a
 * message that was never sent. Both told the customer to do something that
 * could not work, which is worse than saying nothing.
 *
 * The STOP keywords further down are kept as they are. Nothing in the Worker
 * reads them today, they cost nothing, and the day anybody wires up an inbound
 * handler the rule they encode is still true: a Spanish-speaking customer may
 * reply STOP because that is what carriers advertise, or PARE because that is
 * what a message told them, and an unhonoured opt-out is a legal problem.
 */

export type Lang = 'en' | 'es';

export const SUPPORTED_LANGUAGES: Lang[] = ['en', 'es'];

export const isLang = (v: unknown): v is Lang =>
  typeof v === 'string' && (SUPPORTED_LANGUAGES as string[]).includes(v);

/** Resolve the language to write in: the client's, else the operator's, else English. */
export const pickLang = (clientLang: string | null, operatorLang: string | null): Lang =>
  isLang(clientLang) ? clientLang : isLang(operatorLang) ? operatorLang : 'en';

interface Copy {
  /**
   * The offer itself: one line the customer reads in their conversation with
   * the business, and the same line at the top of the email that nudges them.
   *
   * Written as a person speaking, not as a notification, because it arrives in
   * a thread where that business has been answering their questions in the
   * first person. It was the SMS copy and it survives almost unchanged: what
   * it says was always right, it was only ever the channel that did not exist.
   */
  offer: (v: { name: string; business: string; when: string; price: string; service: string; url: string }) => string;

  /** Subject line of the nudge email. The business and the hour, nothing else. */
  offerEmailSubject: (v: { business: string; when: string }) => string;
  /**
   * The three labels down the left of the nudge email.
   *
   * Translated, unlike the identical list in alertEmail, which prints "What /
   * When / Price" in English whatever language the reader has. That is a small
   * wrong thing there and would be a larger one here: an alert is a service a
   * stranger subscribed to in whatever language the site was in, and this is a
   * business writing to a customer whose own language is on their record and
   * whose message above these words is in it.
   */
  offerEmailFacts: { what: string; when: string; price: string };
  /** First line of the nudge email. */
  offerEmailOpening: (v: { name: string; business: string }) => string;
  /**
   * Why this arrived, which an alert does not have to say and this does: an
   * alert was asked for, and an offer was not. Naming the business and the
   * fact that they have booked with them is what tells somebody who has
   * forgotten the job apart from somebody being spammed.
   */
  offerEmailWhy: (v: { business: string }) => string;
  /**
   * The one-click way to stop receiving offers, at the bottom of every one.
   *
   * Replaces `optOut`, which said "Reply STOP" — a carrier instruction on a
   * message no carrier carries. This is a link, it is in every offer email,
   * and it is the only thing that can be done with it: see stopOffersByToken
   * in ./offers.ts.
   */
  stopOffers: (v: { url: string }) => string;

  /**
   * The text a customer gets when they are creating an account or signing in
   * on a new device.
   *
   * Three things it has to do and one it must not. It has to name the site, so
   * that a code arriving out of nowhere is identifiable; it has to say how long
   * the code lasts, so somebody who reads it an hour later knows why it failed;
   * and it has to say what to do if they did not ask for it, because the one
   * person guaranteed to receive an unwanted code is somebody whose number
   * another person typed in. It must NOT carry a link. A sign-in message with a
   * tappable URL in it is the exact shape of the phishing text this product
   * would otherwise be teaching its customers to trust.
   *
   * No opt-out line, unlike the offer above: this is a message the recipient
   * asked for seconds earlier, it is sent once, and there is nothing to
   * unsubscribe from. There is nothing to advertise either -- the inbound
   * handler that read STOP went with the carrier account, and a code is not a
   * mailing list.
   */
  signInCode: (v: { code: string; minutes: number }) => string;

  /** Public offer page. */
  greeting: (name: string) => string;
  hasSlotFree: (business: string) => string;
  yesBookMe: string;
  notThisTime: string;
  firstToConfirm: string;

  bookedTitle: string;
  bookedHeading: string;
  bookedNote: string;

  takenHeading: string;
  takenBody: string;

  declinedHeading: string;
  declinedBody: string;

  expiredHeading: string;
  expiredBody: string;

  invalidHeading: string;
  invalidBody: string;
}

const EN: Copy = {
  offer: ({ name, business, when, price, service, url }) =>
    `Hi ${name}, it's ${business}. I've had a slot open up: ${when}` +
    `${price ? ` — ${price}` : ''}. ${service}. Want it? ${url}`,

  offerEmailSubject: ({ business, when }) => `${business} has ${when} free`,
  offerEmailFacts: { what: 'What', when: 'When', price: 'Price' },
  offerEmailOpening: ({ name, business }) =>
    `Hi ${name} — ${business} has had a slot open up and thought of you.`,
  offerEmailWhy: ({ business }) =>
    `You are getting this because you have booked ${business} through Round The Way. `
    + 'It is only ever about their own spare hours, and only from them.',
  stopOffers: ({ url }) => `Stop these offers: ${url}`,

  signInCode: ({ code, minutes }) =>
    `${code} is your Round The Way code. It lasts ${minutes} minutes and works once. `
    + 'If you did not ask for it, ignore this message and do not pass the code on.',

  greeting: (name) => `Hi ${name}`,
  hasSlotFree: (business) => `${business} has a slot free`,
  yesBookMe: 'Yes, book me in',
  notThisTime: 'Not this time',
  firstToConfirm: 'First to confirm gets the slot.',

  bookedTitle: 'Booked',
  bookedHeading: "You're booked in",
  bookedNote: 'See you then. Message them in the app if anything changes.',

  takenHeading: 'That slot just went',
  takenBody: "Someone confirmed a moment before you. We'll let you know next time one opens up.",

  declinedHeading: 'No problem',
  declinedBody: "We've taken you off this one. You'll hear about the next slot.",

  expiredHeading: 'This offer has expired',
  expiredBody: "Message them in the app if you'd still like the slot.",

  invalidHeading: "This link isn't valid",
  invalidBody: "Check the link they sent you, or message them in the app and we'll sort it out.",
};

const ES: Copy = {
  offer: ({ name, business, when, price, service, url }) =>
    `Hola ${name}, soy ${business}. Se me desocupó un horario: ${when}` +
    `${price ? ` — ${price}` : ''}. ${service}. ¿Lo quieres? ${url}`,

  offerEmailSubject: ({ business, when }) => `${business} tiene libre ${when}`,
  offerEmailFacts: { what: 'Qué', when: 'Cuándo', price: 'Precio' },
  offerEmailOpening: ({ name, business }) =>
    `Hola ${name}: a ${business} se le desocupó un horario y se acordó de ti.`,
  offerEmailWhy: ({ business }) =>
    `Recibes esto porque reservaste con ${business} por medio de Round The Way. `
    + 'Solo se trata de sus propios horarios libres, y solo de parte de ellos.',
  stopOffers: ({ url }) => `Para dejar de recibir estos avisos: ${url}`,

  signInCode: ({ code, minutes }) =>
    `${code} es tu código de Round The Way. Dura ${minutes} minutos y sirve una sola vez. `
    + 'Si no lo pediste, ignora este mensaje y no le des el código a nadie.',

  greeting: (name) => `Hola ${name}`,
  hasSlotFree: (business) => `${business} tiene un horario libre`,
  yesBookMe: 'Sí, apúntame',
  notThisTime: 'Esta vez no',
  firstToConfirm: 'El primero en confirmar se queda con el horario.',

  bookedTitle: 'Confirmado',
  bookedHeading: 'Ya quedaste apuntado',
  bookedNote: 'Nos vemos. Escríbeles por la app si algo cambia.',

  takenHeading: 'Ese horario ya se ocupó',
  takenBody: 'Alguien confirmó justo antes que tú. Te avisamos cuando se abra otro.',

  declinedHeading: 'Sin problema',
  declinedBody: 'Te quitamos de este. Te avisamos del siguiente horario.',

  expiredHeading: 'Esta oferta ya venció',
  expiredBody: 'Escríbeles por la app si todavía quieres el horario.',

  invalidHeading: 'Este enlace no es válido',
  invalidBody: 'Revisa el enlace que te mandaron, o escríbeles por la app y lo resolvemos.',
};

const CATALOG: Record<Lang, Copy> = { en: EN, es: ES };

export const copy = (lang: Lang): Copy => CATALOG[lang] ?? EN;

/**
 * Opt-out keywords, all languages at once.
 *
 * READ BY NOTHING TODAY, and kept anyway. They were checked by an inbound SMS
 * webhook that is gone with the carrier account behind it, and no offer this
 * product sends now invites a keyword reply — stopping offers is a one-click
 * link in the email. What they encode is still true for any future inbound
 * handler: a Spanish-speaking customer may reply STOP because that is what
 * carriers advertise, or PARE because that is what somebody told them, and an
 * unhonoured opt-out is a legal problem rather than a missed message.
 */
export const STOP_WORDS = new Set([
  'STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT',
  'PARE', 'PARAR', 'ALTO', 'BAJA', 'CANCELAR', 'ELIMINAR',
]);

export const START_WORDS = new Set([
  'START', 'UNSTOP', 'YES',
  'EMPEZAR', 'ALTA', 'SI', 'SÍ',
]);
