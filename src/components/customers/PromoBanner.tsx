import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

interface Promo {
  id: string;
  title: string;
  description: string | null;
  media_url: string | null;
  media_type: 'image' | 'video' | null;
  link_url: string | null;
  display_order: number;
}

const ROTATE_MS = 5000;

export default function PromoBanner() {
  const [promos, setPromos] = useState<Promo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch active promos once on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await (supabase.from('promotions' as any) as any)
          .select('id, title, description, media_url, media_type, link_url, display_order')
          .eq('is_active', true)
          .order('display_order', { ascending: true });
        if (cancelled) return;
        if (!error && Array.isArray(data)) {
          setPromos(data as Promo[]);
        }
      } catch {
        /* swallow — banner just hides on error */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Auto-rotate
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (paused || promos.length < 2) return;
    timerRef.current = setTimeout(() => {
      setIndex(i => (i + 1) % promos.length);
    }, ROTATE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [index, paused, promos.length]);

  if (!loaded || promos.length === 0) return null;

  const go = (next: number) => {
    const n = promos.length;
    setIndex(((next % n) + n) % n);
  };

  return (
    <div
      className="relative w-full overflow-hidden rounded-lg shadow-md bg-black/5"
      style={{ maxHeight: 300 }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div
        className="flex transition-transform duration-500 ease-in-out"
        style={{ transform: `translateX(-${index * 100}%)` }}
      >
        {promos.map(p => (
          <div key={p.id} className="relative w-full flex-shrink-0" style={{ flexBasis: '100%' }}>
            <div
              className="relative w-full bg-black"
              style={{ height: 300, maxHeight: 300 }}
            >
              {p.media_type === 'video' && p.media_url ? (
                <video
                  src={p.media_url}
                  className="absolute inset-0 h-full w-full object-cover"
                  autoPlay
                  muted
                  loop
                  playsInline
                />
              ) : p.media_type === 'image' && p.media_url ? (
                <img
                  src={p.media_url}
                  alt={p.title}
                  className="absolute inset-0 h-full w-full object-cover"
                />
              ) : null}

              {/* Gradient overlay for legibility */}
              <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />

              {/* Text + CTA */}
              <div className="absolute inset-x-0 bottom-0 p-4 sm:p-6 text-white">
                <h3 className="text-lg sm:text-2xl font-bold drop-shadow">{p.title}</h3>
                {p.description && (
                  <p className="mt-1 text-xs sm:text-sm opacity-90 max-w-2xl drop-shadow">
                    {p.description}
                  </p>
                )}
                {p.link_url && (
                  <a
                    href={p.link_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-3 inline-flex items-center px-4 py-2 text-xs font-semibold uppercase tracking-wider rounded bg-white text-black hover:bg-white/90 transition"
                  >
                    Learn More
                  </a>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {promos.length > 1 && (
        <>
          <button
            type="button"
            aria-label="Previous promo"
            onClick={() => go(index - 1)}
            className="absolute left-2 top-1/2 -translate-y-1/2 h-9 w-9 rounded-full bg-black/40 hover:bg-black/60 text-white flex items-center justify-center transition"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button
            type="button"
            aria-label="Next promo"
            onClick={() => go(index + 1)}
            className="absolute right-2 top-1/2 -translate-y-1/2 h-9 w-9 rounded-full bg-black/40 hover:bg-black/60 text-white flex items-center justify-center transition"
          >
            <ChevronRight className="h-5 w-5" />
          </button>

          <div className="absolute bottom-2 left-0 right-0 flex justify-center gap-1.5">
            {promos.map((p, i) => (
              <button
                key={p.id}
                type="button"
                aria-label={`Go to promo ${i + 1}`}
                onClick={() => go(i)}
                className={`h-2 w-2 rounded-full transition ${
                  i === index ? 'bg-white w-5' : 'bg-white/50 hover:bg-white/80'
                }`}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
