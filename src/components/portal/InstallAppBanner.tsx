import { useEffect, useState } from 'react';
import { Download, X } from 'lucide-react';

const DISMISSED_KEY = 'cha_install_banner_dismissed';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

interface InstallAppBannerProps {
  // Parent gates this — typically: account.invoice_number
  // begins with "TEST-" so production customers never see it.
  show: boolean;
}

// PWA install banner. Listens for beforeinstallprompt on
// Chrome / Edge / Android; renders iOS-specific instructions
// on iOS Safari (which does not fire beforeinstallprompt and
// requires the user to "Add to Home Screen" via Share sheet).
//
// Greenfield rebuild after Bug #65 cleanup (commit 63ffb16
// removed the prior banner UI and its dynamic-manifest
// helper). Now gated to TEST-% accounts only so production
// customers do not see it until manifest start_url change
// in Step 3b-3 has been verified.
export function InstallAppBanner({ show }: InstallAppBannerProps) {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isIOS, setIsIOS] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED_KEY) === 'true';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    const userAgent = window.navigator.userAgent.toLowerCase();
    setIsIOS(/iphone|ipad|ipod/.test(userAgent));

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);

    return () => {
      window.removeEventListener('beforeinstallprompt', handler);
    };
  }, []);

  if (!show || dismissed) return null;
  if (!deferredPrompt && !isIOS) return null;

  const handleInstall = async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      handleDismiss();
    }
  };

  const handleDismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, 'true');
    } catch {
      // localStorage unavailable — non-fatal
    }
    setDismissed(true);
  };

  return (
    <div className="bg-primary/10 border border-primary/30 rounded-lg p-4 mb-4 flex items-center justify-between gap-4">
      <div className="flex items-center gap-3 flex-1">
        <Download className="h-5 w-5 text-primary flex-shrink-0" />
        <div className="text-sm">
          {isIOS ? (
            <span>
              Install this app: tap the Share button below, then{' '}
              <strong>Add to Home Screen</strong>.
            </span>
          ) : (
            <span>Install this app for faster access on your home screen.</span>
          )}
        </div>
      </div>

      {!isIOS && deferredPrompt && (
        <button
          onClick={handleInstall}
          className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm font-medium hover:bg-primary/90"
        >
          Install
        </button>
      )}

      <button
        onClick={handleDismiss}
        className="text-muted-foreground hover:text-foreground"
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
