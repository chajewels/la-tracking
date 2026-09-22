import { postSlug } from "@/components/website/website-posts";

/**
 * Shape and rules for the storefront FAQ: public.website_faq_sections and
 * public.website_faq_items.
 *
 * Pure — no Supabase — so the ordering and the validation are testable without
 * a database (src/test/website-faq.test.ts).
 *
 * THE ONE THING TO KNOW ABOUT THIS TABLE PAIR: website_faq_items.section_id is
 * ON DELETE CASCADE. Deleting a section takes every answer in it with it,
 * silently, at the database. Nothing in the Hub may delete a section that still
 * has items — `sectionDeleteBlocker` below is that guard, and it is the only
 * thing between a mis-click and a page of published terms.
 */

export interface FaqSectionRow {
  id: string;
  slug: string;
  title_en: string;
  title_ja: string | null;
  sort_order: number | null;
  published: boolean | null;
}

export interface FaqItemRow {
  id: string;
  section_id: string;
  question_en: string;
  question_ja: string | null;
  answer_en: string;
  answer_ja: string | null;
  layaway_only: boolean | null;
  sort_order: number | null;
  published: boolean | null;
}

export const FAQ_SECTION_SELECT = "id, slug, title_en, title_ja, sort_order, published";
export const FAQ_ITEM_SELECT =
  "id, section_id, question_en, question_ja, answer_en, answer_ja, layaway_only, sort_order, published";

export interface FaqSectionDraft {
  id?: string;
  slug: string;
  title_en: string;
  title_ja: string;
  published: boolean;
}

export interface FaqItemDraft {
  id?: string;
  section_id: string;
  question_en: string;
  question_ja: string;
  answer_en: string;
  answer_ja: string;
  layaway_only: boolean;
  published: boolean;
}

/** Both tables default `published` to TRUE, so a new draft must too — otherwise
 *  the editor shows a state the database would not have produced. */
export const emptySection = (): FaqSectionDraft => ({
  slug: "", title_en: "", title_ja: "", published: true,
});

export const emptyItem = (section_id: string): FaqItemDraft => ({
  section_id, question_en: "", question_ja: "", answer_en: "", answer_ja: "",
  layaway_only: false, published: true,
});

export const sectionToDraft = (r: FaqSectionRow): FaqSectionDraft => ({
  id: r.id,
  slug: r.slug ?? "",
  title_en: r.title_en ?? "",
  title_ja: r.title_ja ?? "",
  published: r.published !== false,
});

export const itemToDraft = (r: FaqItemRow): FaqItemDraft => ({
  id: r.id,
  section_id: r.section_id,
  question_en: r.question_en ?? "",
  question_ja: r.question_ja ?? "",
  answer_en: r.answer_en ?? "",
  answer_ja: r.answer_ja ?? "",
  layaway_only: !!r.layaway_only,
  published: r.published !== false,
});

/**
 * The section slug is NOT NULL UNIQUE and becomes an anchor on the FAQ page,
 * so it wants exactly the rule the posts editor already has — accents folded,
 * apostrophes kept inside the word, capped on a word boundary, idempotent.
 * Reused rather than reimplemented: a third slug rule in this folder is a third
 * way for two of them to disagree.
 */
export const faqSlug = postSlug;

const nullable = (v: string) => v.trim() || null;

export function validateSection(d: FaqSectionDraft, others: { id: string; slug: string }[]): string[] {
  const errs: string[] = [];
  if (!d.title_en.trim()) errs.push("An English title is required.");
  const slug = d.slug.trim();
  if (!slug) errs.push("A slug is required — it is the section's anchor on the FAQ page.");
  else if (slug !== faqSlug(slug)) errs.push("The slug may use lowercase letters, numbers and hyphens only.");
  else if (others.some((o) => o.slug === slug && o.id !== d.id)) {
    errs.push(`Another section already uses the slug "${slug}".`);
  }
  return errs;
}

export function validateItem(d: FaqItemDraft): string[] {
  const errs: string[] = [];
  if (!d.question_en.trim()) errs.push("An English question is required.");
  if (!d.answer_en.trim()) errs.push("An English answer is required.");
  return errs;
}

export function sectionPayload(d: FaqSectionDraft, userId: string | null, sortOrder?: number) {
  return {
    ...(d.id ? { id: d.id } : {}),
    slug: d.slug.trim(),
    title_en: d.title_en.trim(),
    title_ja: nullable(d.title_ja),
    published: d.published,
    ...(sortOrder === undefined ? {} : { sort_order: sortOrder }),
    updated_by: userId,
  };
}

export function itemPayload(d: FaqItemDraft, userId: string | null, sortOrder?: number) {
  return {
    ...(d.id ? { id: d.id } : {}),
    section_id: d.section_id,
    question_en: d.question_en.trim(),
    question_ja: nullable(d.question_ja),
    answer_en: d.answer_en.trim(),
    answer_ja: nullable(d.answer_ja),
    layaway_only: d.layaway_only,
    published: d.published,
    ...(sortOrder === undefined ? {} : { sort_order: sortOrder }),
    updated_by: userId,
  };
}

/** Rows in the order the site shows them: sort_order, then a stable tiebreak so
 *  two rows sharing a sort_order never swap places between renders. */
export function inOrder<T extends { id: string; sort_order: number | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const d = (a.sort_order ?? 0) - (b.sort_order ?? 0);
    return d !== 0 ? d : a.id.localeCompare(b.id);
  });
}

/** The next sort_order at the end of a list. The columns default to 100, so an
 *  empty list starts there rather than at 0. */
export function nextSortOrder(rows: { sort_order: number | null }[]): number {
  if (!rows.length) return 100;
  return Math.max(...rows.map((r) => r.sort_order ?? 0)) + 10;
}

export interface ReorderWrite { id: string; sort_order: number }

/**
 * Move one row up or down within its list.
 *
 * Returns the two rows whose sort_order must be written, or null when the move
 * is off the end. It rewrites BOTH rather than swapping the stored numbers,
 * because two rows can share a sort_order (nothing in the schema forbids it)
 * and a swap between equal values is a no-op that looks like a broken button.
 */
export function reorder<T extends { id: string; sort_order: number | null }>(
  rows: T[], id: string, direction: -1 | 1,
): ReorderWrite[] | null {
  const ordered = inOrder(rows);
  const i = ordered.findIndex((r) => r.id === id);
  if (i < 0) return null;
  const j = i + direction;
  if (j < 0 || j >= ordered.length) return null;

  const a = ordered[i];
  const b = ordered[j];
  const aOrder = a.sort_order ?? 0;
  const bOrder = b.sort_order ?? 0;
  // Equal (or absent) values would swap to themselves; step them apart instead.
  if (aOrder === bOrder) {
    return direction === -1
      ? [{ id: a.id, sort_order: bOrder - 1 }, { id: b.id, sort_order: bOrder }]
      : [{ id: a.id, sort_order: bOrder + 1 }, { id: b.id, sort_order: bOrder }];
  }
  return [{ id: a.id, sort_order: bOrder }, { id: b.id, sort_order: aOrder }];
}

/**
 * Why this section may not be deleted, or null when it may.
 *
 * section_id is ON DELETE CASCADE: the database will remove every item without
 * complaint. This refusal is the only thing that stops a click from taking a
 * page of published layaway and loyalty terms with it.
 */
export function sectionDeleteBlocker(itemCount: number): string | null {
  if (itemCount === 0) return null;
  return `${itemCount} question${itemCount === 1 ? "" : "s"} still ${itemCount === 1 ? "sits" : "sit"} in this section. ` +
    "Deleting it would delete them too — move or remove them first.";
}
