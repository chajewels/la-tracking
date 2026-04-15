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
  media_url: string | null;
  media_type: 'image' | 'video' | null;
}

const EMPTY_FORM: PromoFormState = {
  title: '',
  description: '',
  link_url: '',
  display_order: 0,
  is_active: true,
  media_url: null,
  media_type: null,
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
    setForm({
      title: p.title,
      description: p.description ?? '',
      link_url: p.link_url ?? '',
      display_order: p.display_order,
      is_active: p.is_active,
      media_url: p.media_url,
      media_type: p.media_type,
    });
    setDialogOpen(true);
  }

  async function handleUpload(file: File) {
    if (!file) return;
    const isVideo = file.type.startsWith('video/');
    const isImage = file.type.startsWith('image/');
    if (!isVideo && !isImage) {
      toast.error('Please select an image or video file.');
      return;
    }
    setUploading(true);
    try {
      const ext = file.name.split('.').pop() || (isVideo ? 'mp4' : 'jpg');
      const path = `promo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const { error } = await supabase.storage
        .from('promotions')
        .upload(path, file, { upsert: false, contentType: file.type });
      if (error) throw error;
      const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/promotions/${path}`;
      setForm(f => ({ ...f, media_url: publicUrl, media_type: isVideo ? 'video' : 'image' }));
      toast.success('Media uploaded.');
    } catch (err: any) {
      toast.error(`Upload failed: ${err.message || err}`);
    } finally {
      setUploading(false);
    }
  }

  async function handleSave() {
    if (!form.title.trim()) {
      toast.error('Title is required.');
      return;
    }
    setSaving(true);
    try {
      const payload: any = {
        title: form.title.trim(),
        description: form.description.trim() || null,
        link_url: form.link_url.trim() || null,
        display_order: Number(form.display_order) || 0,
        is_active: form.is_active,
        media_url: form.media_url,
        media_type: form.media_type,
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
              <Label>Media (image or video)</Label>
              <div className="flex items-center gap-3">
                <label
                  className="inline-flex items-center gap-2 px-3 py-2 border rounded-md cursor-pointer hover:bg-muted text-sm"
                >
                  <Upload className="h-4 w-4" />
                  {uploading ? 'Uploading…' : form.media_url ? 'Replace file' : 'Upload file'}
                  <input
                    type="file"
                    accept="image/*,video/*"
                    className="hidden"
                    disabled={uploading}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleUpload(f);
                      e.target.value = '';
                    }}
                  />
                </label>
                {form.media_url && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {form.media_type === 'video' ? <Video className="h-3 w-3" /> : <ImageIcon className="h-3 w-3" />}
                    <span className="truncate max-w-[200px]">{form.media_url.split('/').pop()}</span>
                  </div>
                )}
              </div>
              {form.media_url && (
                <div className="mt-2 rounded-md border overflow-hidden max-h-40 bg-muted flex items-center justify-center">
                  {form.media_type === 'video' ? (
                    <video src={form.media_url} className="max-h-40" controls muted />
                  ) : (
                    <img src={form.media_url} alt="preview" className="max-h-40" />
                  )}
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
