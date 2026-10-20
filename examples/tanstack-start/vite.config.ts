import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 3000 matches the default ORIGIN in src/lib/helpdesk.server.ts, which the
// helpdesk checks mutations against.
export default defineConfig({
  server: { port: 3000 },
  preview: { port: 3000 },
  plugins: [tanstackStart(), viteReact()],
});
