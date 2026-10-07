# Campus Wallet card levels (test mode)

Card-level prices and fees are configured by an administrator and calculated by
the Node.js API. Amounts are integers in paise. Flutter displays the server's
fee quote before asking the student to confirm; it never calculates a fee for
posting a transaction.

## Student card levels

| Level | Price | Transfer to a friend | Withdrawal fee |
| --- | --- | --- | --- |
| STARROW | Free; default level, no renewal | Not allowed, except an accepted-member payback to that member's own team leader, up to the member's share, once per team, with no fee | 2% |
| FENWICK | ₹99 per semester or ₹199 per year by default; administrator-editable | 0.5% by default | 0.5% |
| EMBERFALL | ₹499 first year, then ₹249 per renewal year by default; administrator-editable | 0% | 0% |

The administrator can edit Fenwick prices, Emberfall first-year and renewal
prices, fee percentages, fee minimum/maximum, and Emberfall grace days (7–15).
Defaults are examples, not production pricing. Current defaults use a ₹2
minimum and ₹50 maximum for non-zero percentage fees.

Fenwick semester/year selections last six/twelve calendar months. Emberfall is
manually renewed yearly and cannot extend past four years from its first
activation. First activation uses the first-year price; renewal after a skipped
year is undecided and must be confirmed before treating the current renewal
price behavior as policy. The configured grace period is 15 days by default.
At expiry, Emberfall falls back to the previously active Fenwick level or
STARROW. The student sees an in-app renewal reminder during the 30 days before
expiry; there is no push-notification service.

Frozen accounts cannot make payments, friend transfers, or test withdrawals;
the app marks their card benefits paused. QR payments and top-ups are free at
every level. Physical ID-card payment is not wired into this backend yet.

## Event entries (test mode)

Emberfall receives one free entry for each membership year. It expires at the
end of that year and is not carried into the next year; renewal grants a new
yearly entry. A student may buy one additional event entry for ₹299. Unused
paid entries carry over between membership years while Emberfall remains
active, including its 15-day grace period. If the membership falls back after
grace, any remaining paid entries expire and do not return on a later
reactivation.

The yearly free entry is used before a paid top-up. Each redeemed entry creates
a zero-balance `Free entry` wallet-ledger line with the covered share in
`cost_paise`; inventory grants, uses, refunds, and expiry are tracked in a
separate append-only entry ledger. A cancelled event restores its used entry
when the corresponding entitlement remains eligible and refunds the amount
actually charged to the wallet, without fees.

Events have a merchant/canteen organizer, a total fee in paise, a team size of
one to four, and a time window. The team fee is split into member shares; extra
paise are assigned from the leader onward (₹10.00 / 3 students becomes ₹3.34,
₹3.33, ₹3.33). Each Emberfall entry covers only its holder's share. The leader
pays the total up front minus the leader's own covered share. An Emberfall
non-leader's share is marked as waived from their payback to the leader; other
non-leader shares remain due. Team invites are sent to verified college-email
addresses, expire after 48 hours, and can be accepted only by a signed-in
account whose verified email exactly matches the invite. A student may join
only one team per event.

Accepted members can see the team payback tracker. They can pay only their
remaining share to the leader; STARROW members may do so once per team and are
charged no fee. Other card levels use the configured friend-transfer fee.
Paybacks require the member's PIN, are idempotent by request ID, and are
rejected for frozen accounts or cancelled events. A leader can send an in-app
reminder to a member who still owes money. Event cancellation refunds collected
paybacks to their original members without a fee.

## Implemented in this phase

- Server-managed level, expiry, fallback, and manual membership purchase/renewal.
- Prices and transfer/withdrawal fees are editable in the admin dashboard.
- Test-mode event creation/listing, event registration, and organizer/admin
  cancellation with append-only refunds.
- Emberfall yearly free-entry entitlements, ₹299 paid entry top-ups, annual
  resets, yearly-first consumption, carryover while active, and lapse expiry.
- Solo/team event fee shares and member-level free-entry/payback accounting.
- College-email verification, expiring team invitations, team membership, and
  database-backed adjustable invite throttles.
- Team payback tracker and reminders, with the narrowly scoped STARROW exception
  and cancellation refunds.
- Fenwick transfer and Starrow/Fenwick withdrawal fee quotes and server-side
  fee calculation, with each fee recorded as its own append-only ledger line.
- Membership charges and simulated withdrawals are ledger entries. A withdrawal
  only accepts a holder name matching the student's account and does not store
  the bank/UPI destination.
- Duplicate membership/transfer/withdrawal requests are protected by request
  IDs; merchant QR codes can be charged only once.
- PostgreSQL rejects updates/deletes to ledger rows.

## Not yet implemented

Offers, cashback, early-bird event prices, milestone/referral rewards, scratch
cards, priority passes, bank/UPI payouts, and push notifications are not
connected yet. General STARROW-to-friend transfers remain blocked; the only
exception is the server-verified team payback described above.

## Policy choices confirmed

- Fenwick can be bought by semester or by year.
- Unused Emberfall paid top-up entries carry into a renewed membership year
  only while Emberfall remains active; they expire after lapse beyond grace.
- The yearly included event entry expires at its membership-year end and resets
  on renewal; it does not carry over.
- Emberfall has a 15-day renewal grace period by default.
- STARROW may send money only to the leader of a team they have joined, up to
  their remaining share and once per team, without a fee.

The price charged for Emberfall renewal after skipping a membership year is
still undecided. The current API code uses the configured renewal price in that
case, but this behavior has not been confirmed as the product rule; ask the
user before relying on or changing it.

Everything is a local test simulation. Membership charges and withdrawals
change only the local test ledger; no real payment, bank transfer, or UPI
payment occurs. Do not use real bank details or student records. An expert must
review RBI prepaid-wallet requirements before any real-money launch.
