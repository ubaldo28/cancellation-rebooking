import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import Boundary from './components/Boundary';
import './styles.css';

// Boundary is outside App on purpose: a throw from the router itself, or from
// the session provider that wraps every route, has to be caught by something
// that is not inside either of them. See Boundary.tsx.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Boundary>
      <App />
    </Boundary>
  </StrictMode>,
);
