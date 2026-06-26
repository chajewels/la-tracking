import { createRoot } from "react-dom/client";
import { HelmetProvider } from "react-helmet-async";
import { registerSW } from 'virtual:pwa-register';
import App from "./App.tsx";
import { setUpdateSW } from './lib/pwaUpdate';
import "./index.css";

// Unregister any service worker inside Lovable preview / iframe contexts.
// The PWA SW caches index.html and bundles, causing the preview to serve
// stale code after deploys. Production (portal.chajewelsjp.com,
// app.chajewelsjp.com) is unaffected.
const isInIframe = (() => {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
})();

const isPreviewHost =
  window.location.hostname.includes("lovableproject.com") ||
  window.location.hostname.includes("lovable.app") ||
  window.location.hostname.includes("id-preview--");

if (isPreviewHost || isInIframe) {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.getRegistrations().then((regs) => {
      regs.forEach((r) => r.unregister());
    });
    caches?.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
  }
}

// Stale-chunk recovery — fires when a dynamic import (lazy route) can't
// preload because the hashed asset URL the running bundle expects has
// been replaced by a newer deploy. Time-gated so a single reload that
// doesn't fix the underlying problem cannot infinite-loop.
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  const key = "chunk-reload-ts";
  const last = Number(sessionStorage.getItem(key) ?? 0);
  const now = Date.now();
  if (!last || now - last > 10_000) {
    sessionStorage.setItem(key, String(now));
    window.location.reload();
  }
});

const updateSW = registerSW({
  onNeedRefresh() {
    window.dispatchEvent(new CustomEvent('pwa:need-refresh'));
  },
  onOfflineReady() {},
});
setUpdateSW(updateSW);

createRoot(document.getElementById("root")!).render(
  <HelmetProvider>
    <App />
  </HelmetProvider>
);
