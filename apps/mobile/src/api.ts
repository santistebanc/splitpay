import { clearPendingLeave, listPendingLeaveGroupIds, rememberPendingLeave } from "./pendingLeave";
import { MIN_GROUP_PASSWORD_LENGTH, rememberPendingGroupPassword } from "./groupPassword";
import { calculateBalances, isSettlementPayment } from "./ledger";
import { DEFAULT_MEMBER_NAME, DUPLICATE_MEMBER_NAME_ERROR, isMemberNameTaken } from "./memberNames";
import { initPowerSync, powersync, setupPowerSync } from "./localFirst/system";
import { ensureAnonymousSession, supabase } from "./localFirst/supabase";

export type Member = {
  id: string;
  displayName: string;
  claimed: boolean;
};

export type Expense = {
  id: string;
  description: string;
  amountCents: number;
  paidByMemberId: string;
  splitMemberIds: string[];
  createdAt: string;
};

export type Balance = {
  memberId: string;
  displayName: string;
  balanceCents: number;
};

export type GroupState = {
  group: {
    id: string;
    code: string;
    name: string;
    currency: string;
    createdAt: string;
    hasPassword: boolean;
  };
  currentMemberId: string | null;
  members: Member[];
  expenses: Expense[];
  balances: Balance[];
};

// Thrown by joinGroup when a password-protected group needs (or was given a
// wrong) password, so the UI can prompt without leaking group existence.
export class JoinError extends Error {
  needsPassword: boolean;
  constructor(message: string, needsPassword: boolean) {
    super(message);
    this.name = "JoinError";
    this.needsPassword = needsPassword;
  }
}

export type ActivityLog = {
  id: string;
  type: string;
  actorMemberId: string | null;
  actorName: string | null;
  summary: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

type GroupRow = {
  id: string;
  code: string;
  name: string;
  currency: string;
  has_password?: number | boolean | null;
  created_at: string;
  updated_at?: string | null;
  deleted_at?: string | null;
};

type MemberRow = {
  id: string;
  group_id: string;
  display_name: string;
  device_id: string | null;
  user_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  deleted_at?: string | null;
};

type ExpenseRow = {
  id: string;
  group_id: string;
  description: string;
  amount_cents: number;
  paid_by_member_id: string;
  created_at: string;
  updated_at?: string | null;
  deleted_at?: string | null;
};

type SplitRow = {
  id?: string;
  expense_id: string;
  member_id: string;
  created_at?: string | null;
  deleted_at?: string | null;
};

type ActivityRow = {
  id: string;
  group_id?: string;
  type: string;
  actor_member_id: string | null;
  actor_name: string | null;
  summary: string;
  metadata_json: string | null;
  created_at: string;
};

type JoinSnapshot = {
  group: GroupRow;
  members: MemberRow[];
  expenses: ExpenseRow[];
  expense_splits: Required<SplitRow>[];
  activity_logs: Required<ActivityRow>[];
  claimedMemberId?: string;
};

async function applyJoinSnapshot(snapshot: JoinSnapshot) {
  const group = snapshot.group;
  await powersync.execute(
    `INSERT OR REPLACE INTO groups (id, code, name, currency, has_password, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      group.id,
      group.code,
      group.name,
      group.currency,
      Number(group.has_password ?? 0) ? 1 : 0,
      group.created_at,
      group.updated_at ?? group.created_at,
      group.deleted_at ?? null
    ]
  );

  for (const member of snapshot.members) {
    await powersync.execute(
      `INSERT OR REPLACE INTO members (id, group_id, display_name, device_id, user_id, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        member.id,
        member.group_id,
        member.display_name,
        member.device_id ?? null,
        member.user_id ?? null,
        member.created_at ?? group.created_at,
        member.updated_at ?? member.created_at ?? group.created_at,
        member.deleted_at ?? null
      ]
    );
  }

  for (const expense of snapshot.expenses) {
    await powersync.execute(
      `INSERT OR REPLACE INTO expenses (id, group_id, description, amount_cents, paid_by_member_id, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        expense.id,
        expense.group_id,
        expense.description,
        expense.amount_cents,
        expense.paid_by_member_id,
        expense.created_at,
        expense.updated_at ?? expense.created_at,
        expense.deleted_at ?? null
      ]
    );
  }

  for (const split of snapshot.expense_splits) {
    await powersync.execute(
      `INSERT OR REPLACE INTO expense_splits (id, expense_id, member_id, created_at, deleted_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        split.id,
        split.expense_id,
        split.member_id,
        split.created_at ?? group.created_at,
        split.deleted_at ?? null
      ]
    );
  }

  for (const log of snapshot.activity_logs) {
    await powersync.execute(
      `INSERT OR REPLACE INTO activity_logs (id, group_id, type, actor_member_id, actor_name, summary, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        log.id,
        log.group_id ?? group.id,
        log.type,
        log.actor_member_id,
        log.actor_name,
        log.summary,
        log.metadata_json ?? "{}",
        log.created_at
      ]
    );
  }
}

// Creates a group with a list of named member slots. Exactly one slot is the
// creator (the one this device claims); it carries this device's device_id so
// the creator is recognized offline, and is bound to a user_id server-side at
// ratification. Every other slot starts unclaimed and can be claimed on join.
export async function createGroup(input: {
  name: string;
  members: { name: string; isMe: boolean }[];
  deviceId: string;
  currency: string;
  password?: string | null;
}) {
  await setupPowerSync();
  const now = new Date().toISOString();
  const groupId = createId();
  const code = createCode();
  const groupName = input.name.trim();
  const trimmedPassword = input.password?.trim() ?? "";
  if (trimmedPassword.length > 0) {
    if (trimmedPassword.length < MIN_GROUP_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_GROUP_PASSWORD_LENGTH} characters`);
    }
    await rememberPendingGroupPassword(groupId, trimmedPassword);
  }

  const named = input.members
    .map((member) => ({ name: member.name.trim() || DEFAULT_MEMBER_NAME, isMe: member.isMe }));
  const slots = named.length > 0 ? named : [{ name: DEFAULT_MEMBER_NAME, isMe: true }];
  // Guarantee exactly one creator slot.
  if (!slots.some((slot) => slot.isMe)) slots[0].isMe = true;

  await powersync.execute(
    `INSERT INTO groups (id, code, name, currency, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    [groupId, code, groupName, input.currency, now, now]
  );

  let myMemberId = "";
  let myName = DEFAULT_MEMBER_NAME;
  for (const slot of slots) {
    const memberId = createId();
    const deviceId = slot.isMe ? input.deviceId : null;
    await powersync.execute(
      `INSERT INTO members (id, group_id, display_name, device_id, user_id, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, NULL)`,
      [memberId, groupId, slot.name, deviceId, now, now]
    );
    if (slot.isMe) {
      myMemberId = memberId;
      myName = slot.name;
    }
  }

  await insertActivity(groupId, {
    type: "group.created",
    actorMemberId: myMemberId,
    actorName: myName,
    summary: `${myName} created ${groupName}`,
    metadata: { groupName, code }
  });

  return fetchGroup(code, input.deviceId);
}

// Adds an unclaimed member slot to a group. Works offline; the slot syncs as
// unclaimed and can later be claimed by a joiner.
export async function addMember(code: string, name: string, deviceId?: string) {
  await setupPowerSync();
  const group = await findGroupByCode(code);
  if (!group) throw new Error("Group not found locally");
  const memberName = name.trim() || DEFAULT_MEMBER_NAME;
  const existing = await powersync.getAll<{ display_name: string }>(
    "SELECT display_name FROM members WHERE group_id = ? AND deleted_at IS NULL",
    [group.id]
  );
  if (isMemberNameTaken(existing.map((row) => row.display_name), memberName)) {
    throw new Error(DUPLICATE_MEMBER_NAME_ERROR);
  }
  const now = new Date().toISOString();
  const memberId = createId();

  await powersync.execute(
    `INSERT INTO members (id, group_id, display_name, device_id, user_id, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL)`,
    [memberId, group.id, memberName, now, now]
  );
  await insertActivity(group.id, {
    type: "member.added",
    actorMemberId: memberId,
    actorName: memberName,
    summary: `${memberName} was added`,
    metadata: { displayName: memberName }
  });

  return fetchGroup(code, deviceId);
}

// Soft-removes a member slot. The server rejects this if the slot has any
// expenses/splits, or if the caller isn't allowed to remove it.
export async function removeMember(code: string, memberId: string, deviceId?: string) {
  await setupPowerSync();
  const group = await findGroupByCode(code);
  if (!group) throw new Error("Group not found locally");
  const member = await powersync.getOptional<MemberRow>(
    "SELECT * FROM members WHERE id = ? AND group_id = ? AND deleted_at IS NULL",
    [memberId, group.id]
  );
  if (!member) throw new Error("Member not found");
  if (member.user_id != null) {
    throw new Error("Claimed members can't be removed. They need to leave the group themselves.");
  }

  const now = new Date().toISOString();
  await powersync.execute("UPDATE members SET deleted_at = ?, updated_at = ? WHERE id = ?", [now, now, memberId]);
  await insertActivity(group.id, {
    type: "member.removed",
    actorMemberId: memberId,
    actorName: member.display_name,
    summary: `${member.display_name} was removed`,
    metadata: { displayName: member.display_name }
  });

  return fetchGroup(code, deviceId);
}

// Releases this device's claimed member slot so the name can be claimed again.
// Clears user_id and device_id locally and on the server when online.
export async function leaveGroup(code: string, deviceId?: string) {
  await setupPowerSync();
  const group = await findGroupByCode(code);
  if (!group) return;

  const member = deviceId
    ? await powersync.getOptional<MemberRow>(
        "SELECT * FROM members WHERE group_id = ? AND device_id = ? AND deleted_at IS NULL",
        [group.id, deviceId]
      )
    : null;

  if (member) {
    const now = new Date().toISOString();
    await powersync.execute(
      "UPDATE members SET device_id = NULL, user_id = NULL, updated_at = ? WHERE id = ?",
      [now, member.id]
    );
    await insertActivity(group.id, {
      type: "member.left",
      actorMemberId: member.id,
      actorName: member.display_name,
      summary: `${member.display_name} left`,
      metadata: { displayName: member.display_name, memberId: member.id }
    });
  }

  try {
    await syncLeaveGroupToServer(group.id);
    await clearPendingLeave(group.id);
  } catch (error) {
    await rememberPendingLeave(group.id);
    if (powersync.connected) throw error;
  }
}

export async function flushPendingLeaves() {
  if (!supabase) return;
  await setupPowerSync();
  await ensureAnonymousSession();

  for (const groupId of await listPendingLeaveGroupIds()) {
    try {
      await syncLeaveGroupToServer(groupId);
      await clearPendingLeave(groupId);
    } catch {
      // Keep pending for the next online retry.
    }
  }
}

async function syncLeaveGroupToServer(groupId: string) {
  if (!supabase) throw new Error("Leaving a group needs you to be online.");
  await ensureAnonymousSession();
  const { error } = await supabase.functions.invoke("leave-group", {
    body: { groupId }
  });
  if (error) throw new Error(await getSupabaseFunctionErrorMessage(error));
}

// A member slot as shown in the join picker.
export type GroupSlot = {
  id: string;
  name: string;
  claimed: boolean;
};

// Online-only: reveal a group's member slots (taken/available) so the joiner
// can pick one to claim or decide to add a new name. Password-gated server-side.
export async function previewGroupMembers(
  code: string,
  input: { password?: string } = {}
): Promise<GroupSlot[]> {
  await setupPowerSync();
  if (!supabase) throw new Error("Joining a group needs you to be online.");
  await ensureAnonymousSession();
  const { data, error } = await supabase.functions.invoke<{ members?: GroupSlot[] }>("join-group", {
    body: { code: code.toUpperCase(), preview: true, password: input.password }
  });
  if (error) {
    const parsed = await parseFunctionError(error, "Could not load members");
    throw new JoinError(parsed.message, parsed.needsPassword);
  }
  return data?.members ?? [];
}

export async function joinGroup(
  code: string,
  input: { displayName: string; deviceId: string; password?: string; memberId?: string }
) {
  await setupPowerSync();
  const normalizedCode = code.toUpperCase();
  const displayName = input.displayName.trim() || DEFAULT_MEMBER_NAME;

  // Joining always goes through the server so slot picks (including "someone
  // else" after leaving locally) are honored. Re-opening a known group offline
  // uses fetchGroup instead. Apply the server snapshot locally right away so
  // device_id (and thus "you") is available before PowerSync download catches up.
  const snapshot = await joinGroupByCodeOnServer(normalizedCode, { ...input, displayName });
  await applyJoinSnapshot(snapshot);

  return fetchGroup(normalizedCode, input.deviceId);
}

async function joinGroupByCodeOnServer(
  code: string,
  input: { displayName: string; deviceId: string; password?: string; memberId?: string }
): Promise<JoinSnapshot> {
  if (!supabase) {
    throw new Error("Joining a group needs you to be online.");
  }

  await ensureAnonymousSession();
  const { data, error } = await supabase.functions.invoke<JoinSnapshot>("join-group", {
    body: {
      code,
      displayName: input.displayName,
      deviceId: input.deviceId,
      password: input.password,
      memberId: input.memberId
    }
  });

  if (error) {
    const parsed = await parseFunctionError(error, "Joining group failed");
    throw new JoinError(parsed.message, parsed.needsPassword);
  }
  if (!data?.group) throw new Error("Group not found");
  return data;
}

// Sets, changes (non-null password), or removes (null) a group's join password.
// Online-only; any member may do it.
export async function setGroupPassword(code: string, password: string | null) {
  await setupPowerSync();
  if (!supabase) throw new Error("Setting a password needs you to be online.");
  const group = await findGroupByCode(code);
  if (!group) throw new Error("Group not found locally");

  await ensureAnonymousSession();
  const { error } = await supabase.functions.invoke("set-password", {
    body: { groupId: group.id, password }
  });
  if (error) throw new Error(await getSupabaseFunctionErrorMessage(error));
}

export function isSyncConfigured() {
  return Boolean(supabase);
}

export type ConnectionStatus = "online" | "offline" | "connecting";

function readConnectionStatus(): ConnectionStatus {
  if (!supabase) return "offline";
  if (powersync.connected) return "online";
  if (powersync.connecting) return "connecting";
  return "offline";
}

// Reports online status (configured + PowerSync connected) and notifies on
// change so the UI can disable online-only features while offline.
export function subscribeToConnection(onChange: (status: ConnectionStatus) => void) {
  if (!supabase) {
    onChange("offline");
    return () => {};
  }
  let disposed = false;
  let dispose: (() => void) | undefined;

  void (async () => {
    try {
      // Attach before connect finishes so we don't miss the connected status event.
      await initPowerSync();
      if (disposed) return;

      dispose = powersync.registerListener({
        statusChanged: () => {
          if (!disposed) onChange(readConnectionStatus());
        }
      });
      onChange(readConnectionStatus());

      await setupPowerSync();
      if (!disposed) onChange(readConnectionStatus());
    } catch (error) {
      console.warn("PowerSync setup failed", error);
      if (!disposed) onChange("offline");
    }
  })();

  return () => {
    disposed = true;
    dispose?.();
  };
}

async function parseFunctionError(error: unknown, fallback: string) {
  const context = typeof error === "object" && error && "context" in error ? (error as { context?: Response }).context : undefined;
  if (context) {
    try {
      const body = await context.clone().json();
      if (body && typeof body === "object") {
        const message = "error" in body && typeof body.error === "string" ? body.error : fallback;
        const needsPassword = "needsPassword" in body && body.needsPassword === true;
        return { message, needsPassword };
      }
    } catch {
      try {
        const text = await context.clone().text();
        if (text.trim()) return { message: text.trim(), needsPassword: false };
      } catch {
        // Fall back to the SDK message below.
      }
    }
  }

  return { message: error instanceof Error ? error.message : fallback, needsPassword: false };
}

async function getSupabaseFunctionErrorMessage(error: unknown) {
  return (await parseFunctionError(error, "Sync failed")).message;
}

export async function fetchGroup(code: string, deviceId?: string) {
  await initPowerSync();
  const group = await findGroupByCode(code);
  if (!group) throw new Error("Group not found locally");

  const members = await powersync.getAll<MemberRow>(
    "SELECT * FROM members WHERE group_id = ? AND deleted_at IS NULL ORDER BY created_at ASC",
    [group.id]
  );
  const expenses = await powersync.getAll<ExpenseRow>(
    "SELECT * FROM expenses WHERE group_id = ? AND deleted_at IS NULL ORDER BY created_at DESC",
    [group.id]
  );
  const splits = await powersync.getAll<SplitRow>(
    `SELECT expense_splits.expense_id, expense_splits.member_id
       FROM expense_splits
       INNER JOIN expenses ON expenses.id = expense_splits.expense_id
      WHERE expenses.group_id = ? AND expense_splits.deleted_at IS NULL AND expenses.deleted_at IS NULL`,
    [group.id]
  );
  const splitMap = new Map<string, string[]>();
  for (const split of splits) {
    splitMap.set(split.expense_id, [...(splitMap.get(split.expense_id) ?? []), split.member_id]);
  }

  const shapedMembers = members.map((member) => ({
    id: member.id,
    displayName: member.display_name,
    claimed: member.user_id != null
  }));
  const shapedExpenses = expenses.map((expense) => ({
    id: expense.id,
    description: expense.description,
    amountCents: Number(expense.amount_cents),
    paidByMemberId: expense.paid_by_member_id,
    splitMemberIds: splitMap.get(expense.id) ?? [],
    createdAt: expense.created_at
  }));

  const nameByMemberId = new Map(shapedMembers.map((member) => [member.id, member.displayName]));
  const balances = calculateBalances(
    shapedMembers.map((member) => member.id),
    shapedExpenses
  ).map((balance) => ({
    memberId: balance.memberId,
    displayName: nameByMemberId.get(balance.memberId) ?? "",
    balanceCents: balance.balanceCents
  }));

  return {
    group: {
      id: group.id,
      code: group.code,
      name: group.name,
      currency: group.currency,
      createdAt: group.created_at,
      hasPassword: Boolean(Number(group.has_password ?? 0))
    },
    currentMemberId: deviceId ? members.find((member) => member.device_id === deviceId)?.id ?? null : null,
    members: shapedMembers,
    expenses: shapedExpenses,
    balances
  };
}

export async function fetchActivityLogs(code: string) {
  await initPowerSync();
  const group = await findGroupByCode(code);
  if (!group) return [];
  const rows = await powersync.getAll<ActivityRow>(
    "SELECT * FROM activity_logs WHERE group_id = ? ORDER BY created_at DESC LIMIT 100",
    [group.id]
  );

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    actorMemberId: row.actor_member_id,
    actorName: row.actor_name,
    summary: row.summary,
    metadata: parseMetadata(row.metadata_json),
    createdAt: row.created_at
  }));
}

export async function updateGroupName(code: string, name: string, deviceId?: string) {
  await setupPowerSync();
  const group = await findGroupByCode(code);
  if (!group) throw new Error("Group not found locally");
  const nextName = name.trim();
  const now = new Date().toISOString();

  await powersync.execute("UPDATE groups SET name = ?, updated_at = ? WHERE id = ?", [nextName, now, group.id]);
  await insertActivity(group.id, {
    type: "group.updated",
    summary: `Group renamed to ${nextName}`,
    metadata: { previousName: group.name, groupName: nextName }
  });
  return fetchGroup(code, deviceId);
}

export async function updateMemberName(code: string, displayName: string, deviceId?: string) {
  await setupPowerSync();
  if (!deviceId) throw new Error("Device id is required");
  const group = await findGroupByCode(code);
  if (!group) throw new Error("Group not found locally");
  const member = await powersync.getOptional<MemberRow>(
    "SELECT * FROM members WHERE group_id = ? AND device_id = ? AND deleted_at IS NULL",
    [group.id, deviceId]
  );
  if (!member) throw new Error("You are not a member of this group");
  return renameMember(code, member.id, displayName, deviceId);
}

export async function renameMember(code: string, memberId: string, displayName: string, deviceId?: string) {
  await setupPowerSync();
  if (!deviceId) throw new Error("Device id is required");
  const group = await findGroupByCode(code);
  if (!group) throw new Error("Group not found locally");

  const member = await powersync.getOptional<MemberRow>(
    "SELECT * FROM members WHERE id = ? AND group_id = ? AND deleted_at IS NULL",
    [memberId, group.id]
  );
  if (!member) throw new Error("Member not found");

  const currentMember = await powersync.getOptional<MemberRow>(
    "SELECT * FROM members WHERE group_id = ? AND device_id = ? AND deleted_at IS NULL",
    [group.id, deviceId]
  );
  if (!currentMember) throw new Error("You are not a member of this group");

  const isOwnSlot = member.id === currentMember.id;
  const isUnclaimed = member.user_id == null;
  if (!isOwnSlot && !isUnclaimed) {
    throw new Error("You can only rename your own profile or an unclaimed member");
  }

  const nextName = displayName.trim() || DEFAULT_MEMBER_NAME;
  if (nextName === member.display_name) return fetchGroup(code, deviceId);

  const existing = await powersync.getAll<{ display_name: string }>(
    "SELECT display_name FROM members WHERE group_id = ? AND deleted_at IS NULL AND id != ?",
    [group.id, member.id]
  );
  if (isMemberNameTaken(existing.map((row) => row.display_name), nextName)) {
    throw new Error(DUPLICATE_MEMBER_NAME_ERROR);
  }

  const now = new Date().toISOString();
  await powersync.execute("UPDATE members SET display_name = ?, updated_at = ? WHERE id = ?", [nextName, now, member.id]);
  await insertActivity(group.id, {
    type: "member.updated",
    actorMemberId: currentMember.id,
    actorName: currentMember.display_name,
    summary: isOwnSlot
      ? `${nextName} updated their name`
      : `${currentMember.display_name} renamed ${member.display_name} to ${nextName}`,
    metadata: { previousName: member.display_name, displayName: nextName, memberId: member.id }
  });
  return fetchGroup(code, deviceId);
}

export async function addExpense(
  code: string,
  input: {
    description: string;
    amountCents: number;
    paidByMemberId: string;
    splitMemberIds: string[];
  },
  deviceId?: string
) {
  await setupPowerSync();
  const group = await findGroupByCode(code);
  if (!group) throw new Error("Group not found locally");
  const now = new Date().toISOString();
  const expenseId = createId();
  const description = input.description.trim() || "Expense";

  await powersync.execute(
    `INSERT INTO expenses (id, group_id, description, amount_cents, paid_by_member_id, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    [expenseId, group.id, description, input.amountCents, input.paidByMemberId, now, now]
  );
  await replaceExpenseSplits(expenseId, input.splitMemberIds, now);
  await logExpenseChange(group, "created", {
    expenseId,
    description,
    amountCents: input.amountCents,
    paidByMemberId: input.paidByMemberId,
    splitMemberIds: input.splitMemberIds
  });

  return fetchGroup(code, deviceId);
}

export async function updateExpense(
  code: string,
  expenseId: string,
  input: {
    description: string;
    amountCents: number;
    paidByMemberId: string;
    splitMemberIds: string[];
  },
  deviceId?: string
) {
  await setupPowerSync();
  const group = await findGroupByCode(code);
  if (!group) throw new Error("Group not found locally");
  const now = new Date().toISOString();
  const description = input.description.trim() || "Expense";

  await powersync.execute(
    `UPDATE expenses
        SET description = ?, amount_cents = ?, paid_by_member_id = ?, updated_at = ?
      WHERE id = ? AND group_id = ?`,
    [description, input.amountCents, input.paidByMemberId, now, expenseId, group.id]
  );
  await powersync.execute("UPDATE expense_splits SET deleted_at = ? WHERE expense_id = ?", [now, expenseId]);
  await replaceExpenseSplits(expenseId, input.splitMemberIds, now);
  await logExpenseChange(group, "updated", {
    expenseId,
    description,
    amountCents: input.amountCents,
    paidByMemberId: input.paidByMemberId,
    splitMemberIds: input.splitMemberIds
  });

  return fetchGroup(code, deviceId);
}

export async function deleteExpense(code: string, expenseId: string, deviceId?: string) {
  await setupPowerSync();
  const group = await findGroupByCode(code);
  if (!group) throw new Error("Group not found locally");
  const now = new Date().toISOString();
  const existing = await powersync.getOptional<ExpenseRow>("SELECT * FROM expenses WHERE id = ?", [expenseId]);

  await powersync.execute("UPDATE expenses SET deleted_at = ?, updated_at = ? WHERE id = ?", [now, now, expenseId]);
  await powersync.execute("UPDATE expense_splits SET deleted_at = ? WHERE expense_id = ?", [now, expenseId]);
  if (existing) {
    await insertActivity(group.id, {
      type: "expense.deleted",
      actorMemberId: existing.paid_by_member_id,
      summary: `Deleted ${existing.description}`,
      metadata: { expenseId, description: existing.description, amountCents: existing.amount_cents }
    });
  }

  return fetchGroup(code, deviceId);
}

export function subscribeToGroup(code: string, deviceId: string, onChange: (state: GroupState) => void, onError?: (error: unknown) => void) {
  const abortController = new AbortController();

  void initPowerSync().then(() => {
    powersync.watch(
      `SELECT
         (SELECT COUNT(*) FROM groups) AS groups_count,
         (SELECT COUNT(*) FROM members) AS members_count,
         (SELECT COUNT(*) FROM expenses) AS expenses_count,
         (SELECT COUNT(*) FROM expense_splits) AS splits_count,
         (SELECT COUNT(*) FROM activity_logs) AS logs_count`,
      [],
      {
        onResult: () => {
          fetchGroup(code, deviceId).then(onChange).catch(onError);
        },
        onError: (error) => onError?.(error)
      },
      { signal: abortController.signal, throttleMs: 100 }
    );
  });

  return () => abortController.abort();
}

async function findGroupByCode(code: string) {
  return powersync.getOptional<GroupRow>(
    "SELECT * FROM groups WHERE code = ? AND deleted_at IS NULL",
    [code.toUpperCase()]
  );
}

async function replaceExpenseSplits(expenseId: string, memberIds: string[], createdAt: string) {
  for (const memberId of [...new Set(memberIds)]) {
    await powersync.execute(
      `INSERT INTO expense_splits (id, expense_id, member_id, created_at, deleted_at)
       VALUES (?, ?, ?, ?, NULL)`,
      [createId(), expenseId, memberId, createdAt]
    );
  }
}

async function logExpenseChange(
  group: GroupRow,
  action: "created" | "updated",
  expense: {
    expenseId: string;
    description: string;
    amountCents: number;
    paidByMemberId: string;
    splitMemberIds: string[];
  }
) {
  const payer = await powersync.getOptional<MemberRow>("SELECT * FROM members WHERE id = ?", [expense.paidByMemberId]);
  const paidForMember = expense.splitMemberIds[0]
    ? await powersync.getOptional<MemberRow>("SELECT * FROM members WHERE id = ?", [expense.splitMemberIds[0]])
    : null;
  const isPayment = isSettlementPayment(expense);
  const type = isPayment ? `payment.${action}` : `expense.${action}`;
  const summary = isPayment
    ? action === "created"
      ? `${payer?.display_name ?? "Someone"} paid ${paidForMember?.display_name ?? "Someone"} ${formatMoney(expense.amountCents, group.currency)}`
      : `Updated payment to ${paidForMember?.display_name ?? "Someone"} to ${formatMoney(expense.amountCents, group.currency)}`
    : action === "created"
      ? `${payer?.display_name ?? "Someone"} added ${expense.description} for ${formatMoney(expense.amountCents, group.currency)}`
      : `Updated ${expense.description} to ${formatMoney(expense.amountCents, group.currency)}`;

  await insertActivity(group.id, {
    type,
    actorMemberId: expense.paidByMemberId,
    actorName: payer?.display_name,
    summary,
    metadata: {
      entryKind: isPayment ? "payment" : "expense",
      expenseId: expense.expenseId,
      description: expense.description,
      amountCents: expense.amountCents,
      paidByMemberId: expense.paidByMemberId,
      splitMemberIds: expense.splitMemberIds
    }
  });
}

async function insertActivity(
  groupId: string,
  input: {
    type: string;
    summary: string;
    actorMemberId?: string | null;
    actorName?: string | null;
    metadata?: Record<string, unknown>;
  }
) {
  await powersync.execute(
    `INSERT INTO activity_logs
      (id, group_id, type, actor_member_id, actor_name, summary, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      createId(),
      groupId,
      input.type,
      input.actorMemberId ?? null,
      input.actorName ?? null,
      input.summary,
      JSON.stringify(input.metadata ?? {}),
      new Date().toISOString()
    ]
  );
}

function parseMetadata(value: string | null) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function formatMoney(cents: number, currency: string) {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol"
  }).format(cents / 100);
}

function createCode() {
  return Array.from({ length: 5 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
}

function createId() {
  return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 11)}`;
}
