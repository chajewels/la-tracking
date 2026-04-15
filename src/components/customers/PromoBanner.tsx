import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Volume2, VolumeX } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { parseImageUrls } from '@/lib/promo-media';

interface Promo {
  id: string;
  title: string;
  description: string | null;
  media_url: string | null;
  media_type: 'image' | 'video' | null;
  link_url: string | null;
  display_order: number;
}

/** A single carousel slide. Image promos are flattened into one slide per image,
 *  all carrying the parent promo's title/description/CTA. Video promos stay as one slide. */
interface Slide {
  key: string;
  promoId: string;
  title: string;
  description: string | null;
  link_url: string | null;
  mediaType: 'image' | 'video' | null;
  mediaUrl: string | null;
}

const ROTATE_MS = 5000;

interface PromoBannerProps {
  /** Invoice number of the current account. Banner is temporarily
   *  restricted to invoice numbers starting with 'TEST' for testing. */
  invoiceNumber: string;
}

export default function PromoBanner({ invoiceNumber }: PromoBannerProps) {
  // Temporary restriction: only render for test accounts.
  const isTestAccount = typeof invoiceNumber === 'string' && invoiceNumber.startsWith('TEST');

  const [promos, setPromos] = useState<Promo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const videoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());

  // Fetch active promos once on mount (skipped for non-test accounts)
  useEffect(() => {
    if (!isTestAccount) return;
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
  }, [isTestAccount]);

  // Flatten promos: images expand into one slide per image URL.
  const slides = useMemo<Slide[]>(() => {
    const out: Slide[] = [];
    for (const p of promos) {
      if (p.media_type === 'video' && p.media_url) {
        out.push({
          key: p.id,
          promoId: p.id,
          title: p.title,
          description: p.description,
          link_url: p.link_url,
          mediaType: 'video',
          mediaUrl: p.media_url,
        });
      } else if (p.media_type === 'image') {
        const urls = parseImageUrls(p.media_url);
        if (urls.length === 0) continue;
        urls.forEach((url, i) => {
          out.push({
            key: `${p.id}:${i}`,
            promoId: p.id,
            title: p.title,
            description: p.description,
            link_url: p.link_url,
            mediaType: 'image',
            mediaUrl: url,
          });
        });
      }
    }
    return out;
  }, [promos]);

  // Auto-rotate
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (paused || slides.length < 2) return;
    timerRef.current = setTimeout(() => {
      setIndex(i => (i + 1) % slides.length);
    }, ROTATE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [index, paused, slides.length]);

  // Sync muted state to all rendered <video> elements via ref.
  useEffect(() => {
    videoRefs.current.forEach(v => { v.muted = muted; });
  }, [muted, slides.length]);

  // Reset index if slides shrink below current
  useEffect(() => {
    if (index >= slides.length && slides.length > 0) setIndex(0);
  }, [slides.length, index]);

  if (!isTestAccount) return null;
  if (!loaded || slides.length === 0) return null;

  const go = (next: number) => {
    const n = slides.length;
    setIndex(((next % n) + n) % n);
  };

  const currentIsVideo = slides[index]?.mediaType === 'video';

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
        {slides.map(s => (
          <div key={s.key} className="relative w-full flex-shrink-0" style={{ flexBasis: '100%' }}>
            <div className="relative w-full bg-black" style={{ height: 300, maxHeight: 300 }}>
              {s.mediaType === 'video' && s.mediaUrl ? (
                <video
                  ref={el => {
                    if (el) videoRefs.current.set(s.key, el);
                    else videoRefs.current.delete(s.key);
                  }}
                  src={s.mediaUrl}
                  className="absolute inset-0 h-full w-full object-cover"
                  autoPlay
                  muted
                  loop
                  playsInline
                />
              ) : s.mediaType === 'image' && s.mediaUrl ? (
                <img
                  src={s.mediaUrl}
                  alt={s.title}
                  className="absolute inset-0 h-full w-full object-cover"
                />
              ) : null}

              {/* Gradient overlay for legibility */}
              <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />

              {/* Text + CTA */}
              <div className="absolute inset-x-0 bottom-0 p-4 sm:p-6 text-white">
                <h3 className="text-lg sm:text-2xl font-bold drop-shadow">{s.title}</h3>
                {s.description && (
                  <p className="mt-1 text-xs sm:text-sm opacity-90 max-w-2xl drop-shadow">
                    {s.description}
                  </p>
                )}
                {s.link_url && (
                  <a
                    href={s.link_url}
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

      {/* Mute / unmute toggle — only visible when current slide is a video */}
      {currentIsVideo && (
        <button
          type="button"
          aria-label={muted ? 'Unmute video' : 'Mute video'}
          onClick={() => setMuted(m => !m)}
          className="absolute bottom-3 right-3 z-10 h-9 w-9 rounded-full bg-black/50 hover:bg-black/70 text-white flex items-center justify-center transition"
        >
          {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </button>
      )}

      {slides.length > 1 && (
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
            {slides.map((s, i) => (
              <button
                key={s.key}
                type="button"
                aria-label={`Go to slide ${i + 1}`}
                onClick={() => go(i)}
                className={`h-2 rounded-full transition ${
                  i === index ? 'bg-white w-5' : 'bg-white/50 hover:bg-white/80 w-2'
                }`}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
