import { useState } from 'react';
import { Download, X } from 'lucide-react';
import { usePWAInstall } from '@/contexts/PWAInstallContext';

const DISMISSED_KEY = 'cha_install_banner_dismissed';

interface InstallAppBannerProps {
  // Parent gates this — typically: account.invoice_number
  // begins with "TEST-" so production customers never see it.
  show: boolean;
}

// PWA install banner. Reads the captured beforeinstallprompt
// event from PWAInstallContext (registered at App root).
// On iOS Safari renders instructional text instead of a
// button, since iOS does not fire beforeinstallprompt and
// the user must "Add to Home Screen" via the Share sheet.
//
// Bug #78: previously this component owned its own
// beforeinstallprompt listener via useEffect, which only
// registered after the banner mounted — too late, since
// CustomerPortal's splash + load + PIN gate delays mount
// for many seconds while Chrome fires the event almost
// immediately. Listener was moved to PWAInstallProvider
// at App root to capture the event on app boot.
export function InstallAppBanner({ show }: InstallAppBannerProps) {
  const { deferredPrompt, isIOS, clearPrompt } = usePWAInstall();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED_KEY) === 'true';
    } catch {
      return false;
    }
  });

  if (!show || dismissed) return null;
  if (!deferredPrompt && !isIOS) return null;

  const handleInstall = async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      clearPrompt();
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
