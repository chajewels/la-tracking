import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Globe } from "lucide-react";
import PageMeta from "@/components/seo/PageMeta";
import AppLayout from "@/components/layout/AppLayout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

/**
 * The Website workspace — everything that feeds chajewelsjp.com, on four tabs.
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
 *   audience         → EITHER, with each card on its own key — see canAudience
 */
export const WEBSITE_TABS = ["catalog", "content", "audience", "settings"] as const;
export type WebsiteTab = (typeof WEBSITE_TABS)[number];

const isWebsiteTab = (v: string | null): v is WebsiteTab =>
  !!v && (WEBSITE_TABS as readonly string[]).includes(v);

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
          <TabsList>
            {canCatalog && <TabsTrigger value="catalog">Catalog</TabsTrigger>}
            {canContent && <TabsTrigger value="content">Content</TabsTrigger>}
            {canAudience && <TabsTrigger value="audience">Audience</TabsTrigger>}
            {canContent && <TabsTrigger value="settings">Settings</TabsTrigger>}
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
              <SettingsCard />
            </TabsContent>
          )}
        </Tabs>
      </div>
    </AppLayout>
  );
}
