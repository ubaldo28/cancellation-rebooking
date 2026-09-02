import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  BrowserRouter, NavLink, Navigate, Route, Routes, useLocation,
} from 'react-router-dom';
import { api, type Operator } from './api';
import { Icon, Spinner } from './components/ui';
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
  loading: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<Session>({
  operator: null, loading: true, refresh: async () => {}, signOut: async () => {},
});

export const useSession = () => useContext(SessionContext);
export const useOperator = () => useSession().operator;

function SessionProvider({ children }: { children: ReactNode }) {
  const [operator, setOperator] = useState<Operator | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const { operator } = await api.me();
      setOperator(operator);
    } catch {
      setOperator(null);          // 401 is the normal signed-out case
    } finally {
      setLoading(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    try { await api.logout(); } finally { setOperator(null); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <SessionContext.Provider value={{ operator, loading, refresh, signOut }}>
      {children}
    </SessionContext.Provider>
  );
}

// ---------------------------------------------------------------------------
function Nav() {
  const items = [
    { to: '/', label: 'Today', icon: 'clock' as const, end: true },
    { to: '/schedule', label: 'Schedule', icon: 'calendar' as const },
    { to: '/clients', label: 'Clients', icon: 'people' as const },
    { to: '/jobs', label: 'Jobs', icon: 'list' as const },
    { to: '/settings', label: 'Settings', icon: 'cog' as const },
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

function Protected({ children }: { children: ReactNode }) {
  const { operator, loading } = useSession();
  const location = useLocation();
  if (loading) return <Spinner label="Loading" />;
  if (!operator) return <Navigate to="/signin" replace state={{ from: location.pathname }} />;
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
          <Route path="/signin" element={<SignIn />} />
          <Route path="/auth/verify" element={<SignIn />} />
          <Route path="/" element={<Protected><Today /></Protected>} />
          <Route path="/gaps/:gapId" element={<Protected><FillSlot /></Protected>} />
          <Route path="/schedule" element={<Protected><Schedule /></Protected>} />
          <Route path="/clients" element={<Protected><Clients /></Protected>} />
          <Route path="/jobs" element={<Protected><Jobs /></Protected>} />
          <Route path="/settings" element={<Protected><Settings /></Protected>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </SessionProvider>
    </BrowserRouter>
  );
}
