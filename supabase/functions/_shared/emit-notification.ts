// emit-notification — Phase 4.2
//
// Shared helper that auto-trigger sites call to insert a single-recipient
// loyalty notification. Direct DB INSERT (no edge function HTTP roundtrip),
// fire-and-forget pattern — the parent operation never fails on
// notification error.
//
// Two writes per call:
//   1. INSERT loyalty_notifications (master row, status='sent' immediately)
//   2. INSERT loyalty_notification_recipients (single recipient row)
//
// Email side-fire policy (per Phase 4.2 design): callers pass
// send_email=false so this helper does NOT call send-transactional-email.
// The flag is recorded on the master row for audit visibility.
// Existing transactional email gates (loyalty_email_earned,
// loyalty_email_redeem, etc.) already cover the email channel for the
// same events; doubling up would double-email customers.

const VALID_CATEGORIES = new Set([
  // Phase 4 admin-pickable
  'info', 'promo', 'tier', 'system', 'reward', 'birthday',
  // Phase 4.2 auto-trigger
  'points', 'redemption', 'order', 'expiry', 'milestone',
]);

export type NotificationCategory =
  | 'info' | 'promo' | 'tier' | 'system' | 'reward' | 'birthday'
  | 'points' | 'redemption' | 'order' | 'expiry' | 'milestone';

export interface EmitNotificationArgs {
  category: NotificationCategory;
  title: string;
  body: string;
  link_target?: string | null;
  send_email?: boolean;
}

/**
 * Insert a single-recipient loyalty notification for the given member.
 *
 * Fire-and-forget: errors are logged via console.error with the prefix
 * '[loyalty-notify]' and silently swallowed. Returns void unconditionally
 * so callers can `void emitNotification(...)` without awaiting and the
 * parent operation never blocks or fails on notification issues.
 *
 * Validates member_id presence and category membership before any DB
 * round-trip. Title/body length validation is delegated to the
 * loyalty_notifications CHECK constraints — over-long inputs surface
 * as a check_violation in the catch block.
 */
// deno-lint-ignore no-explicit-any
export async function emitNotification(
  supabase: any,
  member_id: string,
  args: EmitNotificationArgs,
): Promise<void> {
  if (!member_id) {
    console.warn(
      '[loyalty-notify] skipped — member_id is required',
    );
    return;
  }
  if (!VALID_CATEGORIES.has(args.category)) {
    console.warn(
      `[loyalty-notify] skipped — invalid category '${args.category}' for member_id=${member_id}`,
    );
    return;
  }

  try {
    // Step 1: master row. status='sent' immediately because this is a
    // direct fan-out to a single recipient — no scheduling, no batching,
    // no queue handoff. audience_member_ids is NULL because the
    // recipient row IS the truth for who received it (Q9 ephemeral
    // semantics, but we're skipping the planning state entirely for
    // auto-triggers).
    const { data: master, error: masterErr } = await supabase
      .from('loyalty_notifications')
      .insert({
        title: args.title,
        body: args.body,
        category: args.category,
        audience_type: 'specific',
        audience_member_ids: null,
        link_target: args.link_target ?? null,
        status: 'sent',
        sent_at: new Date().toISOString(),
        send_email: args.send_email ?? false,
        email_sent: false,
        created_by_user_id: null,
      })
      .select('id')
      .single();

    if (masterErr) {
      console.error(
        `[loyalty-notify] master insert failed for member_id=${member_id} category=${args.category}:`,
        masterErr,
      );
      return;
    }

    // Step 2: recipient row. UNIQUE (notification_id, member_id) on the
    // table prevents accidental duplicates if this helper is somehow
    // re-invoked with the same master id (shouldn't happen — masterErr
    // path above guards against insert-then-recover, and master.id is
    // freshly generated). is_read defaults to false on the column.
    const { error: recipErr } = await supabase
      .from('loyalty_notification_recipients')
      .insert({
        notification_id: master.id,
        member_id,
        is_read: false,
        read_at: null,
      });

    if (recipErr) {
      console.error(
        `[loyalty-notify] recipient insert failed for member_id=${member_id} category=${args.category} master_id=${master.id}:`,
        recipErr,
      );
      // Don't roll back the master row — leaves an orphaned master row
      // (no recipients), which is harmless. customer-portal joins
      // recipients to master so the customer never sees the orphan; the
      // admin Notifications tab will show 0 recipients for the row,
      // which is the correct signal that something went wrong.
      return;
    }
  } catch (err) {
    console.error(
      `[loyalty-notify] emit failed for member_id=${member_id} category=${args.category}:`,
      err,
    );
    // Silently swallow — fire-and-forget contract.
  }
}
