import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Volume2, VolumeX, X } from 'lucide-react';
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
  expires_at: string | null;
}

interface Category {
  id: string;
  name: string;
  display_order: number;
}

interface Assignment {
  promo_id: string;
  category_id: string;
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
  /** For image slides only: index within the parent promo's image array. */
  imageIndex?: number;
}

const ROTATE_MS = 5000;
const SWIPE_THRESHOLD = 50; // px

export default function PromoBanner() {
  const [promos, setPromos] = useState<Promo[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(true);
  /** null = "All" tab selected */
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  /** Lightbox state — null when closed. */
  const [lightbox, setLightbox] = useState<{ promoId: string; imageIndex: number } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const videoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const touchStartXRef = useRef<number | null>(null);

  // Fetch active promos, categories, and assignments in parallel.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [promoRes, catRes, assignRes] = await Promise.all([
          (supabase.from('promotions' as any) as any)
            .select('id, title, description, media_url, media_type, link_url, display_order, expires_at')
            .eq('is_active', true)
            .order('display_order', { ascending: true }),
          (supabase.from('promo_categories' as any) as any)
            .select('id, name, display_order')
            .order('display_order', { ascending: true }),
          (supabase.from('promo_category_assignments' as any) as any)
            .select('promo_id, category_id'),
        ]);
        if (cancelled) return;
        if (!promoRes.error && Array.isArray(promoRes.data)) {
          setPromos(promoRes.data as Promo[]);
        }
        if (!catRes.error && Array.isArray(catRes.data)) {
          setCategories(catRes.data as Category[]);
        }
        if (!assignRes.error && Array.isArray(assignRes.data)) {
          setAssignments(assignRes.data as Assignment[]);
        }
      } catch {
        /* swallow — banner just hides on error */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Map: promoId → Set<categoryId>
  const promoToCategories = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const a of assignments) {
      if (!m.has(a.promo_id)) m.set(a.promo_id, new Set());
      m.get(a.promo_id)!.add(a.category_id);
    }
    return m;
  }, [assignments]);

  // Exclude expired promos (expires_at IS NOT NULL AND expires_at < now).
  // The DB keeps them with is_active=true until the hourly cron flips them;
  // the UI must never show them regardless of that lag.
  const nonExpiredPromos = useMemo(() => {
    const now = Date.now();
    return promos.filter(p => {
      if (!p.expires_at) return true;
      const t = new Date(p.expires_at).getTime();
      return !Number.isFinite(t) || t >= now;
    });
  }, [promos]);

  // Categories that have at least one active, non-expired promo (preserving display order).
  const activeCategories = useMemo(() => {
    const activePromoIds = new Set(nonExpiredPromos.map(p => p.id));
    const usedCategoryIds = new Set<string>();
    for (const a of assignments) {
      if (activePromoIds.has(a.promo_id)) usedCategoryIds.add(a.category_id);
    }
    return categories.filter(c => usedCategoryIds.has(c.id));
  }, [nonExpiredPromos, assignments, categories]);

  // Filter promos by selected category, then flatten into slides.
  const slides = useMemo<Slide[]>(() => {
    const filteredPromos = selectedCategoryId === null
      ? nonExpiredPromos
      : nonExpiredPromos.filter(p => promoToCategories.get(p.id)?.has(selectedCategoryId));

    const out: Slide[] = [];
    for (const p of filteredPromos) {
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
            imageIndex: i,
          });
        });
      }
    }
    return out;
  }, [nonExpiredPromos, promoToCategories, selectedCategoryId]);

  // Reset index when filter changes
  useEffect(() => {
    setIndex(0);
  }, [selectedCategoryId]);

  // Auto-rotate — paused while the lightbox is open.
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (paused || lightbox || slides.length < 2) return;
    timerRef.current = setTimeout(() => {
      setIndex(i => (i + 1) % slides.length);
    }, ROTATE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [index, paused, lightbox, slides.length]);

  // Sync muted state to all rendered <video> elements via ref.
  useEffect(() => {
    videoRefs.current.forEach(v => { v.muted = muted; });
  }, [muted, slides.length]);

  // Reset index if slides shrink below current
  useEffect(() => {
    if (index >= slides.length && slides.length > 0) setIndex(0);
  }, [slides.length, index]);

  // Lightbox: images for the active promo, and current image (with safe indexing).
  const lightboxImages = useMemo(() => {
    if (!lightbox) return [];
    const promo = promos.find(p => p.id === lightbox.promoId);
    if (!promo) return [];
    return parseImageUrls(promo.media_url);
  }, [lightbox, promos]);

  const lightboxIndex = lightbox && lightboxImages.length > 0
    ? Math.max(0, Math.min(lightbox.imageIndex, lightboxImages.length - 1))
    : 0;

  // Keyboard shortcuts for lightbox: Escape / ArrowLeft / ArrowRight
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null);
      else if (e.key === 'ArrowLeft') {
        setLightbox(lb => {
          if (!lb || lightboxImages.length === 0) return lb;
          const n = lightboxImages.length;
          return { ...lb, imageIndex: (lb.imageIndex - 1 + n) % n };
        });
      } else if (e.key === 'ArrowRight') {
        setLightbox(lb => {
          if (!lb || lightboxImages.length === 0) return lb;
          const n = lightboxImages.length;
          return { ...lb, imageIndex: (lb.imageIndex + 1) % n };
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox, lightboxImages.length]);

  if (!loaded) return null;
  // Hide entirely when there are no active, non-expired promos (banner + tabs)
  if (nonExpiredPromos.length === 0) return null;

  const go = (next: number) => {
    const n = slides.length;
    if (n === 0) return;
    setIndex(((next % n) + n) % n);
  };

  const currentIsVideo = slides[index]?.mediaType === 'video';

  const openLightboxForSlide = (s: Slide) => {
    if (s.mediaType !== 'image' || !s.mediaUrl) return;
    if (s.link_url) return; // link takes precedence — do nothing here
    setLightbox({ promoId: s.promoId, imageIndex: s.imageIndex ?? 0 });
  };

  const stepLightbox = (delta: number) => {
    if (lightboxImages.length === 0) return;
    const n = lightboxImages.length;
    setLightbox(lb => lb ? { ...lb, imageIndex: ((lb.imageIndex + delta) % n + n) % n } : lb);
  };

  return (
    <div className="space-y-2">
      {/* Category filter tabs — only when at least one category has active promos */}
      {activeCategories.length > 0 && (
        <div className="flex flex-wrap gap-1.5 overflow-x-auto">
          <button
            type="button"
            onClick={() => setSelectedCategoryId(null)}
            className={`px-3 py-1.5 text-xs font-medium rounded-full border transition whitespace-nowrap ${
              selectedCategoryId === null
                ? 'bg-black text-white border-black'
                : 'bg-white text-black border-black/20 hover:border-black/50'
            }`}
          >
            All
          </button>
          {activeCategories.map(c => (
            <button
              key={c.id}
              type="button"
              onClick={() => setSelectedCategoryId(c.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-full border transition whitespace-nowrap ${
                selectedCategoryId === c.id
                  ? 'bg-black text-white border-black'
                  : 'bg-white text-black border-black/20 hover:border-black/50'
              }`}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}

      {slides.length === 0 ? null : (
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
            {slides.map(s => {
              const imageIsClickable = s.mediaType === 'image' && !s.link_url && !!s.mediaUrl;
              return (
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
                      onClick={imageIsClickable ? () => openLightboxForSlide(s) : undefined}
                      className={`absolute inset-0 h-full w-full object-cover ${imageIsClickable ? 'cursor-zoom-in' : ''}`}
                    />
                  ) : null}

                  {/* Gradient overlay for legibility */}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent pointer-events-none" />

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
              );
            })}
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
      )}

      {/* Lightbox — fullscreen image viewer for image slides without a link_url */}
      {lightbox && lightboxImages.length > 0 && (
        <div
          className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center"
          role="dialog"
          aria-modal="true"
          aria-label="Image viewer"
          onClick={() => setLightbox(null)}
          onTouchStart={(e) => {
            touchStartXRef.current = e.changedTouches[0]?.clientX ?? null;
          }}
          onTouchEnd={(e) => {
            const startX = touchStartXRef.current;
            if (startX === null) return;
            const endX = e.changedTouches[0]?.clientX ?? startX;
            const dx = endX - startX;
            touchStartXRef.current = null;
            if (Math.abs(dx) < SWIPE_THRESHOLD) return;
            stepLightbox(dx < 0 ? 1 : -1);
          }}
        >
          {/* Close button */}
          <button
            type="button"
            aria-label="Close image viewer"
            onClick={(e) => { e.stopPropagation(); setLightbox(null); }}
            className="absolute top-4 right-4 h-10 w-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition"
          >
            <X className="h-5 w-5" />
          </button>

          {/* Image — click is stopped so tapping the image itself does not close */}
          <img
            src={lightboxImages[lightboxIndex]}
            alt="promo image"
            onClick={(e) => e.stopPropagation()}
            className="max-w-[95vw] max-h-[90vh] object-contain select-none"
            draggable={false}
          />

          {lightboxImages.length > 1 && (
            <>
              <button
                type="button"
                aria-label="Previous image"
                onClick={(e) => { e.stopPropagation(); stepLightbox(-1); }}
                className="absolute left-3 top-1/2 -translate-y-1/2 h-11 w-11 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition"
              >
                <ChevronLeft className="h-6 w-6" />
              </button>
              <button
                type="button"
                aria-label="Next image"
                onClick={(e) => { e.stopPropagation(); stepLightbox(1); }}
                className="absolute right-3 top-1/2 -translate-y-1/2 h-11 w-11 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition"
              >
                <ChevronRight className="h-6 w-6" />
              </button>

              <div className="absolute bottom-4 left-0 right-0 flex justify-center">
                <span className="px-3 py-1 text-xs text-white/90 rounded-full bg-white/10">
                  {lightboxIndex + 1} / {lightboxImages.length}
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
