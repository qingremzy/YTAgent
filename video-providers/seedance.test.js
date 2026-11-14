"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { assertSeedanceBillingAllowed, generateSeedanceSceneClips } = require("./seedance");

test("Seedance is blocked in default zero-cost mode even when a key exists", () => {
  assert.throws(
    () => assertSeedanceBillingAllowed({
      YTAGENT_ZERO_COST_MODE: "true",
      ARK_SEEDANCE_ENABLED: "true",
      ARK_ALLOW_PAID_VIDEO_APIS: "true",
      ARK_API_KEY: "test-key"
    }),
    /not a verified free API/
  );
});

test("Seedance requires explicit paid-API approval when zero-cost mode is disabled", () => {
  assert.throws(
    () => assertSeedanceBillingAllowed({
      YTAGENT_ZERO_COST_MODE: "false",
      ARK_SEEDANCE_ENABLED: "true",
      ARK_API_KEY: "test-key"
    }),
    /explicit paid-API approval is missing/
  );
});

test("Seedance requires its feature flag and API key after paid approval", () => {
  assert.throws(
    () => assertSeedanceBillingAllowed({
      YTAGENT_ZERO_COST_MODE: "false",
      ARK_ALLOW_PAID_VIDEO_APIS: "true",
      ARK_SEEDANCE_ENABLED: "false",
      ARK_API_KEY: "test-key"
    }),
    /Seedance is disabled/
  );
  assert.throws(
    () => assertSeedanceBillingAllowed({
      YTAGENT_ZERO_COST_MODE: "false",
      ARK_ALLOW_PAID_VIDEO_APIS: "true",
      ARK_SEEDANCE_ENABLED: "true"
    }),
    /ARK_API_KEY is missing/
  );
});

test("Seedance generator refuses before validating or submitting a task in $0 mode", async () => {
  await assert.rejects(
    () => generateSeedanceSceneClips([], "test", "/tmp", () => {}),
    /Seedance blocked: YTAGENT_ZERO_COST_MODE is active/
  );
});
