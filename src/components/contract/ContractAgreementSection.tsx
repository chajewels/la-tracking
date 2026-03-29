import { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { FileText, Link as LinkIcon, Eye } from 'lucide-react';

interface Props {
  accountId: string;
}

interface Signature {
  id: string;
  full_name: string;
  email: string;
  facebook_name: string;
  country: string;
  signature_image: string;
  signed_at: string;
  agreement_version: string;
}

interface UnlinkedSignature {
  id: string;
  full_name: string;
  email: string;
  country: string;
  signed_at: string;
}

export default function ContractAgreementSection({ accountId }: Props) {
  const queryClient = useQueryClient();
  const [viewOpen, setViewOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [debounceTimer, setDebounceTimer] = useState<ReturnType<typeof setTimeout> | null>(null);
  const [confirmSig, setConfirmSig] = useState<UnlinkedSignature | null>(null);
  const [linking, setLinking] = useState(false);

  const { data: signature, isLoading } = useQuery({
    queryKey: ['signature', accountId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('layaway_signatures')
        .select('id, full_name, email, facebook_name, country, signature_image, signed_at, agreement_version')
        .eq('account_id', accountId)
        .order('signed_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as Signature | null;
    },
  });

  const { data: searchResults } = useQuery({
    queryKey: ['unlinked-signatures', debouncedQuery],
    queryFn: async () => {
      if (!debouncedQuery || debouncedQuery.length < 2) return [];
      const { data, error } = await supabase
        .from('layaway_signatures')
        .select('id, full_name, email, country, signed_at')
        .is('account_id', null)
        .or(`full_name.ilike.%${debouncedQuery}%,email.ilike.%${debouncedQuery}%`)
        .order('signed_at', { ascending: false })
        .limit(10);
      if (error) throw error;
      return (data || []) as UnlinkedSignature[];
    },
    enabled: linkOpen && debouncedQuery.length >= 2,
  });

  const handleSearchChange = useCallback((val: string) => {
    setSearchQuery(val);
    if (debounceTimer) clearTimeout(debounceTimer);
    const timer = setTimeout(() => setDebouncedQuery(val), 300);
    setDebounceTimer(timer);
  }, [debounceTimer]);

  const handleLink = useCallback(async () => {
    if (!confirmSig) return;
    setLinking(true);
    try {
      const { error } = await supabase
        .from('layaway_signatures')
        .update({ account_id: accountId })
        .eq('id', confirmSig.id)
        .is('account_id', null);
      if (error) throw error;
      toast.success('Signature linked successfully');
      setConfirmSig(null);
      setLinkOpen(false);
      setSearchQuery('');
      setDebouncedQuery('');
      queryClient.invalidateQueries({ queryKey: ['signature', accountId] });
    } catch (err: any) {
      toast.error(err.message || 'Failed to link signature');
    } finally {
      setLinking(false);
    }
  }, [confirmSig, accountId, queryClient]);

  if (isLoading) return null;

  return (
    <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <h3 className="text-sm font-semibold text-card-foreground mb-4 flex items-center gap-2">
        <FileText className="h-4 w-4" /> 📜 Contract & Agreement
      </h3>

      {signature ? (
        <>
          <Badge className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 mb-4">
            ✅ Contract Signed
          </Badge>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm mb-4">
            <div>
              <span className="text-muted-foreground">Full Name:</span>
              <p className="font-medium text-card-foreground">{signature.full_name}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Email:</span>
              <p className="font-medium text-card-foreground">{signature.email}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Facebook:</span>
              <p className="font-medium text-card-foreground">{signature.facebook_name}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Country:</span>
              <p className="font-medium text-card-foreground">{signature.country}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Signed:</span>
              <p className="font-medium text-card-foreground">
                {format(new Date(signature.signed_at), 'MMM dd, yyyy h:mm a')}
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">Agreement:</span>
              <p className="font-medium text-card-foreground">{signature.agreement_version}</p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setViewOpen(true)}
            className="border-yellow-500/50 text-yellow-700 hover:bg-yellow-50 dark:text-yellow-400 dark:hover:bg-yellow-900/20"
          >
            <Eye className="h-3.5 w-3.5 mr-1.5" /> View Signature
          </Button>

          {/* View Signature Modal */}
          <Dialog open={viewOpen} onOpenChange={setViewOpen}>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>Customer Signature — {signature.full_name}</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <img
                  src={signature.signature_image}
                  alt="Customer signature"
                  className="w-full rounded-lg border border-border"
                />
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <div><span className="text-muted-foreground">Email:</span> <span>{signature.email}</span></div>
                  <div><span className="text-muted-foreground">Facebook:</span> <span>{signature.facebook_name}</span></div>
                  <div><span className="text-muted-foreground">Country:</span> <span>{signature.country}</span></div>
                  <div><span className="text-muted-foreground">Signed:</span> <span>{format(new Date(signature.signed_at), 'MMM dd, yyyy h:mm a')}</span></div>
                  <div><span className="text-muted-foreground">Agreement:</span> <span>{signature.agreement_version}</span></div>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setViewOpen(false)}>Close</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      ) : (
        <>
          <Badge variant="secondary" className="mb-4">⚪ No signed contract on file</Badge>
          <p className="text-sm text-muted-foreground italic mb-4">
            Payment implies agreement per Article VII.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setLinkOpen(true)}
          >
            <LinkIcon className="h-3.5 w-3.5 mr-1.5" /> Link Signature
          </Button>

          {/* Link Signature Dialog */}
          <Dialog open={linkOpen} onOpenChange={(open) => {
            setLinkOpen(open);
            if (!open) { setSearchQuery(''); setDebouncedQuery(''); }
          }}>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Link Signature to Account</DialogTitle>
              </DialogHeader>
              <Input
                placeholder="Search by name or email"
                value={searchQuery}
                onChange={(e) => handleSearchChange(e.target.value)}
                autoFocus
              />
              <div className="max-h-60 overflow-y-auto space-y-1 mt-2">
                {debouncedQuery.length < 2 ? (
                  <p className="text-xs text-muted-foreground text-center py-4">Type at least 2 characters to search</p>
                ) : !searchResults || searchResults.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-4">No unlinked signatures found</p>
                ) : (
                  searchResults.map((sig) => (
                    <button
                      key={sig.id}
                      onClick={() => setConfirmSig(sig)}
                      className="w-full text-left px-3 py-2 rounded-lg hover:bg-muted/60 transition text-sm border border-transparent hover:border-border"
                    >
                      <span className="font-medium">{sig.full_name}</span>
                      <span className="text-muted-foreground"> — {sig.email} — {sig.country} — {format(new Date(sig.signed_at), 'MMM dd, yyyy')}</span>
                    </button>
                  ))
                )}
              </div>
            </DialogContent>
          </Dialog>

          {/* Confirm Link Dialog */}
          <AlertDialog open={!!confirmSig} onOpenChange={(open) => { if (!open) setConfirmSig(null); }}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Link Signature</AlertDialogTitle>
                <AlertDialogDescription>
                  Link signature from <strong>{confirmSig?.full_name}</strong> ({confirmSig?.email}) to this account?
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={linking}>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleLink} disabled={linking}>
                  {linking ? 'Linking...' : 'Confirm'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </div>
  );
}
