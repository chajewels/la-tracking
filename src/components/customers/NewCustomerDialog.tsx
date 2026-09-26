import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { UserPlus } from 'lucide-react';
import DecoDialogHeader, { decoTitleClass } from '@/components/shared/DecoDialogHeader';
import { useCreateCustomer, DbCustomer } from '@/hooks/use-supabase-data';
import { toast } from 'sonner';
import CountrySelect from '@/components/customers/CountrySelect';
import { LocationType, toLocationString } from '@/lib/countries';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import CustomerMatchList from '@/components/customers/CustomerMatchList';
import { blankToNull, type CustomerMatch, type FindCustomerMatchesRpc } from '@/lib/customer-matches';

interface NewCustomerDialogProps {
  onCreated?: (customer: DbCustomer) => void;
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  initialFullName?: string;
  /** Seeds Facebook Name when the dialog opens (Page365 import passes the invoice name). */
  initialFacebookName?: string;
}

export default function NewCustomerDialog({ onCreated, trigger, open, onOpenChange, initialFullName, initialFacebookName }: NewCustomerDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : internalOpen;
  const setIsOpen = isControlled
    ? (v: boolean) => onOpenChange?.(v)
    : setInternalOpen;
  const createCustomer = useCreateCustomer();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [fullName, setFullName] = useState(initialFullName ?? '');
  const [facebookName, setFacebookName] = useState(initialFacebookName ?? '');
  const [messengerLink, setMessengerLink] = useState('');
  const [mobileNumber, setMobileNumber] = useState('');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [locationType, setLocationType] = useState<LocationType>('japan');
  const [country, setCountry] = useState('');
  // Duplicate-customer prevention (owner rules 2026-09-23). A match BLOCKS the
  // create — there is no "create anyway". Staff confirm the details with the
  // customer and use the existing account, or correct the form and submit
  // again (which re-runs the check).
  const [matches, setMatches] = useState<CustomerMatch[]>([]);
  const [checking, setChecking] = useState(false);
  const [usingId, setUsingId] = useState<string | null>(null);

  // When opened with a fresh initialFullName, seed the field. Skipped while the
  // dialog is closed so the user's in-progress typing isn't clobbered.
  useEffect(() => {
    if (isOpen && initialFullName) {
      setFullName(initialFullName);
    }
  }, [isOpen, initialFullName]);

  // Same rule for Facebook Name.
  useEffect(() => {
    if (isOpen && initialFacebookName) {
      setFacebookName(initialFacebookName);
    }
  }, [isOpen, initialFacebookName]);

  // A match list belongs to one attempt; never show it on a reopened dialog.
  useEffect(() => {
    if (!isOpen) setMatches([]);
  }, [isOpen]);

  const resetForm = () => {
    setFullName('');
    setFacebookName('');
    setMessengerLink('');
    setMobileNumber('');
    setEmail('');
    setNotes('');
    setLocationType('japan');
    setCountry('');
    setMatches([]);
  };

  const handleLocationChange = (v: string) => {
    const lt = v as LocationType;
    setLocationType(lt);
    if (lt !== 'international') setCountry('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fullName.trim()) {
      toast.error('Full name is required');
      return;
    }
    if (locationType === 'international' && !country.trim()) {
      toast.error('Please select a country');
      return;
    }
    const location = toLocationString(locationType, country) || undefined;

    // Check BEFORE creating. A failed check never falls through to the create.
    setChecking(true);
    const { data: found, error: checkErr } = await (supabase.rpc as unknown as FindCustomerMatchesRpc)(
      'find_customer_matches',
      {
        p_full_name: blankToNull(fullName),
        p_facebook_name: blankToNull(facebookName),
        p_mobile: blankToNull(mobileNumber),
        p_email: blankToNull(email),
      },
    );
    setChecking(false);
    if (checkErr) {
      toast.error(`Could not check for existing customers — nothing was created. ${checkErr.message}`);
      return;
    }
    if (found && found.length > 0) {
      setMatches(found);
      return;
    }
    setMatches([]);

    try {
      const customer = await createCustomer.mutateAsync({
        full_name: fullName.trim(),
        facebook_name: facebookName.trim() || undefined,
        messenger_link: messengerLink.trim() || undefined,
        mobile_number: mobileNumber.trim() || undefined,
        email: email.trim() || undefined,
        notes: notes.trim() || undefined,
        location,
      });
      toast.success(`Customer created! Code: ${customer.customer_code}`);
      onCreated?.(customer as DbCustomer);
      resetForm();
      setIsOpen(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to create customer');
    }
  };

  const handleUseExisting = async (match: CustomerMatch) => {
    setUsingId(match.customer_id);
    try {
      // Same columns the callers get from a create (select('*') = DbCustomer).
      const { data: existing, error: loadErr } = await supabase
        .from('customers')
        .select('*')
        .eq('id', match.customer_id)
        .single();
      if (loadErr || !existing) throw new Error(loadErr?.message || 'Customer not found');

      const { error: auditErr } = await supabase.from('audit_logs').insert({
        entity_type: 'customer',
        entity_id: match.customer_id,
        action: 'duplicate_prevented',
        performed_by_user_id: user?.id ?? null,
        new_value_json: {
          source: 'new_customer_dialog',
          typed: {
            full_name: blankToNull(fullName),
            facebook_name: blankToNull(facebookName),
            messenger_link: blankToNull(messengerLink),
            mobile_number: blankToNull(mobileNumber),
            email: blankToNull(email),
            location: toLocationString(locationType, country),
          },
          matched_on: match.matched_on,
          customer_code: match.customer_code,
        },
      });
      if (auditErr) throw new Error(`Could not record the audit entry: ${auditErr.message}`);

      toast.success(`Using existing customer ${existing.customer_code ?? existing.full_name}`);
      resetForm();
      setIsOpen(false);
      if (onCreated) {
        onCreated(existing as DbCustomer);
      } else {
        navigate(`/customers/${existing.id}`);
      }
    } catch (err) {
      toast.error((err as Error)?.message || 'Failed to load the existing customer');
    } finally {
      setUsingId(null);
    }
  };

  const busy = checking || createCustomer.isPending;

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      {!isControlled && (
        <DialogTrigger asChild>
          {trigger || (
            <Button className="gold-gradient text-primary-foreground font-medium">
              <UserPlus className="h-4 w-4 mr-2" />
              New Customer
            </Button>
          )}
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader className="text-left">
          <DecoDialogHeader icon={<UserPlus />} title={<DialogTitle className={decoTitleClass}>New Customer</DialogTitle>} />
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>Full Name *</Label>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="e.g. Maria Santos" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Location</Label>
              <Select value={locationType} onValueChange={handleLocationChange}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="japan">Japan</SelectItem>
                  <SelectItem value="philippines">Philippines</SelectItem>
                  <SelectItem value="international">International</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {locationType === 'international' && (
              <div className="space-y-2">
                <Label>Country *</Label>
                <CountrySelect value={country} onValueChange={setCountry} />
                <p className="text-xs text-muted-foreground">Please select your country for delivery and payment coordination.</p>
              </div>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Facebook Name</Label>
              <Input value={facebookName} onChange={(e) => setFacebookName(e.target.value)} placeholder="Facebook display name" />
            </div>
            <div className="space-y-2">
              <Label>Messenger Link</Label>
              <Input value={messengerLink} onChange={(e) => setMessengerLink(e.target.value)} placeholder="m.me/username" />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Mobile Number</Label>
              <Input value={mobileNumber} onChange={(e) => setMobileNumber(e.target.value)} placeholder="+63 xxx xxx xxxx" />
            </div>
            <div className="space-y-2">
              <Label>Email</Label>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@example.com" />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Notes</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional notes..." rows={2} />
          </div>
          {matches.length > 0 && (
            <CustomerMatchList
              matches={matches}
              description="This customer was NOT created. Confirm the details with the customer and use the existing account. If the form is wrong, correct it and submit again to re-check."
              onUse={handleUseExisting}
              usingId={usingId}
            />
          )}
          <div className="flex justify-end gap-3 pt-4 hairline-t">
            <Button type="button" variant="outline" onClick={() => setIsOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !!usingId} className="gold-gradient text-primary-foreground font-medium">
              {checking ? 'Checking…' : createCustomer.isPending ? 'Creating…' : matches.length > 0 ? 'Re-check & Create' : 'Create Customer'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}