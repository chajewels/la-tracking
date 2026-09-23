// Imported into the generated service worker (vite.config.ts →
// workbox.importScripts). F02 / #295.
//
// Devices that ran a build before 2026-09-23 still hold a 'supabase-cache'
// Cache Storage bucket containing authenticated PostgREST responses keyed on
// URL alone. Removing the runtimeCaching rule stops NEW writes but does not
// evict what is already there, and Workbox's cleanupOutdatedCaches only
// prunes its own precaches. So delete that one cache by name on activation.
//
// Scoped deliberately: exactly one caches.delete, for one hardcoded name.
// It must never iterate caches.keys() — 'navigation-cache', the precache and
// anything another script owns are not ours to drop.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.delete('supabase-cache').catch(() => {
      // Absent, or Cache Storage unavailable — nothing to do either way.
    }),
  );
});
