# SplitPay

Offline-first bill splitting for groups of friends. This file records the project's domain language so refactors and reviews stay consistent. General programming concepts don't belong here — only terms specific to SplitPay.

## Language

**Group**:
A shared space, identified by a short join code, containing members and the expenses they split.
_Avoid_: room, party, account

**Member** (also **slot**):
A named place in a group that expenses attach to. Money math refers to a member by id; display names are presentation only. A member is **claimed** when bound to a user (`user_id` set) and **unclaimed** otherwise — an unclaimed slot is just a name that anyone in the group can record against and that a joiner can later claim.
_Avoid_: user, person, friend (in code)

**Claim**:
Binding a user to a member slot (assigning its `user_id`). Only `create-group` (for the creator) and `join-group` (for a joiner) ever claim; it never happens through the generic sync path.
_Avoid_: assign, take, occupy

**User**:
An anonymous identity (a Supabase auth uid) that may claim a member slot. Distinct from a member: a member can exist with no user (unclaimed).
_Avoid_: account, member (they are not interchangeable)

**Expense**:
A single recorded cost: an amount in integer cents, who paid it, and which members it is split across.
_Avoid_: transaction, charge, item

**Split**:
The link between an expense and a member who shares its cost. Equal shares only.
_Avoid_: share, portion

**Payment**:
A settling transfer between two members, modelled as an expense paid by one member and split across exactly one other.
_Avoid_: settlement (reserve that for the computed transfer), transfer, repayment

**Balance**:
A member's net position in a group: positive means owed, negative means owing. Always in integer cents, always summing to zero across the group.
_Avoid_: total, amount, debt

**Settlement**:
A computed transfer (from member, to member, cents) that reduces outstanding balances toward zero. Derived, never stored.
_Avoid_: payment (reserve that for a recorded settling expense), transfer

**Ledger**:
The pure module that derives balances and settlements from a group's expenses. Works in member ids and integer cents; knows nothing of display names, money formatting, storage, or React.
_Avoid_: calculator, math utils, balances service

**Activity**:
The append-only log of what happened in a group (expense added, member joined, etc.), used for the activity feed.
_Avoid_: history, audit, event log
