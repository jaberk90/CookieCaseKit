'use client';
import { CaseKit } from '../src/react.js'; // Installed app: import from 'cookiecasekit/react'.
// Installed app: import 'cookiecasekit/react.css' in your app's stylesheet entry.

/** Render this component from your application's protected /support React route. */
export default function SupportPage() {
  return <CaseKit basePath="/_casekit" />;
}
