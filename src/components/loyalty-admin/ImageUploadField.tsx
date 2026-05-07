import { useCallback, useRef, useState, type DragEvent } from 'react';
import { Loader2, RefreshCw, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import {
  LOYALTY_IMAGES_BUCKET,
  loyaltyImagesPath,
} from '@/lib/loyalty-images-path';
import { cn } from '@/lib/utils';

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

type Entity = 'promo' | 'reward' | 'banner';

interface ImageUploadFieldProps {
  entity: Entity;
  value: string | null;
  onChange: (newUrl: string | null) => void;
  disabled?: boolean;
}

function getExt(file: File): string {
  const fromName = file.name.split('.').pop()?.toLowerCase();
  if (fromName && fromName.length <= 5 && /^[a-z0-9]+$/.test(fromName)) {
    return fromName;
  }
  if (file.type === 'image/jpeg') return 'jpg';
  if (file.type === 'image/png') return 'png';
  if (file.type === 'image/webp') return 'webp';
  return 'jpg';
}

function fileNameFromUrl(url: string): string {
  try {
    const parts = url.split('/');
    return decodeURIComponent(parts[parts.length - 1] || '');
  } catch {
    return '';
  }
}

export default function ImageUploadField({
  entity,
  value,
  onChange,
  disabled = false,
}: ImageUploadFieldProps) {
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const validate = useCallback((file: File): string | null => {
    if (!ALLOWED_MIME.has(file.type)) {
      return 'Unsupported file type. Use JPEG, PNG, or WebP.';
    }
    if (file.size > MAX_BYTES) {
      const mb = (file.size / 1024 / 1024).toFixed(1);
      return `File too large (${mb} MB). Max 5 MB.`;
    }
    return null;
  }, []);

  // Fire-and-forget — never surface the error. Only deletes URLs that point
  // to our own bucket; external URLs (from the legacy paste-only flow) are
  // left untouched.
  const deletePrevious = useCallback(async (prevUrl: string) => {
    const path = loyaltyImagesPath(prevUrl);
    if (!path) return;
    try {
      await supabase.storage.from(LOYALTY_IMAGES_BUCKET).remove([path]);
    } catch {
      // intentionally swallowed
    }
  }, []);

  const upload = useCallback(
    async (file: File) => {
      const validationErr = validate(file);
      if (validationErr) {
        setError(validationErr);
        toast.error(validationErr);
        return;
      }
      setError(null);
      setUploading(true);
      try {
        const ext = getExt(file);
        const filename = `${entity}-${crypto.randomUUID()}-${Date.now()}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from(LOYALTY_IMAGES_BUCKET)
          .upload(filename, file, {
            contentType: file.type,
            cacheControl: '3600',
            upsert: false,
          });
        if (upErr) throw upErr;
        const { data } = supabase.storage.from(LOYALTY_IMAGES_BUCKET).getPublicUrl(filename);
        const newUrl = data.publicUrl;

        if (value) {
          void deletePrevious(value);
        }

        onChange(newUrl);
        toast.success('Image uploaded.');
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Upload failed';
        setError(msg);
        toast.error(msg);
      } finally {
        setUploading(false);
      }
    },
    [entity, onChange, value, validate, deletePrevious],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void upload(file);
      // Reset so re-selecting the same file still fires onChange
      if (inputRef.current) inputRef.current.value = '';
    },
    [upload],
  );

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      if (disabled || uploading) return;
      const file = e.dataTransfer.files?.[0];
      if (file) void upload(file);
    },
    [disabled, uploading, upload],
  );

  const handleDragOver = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (disabled || uploading) return;
      if (!dragOver) setDragOver(true);
    },
    [disabled, uploading, dragOver],
  );

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleRemove = useCallback(() => {
    if (disabled || uploading) return;
    if (value) void deletePrevious(value);
    setError(null);
    onChange(null);
  }, [disabled, uploading, value, onChange, deletePrevious]);

  const openBrowse = useCallback(() => {
    if (disabled || uploading) return;
    inputRef.current?.click();
  }, [disabled, uploading]);

  const filename = value ? fileNameFromUrl(value) : '';

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={handleFileSelect}
        disabled={disabled || uploading}
      />

      {!value ? (
        <button
          type="button"
          onClick={openBrowse}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          disabled={disabled || uploading}
          className={cn(
            'w-full rounded-md border border-dashed p-6 flex flex-col items-center justify-center gap-1.5 text-center transition-colors',
            dragOver
              ? 'border-primary bg-primary/5'
              : 'border-border bg-muted/30 hover:bg-muted/40',
            (disabled || uploading) && 'opacity-50 cursor-not-allowed',
          )}
        >
          {uploading ? (
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          ) : (
            <Upload className="h-5 w-5 text-muted-foreground" />
          )}
          <p className="text-xs font-medium text-foreground">
            {uploading ? 'Uploading…' : 'Drag image here or click to browse'}
          </p>
          <p className="text-[11px] text-muted-foreground">
            JPEG, PNG, or WebP • max 5 MB
          </p>
        </button>
      ) : (
        <div
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          className={cn(
            'flex items-center gap-3 rounded-md border p-2 transition-colors',
            dragOver ? 'border-primary bg-primary/5' : 'border-border',
          )}
        >
          <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-md border border-border bg-muted">
            <img
              src={value}
              alt=""
              className="h-full w-full object-cover"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = 'none';
              }}
            />
            {uploading && (
              <div className="absolute inset-0 flex items-center justify-center bg-background/70">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
              </div>
            )}
          </div>

          <div className="flex-1 min-w-0">
            <p
              className="text-xs font-medium text-foreground truncate"
              title={filename}
            >
              {filename || 'Image attached'}
            </p>
            <p className="text-[11px] text-muted-foreground">
              JPEG, PNG, or WebP • max 5 MB
            </p>
            <div className="mt-1.5 flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={openBrowse}
                disabled={disabled || uploading}
                className="h-7 px-2 text-[11px]"
              >
                <RefreshCw className="h-3 w-3 mr-1" />
                Replace
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={handleRemove}
                disabled={disabled || uploading}
                className="h-7 px-2 text-[11px] text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="h-3 w-3 mr-1" />
                Remove
              </Button>
            </div>
          </div>
        </div>
      )}

      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
