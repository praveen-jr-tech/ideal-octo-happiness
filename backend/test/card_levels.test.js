const test = require("node:test");
const assert = require("node:assert/strict");
const {
  effectiveMembership,
  transferQuote,
  withdrawalQuote,
} = require("../src/card_levels");
const { HttpError } = require("../src/db");

const settings = {
  fenwick_transfer_fee_bps: 50,
  starrow_withdrawal_fee_bps: 200,
  fenwick_withdrawal_fee_bps: 50,
  minimum_fee_paise: 200,
  maximum_fee_paise: 5000,
};

test("Fenwick transfer fee applies min/max bounds", () => {
  const small = transferQuote({
    cardLevel: "FENWICK",
    amountPaise: 10000,
    settings,
    purpose: "friend_transfer",
  });
  assert.equal(small.feePaise, 200);
  assert.equal(small.totalDebitPaise, 10200);

  const large = transferQuote({
    cardLevel: "FENWICK",
    amountPaise: 10000000,
    settings,
    purpose: "friend_transfer",
  });
  assert.equal(large.feePaise, 5000);
});

test("Emberfall friend transfers have no fee", () => {
  const quote = transferQuote({
    cardLevel: "EMBERFALL",
    amountPaise: 10000,
    settings,
    purpose: "friend_transfer",
  });
  assert.equal(quote.feePaise, 0);
  assert.equal(quote.totalDebitPaise, 10000);
});

test("Starrow cannot send a normal friend transfer", () => {
  assert.throws(
    () => transferQuote({
      cardLevel: "STARROW",
      amountPaise: 10000,
      settings,
      purpose: "friend_transfer",
    }),
    (error) => error instanceof HttpError && error.status === 403
  );
});

test("withdrawal fees use the card-level rate and configured bounds", () => {
  const starrow = withdrawalQuote({ cardLevel: "STARROW", amountPaise: 10000, settings });
  assert.equal(starrow.feePaise, 200);
  const emberfall = withdrawalQuote({ cardLevel: "EMBERFALL", amountPaise: 10000, settings });
  assert.equal(emberfall.feePaise, 0);
});

test("expired memberships fall back and Emberfall remains active during grace", () => {
  const now = new Date("2026-10-07T00:00:00.000Z");
  const expiresAt = new Date("2026-10-01T00:00:00.000Z");
  assert.equal(
    effectiveMembership({
      card_level: "FENWICK",
      card_level_expires_at: expiresAt,
      card_level_fallback: "STARROW",
    }, now).level,
    "STARROW"
  );
  const emberfall = effectiveMembership({
    card_level: "EMBERFALL",
    card_level_expires_at: expiresAt,
    card_level_fallback: "FENWICK",
    frozen: true,
  }, now, 15);
  assert.equal(emberfall.level, "EMBERFALL");
  assert.equal(emberfall.inGracePeriod, true);
  assert.equal(emberfall.benefitsPaused, true);
});
