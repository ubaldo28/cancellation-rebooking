import { useMetros } from '../lib/metros';

/**
 * "· Los Angeles · Santa Maria" — the tail of a "where this is open" line.
 *
 * The pages that count openings across the whole site end their geography
 * section with a way up to the neighbourhood index, and the server-rendered
 * versions of those same pages put every metro beside it. This is that run of
 * links, in one place, so a page carrying it is not a page that has to be
 * edited when the product opens somewhere new.
 *
 * Plain anchors: the metro pages are server-rendered by the Worker, and a
 * client-side navigation would throw that rendered page away and rebuild it
 * from the API for no gain.
 *
 * Nothing at all until the records arrive, which is the right silence: the
 * link before this one already goes somewhere useful, and a separator with no
 * name after it is worse than no separator.
 */
export default function MetroLinks() {
  const metros = useMetros();
  return (
    <>
      {metros.map((m) => (
        <span key={m.slug}>{' · '}<a href={m.path}>{m.name}</a></span>
      ))}
    </>
  );
}
