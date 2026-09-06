/**
 * Whether this reader has asked for less movement.
 *
 * Consulted before anything that animates on its own — the map easing to a
 * neighbourhood, the van marker sliding between pings — because those are
 * movements nobody asked for and, for somebody with a vestibular disorder, the
 * reason they turned the setting on. Both of those files had their own copy of
 * this predicate.
 *
 * Read at the moment of the animation rather than subscribed to: the setting
 * changes about once a year and the answer is only ever needed to decide the
 * duration of something starting right now.
 */
export const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined'
  && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
