import type { AbstractPowerSyncDatabase, PowerSyncBackendConnector } from "@powersync/common";
import { peekPendingGroupPassword, takePendingGroupPassword } from "../groupPassword";
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
    //   - Group creation is ratified by the gated create-group Edge Function,
    //     which also inserts the group's initial member slots (binding the
    //     creator). A local group insert triggers idempotent ratification.
    //   - Everything else (member slots, expenses/splits/activity/renames)
    //     flows through sync-upload, which authorizes each op by membership.
    //     Member-slot PUTs are therefore implicitly gated behind successful
    //     ratification, and sync-upload only ever creates *unclaimed* slots, so
    //     it can never downgrade the creator's binding.
    const dataOps: Array<Record<string, unknown>> = [];

    for (const op of transaction.crud) {
      if (op.table === "groups" && op.op === "PUT") {
        await this.ratifyGroup(database, op.id, op.opData ?? null);
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
    // Ratify the whole local member roster. Each slot is created unclaimed
    // server-side except the creator's, identified by the slot that carries a
    // local device_id (offline, only the creator's own slot has one).
    const members = await database.getAll<{
      id: string;
      display_name: string;
      device_id: string | null;
      created_at: string | null;
    }>(
      "SELECT id, display_name, device_id, created_at FROM members WHERE group_id = ? AND deleted_at IS NULL ORDER BY created_at ASC",
      [groupId]
    );

    const creator = members.find((member) => member.device_id != null) ?? members[0];
    const pendingPassword = await peekPendingGroupPassword(groupId);

    const { data: result, error } = await supabase!.functions.invoke<{ code?: string }>("create-group", {
      body: {
        groupId,
        code: data?.code,
        name: data?.name,
        currency: data?.currency,
        createdAt: data?.created_at,
        creatorMemberId: creator?.id,
        members: members.map((member) => ({
          id: member.id,
          name: member.display_name,
          deviceId: member.device_id,
          createdAt: member.created_at
        })),
        password: pendingPassword ?? undefined
      }
    });

    if (error) {
      throw new Error(await getSupabaseFunctionErrorMessage(error));
    }

    if (pendingPassword) {
      await takePendingGroupPassword(groupId);
      await database.execute("UPDATE groups SET has_password = 1 WHERE id = ?", [groupId]);
    }

    const serverCode = result?.code;
    // If the server had to mint a different code (collision), adopt it locally
    // so the creator's view stays consistent without waiting for a download.
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
