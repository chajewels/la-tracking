import { useState } from 'react';
import { Users, MessageCircle, Search, Pencil, Trash2 } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { useCustomers, useAccounts } from '@/hooks/use-supabase-data';
import { Skeleton } from '@/components/ui/skeleton';
import { Link } from 'react-router-dom';
import NewCustomerDialog from '@/components/customers/NewCustomerDialog';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';

export default function Customers() {
  const { data: customers, isLoading } = useCustomers();
  const { data: accounts } = useAccounts();
  const [search, setSearch] = useState('');
  const queryClient = useQueryClient();

  // Edit dialog state
  const [editOpen, setEditOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    full_name: '',
    customer_code: '',
    facebook_name: '',
    messenger_link: '',
    mobile_number: '',
    email: '',
    notes: '',
    locationType: 'japan' as 'japan' | 'international',
    country: '',
  });
  const [saving, setSaving] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const resp = await supabase.functions.invoke('delete-customer', {
        body: { customer_id: deleteTarget.id },
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      if (resp.error || resp.data?.error) throw new Error(resp.data?.error || resp.error?.message);
      toast.success(`Customer "${deleteTarget.name}" deleted`);
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      setDeleteConfirmOpen(false);
      setEditOpen(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete');
    } finally {
      setDeleting(false);
    }
  };

  const filtered = (customers || [])
    .filter(c =>
      c.full_name.toLowerCase().includes(search.toLowerCase()) ||
      (c.facebook_name || '').toLowerCase().includes(search.toLowerCase()) ||
      (c.customer_code || '').toLowerCase().includes(search.toLowerCase())
    )
    .sort((a, b) => a.full_name.localeCompare(b.full_name));

  const openEdit = (c: any) => {
    const loc = (c.location || '').trim();
    const isJapan = !loc || loc.toLowerCase() === 'japan';
    setEditId(c.id);
    setEditForm({
      full_name: c.full_name || '',
      customer_code: c.customer_code || '',
      facebook_name: c.facebook_name || '',
      messenger_link: c.messenger_link || '',
      mobile_number: c.mobile_number || '',
      email: c.email || '',
      notes: c.notes || '',
      locationType: isJapan ? 'japan' : 'international',
      country: isJapan ? '' : loc,
    });
    setEditOpen(true);
  };

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editId || !editForm.full_name.trim()) return;
    setSaving(true);
    const location = editForm.locationType === 'japan' ? 'Japan' : editForm.country.trim() || null;
    try {
      const { error } = await supabase.from('customers').update({
        full_name: editForm.full_name.trim(),
        customer_code: editForm.customer_code.trim(),
        facebook_name: editForm.facebook_name.trim() || null,
        messenger_link: editForm.messenger_link.trim() || null,
        mobile_number: editForm.mobile_number.trim() || null,
        email: editForm.email.trim() || null,
        notes: editForm.notes.trim() || null,
        location,
      }).eq('id', editId);
      if (error) throw error;
      toast.success('Customer updated');
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      setEditOpen(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to update');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Users className="h-5 w-5 text-primary" />
            <div>
              <h1 className="text-2xl font-bold text-foreground font-display">Customers</h1>
              <p className="text-sm text-muted-foreground mt-0.5">{filtered.length} customers</p>
            </div>
          </div>
          <NewCustomerDialog />
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name, code, or Facebook name…"
            className="pl-9"
          />
        </div>

        <div className="rounded-xl border border-border bg-card overflow-hidden">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="text-left px-5 py-3 text-xs font-semibold text-muted-foreground uppercase">Customer</th>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-muted-foreground uppercase">Location</th>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-muted-foreground uppercase">Contact</th>
                  <th className="text-center px-5 py-3 text-xs font-semibold text-muted-foreground uppercase">Accounts</th>
                  <th className="text-center px-5 py-3 text-xs font-semibold text-muted-foreground uppercase">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr><td colSpan={5} className="px-5 py-8 text-center text-sm text-muted-foreground">No customers found</td></tr>
                ) : filtered.map(c => {
                  const accountCount = (accounts || []).filter(a => a.customer_id === c.id && a.status !== 'forfeited' && a.status !== 'cancelled').length;
                  return (
                    <tr key={c.id} className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-3 group">
                          <Link to={`/customers/${c.id}`} className="flex items-center gap-3 flex-1">
                            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary text-sm font-bold">
                              {c.full_name.charAt(0)}
                            </div>
                            <div>
                              <p className="text-sm font-medium text-card-foreground group-hover:text-primary transition-colors">{c.full_name}</p>
                              {c.facebook_name && <p className="text-xs text-muted-foreground">@{c.facebook_name}</p>}
                            </div>
                          </Link>
                          <Button variant="ghost" size="icon" className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground" onClick={() => openEdit(c)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </td>
                      <td className="px-5 py-3 text-sm text-muted-foreground">{c.location || '—'}</td>
                      <td className="px-5 py-3 text-sm text-muted-foreground">{c.mobile_number || '—'}</td>
                      <td className="px-5 py-3 text-center text-sm text-card-foreground">{accountCount}</td>
                      <td className="px-5 py-3 text-center">
                        {c.messenger_link && (
                          <a href={c.messenger_link} target="_blank" rel="noopener noreferrer">
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-info">
                              <MessageCircle className="h-4 w-4" />
                            </Button>
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Edit Customer Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-display">Edit Customer</DialogTitle>
          </DialogHeader>
          <form onSubmit={saveEdit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Full Name *</Label>
                <Input value={editForm.full_name} onChange={e => setEditForm(f => ({ ...f, full_name: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>Customer Code</Label>
                <Input value={editForm.customer_code} onChange={e => setEditForm(f => ({ ...f, customer_code: e.target.value }))} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Location</Label>
                <Select value={editForm.locationType} onValueChange={v => setEditForm(f => ({ ...f, locationType: v as 'japan' | 'international' }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="japan">Japan</SelectItem>
                    <SelectItem value="international">International</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {editForm.locationType === 'international' && (
                <div className="space-y-2">
                  <Label>Country</Label>
                  <Input value={editForm.country} onChange={e => setEditForm(f => ({ ...f, country: e.target.value }))} placeholder="e.g. Philippines" />
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Facebook Name</Label>
                <Input value={editForm.facebook_name} onChange={e => setEditForm(f => ({ ...f, facebook_name: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>Messenger Link</Label>
                <Input value={editForm.messenger_link} onChange={e => setEditForm(f => ({ ...f, messenger_link: e.target.value }))} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Mobile Number</Label>
                <Input value={editForm.mobile_number} onChange={e => setEditForm(f => ({ ...f, mobile_number: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>Email</Label>
                <Input type="email" value={editForm.email} onChange={e => setEditForm(f => ({ ...f, email: e.target.value }))} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea value={editForm.notes} onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))} rows={2} />
            </div>
            <div className="flex justify-between pt-2">
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => {
                  setDeleteTarget({ id: editId!, name: editForm.full_name });
                  setDeleteConfirmOpen(true);
                }}
                disabled={saving}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                Delete
              </Button>
              <div className="flex gap-3">
                <Button type="button" variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={saving} className="gold-gradient text-primary-foreground font-medium">
                  {saving ? 'Saving…' : 'Save Changes'}
                </Button>
              </div>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Customer</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{deleteTarget?.name}</strong>? This cannot be undone. Customers with linked accounts cannot be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={deleting} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {deleting ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}