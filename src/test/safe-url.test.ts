import { describe, expect, it } from 'vitest';
import { isOwnProofUrl, ownSupabaseHost, safeHttpUrl } from '@/lib/safe-url';

describe('safeHttpUrl (QC P1-1)', () => {
  it('passes http(s) links through unchanged', () => {
    const u = 'https://x.supabase.co/storage/v1/object/public/payment-proofs/a/b.jpg';
    expect(safeHttpUrl(u)).toBe(u);
    expect(safeHttpUrl('http://example.com/a.pdf')).toBe('http://example.com/a.pdf');
  });
  it('refuses script, data and other schemes', () => {
    expect(safeHttpUrl('javascript:alert(1)//x.pdf')).toBeNull();
    expect(safeHttpUrl(' JavaScript:alert(1)')).toBeNull();
    expect(safeHttpUrl('java\tscript:alert(1)')).toBeNull();
    expect(safeHttpUrl('data:text/html;base64,PHNjcmlwdD4=')).toBeNull();
    expect(safeHttpUrl('vbscript:x')).toBeNull();
    expect(safeHttpUrl('file:///etc/passwd')).toBeNull();
  });
  it('refuses blanks, relative and unparseable values', () => {
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
    expect(safeHttpUrl('   ')).toBeNull();
    expect(safeHttpUrl('a/b.jpg')).toBeNull();
    expect(safeHttpUrl('//evil.example/x')).toBeNull();
  });
});

describe('isOwnProofUrl (bulk import CSV)', () => {
  const host = ownSupabaseHost('https://abcd.supabase.co');
  it('derives the host from a base URL', () => {
    expect(host).toBe('abcd.supabase.co');
    expect(ownSupabaseHost('')).toBeNull();
  });
  it('accepts only our payment-proofs bucket', () => {
    expect(isOwnProofUrl('https://abcd.supabase.co/storage/v1/object/public/payment-proofs/bulk-import/k/x.jpg', host)).toBe(true);
    expect(isOwnProofUrl('https://drive.google.com/file/d/x', host)).toBe(false);
    expect(isOwnProofUrl('https://abcd.supabase.co/storage/v1/object/public/brand-assets/x.jpg', host)).toBe(false);
    expect(isOwnProofUrl('https://abcd.supabase.co/storage/v1/object/public/payment-proofs/x.jpg', null)).toBe(false);
  });
});
