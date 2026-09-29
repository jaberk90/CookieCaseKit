import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import SupportPage from './react-page.js';
createRoot(document.getElementById('support-root')!).render(
  <StrictMode>
    <SupportPage />
  </StrictMode>,
);
