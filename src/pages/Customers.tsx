import { useState } from 'react';
import { Users, MessageCircle, Search, Pencil, Check, X } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const queryClient = useQueryClient();

  const filtered = (customers || [])
    .filter(c =>
      c.full_name.toLowerCase().includes(search.toLowerCase()) ||
      (c.facebook_name || '').toLowerCase().includes(search.toLowerCase()) ||
      (c.customer_code || '').toLowerCase().includes(search.toLowerCase())
    )
    .sort((a, b) => a.full_name.localeCompare(b.full_name));

  const startEdit = (id: string, name: string) => {
    setEditingId(id);
    setEditName(name);
  };

  const saveEdit = async (id: string) => {
    if (!editName.trim()) return;
    try {
      const { error } = await supabase.from('customers').update({ full_name: editName.trim() }).eq('id', id);
      if (error) throw error;
      toast.success('Name updated');
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      setEditingId(null);
    } catch (err: any) {
      toast.error(err.message || 'Failed to update name');
    }
  };

  const cancelEdit = () => setEditingId(null);

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
                  const accountCount = (accounts || []).filter(a => a.customer_id === c.id).length;
                  const isEditing = editingId === c.id;
                  return (
                    <tr key={c.id} className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors">
                      <td className="px-5 py-3">
                        {isEditing ? (
                          <div className="flex items-center gap-2">
                            <Input
                              value={editName}
                              onChange={e => setEditName(e.target.value)}
                              className="h-8 text-sm"
                              autoFocus
                              onKeyDown={e => {
                                if (e.key === 'Enter') saveEdit(c.id);
                                if (e.key === 'Escape') cancelEdit();
                              }}
                            />
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-emerald-500" onClick={() => saveEdit(c.id)}><Check className="h-3.5 w-3.5" /></Button>
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={cancelEdit}><X className="h-3.5 w-3.5" /></Button>
                          </div>
                        ) : (
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
                            <Button variant="ghost" size="icon" className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground" onClick={() => startEdit(c.id, c.full_name)}>
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-3 text-sm text-muted-foreground">{(c as any).location || '—'}</td>
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
    </AppLayout>
  );
}
