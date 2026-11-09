import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { AppErrorBoundary } from '@/components/AppErrorBoundary';
import './index.css';

// The boundary wraps App rather than living inside it: App, AppShell, and the
// auth controller are themselves capable of throwing, and a boundary nested
// below them could not catch those failures.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
