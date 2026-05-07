// cleanup-loyalty-images — Phase 3.5.1
//
// Cron-driven orphan detection + cleanup. Identifies images in the
// loyalty-images bucket not referenced by any loyalty_promos /
// loyalty_rewards / loyalty_banners image_url field, then deletes
// them (or logs them when in dry-run mode).
//
// Auth: service_role JWT only. Cron schedule provides the JWT via
// Authorization header; isServiceRoleCaller decodes the payload and
// rejects anything where role !== 'service_role'. Pattern mirrors
// process-loyalty-notification-queue (Phase 4 sibling cron).
//
// Schedule: Sunday 04:00 UTC = Sunday 12:00 PHT (jobid TBD when
// Phase 3.5.1 C1 SQL is applied via Lovable SQL Editor).
//
// Dry-run gate: system_settings.cleanup_loyalty_images_dry_run
// (default true if missing). Override per-invocation via
// ?dry_run=true|false query param.
//
// Safety cap: HARD_CAP = 50. If detected orphan count exceeds the
// cap the function halts without deleting anything and writes a
// 'cleanup_halted' audit row. Deliberate manual investigation is
// then required before flipping the dry-run flag off.
//
// Performance: single storage.list, three parallel SELECTs, optional
// single storage.remove. Sub-second on typical bucket size (<100
// files).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  LOYALTY_IMAGES_BUCKET,
  loyaltyImagesPath,
} from "../_shared/loyalty-images-path.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const HARD_CAP = 50;
const STORAGE_LIST_LIMIT = 1000;
const SETTINGS_KEY = "cleanup_loyalty_images_dry_run";

// Phase 2 sentinel — audit_logs.entity_id is UUID NOT NULL and this
// function operates at system level (no per-row UUID). a2 distinguishes
// loyalty_images_cleanup from loyalty_settings (a1).
const AUDIT_SENTINEL_ID = "00000000-0000-0000-0000-0000000000a2";

function isServiceRoleCaller(req: Request): boolean {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice(7).trim();
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const payloadB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payloadB64 + "=".repeat((4 - payloadB64.length % 4) % 4);
    const payload = JSON.parse(atob(padded));
    return payload.role === "service_role";
  } catch {
    return false;
  }
}

// Resolve dry_run flag. ?dry_run=true|false overrides; otherwise read
// system_settings.cleanup_loyalty_images_dry_run. Fail-safe to true on
// any infrastructure error so the function never silently deletes
// because of a missing key, RLS denial, or transient DB failure.
async function resolveDryRun(
  supabase: ReturnType<typeof createClient>,
  url: URL,
): Promise<boolean> {
  const param = url.searchParams.get("dry_run");
  if (param === "true") return true;
  if (param === "false") return false;

  try {
    const { data, error } = await supabase
      .from("system_settings")
      .select("value")
      .eq("key", SETTINGS_KEY)
      .maybeSingle();

    if (error) {
      console.warn(
        `[cleanup-loyalty-images] system_settings read failed, defaulting to dry_run=true:`,
        error.message ?? error,
      );
      return true;
    }
    if (!data) {
      console.warn(
        `[cleanup-loyalty-images] system_settings key '${SETTINGS_KEY}' missing, defaulting to dry_run=true`,
      );
      return true;
    }

    let parsed: unknown = data.value;
    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        // leave as-is; coercion below catches it
      }
    }
    // Only an explicit `false` (boolean or "false" string) disables
    // dry-run. Anything else (true, null, malformed) stays in dry-run.
    return !(parsed === false || parsed === "false");
  } catch (err) {
    console.warn(
      `[cleanup-loyalty-images] unexpected error reading dry_run setting, defaulting to true:`,
      err,
    );
    return true;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (!isServiceRoleCaller(req)) {
    console.warn("[cleanup-loyalty-images] rejected: caller is not service_role");
    return json({ error: "service_role required" }, 403);
  }

  const startedAt = Date.now();

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const url = new URL(req.url);
  const dryRun = await resolveDryRun(supabase, url);

  // 1. List bucket files (flat root — Phase 3.5 stores everything in
  //    the bucket root).
  const { data: listing, error: listErr } = await supabase.storage
    .from(LOYALTY_IMAGES_BUCKET)
    .list("", { limit: STORAGE_LIST_LIMIT });

  if (listErr) {
    console.error("[cleanup-loyalty-images] storage.list failed:", listErr);
    return json(
      { error: `storage list failed: ${listErr.message}` },
      500,
    );
  }

  // Filter out folder placeholders (id === null). Bucket is flat; this
  // is defensive against future shape drift.
  const bucketFiles = (listing ?? [])
    .filter((row) => row.id !== null && row.name)
    .map((row) => row.name);
  const filesScanned = bucketFiles.length;

  // 2. Collect referenced filenames from the 3 catalog tables.
  const [promosRes, rewardsRes, bannersRes] = await Promise.all([
    supabase
      .from("loyalty_promos")
      .select("image_url")
      .not("image_url", "is", null),
    supabase
      .from("loyalty_rewards")
      .select("image_url")
      .not("image_url", "is", null),
    supabase
      .from("loyalty_banners")
      .select("image_url")
      .not("image_url", "is", null),
  ]);

  const fetchErr = promosRes.error ?? rewardsRes.error ?? bannersRes.error;
  if (fetchErr) {
    console.error("[cleanup-loyalty-images] catalog query failed:", fetchErr);
    return json(
      { error: `catalog query failed: ${fetchErr.message}` },
      500,
    );
  }

  const referenced = new Set<string>();
  const allRows = [
    ...(promosRes.data ?? []),
    ...(rewardsRes.data ?? []),
    ...(bannersRes.data ?? []),
  ] as Array<{ image_url: string | null }>;
  for (const row of allRows) {
    const path = loyaltyImagesPath(row.image_url);
    if (path) referenced.add(path);
  }

  // 3. Compute orphans = bucket files not in referenced set. URLs that
  //    don't match the bucket pattern (legacy paste-only externals)
  //    correctly drop out at loyaltyImagesPath — they're not in the
  //    bucket either, so they can't be orphans.
  const orphans = bucketFiles.filter((name) => !referenced.has(name));
  const orphanCount = orphans.length;

  // 4. Hard-cap halt — protects against catastrophic accidental
  //    deletion if the catalog tables are wiped or corrupted.
  if (orphanCount > HARD_CAP) {
    console.warn(
      `[cleanup-loyalty-images] HALTED: ${orphanCount} orphans detected exceeds cap of ${HARD_CAP}; investigation required`,
    );

    await supabase.from("audit_logs").insert({
      entity_type: "loyalty_images_cleanup",
      entity_id: AUDIT_SENTINEL_ID,
      action: "cleanup_halted",
      performed_by_user_id: null,
      new_value_json: {
        files_scanned: filesScanned,
        orphans_detected: orphanCount,
        files_deleted: 0,
        dry_run: dryRun,
        safety_cap_hit: true,
        cap: HARD_CAP,
        elapsed_ms: Date.now() - startedAt,
      },
    });

    return json({
      halted: true,
      orphan_count: orphanCount,
      deleted: 0,
    });
  }

  // 5. Dry-run path — log, audit, do not delete.
  if (dryRun) {
    const preview = orphans.slice(0, 10);
    const overflow = orphans.length > 10 ? ` (+${orphans.length - 10} more)` : "";
    console.log(
      `[cleanup-loyalty-images] DRY RUN: ${orphanCount} orphans would be deleted: ${JSON.stringify(preview)}${overflow}`,
    );

    await supabase.from("audit_logs").insert({
      entity_type: "loyalty_images_cleanup",
      entity_id: AUDIT_SENTINEL_ID,
      action: "cleanup_dry_run",
      performed_by_user_id: null,
      new_value_json: {
        files_scanned: filesScanned,
        orphans_detected: orphanCount,
        files_deleted: 0,
        dry_run: true,
        safety_cap_hit: false,
        cap: HARD_CAP,
        elapsed_ms: Date.now() - startedAt,
      },
    });

    return json({
      dry_run: true,
      orphan_count: orphanCount,
      deleted: 0,
      would_delete: orphans,
    });
  }

  // 6. Real delete path. storage.remove takes the full array; partial
  //    failures land in error while data still reports per-file
  //    success metadata. Final audit row reports actual deleted count.
  let deleted = 0;
  if (orphanCount > 0) {
    const { data: removeData, error: removeErr } = await supabase.storage
      .from(LOYALTY_IMAGES_BUCKET)
      .remove(orphans);

    if (removeErr) {
      console.error("[cleanup-loyalty-images] storage.remove error:", removeErr);
      // Do not abort — still record actual successes.
    }
    deleted = (removeData ?? []).length;
    console.log(
      `[cleanup-loyalty-images] Deleted ${deleted} orphan files (of ${orphanCount} detected)`,
    );
  }

  await supabase.from("audit_logs").insert({
    entity_type: "loyalty_images_cleanup",
    entity_id: AUDIT_SENTINEL_ID,
    action: "cleanup_run",
    performed_by_user_id: null,
    new_value_json: {
      files_scanned: filesScanned,
      orphans_detected: orphanCount,
      files_deleted: deleted,
      dry_run: false,
      safety_cap_hit: false,
      cap: HARD_CAP,
      elapsed_ms: Date.now() - startedAt,
    },
  });

  return json({
    dry_run: false,
    orphan_count: orphanCount,
    deleted,
  });
});
