// Idempotency key for the "shipped" email (notify-shipped, payment lifecycle H7).
// Keyed on shipped_at so a double click sends once, while re-marking after an
// undo (a new shipped_at) is a new dispatch. Pure: no Deno.serve, testable alone.
export function shippedKey(kind: string, id: string, shippedAt: string): string {
  return `shipped-${kind}-${id}-${shippedAt}`;
}
