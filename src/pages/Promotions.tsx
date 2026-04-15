import { useState } from 'react';
import { Megaphone, Plus, Pencil, Trash2, Upload, Image as ImageIcon, Video, ExternalLink, Tag } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { parseImageUrls } from '@/lib/promo-media';

interface Promotion {
  id: string;
  title: string;
  description: string | null;
  media_url: string | null;
  media_type: 'image' | 'video' | null;
  link_url: string | null;
  is_active: boolean;
  display_order: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

interface PromoFormState {
  title: string;
  description: string;
  link_url: string;
  display_order: number;
  is_active: boolean;
  media_type: 'image' | 'video' | null;
  /** Image URLs (when media_type === 'image'). Stored in DB as JSON array. */
  images: string[];
  /** Single video URL (when media_type === 'video'). */
  video_url: string | null;
  /** Selected category ids (managed via promo_category_assignments). */
  selectedCategoryIds: string[];
  /** datetime-local string ('' when no expiry). Converted to ISO on save. */
  expires_at_local: string;
}

const EMPTY_FORM: PromoFormState = {
  title: '',
  description: '',
  link_url: '',
  display_order: 0,
  is_active: true,
  media_type: null,
  images: [],
  video_url: null,
  selectedCategoryIds: [],
  expires_at_local: '',
};

/** Convert an ISO timestamp (UTC) into a local `datetime-local` input value. */
function isoToDatetimeLocal(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Convert a `datetime-local` input value to an ISO timestamp, or null if empty. */
function datetimeLocalToIso(s: string): string | null {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function isExpired(iso: string | null): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && t < Date.now();
}

function formatExpiry(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

interface PromoCategory {
  id: string;
  name: string;
  display_order: number;
  created_by: string | null;
  created_at: string;
}

interface CategoryFormState {
  name: string;
  display_order: number;
}

const EMPTY_CATEGORY_FORM: CategoryFormState = {
  name: '',
  display_order: 0,
};

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;

export default function Promotions() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<'promos' | 'categories'>('promos');

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Promotion | null>(null);
  const [form, setForm] = useState<PromoFormState>(EMPTY_FORM);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Promotion | null>(null);

  // Categories tab state
  const [catDialogOpen, setCatDialogOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<PromoCategory | null>(null);
  const [catForm, setCatForm] = useState<CategoryFormState>(EMPTY_CATEGORY_FORM);
  const [savingCategory, setSavingCategory] = useState(false);
  const [deleteCategoryTarget, setDeleteCategoryTarget] = useState<PromoCategory | null>(null);

  const { data: promos, isLoading } = useQuery({
    queryKey: ['promotions-admin'],
    queryFn: async () => {
      const { data, error } = await (supabase.from('promotions' as any) as any)
        .select('*')
        .order('display_order', { ascending: true })
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as Promotion[];
    },
  });

  // All categories (for both Categories tab and the promo form's checkboxes)
  const { data: categories } = useQuery({
    queryKey: ['promo-categories'],
    queryFn: async () => {
      const { data, error } = await (supabase.from('promo_categories' as any) as any)
        .select('*')
        .order('display_order', { ascending: true })
        .order('name', { ascending: true });
      if (error) throw error;
      return (data ?? []) as PromoCategory[];
    },
  });

  // Map of user_id → full_name for "Created by" column
  const creatorIds = Array.from(new Set((promos ?? []).map(p => p.created_by).filter(Boolean))) as string[];
  const { data: creators } = useQuery({
    queryKey: ['promotions-creators', creatorIds.sort().join(',')],
    enabled: creatorIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('user_id, full_name')
        .in('user_id', creatorIds);
      if (error) throw error;
      const map = new Map<string, string>();
      (data ?? []).forEach((p: any) => map.set(p.user_id, p.full_name));
      return map;
    },
  });

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }

  async function openEdit(p: Promotion) {
    setEditing(p);
    const isImage = p.media_type === 'image';
    const isVideo = p.media_type === 'video';
    // Load existing category assignments
    let assignedIds: string[] = [];
    try {
      const { data, error } = await (supabase.from('promo_category_assignments' as any) as any)
        .select('category_id')
        .eq('promo_id', p.id);
      if (!error && Array.isArray(data)) {
        assignedIds = data.map((r: any) => r.category_id);
      }
    } catch {
      /* leave empty on error */
    }
    setForm({
      title: p.title,
      description: p.description ?? '',
      link_url: p.link_url ?? '',
      display_order: p.display_order,
      is_active: p.is_active,
      media_type: p.media_type,
      images: isImage ? parseImageUrls(p.media_url) : [],
      video_url: isVideo ? p.media_url : null,
      selectedCategoryIds: assignedIds,
      expires_at_local: isoToDatetimeLocal(p.expires_at),
    });
    setDialogOpen(true);
  }

  function toggleCategorySelection(categoryId: string) {
    setForm(f => {
      const has = f.selectedCategoryIds.includes(categoryId);
      return {
        ...f,
        selectedCategoryIds: has
          ? f.selectedCategoryIds.filter(id => id !== categoryId)
          : [...f.selectedCategoryIds, categoryId],
      };
    });
  }

  async function syncPromoCategoryAssignments(promoId: string, categoryIds: string[]) {
    // Replace strategy: delete all existing for this promo, then insert.
    const { error: delErr } = await (supabase.from('promo_category_assignments' as any) as any)
      .delete()
      .eq('promo_id', promoId);
    if (delErr) throw delErr;
    if (categoryIds.length === 0) return;
    const rows = categoryIds.map(cid => ({ promo_id: promoId, category_id: cid }));
    const { error: insErr } = await (supabase.from('promo_category_assignments' as any) as any)
      .insert(rows);
    if (insErr) throw insErr;
  }

  // ── Categories tab handlers ──────────────────────────────────────
  function openCreateCategory() {
    setEditingCategory(null);
    setCatForm(EMPTY_CATEGORY_FORM);
    setCatDialogOpen(true);
  }

  function openEditCategory(c: PromoCategory) {
    setEditingCategory(c);
    setCatForm({ name: c.name, display_order: c.display_order });
    setCatDialogOpen(true);
  }

  async function handleSaveCategory() {
    if (!catForm.name.trim()) {
      toast.error('Name is required.');
      return;
    }
    setSavingCategory(true);
    try {
      const payload: any = {
        name: catForm.name.trim(),
        display_order: Number(catForm.display_order) || 0,
      };
      if (editingCategory) {
        const { error } = await (supabase.from('promo_categories' as any) as any)
          .update(payload)
          .eq('id', editingCategory.id);
        if (error) throw error;
        toast.success('Category updated.');
      } else {
        payload.created_by = user?.id ?? null;
        const { error } = await (supabase.from('promo_categories' as any) as any).insert(payload);
        if (error) throw error;
        toast.success('Category created.');
      }
      setCatDialogOpen(false);
      queryClient.invalidateQueries({ queryKey: ['promo-categories'] });
      queryClient.invalidateQueries({ queryKey: ['promo-categories-active'] });
    } catch (err: any) {
      toast.error(`Save failed: ${err.message || err}`);
    } finally {
      setSavingCategory(false);
    }
  }

  async function handleDeleteCategory() {
    if (!deleteCategoryTarget) return;
    try {
      const { error } = await (supabase.from('promo_categories' as any) as any)
        .delete()
        .eq('id', deleteCategoryTarget.id);
      if (error) throw error;
      toast.success('Category deleted.');
      setDeleteCategoryTarget(null);
      queryClient.invalidateQueries({ queryKey: ['promo-categories'] });
      queryClient.invalidateQueries({ queryKey: ['promo-categories-active'] });
    } catch (err: any) {
      toast.error(`Delete failed: ${err.message || err}`);
    }
  }

  async function uploadOne(file: File): Promise<string> {
    const ext = file.name.split('.').pop() || (file.type.startsWith('video/') ? 'mp4' : 'jpg');
    const path = `promo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error } = await supabase.storage
      .from('promotions')
      .upload(path, file, { upsert: false, contentType: file.type });
    if (error) throw error;
    return `${SUPABASE_URL}/storage/v1/object/public/promotions/${path}`;
  }

  async function handleUpload(fileList: FileList) {
    const files = Array.from(fileList);
    if (files.length === 0) return;

    const images = files.filter(f => f.type.startsWith('image/'));
    const videos = files.filter(f => f.type.startsWith('video/'));
    const other = files.length - images.length - videos.length;
    if (other > 0) {
      toast.error('Only image and video files are allowed.');
      return;
    }

    // Enforce one media type per promo.
    if (videos.length > 0 && (form.images.length > 0 || images.length > 0)) {
      toast.error('A promo can hold either images or one video, not both. Remove current media first.');
      return;
    }
    if (videos.length > 1) {
      toast.error('Only one video per promo.');
      return;
    }
    if (images.length > 0 && form.video_url) {
      toast.error('This promo already has a video. Remove it before adding images.');
      return;
    }

    setUploading(true);
    try {
      if (videos.length === 1) {
        const url = await uploadOne(videos[0]);
        setForm(f => ({ ...f, video_url: url, images: [], media_type: 'video' }));
        toast.success('Video uploaded.');
        return;
      }
      const urls = await Promise.all(images.map(uploadOne));
      setForm(f => ({
        ...f,
        images: [...f.images, ...urls],
        video_url: null,
        media_type: 'image',
      }));
      toast.success(`${urls.length} image${urls.length === 1 ? '' : 's'} uploaded.`);
    } catch (err: any) {
      toast.error(`Upload failed: ${err.message || err}`);
    } finally {
      setUploading(false);
    }
  }

  function removeImage(idx: number) {
    setForm(f => {
      const next = f.images.filter((_, i) => i !== idx);
      return {
        ...f,
        images: next,
        media_type: next.length === 0 ? null : 'image',
      };
    });
  }

  function removeVideo() {
    setForm(f => ({ ...f, video_url: null, media_type: null }));
  }

  async function handleSave() {
    if (!form.title.trim()) {
      toast.error('Title is required.');
      return;
    }
    setSaving(true);
    try {
      // media_url storage format:
      //   'image' → JSON array of URLs
      //   'video' → single URL string
      //   null    → null
      let serializedMediaUrl: string | null = null;
      let resolvedType: 'image' | 'video' | null = null;
      if (form.video_url) {
        serializedMediaUrl = form.video_url;
        resolvedType = 'video';
      } else if (form.images.length > 0) {
        serializedMediaUrl = JSON.stringify(form.images);
        resolvedType = 'image';
      }

      const payload: any = {
        title: form.title.trim(),
        description: form.description.trim() || null,
        link_url: form.link_url.trim() || null,
        display_order: Number(form.display_order) || 0,
        is_active: form.is_active,
        media_url: serializedMediaUrl,
        media_type: resolvedType,
        expires_at: datetimeLocalToIso(form.expires_at_local),
      };
      let promoId: string;
      if (editing) {
        const { error } = await (supabase.from('promotions' as any) as any)
          .update(payload)
          .eq('id', editing.id);
        if (error) throw error;
        promoId = editing.id;
        toast.success('Promotion updated.');
      } else {
        payload.created_by = user?.id ?? null;
        const { data: inserted, error } = await (supabase.from('promotions' as any) as any)
          .insert(payload)
          .select('id')
          .single();
        if (error) throw error;
        promoId = (inserted as any).id;
        toast.success('Promotion created.');
      }
      // Sync category assignments (replace strategy)
      await syncPromoCategoryAssignments(promoId, form.selectedCategoryIds);
      setDialogOpen(false);
      queryClient.invalidateQueries({ queryKey: ['promotions-admin'] });
      queryClient.invalidateQueries({ queryKey: ['promotions-active'] });
      queryClient.invalidateQueries({ queryKey: ['promo-categories-active'] });
    } catch (err: any) {
      toast.error(`Save failed: ${err.message || err}`);
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(p: Promotion, next: boolean) {
    try {
      const { error } = await (supabase.from('promotions' as any) as any)
        .update({ is_active: next })
        .eq('id', p.id);
      if (error) throw error;
      queryClient.invalidateQueries({ queryKey: ['promotions-admin'] });
      queryClient.invalidateQueries({ queryKey: ['promotions-active'] });
    } catch (err: any) {
      toast.error(`Toggle failed: ${err.message || err}`);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      const { error } = await (supabase.from('promotions' as any) as any)
        .delete()
        .eq('id', deleteTarget.id);
      if (error) throw error;
      toast.success('Promotion deleted.');
      setDeleteTarget(null);
      queryClient.invalidateQueries({ queryKey: ['promotions-admin'] });
      queryClient.invalidateQueries({ queryKey: ['promotions-active'] });
    } catch (err: any) {
      toast.error(`Delete failed: ${err.message || err}`);
    }
  }

  return (
    <AppLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Megaphone className="h-6 w-6 text-primary" />
            <div>
              <h1 className="text-2xl font-bold">Promotions</h1>
              <p className="text-sm text-muted-foreground">
                Banners &amp; ads shown to customers in the portal.
              </p>
            </div>
          </div>
          {tab === 'promos' ? (
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4 mr-2" />
              Add Promo
            </Button>
          ) : (
            <Button onClick={openCreateCategory}>
              <Plus className="h-4 w-4 mr-2" />
              Add Category
            </Button>
          )}
        </div>

        <Tabs value={tab} onValueChange={(v) => setTab(v as 'promos' | 'categories')} className="w-full">
          <TabsList className="grid grid-cols-2 w-full max-w-sm">
            <TabsTrigger value="promos">Promos</TabsTrigger>
            <TabsTrigger value="categories">Categories</TabsTrigger>
          </TabsList>

          <TabsContent value="promos" className="mt-4">
        <div className="rounded-lg border bg-card">
          {isLoading ? (
            <div className="p-6 space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : promos && promos.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Order</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Created by</TableHead>
                  <TableHead>Created at</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {promos.map(p => {
                  const expired = isExpired(p.expires_at);
                  return (
                  <TableRow key={p.id} className={expired ? 'opacity-50' : undefined}>
                    <TableCell className="font-medium">
                      <div className="flex flex-col">
                        <div className="flex items-center gap-2">
                          <span>{p.title}</span>
                          {expired && (
                            <Badge variant="destructive" className="text-[10px]">Expired</Badge>
                          )}
                        </div>
                        {p.link_url && (
                          <a
                            href={p.link_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1"
                          >
                            <ExternalLink className="h-3 w-3" />
                            {p.link_url}
                          </a>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      {p.media_type === 'video' ? (
                        <Badge variant="secondary"><Video className="h-3 w-3 mr-1" /> Video</Badge>
                      ) : p.media_type === 'image' ? (
                        <Badge variant="secondary"><ImageIcon className="h-3 w-3 mr-1" /> Image</Badge>
                      ) : (
                        <Badge variant="outline">—</Badge>
                      )}
                    </TableCell>
                    <TableCell>{p.display_order}</TableCell>
                    <TableCell>
                      <Switch
                        checked={p.is_active}
                        onCheckedChange={(v) => toggleActive(p, v)}
                      />
                    </TableCell>
                    <TableCell className="text-sm">
                      {!p.expires_at ? (
                        <span className="text-muted-foreground">No expiry</span>
                      ) : expired ? (
                        <Badge variant="destructive">Expired</Badge>
                      ) : (
                        <span className="text-emerald-600 dark:text-emerald-400">
                          {formatExpiry(p.expires_at)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {p.created_by && creators?.get(p.created_by) || '—'}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(p.created_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right space-x-1">
                      <Button size="sm" variant="ghost" onClick={() => openEdit(p)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeleteTarget(p)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <div className="p-12 text-center text-muted-foreground">
              <Megaphone className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p>No promotions yet. Click "Add Promo" to create one.</p>
            </div>
          )}
        </div>
          </TabsContent>

          <TabsContent value="categories" className="mt-4">
            <div className="rounded-lg border bg-card">
              {categories && categories.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Display order</TableHead>
                      <TableHead>Created at</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {categories.map(c => (
                      <TableRow key={c.id}>
                        <TableCell className="font-medium">
                          <div className="inline-flex items-center gap-2">
                            <Tag className="h-3.5 w-3.5 text-muted-foreground" />
                            {c.name}
                          </div>
                        </TableCell>
                        <TableCell>{c.display_order}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {new Date(c.created_at).toLocaleDateString()}
                        </TableCell>
                        <TableCell className="text-right space-x-1">
                          <Button size="sm" variant="ghost" onClick={() => openEditCategory(c)}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            onClick={() => setDeleteCategoryTarget(c)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <div className="p-12 text-center text-muted-foreground">
                  <Tag className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p>No categories yet. Click "Add Category" to create one.</p>
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </div>

      {/* Add/Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Promotion' : 'New Promotion'}</DialogTitle>
            <DialogDescription>
              {editing ? 'Update this promo.' : 'Create a new promo banner.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="promo-title">Title *</Label>
              <Input
                id="promo-title"
                value={form.title}
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                placeholder="Holiday Sale"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="promo-desc">Description</Label>
              <Textarea
                id="promo-desc"
                rows={3}
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="Up to 30% off selected pieces this week only."
              />
            </div>

            <div className="space-y-1.5">
              <Label>Media (multiple images or one video)</Label>
              <div className="flex items-center gap-3 flex-wrap">
                <label className="inline-flex items-center gap-2 px-3 py-2 border rounded-md cursor-pointer hover:bg-muted text-sm">
                  <Upload className="h-4 w-4" />
                  {uploading
                    ? 'Uploading…'
                    : form.video_url
                      ? 'Replace video'
                      : form.images.length > 0
                        ? 'Add more images'
                        : 'Upload images or video'}
                  <input
                    type="file"
                    accept="image/*,video/*"
                    multiple
                    className="hidden"
                    disabled={uploading}
                    onChange={(e) => {
                      if (e.target.files && e.target.files.length > 0) {
                        handleUpload(e.target.files);
                      }
                      e.target.value = '';
                    }}
                  />
                </label>
                {form.media_type === 'video' && form.video_url && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Video className="h-3 w-3" /> 1 video
                  </span>
                )}
                {form.media_type === 'image' && form.images.length > 0 && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <ImageIcon className="h-3 w-3" /> {form.images.length} image{form.images.length === 1 ? '' : 's'}
                  </span>
                )}
              </div>

              {/* Video preview */}
              {form.video_url && (
                <div className="mt-2 relative rounded-md border overflow-hidden max-h-48 bg-black flex items-center justify-center">
                  <video src={form.video_url} className="max-h-48" controls muted />
                  <button
                    type="button"
                    onClick={removeVideo}
                    className="absolute top-1 right-1 h-6 w-6 rounded-full bg-black/70 hover:bg-destructive text-white flex items-center justify-center"
                    aria-label="Remove video"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              )}

              {/* Image thumbnails grid */}
              {form.images.length > 0 && (
                <div className="mt-2 grid grid-cols-3 sm:grid-cols-4 gap-2">
                  {form.images.map((url, idx) => (
                    <div key={`${url}-${idx}`} className="relative group rounded-md overflow-hidden border bg-muted aspect-video">
                      <img src={url} alt={`image ${idx + 1}`} className="h-full w-full object-cover" />
                      <button
                        type="button"
                        onClick={() => removeImage(idx)}
                        className="absolute top-1 right-1 h-6 w-6 rounded-full bg-black/70 hover:bg-destructive text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition"
                        aria-label={`Remove image ${idx + 1}`}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="promo-link">Link URL (optional)</Label>
              <Input
                id="promo-link"
                value={form.link_url}
                onChange={e => setForm(f => ({ ...f, link_url: e.target.value }))}
                placeholder="https://example.com/sale"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="promo-order">Display order</Label>
                <Input
                  id="promo-order"
                  type="number"
                  value={form.display_order}
                  onChange={e => setForm(f => ({ ...f, display_order: Number(e.target.value) || 0 }))}
                />
                <p className="text-[11px] text-muted-foreground">Lower = shown first.</p>
              </div>
              <div className="space-y-1.5">
                <Label>Active</Label>
                <div className="flex items-center gap-2 h-10">
                  <Switch
                    checked={form.is_active}
                    onCheckedChange={(v) => setForm(f => ({ ...f, is_active: v }))}
                  />
                  <span className="text-sm text-muted-foreground">
                    {form.is_active ? 'Shown to customers' : 'Hidden'}
                  </span>
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="promo-expires">Expires At (optional)</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="promo-expires"
                  type="datetime-local"
                  value={form.expires_at_local}
                  onChange={e => setForm(f => ({ ...f, expires_at_local: e.target.value }))}
                  className="max-w-xs"
                />
                {form.expires_at_local && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setForm(f => ({ ...f, expires_at_local: '' }))}
                  >
                    Clear
                  </Button>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground">
                When set, the promo is hidden from customers after this moment.
                Leave blank for no expiry.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>Categories</Label>
              {categories && categories.length > 0 ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 rounded-md border p-3">
                  {categories.map(c => {
                    const checked = form.selectedCategoryIds.includes(c.id);
                    return (
                      <label
                        key={c.id}
                        className="flex items-center gap-2 text-sm cursor-pointer hover:text-primary"
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() => toggleCategorySelection(c.id)}
                        />
                        <span>{c.name}</span>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No categories yet. Create one in the Categories tab to assign it here.
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving || uploading}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation — plain-dialog pattern to avoid alert-dialog dependency */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete promotion?</DialogTitle>
            <DialogDescription>
              This will permanently remove "{deleteTarget?.title}". This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Category Add/Edit dialog */}
      <Dialog open={catDialogOpen} onOpenChange={setCatDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingCategory ? 'Edit Category' : 'New Category'}</DialogTitle>
            <DialogDescription>
              {editingCategory ? 'Update this category.' : 'Create a new promo category.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="cat-name">Name *</Label>
              <Input
                id="cat-name"
                value={catForm.name}
                onChange={e => setCatForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Secret Vault"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cat-order">Display order</Label>
              <Input
                id="cat-order"
                type="number"
                value={catForm.display_order}
                onChange={e => setCatForm(f => ({ ...f, display_order: Number(e.target.value) || 0 }))}
              />
              <p className="text-[11px] text-muted-foreground">Lower = shown first.</p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCatDialogOpen(false)} disabled={savingCategory}>
              Cancel
            </Button>
            <Button onClick={handleSaveCategory} disabled={savingCategory}>
              {savingCategory ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Category Delete confirmation — plain Dialog */}
      <Dialog open={!!deleteCategoryTarget} onOpenChange={(o) => !o && setDeleteCategoryTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete category?</DialogTitle>
            <DialogDescription>
              This will permanently remove "{deleteCategoryTarget?.name}" and unassign it
              from all promos. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteCategoryTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDeleteCategory}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
