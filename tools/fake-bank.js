const express = require("express");

const app = express();
app.use(express.json());

// Demo state; resets whenever this process restarts.
let mode = "normal";
let calls = 0;

const payouts = new Map();
const referenceCalls = new Map();

app.post("/mode", (req, res) => {
  const { mode: requestedMode } = req.body;

  if (!["normal", "flaky", "slow", "down"].includes(requestedMode)) {
    return res.status(400).json({
      error: "Mode must be normal, flaky, slow, or down",
    });
  }

  mode = requestedMode;
  return res.json({ mode });
});

app.get("/stats", (req, res) => {
  return res.json({
    mode,
    calls,
    paid: [...payouts.values()].filter(
      (payout) => payout.status === "SUCCESS"
    ).length,
    payouts: [...payouts.entries()].map(([reference, payout]) => ({
      reference,
      ...payout,
    })),
    referenceCalls: Object.fromEntries(referenceCalls),
  });
});

app.get("/payouts/:reference", (req, res) => {
  const payout = payouts.get(req.params.reference);

  if (!payout) {
    return res.status(404).json({
      error: "No payout with this reference",
    });
  }

  return res.json(payout);
});

app.post("/payouts", async (req, res) => {
  const { reference, amount, accountNumber, ifsc } = req.body;

  if (
    typeof reference !== "string" ||
    reference.length === 0 ||
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    typeof accountNumber !== "string" ||
    typeof ifsc !== "string"
  ) {
    return res.status(400).json({
      status: "FAILED",
      message: "Missing or invalid payout details",
    });
  }

  calls++;
  referenceCalls.set(
    reference,
    (referenceCalls.get(reference) || 0) + 1
  );

  // Return the saved result for an already processed reference.
  if (payouts.has(reference)) {
    return res.json(payouts.get(reference));
  }

  if (mode === "down") {
    return res.status(503).json({
      status: "FAILED",
      message: "Bank temporarily unavailable",
    });
  }

  // Fail the first request for each reference; the next can succeed.
  if (
    mode === "flaky" &&
    referenceCalls.get(reference) === 1
  ) {
    return res.status(503).json({
      status: "FAILED",
      message: "Temporary bank error",
    });
  }

  // Delay the response to simulate a slow bank.
  if (mode === "slow") {
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  // Simulate a permanently closed account.
  if (accountNumber.endsWith("0000")) {
    return res.status(400).json({
      status: "FAILED",
      message: "Account closed",
    });
  }

  const result = {
    status: "SUCCESS",
    bankRef: `BANK_${reference}`,
  };

  payouts.set(reference, result);

  return res.json(result);
});

app.listen(4000, () => {
  console.log("[bank] Fake bank running on http://localhost:4000");
});