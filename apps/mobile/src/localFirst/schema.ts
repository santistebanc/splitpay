import { column, Schema, Table } from "@powersync/common";

const groups = new Table({
  code: column.text,
  name: column.text,
  currency: column.text,
  has_password: column.integer,
  created_at: column.text,
  updated_at: column.text,
  deleted_at: column.text
});

const members = new Table(
  {
    group_id: column.text,
    display_name: column.text,
    device_id: column.text,
    user_id: column.text,
    created_at: column.text,
    updated_at: column.text,
    deleted_at: column.text
  },
  { indexes: { by_group: ["group_id"], by_device: ["device_id"] } }
);

const expenses = new Table(
  {
    group_id: column.text,
    description: column.text,
    amount_cents: column.integer,
    paid_by_member_id: column.text,
    created_at: column.text,
    updated_at: column.text,
    deleted_at: column.text
  },
  { indexes: { by_group: ["group_id"], by_payer: ["paid_by_member_id"] } }
);

const expense_splits = new Table(
  {
    expense_id: column.text,
    member_id: column.text,
    created_at: column.text,
    deleted_at: column.text
  },
  { indexes: { by_expense: ["expense_id"], by_member: ["member_id"] } }
);

const activity_logs = new Table(
  {
    group_id: column.text,
    type: column.text,
    actor_member_id: column.text,
    actor_name: column.text,
    summary: column.text,
    metadata_json: column.text,
    created_at: column.text
  },
  { indexes: { by_group: ["group_id"] } }
);

export const AppSchema = new Schema({
  groups,
  members,
  expenses,
  expense_splits,
  activity_logs
});

export type LocalDatabase = (typeof AppSchema)["types"];
