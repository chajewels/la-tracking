import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { execSync } from "node:child_process";
import { componentTagger } from "lovable-tagger";
import { VitePWA } from "vite-plugin-pwa";
import pkg from "./package.json";

const APP_VERSION = (() => {
  // 1. Try common CI/build commit SHA env vars first — git is usually
  //    unavailable in build environments, but the host typically injects
  //    the commit SHA as an env var.
  const ciSha =
    process.env.COMMIT_REF ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.CF_PAGES_COMMIT_SHA ||
    process.env.GITHUB_SHA;
  if (ciSha) return ciSha.slice(0, 7);

  // 2. Fall back to git rev-parse for local builds.
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    // 3. Final fallback: minute-precision timestamp so consecutive
    //    builds in the same environment remain distinguishable.
    return "dev-" + new Date().toISOString().replace("T", " ").slice(0, 16);
  }
})();

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [
    react(),
    mode === "development" && componentTagger(),
    VitePWA({
      registerType: 'autoUpdate',
      devOptions: { enabled: false },
      includeAssets: ['favicon.ico', 'apple-touch-icon.png'],
      manifest: {
        name: 'Cha Jewels Hub',
        short_name: 'ChaJewels',
        description: 'Cha Jewels Hub',
        theme_color: '#D4AF37',
        background_color: '#000000',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/portal/login',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        cleanupOutdatedCaches: true,
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [
          /\/[^/?]+\.[^/]+$/, // requests for files with extensions (don't redirect to index.html)
        ],
        runtimeCaching: [
          {
            // NetworkFirst for SPA navigations — ensures fresh HTML/bundle
            // on each visit with offline cache fallback. Fixes 404s when
            // the client has stale cached index.html from before new routes
            // were deployed.
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'navigation-cache',
              networkTimeoutSeconds: 3,
              expiration: { maxEntries: 50, maxAgeSeconds: 86400 },
            },
          },
          {
            urlPattern: /^https:\/\/.*\.supabase\.co\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'supabase-cache',
              expiration: { maxEntries: 50, maxAgeSeconds: 300 },
            },
          },
        ],
      },
    }),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  define: {
    __BUILD_TIME__: Date.now(),
    __APP_VERSION__: JSON.stringify(`${pkg.version} · ${APP_VERSION}`),
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-supabase': ['@supabase/supabase-js'],
          'vendor-ui': ['@radix-ui/react-dialog', '@radix-ui/react-alert-dialog',
                        '@radix-ui/react-tabs', '@radix-ui/react-select',
                        '@radix-ui/react-dropdown-menu'],
          'vendor-charts': ['recharts'],
          'vendor-icons': ['lucide-react'],
        },
      },
    },
  },
}));
