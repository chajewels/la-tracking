import { useEffect, useState } from 'react';
import chaJewelsLogo from '@/assets/cha-jewels-logo.jpeg';

const GOLD = '#D4AF37';
const BG = '#0A0A0A';

const KEYFRAMES = `
@keyframes splash-logo-in {
  from { opacity: 0; transform: scale(0.85); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes splash-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes splash-tagline-in {
  from { opacity: 0; }
  to { opacity: 0.7; }
}
@keyframes splash-line-grow {
  from { width: 0; }
  to { width: 50px; }
}
@keyframes splash-dot-pulse {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1); }
}
`;

interface Props {
  onComplete: () => void;
}

export default function SplashScreen({ onComplete }: Props) {
  const [fadingOut, setFadingOut] = useState(false);
  const [unmounted, setUnmounted] = useState(false);

  useEffect(() => {
    const fadeTimer = setTimeout(() => setFadingOut(true), 2500);
    const unmountTimer = setTimeout(() => {
      setUnmounted(true);
      onComplete();
    }, 3000);
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(unmountTimer);
    };
  }, [onComplete]);

  if (unmounted) return null;

  return (
    <>
      <style>{KEYFRAMES}</style>
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 9999,
          backgroundColor: BG,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: fadingOut ? 0 : 1,
          transition: 'opacity 0.5s ease-out',
          pointerEvents: fadingOut ? 'none' : 'auto',
        }}
      >
        <img
          src={chaJewelsLogo}
          alt="Cha Jewels"
          style={{
            width: '160px',
            height: 'auto',
            opacity: 0,
            animation: 'splash-logo-in 0.8s ease-out 0.2s forwards',
          }}
        />

        <div
          style={{
            color: GOLD,
            fontSize: '13px',
            fontWeight: 300,
            letterSpacing: '0.4em',
            marginTop: '24px',
            opacity: 0,
            animation: 'splash-fade-in 0.6s ease-out 0.6s forwards',
          }}
        >
          CHA JEWELS
        </div>

        <div
          style={{
            width: 0,
            height: '1px',
            backgroundColor: GOLD,
            marginTop: '16px',
            animation: 'splash-line-grow 0.8s ease-out 1s forwards',
          }}
        />

        <div
          style={{
            textAlign: 'center',
            marginTop: '8px',
            opacity: 0,
            animation: 'splash-fade-in 0.8s ease-out 1.2s forwards',
          }}
        >
          <div
            style={{
              color: '#ffffff',
              fontSize: '13px',
              fontStyle: 'italic',
              fontWeight: 300,
              opacity: 0.7,
              letterSpacing: '0.08em',
            }}
          >
            Everyday, Layaway.
          </div>
          <div
            style={{
              color: GOLD,
              fontSize: '13px',
              fontStyle: 'italic',
              fontWeight: 400,
              letterSpacing: '0.08em',
              marginTop: '4px',
            }}
          >
            Cha Jewels All the Way.
          </div>
        </div>

        <div
          style={{
            position: 'absolute',
            bottom: '48px',
            display: 'flex',
            gap: '8px',
          }}
        >
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                backgroundColor: GOLD,
                animation: `splash-dot-pulse 1.4s ease-in-out ${i * 0.2}s infinite`,
              }}
            />
          ))}
        </div>
      </div>
    </>
  );
}
