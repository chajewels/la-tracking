// TODO: wire to Supabase
export interface FallbackReward {
  id: string;
  name: string;
  description: string;
  pointsCost: number;
  category: 'Redeem with Points' | 'Tier Exclusive' | 'Shipping Rewards' | 'Member-Only Offers' | 'VIP Vault';
  tier: 'Glimmer' | 'Radiant' | 'Elite' | 'Crown VIP' | 'All';
  isLimited?: boolean;
  isVipOnly?: boolean;
  isVault?: boolean;
  // Phase 3.2: stock tracking from loyalty_rewards.current_stock.
  // null = unlimited; undefined when sourced from staticFallback.
  currentStock?: number | null;
}

// TODO: wire to Supabase
export const REWARDS: FallbackReward[] = [
  { id: '1', name: '¥500 Cha Jewels Voucher', description: 'Redeem for ¥500 off your next Japan Gold purchase of ¥5,000 or more.', pointsCost: 500, category: 'Redeem with Points', tier: 'All' },
  { id: '2', name: '¥1,000 Gold Collection Voucher', description: 'Redeem for ¥1,000 off any Japan Gold piece worth ¥10,000 or more.', pointsCost: 1000, category: 'Redeem with Points', tier: 'All' },
  { id: '3', name: '¥2,500 Layaway Credit', description: 'Apply as credit toward any active Cha Jewels layaway purchase.', pointsCost: 2500, category: 'Redeem with Points', tier: 'Radiant' },
  { id: '4', name: '18K Gold Charm Bracelet', description: 'A delicate 18K Japan Gold charm bracelet from the Petite Collection — exclusively for Radiant members.', pointsCost: 3500, category: 'Tier Exclusive', tier: 'Radiant' },
  { id: '5', name: 'Pearl & Gold Stud Earrings', description: 'Elegant freshwater pearl studs set in 14K Japan Gold. A signature Cha Jewels design.', pointsCost: 5000, category: 'Tier Exclusive', tier: 'Elite' },
  { id: '6', name: 'Free Shipping Pass (4 Items)', description: 'Free shipping on your next 4 qualifying items (min ¥8,000 per item). Elite members and above.', pointsCost: 1200, category: 'Shipping Rewards', tier: 'Elite' },
  { id: '7', name: 'Free Shipping Pass (3 Items)', description: 'Free shipping on your next 3 qualifying items (min ¥8,000 per item). Crown VIP exclusive.', pointsCost: 800, category: 'Shipping Rewards', tier: 'Crown VIP', isVipOnly: true },
  { id: '8', name: 'Complimentary Gold Cleaning', description: 'Professional cleaning & polishing for up to 3 pieces of your Cha Jewels gold jewelry.', pointsCost: 200, category: 'Member-Only Offers', tier: 'All' },
  { id: '9', name: 'Limited Edition Rose Gold Ring', description: 'A limited-run 18K Japan rose gold ring. Only 50 pieces — exclusively for Elite members and above.', pointsCost: 12000, category: 'Tier Exclusive', tier: 'Elite', isLimited: true },
  { id: '10', name: 'VIP Private Gold Viewing', description: 'Exclusive invitation to a private Japan Gold viewing event with our master jeweler.', pointsCost: 8000, category: 'Tier Exclusive', tier: 'Crown VIP', isVipOnly: true },
  { id: '11', name: 'Birthday Bonus — 500 Points', description: 'Claim your birthday bonus points during your birthday month. A gift from Cha Jewels! 🎂', pointsCost: 0, category: 'Member-Only Offers', tier: 'All' },
  { id: '12', name: 'Gold Investment Consultation', description: '30-minute personal consultation on Japan Gold investment strategy with our gold expert.', pointsCost: 1200, category: 'Member-Only Offers', tier: 'Elite' },
  // VIP Vault
  { id: 'v1', name: 'Secret Member-Only Discount', description: 'Exclusive 5% discount on any Japan Gold piece — vault members only.', pointsCost: 3000, category: 'VIP Vault', tier: 'Elite', isVault: true },
  { id: 'v2', name: 'VIP Flash Sale Invitation', description: 'Private invitation to our quarterly VIP flash sale with up to 15% off select pieces.', pointsCost: 2000, category: 'VIP Vault', tier: 'Radiant', isVault: true },
  { id: 'v3', name: 'Mystery Gift Redemption', description: 'Redeem a mystery luxury gift — only Crown VIP members know what awaits inside.', pointsCost: 5000, category: 'VIP Vault', tier: 'Crown VIP', isVault: true, isVipOnly: true },
  { id: 'v4', name: 'Free Shipping — Unlimited Month', description: 'Free shipping on all orders for an entire month. No minimum purchase required.', pointsCost: 4000, category: 'VIP Vault', tier: 'Elite', isVault: true },
  { id: 'v5', name: 'Limited-Time Reward Drop', description: 'Access to a surprise reward drop — exclusive pieces and deals only for vault members.', pointsCost: 6000, category: 'VIP Vault', tier: 'Crown VIP', isVault: true, isLimited: true, isVipOnly: true },
];

// TODO: wire to Supabase
export interface FallbackNotification {
  id: string;
  title: string;
  message: string;
  category: 'tier' | 'points' | 'redemption' | 'birthday' | 'promo' | 'order' | 'vip' | 'expiry' | 'security' | 'activity' | 'milestone' | 'referral';
  date: string;
  isRead: boolean;
}

// TODO: wire to Supabase
export const NOTIFICATIONS: FallbackNotification[] = [
  { id: '1', title: 'Happy Birthday Month, Cynthia! 🎂💛', message: 'Your 500 birthday bonus points are ready to claim! Enjoy exclusive birthday perks at Cha Jewels.', category: 'birthday', date: 'Today', isRead: false },
  { id: '2', title: 'You Earned 700 Points ✨', message: 'Your 18K Japan Gold Necklace purchase (¥350,000) earned you 700 loyalty points with your 2x Radiant multiplier!', category: 'points', date: 'Today', isRead: false },
  { id: '3', title: "You're Getting Closer to Elite! 🚀", message: 'Spend ¥2,150,000 more to unlock Elite Member — enjoy free shipping and 2% invoice discounts.', category: 'tier', date: 'Today', isRead: false },
  { id: 'm1', title: '🎉 Congratulations!', message: 'You have reached ¥1,000,000 in lifetime purchases. Thank you for being a loyal Cha Jewels member!', category: 'milestone', date: 'Today', isRead: false },
  { id: '4', title: 'New Japan Gold Collection — Early Access', message: 'As a Radiant member, you have exclusive early access to the Spring 2026 Japan Gold Collection.', category: 'vip', date: 'Yesterday', isRead: true },
  { id: '5', title: 'Stay Active to Keep Your Benefits', message: 'Remember: at least 1 purchase every 6 months keeps your tier and benefits active. Your status: Active ✅', category: 'activity', date: 'Yesterday', isRead: true },
  { id: '6', title: "Congratulations! You're Now Radiant ✨", message: "You've been upgraded to Radiant Tier! Enjoy 2x points on all purchases and exclusive member promotions.", category: 'tier', date: 'Feb 20', isRead: true },
  { id: 'r1', title: '🎉 Your friend joined Cha Jewels!', message: 'You earned 100 referral bonus points. Keep sharing your code to earn more rewards!', category: 'referral', date: 'Feb 18', isRead: true },
  { id: '7', title: 'Reward Redeemed Successfully 🎁', message: 'Your ¥500 Cha Jewels Voucher has been redeemed. Thank you for choosing Cha Jewels Japan Gold!', category: 'redemption', date: 'Feb 28', isRead: true },
  { id: '8', title: 'Crown VIP Rewards Now Available', message: 'Explore exclusive Crown VIP rewards including mystery gifts, private viewings, and premium shipping perks.', category: 'vip', date: 'Feb 10', isRead: true },
  { id: '9', title: 'Layaway Purchase Confirmed', message: 'Your Gold Ring layaway purchase (CJ-LAY-20260301) has been confirmed. Points credited to your account!', category: 'order', date: 'Mar 1', isRead: true },
  { id: '10', title: 'Account Security Update', message: "Your Cha Jewels account password was recently changed. If this wasn't you, contact our support team immediately.", category: 'security', date: 'Jan 30', isRead: true },
];

// TODO: wire to Supabase
export interface FallbackMilestone {
  id: string;
  amount: number;
  emoji: string;
  title: string;
  message: string;
  reached: boolean;
}

// TODO: wire to Supabase
export const MILESTONES: FallbackMilestone[] = [
  { id: 'm1', amount: 1000000, emoji: '🎉', title: 'Congratulations', message: 'You have reached ¥1,000,000 in lifetime purchases.', reached: true },
  { id: 'm2', amount: 3000000, emoji: '✨', title: 'Amazing progress', message: 'You have reached ¥3,000,000 in lifetime purchases.', reached: false },
  { id: 'm3', amount: 5000000, emoji: '🏆', title: 'Incredible loyalty', message: 'You have reached ¥5,000,000 in lifetime purchases.', reached: false },
  { id: 'm4', amount: 8000000, emoji: '💎', title: 'Elite loyalty milestone', message: 'You have reached ¥8,000,000 in lifetime purchases.', reached: false },
];

// TODO: wire to Supabase
export interface FallbackReferral {
  code: string;
  link: string;
  friendsReferred: number;
  pointsEarned: number;
  bonusPerReferral: number;
  welcomeBonus: number;
}

// TODO: wire to Supabase
export const REFERRAL: FallbackReferral = {
  code: 'CJ-CYNTHIA102',
  link: 'https://chajewels.com/ref/CJ-CYNTHIA102',
  friendsReferred: 5,
  pointsEarned: 500,
  bonusPerReferral: 100,
  welcomeBonus: 50,
};

// TODO: wire to Supabase
export interface FallbackFaq {
  q: string;
  a: string;
}

// TODO: wire to Supabase
export const FAQS: FallbackFaq[] = [
  { q: 'How do I earn loyalty points?', a: 'You earn 100 loyalty points for every ¥10,000 spent on Cha Jewels purchases. Higher tier members earn 2x or 3x points based on their tier multiplier.' },
  { q: 'What are the loyalty tiers?', a: 'Cha Jewels has 4 tiers — Glimmer (¥0+), Radiant (¥1M+), Elite (¥4M+), and Crown VIP (¥8M+). Each tier unlocks better rewards and earning rates.' },
  { q: 'How do I redeem my points?', a: 'Browse the Rewards tab to see what you can redeem with your points. Some rewards are available to all members, others are tier-exclusive.' },
  { q: 'When do my points expire?', a: 'Loyalty points are valid as long as you remain an active member. Make at least one purchase every 6 months to keep your tier and points active.' },
  { q: 'How do I check my tier progress?', a: 'Visit the Tiers tab to see your current tier, your progress to the next tier, and all tier benefits.' },
  { q: 'Can I share my points with someone else?', a: 'No, loyalty points are non-transferable and tied to your customer account.' },
  { q: 'How does the referral program work?', a: 'Share your referral code from the Profile tab. When a friend joins using your code, you both earn bonus points.' },
  { q: 'What happens if I become inactive?', a: 'After 6 months without a purchase, your tier may be downgraded one level. Stay active with regular purchases to maintain your tier.' },
  { q: 'How do I contact customer support?', a: 'Use the Contact Support button in the Profile tab to reach the Cha Jewels team via Messenger or email.' },
];
