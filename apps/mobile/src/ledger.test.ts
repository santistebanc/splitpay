import { describe, expect, it } from "vitest";
import {
  calculateBalances,
  calculateSettlements,
  isSettlementPayment,
  settlementKey,
  type LedgerExpense,
  type MemberBalance
} from "./ledger";

// Characterization tests: these pin the *current* balance/rounding/settlement
// behaviour, so the Ledger extraction is provably behaviour-preserving and any
// future change to the money math is a deliberate, visible decision.

const centsByMember = (balances: MemberBalance[]) =>
  Object.fromEntries(balances.map((b) => [b.memberId, b.balanceCents]));

const sumsToZero = (balances: MemberBalance[]) =>
  balances.reduce((total, b) => total + b.balanceCents, 0);

describe("calculateBalances", () => {
  it("splits an even expense in two", () => {
    const expenses: LedgerExpense[] = [{ paidByMemberId: "a", splitMemberIds: ["a", "b"], amountCents: 1000 }];
    const balances = calculateBalances(["a", "b"], expenses);
    expect(centsByMember(balances)).toEqual({ a: 500, b: -500 });
    // Sorted ascending (biggest debtor first).
    expect(balances.map((b) => b.memberId)).toEqual(["b", "a"]);
  });

  it("distributes indivisible pennies deterministically and still sums to zero", () => {
    // 100c split three ways: shares are 100/3. Leftover pennies go to the
    // lowest-index members with the largest remainder.
    const expenses: LedgerExpense[] = [{ paidByMemberId: "a", splitMemberIds: ["a", "b", "c"], amountCents: 100 }];
    const balances = calculateBalances(["a", "b", "c"], expenses);
    expect(centsByMember(balances)).toEqual({ a: 67, b: -33, c: -34 });
    expect(sumsToZero(balances)).toBe(0);
  });

  it("treats an empty split list as 'everyone'", () => {
    const expenses: LedgerExpense[] = [{ paidByMemberId: "a", splitMemberIds: [], amountCents: 90 }];
    const balances = calculateBalances(["a", "b", "c"], expenses);
    expect(centsByMember(balances)).toEqual({ a: 60, b: -30, c: -30 });
    expect(sumsToZero(balances)).toBe(0);
  });

  it("nets multiple expenses across members and sums to zero", () => {
    const expenses: LedgerExpense[] = [
      { paidByMemberId: "a", splitMemberIds: ["a", "b", "c"], amountCents: 3000 },
      { paidByMemberId: "b", splitMemberIds: ["a", "b", "c"], amountCents: 1500 },
      { paidByMemberId: "c", splitMemberIds: ["b", "c"], amountCents: 700 }
    ];
    const balances = calculateBalances(["a", "b", "c"], expenses);
    expect(sumsToZero(balances)).toBe(0);
    // Members with no expenses stay at zero.
    const idle = calculateBalances(["a", "b", "x"], expenses.slice(0, 1));
    expect(centsByMember(idle).x).toBe(0);
  });

  it("returns zero balances for a group with no expenses", () => {
    expect(centsByMember(calculateBalances(["a", "b"], []))).toEqual({ a: 0, b: 0 });
  });
});

describe("calculateSettlements", () => {
  it("matches a single debtor to a single creditor", () => {
    const balances: MemberBalance[] = [
      { memberId: "a", balanceCents: -500 },
      { memberId: "b", balanceCents: 500 }
    ];
    expect(calculateSettlements(balances)).toEqual([{ fromMemberId: "a", toMemberId: "b", amountCents: 500 }]);
  });

  it("greedily pays the largest creditor first", () => {
    const balances: MemberBalance[] = [
      { memberId: "a", balanceCents: -700 },
      { memberId: "b", balanceCents: 200 },
      { memberId: "c", balanceCents: 500 }
    ];
    expect(calculateSettlements(balances)).toEqual([
      { fromMemberId: "a", toMemberId: "c", amountCents: 500 },
      { fromMemberId: "a", toMemberId: "b", amountCents: 200 }
    ]);
  });

  it("produces no transfers when everyone is settled", () => {
    expect(calculateSettlements([{ memberId: "a", balanceCents: 0 }, { memberId: "b", balanceCents: 0 }])).toEqual([]);
  });
});

describe("isSettlementPayment", () => {
  it("is a payment when one member pays exactly one other", () => {
    expect(isSettlementPayment({ paidByMemberId: "a", splitMemberIds: ["b"] })).toBe(true);
  });

  it("is not a payment when the single split is the payer", () => {
    expect(isSettlementPayment({ paidByMemberId: "a", splitMemberIds: ["a"] })).toBe(false);
  });

  it("is not a payment when split across multiple members", () => {
    expect(isSettlementPayment({ paidByMemberId: "a", splitMemberIds: ["b", "c"] })).toBe(false);
    expect(isSettlementPayment({ paidByMemberId: "a", splitMemberIds: [] })).toBe(false);
  });
});

describe("settlementKey", () => {
  it("is stable from members and amount", () => {
    expect(settlementKey({ fromMemberId: "a", toMemberId: "b", amountCents: 500 })).toBe("a-b-500");
  });
});
