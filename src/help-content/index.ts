import welcomeContent from './welcome.md?raw';
import quickStartAdminContent from './quick-start-admin.md?raw';
import quickStartStaffContent from './quick-start-staff.md?raw';

export type HelpRole = 'admin' | 'finance' | 'staff' | 'csr' | 'customer';
export type HelpCategory = 'quick-start' | 'hub' | 'portal' | 'meta';

export interface HelpSection {
  slug: string;
  title: string;
  category: HelpCategory;
  order: number;
  roles: HelpRole[];
  content: string;
}

export const CATEGORY_LABELS: Record<HelpCategory, string> = {
  'quick-start': 'Quick Start',
  'hub': 'HUB Reference',
  'portal': 'Customer Portal',
  'meta': 'Meta',
};

export const HELP_SECTIONS: HelpSection[] = [
  {
    slug: 'welcome',
    title: 'Welcome',
    category: 'quick-start',
    order: 1,
    roles: ['admin', 'finance', 'staff', 'csr', 'customer'],
    content: welcomeContent,
  },
  {
    slug: 'quick-start-admin',
    title: 'For Admins',
    category: 'quick-start',
    order: 2,
    roles: ['admin'],
    content: quickStartAdminContent,
  },
  {
    slug: 'quick-start-staff',
    title: 'For Staff',
    category: 'quick-start',
    order: 3,
    roles: ['staff'],
    content: quickStartStaffContent,
  },
];

export function getSectionsForRole(role: HelpRole | undefined): HelpSection[] {
  if (!role) return [];
  const sorted = [...HELP_SECTIONS].sort((a, b) => a.order - b.order);
  if (role === 'admin') return sorted;
  return sorted.filter(s => s.roles.includes(role));
}

export function groupSectionsByCategory(
  sections: HelpSection[]
): Array<{ category: HelpCategory; label: string; items: HelpSection[] }> {
  const categories: HelpCategory[] = ['quick-start', 'hub', 'portal', 'meta'];
  return categories
    .map(cat => ({
      category: cat,
      label: CATEGORY_LABELS[cat],
      items: sections.filter(s => s.category === cat),
    }))
    .filter(group => group.items.length > 0);
}
