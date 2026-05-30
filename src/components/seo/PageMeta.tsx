import { Helmet } from "react-helmet-async";

interface PageMetaProps {
  title: string;
  description: string;
  path: string;
}

const ORIGIN = "https://portal.chajewelsjp.com";

/**
 * Per-route head tags. Provides unique title, meta description,
 * canonical link, and Open Graph title/description so social shares
 * of different routes preview distinctly.
 */
export default function PageMeta({ title, description, path }: PageMetaProps) {
  const url = `${ORIGIN}${path}`;
  return (
    <Helmet>
      <title>{title}</title>
      <meta name="description" content={description} />
      <link rel="canonical" href={url} />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={url} />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
    </Helmet>
  );
}
