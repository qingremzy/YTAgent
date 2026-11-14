const assert = require("node:assert/strict");
const { enabled } = require("./agnes-v2-free-generator");

assert.equal(enabled("true"), true);
assert.equal(enabled("1"), true);
assert.equal(enabled("false"), false);
assert.equal(enabled(undefined), false);
console.log("Agnes v2.0 fallback opt-in tests passed.");
