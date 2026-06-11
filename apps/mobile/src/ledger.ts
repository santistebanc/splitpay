// Ledger — the pure heart of SplitPay's money math.
//
// Given a group's members (as ids) and expenses (amount in integer cents, who
// paid, who it's split across), it derives each member's balance and the set of
// settlement transfers that zero those balances out. It works only in member
// ids and integer cents: it knows nothing of display names, money formatting,
// storage, or React. That keeps the interface small and the whole module a pure
// test surface.

export type LedgerExpense = {
  paidByMemberId: string;
  // Empty means "split equally across all members".
  splitMemberIds: string[];
  amountCents: number;
};

export type MemberBalance = {
  memberId: string;
  // Positive = owed to this member; negative = owed by this member. The set
  // always sums to exactly zero across the group.
  balanceCents: number;
};

export type Settlement = {
  fromMemberId: string;
  toMemberId: string;
  amountCents: number;
};

// Computes each member's net balance in integer cents. Splits are tracked as
// exact fractions and only rounded to whole cents at the end, distributing
// leftover pennies deterministically so the result sums to zero. Returned
// sorted by balance ascending (biggest debtor first).
export function calculateBalances(memberIds: string[], expenses: LedgerExpense[]): MemberBalance[] {
  const totals = new Map(memberIds.map((memberId) => [memberId, fraction(0)]));

  for (const expense of expenses) {
    totals.set(expense.paidByMemberId, addFractions(totals.get(expense.paidByMemberId) ?? fraction(0), fraction(expense.amountCents)));
    const people = expense.splitMemberIds.length > 0 ? expense.splitMemberIds : memberIds;
    const share = fraction(expense.amountCents, people.length);

    for (const memberId of people) {
      totals.set(memberId, subtractFractions(totals.get(memberId) ?? fraction(0), share));
    }
  }

  const rounded = roundFractionsToZeroSumCents(memberIds.map((memberId) => ({
    memberId,
    value: totals.get(memberId) ?? fraction(0)
  })));

  return memberIds
    .map((memberId) => ({
      memberId,
      balanceCents: rounded.get(memberId) ?? 0
    }))
    .sort((a, b) => a.balanceCents - b.balanceCents);
}

// Greedily matches the largest debtor to the largest creditor until balances
// are exhausted, producing a minimal-ish set of transfers.
export function calculateSettlements(balances: MemberBalance[]): Settlement[] {
  const debtors = balances
    .filter((balance) => balance.balanceCents < 0)
    .map((balance) => ({ ...balance, remainingCents: -balance.balanceCents }))
    .sort((a, b) => b.remainingCents - a.remainingCents);
  const creditors = balances
    .filter((balance) => balance.balanceCents > 0)
    .map((balance) => ({ ...balance, remainingCents: balance.balanceCents }))
    .sort((a, b) => b.remainingCents - a.remainingCents);
  const settlements: Settlement[] = [];

  let debtorIndex = 0;
  let creditorIndex = 0;

  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex];
    const creditor = creditors[creditorIndex];
    const amountCents = Math.min(debtor.remainingCents, creditor.remainingCents);

    if (amountCents > 0) {
      settlements.push({
        fromMemberId: debtor.memberId,
        toMemberId: creditor.memberId,
        amountCents
      });
    }

    debtor.remainingCents -= amountCents;
    creditor.remainingCents -= amountCents;
    if (debtor.remainingCents === 0) debtorIndex += 1;
    if (creditor.remainingCents === 0) creditorIndex += 1;
  }

  return settlements;
}

export function settlementKey(settlement: Settlement) {
  return `${settlement.fromMemberId}-${settlement.toMemberId}-${settlement.amountCents}`;
}

// An expense is a settling payment when one member pays and it's split across
// exactly one other member.
export function isSettlementPayment(entry: { paidByMemberId: string; splitMemberIds: string[] }) {
  return entry.splitMemberIds.length === 1 && entry.splitMemberIds[0] !== entry.paidByMemberId;
}

type Fraction = {
  numerator: bigint;
  denominator: bigint;
};

function fraction(numerator: number | bigint, denominator: number | bigint = 1): Fraction {
  return normalizeFraction({ numerator: BigInt(numerator), denominator: BigInt(denominator) });
}

function addFractions(left: Fraction, right: Fraction) {
  return normalizeFraction({
    numerator: left.numerator * right.denominator + right.numerator * left.denominator,
    denominator: left.denominator * right.denominator
  });
}

function subtractFractions(left: Fraction, right: Fraction) {
  return normalizeFraction({
    numerator: left.numerator * right.denominator - right.numerator * left.denominator,
    denominator: left.denominator * right.denominator
  });
}

function normalizeFraction(value: Fraction): Fraction {
  if (value.denominator === 0n) throw new Error("Cannot divide by zero");
  if (value.denominator < 0n) value = { numerator: -value.numerator, denominator: -value.denominator };
  const divisor = greatestCommonDivisor(absBigInt(value.numerator), value.denominator);
  return { numerator: value.numerator / divisor, denominator: value.denominator / divisor };
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  while (right !== 0n) {
    const next = left % right;
    left = right;
    right = next;
  }
  return left || 1n;
}

function absBigInt(value: bigint) {
  return value < 0n ? -value : value;
}

function floorFraction(value: Fraction) {
  const quotient = value.numerator / value.denominator;
  const remainder = value.numerator % value.denominator;
  return remainder < 0n ? quotient - 1n : quotient;
}

function roundFractionsToZeroSumCents(values: Array<{ memberId: string; value: Fraction }>) {
  const rounded = new Map<string, number>();
  const floors = values.map((item, index) => {
    const floor = floorFraction(item.value);
    return {
      ...item,
      index,
      floor,
      remainder: item.value.numerator - floor * item.value.denominator
    };
  });
  const floorSum = floors.reduce((sum, item) => sum + item.floor, 0n);
  const centsToAdd = -floorSum;
  const addOneCent = new Set(
    floors
      .filter((item) => item.remainder > 0n)
      .sort((a, b) => {
        const byRemainder = b.remainder * a.value.denominator - a.remainder * b.value.denominator;
        if (byRemainder !== 0n) return byRemainder > 0n ? 1 : -1;
        return a.index - b.index;
      })
      .slice(0, Number(centsToAdd))
      .map((item) => item.memberId)
  );

  for (const item of floors) {
    const balance = item.floor + (centsToAdd > 0n && addOneCent.has(item.memberId) ? 1n : 0n);
    rounded.set(item.memberId, Number(balance));
  }

  return rounded;
}
