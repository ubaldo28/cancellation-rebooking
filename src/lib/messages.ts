/**
 * Customer-facing copy, per language.
 *
 * Everything in here is read by the operator's CLIENT, not the operator. The
 * language comes from the client's own record where they have one, so a single
 * operator can text one customer in English and the next in Spanish.
 *
 * The opt-out keyword matters legally, and carriers recognise the English
 * STOP everywhere — so Spanish copy says PARE but the inbound handler accepts
 * both. Never translate the keyword without also accepting the original.
 */

export type Lang = 'en' | 'es';

export const SUPPORTED_LANGUAGES: Lang[] = ['en', 'es'];

export const isLang = (v: unknown): v is Lang =>
  typeof v === 'string' && (SUPPORTED_LANGUAGES as string[]).includes(v);

/** Resolve the language to write in: the client's, else the operator's, else English. */
export const pickLang = (clientLang: string | null, operatorLang: string | null): Lang =>
  isLang(clientLang) ? clientLang : isLang(operatorLang) ? operatorLang : 'en';

interface Copy {
  /** The offer SMS. */
  sms: (v: { name: string; business: string; when: string; price: string; service: string; url: string }) => string;
  optOut: string;

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
   * No opt-out line, unlike the offer message above: this is a message the
   * recipient asked for seconds earlier, it is sent once, and there is nothing
   * to unsubscribe from. STOP still works at the carrier and in our inbound
   * handler; advertising it here would only make the code longer.
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
  sms: ({ name, business, when, price, service, url }) =>
    `Hi ${name}, it's ${business}. I've had a slot open up: ${when}` +
    `${price ? ` — ${price}` : ''}. ${service}. Want it? ${url}`,
  optOut: 'Reply STOP to opt out.',

  signInCode: ({ code, minutes }) =>
    `${code} is your Slotfill code. It lasts ${minutes} minutes and works once. `
    + 'If you did not ask for it, ignore this message and do not pass the code on.',

  greeting: (name) => `Hi ${name}`,
  hasSlotFree: (business) => `${business} has a slot free`,
  yesBookMe: 'Yes, book me in',
  notThisTime: 'Not this time',
  firstToConfirm: 'First to confirm gets the slot.',

  bookedTitle: 'Booked',
  bookedHeading: "You're booked in",
  bookedNote: 'See you then. Reply to the text if anything changes.',

  takenHeading: 'That slot just went',
  takenBody: "Someone confirmed a moment before you. We'll let you know next time one opens up.",

  declinedHeading: 'No problem',
  declinedBody: "We've taken you off this one. You'll hear about the next slot.",

  expiredHeading: 'This offer has expired',
  expiredBody: "Reply to the text if you'd still like the slot.",

  invalidHeading: "This link isn't valid",
  invalidBody: "Check the text message, or reply to it and we'll sort it out.",
};

const ES: Copy = {
  sms: ({ name, business, when, price, service, url }) =>
    `Hola ${name}, soy ${business}. Se me desocupó un horario: ${when}` +
    `${price ? ` — ${price}` : ''}. ${service}. ¿Lo quieres? ${url}`,
  optOut: 'Responde PARE o STOP para no recibir más mensajes.',

  signInCode: ({ code, minutes }) =>
    `${code} es tu código de Slotfill. Dura ${minutes} minutos y sirve una sola vez. `
    + 'Si no lo pediste, ignora este mensaje y no le des el código a nadie.',

  greeting: (name) => `Hola ${name}`,
  hasSlotFree: (business) => `${business} tiene un horario libre`,
  yesBookMe: 'Sí, apúntame',
  notThisTime: 'Esta vez no',
  firstToConfirm: 'El primero en confirmar se queda con el horario.',

  bookedTitle: 'Confirmado',
  bookedHeading: 'Ya quedaste apuntado',
  bookedNote: 'Nos vemos. Responde al mensaje si algo cambia.',

  takenHeading: 'Ese horario ya se ocupó',
  takenBody: 'Alguien confirmó justo antes que tú. Te avisamos cuando se abra otro.',

  declinedHeading: 'Sin problema',
  declinedBody: 'Te quitamos de este. Te avisamos del siguiente horario.',

  expiredHeading: 'Esta oferta ya venció',
  expiredBody: 'Responde al mensaje si todavía quieres el horario.',

  invalidHeading: 'Este enlace no es válido',
  invalidBody: 'Revisa el mensaje de texto, o respóndelo y lo resolvemos.',
};

const CATALOG: Record<Lang, Copy> = { en: EN, es: ES };

export const copy = (lang: Lang): Copy => CATALOG[lang] ?? EN;

/**
 * Opt-out keywords, all languages at once.
 *
 * A Spanish-speaking client may reply STOP because that is what carriers
 * advertise, or PARE because that is what our message told them. Both must
 * work — an unhonoured opt-out is the operator's legal problem, not ours.
 */
export const STOP_WORDS = new Set([
  'STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT',
  'PARE', 'PARAR', 'ALTO', 'BAJA', 'CANCELAR', 'ELIMINAR',
]);

export const START_WORDS = new Set([
  'START', 'UNSTOP', 'YES',
  'EMPEZAR', 'ALTA', 'SI', 'SÍ',
]);
