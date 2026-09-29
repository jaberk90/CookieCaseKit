import { readFileSync, writeFileSync } from 'node:fs';
import postcss from 'postcss';
// Share the standalone console design without applying its global rules to the host website.
const root = postcss.parse(readFileSync('public/style.css', 'utf8'));
root.walkRules((rule) => {
  rule.selectors = rule.selectors.map((selector) => {
    let scoped = selector.replace(/:root/g, '.cck').replace(/^body\b/, '.cck');
    scoped = scoped.replace(/^\[data-theme=/, '.cck[data-theme=');
    scoped = scoped.replace(/#([a-z-]+)/g, '.cck-$1');
    return /^\.cck(?:[ .[:#]|$)/.test(scoped) ? scoped : `.cck ${scoped}`;
  });
});
const overrides = `
.cck { position: relative; isolation: isolate; min-height: 760px; width: 100%; color: var(--ink); }
.cck .sidebar { position: absolute; }
.cck .cck-error { padding: 12px 16px; background: var(--paper); border: 1px solid var(--line); border-radius: 6px; color: #a44535; }
.cck[data-theme='dark'] .cck-error { color: #f0a191; }
.cck .cck-notice { padding: 28px; }
.cck .cck-empty { padding: 60px 20px; text-align: center; }
.cck dialog { max-width: calc(100vw - 32px); }
.cck .cck-busy { color: var(--muted); font-size: 12px; }
@media(max-width:760px) { .cck .sidebar { position: static; } .cck { min-height: 600px; } }
`;
writeFileSync('dist/react.css', root.toString() + overrides);
