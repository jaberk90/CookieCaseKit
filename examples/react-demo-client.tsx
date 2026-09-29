import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import SupportPage from './react-page.js';
import { CaseKit } from '../src/react.js';
function ControlledDemo() {
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  return <CaseKit basePath="/_casekit" theme={theme} onThemeChange={setTheme} />;
}
createRoot(document.getElementById('support-root')!).render(
  <StrictMode>
    {location.search.includes('controlled=1') ? (
      <ControlledDemo />
    ) : location.search.includes('bearer=1') ? (
      <CaseKit basePath="/_casekit" getToken={async () => 'demo-token'} />
    ) : (
      <SupportPage />
    )}
  </StrictMode>,
);
