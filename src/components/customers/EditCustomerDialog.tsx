import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';

interface EditForm {
  full_name: string; customer_code: string; facebook_name: string; messenger_link: string;
  mobile_number: string; email: string; notes: string;
  locationType: 'japan' | 'international'; country: string;
}

interface EditCustomerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editId: string | null;
  editForm: EditForm;
  setEditForm: React.Dispatch<React.SetStateAction<EditForm>>;
}

export default function EditCustomerDialog({ open, onOpenChange, editId, editForm, setEditForm }: EditCustomerDialogProps) {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    if (!editId) return;
    setDeleting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const resp = await supabase.functions.invoke('delete-customer', {
        body: { customer_id: editId },
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      if (resp.error || resp.data?.error) throw new Error(resp.data?.error || resp.error?.message);
      toast.success(`Customer "${editForm.full_name}" deleted`);
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      setDeleteConfirmOpen(false);
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete');
    } finally {
      setDeleting(false);
    }
  };

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editId || !editForm.full_name.trim()) return;
    setSaving(true);
    const location = editForm.locationType === 'japan' ? 'Japan' : editForm.country.trim() || null;
    try {
      const { error } = await supabase.from('customers').update({
        full_name: editForm.full_name.trim(), customer_code: editForm.customer_code.trim(),
        facebook_name: editForm.facebook_name.trim() || null, messenger_link: editForm.messenger_link.trim() || null,
        mobile_number: editForm.mobile_number.trim() || null, email: editForm.email.trim() || null,
        notes: editForm.notes.trim() || null, location,
      }).eq('id', editId);
      if (error) throw error;
      toast.success('Customer updated');
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to update');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
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
              <Button type="button" variant="destructive" size="sm"
                onClick={() => setDeleteConfirmOpen(true)}
                disabled={saving}>
                <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Delete
              </Button>
              <div className="flex gap-3">
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
                <Button type="submit" disabled={saving} className="gold-gradient text-primary-foreground font-medium">
                  {saving ? 'Saving…' : 'Save Changes'}
                </Button>
              </div>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Customer</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{editForm.full_name}</strong>? This cannot be undone. Customers with linked accounts cannot be deleted.
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
    </>
  );
}
