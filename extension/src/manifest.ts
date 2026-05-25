import { defineManifest } from '@crxjs/vite-plugin';
import pkg from '../package.json';

export default defineManifest({
  manifest_version: 3,
  name: 'Polaris',
  version: pkg.version,
  description: pkg.description,
  side_panel: {
    default_path: 'src/sidepanel/index.html',
  },
  background: {
    service_worker: 'src/background/service_worker.ts',
    type: 'module',
  },
  action: {
    default_title: 'Open Polaris',
  },
  // Permissions:
  //   storage    — chrome.storage.local for hot agent state
  //   sidePanel  — UI surface
  //   alarms     — watchdog tick (1-min interval)
  //   tabs       — tab.open / tab.close / tab.list / tab.wait_loaded (M3)
  //   debugger   — aria.extract via Accessibility.getFullAXTree (M3)
  //   activeTab  — captureVisibleTab consents to whichever tab gains focus
  //                during tab.screenshot (less invasive than <all_urls>)
  permissions: ['storage', 'sidePanel', 'alarms', 'tabs', 'debugger', 'activeTab'],
  host_permissions: ['http://*/*', 'https://*/*'],
  // Explicit CSP — MV3's default is already strict (`script-src 'self';
  // object-src 'self'`) but pinning it here is an audit-trail anchor: any
  // future change to relax it has to walk past this comment. No
  // unsafe-eval, no unsafe-inline, no remote scripts. The MV3 default
  // already forbids these, so this is reaffirming, not changing.
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'self'; base-uri 'self'",
  },
});
