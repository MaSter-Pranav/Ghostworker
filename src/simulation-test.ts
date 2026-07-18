import axios from "axios";

const modelName = process.env.OPENAI_MODEL || "gpt-5.6";
const demoMode = process.env.GHOSTWORKER_DEMO_MODE === "true";
const baseUrl = process.env.GHOSTWORKER_BASE_URL || "http://localhost:3000";
const endpoint = `${baseUrl}/api/v1/webhook-ingress/example`;
const dashboardUrl = `${baseUrl}/dashboard`;

const invalidPayload = {
  eventType: "invoice.payment_succeeded",
  occurredAt: new Date().toISOString(),
  customer: { externalId: "cust_demo_2048", tier: "enterprise" },
  amount: { currency: "USD", value: 24900 },
  source: "ghostworker-drift-simulator",
};

const main = async (): Promise<void> => {
  console.log("\n[GHOSTWORKER][DEMO][START] Beginning autonomous schema-drift demonstration.");
  console.log(`[GHOSTWORKER][DEMO][MODEL] Recovery pipeline configured for ${modelName}.`);
  console.log(`[GHOSTWORKER][DEMO][MODE] ${demoMode ? "Deterministic offline demo mode enabled; no OpenAI API request will be sent." : "Live OpenAI recovery mode enabled."}`);
  console.log(`[GHOSTWORKER][DEMO][DASHBOARD] Open ${dashboardUrl} to watch live telemetry.`);
  console.log("[GHOSTWORKER][DEMO][PAYLOAD] Sending webhook without required root field 'id'.");

  const response = await axios.post(endpoint, invalidPayload, {
    headers: { "content-type": "application/json", "x-ghostworker-demo": "schema-drift" },
    timeout: 120_000,
    validateStatus: () => true,
  });

  console.log(`[GHOSTWORKER][DEMO][INGRESS] Webhook request completed with HTTP ${response.status}.`);
  console.log("[GHOSTWORKER][DEMO][RESPONSE]", JSON.stringify(response.data, null, 2));
  console.log(`[GHOSTWORKER][DEMO][COMPLETE] Inspect ${dashboardUrl} for the intercepted payload, diagnosis, and patch evidence.\n`);
};

main().catch((error: unknown) => {
  if (axios.isAxiosError(error)) {
    console.error(`[GHOSTWORKER][DEMO][CONNECTION-FAILED] Could not reach ${endpoint}: ${error.message}`);
  } else {
    console.error("[GHOSTWORKER][DEMO][FAILED]", error);
  }
  console.error(`[GHOSTWORKER][DEMO][NEXT] Start the server, then open ${dashboardUrl} and rerun this script.`);
  process.exitCode = 1;
});
