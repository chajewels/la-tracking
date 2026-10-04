import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { Globe, Hourglass } from "lucide-react";
import PageMeta from "@/components/seo/PageMeta";
import AppLayout from "@/components/layout/AppLayout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ROUTES } from "@/constants/routes";
import { useAuth } from "@/contexts/AuthContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import ProductsCard from "@/components/website/ProductsCard";
import { JewelryTypesCard } from "@/components/website/JewelryTypesCard";
import { CategoriesCard } from "@/components/website/CategoriesCard";
import { PostsCard } from "@/components/website/PostsCard";
import { FaqCard } from "@/components/website/FaqCard";
import { TestimonialsCard } from "@/components/website/TestimonialsCard";
import { CampaignsCard } from "@/components/website/CampaignsCard";
import { NewsletterSubscribersCard } from "@/components/website/NewsletterSubscribersCard";
import { WholesaleInquiriesCard } from "@/components/website/WholesaleInquiriesCard";
import { ContactInquiriesCard } from "@/components/website/ContactInquiriesCard";
import { SettingsCard } from "@/components/website/SettingsCard";
import { Page365StockCard } from "@/components/website/Page365StockCard";
import { Page365InventoryCard } from "@/components/website/Page365InventoryCard";
import { Page365InventoryScheduleCard } from "@/components/website/Page365InventoryScheduleCard";
import { MediaCutoutReviewCard, MediaCutoutSettingsCard } from "@/components/website/MediaCutoutsCard";
import { HeroCutoutsCard } from "@/components/website/HeroCutoutsCard";
import { ReviewsCard } from "@/components/website/ReviewsCard";
import PaymentMethodsTab from "@/components/settings/PaymentMethodsTab";
import { PaymentRemindersCard } from "@/components/settings/PaymentRemindersCard";
import { PaidySettingsCard } from "@/components/settings/PaidySettingsCard";
import { SquareSettingsCard } from "@/components/settings/SquareSettingsCard";
import { SquareOperationsPanel } from "@/components/website/SquareOperationsPanel";
import { ShippingFeesCard } from "@/components/website/ShippingFeesCard";

/**
 * The Website workspace — everything that feeds chajewelsjp.com, on six tabs.
 *
 * Tab state lives in `?tab=`, the same arrangement Monitoring uses: validated
 * on init so a hand-typed tab falls back rather than rendering nothing, written
 * back with a FUNCTIONAL setSearchParams so a card writing its own param in the
 * same tick (ContactInquiriesCard consuming `?inquiry=`, the subscriber card
 * consuming `?subscriber=`) cannot clobber the tab, and mirrored by an effect
 * so Back and a pasted link both land on the right tab.
 *
 * Two permission keys, not one — see docs/WEBSITE-WORKSPACE.md:
 *   catalog          → manage_website_catalog  (the shop)
 *   content, settings → manage_website_content  (the words on the site)
 *                      Settings also carries three ADMIN-ONLY sections:
 *                      Payment details and Payment reminders (moved from Hub
 *                      Settings in website-orders PR 1) and Shipping fees
 *                      (PR 2). They render only for admins, because content
 *                      editors can open this tab.
 *   audience         → EITHER, with each card on its own key — see canAudience
 *   page365-stock    → manage_website_catalog  (imported Page365 lines that
 *                      did not match one website product — docs/PAGE365-IMPORT.md
 *                      "STOCK"), and the Page365 inventory fetch/review/apply,
 *                      which since PR 2 is the only thing that moves website
 *                      stock from Page365 (docs/PAGE365-IMPORT.md "INVENTORY")
 *   photos           → manage_website_catalog  (automatic background removal:
 *                      the switch, the monthly limit and the review queue —
 *                      docs/MEDIA-CUTOUTS.md; and the HERO cut-outs, original
 *                      tool only, approve / reject / go-live ADMIN only —
 *                      docs/HERO-CUTOUTS.md)
 *   reviews          → moderate_reviews  (customer reviews: approve / reject /
 *                      hide — docs/SCHEMA-FACTS.md "Product reviews")
 */
export const WEBSITE_TABS = ["catalog", "content", "audience", "settings", "page365-stock", "photos", "reviews"] as const;
export type WebsiteTab = (typeof WEBSITE_TABS)[number];

const isWebsiteTab = (v: string | null): v is WebsiteTab =>
  !!v && (WEBSITE_TABS as readonly string[]).includes(v);

/**
 * Anchors on the Settings tab, so an old link can land on its section:
 * /settings?tab=payment-details redirects to
 * /website?tab=settings#payment-details (SettingsPage).
 */
export const WEBSITE_SETTINGS_SECTIONS = {
  websiteOrders: "website-orders",
  paymentDetails: "payment-details",
  paymentReminders: "payment-reminders",
  paidy: "paidy",
  square: "square",
  shippingFees: "shipping-fees",
  siteSettings: "site-settings",
} as const;

export default function Website() {
  const { roles } = useAuth();
  const isAdmin = !!roles?.includes("admin");
  const { can } = usePermissions();
  const canCatalog = can("manage_website_catalog") || isAdmin;
  const canContent = can("manage_website_content") || isAdmin;
  /**
   * Audience is the one tab that is NOT one key's.
   *
   * Three of its cards are the catalog key's (who wrote in, who subscribed)
   * and Campaigns is the content key's (words the site sends). Gating the tab
   * on either one alone hid a card from someone holding the key for it —
   * a content-only holder could write campaigns and never reach them.
   *
   * So the TAB opens to either key and each CARD keeps its own gate. A holder
   * of one key sees exactly their cards, and never an empty tab: whichever key
   * opened it also renders at least one card.
   */
  const canAudience = canCatalog || canContent;
  const canReviews = can("moderate_reviews") || isAdmin;

  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTabState] = useState<WebsiteTab>(() => {
    const urlTab = searchParams.get("tab");
    return isWebsiteTab(urlTab) ? urlTab : "catalog";
  });

  const setTab = useCallback((next: WebsiteTab) => {
    setTabState(next);
    setSearchParams(prev => {
      const params = new URLSearchParams(prev);
      params.set("tab", next);
      return params;
    }, { replace: true });
  }, [setSearchParams]);

  useEffect(() => {
    const urlTab = searchParams.get("tab");
    if (isWebsiteTab(urlTab) && urlTab !== tab) setTabState(urlTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // A #section on the Settings tab scrolls to it once the tab has rendered.
  // The browser's own hash jump fires before React mounts the section.
  const { hash } = useLocation();
  useEffect(() => {
    if (tab !== "settings" || !hash) return;
    const id = decodeURIComponent(hash.slice(1));
    const frame = requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ block: "start" });
    });
    return () => cancelAnimationFrame(frame);
  }, [tab, hash]);

  return (
    <AppLayout>
      <div className="p-6 space-y-6">
        <PageMeta
          title="Website | Cha Jewels Hub"
          description="Manage the products, content, subscribers and inquiries published on the Cha Jewels public website."
          path="/website"
        />

        <div className="flex items-center gap-3">
          <Globe className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Website</h1>
            <p className="text-sm text-muted-foreground">
              Everything shown on chajewelsjp.com. Only <span className="text-foreground">Active</span> products are published.
            </p>
          </div>
        </div>

        <Tabs value={tab} onValueChange={v => setTab(v as WebsiteTab)} className="w-full">
          {/* Six tabs overflow a phone: scroll sideways there (CustomerDetail's pattern). */}
          <TabsList className="flex w-full max-w-full justify-start overflow-x-auto scrollbar-hide sm:inline-flex sm:w-auto [&>*]:shrink-0">
            {canCatalog && <TabsTrigger value="catalog">Catalog</TabsTrigger>}
            {canContent && <TabsTrigger value="content">Content</TabsTrigger>}
            {canAudience && <TabsTrigger value="audience">Audience</TabsTrigger>}
            {canContent && <TabsTrigger value="settings">Settings</TabsTrigger>}
            {canCatalog && <TabsTrigger value="page365-stock">Page365 stock</TabsTrigger>}
            {canCatalog && <TabsTrigger value="photos">Photos</TabsTrigger>}
            {canReviews && <TabsTrigger value="reviews">Reviews</TabsTrigger>}
          </TabsList>

          {canCatalog && (
            <TabsContent value="catalog" className="mt-5 space-y-6" tabIndex={-1}>
              <ProductsCard />
              <JewelryTypesCard />
              <CategoriesCard />
            </TabsContent>
          )}

          {canContent && (
            <TabsContent value="content" className="mt-5 space-y-6" tabIndex={-1}>
              <PostsCard />
              <FaqCard />
              <TestimonialsCard />
            </TabsContent>
          )}

          {canAudience && (
            <TabsContent value="audience" className="mt-5 space-y-6" tabIndex={-1}>
              {canContent && <CampaignsCard />}
              {canCatalog && <NewsletterSubscribersCard />}
              {canCatalog && <WholesaleInquiriesCard />}
              {canCatalog && <ContactInquiriesCard />}
            </TabsContent>
          )}

          {canContent && (
            <TabsContent value="settings" className="mt-5 space-y-6" tabIndex={-1}>
              {/* Website orders PR 10 (2026-10-01): every website checkout is a
                  draft confirmed by staff. The reserve-first switch and the
                  checkout-mode card are gone (web_checkout_mode stays 'draft');
                  this static note replaces both. The section id is kept so an
                  old deep link still lands here. */}
              <section id={WEBSITE_SETTINGS_SECTIONS.websiteOrders} className="scroll-mt-20">
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                      <Hourglass className="h-4 w-4 text-primary" />
                      Website orders
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    <p className="text-muted-foreground">
                      Every website checkout waits in Sales → Website orders → To confirm until staff confirm it.
                      The piece is held, the customer pays nothing until then.
                    </p>
                    <Link to={`${ROUTES.SALES}?tab=web`} className="inline-block font-medium text-primary hover:underline">
                      Open Website orders
                    </Link>
                  </CardContent>
                </Card>
              </section>
              {/* Admin only: live bank/GCash details shown to customers at
                  checkout. PaymentMethodsTab keeps its own admins-only gate
                  as a second layer. */}
              {isAdmin && (
                <section id={WEBSITE_SETTINGS_SECTIONS.paymentDetails} className="scroll-mt-20">
                  <PaymentMethodsTab />
                </section>
              )}
              {/* Admin only (v1 W-17): the stage D reminder switch. Content
                  editors can open this tab and must not see it. */}
              {isAdmin && (
                <section id={WEBSITE_SETTINGS_SECTIONS.paymentReminders} className="scroll-mt-20">
                  <PaymentRemindersCard />
                </section>
              )}
              {/* Admin only (Paidy, 2026-10-03): the ato-barai switch and the
                  public key. set_paidy_settings re-checks the role. */}
              {isAdmin && (
                <section id={WEBSITE_SETTINGS_SECTIONS.paidy} className="scroll-mt-20">
                  <PaidySettingsCard />
                </section>
              )}
              {/* Admin only (Square S1, 2026-10-04): the "Pay by card" switch,
                  the PUBLIC Application ID / Location ID and the Card Purchase
                  Agreement threshold. set_square_settings re-checks the role.
                  The access token never comes here (Lovable secret). */}
              {isAdmin && (
                <section id={WEBSITE_SETTINGS_SECTIONS.square} className="scroll-mt-20 space-y-6">
                  <SquareSettingsCard />
                  {/* Square integrity (2026-10-04): the operator panel — holds,
                      open attempts, exceptions, refunds, disputes, webhook
                      problems and the settlement report. Admin only, like the
                      settings above; decide_square_case is staff-checked. */}
                  <SquareOperationsPanel />
                </section>
              )}
              {/* Admin only (website-orders PR 2): the storefront shipping
                  rate card. set_shipping_rate / deactivate_shipping_rate
                  re-check the admin role and audit every change. */}
              {isAdmin && (
                <section id={WEBSITE_SETTINGS_SECTIONS.shippingFees} className="scroll-mt-20">
                  <ShippingFeesCard />
                </section>
              )}
              <section id={WEBSITE_SETTINGS_SECTIONS.siteSettings} className="scroll-mt-20">
                <SettingsCard />
              </section>
            </TabsContent>
          )}

          {canCatalog && (
            <TabsContent value="page365-stock" className="mt-5 space-y-6" tabIndex={-1}>
              <Page365InventoryScheduleCard />
              <Page365InventoryCard />
              <Page365StockCard />
            </TabsContent>
          )}

          {canCatalog && (
            <TabsContent value="photos" className="mt-5 space-y-6" tabIndex={-1}>
              <MediaCutoutSettingsCard />
              <MediaCutoutReviewCard />
              {/* The hero's own cut-outs (original tool), apart from Photoroom's (docs/HERO-CUTOUTS.md). */}
              <HeroCutoutsCard />
            </TabsContent>
          )}

          {canReviews && (
            <TabsContent value="reviews" className="mt-5 space-y-6" tabIndex={-1}>
              <ReviewsCard />
            </TabsContent>
          )}
        </Tabs>
      </div>
    </AppLayout>
  );
}
