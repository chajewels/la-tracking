import { useEffect, useState } from 'react';
import chaJewelsLogo from '@/assets/cha-jewels-logo.jpeg';

const KEYFRAMES = `
@keyframes splash-fade-in-up {
  from { opacity: 0; transform: translateY(20px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes splash-dot-cycle {
  0%, 80%, 100% {
    width: 0.375rem;
    background-color: hsl(var(--accent));
  }
  40% {
    width: 1.5rem;
    background-color: hsl(var(--primary));
  }
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
        className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-background"
        style={{
          opacity: fadingOut ? 0 : 1,
          transition: 'opacity 0.5s ease-out',
          pointerEvents: fadingOut ? 'none' : 'auto',
        }}
      >
        <div
          className="rounded-2xl overflow-hidden bg-black p-3"
          style={{
            opacity: 0,
            animation: 'splash-fade-in-up 0.5s ease-out forwards',
          }}
        >
          <img
            src={chaJewelsLogo}
            alt="Cha Jewels"
            style={{
              width: '160px',
              height: 'auto',
              display: 'block',
            }}
          />
        </div>

        <h2
          className="font-display text-3xl font-semibold tracking-tight text-primary mt-6"
          style={{
            opacity: 0,
            animation: 'splash-fade-in-up 0.5s ease-out 0.3s forwards',
          }}
        >
          Cha Jewels
        </h2>

        <div className="w-12 h-px bg-primary/40 my-4" />

        <div
          className="text-center"
          style={{
            opacity: 0,
            animation: 'splash-fade-in-up 0.5s ease-out 0.3s forwards',
          }}
        >
          <p className="font-display text-base font-light tracking-widest text-muted-foreground">
            Everyday, Layaway.
          </p>
          <p className="font-display text-base font-medium tracking-widest text-primary mt-1">
            Cha Jewels All the Way.
          </p>
        </div>

        <div className="absolute bottom-12 flex items-center gap-2">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-1.5 rounded-full"
              style={{
                width: '0.375rem',
                backgroundColor: 'hsl(var(--accent))',
                animation: `splash-dot-cycle 1.4s ease-in-out ${i * 0.2}s infinite`,
              }}
            />
          ))}
        </div>
      </div>
    </>
  );
}
