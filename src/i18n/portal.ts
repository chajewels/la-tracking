/**
 * Cha Jewels Customer Portal — string catalogue + tiny translate helper.
 *
 * OPTION (b), NOT a runtime i18n library. This is a plain TypeScript
 * dictionary plus a `pt(key, vars)` helper whose signature deliberately
 * mirrors react-i18next's `t(key, vars)`, and whose interpolation uses
 * react-i18next's DEFAULT `{{token}}` syntax. The intent (owner decision,
 * 2026-07-08) is that a future real `react-i18next` install can adopt this
 * catalogue largely as-is — move `portalEn` into an i18next `en` resource
 * bundle and swap `pt` for `useTranslation().t` — instead of rewriting
 * every string and placeholder.
 *
 * SCOPE: only the Portal surfaces authored/rebuilt in the Maison workstream
 * (Phases 1-5) are catalogued here — the new portal/* components, the four
 * auth pages, the four loyalty dialogs/prompts + RecentActivity's empty
 * state, and the Maison-scoped regions of CustomerPortal.tsx /
 * LoyaltyPortal.tsx. The still-dark deferred areas (AccountCard grid,
 * Pay Now / Submissions tabs, cash-order cards, the broader loyalty
 * screens tree) are intentionally NOT catalogued — they will be extracted
 * when they are actually retheme'd, not before.
 *
 * LOCKED COPY: business-critical strings (payment-confirmation templates,
 * "¥10,000 = 100 points", etc.) are moved verbatim — never reworded, and
 * no new business-rule figures are introduced by this extraction.
 */

export type PortalVars = Record<string, string | number>;

/**
 * Interpolate `{{token}}` placeholders — the same default syntax
 * react-i18next uses. Unknown tokens are left untouched (visible in dev,
 * matching react-i18next's missing-interpolation behavior).
 */
export function formatPortal(template: string, vars?: PortalVars): string {
  if (!vars) return template;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key) =>
    key in vars ? String(vars[key]) : `{{${key}}}`,
  );
}

function lookup(path: string): string {
  const parts = path.split('.');
  let node: unknown = portalEn;
  for (const part of parts) {
    if (node && typeof node === 'object' && part in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[part];
    } else {
      return path; // dev fallback: surface the missing key rather than blank
    }
  }
  return typeof node === 'string' ? node : path;
}

/**
 * Portal translate. `pt('home.planSubtitle', { months })`. Dot-path key
 * into `portalEn`, then `{{token}}` interpolation. Mirrors react-i18next's
 * `t(key, vars)` so a future migration is near-mechanical.
 */
export function pt(key: string, vars?: PortalVars): string {
  return formatPortal(lookup(key), vars);
}

const SERVICE_KEYS = new Set(['resize', 'certificate', 'polish', 'change_color', 'engraving', 'repair', 'other']);

/**
 * Service-type label: known types resolve through the `services.*`
 * catalogue; any unknown/custom type falls back to the raw value (matching
 * the prior `SERVICE_LABELS[type] || type` behavior, now locale-aware).
 */
export function serviceLabel(serviceType: string): string {
  return SERVICE_KEYS.has(serviceType) ? pt(`services.${serviceType}`) : serviceType;
}

/**
 * The English catalogue. Nested by surface. Future react-i18next adoption:
 * `resources: { en: { translation: portalEn } }`.
 */
export const portalEn = {
  common: {
    chaJewels: 'Cha Jewels',
    customerPortal: 'Customer Portal',
    payNow: 'Pay Now',
    viewDetails: 'View Details',
    downpayment: 'Downpayment',
    paid: 'Paid',
    additionalServices: 'Additional Services',
    paymentHistory: 'Payment History',
    reference: 'Ref: {{ref}}',
    invoiceHash: 'Invoice #{{number}}',
    percentAria: '{{percent}} percent {{label}}',
    notSet: 'Not set',
    cancel: 'Cancel',
    saveChanges: 'Save Changes',
    saving: 'Saving…',
    loading: 'Loading…',
    emDash: '—',
  },
  auth: {
    // shared field labels / placeholders
    email: 'Email',
    emailPlaceholder: 'you@example.com',
    password: 'Password',
    passwordPlaceholder: 'Enter your password',
    newPassword: 'New Password',
    confirmPassword: 'Confirm Password',
    min8Chars: 'At least 8 characters',
    confirmNewPlaceholder: 'Confirm your new password',
    optional: ' (optional)',
    backToSignIn: 'Back to Sign In',
    backToSignInArrow: '← Back to Sign In',
    didntReceive: "Didn't receive it? Check your spam folder, or try again in a few minutes.",
    // login
    loginHeading: 'Welcome back to your Cha Jewels Portal',
    loginSubtitle: 'Sign in to access your accounts',
    signIn: 'Sign In',
    signingIn: 'Signing in…',
    forgotPassword: 'Forgot password?',
    firstTimeSetup: 'First time? Set up',
    welcomeBack: 'Welcome back to Cha Jewels',
    errEnterEmailPassword: 'Please enter your email and password',
    // forgot password
    forgotHeading: 'Reset your portal password',
    forgotSubtitle: 'Enter your email to receive a reset link',
    sendResetEmail: 'Send Reset Email',
    sending: 'Sending…',
    checkInboxTitle: 'Check your inbox',
    resetLinkSentTo: 'A password reset link has been sent to:',
    errEnterEmail: 'Please enter your email address',
    errResetSendFailed: 'Failed to send reset email. Please try again.',
    // reset password
    verifyingResetLink: 'Verifying reset link…',
    resetHeading: 'Set a new portal password',
    resetSubtitle: 'Enter your new password below.',
    updatePassword: 'Update Password',
    updating: 'Updating…',
    passwordUpdated: 'Password updated successfully',
    errPasswordMin: 'Password must be at least 8 characters',
    errPasswordMismatch: 'Passwords do not match',
    // setup
    setupHeading: 'Set up your Cha Jewels Portal account',
    setupSubtitle: 'Use the email Cha Jewels has on file for you.',
    fullName: 'Full Name',
    fullNamePlaceholder: 'Your full name',
    mobileNumber: 'Mobile Number',
    mobilePlaceholder: 'e.g. 09XX XXX XXXX',
    facebookName: 'Facebook Name',
    facebookPlaceholder: 'Name on Facebook',
    messengerLink: 'Messenger Link',
    messengerPlaceholder: 'm.me/yourprofile',
    location: 'Location',
    locationPlaceholder: 'City / area',
    country: 'Country',
    countryPlaceholder: 'Country',
    setupPasswordPlaceholder: 'At least 8 characters',
    confirmPasswordPlaceholder: 'Confirm your password',
    createAccount: 'Create Account',
    creatingAccount: 'Creating account…',
    alreadyHaveAccount: 'Already have an account? Sign in',
    checkEmailTitle: 'Check your email',
    verificationSentTo: 'We sent a verification link to:',
    verifyInstructions: "Click the link in the email to verify your account. Once verified, you'll be linked to your Cha Jewels customer profile automatically.",
    linkingTitle: 'Linking your account',
    justAMoment: 'Just a moment…',
    pleaseWait: 'Please wait',
    accountNotFoundTitle: 'Account not found',
    tryDifferentEmail: 'Try Different Email',
    needHelpMessenger: 'Need help? Contact Cha Jewels via Messenger.',
    setupErrorTitle: 'Setup error',
    tryAgain: 'Try Again',
    accountLinked: 'Account linked successfully',
    errSessionLost: 'Authentication session lost. Please sign in again.',
    errNoCustomer: 'We couldn’t find a customer record for this email. Please contact Cha Jewels for help.',
    errConflictRegistered: 'This email is already registered for portal access. Please contact support to set up your account.',
    errLinkFailed: 'Failed to link your account. Please try again or contact support.',
    errLinkTimeout: 'Account linking timed out. Please try again — if this keeps happening, contact Cha Jewels for help.',
    errNetwork: 'Network error. Please check your connection and try again.',
    errInvalidEmail: 'Please enter a valid email address',
    errEnterFullName: 'Please enter your full name',
    errEnterFacebook: 'Please enter your Facebook name',
    errEnterCountry: 'Please enter your country',
    errAlreadyRegistered: 'This email is already registered. Please contact support if you need help accessing your portal account.',
  },
  nav: {
    label: 'Portal navigation',
    home: 'Home',
    layaway: 'Layaway',
    loyalty: 'Loyalty',
    profile: 'Profile',
    accounts: 'Accounts',
    backToPortal: 'Back to Portal',
    signOut: 'Sign Out',
  },
  offline: {
    message: "You're offline — some information may be out of date.",
  },
  home: {
    eyebrowActive: 'Active Layaway',
    eyebrowPaid: 'Fully Paid',
    planSubtitle: '{{months}}-Month Layaway Plan',
    ringLabel: 'paid',
    nextPayment: 'Next Payment',
    dueDate: 'Due {{date}}',
    overdue: 'Overdue',
    dueToday: 'Due today',
    dueInDays_one: 'Due in {{days}} day',
    dueInDays_other: 'Due in {{days}} days',
    fullyPaidThanks: '🎉 Fully paid — Thank you!',
    paidOfTotal: '{{paid}} of {{total}} paid in full.',
    pointsBalance: 'Points Balance',
    activePlans: 'Active Plans',
    latestStatement: 'Latest Statement',
    goodMorning: 'Good Morning',
    goodAfternoon: 'Good Afternoon',
    goodEvening: 'Good Evening',
    noAccountsTitle: 'No layaway accounts yet.',
    noAccountsBody: 'Visit Cha Jewels to start your first layaway plan.',
    noMatchTitle: 'No accounts match your search.',
    noMatchBody: 'Try adjusting your filters.',
    updateAvailable: 'A new version is available. Reload to load the latest update.',
    reload: 'Reload',
  },
  detail: {
    invoice: 'Invoice',
    totalAmount: 'Total Amount',
    balanceDue: 'Balance Due',
    includesPenalties: 'includes {{amount}} in late penalties',
    nextDue: 'Next Due',
    nextAmount: 'Next Amount',
    tabSchedule: 'Schedule',
    tabPay: 'Pay Now',
    tabSubmissions: 'Submissions',
    overdueTitle: 'Payment Overdue',
    overdueBody: 'Please submit your payment as soon as possible to avoid additional penalties.',
    paymentJourney: 'Payment Journey',
    dpNode: 'DP',
    dpPaidStatus: 'Paid',
    dpPartial: 'Partial — {{amount}} paid',
    dpDueOnOrder: 'Due on order',
    monthN: 'Month {{n}}',
    statusPaid: 'Paid',
    statusOverdue: 'Overdue',
    statusPartial: 'Partial',
    statusUpcoming: 'Upcoming',
    statusCancelled: 'Cancelled',
    statusDueToday: 'Due today',
    statusDueInDays: 'Due in {{days}}d',
    penalty: '+{{amount}} penalty',
    penaltyPaid: '+{{amount}} penalty (paid)',
    paidAmount: 'Paid: {{amount}}',
    itemizedTotals: 'Itemized Totals',
    layawayAmount: 'Layaway Amount',
    includesAddedServices: 'Includes added services',
    alreadyIncluded: 'Already included above',
    outstandingPenalties: 'Outstanding Penalties',
    totalPaidToDate: 'Total Paid to Date',
    remainingBalance: 'Remaining Balance',
    completedTitle: 'Fully Paid',
    completedThanks: 'Thank you for your continued trust in Cha Jewels.',
    completedTotalPaid: 'Total Paid',
    completedTotalObligation: 'Total Obligation',
    serviceStatus: 'Service Status',
    svcReceived: 'Received {{date}}',
    svcCompleted: ' · Completed {{date}}',
    svcEst: ' · Est. {{date}}',
  },
  statements: {
    title: 'Account Statement',
    issued: 'Issued {{date}}',
    customer: 'Customer',
    invoice: 'Invoice',
    plan: 'Plan',
    planValue: '{{months}}-Month Layaway',
    orderDate: 'Order Date',
    print: 'Print / Save as PDF',
  },
  states: {
    loadingAccounts: 'Loading your accounts…',
    signInTitle: 'Sign in to your Cha Jewels Portal',
    signInBody: 'Use your email and password to access your accounts.',
    signIn: 'Sign In',
    firstTimeSetup: 'First time? Set up your account',
    linkExpiredTitle: 'Portal Link Expired',
    linkInvalidTitle: 'Invalid Portal Link',
    linkExpiredBody: 'This portal link has expired. Please request a new link from Cha Jewels.',
    linkInvalidBody: 'This link is invalid or no longer active. Please contact Cha Jewels for a new portal link.',
    pinPrompt: 'Enter your 4-digit portal PIN',
    pinVerifying: 'Verifying...',
    pinAccess: 'Access My Account',
    pinForgot: 'Forgot your PIN? Contact your staff.',
    pinDefault: 'Default PIN: last 4 digits of your registered mobile number',
    errLoadAccounts: 'Unable to load your accounts. Please try again.',
    loyaltyValidating: 'Validating your access…',
    loyaltyLoading: 'Loading your loyalty status…',
    loyaltySrHeading: 'Cha Jewels Loyalty Rewards',
    errLoadLoyalty: 'Unable to load your loyalty status',
  },
  profile: {
    title: 'My Profile',
    edit: 'Edit',
    updated: 'Your profile has been updated successfully.',
    fullName: 'Full Name',
    location: 'Location',
    facebookName: 'Facebook Name',
    messengerLink: 'Messenger Link',
    messengerPlaceholder: 'm.me/username',
    mobileNumber: 'Mobile Number',
    mobilePlaceholder: '+63 or +81',
    email: 'Email',
    country: 'Country',
    notes: 'Notes',
    notesPlaceholder: 'Any notes for Cha Jewels…',
    locJapan: 'Japan',
    locPhilippines: 'Philippines',
    locInternational: 'International',
    errFullNameRequired: 'Full Name is required.',
    errCountryRequired: 'Please select a country.',
    errInvalidEmail: 'Please enter a valid email address.',
    errUpdateFailed: 'Failed to update profile.',
    errGeneric: 'Something went wrong. Please try again.',
  },
  loyalty: {
    // RecentActivity empty state
    recentActivity: 'Recent Activity',
    viewAll: 'View All',
    noActivity: 'No activity yet — points show up here after your first order.',
    // RedemptionForm
    typeNewOrderTitle: 'New Order Discount',
    typeNewOrderDesc: 'Apply as discount on a new order',
    typeShippingTitle: 'Shipping Fee',
    typeShippingDesc: 'Pay shipping cost on any of your orders',
    typeServiceTitle: 'Service Fee',
    typeServiceDesc: 'Pay service charges on any of your orders',
    redeemTitle: 'Redeem Your Points',
    // "1 point = ¥1 value" is the locked loyalty conversion — verbatim.
    redeemSubtitle: 'You have {{points}} points available. 1 point = ¥1 value.',
    redemptionType: 'Redemption Type',
    invoiceNumber: 'Invoice Number',
    invoicePlaceholder: 'e.g. 19012',
    invoiceHint: 'Enter the invoice number your team gave you for the new order.',
    invoiceNotFound: 'Invoice not found among your brand-new orders.',
    foundOrder: '✓ Found: {{kind}} — {{amount}}',
    kindLayaway: 'Layaway',
    kindCash: 'Cash Order',
    notes: 'Notes',
    notesRequiredHint: '(required for tracking & notification)',
    notesOptionalHint: '(optional)',
    notesPlaceholder: 'Describe what this shipping fee / service fee redemption is for. The admin will see this on review.',
    notesRequiredEmpty: 'Required — cannot submit without notes',
    notesPointsOnly: 'These points-only redemptions never touch an order.',
    charCount: '{{count}}/500',
    pointsToRedeem: 'Points to Redeem',
    pointsPlaceholder: '0',
    quickAll: 'All',
    // "= ¥X value" reflects the locked 1pt=¥1 conversion — verbatim.
    pointsValue: '= ¥{{amount}} value',
    errPositive: 'Enter a positive number',
    errExceedsPoints: 'Cannot exceed your {{points}} available points',
    notesOptionalPlaceholder: 'Any details for our team to know',
    submitRedemption: 'Submit Redemption Request',
    submitting: 'Submitting…',
    submittedToast: 'Redemption request submitted',
    howItWorks: '💡 How it works',
    step1: 'Submit your request below',
    step2: 'Our team will review and approve',
    step4: "You'll receive a confirmation email",
    applyNewOrder: 'The discount will be applied to the order matching your invoice number',
    applyShipping: 'Your shipping fee will be covered using these points',
    applyService: 'Your service fee will be covered using these points',
    applyDefault: 'The points will be applied to your order',
    successTitle: 'Redemption request submitted!',
    successBody: "We'll notify you once approved.",
    // TierCelebrationModal
    congrats: '🎉 Congratulations!',
    tierUpdate: 'Tier Update',
    youveReached: "You've reached",
    tierAdjusted: 'Your tier has been adjusted to',
    continue: 'Continue',
    // LoyaltyComingSoon
    comingSoonTitle: '💎 Cha Jewels Loyalty Program',
    comingSoonBody: 'Coming soon! Our loyalty program is launching soon — stay tuned for exclusive rewards, tier benefits, and points on every purchase.',
    emailPlaceholder: 'your@email.com',
    notifyMe: 'Notify Me',
    savingEmail: 'Saving…',
    onTheList: "✓ You're on the list",
    errEnterEmailNotify: 'Enter an email to be notified',
    notifySuccess: "You're on the list — we'll email you at launch",
    errSaveEmail: 'Could not save your email',
    // LoyaltyJoinPrompt
    benefitPoints: 'Earn points on every purchase',
    benefitTiers: '4 tiers up to 3× points multiplier',
    benefitShipping: 'Free international shipping',
    benefitGifts: 'Mystery gifts for VIPs',
    joinTitle: 'Join Cha Jewels Loyalty',
    joinSubtitle: 'Earn rewards on every order — opt in once, redeem anytime.',
    joinNow: 'Join Now',
    joining: 'Joining…',
    alreadyMember: "You're already a member — welcome back",
    welcomeJoin: 'Welcome to Cha Jewels Loyalty',
    joinedGeneric: 'Joined the loyalty program',
    errJoin: 'Could not join right now — please try again',
  },
  services: {
    resize: 'Resize',
    certificate: 'Certificate',
    polish: 'Polish',
    change_color: 'Change Color',
    engraving: 'Engraving',
    repair: 'Repair',
    other: 'Other',
  },
} as const;
