import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Megaphone, Plus, Pencil, Trash2, Loader2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';

interface Announcement {
  id: string;
  title: string;
  content: string;
  image_url: string | null;
  link_url: string | null;
  link_label: string | null;
  is_active: boolean;
  show_once: boolean;
  created_by: string | null;
  created_at: string;
}

const EMPTY: Partial<Announcement> = {
  title: '', content: '', image_url: null, link_url: null, link_label: null, is_active: true, show_once: true,
};

export default function Announcements() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [editOpen, setEditOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Announcement | null>(null);
  const [form, setForm] = useState<Partial<Announcement>>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [imageFile, setImageFile] = useState<File | null>(null);

  const { data: announcements, isLoading } = useQuery({
    queryKey: ['announcements'],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('announcements')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []) as Announcement[];
    },
  });

  const openNew = () => { setForm({ ...EMPTY }); setImageFile(null); setEditOpen(true); };
  const openEdit = (a: Announcement) => { setForm({ ...a }); setImageFile(null); setEditOpen(true); };

  const handleSave = async () => {
    if (!form.title?.trim() || !form.content?.trim()) { toast.error('Title and content are required'); return; }
    setSaving(true);
    try {
      let imageUrl = form.image_url || null;
      if (imageFile) {
        const ext = (imageFile.name.split('.').pop() || 'jpg').toLowerCase();
        const path = `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
        const { error: upErr } = await supabase.storage.from('announcements').upload(path, imageFile, { cacheControl: '3600', upsert: true });
        if (upErr) throw upErr;
        const { data: urlData } = supabase.storage.from('announcements').getPublicUrl(path);
        imageUrl = urlData.publicUrl;
      }
      const payload = {
        title: form.title!.trim(),
        content: form.content!.trim(),
        image_url: imageUrl,
        link_url: form.link_url?.trim() || null,
        link_label: form.link_label?.trim() || null,
        is_active: form.is_active ?? true,
        show_once: form.show_once ?? true,
      };
      if (form.id) {
        const { error } = await (supabase as any).from('announcements').update(payload).eq('id', form.id);
        if (error) throw error;
        toast.success('Announcement updated');
      } else {
        const { error } = await (supabase as any).from('announcements').insert({ ...payload, created_by: user?.id });
        if (error) throw error;
        toast.success('Announcement created');
      }
      queryClient.invalidateQueries({ queryKey: ['announcements'] });
      setEditOpen(false);
    } catch (err: any) {
      toast.error(err.message || 'Save failed');
    } finally { setSaving(false); }
  };

  const toggleActive = async (a: Announcement) => {
    await (supabase as any).from('announcements').update({ is_active: !a.is_active }).eq('id', a.id);
    queryClient.invalidateQueries({ queryKey: ['announcements'] });
  };

  const toggleShowOnce = async (a: Announcement) => {
    await (supabase as any).from('announcements').update({ show_once: !a.show_once }).eq('id', a.id);
    queryClient.invalidateQueries({ queryKey: ['announcements'] });
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const { error } = await (supabase as any).from('announcements').delete().eq('id', deleteTarget.id);
    if (error) { toast.error(error.message); return; }
    toast.success('Announcement deleted');
    setDeleteTarget(null);
    queryClient.invalidateQueries({ queryKey: ['announcements'] });
  };

  return (
    <AppLayout>
      <div className="p-4 sm:p-6 space-y-6 max-w-4xl mx-auto">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold font-display text-foreground flex items-center gap-2">
              <Megaphone className="h-6 w-6 text-primary" /> Announcements
            </h1>
            <p className="text-sm text-muted-foreground mt-1">Manage customer-facing announcements shown in the portal.</p>
          </div>
          <Button onClick={openNew} className="gold-gradient text-primary-foreground gap-1.5">
            <Plus className="h-4 w-4" /> Add Announcement
          </Button>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : !announcements || announcements.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">No announcements yet.</div>
        ) : (
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] text-muted-foreground uppercase border-b border-border bg-muted/30">
                  <th className="py-2.5 px-4">Title</th>
                  <th className="py-2.5 px-4 text-center">Active</th>
                  <th className="py-2.5 px-4 text-center">Show Once</th>
                  <th className="py-2.5 px-4">Created</th>
                  <th className="py-2.5 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {announcements.map(a => (
                  <tr key={a.id} className="border-b border-border/50 hover:bg-muted/20">
                    <td className="py-2 px-4">
                      <span className="font-medium text-foreground">{a.title}</span>
                      {a.image_url && <Badge variant="outline" className="ml-2 text-[9px]">📷</Badge>}
                      {a.link_url && <Badge variant="outline" className="ml-1 text-[9px]">🔗</Badge>}
                    </td>
                    <td className="py-2 px-4 text-center">
                      <Switch checked={a.is_active} onCheckedChange={() => toggleActive(a)} />
                    </td>
                    <td className="py-2 px-4 text-center">
                      <Switch checked={a.show_once} onCheckedChange={() => toggleShowOnce(a)} />
                    </td>
                    <td className="py-2 px-4 text-muted-foreground text-xs">
                      {new Date(a.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </td>
                    <td className="py-2 px-4 text-right">
                      <div className="inline-flex gap-1">
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(a)}><Pencil className="h-3 w-3" /></Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => setDeleteTarget(a)}><Trash2 className="h-3 w-3" /></Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Add/Edit Dialog */}
        <Dialog open={editOpen} onOpenChange={setEditOpen}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader><DialogTitle>{form.id ? 'Edit' : 'New'} Announcement</DialogTitle></DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2"><Label>Title *</Label><Input value={form.title || ''} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} /></div>
              <div className="space-y-2"><Label>Content *</Label><Textarea rows={4} value={form.content || ''} onChange={e => setForm(f => ({ ...f, content: e.target.value }))} /></div>
              <div className="space-y-2">
                <Label>Image (optional)</Label>
                {form.image_url && !imageFile && <img src={form.image_url} alt="" className="w-full max-h-32 object-cover rounded border border-border" />}
                <label className="flex items-center gap-2 rounded-md border border-dashed border-border bg-background/50 px-3 py-2 text-xs text-muted-foreground cursor-pointer hover:border-primary/50">
                  <Upload className="h-4 w-4" /> {imageFile ? imageFile.name : 'Choose image'}
                  <input type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) setImageFile(f); }} />
                </label>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2"><Label>Link URL</Label><Input value={form.link_url || ''} onChange={e => setForm(f => ({ ...f, link_url: e.target.value }))} placeholder="https://..." /></div>
                <div className="space-y-2"><Label>Link Label</Label><Input value={form.link_label || ''} onChange={e => setForm(f => ({ ...f, link_label: e.target.value }))} placeholder="Learn More" /></div>
              </div>
              <div className="flex items-center gap-6">
                <div className="flex items-center gap-2"><Switch checked={form.is_active ?? true} onCheckedChange={v => setForm(f => ({ ...f, is_active: v }))} /><Label>Active</Label></div>
                <div className="flex items-center gap-2"><Switch checked={form.show_once ?? true} onCheckedChange={v => setForm(f => ({ ...f, show_once: v }))} /><Label>Show Once</Label></div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
              <Button onClick={handleSave} disabled={saving} className="gold-gradient text-primary-foreground">
                {saving ? 'Saving…' : form.id ? 'Update' : 'Create'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete confirmation — plain Dialog, NOT AlertDialog */}
        <Dialog open={!!deleteTarget} onOpenChange={open => { if (!open) setDeleteTarget(null); }}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader><DialogTitle>Delete Announcement?</DialogTitle></DialogHeader>
            <p className="text-sm text-muted-foreground">This will permanently delete "{deleteTarget?.title}". This cannot be undone.</p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
              <Button variant="destructive" onClick={handleDelete}>Delete</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AppLayout>
  );
}
