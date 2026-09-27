import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  CUTOUT_LIST_KEY, CUTOUT_OVERVIEW_KEY, hasTransparency, refusalText, review, uploadOwnCutout,
} from "@/lib/media-cutouts";
import {
  fetchCutoutStates, fetchProductPhotos, isLookupCode, markDuplicates, matchOne, parseFileName, PROBLEM_TEXT,
  type MatchResult,
} from "@/lib/cutout-bulk";

/**
 * Website → Photos → "Upload from Photoroom" (owner request 2026-09-27).
 * Drop the transparent PNGs exported from a Photoroom APP batch edit; each is
 * matched to a product photo by its file name (product code + photo number,
 * both editable here) and applied only after "Apply". Each applied file is
 * exactly "Upload my own cut-out": audited, finished by the Hub, approved.
 * No Photoroom API call, no API images. See src/lib/cutout-bulk.ts.
 */

const MAX_FILES = 300;
const PARALLEL = 3;

interface Item {
  id: string;
  file: File;
  preview: string;
  code: string;
  photoNo: number;
  isImage: boolean;
  transparent: boolean | null; // null = still checking
  outcome: { ok: boolean; message: string } | null;
}

export default function CutoutBulkUpload({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [items, setItems] = useState<Item[]>([]);
  const [dragging, setDragging] = useState(false);
  const [applying, setApplying] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Free the previews when the window closes or files are removed.
  const itemsRef = useRef<Item[]>([]);
  itemsRef.current = items;
  useEffect(() => () => { itemsRef.current.forEach((i) => URL.revokeObjectURL(i.preview)); }, []);
  const reset = () => { items.forEach((i) => URL.revokeObjectURL(i.preview)); setItems([]); };

  const addFiles = (list: FileList | File[]) => {
    const incoming = Array.from(list).slice(0, Math.max(0, MAX_FILES - items.length));
    if (list.length > incoming.length) toast.info(`Only the first ${MAX_FILES} files are taken at once.`);
    const added: Item[] = incoming.map((file) => {
      const { code, photoNo } = parseFileName(file.name);
      return {
        id: crypto.randomUUID(), file, preview: URL.createObjectURL(file), code, photoNo,
        isImage: file.type === "image/png" || file.type === "image/webp",
        transparent: null, outcome: null,
      };
    });
    setItems((prev) => [...prev, ...added]);
    for (const it of added) {
      if (!it.isImage) { setItems((p) => p.map((x) => (x.id === it.id ? { ...x, transparent: false } : x))); continue; }
      hasTransparency(it.file)
        .then((t) => setItems((p) => p.map((x) => (x.id === it.id ? { ...x, transparent: t } : x))))
        .catch(() => setItems((p) => p.map((x) => (x.id === it.id ? { ...x, transparent: false } : x))));
    }
  };

  const update = (id: string, patch: Partial<Item>) =>
    setItems((p) => p.map((x) => (x.id === id ? { ...x, ...patch, outcome: null } : x)));
  const remove = (id: string) => setItems((p) => {
    const gone = p.find((x) => x.id === id);
    if (gone) URL.revokeObjectURL(gone.preview);
    return p.filter((x) => x.id !== id);
  });

  // Look up every code on screen (re-runs when a code is edited).
  const codes = useMemo(
    () => [...new Set(items.map((i) => i.code.trim().toUpperCase()).filter(isLookupCode))].sort(),
    [items],
  );
  const lookup = useQuery({
    queryKey: ["cutout-bulk-lookup", codes],
    enabled: open && codes.length > 0,
    staleTime: 10_000,
    queryFn: async () => {
      const products = await fetchProductPhotos(codes);
      const urls = [...products.values()].flat().flatMap((p) => p.photos);
      const states = await fetchCutoutStates(urls);
      return { products, states };
    },
  });

  const results: MatchResult[] = useMemo(() => {
    const products = lookup.data?.products ?? new Map();
    const states = lookup.data?.states ?? new Map();
    return markDuplicates(items.map((i) => (i.outcome?.ok
      ? { ready: false, problem: null, product: null, sourceUrl: null, status: null }
      : matchOne(i.code, i.photoNo, { isImage: i.isImage, transparent: i.transparent }, products, states))));
  }, [items, lookup.data]);

  const readyIdx = items.map((it, i) => (results[i].ready && !it.outcome?.ok ? i : -1)).filter((i) => i >= 0);
  const checking = items.some((i) => i.transparent === null) || lookup.isFetching;

  const apply = async () => {
    setApplying(true);
    const queue = [...readyIdx];
    let ok = 0;
    let failed = 0;
    const worker = async () => {
      for (let k = queue.shift(); k !== undefined; k = queue.shift()) {
        const it = items[k];
        const r = results[k];
        try {
          const ownUrl = await uploadOwnCutout(it.file);
          await review(r.sourceUrl!, "own_cutout", {
            ownUrl, expected: r.status ?? undefined, note: `Photoroom batch: ${it.file.name}`.slice(0, 500),
          });
          ok++;
          setItems((p) => p.map((x) => (x.id === it.id ? { ...x, outcome: { ok: true, message: "Saved — lands approved within a minute or two." } } : x)));
        } catch (e) {
          failed++;
          setItems((p) => p.map((x) => (x.id === it.id ? { ...x, outcome: { ok: false, message: refusalText(e) } } : x)));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
    setApplying(false);
    await qc.invalidateQueries({ queryKey: [CUTOUT_LIST_KEY] });
    await qc.invalidateQueries({ queryKey: CUTOUT_OVERVIEW_KEY });
    await qc.invalidateQueries({ queryKey: ["cutout-bulk-lookup"] });
    if (ok) toast.success(`${ok} cut-out${ok === 1 ? "" : "s"} saved. They land approved within a minute or two.`);
    if (failed) toast.error(`${failed} could not be saved — see the red lines.`);
  };

  const saved = items.filter((i) => i.outcome?.ok).length;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (applying) return; if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="flex max-h-[92vh] w-[96vw] max-w-4xl flex-col gap-3">
        <DialogHeader>
          <DialogTitle>Upload from Photoroom</DialogTitle>
          <DialogDescription>
            Drop the transparent PNGs you exported from a Photoroom batch edit. Each file is matched by its name —
            product code, then the photo number (<span className="font-mono">AL123.png</span> = main photo,{" "}
            <span className="font-mono">AL123-2.png</span> = 2nd photo). Fix any code or number below, then Apply.
            Nothing is saved before Apply. No Photoroom API images are used.
          </DialogDescription>
        </DialogHeader>

        <div
          data-testid="bulk-drop"
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files); }}
          className={`flex flex-col items-center justify-center gap-2 rounded border-2 border-dashed p-5 text-center text-sm ${
            dragging ? "border-primary bg-primary/5" : "border-border"}`}
        >
          <Upload className="h-5 w-5 text-muted-foreground" />
          <span>Drag the files here, or</span>
          <Button type="button" size="sm" variant="outline" onClick={() => inputRef.current?.click()} disabled={applying}>
            Choose files
          </Button>
          <input ref={inputRef} type="file" multiple accept="image/png,image/webp" className="hidden"
                 aria-label="Photoroom files"
                 onChange={(e) => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = ""; }} />
        </div>

        {items.length > 0 && (
          <div className="min-h-0 flex-1 overflow-auto rounded border border-border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-card text-left text-muted-foreground">
                <tr>
                  <th className="p-2 font-medium">File</th>
                  <th className="p-2 font-medium">Product code</th>
                  <th className="p-2 font-medium">Photo no.</th>
                  <th className="p-2 font-medium">Goes to</th>
                  <th className="p-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {items.map((it, i) => {
                  const r = results[i];
                  return (
                    <tr key={it.id} data-testid="bulk-row" className="align-middle">
                      <td className="p-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <img src={it.preview} alt="" className="h-10 w-10 shrink-0 rounded border border-border object-contain"
                               style={{ background: "repeating-conic-gradient(#d4d4d4 0% 25%, #ffffff 0% 50%) 50% / 10px 10px" }} />
                          <span className="max-w-[12rem] truncate" title={it.file.name}>{it.file.name}</span>
                        </div>
                      </td>
                      <td className="p-2">
                        <Input value={it.code} aria-label={`Product code for ${it.file.name}`} disabled={applying || !!it.outcome?.ok}
                               className="h-8 w-28 font-mono uppercase"
                               onChange={(e) => update(it.id, { code: e.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase() })} />
                      </td>
                      <td className="p-2">
                        <Input type="number" min={1} max={99} value={it.photoNo} aria-label={`Photo number for ${it.file.name}`}
                               disabled={applying || !!it.outcome?.ok} className="h-8 w-16"
                               onChange={(e) => update(it.id, { photoNo: Math.max(1, Math.min(99, Number(e.target.value) || 1)) })} />
                      </td>
                      <td className="p-2">
                        {it.outcome ? (
                          <span className={it.outcome.ok ? "flex items-center gap-1 text-success" : "text-destructive"}>
                            {it.outcome.ok && <CheckCircle2 className="h-3.5 w-3.5" />}{it.outcome.message}
                          </span>
                        ) : it.transparent === null || (lookup.isFetching && !lookup.data) ? (
                          <span className="flex items-center gap-1 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking…</span>
                        ) : r.problem ? (
                          <span className="text-destructive" data-testid="bulk-problem">
                            {r.product && <span className="text-foreground">{r.product.sku} · {r.product.name} — </span>}
                            {PROBLEM_TEXT[r.problem]}
                          </span>
                        ) : r.ready && r.product ? (
                          <div className="flex items-center gap-2">
                            <img src={r.sourceUrl!} alt="" className="h-10 w-10 shrink-0 rounded border border-border object-cover" />
                            <span className="min-w-0">
                              <span className="block truncate">{r.product.sku} · {r.product.name}</span>
                              <span className="text-muted-foreground">
                                Photo {it.photoNo}{it.photoNo === 1 ? " (main)" : ""} of {r.product.photos.length}
                                {r.status === "approved" ? " · replaces the approved cut-out" : ""}
                              </span>
                            </span>
                          </div>
                        ) : null}
                      </td>
                      <td className="p-2 text-right">
                        {!it.outcome?.ok && (
                          <Button type="button" size="icon" variant="ghost" className="h-7 w-7" disabled={applying}
                                  aria-label={`Remove ${it.file.name}`} onClick={() => remove(it.id)}>
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {lookup.isError && <p className="text-xs text-destructive">Could not look up the products: {refusalText(lookup.error)}</p>}

        <DialogFooter className="flex-row items-center justify-between gap-2 sm:justify-between">
          <div className="flex flex-wrap gap-1.5 text-xs">
            {items.length > 0 && <Badge variant="outline">{items.length} file{items.length === 1 ? "" : "s"}</Badge>}
            {readyIdx.length > 0 && <Badge variant="outline">{readyIdx.length} ready</Badge>}
            {saved > 0 && <Badge variant="outline">{saved} saved</Badge>}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" disabled={applying} onClick={() => { reset(); onOpenChange(false); }}>
              {saved > 0 ? "Close" : "Cancel"}
            </Button>
            <Button disabled={applying || checking || readyIdx.length === 0} onClick={apply}>
              {applying ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Saving…</> : `Apply ${readyIdx.length || ""}`.trim()}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
