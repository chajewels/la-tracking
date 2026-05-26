import { useState } from "react";
import { motion } from "framer-motion";
import { ChevronRight, LogOut, HelpCircle, Shield, Bell, FileText, MessageCircle, Crown, Calendar, X } from "lucide-react";
import { toast } from "sonner";
import { useLoyaltyData } from "@/components/loyalty/loyaltyData";
import ProfileMemberCard from "@/components/loyalty/ProfileMemberCard";
import { getPortalAuthHeaders } from "@/lib/portal-auth";
// TODO: wire to Supabase
import { FAQS } from "@/components/loyalty/staticFallback";
import chaJewelsLogo from "@/assets/cha-jewels-logo.jpeg";
import type { LoyaltyTab } from "@/components/loyalty/LoyaltyBottomNav";

interface ProfileScreenProps {
  setTab: (tab: LoyaltyTab) => void;
  portalToken: string;
  birthday: string | null;
  birthdayLocked: boolean;
  onUpdated: () => void;
}

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function formatBirthday(dateStr: string | null): string {
  if (!dateStr) return '';
  // dateStr is 'YYYY-MM-DD' (sentinel year 2000); render month + day only, no year.
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return '';
  const mi = Number(m[1]) - 1;
  const d = Number(m[2]);
  if (mi < 0 || mi > 11 || d < 1 || d > 31) return '';
  return `${MONTHS[mi]} ${d}`;
}

export default function ProfileScreen({ setTab, portalToken, birthday, birthdayLocked, onUpdated }: ProfileScreenProps) {
  const { member, tiers } = useLoyaltyData();
  const [showFaq, setShowFaq] = useState(false);
  const [expandedFaq, setExpandedFaq] = useState<number | null>(null);
  const [showTerms, setShowTerms] = useState(false);
  const [editingBirthday, setEditingBirthday] = useState(false);
  const [monthInput, setMonthInput] = useState<string>('');
  const [dayInput, setDayInput] = useState<string>('');
  const [savingBirthday, setSavingBirthday] = useState(false);

  if (!member || !tiers || tiers.length === 0) return null;

  const currentTier = tiers.find((t) => t.name === member.current_tier) ?? tiers[0]!;
  // TODO: wire phone to Supabase (no store field yet)
  const phone: string | null = null;
  const locked = birthdayLocked || birthday != null;
  const formattedBirthday = formatBirthday(birthday);

  const handleSaveBirthday = async () => {
    if (!monthInput || !dayInput) {
      toast.error('Pick a month and a day');
      return;
    }
    const mm = monthInput.padStart(2, '0');
    const dd = dayInput.padStart(2, '0');
    const p_birthday = `2000-${mm}-${dd}`;
    setSavingBirthday(true);
    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const supabaseAnonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
      // Dual-auth (mirrors RedemptionForm): token-auth → token in body,
      // no Authorization; session-auth (email/password) → Bearer <session JWT>
      // via getPortalAuthHeaders. resolvePortalAuth Path 0/2 handles both.
      const authHeaders = await getPortalAuthHeaders(portalToken);
      const res = await fetch(`${supabaseUrl}/functions/v1/customer-portal`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: supabaseAnonKey,
          ...authHeaders,
        },
        body: JSON.stringify({
          token: portalToken || undefined,
          action: 'set_birthday',
          p_birthday,
        }),
      });
      const payload = await res.json().catch(() => ({} as any));
      if (!res.ok || payload?.error) {
        toast.error(payload?.error || `Failed to save birthday (HTTP ${res.status})`);
        return;
      }
      toast.success('Birthday saved');
      setEditingBirthday(false);
      onUpdated();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to save birthday');
    } finally {
      setSavingBirthday(false);
    }
  };

  return (
    <div className="px-5 pt-6 pb-4 space-y-6">
      <h1 className="font-display text-2xl font-semibold text-foreground">Profile</h1>

      {/* Gold loyalty Profile Member Card */}
      <ProfileMemberCard />

      {/* Loyalty Status Card */}
      <div className="bg-card rounded-2xl shadow-card border-gold-accent overflow-hidden">
        <p className="text-[11px] text-muted-foreground font-body tracking-[0.2em] uppercase px-4 pt-4 pb-2">Loyalty Status</p>
        {[
          { label: 'Member ID', value: member.member_id },
          { label: 'Current Tier', value: `${currentTier.name} Member` },
          { label: 'Lifetime Spend', value: `¥${member.lifetime_spend_yen.toLocaleString()}` },
          { label: 'Available Points', value: member.available_points.toLocaleString() },
          { label: 'Tier Multiplier', value: `${currentTier.multiplier}x` },
          { label: 'Last Purchase', value: member.last_purchase_date ?? '—' },
          { label: 'Status', value: member.activity_status },
        ].map((item, i) => (
          <div key={item.label} className={`flex items-center justify-between px-4 py-3 ${i < 6 ? 'border-b border-border/50' : ''}`}>
            <span className="text-[13px] text-muted-foreground font-body">{item.label}</span>
            <span className={`text-[13px] font-body font-medium ${item.label === 'Status' && item.value === 'Active' ? 'text-primary' : 'text-foreground'}`}>
              {item.value}
            </span>
          </div>
        ))}
      </div>

      {/* Birthday Setup */}
      <div className="bg-card rounded-2xl shadow-card border-gold-accent p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
              <Calendar size={14} className="text-primary" />
            </div>
            <div>
              <p className="text-[13px] font-body font-semibold text-foreground">Birthday Rewards</p>
              <p className="text-[12px] text-muted-foreground font-body mt-0.5">
                {locked && formattedBirthday
                  ? `Birthday: ${formattedBirthday}`
                  : 'Set your birthday to unlock birthday rewards'}
              </p>
              {locked && formattedBirthday && (
                <p className="text-[11px] text-muted-foreground/60 font-body mt-1">
                  🔒 Your birthday is set and can't be changed.
                </p>
              )}
            </div>
          </div>
          {!locked && !editingBirthday && (
            <button
              onClick={() => setEditingBirthday(true)}
              className="text-[12px] text-primary font-body font-semibold"
            >
              Set Birthday
            </button>
          )}
        </div>
        {!locked && editingBirthday && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            className="mt-3 pt-3 border-t border-border/50"
          >
            <div className="flex gap-2">
              <select
                value={monthInput}
                onChange={(e) => setMonthInput(e.target.value)}
                className="flex-1 px-3 py-2 bg-background rounded-lg border-gold-accent text-[13px] font-body text-foreground"
              >
                <option value="">Month</option>
                {MONTHS.map((name, i) => (
                  <option key={name} value={String(i + 1)}>{name}</option>
                ))}
              </select>
              <select
                value={dayInput}
                onChange={(e) => setDayInput(e.target.value)}
                className="w-24 px-3 py-2 bg-background rounded-lg border-gold-accent text-[13px] font-body text-foreground"
              >
                <option value="">Day</option>
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={String(d)}>{d}</option>
                ))}
              </select>
            </div>
            <p className="text-[11px] text-muted-foreground/60 font-body mt-2 italic">
              Earn birthday bonus points during your birthday month — the amount scales with your tier.
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={() => { setEditingBirthday(false); setMonthInput(''); setDayInput(''); }}
                className="px-3 py-1.5 rounded-lg text-[12px] font-body text-muted-foreground"
                disabled={savingBirthday}
              >
                Cancel
              </button>
              <button
                onClick={handleSaveBirthday}
                disabled={savingBirthday || !monthInput || !dayInput}
                className="px-4 py-1.5 rounded-lg text-[12px] font-body font-semibold bg-primary text-primary-foreground disabled:opacity-50"
              >
                {savingBirthday ? 'Saving…' : 'Save'}
              </button>
            </div>
          </motion.div>
        )}
      </div>

      {/* Account Details */}
      <div className="bg-card rounded-2xl shadow-card border-gold-accent overflow-hidden">
        <p className="text-[11px] text-muted-foreground font-body tracking-[0.2em] uppercase px-4 pt-4 pb-2">Account Details</p>
        {[
          { label: 'Email', value: member.email ?? '—' },
          // TODO: wire phone to Supabase
          { label: 'Phone', value: phone ?? '—' },
          { label: 'Birthday', value: formattedBirthday || '—' },
          { label: 'Member Since', value: member.join_date },
        ].map((item, i) => (
          <div key={item.label} className={`flex items-center justify-between px-4 py-3 ${i < 3 ? 'border-b border-border/50' : ''}`}>
            <span className="text-[13px] text-muted-foreground font-body">{item.label}</span>
            <span className="text-[13px] font-body font-medium text-foreground">{item.value}</span>
          </div>
        ))}
      </div>

      {/* Menu Items */}
      <div className="bg-card rounded-2xl shadow-card border-gold-accent overflow-hidden">
        {[
          { label: 'My Tier Benefits', icon: Crown, action: () => setTab('tiers') },
          { label: 'Notification Preferences', icon: Bell, action: () => toast('Notification preferences coming soon') },
          // TODO: build security settings page
          { label: 'Security Settings', icon: Shield, action: () => toast('Security settings coming soon') },
          { label: 'Help & FAQ', icon: HelpCircle, action: () => setShowFaq(!showFaq) },
          { label: 'Contact Cha Jewels Support', icon: MessageCircle, action: () => window.open('https://m.me/chajewelsjp', '_blank') },
          { label: 'Terms & Privacy', icon: FileText, action: () => setShowTerms(true) },
        ].map((item, i) => (
          <button
            key={item.label}
            onClick={item.action}
            className={`flex items-center justify-between w-full px-4 py-3.5 ${i < 5 ? 'border-b border-border/50' : ''}`}
          >
            <div className="flex items-center gap-3">
              <item.icon size={16} className="text-primary/60" />
              <span className="text-[13px] font-body font-medium text-foreground">{item.label}</span>
            </div>
            <ChevronRight size={14} className="text-muted-foreground/40" />
          </button>
        ))}
      </div>

      {/* FAQ Section */}
      {showFaq && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          className="bg-card rounded-2xl p-5 shadow-card border-gold-accent space-y-3"
        >
          <h3 className="font-display text-lg font-semibold text-foreground">Frequently Asked Questions</h3>
          {FAQS.map((faq, i) => (
            <button
              key={i}
              onClick={() => setExpandedFaq(expandedFaq === i ? null : i)}
              className="w-full text-left"
            >
              <div className="flex items-start justify-between py-2 border-b border-border/50">
                <p className="text-[13px] font-body font-medium text-foreground pr-4">{faq.q}</p>
                <ChevronRight
                  size={12}
                  className={`text-muted-foreground transition-transform flex-shrink-0 mt-0.5 ${expandedFaq === i ? 'rotate-90' : ''}`}
                />
              </div>
              {expandedFaq === i && (
                <p className="text-[12px] text-muted-foreground font-body py-2 leading-relaxed">{faq.a}</p>
              )}
            </button>
          ))}
        </motion.div>
      )}

      {/* Sign Out */}
      <button
        onClick={() => setTab('home')}
        className="w-full py-3 bg-card rounded-xl shadow-card border-gold-accent flex items-center justify-center gap-2"
      >
        <LogOut size={14} className="text-destructive" />
        <span className="text-[13px] font-body font-medium text-destructive">Sign Out</span>
      </button>

      {/* Brand footer */}
      <div className="flex flex-col items-center gap-2 pb-4">
        <img
          src={chaJewelsLogo}
          alt="Cha Jewels"
          className="w-10 h-10 object-contain opacity-40 mix-blend-multiply dark:mix-blend-screen"
        />
        <p className="text-[11px] text-muted-foreground/40 font-body italic">
          Cha Jewels Loyalty V1.0
        </p>
      </div>

      {/* Terms & Privacy modal */}
      {showTerms && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={() => setShowTerms(false)}
        >
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            onClick={(e) => e.stopPropagation()}
            className="bg-card rounded-2xl shadow-elevated border-gold-accent w-full max-w-md max-h-[80vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-border/50 sticky top-0 bg-card">
              <h3 className="font-display text-lg font-semibold text-foreground">
                Terms &amp; Privacy
              </h3>
              <button
                onClick={() => setShowTerms(false)}
                className="w-8 h-8 rounded-full bg-muted/40 flex items-center justify-center"
                aria-label="Close"
              >
                <X size={16} className="text-muted-foreground" />
              </button>
            </div>
            <div className="px-5 py-4 space-y-3">
              {/* TODO: replace with actual legal text from Cha Jewels */}
              <p className="text-[13px] font-body text-foreground leading-relaxed">
                Terms of Service and Privacy Policy for Cha Jewels Loyalty Program.
                Full legal text will be added soon.
              </p>
              <p className="text-[12px] font-body text-muted-foreground leading-relaxed">
                By participating in the Cha Jewels Loyalty Program, you agree to the
                terms governing point earning, redemption, tier qualification, and
                account activity. Points are non-transferable and have no cash value.
              </p>
              <p className="text-[12px] font-body text-muted-foreground leading-relaxed">
                Cha Jewels reserves the right to update these terms at any time.
                Continued participation in the program constitutes acceptance of
                the latest version.
              </p>
              <p className="text-[12px] font-body text-muted-foreground/70 italic leading-relaxed">
                For questions, contact us via the Contact Support option in your
                Profile.
              </p>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
}
