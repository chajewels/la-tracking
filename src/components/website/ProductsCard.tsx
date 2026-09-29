import { uploadProductVideo } from "@/lib/product-video";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { CatalogBulkBar } from "@/components/website/CatalogBulkBar";
import { CatalogSearchBar } from "@/components/website/CatalogSearchBar";
import {
  type CatalogFilters, type CatalogTab, filterProducts, filtersFromParams, groupByType, hasActiveFilters, openFromParams,
  pageSlice, pagesFromParams, placementFor, productTypeCounts, scopeToView, statusesForTab, tabCounts, tabOf, tabOfProduct,
  viewFromParams, withFilters, withOpen, withPage, withView,
} from "@/lib/catalog-search";
import { missingText, publishMissing } from "@/lib/page365-drafts";
import { hiddenByPage365Note } from "@/lib/page365-inventory";
import { fetchHiddenByPage365 } from "@/lib/page365-inventory-api";
import { ChevronDown, ChevronLeft, ChevronRight, Download, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import ProductImportDialog from "@/components/website/ProductImportDialog";
import ProductDialog from "@/components/website/ProductDialog";
import { translateJa } from "@/components/website/translate";
import { uploadWebsiteImage } from "@/components/website/HeroImageField";
import { CATEGORIES_QUERY_KEY, fetchCategories } from "@/components/website/CategoriesCard";
import {
  ConditionValue, ORIGIN_VALUES, OriginValue,
} from "@/lib/website-catalog-import";
import {
  type MediaRow, type ProductForm, type ProductMetal, type VariantRow, PRODUCT_METAL_VALUES, TEMPLATE_PATH,
  ITEM_KIND_LABEL, emptyProduct, emptyVariant, itemKindFrom, metalRequired, metalsLabel, slugify, yen,
} from "@/components/website/product-form";

/**
 * The website product list and everything that writes to it: the queries, the
 * save and remove mutations, the bulk Japanese pass, the import trigger and
 * the template download.
 *
 * Published / Unpublished (2026-09-28): two top-level tabs, ?view=published
 * (default) | unpublished; ?view=page365-drafts is a narrower Unpublished
 * view. "Published" = status "active", the same test the website API and the
 * cut-out publish gate use (src/lib/catalog-search.ts isPublished). Inside a
 * tab the products are grouped under their product types (website_collections
 * order, then "No product type"; a product in several types shows under each).
 * Each type is a collapsible section, closed by default, 25 products a page
 * (2026-09-28: the list had no boundaries). Open sections and pages live in
 * the URL (?open=, ?pg=) with the tab and filters; changing search, a filter
 * or the tab opens only the types with matches (none without a search or
 * filter) and goes back to page 1 — src/lib/catalog-search.ts placementFor.
 *
 * Search and filters (2026-09-27) live in the URL —
 * ?q=&type=&category=&status=&stock= — work within the open tab, and combine
 * with ?view= and ?product=<id>. Filtering is client-side over the WHOLE catalog: the
 * list is read in pages (PostgREST returns at most 1,000 rows per request),
 * so a search never runs over a silently truncated list. Rules:
 * src/lib/catalog-search.ts.
 *
 * Lifted out of WebsiteCatalog.tsx with its logic untouched. The one thing
 * that moved on screen is the action row — it used to sit beside the page
 * title and now sits in this card's header, because the card is no longer the
 * only thing on the page.
 */
export default function ProductsCard() {
  const { roles } = useAuth();
  const isAdmin = roles?.includes("admin");
  // The delete guard. isAdmin still gates the two ADMIN-ONLY things here — the
  // cost-basis field and the importer's admin mode — because those are about
  // money, not about who maintains the catalog. Removing a product is the
  // latter, so it follows the permission.
  const { can } = usePermissions();
  const canManage = can("manage_website_catalog") || !!isAdmin;
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<ProductForm>(emptyProduct());
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [searchParams, setSearchParams] = useSearchParams();
  const view = viewFromParams(searchParams);
  const tab: CatalogTab = tabOf(view);
  const draftsView = view === "page365-drafts";

  const collections = useQuery({
    queryKey: ["website-collections"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("website_collections" as any)
        .select("id, slug, name, name_ja, description, description_ja, hero_media")
        .order("name");
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });

  const products = useQuery({
    queryKey: ["website-products"],
    queryFn: async () => {
      // Paged: one request returns at most 1,000 rows (PostgREST max-rows),
      // and the search must run over the whole catalog, never a truncated
      // one. A failed page fails the whole read — no partial list is shown.
      // id breaks created_at ties so pages never overlap or skip.
      const PAGE_SIZE = 1000;
      const MAX_PAGES = 100;
      const all: Array<Record<string, unknown>> = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const { data, error } = await supabase
          .from("website_products" as any)
          .select(
            // "*" rather than a column list: page365_product_id (PR 4) is read when
            // the migration has run and simply absent before it.
            "*, " +
            "website_product_variants(id, size, stone, price_jpy, cost_basis, stock_qty, sort, website_product_media(id, url, alt, sort, page365_photo_id, page365_photo_version)), " +
            "website_collection_products(collection_id), website_category_products(category_id)"
          )
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
        if (error) throw error;
        all.push(...((data ?? []) as unknown as Array<Record<string, unknown>>));
        if ((data ?? []).length < PAGE_SIZE) return all;
      }
      throw new Error(`The catalog has more than ${PAGE_SIZE * MAX_PAGES} products; the list would be incomplete.`);
    },
  });

  const categories = useQuery({ queryKey: CATEGORIES_QUERY_KEY, queryFn: fetchCategories });

  // PR 3b: products the Hub hid because Page365 stopped listing them. Before
  // the migration the table is absent: the query fails and no note shows.
  const hiddenByPage365 = useQuery({
    queryKey: ["page365-hidden-products"],
    queryFn: fetchHiddenByPage365,
    retry: false,
    staleTime: 60_000,
  });

  const fx = useQuery({
    queryKey: ["website-fx-rate"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fx_rates" as any)
        .select("date, jpy_php")
        .order("date", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as any;
    },
  });

  const rows = useMemo(() => (products.data ?? []).map((p: any) => {
    const variants = (p.website_product_variants ?? []) as any[];
    const prices = variants.map((v) => Number(v.price_jpy ?? 0)).filter((n) => n > 0);
    return {
      ...p,
      variantCount: variants.length,
      stock: variants.reduce((s, v) => s + Number(v.stock_qty ?? 0), 0),
      fromPrice: prices.length ? Math.min(...prices) : 0,
    };
  }), [products.data]);

  // The open tab: Published, Unpublished, or (from "Landed in Catalog",
  // ?view=page365-drafts) only the unpublished Page365 products.
  const scoped = useMemo(() => scopeToView(rows, view), [rows, view]);

  // Search + filters, from the URL. The box writes ?q= after a short pause so
  // typing stays smooth and a refresh or shared link keeps the search.
  const filters = useMemo(() => filtersFromParams(searchParams), [searchParams]);
  const [query, setQuery] = useState(filters.q);
  // The last ?q= this box wrote. The URL is copied back into the box only when
  // it changed from elsewhere (Back, a pasted link), never when our own
  // debounced write lands — that would drop keys typed in the meantime.
  const wroteQ = useRef(filters.q);
  useEffect(() => {
    if (filters.q !== wroteQ.current) { wroteQ.current = filters.q; setQuery(filters.q); }
  }, [filters.q]);
  useEffect(() => {
    if (query === wroteQ.current) return;
    const t = setTimeout(() => {
      wroteQ.current = query;
      setSearchParams((prev) => place(withFilters(prev, { q: query })), { replace: true });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);
  const setFilters = (patch: Partial<CatalogFilters>) =>
    setSearchParams((prev) => place(withFilters(prev, patch)), { replace: true });
  const clearFilters = () => {
    wroteQ.current = "";
    setQuery("");
    setSearchParams(
      (prev) => place(withFilters(prev, { q: "", type: "", category: "", status: "", stock: "" })),
      { replace: true },
    );
  };
  const visible = useMemo(() => filterProducts(scoped, filters), [scoped, filters]);
  const typeCounts = useMemo(() => productTypeCounts(scoped, filters), [scoped, filters]);
  const tabTotals = useMemo(() => tabCounts(rows, filters), [rows, filters]);
  const statuses = useMemo(() => statusesForTab(tab, rows.map((p) => String(p.status ?? ""))), [tab, rows]);
  const typeOptions = useMemo(
    () => (collections.data ?? []).map((c: { id: string; name: string }) => ({ id: c.id, name: c.name })),
    [collections.data],
  );
  const filtering = hasActiveFilters(filters);
  // Grouped by product type; with a type filter, only that group. A type with
  // no products (in this tab, after search and filters) is left out — it has
  // no chip either (owner 2026-09-29: "save space").
  const groups = useMemo(
    () => groupByType(visible, typeOptions)
      .filter((g) => !filters.type || g.id === filters.type)
      .filter((g) => g.rows.length > 0),
    [visible, typeOptions, filters.type],
  );
  // Which sections are open and the page each shows (URL: ?open=, ?pg=).
  const openIds = useMemo(() => openFromParams(searchParams), [searchParams]);
  const pageOf = useMemo(() => pagesFromParams(searchParams), [searchParams]);
  const sections = useMemo(
    () => groups.map((g) => ({ group: g, open: openIds.has(g.id), slice: pageSlice(g.rows, pageOf.get(g.id) ?? 1) })),
    [groups, openIds, pageOf],
  );
  const openCount = sections.filter((s) => s.open).length;
  // The rows on screen now: the current page of every open section. "Select
  // all" selects exactly these (a product in two open types counts once).
  const shownIds = useMemo(
    () => [...new Set(sections.filter((s) => s.open).flatMap((s) => s.slice.rows.map((p) => String(p.id))))],
    [sections],
  );
  const selectedRows = useMemo(() => visible.filter((p) => picked.has(p.id)), [visible, picked]);
  // A search, filter or tab change re-places the list: see placementFor.
  function place(sp: URLSearchParams): URLSearchParams {
    return placementFor(sp, rows, typeOptions);
  }
  const setView = (v: "published" | "unpublished" | "sold-out") => {
    setPicked(new Set());
    setSearchParams((prev) => place(withView(prev, v)), { replace: false });
  };
  const setOpenGroups = (ids: Iterable<string>) => setSearchParams((prev) => withOpen(prev, ids), { replace: true });
  const toggleGroup = (typeId: string) => setSearchParams((prev) => {
    const o = openFromParams(prev);
    if (o.has(typeId)) o.delete(typeId); else o.add(typeId);
    return withOpen(prev, o);
  }, { replace: true });
  // Jump to: open that type only, then scroll to it once it has rendered open.
  // A page change brings the section's header back into view too ("nearest":
  // only if it is off screen) — the new page can be shorter, which would
  // otherwise leave the view below the section.
  const [jumping, setJumping] = useState<{ id: string; block: ScrollLogicalPosition } | null>(null);
  const jumpTo = (typeId: string) => { setOpenGroups([typeId]); setJumping({ id: typeId, block: "start" }); };
  const setGroupPage = (typeId: string, page: number) => {
    setSearchParams((prev) => withPage(prev, typeId, page), { replace: true });
    setJumping({ id: typeId, block: "nearest" });
  };
  useEffect(() => {
    if (!jumping || !openIds.has(jumping.id)) return;
    (document.getElementById(`catalog-group-${jumping.id}`) ?? document.getElementById(`catalog-group-body-${jumping.id}`))?.scrollIntoView?.({ behavior: "smooth", block: jumping.block });
    setJumping(null);
  }, [jumping, openIds]);
  const noun = draftsView ? "unpublished Page365 products" : `${tab} products`;

  // ?product=<id> (links from "Landed in Catalog"): open that product once loaded.
  const deepLinked = searchParams.get("product");
  useEffect(() => {
    if (!deepLinked || !products.data) return;
    const p = rows.find((r) => r.id === deepLinked);
    // The product's own tab is opened behind the dialog (drafts stay under Unpublished).
    setSearchParams((prev) => {
      const n = p && tabOfProduct(p) !== tabOf(viewFromParams(prev)) ? withView(prev, tabOfProduct(p)) : new URLSearchParams(prev);
      n.delete("product");
      return n;
    }, { replace: true });
    if (p) openEdit(p);
    else toast({ title: "Product not found", description: "It may have been removed.", variant: "destructive" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinked, products.data]);

  function openNew() {
    setForm(emptyProduct());
    setOpen(true);
  }

  function openEdit(p: any) {
    const variants = ((p.website_product_variants ?? []) as any[])
      .sort((a, b) => Number(a.sort) - Number(b.sort))
      .map((v) => ({
        id: v.id,
        size: v.size ?? "",
        stone: v.stone ?? "",
        price_jpy: Number(v.price_jpy ?? 0),
        cost_basis: v.cost_basis === null ? null : Number(v.cost_basis),
        stock_qty: Number(v.stock_qty ?? 0),
        sort: Number(v.sort ?? 0),
        media: ((v.website_product_media ?? []) as any[])
          .sort((a, b) => Number(a.sort) - Number(b.sort))
          .map((m) => ({
            id: m.id, url: m.url, alt: m.alt, sort: Number(m.sort ?? 0),
            page365_photo_id: m.page365_photo_id ?? null, page365_photo_version: m.page365_photo_version ?? null,
          })),
      }));
    setForm({
      id: p.id,
      sku: p.sku ?? "",
      slug: p.slug ?? "",
      name: p.name ?? "",
      name_ja: p.name_ja ?? "",
      savedName: p.name ?? "",
      itemKind: itemKindFrom(p.item_kind),
      metals: (Array.isArray(p.metals) && p.metals.length ? p.metals : p.karat ? [p.karat] : [])
        .filter((m: string): m is ProductMetal => (PRODUCT_METAL_VALUES as readonly string[]).includes(m)),
      weight_g: p.weight_g === null ? null : Number(p.weight_g),
      condition: (p.condition === "Preloved" ? "Preloved" : "New") as ConditionValue,
      origin: (ORIGIN_VALUES as readonly string[]).includes(p.origin) ? (p.origin as OriginValue) : "UNKNOWN",
      brand: p.brand ?? "",
      description_en: p.description_en ?? "",
      description_ja: p.description_ja ?? "",
      savedEn: p.description_en ?? "",
      status: p.status ?? "draft",
      page365SyncDisabled: p.page365_sync_disabled === true,
      videoUrl: p.video_url ?? null,
      videoPosterUrl: p.video_poster_url ?? null,
      videoColumns: "video_url" in p,
      collectionIds: ((p.website_collection_products ?? []) as any[]).map((c) => c.collection_id),
      categoryIds: ((p.website_category_products ?? []) as any[]).map((c) => c.category_id),
      variants: variants.length ? variants : [emptyVariant(0)],
    });
    setOpen(true);
  }

  async function regenerateJapanese() {
    const name = form.name.trim();
    const en = form.description_en.trim();
    if (!name && !en) {
      toast({ title: "Nothing to translate", description: "Write the English name or description first." });
      return;
    }
    setTranslating(true);
    try {
      const ja = await translateJa({ name, description: en });
      setForm((f) => ({
        ...f,
        name_ja: name ? ja.name_ja : "",
        description_ja: en ? ja.description_ja : "",
      }));
      toast({ title: "Japanese updated" });
    } catch (e: any) {
      toast({ title: "Could not translate", description: e.message, variant: "destructive" });
    } finally {
      setTranslating(false);
    }
  }

  /**
   * Re-translate EVERY product's Japanese name and description in one pass,
   * sequentially so the AI rate limit is never hit. Name and description go in
   * one call per product, so a design term ("Open Teardrop") comes back the
   * same in both. English is never touched; a product whose translation fails
   * is skipped and named in the summary.
   */
  async function regenerateAllJapanese() {
    const rows = (products.data ?? []) as any[];
    const targets = rows.filter((p) => String(p.name ?? "").trim());
    if (!targets.length) { toast({ title: "Nothing to translate" }); return; }
    if (!confirm(`Regenerate the Japanese name and description for ${targets.length} product${targets.length === 1 ? "" : "s"}? English text is not changed.`)) return;
    setBulk({ done: 0, total: targets.length });
    const failed: string[] = [];
    for (const [i, p] of targets.entries()) {
      try {
        const en = String(p.description_en ?? "").trim();
        const out = await translateJa({ name: String(p.name).trim(), description: en || undefined });
        const { error } = await supabase.from("website_products" as any)
          .update({ name_ja: out.name_ja || null, description_ja: en ? out.description_ja || null : null })
          .eq("id", p.id);
        if (error) throw error;
      } catch (e: any) {
        failed.push(`${p.sku ?? p.name}: ${e.message}`);
      } finally {
        setBulk({ done: i + 1, total: targets.length });
      }
    }
    setBulk(null);
    qc.invalidateQueries({ queryKey: ["website-products"] });
    if (failed.length) {
      toast({ title: `Japanese regenerated for ${targets.length - failed.length} of ${targets.length}`, description: failed.join(" · "), variant: "destructive" });
    } else {
      toast({ title: `Japanese regenerated for ${targets.length} product${targets.length === 1 ? "" : "s"}` });
    }
  }

  const save = useMutation({
    mutationFn: async (f: ProductForm) => {
      if (!f.name.trim() || !f.sku.trim()) throw new Error("Name and SKU are required.");
      // Jewelry only, and only to publish (owner decision 2026-09-26; DB CHECK
      // website_products_metals_jewelry applies to status active). A draft saves without one.
      if (f.status === "active" && metalRequired(f.itemKind) && !f.metals.length) {
        throw new Error("Pick at least one metal stamp — required to publish jewelry. Save it as a draft until then.");
      }
      if (!f.variants.length) throw new Error("Add at least one variant.");
      if (f.origin === "BRAND" && !f.brand.trim()) throw new Error("Enter the brand name for a Branded piece.");
      const slug = (f.slug.trim() || slugify(f.name));
      const wasActive = (products.data ?? []).some((p) => p.id === f.id && p.status === "active");
      const goingLive = f.status === "active" && !wasActive;

      // Japanese is derived from the English text: refresh it when the English
      // changed, or when it has never been generated. Never on an unchanged product.
      const name = f.name.trim();
      const en = f.description_en.trim();
      let nameJa = f.name_ja.trim();
      let ja = f.description_ja.trim();
      if (!en) ja = "";
      const needName = name !== f.savedName.trim() || !nameJa;
      const needDesc = !!en && (en !== f.savedEn.trim() || !ja);
      if (needName || needDesc) {
        setTranslating(true);
        try {
          const out = await translateJa({
            name: needName ? name : undefined,
            description: needDesc ? en : undefined,
          });
          if (needName) nameJa = out.name_ja;
          if (needDesc) ja = out.description_ja;
        } catch (e: any) {
          toast({
            title: "Japanese not regenerated",
            description: `${e.message} The product still saved — use Regenerate to retry.`,
            variant: "destructive",
          });
        } finally {
          setTranslating(false);
        }
      }

      const productPayload = {
        sku: f.sku.trim(),
        slug,
        name,
        name_ja: nameJa || null,
        item_kind: f.itemKind,
        metals: f.metals,
        weight_g: f.weight_g,
        condition: f.condition,
        origin: f.origin,
        brand: f.brand.trim() || null,
        description_en: en || null,
        description_ja: ja || null,
        // Going live is written LAST, after categories: a Page365 draft is
        // refused publication without a category (trg_page365_draft_publish_guard).
        status: goingLive ? "draft" : f.status,
        page365_sync_disabled: f.page365SyncDisabled,
        // Only once the columns exist (or a video was added): see videoColumns.
        ...(f.videoColumns || f.videoUrl
          ? { video_url: f.videoUrl, video_poster_url: f.videoUrl ? f.videoPosterUrl : null }
          : {}),
      };

      let productId = f.id;
      if (productId) {
        const { error } = await supabase.from("website_products" as any)
          .update(productPayload).eq("id", productId);
        if (error) throw error;
      } else {
        const { data, error } = await supabase.from("website_products" as any)
          .insert(productPayload).select("id").single();
        if (error) throw error;
        productId = (data as any).id;
      }

      // Variants: upsert, then remove ones deleted in the form.
      const keptVariantIds: string[] = [];
      for (const [i, v] of f.variants.entries()) {
        const payload = {
          product_id: productId,
          size: v.size?.trim() || null,
          stone: v.stone?.trim() || null,
          price_jpy: Math.round(Number(v.price_jpy) || 0),
          cost_basis: v.cost_basis === null || v.cost_basis === undefined ? null : Math.round(Number(v.cost_basis)),
          stock_qty: Math.round(Number(v.stock_qty) || 0),
          sort: i,
        };
        let variantId = v.id;
        if (variantId) {
          const { error } = await supabase.from("website_product_variants" as any)
            .update(payload).eq("id", variantId);
          if (error) throw error;
        } else {
          const { data, error } = await supabase.from("website_product_variants" as any)
            .insert(payload).select("id").single();
          if (error) throw error;
          variantId = (data as any).id;
        }
        keptVariantIds.push(variantId!);

        // Media rows for this variant (replace-all — media list is small).
        const { error: delMediaErr } = await supabase.from("website_product_media" as any)
          .delete().eq("variant_id", variantId);
        if (delMediaErr) throw delMediaErr;
        if (v.media.length) {
          const { error: insMediaErr } = await supabase.from("website_product_media" as any)
            .insert(v.media.map((m, idx) => ({
              variant_id: variantId, url: m.url, alt: m.alt?.trim() || null, sort: idx,
              // Keep a copied Page365 photo's identity, or the next fetch
              // would copy it again (duplicate photo).
              page365_photo_id: m.page365_photo_id ?? null,
              page365_photo_version: m.page365_photo_version ?? null,
            })));
          if (insMediaErr) throw insMediaErr;
        }
      }
      const { data: existing } = await supabase.from("website_product_variants" as any)
        .select("id").eq("product_id", productId);
      const stale = ((existing ?? []) as any[]).map((r) => r.id).filter((id) => !keptVariantIds.includes(id));
      if (stale.length) {
        const { error } = await supabase.from("website_product_variants" as any).delete().in("id", stale);
        if (error) throw error;
      }

      // Collection membership
      const { error: delColErr } = await supabase.from("website_collection_products" as any)
        .delete().eq("product_id", productId);
      if (delColErr) throw delColErr;
      if (f.collectionIds.length) {
        const { error } = await supabase.from("website_collection_products" as any)
          .insert(f.collectionIds.map((cid, idx) => ({
            collection_id: cid, product_id: productId, sort: idx,
          })));
        if (error) throw error;
      }

      // Category membership — its own join table with its own column name
      // (sort_order, not sort). Never the collection payload.
      const { error: delCatErr } = await supabase.from("website_category_products" as any)
        .delete().eq("product_id", productId);
      if (delCatErr) throw delCatErr;
      if (f.categoryIds.length) {
        const { error } = await supabase.from("website_category_products" as any)
          .insert(f.categoryIds.map((cid, idx) => ({
            category_id: cid, product_id: productId, sort_order: idx,
          })));
        if (error) throw error;
      }
      if (goingLive) {
        const { error } = await supabase.from("website_products" as never)
          .update({ status: "active" } as never).eq("id", productId!);
        if (error) throw new Error(`Saved as a draft, not published: ${error.message}`);
      }
      return productId;
    },
    onSuccess: () => {
      toast({ title: "Saved", description: "The website will refresh within a minute." });
      qc.invalidateQueries({ queryKey: ["website-products"] });
      setOpen(false);
    },
    onError: (e: any) => toast({ title: "Could not save", description: e.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("website_products" as any).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Product removed" });
      qc.invalidateQueries({ queryKey: ["website-products"] });
    },
    onError: (e: any) => toast({ title: "Could not remove", description: e.message, variant: "destructive" }),
  });

  async function uploadMedia(variantIndex: number, files: FileList | null) {
    if (!files?.length) return;
    setUploadingKey(`v${variantIndex}`);
    try {
      const uploaded: MediaRow[] = [];
      for (const file of Array.from(files)) {
        const url = await uploadWebsiteImage("", file);
        uploaded.push({ url, alt: form.name || null, sort: 0 });
      }
      setForm((f) => {
        const variants = [...f.variants];
        variants[variantIndex] = {
          ...variants[variantIndex],
          media: [...variants[variantIndex].media, ...uploaded],
        };
        return { ...f, variants };
      });
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    } finally {
      setUploadingKey(null);
    }
  }

  async function uploadVideo(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setUploadingKey("video");
    try {
      const { video_url, video_poster_url } = await uploadProductVideo(file);
      setForm((f) => ({ ...f, videoUrl: video_url, videoPosterUrl: video_poster_url }));
      toast({
        title: "Video added",
        description: video_poster_url ? "Save the product to put it on the website." : "Uploaded without a still frame (this browser could not read the clip). Save the product to put it on the website.",
      });
    } catch (e: any) {
      toast({ title: "Video upload failed", description: e.message, variant: "destructive" });
    } finally {
      setUploadingKey(null);
    }
  }

  function patchVariant(i: number, patch: Partial<VariantRow>) {
    setForm((f) => {
      const variants = [...f.variants];
      variants[i] = { ...variants[i], ...patch };
      return { ...f, variants };
    });
  }

  const jpyPhp = fx.data ? Number((fx.data as any).jpy_php) : null;
  const peso = (n: number) =>
    jpyPhp ? `₱ ${Math.round(n * jpyPhp).toLocaleString("en-US")}` : "—";

  return (
    <>
      <Card>
        <CardHeader className="hairline-b">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
            <CardTitle className="text-base">
              Products {products.data ? `(${products.data.length})` : ""}
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              {jpyPhp
                ? `Peso prices are calculated on the website from the daily rate — ¥1 = ₱${jpyPhp} as of ${(fx.data as any).date}. Nothing peso-denominated is stored here.`
                : "No exchange rate on file yet — the website will show yen only until the daily rate lands."}
            </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" asChild>
            <a href={TEMPLATE_PATH} download>
              <Download className="mr-2 h-4 w-4" /> Download template
            </a>
          </Button>
          <ProductImportDialog
            collections={(collections.data ?? []) as any[]}
            categories={(categories.data ?? []).map((c) => ({ id: c.id, name: c.name, slug: c.slug }))}
            isAdmin={!!isAdmin}
            translate={translateJa}
          />
          <Button variant="outline" onClick={regenerateAllJapanese} disabled={!!bulk || !(products.data ?? []).length}>
            {bulk
              ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Translating {bulk.done}/{bulk.total}</>
              : <><RefreshCw className="mr-2 h-4 w-4" /> Regenerate all Japanese</>}
          </Button>
          <Button onClick={openNew}>
            <Plus className="mr-2 h-4 w-4" /> Add product
          </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {rows.length > 0 && (
            <div className="flex gap-1 border-b border-border px-4 pt-3" role="tablist" aria-label="Published or not" data-testid="catalog-publish-tabs">
              {(["published", "unpublished", "sold-out"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => { if (view !== t) setView(t); }}
                  className={
                    "-mb-px whitespace-nowrap border-b-2 px-3 pb-2 text-sm font-medium transition-colors " +
                    (tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")
                  }
                >
                  {t === "published" ? "Published" : t === "unpublished" ? "Unpublished" : "Sold out"} ({tabTotals[t]})
                </button>
              ))}
            </div>
          )}
          {draftsView && (
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-xs">
              <Badge variant="outline">Unpublished Page365 products only ({visible.length})</Badge>
              <span className="text-muted-foreground">Not on the website. Set origin and category, then select and Publish.</span>
              <Button size="sm" variant="ghost" onClick={() => setView("unpublished")}>Show all unpublished</Button>
            </div>
          )}
          {rows.length > 0 && (
            <CatalogSearchBar
              query={query}
              onQueryChange={setQuery}
              filters={filters}
              onFiltersChange={setFilters}
              onClear={clearFilters}
              types={typeOptions}
              categories={(categories.data ?? []).map((c) => ({ id: c.id, name: c.name }))}
              statuses={statuses}
              counts={typeCounts}
              shown={visible.length}
              total={scoped.length}
              noun={noun}
              onJump={jumpTo}
              openIds={openIds}
              onClose={toggleGroup}
              onOpenAll={() => setOpenGroups(groups.map((g) => g.id))}
              onCloseAll={() => setOpenGroups([])}
              openCount={openCount}
              groupCount={sections.length}
            />
          )}
          {canManage && (
            <CatalogBulkBar
              selected={selectedRows}
              categories={(categories.data ?? []).map((c) => ({ id: c.id, name: c.name }))}
              onDone={() => qc.invalidateQueries({ queryKey: ["website-products"] })}
              onClear={() => setPicked(new Set())}
            />
          )}
          {products.isLoading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : products.isError ? (
            <div className="py-16 text-center text-sm text-destructive" data-testid="catalog-load-error">
              Could not load the whole catalog, so nothing is shown rather than part of it. Refresh to try again.
            </div>
          ) : rows.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              No products yet. Add your first piece to publish it on the website.
            </div>
          ) : scoped.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground" data-testid="catalog-tab-empty">
              {draftsView
                ? "No unpublished Page365 products."
                : tab === "published"
                  ? "No published products yet. Publish one from the Unpublished tab."
                  : "Nothing unpublished — every product is on the website."}
            </div>
          ) : visible.length === 0 ? (
            <div className="space-y-3 py-16 text-center text-sm text-muted-foreground" data-testid="catalog-no-match">
              <p>No {noun} match.</p>
              <Button variant="outline" size="sm" onClick={clearFilters}>Clear search and filters</Button>
            </div>
          ) : !sections.some((s) => s.open) ? (
            <div className="py-12 text-center text-sm text-muted-foreground" data-testid="catalog-pick-type">
              Pick a product type above to see its products.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {canManage && (
                    <TableHead className="w-8">
                      <Checkbox
                        aria-label="Select all shown"
                        title="Selects the products shown: the current page of each open type"
                        disabled={shownIds.length === 0}
                        checked={shownIds.length > 0 && shownIds.every((id) => picked.has(id))}
                        onCheckedChange={(v) => setPicked(v === true ? new Set(shownIds) : new Set())}
                      />
                    </TableHead>
                  )}
                  <TableHead>Name</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Metal</TableHead>
                  <TableHead>Condition</TableHead>
                  <TableHead>Origin</TableHead>
                  <TableHead className="text-right">From</TableHead>
                  <TableHead className="text-right">Approx.</TableHead>
                  <TableHead className="text-right">Variants</TableHead>
                  <TableHead className="text-right">Stock</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              {sections.filter((s) => s.open).map(({ group: g, open: isOpen, slice }) => (
                <Fragment key={g.id}>
                  {/* A heading only when two or more types are open (Open all, or a
                      search matching several): with one, its highlighted chip says
                      which type this is. Closed types print nothing (owner 2026-09-29). */}
                  {openCount > 1 && (
                  <TableBody>
                    <TableRow className="bg-muted/40 hover:bg-muted/40" data-testid="catalog-group">
                      <TableCell colSpan={canManage ? 12 : 11} className="scroll-mt-20 p-0" id={`catalog-group-${g.id}`}>
                        <button
                          type="button"
                          onClick={() => toggleGroup(g.id)}
                          aria-expanded={isOpen}
                          aria-controls={isOpen ? `catalog-group-body-${g.id}` : undefined}
                          data-testid="catalog-group-toggle"
                          className="sticky left-0 flex min-h-11 items-center gap-2 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {isOpen
                            ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                            : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
                          <span className="text-sm font-semibold" data-testid="catalog-group-name">{g.name}</span>
                          <span className="text-xs tabular-nums text-muted-foreground" data-testid="catalog-group-count">
                            {g.rows.length} {g.rows.length === 1 ? "product" : "products"}
                          </span>
                        </button>
                      </TableCell>
                    </TableRow>
                  </TableBody>
                  )}
                  {isOpen && (
                  <TableBody id={`catalog-group-body-${g.id}`} className="scroll-mt-20" data-testid="catalog-group-body">
                    {g.rows.length === 0 && (
                      <TableRow data-testid="catalog-group-empty">
                        <TableCell colSpan={canManage ? 12 : 11} className="py-3 text-xs text-muted-foreground">
                          <span className="sticky left-3">No {noun} of this type.</span>
                        </TableCell>
                      </TableRow>
                    )}
                    {slice.rows.map((p: any) => (
                  <TableRow key={`${g.id}:${p.id}`} className="cursor-pointer" onClick={() => openEdit(p)}>
                        {canManage && (
                          <TableCell className="w-8" onClick={(e) => e.stopPropagation()}>
                            <Checkbox
                              aria-label={`Select ${p.sku}`}
                              checked={picked.has(p.id)}
                              onCheckedChange={(v) => setPicked((prev) => {
                                const n = new Set(prev);
                                if (v === true) n.add(p.id); else n.delete(p.id);
                                return n;
                              })}
                            />
                          </TableCell>
                        )}
                        <TableCell className="font-medium">
                          {p.name}
                          {p.name_ja && <div className="text-xs font-normal text-muted-foreground" lang="ja">{p.name_ja}</div>}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {p.sku}
                          {p.page365_sync_disabled && (
                            <Badge variant="outline" className="ml-1.5 text-[10px] text-muted-foreground" title="Don't sync with Page365">
                              Not synced
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          {metalsLabel(p.metals, p.karat)}
                          {itemKindFrom(p.item_kind) !== "jewelry" && (
                            <Badge variant="outline" className="ml-1.5 text-[10px] text-muted-foreground">
                              {ITEM_KIND_LABEL[itemKindFrom(p.item_kind)]}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          {p.condition === "Preloved"
                            ? <Badge variant="secondary">Preloved</Badge>
                            : <span className="text-muted-foreground">New</span>}
                        </TableCell>
                        <TableCell>
                          {p.origin === "JAPAN" ? "Made in Japan"
                            : p.origin === "BRAND" ? (p.brand || <span className="text-warning">Branded — no brand name</span>)
                            : p.origin === "OTHER" ? <span className="text-muted-foreground">Other</span>
                            : <span className="text-muted-foreground">Unknown</span>}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{p.fromPrice ? yen(p.fromPrice) : "—"}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {p.fromPrice ? peso(p.fromPrice) : "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{p.variantCount}</TableCell>
                        <TableCell className="text-right tabular-nums">{p.stock}</TableCell>
                        <TableCell>
                          <Badge variant={p.status === "active" ? "default" : "secondary"}>{p.status}</Badge>
                          {p.status === "draft" && publishMissing(p).length > 0 && (
                            <div className="mt-0.5 text-[10px] text-warning">{missingText(publishMissing(p))}</div>
                          )}
                          {hiddenByPage365Note(p.status, hiddenByPage365.data?.get(p.id)) && (
                            <div className="mt-0.5 text-[10px] text-muted-foreground" data-testid="catalog-hidden-by-page365">
                              {hiddenByPage365Note(p.status, hiddenByPage365.data?.get(p.id))}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {canManage && (
                            <Button
                              variant="ghost" size="icon"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (confirm(`Remove ${p.name} from the website catalog?`)) remove.mutate(p.id);
                              }}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                    {slice.pages > 1 && (
                      <TableRow className="hover:bg-transparent" data-testid="catalog-group-pager">
                        <TableCell colSpan={canManage ? 12 : 11} className="py-2">
                          <div className="sticky left-3 flex max-w-[calc(100vw-7rem)] flex-wrap items-center gap-2 text-xs sm:max-w-none">
                            <span className="tabular-nums text-muted-foreground" data-testid="catalog-group-range">
                              {slice.from}–{slice.to} of {slice.total}
                            </span>
                            <div className="flex gap-2">
                              <Button size="sm" variant="outline" className="h-8" disabled={slice.page <= 1}
                                      onClick={() => setGroupPage(g.id, slice.page - 1)} aria-label={`Previous page of ${g.name}`}>
                                <ChevronLeft className="mr-1 h-3.5 w-3.5" /> Previous
                              </Button>
                              <Button size="sm" variant="outline" className="h-8" disabled={slice.page >= slice.pages}
                                      onClick={() => setGroupPage(g.id, slice.page + 1)} aria-label={`Next page of ${g.name}`}>
                                Next <ChevronRight className="ml-1 h-3.5 w-3.5" />
                              </Button>
                            </div>
                            <span className="tabular-nums text-muted-foreground">Page {slice.page} of {slice.pages}</span>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                  )}
                </Fragment>
              ))}
            </Table>
          )}
        </CardContent>
      </Card>

      <ProductDialog
        open={open}
        onOpenChange={setOpen}
        form={form}
        setForm={setForm}
        collections={(collections.data ?? []) as any[]}
        categories={categories.data ?? []}
        isAdmin={!!isAdmin}
        translating={translating}
        uploadingKey={uploadingKey}
        peso={peso}
        saving={save.isPending}
        onSave={() => save.mutate(form)}
        onRegenerateJapanese={regenerateJapanese}
        onUploadMedia={uploadMedia}
        onUploadVideo={uploadVideo}
        onPatchVariant={patchVariant}
      />
    </>
  );
}
