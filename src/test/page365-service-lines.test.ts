import { describe, expect, it } from "vitest";
import { isPage365ServiceLine } from "../../supabase/functions/_shared/page365-service-lines.ts";

// Every distinct line name ever imported from Page365 (live, 2026-10-27).
const REAL_PRODUCTS = [
  "7DLY Ring K18 3.0g Abacus shaped 7 Layers one-size-fits-all",
  "B2200 Bag Burberry Leather Clutch Second Bag [Preloved]",
  "B2418 Bracelet Tiffany & Co. 750 2.40g Kiss X Paloma Picasso 18.5cm [Preloved]",
  "B3M46 Bracelet K18 2.35g Open Circle chain 15+3cm",
  "B5575 Bracelet K18 2.50g 7pcs Akoya Pearl 5.5-7.5mm 18.0cm",
  "B7517 Bracelet K18 0.75g Heart Chain 17cm",
  "B7547 Bracelet Tiffany & Co. 750 4.70g Bean 17cm [Preloved]",
  "B7577 Bangle Tiffany & Co. 750 7.70g Ball Bypass 15cm [Preloved]",
  "BHC80 Pelican Loving Butt Hip Care Soap 80g",
  "BK417 Bracelet K18 1.05g Figaro Paperclip 17cm",
  "BK418 Bracelet K18 1.10g Figaro Paperclip 18cm",
  "BL5RE Bracelet K18 6.90g Roro Chain 5 Elephant Charms 18cm",
  "BLCH1 Bracelet K18 15.70g Roro Chain Star Moon Heart Ball Charms Design 1 18cm",
  "BLCH2 Bracelet K18 18.20g Roro Chain Star Moon Heart Ball Charms Design 2 18cm",
  "BLCH3 Bracelet K18WG 19.05g Roro Chain Star Moon Heart Ball Charms Design 2 18cm",
  "BPC18 Bracelet K18 0.55g Paperclip 18cm",
  "Bracelet K18 Hardware Tiffany Inspired",
  "BRC18 Bracelet K18 0.83g Rope Chain 18cm",
  "CHCP12 Novelty Chanel Passport Case Mesh Mini Pouch",
  "DTB42 Novelty Dior Toile de Jouy Tote Bag Limited Edition White Blue Navy",
  "E1503 Earrings K18WG 1.50g Black Opal Oval Shaped [Preloved]",
  "E1760 Earrings K18 1.70g Diamond 0.607, 0.72ct Floral Cluster",
  "E2263 Earrings PT900 2.20g Diamond 0.636ct Solitaire [Preloved]",
  "E2713 Earrings K18 2.70g Ruby 1.38ct Diamond 0.88ct Sunburst Cluster",
  "E2M40 Earrings K18 2.50g Black Onyx 15.0mm VCA Inspired",
  "E3267 Earrings PT950/900 3.20g Diamond 0.671, 0.78ct Double Halo Stud",
  "E3404 Earrings PT900 3.40g Aquamarine Diamond Sunburst Cluster [Preloved]",
  "E5248 Earrings K18 5.20g Diamond 0.548ct Hexagon Hoop [Preloved]",
  "E5432 Earrings K18 5.40g B.T 0.86ct T 0.22ct Dia 0.32ct Drop Stud [Preloved]",
  "E5750 Earrings K18WG 5.70g Diamond 0.50ct Triple Tier Drop Heart [Preloved]",
  "E6781 Earrings K18 6.78g Diamond 1.0ct Inside-Out Placement [New]",
  "E7029 Earrings PT900 0.70g Diamond 0.297ct (D VS1 E), 0.268ct (F VS1 G) Stud",
  "E7070 Earrings PT900 0.70g Diamond 0.70ct Solitaire [Preloved]",
  "E7508 Earrings Bvlgari 750WG 8.0g Bzero1 Hoop [Preloved]",
  "E7511 Earrings Tiffany & Co. 750 11.60g Atlas Hoop [Preloved]",
  "E7535 Earrings Bvlgari 750PG 3.50g Mother of Pearl Stud [Preloved]",
  "E7571 Earrings Bvlgari 750 7.10g Bvlgari Diamond Stud [Preloved]",
  "Earrings K18 Hoop",
  "EKP14 Earrings K18/PT900 0.70g Open Clover 14mm",
  "ESH11 Earrings PT900 Natural White South Sea Pearl 11.0mm Hook Type",
  "ESH12 Earrings PT900 Natural White South Sea Pearl 12.0mm Hook Type",
  "EWS12 Earrings PT900 Natural White South Sea Pearl 12.0mm",
  "HB217 Bracelet K18 2.10g Heart Bizmarck 2.50mm 17cm",
  "HB243 Necklace K18 4.80g Heart Bizmarck 2.50mm 43cm",
  "JO177 Earrings K18 1.75g Hook Type Kihei 4.5cm",
  "N1049 Necklace Mikimoto K18 2.80g 5.0mm Pearl Ribbon 40cm [Preloved]",
  "N1214 Necklace K18 3.70g Diamond 0.26ct Solitaire 42cm [Preloved]",
  "N1245 Necklace K18WG 1.20g Diamond 0.14ct Dancing Diamond 45cm [Preloved]",
  "N1337 Necklace SV925 Tahiti SSP 9.5-10.0mm 45cm [Preloved]",
  "N1594 Necklace PT850/900 5.0g Diamond 1.0ct Rectangle Plaque 45cm [Preloved]",
  "N1745 Necklace K18 1.75g Heart Chain 45cm",
  "N1J75 Necklace K18 3.50g 2 Line Heart Top 40cm Adjustable",
  "N2645 Necklace Tiffany & Co. 750PG 2.60g Ampersand Crescent Moon 45cm [Preloved]",
  "N2J74 Necklace K18 3.50g 2 Line Cross Top 40cm Adjustable",
  "N3813 Necklace SV 15.90g Tourmaline 42cm [Preloved]",
  "N4032 Necklace Saint Laurent K18 3.20g R0.05ct D0.10ct Logo YSL 40cm [Preloved]",
  "N4034 Necklace Saint Laurent K18 3.40g Logo YSL 40cm [Preloved]",
  "N4224 Necklace PT850 4.20g Emerald 0.54ct Dia 0.24ct Oval Halo  40cm [Preloved]",
  "N6440 Necklace PT850/900 6.40g Diamond 1.0ct Floral Cluster 40cm [Preloved]",
  "N7441 Necklace Tiffany & Co. 750 7.40g Elsa Perreti Bean 41.0cm [Used]",
  "N9545 Necklace K18 9.45g Ball Chain Mirror Ball 45cm Adjustable",
  "Necklace K18 Paperclip Chain Unisex",
  "NL366 Necklace K18 1.20g 10pc Ball 3.0mm Station Movable 40cm",
  "NLJ70 Necklace K18 Rosary Black Spinel Onyx Jade 70cm",
  "NLS70 Necklace K18 Rosary Black Spinel Onyx Sango 70cm",
  "P1421 Pendant K18 0.90g Ruby 0.43ct Diamond 0.14ct [Preloved]",
  "P1471 Pendant Brooch K18WG 16.40g Diamond 1.10ct Owl [Preloved]",
  "P1982 Pendant K18 1.50g Heart Shaped 4x13mm Reversible",
  "P2578 Pendant PT900 3.80g Diamond 0.30ct Clover Top [Used]",
  "P3201 Pendant K18WG 3.20g Diamond 1.0ct Camella Floral [Preloved]",
  "Pendant Shell Cameo K18 Turquoise Shell Onyx Mosaic Lady 40x30mm Reversible",
  "PNBN1 Pendant K18 Natural Jade Bean",
  "PPS112 Earrings PT900 Golden South Sea Pearl 11.0mm Stud",
  "PPS14 Earrings K18 Natural Golden South Sea Pearl 14.0mm Stud",
  "R1056 Ring K18 10.55g Sapphire 0.78ct Diamond 0.66ct Sz# 9 [Preloved]",
  "R1322 Ring K18 2.20g Heart Links Disconnected Sz# 13",
  "R2117 Ring PT900 11.0g Diamond 2.0ct Rhombus Sz# 14 [Preloved]",
  "R3701 Ring Bvlgari 750PG 3.70g Bzero1 Essential Band Sz# 13 [Preloved]",
  "R4612 Heiwado Ring PT900 4.60g Diamond 0.31ct Solitaire Sz# 12.5 [Preloved]",
  "R6613 Ring 18K 6.60g Diamond 1.0ct Interlock C Buckle Sz# 13.5 [Preloved]",
  "RC456 Ring Cartier 750 4.66g 3 Tone Gold Wedding Ring #56 [Preloved]",
  "Ring K18 Long Mesh Ring Finger",
  "T1489 Tory Burch Leather Tote Bag [Preloved]",
  "TKN19 Necklace SV925 6.20g Black Diamond 29.39ct 40cm [Preloved]",
  "UL410 Pendant K18 0.80g Turtle Motif Top",
  "W1011 Watch Rado Integral Quartz SS/CE Black 16cm [Used]",
  "W3253 Wallet Prada Saffiano Card Case [Used]",
  "YSLT8 Yves Saint Laurent Novelty Tote Bag Black Gold Embroidered Logo",
];

describe("Page365 service lines (owner 2026-10-27: leave out all kinds of services)", () => {
  it("marks the two service lines seen on real invoices", () => {
    expect(isPage365ServiceLine("RESIZE FEE")).toBe(true);
    expect(isPage365ServiceLine("Certificate Mini Booklet (A5 Size)")).toBe(true);
  });

  it("marks every kind of Hub service", () => {
    for (const n of [
      "Resize", "Re-size fee", "Ring sizing", "Bracelet Resize", "Certificate", "Certification fee",
      "Polish", "Polishing", "Watch Polishing", "Color Change", "Colour change", "Change color",
      "Engraving", "Repair", "Repairing fee", "Appraisal", "Replating", "Re-plating", "Plating fee",
      "Cleaning", "Service fee", "Service charge", "Labor fee", "Labour",
    ]) expect(isPage365ServiceLine(n), n).toBe(true);
  });

  it("never marks a real imported product as a service", () => {
    for (const n of REAL_PRODUCTS) expect(isPage365ServiceLine(n), n).toBe(false);
  });

  it("keeps a coded product that mentions a service word a product", () => {
    expect(isPage365ServiceLine("R2117 Ring PT900 Diamond 1.0ct with GIA Certificate")).toBe(false);
    expect(isPage365ServiceLine("E1234 Earrings K18 Polish finish")).toBe(false);
  });

  it("does not read adjectives as services", () => {
    expect(isPage365ServiceLine("Ring K18 High Polished Band")).toBe(false);
    expect(isPage365ServiceLine("Bracelet K18 Engraved Bar")).toBe(false);
    expect(isPage365ServiceLine("")).toBe(false);
    expect(isPage365ServiceLine(null)).toBe(false);
  });
});
