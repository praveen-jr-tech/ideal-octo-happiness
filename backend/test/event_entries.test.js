const assert = require("node:assert/strict");
const { test } = require("node:test");
const { splitTeamFee } = require("../src/event_entries");

test("team event fees split into deterministic paise shares that sum to total", () => {
  assert.deepEqual(splitTeamFee(1000, 3), [334, 333, 333]);
  assert.deepEqual(splitTeamFee(1001, 4), [251, 250, 250, 250]);
  assert.equal(splitTeamFee(999, 1).reduce((sum, share) => sum + share, 0), 999);
  assert.throws(() => splitTeamFee(0, 2), /positive safe integer/);
  assert.throws(() => splitTeamFee(100, 5), /between 1 and 4/);
});
