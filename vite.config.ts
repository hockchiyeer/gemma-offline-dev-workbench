import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(() => {
  const disableHmr = process.env.DISABLE_HMR === 'true';

  return {
    plugins: [
      react(),
      tailwindcss(),
      ...(disableHmr
        ? [
            {
              name: 'disable-vite-hmr-ws',
              apply: 'serve' as const,
              enforce: 'post' as const,
              transform(code: string, id: string) {
                if (id.includes('/vite/dist/client/client.mjs')) {
                  return code.replace(
                    'transport.connect(createHMRHandler(handleMessage));',
                    '/* HMR WebSocket disabled via DISABLE_HMR=true */'
                  );
                }
              },
            },
          ]
        : []),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: [
          'icon.svg',
          'apple-touch-icon.png',
          'pwa-192x192.png',
          'pwa-512x512.png',
          'pwa-maskable-512x512.png',
        ],
        manifest: {
          id: '/',
          name: 'GemmaVault — Offline Local Gemma Coding Workbench',
          short_name: 'GemmaVault',
          description:
            'Offline self-sustaining AI coding workbench powered by locally installed Google Gemma models with an encrypted local database for snippets and documentation.',
          categories: ['developer', 'productivity', 'utilities'],
          orientation: 'any',
          lang: 'en',
          theme_color: '#0B1120',
          background_color: '#0B1120',
          display: 'standalone',
          start_url: '/',
          scope: '/',
          icons: [
            {
              src: '/pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/pwa-maskable-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
          cleanupOutdatedCaches: true,
          navigateFallback: 'index.html',
          navigateFallbackDenylist: [/^\/api\//],
        },
        devOptions: {
          enabled: false,
        },
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      target: 'es2022',
    },
    server: {
      ...(disableHmr ? { hmr: false as const, ws: false as const } : {}),
      watch: disableHmr ? null : {},
    },
  };
});
