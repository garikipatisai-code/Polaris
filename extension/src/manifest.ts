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
  permissions: ['storage', 'sidePanel'],
  host_permissions: ['http://*/*', 'https://*/*'],
});
