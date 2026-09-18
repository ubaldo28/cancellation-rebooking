import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import Boundary from './components/Boundary';
import './styles.css';

/**
 * THIS LINE DELETES THE SERVER-RENDERED PAGE, ON PURPOSE, AND THAT IS A DEBT
 * EVERY ROUTE THE WORKER RENDERS INTO HAS TO PAY BACK.
 *
 * `createRoot().render()` empties its container before it draws anything. The
 * container here is #root, and on six URL shapes — /s/:trade, /cost/:trade,
 * /browse, /browse/:category, /cost and /p/:slug — the Worker has already put
 * a complete, readable copy of the page inside it, structured data and all
 * (`intoShell` in src/lib/seo.ts). So the first thing this bundle does on
 * those pages is throw that copy away.
 *
 * WHY NOT `hydrateRoot`. Hydration is React adopting markup React produced.
 * The Worker's markup is not React's: it is a different tree, from a different
 * renderer, in a different language, and it is deliberately not a copy of what
 * these components emit — it is a stylesheet-scoped, script-free page written
 * to be read by something that runs no JavaScript at all. Handing it to
 * `hydrateRoot` does not preserve it; it produces a mismatch and React throws
 * the markup away anyway, only noisily and after doing more work.
 *
 * WHY NOT LIFT THE SERVER'S JSON-LD OUT OF #ROOT AND INTO THE HEAD, which is
 * the other obvious rescue. Because the React pages emit their own. Trade.tsx
 * and CostGuide.tsx each publish a FAQPage, every public page publishes a
 * BreadcrumbList through Crumbs, and a saved copy of the server's graph
 * alongside them would put two FAQPage nodes and two BreadcrumbList nodes on
 * one document — which is worse than publishing one, because a search engine
 * reading two answers to "what is this page" is entitled to trust neither. The
 * Worker knows this and places the block inside #root for precisely that
 * reason; test/seo-pages.test.ts pins it there.
 *
 * SO THE BARGAIN IS: the server block is the page for anything that does not
 * run scripts, this app is the page for everything that does, and the app owes
 * the server block's structured data back on every route the Worker renders
 * into. That is not automatic and nothing enforces it — it is a rule, and it
 * is this one:
 *
 *   A ROUTE LISTED IN WORKER_PATHS MUST EMIT THE STRUCTURED DATA THE WORKER
 *   EMITS FOR IT. Break it and the page keeps working, looks right, and
 *   silently loses its rich results.
 *
 * Where that stands today: Trade.tsx and CostGuide.tsx emit FAQPage,
 * BrowseIndex.tsx emits its own graph, Crumbs emits the BreadcrumbList on all
 * six, and PublicProfile.tsx now emits the Product/LocalBusiness node and its
 * AggregateRating — which it did not, so /p/:slug, the one page on this site
 * with stars to win in a search result, published them in the first response
 * and deleted them a moment later.
 *
 * Boundary is outside App on purpose: a throw from the router itself, or from
 * the session provider that wraps every route, has to be caught by something
 * that is not inside either of them. See Boundary.tsx.
 */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Boundary>
      <App />
    </Boundary>
  </StrictMode>,
);
