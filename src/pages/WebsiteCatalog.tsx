import { useAuth } from "@/contexts/AuthContext";
import PageMeta from "@/components/seo/PageMeta";
import AppLayout from "@/components/layout/AppLayout";
import { Globe } from "lucide-react";
import ProductsCard from "@/components/website/ProductsCard";
import { JewelryTypesCard } from "@/components/website/JewelryTypesCard";
import { CategoriesCard } from "@/components/website/CategoriesCard";
import { TestimonialsCard } from "@/components/website/TestimonialsCard";
import { NewsletterSubscribersCard } from "@/components/website/NewsletterSubscribersCard";
import { WholesaleInquiriesCard } from "@/components/website/WholesaleInquiriesCard";

/**
 * Public website catalog manager. Feeds the `website` API used by chajewelsjp.com.
 *
 * Every card on this page now lives in components/website/ — this file is the
 * page chrome and the order they appear in, nothing else.
 */
export default function WebsiteCatalog() {
  const { roles } = useAuth();
  const isAdmin = !!roles?.includes("admin");

  return (
    <AppLayout>
      <div className="p-6 space-y-6">
        <PageMeta
          title="Website Catalog | Cha Jewels Hub"
          description="Manage the products, jewelry types and imagery published on the Cha Jewels public website."
          path="/website-catalog"
        />

        <div className="flex items-center gap-3">
          <Globe className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Website Catalog</h1>
            <p className="text-sm text-muted-foreground">
              Everything shown on chajewelsjp.com. Only <span className="text-foreground">Active</span> products are published.
            </p>
          </div>
        </div>

        <ProductsCard />
        <JewelryTypesCard isAdmin={isAdmin} />
        <CategoriesCard isAdmin={isAdmin} />
        <TestimonialsCard isAdmin={isAdmin} />
        <NewsletterSubscribersCard />
        <WholesaleInquiriesCard />
      </div>
    </AppLayout>
  );
}
