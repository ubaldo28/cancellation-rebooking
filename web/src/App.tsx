import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  BrowserRouter, NavLink, Navigate, Route, Routes, useLocation,
} from 'react-router-dom';
import { api, type Operator } from './api';
import { Icon, Spinner } from './components/ui';
import { startPinging } from './lib/ping';
import Discover from './pages/Discover';
import Join from './pages/Join';
import Bookings from './pages/Bookings';
import GuestThread from './pages/GuestThread';
import Messages from './pages/Messages';
import Book from './pages/Book';
import Credentials from './pages/Credentials';
import PostOpening from './pages/PostOpening';
import Watch from './pages/Watch';
import Profile from './pages/Profile';
import Category from './pages/Category';
import Trade from './pages/Trade';
import CostGuide from './pages/CostGuide';
import Search from './pages/Search';
import Areas from './pages/Areas';
import Metro from './pages/Metro';
import BrowseIndex from './pages/BrowseIndex';
import CostIndex from './pages/CostIndex';
import Covered from './pages/Covered';
import Safety from './pages/Safety';
import ForPros from './pages/ForPros';
import About from './pages/About';
import Terms from './pages/Terms';
import Privacy from './pages/Privacy';
import Help from './pages/Help';
import PublicProfile from './pages/PublicProfile';
import SignIn from './pages/SignIn';
import Today from './pages/Today';
import FillSlot from './pages/FillSlot';
import Schedule from './pages/Schedule';
import Clients from './pages/Clients';
import Jobs from './pages/Jobs';
import Settings from './pages/Settings';

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
    { to: '/app/messages', label: 'Messages', icon: 'list' as const },
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

  useEffect(() => {
    if (loading || operator || opening || noDemo) return;
    setOpening(true);
    api.startDemo()
      .then(() => refresh())
      .catch(() => setNoDemo(true))
      .finally(() => setOpening(false));
  }, [loading, operator, opening, noDemo, refresh]);

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
            /near and /los-angeles MUST EXIST HERE EVEN THOUGH THE WORKER
            RENDERS THEM — and so must /p/:slug, /browse/:category, /s/:trade
            and /cost/:trade above, for the same reason. Every one of those is
            in WORKER_PATHS in src/index.ts and arrives as server-rendered
            HTML; the Worker splices it into this app's own #root and React
            then mounts over it. Without a matching route the catch-all below
            would send the visitor to the front page a fraction of a second
            after the page they asked for had already been drawn — the
            server-rendered page would appear and then vanish.
          */}
          <Route path="/near" element={<Areas />} />
          <Route path="/los-angeles" element={<Metro />} />
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
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </SessionProvider>
    </BrowserRouter>
  );
}
