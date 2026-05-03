import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

// Type matches Chrome's BeforeInstallPromptEvent shape.
// Standardized in WICG but only Chromium browsers fire it
// (iOS Safari requires the user to "Add to Home Screen"
// via the Share sheet — gesture, not event).
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform?: string }>;
}

interface PWAInstallContextValue {
  deferredPrompt: BeforeInstallPromptEvent | null;
  isIOS: boolean;
  clearPrompt: () => void;
}

const PWAInstallContext = createContext<PWAInstallContextValue>({
  deferredPrompt: null,
  isIOS: false,
  clearPrompt: () => {},
});

// PWAInstallProvider must wrap the app root so the
// beforeinstallprompt listener registers on app boot —
// before any splash screen, route, or PIN gate mounts.
//
// This addresses Bug #78: when the listener was inside
// InstallAppBanner, the banner mounted only after
// CustomerPortal's splash (3s) + portal data load + PIN
// gate. Chrome fires beforeinstallprompt within seconds
// of page load, so the event was lost before the listener
// registered. Moving the listener up to App level fixes
// the race.
export function PWAInstallProvider({ children }: { children: ReactNode }) {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isIOS, setIsIOS] = useState(false);

  useEffect(() => {
    // Detect iOS once on mount
    const userAgent = window.navigator.userAgent.toLowerCase();
    setIsIOS(/iphone|ipad|ipod/.test(userAgent));

    // Capture beforeinstallprompt early — before any gates
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);

    return () => {
      window.removeEventListener('beforeinstallprompt', handler);
    };
  }, []);

  const clearPrompt = () => setDeferredPrompt(null);

  return (
    <PWAInstallContext.Provider value={{ deferredPrompt, isIOS, clearPrompt }}>
      {children}
    </PWAInstallContext.Provider>
  );
}

export function usePWAInstall() {
  return useContext(PWAInstallContext);
}
