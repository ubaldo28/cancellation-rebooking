import {
  createContext, Suspense, lazy, useCallback, useContext, useEffect, useRef, useState,
} from 'react';
import type { ReactNode } from 'react';
import {
  BrowserRouter, NavLink, Navigate, Route, Routes, useLocation,
} from 'react-router-dom';
import { api, type Operator } from './api';
import { Icon, Spinner } from './components/ui';
import { startPinging } from './lib/ping';

/**
 * WHAT IS IN THE FIRST DOWNLOAD, AND WHAT IS NOT.
 *
 * Every page below used to be a static import, which is one bundle: a stranger
 * who opened a cost guide from a search result downloaded the operator's
 * dashboard, the card form, the chat and the van tracking before that guide
 * could do anything. 838 kB of JavaScript to read a page about what a job
 * costs, almost none of which that reader will ever run.
 *
 * THE LINE IS DRAWN AT WHAT THE WORKER RENDERS. src/index.ts serves /s/:trade,
 * /cost/:trade, /browse, /browse/:category, /cost and /p/:slug as fully-formed
 * HTML spliced into this app's own #root, and React then clears that markup and
 * draws the page again (see main.tsx). Those routes must therefore be in the
 * first chunk: split one of them out and the visitor watches a complete,
 * painted page blank itself and then wait a round trip for the code to redraw
 * it, which is strictly worse than the flash we already have. The front page
 * and the two server-rendered geography routes are in there for the same
 * reason — they are what a stranger arrives on.
 *
 * EVERYTHING ELSE IS FETCHED WHEN IT IS ASKED FOR. The operator app behind
 * /app is the largest single block of it and nobody reaches it without signing
 * in or pressing "list a business"; the checkout, the guest thread, the alerts,
 * sign-in, search and the policy pages are all one deliberate click away, and a
 * spinner for the length of one request on a click is the ordinary cost of
 * arriving somewhere. Boundary in main.tsx catches a chunk that fails to load,
 * which is what a deploy landing mid-session looks like.
 */
import Discover from './pages/Discover';
import Category from './pages/Category';
import Trade from './pages/Trade';
import CostGuide from './pages/CostGuide';
import Areas from './pages/Areas';
import Metro from './pages/Metro';
import BrowseIndex from './pages/BrowseIndex';
import CostIndex from './pages/CostIndex';
import PublicProfile from './pages/PublicProfile';
// Not split, and it must not be: this is what an unknown URL renders, and a
// chunk request for it would put a spinner in front of "page not found".
import NotFound from './pages/NotFound';

const Join = lazy(() => import('./pages/Join'));
const Bookings = lazy(() => import('./pages/Bookings'));
const GuestThread = lazy(() => import('./pages/GuestThread'));
const Messages = lazy(() => import('./pages/Messages'));
const Book = lazy(() => import('./pages/Book'));
const Credentials = lazy(() => import('./pages/Credentials'));
const PostOpening = lazy(() => import('./pages/PostOpening'));
const Watch = lazy(() => import('./pages/Watch'));
const Profile = lazy(() => import('./pages/Profile'));
const Search = lazy(() => import('./pages/Search'));
const Covered = lazy(() => import('./pages/Covered'));
const Safety = lazy(() => import('./pages/Safety'));
const ForPros = lazy(() => import('./pages/ForPros'));
const About = lazy(() => import('./pages/About'));
const Terms = lazy(() => import('./pages/Terms'));
const Privacy = lazy(() => import('./pages/Privacy'));
const Help = lazy(() => import('./pages/Help'));
const SignIn = lazy(() => import('./pages/SignIn'));
const Account = lazy(() => import('./pages/Account'));
const AccountThread = lazy(() => import('./pages/AccountThread'));
const Today = lazy(() => import('./pages/Today'));
const FillSlot = lazy(() => import('./pages/FillSlot'));
const Schedule = lazy(() => import('./pages/Schedule'));
const Clients = lazy(() => import('./pages/Clients'));
const Jobs = lazy(() => import('./pages/Jobs'));
const Settings = lazy(() => import('./pages/Settings'));

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
interface Session {
  operator: Operator | null;
  /** True when the signed-in account is one of the sample businesses. */
  isDemo: boolean;
  loading: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  /**
   * Drops the local copy of the session without asking the Worker to do
   * anything.
   *
   * For the one case where the session is already gone server-side and there
   * is nothing left to sign out of: closing the account revokes every session
   * and clears the cookie on its own success response, so signOut()'s round
   * trip would be a request made about an account that no longer exists.
   */
  clearSession: () => void;
}

const SessionContext = createContext<Session>({
  operator: null, isDemo: false, loading: true,
  refresh: async () => {}, signOut: async () => {}, clearSession: () => {},
});

export const useSession = () => useContext(SessionContext);
export const useOperator = () => useSession().operator;

function SessionProvider({ children }: { children: ReactNode }) {
  const [operator, setOperator] = useState<Operator | null>(null);
  const [isDemo, setIsDemo] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const { operator, is_demo } = await api.me();
      setOperator(operator);
      setIsDemo(Boolean(is_demo));
    } catch {
      setOperator(null);          // 401 is the normal signed-out case
      setIsDemo(false);
    } finally {
      setLoading(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    try { await api.logout(); } finally { setOperator(null); setIsDemo(false); }
  }, []);

  const clearSession = useCallback(() => { setOperator(null); setIsDemo(false); }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <SessionContext.Provider
      value={{ operator, isDemo, loading, refresh, signOut, clearSession }}>
      {children}
    </SessionContext.Provider>
  );
}

// ---------------------------------------------------------------------------
function Nav() {
  const items = [
    { to: '/app', label: 'Today', icon: 'clock' as const, end: true },
    { to: '/app/messages', label: 'Messages', icon: 'chat' as const },
    { to: '/app/schedule', label: 'Schedule', icon: 'calendar' as const },
    { to: '/app/clients', label: 'Clients', icon: 'people' as const },
    { to: '/app/settings', label: 'Settings', icon: 'cog' as const },
  ];
  return (
    <nav className="nav">
      {items.map((i) => (
        <NavLink key={i.to} to={i.to} end={i.end}
          className={({ isActive }) => (isActive ? 'active' : undefined)}>
          {({ isActive }) => (
            <>
              <Icon name={i.icon} size={21} stroke={isActive ? 1.95 : 1.7} />
              <span>{i.label}</span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

/**
 * The operator app.
 *
 * Nobody is asked to sign in to look around. Arriving here without a session
 * opens the sample business instead, so the whole product can be seen — and
 * shown to someone else — without an account existing. A real sign-in is only
 * needed to own an account, not to see one.
 */
function Protected({ children }: { children: ReactNode }) {
  const { operator, loading, refresh } = useSession();

  // Position goes up only while an operator who opted in has the app open.
  useEffect(() => {
    if (operator?.share_location !== 1) return;
    return startPinging();
  }, [operator?.share_location]);

  const location = useLocation();
  const [opening, setOpening] = useState(false);
  const [noDemo, setNoDemo] = useState(false);

  /**
   * The sample business is opened at most once per visit to this shell.
   *
   * Without the ref this was a loop rather than a fallback: `opening` is in the
   * effect's own dependencies, so the moment it went back to false the effect
   * ran again — and any outcome that leaves no operator behind (startDemo
   * succeeds but the /me that follows it does not) sent another POST, and
   * another, until the Worker's rate limiter refused one. What the operator saw
   * was "Opening the app…" forever with a request every few hundred
   * milliseconds behind it. One attempt, and a failure is a failure.
   */
  const demoTried = useRef(false);

  useEffect(() => {
    if (loading || operator || opening || noDemo || demoTried.current) return;
    demoTried.current = true;
    setOpening(true);
    api.startDemo()
      .then(() => refresh())
      .catch(() => setNoDemo(true))
      .finally(() => setOpening(false));
  }, [loading, operator, opening, noDemo, refresh]);

  // A demo that started but left nobody signed in is the same dead end as one
  // that was refused, and it must land on the page that can do something about
  // it rather than on a spinner nothing will ever resolve.
  useEffect(() => {
    if (!loading && !opening && !operator && demoTried.current) setNoDemo(true);
  }, [loading, opening, operator]);

  if (loading || opening) return <Spinner label="Opening the app" />;
  // Only if the sample business is unavailable does anyone see a sign-in page.
  if (!operator) {
    return noDemo
      ? <Navigate to="/signin" replace state={{ from: location.pathname }} />
      : <Spinner label="Opening the app" />;
  }
  return (
    <div className="app">
      {children}
      <Nav />
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        {/*
          One boundary around the whole table rather than one per split route.
          A route is either already downloaded, in which case this never draws,
          or it is a single request away — and the honest thing to show for the
          length of that request is the same "loading" the app shows for every
          other request it makes. Per-route wrappers would be twenty-five copies
          of this line, each of which could be forgotten.
        */}
        <Suspense fallback={<Spinner label="Loading" />}>
          <Routes>
            {/* The front door is the map. A stranger has to see what this is
                before anything asks them to sign in. */}
            <Route path="/" element={<Discover />} />
            <Route path="/join" element={<Join />} />
            <Route path="/p/:slug" element={<PublicProfile />} />
            {/* THE THREE BROWSE LEVELS, the way the reference marketplace
                arranges them. The front page shows categories; a category shows
                its trades; a trade gets its own page with the openings in it,
                the questions people ask about it, and what it currently costs.
                Before this, all three levels were piled onto the front page at
                once and it read as a database dump. */}
            <Route path="/browse" element={<BrowseIndex />} />
            <Route path="/browse/:category" element={<Category />} />
            <Route path="/s/:trade" element={<Trade />} />
            <Route path="/cost" element={<CostIndex />} />
            <Route path="/cost/:trade" element={<CostGuide />} />
            {/*
              /near AND EVERY METRO PAGE MUST EXIST HERE EVEN THOUGH THE WORKER
              RENDERS THEM — and so must /p/:slug, /browse/:category, /s/:trade
              and /cost/:trade above, for the same reason. Every one of those is
              in WORKER_PATHS in src/index.ts and arrives as server-rendered
              HTML; the Worker splices it into this app's own #root and React
              then mounts over it. Without a matching route the catch-all below
              would send the visitor to the front page a fraction of a second
              after the page they asked for had already been drawn — the
              server-rendered page would appear and then vanish. That is exactly
              what /santa-maria did while the only metro route here was a
              literal '/los-angeles'.
            */}
            <Route path="/near" element={<Areas />} />
            {/* The pages the footer links to. Every one of these was an inert
                grey word until the page behind it existed. */}
            <Route path="/covered" element={<Covered />} />
            <Route path="/safety" element={<Safety />} />
            <Route path="/pros" element={<ForPros />} />
            <Route path="/about" element={<About />} />
            <Route path="/terms" element={<Terms />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/help" element={<Help />} />
            {/* Where the header's search box lands. It is on every page, so this
                route has to exist for the box to be anything other than
                decoration. */}
            <Route path="/search" element={<Search />} />
            {/* The customer's whole relationship with the business: their
                confirmation, their conversation, and their only way back. */}
            <Route path="/book/:gapId" element={<Book />} />
            <Route path="/c/:token" element={<GuestThread />} />
            {/* Standing alerts. /a creates one; /a/:token manages it. */}
            <Route path="/a" element={<Watch />} />
            <Route path="/a/:token" element={<Watch />} />
            <Route path="/signin" element={<SignIn />} />
            <Route path="/auth/verify" element={<SignIn />} />
            {/* The customer's own door, and a different one from /signin above.
                Both sides sign in with an email address since migration 0038, and
                the two are still separate accounts in separate tables: a business
                gets a link emailed to it, a customer gets a six-digit code.
                Signed out this is that sign-in; signed in it is their bookings,
                their card and the two ways of getting rid of the account. */}
            <Route path="/account" element={<Account />} />
            {/* One of their conversations, opened on the account rather than
                on the /c/:token link — the same page component either way, so
                the money logic on it exists once. See AccountThread.tsx for
                what the dead end was before this route existed, and note that
                /account/messages/:id has to be in SPA_PATHS in src/index.ts
                or the Worker restamps its shell as a 404. */}
            <Route path="/account/messages/:id" element={<AccountThread />} />
            <Route path="/app" element={<Protected><Today /></Protected>} />
            <Route path="/app/gaps/:gapId" element={<Protected><FillSlot /></Protected>} />
            <Route path="/app/schedule" element={<Protected><Schedule /></Protected>} />
            <Route path="/app/clients" element={<Protected><Clients /></Protected>} />
            <Route path="/app/jobs" element={<Protected><Jobs /></Protected>} />
            <Route path="/app/settings" element={<Protected><Settings /></Protected>} />
            <Route path="/app/profile" element={<Protected><Profile /></Protected>} />
            <Route path="/app/bookings" element={<Protected><Bookings /></Protected>} />
            <Route path="/app/messages" element={<Protected><Messages /></Protected>} />
            <Route path="/app/post" element={<Protected><PostOpening /></Protected>} />
            <Route path="/app/credentials" element={<Protected><Credentials /></Protected>} />
            {/*
              THE METRO PAGES, as one parameterised route rather than one line
              per place.

              A literal route per metro is what has to be remembered — and was
              not — the next time the product opens somewhere: /santa-maria was
              server-rendered, complete and correct, and this app threw it away a
              fraction of a second later because the only metro listed here was
              Los Angeles. Reading the slug instead means the Worker's list in
              src/lib/metros.ts is the only place a new place is declared, and
              Metro.tsx resolves the slug against that same list over
              /api/public/metros.

              It is last, and after every literal route above it, because it
              matches any single segment. React Router ranks a static segment
              above a dynamic one, so /about and /near still reach their own
              pages; a segment that is no metro at all reaches Metro, which
              renders the same not-found page the catch-all below does.
            */}
            <Route path="/:metro" element={<Metro />} />
            {/*
              AN ADDRESS WITH NOTHING BEHIND IT SAYS SO, AND STAYS PUT.

              This was `<Navigate to="/" replace />`: a client-side redirect to
              the front page, on top of the 200 the assets binding had already
              sent. Google documents exactly that pair — a successful response for
              a URL that does not exist, which then becomes a different page — as
              a soft 404, and it costs twice: the dead URL is judged as a
              duplicate of the front page, and the front page collects a crowd of
              addresses that are not it. It was also a lie to the reader, who
              mistyped one character and was put on the home page with nothing
              anywhere saying that what they asked for was not found.

              The status code is still a 200 and cannot be fixed from here — it
              is decided in src/index.ts and by the assets binding behind it.
              NotFound asks for noindex, which is the part a browser can do.
            */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </SessionProvider>
    </BrowserRouter>
  );
}
