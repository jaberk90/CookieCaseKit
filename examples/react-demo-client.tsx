import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import SupportPage from './react-page.js';
import { CaseKit } from '../src/react.js';
createRoot(document.getElementById('support-root')!).render(
  <StrictMode>
    {location.search.includes('bearer=1') ? (
      <CaseKit basePath="/_casekit" getToken={async () => 'demo-token'} />
    ) : (
      <SupportPage />
    )}
  </StrictMode>,
);
