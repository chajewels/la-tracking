import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { UserPlus } from 'lucide-react';
import { useCreateCustomer, DbCustomer } from '@/hooks/use-supabase-data';
import { toast } from 'sonner';
import CountrySelect from '@/components/customers/CountrySelect';
import { LocationType, toLocationString } from '@/lib/countries';

interface NewCustomerDialogProps {
  onCreated?: (customer: DbCustomer) => void;
  trigger?: React.ReactNode;
}

export default function NewCustomerDialog({ onCreated, trigger }: NewCustomerDialogProps) {
  const [open, setOpen] = useState(false);
  const createCustomer = useCreateCustomer();

  const [fullName, setFullName] = useState('');
  const [customerCode, setCustomerCode] = useState('');
  const [facebookName, setFacebookName] = useState('');
  const [messengerLink, setMessengerLink] = useState('');
  const [mobileNumber, setMobileNumber] = useState('');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [locationType, setLocationType] = useState<LocationType>('japan');
  const [country, setCountry] = useState('');

  const resetForm = () => {
    setFullName('');
    setCustomerCode('');
    setFacebookName('');
    setMessengerLink('');
    setMobileNumber('');
    setEmail('');
    setNotes('');
    setLocationType('japan');
    setCountry('');
  };

  const handleLocationChange = (v: string) => {
    const lt = v as LocationType;
    setLocationType(lt);
    if (lt !== 'international') setCountry('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fullName.trim() || !customerCode.trim()) {
      toast.error('Full name and customer code are required');
      return;
    }
    if (locationType === 'international' && !country.trim()) {
      toast.error('Please select a country');
      return;
    }
    const location = toLocationString(locationType, country) || undefined;
    try {
      const customer = await createCustomer.mutateAsync({
        full_name: fullName.trim(),
        customer_code: customerCode.trim(),
        facebook_name: facebookName.trim() || undefined,
        messenger_link: messengerLink.trim() || undefined,
        mobile_number: mobileNumber.trim() || undefined,
        email: email.trim() || undefined,
        notes: notes.trim() || undefined,
        location,
      });
      toast.success(`Customer "${fullName}" created`);
      onCreated?.(customer as DbCustomer);
      resetForm();
      setOpen(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to create customer');
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button className="gold-gradient text-primary-foreground font-medium">
            <UserPlus className="h-4 w-4 mr-2" />
            New Customer
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display">New Customer</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Full Name *</Label>
              <Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="e.g. Maria Santos" />
            </div>
            <div className="space-y-2">
              <Label>Customer Code *</Label>
              <Input value={customerCode} onChange={(e) => setCustomerCode(e.target.value)} placeholder="e.g. CUST-001" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
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
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Facebook Name</Label>
              <Input value={facebookName} onChange={(e) => setFacebookName(e.target.value)} placeholder="Facebook display name" />
            </div>
            <div className="space-y-2">
              <Label>Messenger Link</Label>
              <Input value={messengerLink} onChange={(e) => setMessengerLink(e.target.value)} placeholder="m.me/username" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
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
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={createCustomer.isPending} className="gold-gradient text-primary-foreground font-medium">
              {createCustomer.isPending ? 'Creating…' : 'Create Customer'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}