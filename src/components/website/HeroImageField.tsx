import { useState } from "react";
import { Loader2, Trash2, Upload } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";

/** Website imagery lives in the promotions bucket under website/. Public read. */
export const MEDIA_BUCKET = "promotions";
export const MEDIA_PREFIX = "website";

/**
 * Upload one image and return its public URL. `folder` nests under website/
 * ("collections", "categories"); "" is the product-photo root the edit modal
 * has always used, so existing objects keep their paths.
 */
export async function uploadWebsiteImage(folder: string, file: File): Promise<string> {
  const ext = file.name.split(".").pop() ?? "jpg";
  const path = `${MEDIA_PREFIX}/${folder ? `${folder}/` : ""}${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from(MEDIA_BUCKET).upload(path, file, { upsert: false });
  if (error) throw error;
  return supabase.storage.from(MEDIA_BUCKET).getPublicUrl(path).data.publicUrl;
}

/**
 * Hero image for a jewelry type or category: thumbnail, upload, remove.
 * Remove clears the URL only — like product photos, the storage object is
 * left in place; the bucket is small and a dangling reference is worse than a
 * dangling file.
 */
export function HeroImageField({
  url, folder, onChange, disabled, size = "md",
}: {
  url: string | null;
  folder: string;
  onChange: (url: string | null) => void;
  disabled?: boolean;
  size?: "sm" | "md";
}) {
  const [uploading, setUploading] = useState(false);
  const box = size === "sm" ? "h-10 w-14" : "h-20 w-28";

  async function pick(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      onChange(await uploadWebsiteImage(folder, file));
    } catch (e) {
      toast({ title: "Upload failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {url ? (
        <img src={url} alt="" className={`${box} rounded object-cover`} loading="lazy" />
      ) : (
        <div className={`${box} grid place-items-center rounded border border-dashed border-border text-[10px] text-muted-foreground`}>none</div>
      )}
      <label className={`flex cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-border px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground ${disabled || uploading ? "pointer-events-none opacity-60" : ""}`}>
        {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
        {url ? "Replace" : "Upload"}
        <input type="file" accept="image/*" className="hidden" disabled={disabled || uploading} onChange={(e) => pick(e.target.files)} />
      </label>
      {url && (
        <button
          type="button" aria-label="Remove hero image" title="Remove hero image"
          disabled={disabled || uploading}
          onClick={() => onChange(null)}
          className="rounded-md p-1.5 text-destructive hover:bg-destructive/10 disabled:opacity-60"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
