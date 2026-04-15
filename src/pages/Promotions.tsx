import { useState } from 'react';
import { Megaphone, Plus, Pencil, Trash2, Upload, Image as ImageIcon, Video, ExternalLink } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
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
};

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;

export default function Promotions() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Promotion | null>(null);
  const [form, setForm] = useState<PromoFormState>(EMPTY_FORM);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Promotion | null>(null);

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

  function openEdit(p: Promotion) {
    setEditing(p);
    const isImage = p.media_type === 'image';
    const isVideo = p.media_type === 'video';
    setForm({
      title: p.title,
      description: p.description ?? '',
      link_url: p.link_url ?? '',
      display_order: p.display_order,
      is_active: p.is_active,
      media_type: p.media_type,
      images: isImage ? parseImageUrls(p.media_url) : [],
      video_url: isVideo ? p.media_url : null,
    });
    setDialogOpen(true);
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
      };
      if (editing) {
        const { error } = await (supabase.from('promotions' as any) as any)
          .update(payload)
          .eq('id', editing.id);
        if (error) throw error;
        toast.success('Promotion updated.');
      } else {
        payload.created_by = user?.id ?? null;
        const { error } = await (supabase.from('promotions' as any) as any).insert(payload);
        if (error) throw error;
        toast.success('Promotion created.');
      }
      setDialogOpen(false);
      queryClient.invalidateQueries({ queryKey: ['promotions-admin'] });
      queryClient.invalidateQueries({ queryKey: ['promotions-active'] });
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
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4 mr-2" />
            Add Promo
          </Button>
        </div>

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
                  <TableHead>Created by</TableHead>
                  <TableHead>Created at</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {promos.map(p => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">
                      <div className="flex flex-col">
                        <span>{p.title}</span>
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
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="p-12 text-center text-muted-foreground">
              <Megaphone className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p>No promotions yet. Click "Add Promo" to create one.</p>
            </div>
          )}
        </div>
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
    </AppLayout>
  );
}
