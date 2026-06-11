import type { AbstractPowerSyncDatabase, PowerSyncBackendConnector } from "@powersync/common";
import { supabase, ensureAnonymousSession } from "./supabase";

const powersyncUrl = process.env.EXPO_PUBLIC_POWERSYNC_URL;

export class SupabasePowerSyncConnector implements PowerSyncBackendConnector {
  async fetchCredentials() {
    if (!powersyncUrl || !supabase) return null;
    const session = await ensureAnonymousSession();
    if (!session?.access_token) return null;

    return {
      endpoint: powersyncUrl,
      token: session.access_token
    };
  }

  async uploadData(database: AbstractPowerSyncDatabase) {
    if (!supabase) return;

    const transaction = await database.getNextCrudTransaction();
    if (!transaction) return;

    // Two rails:
    //   - Lifecycle (group/member creation) is handled by dedicated, gated Edge
    //     Functions (create-group / join-group), never the generic sync path.
    //     Local group inserts trigger idempotent ratification; local member
    //     inserts are dropped (the server owns membership).
    //   - Data (expenses/splits/activity/renames) flows through sync-upload,
    //     which authorizes each op by membership. Expense uploads are therefore
    //     implicitly gated behind successful ratification (membership must
    //     exist server-side first).
    const dataOps: Array<Record<string, unknown>> = [];

    for (const op of transaction.crud) {
      if (op.table === "groups" && op.op === "PUT") {
        await this.ratifyGroup(database, op.id, op.opData ?? null);
        continue;
      }
      if (op.table === "members" && op.op === "PUT") {
        continue;
      }
      dataOps.push({
        table: op.table,
        op: op.op,
        id: op.id,
        data: op.opData ?? null,
        previous: op.previousValues ?? null
      });
    }

    if (dataOps.length > 0) {
      const { error } = await supabase!.functions.invoke("sync-upload", {
        body: { operations: dataOps }
      });
      if (error) throw new Error(await getSupabaseFunctionErrorMessage(error));
    }

    await transaction.complete();
  }

  // Ratifies a locally-created group on the server. Idempotent and safe to
  // retry; throws on failure so PowerSync keeps the transaction queued (e.g.
  // while offline) and retries later.
  private async ratifyGroup(
    database: AbstractPowerSyncDatabase,
    groupId: string,
    data: Record<string, unknown> | null
  ) {
    const creator = await database.getOptional<{
      id: string;
      display_name: string;
      device_id: string | null;
    }>(
      "SELECT id, display_name, device_id FROM members WHERE group_id = ? ORDER BY created_at ASC LIMIT 1",
      [groupId]
    );

    const { data: result, error } = await supabase!.functions.invoke<{ code?: string }>("create-group", {
      body: {
        groupId,
        code: data?.code,
        name: data?.name,
        currency: data?.currency,
        createdAt: data?.created_at,
        member: creator
          ? { id: creator.id, displayName: creator.display_name, deviceId: creator.device_id }
          : undefined
      }
    });

    if (error) throw new Error(await getSupabaseFunctionErrorMessage(error));

    // If the server had to mint a different code (collision), adopt it locally
    // so the creator's view stays consistent without waiting for a download.
    const serverCode = result?.code;
    if (typeof serverCode === "string" && serverCode !== data?.code) {
      await database.execute("UPDATE groups SET code = ? WHERE id = ?", [serverCode, groupId]);
    }
  }
}

async function getSupabaseFunctionErrorMessage(error: unknown) {
  const context = typeof error === "object" && error && "context" in error ? (error as { context?: Response }).context : undefined;
  if (context) {
    try {
      const body = await context.clone().json();
      if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
        return body.error;
      }
    } catch {
      try {
        const text = await context.clone().text();
        if (text.trim()) return text.trim();
      } catch {
        // Fall back to the SDK message below.
      }
    }
  }

  return error instanceof Error ? error.message : "Sync failed";
}
