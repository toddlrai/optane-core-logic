// scripts/final-audit.ts
import "dotenv/config";
import { supabaseServer } from "../src/lib/supabase-server";
import { handlePaymentSuccess, finalizeUsageInvoice } from "../src/lib/db/rpc";
import { enforceUsagePayment } from "../src/lib/billing/enforcement";
import { GET as triggerBillingCron } from "../src/app/api/cron/billing/route";

const TEST_ID = "TEST_ID";
const REAL_PADDLE_CUST_ID = "PADDLE_CTM_ID";
const REAL_PADDLE_SUB_ID = "PADDLE_SUB_ID";
const REAL_PADDLE_USAGE_PRICE_ID = "PADDLE_USG_PRI_ID";

async function runAudit() {
  console.log("🏁 Starting Final Audit [DEC 23, 2025 - SCALE PLAN]");

  // 0️⃣ PRE-TEST CLEANUP
  console.log("🧹 Cleaning up test client state...");
  await supabaseServer.from("clients").update({
    agent_status: "active",
    paused_reason: null,
    usage_invoice_due_at: null,
    usage_invoice_sent_at: null,
    renewal_status: "active",
    paddle_customer_id: REAL_PADDLE_CUST_ID,
    paddle_subscription_id: REAL_PADDLE_SUB_ID,
    paddle_price_usage_id: REAL_PADDLE_USAGE_PRICE_ID,
    vapi_phone_number_id: "PHONE_NUMBER_ID",
    vapi_api_key: "API_KEY",
    paddle_address_id: "ADDRESS_ID"
  }).eq("id", TEST_ID);

  await supabaseServer.from("usage").delete().eq("client_id", TEST_ID);
  await supabaseServer.from("payments").delete().eq("client_id", TEST_ID);

  console.log("\n--- CORE PIPELINES (1-3) ---");

  // 1️⃣ Pipeline A: Atomic Payment
  console.log("1️⃣ Pipeline A: Atomic Payment...");
  await handlePaymentSuccess({
    clientId: TEST_ID,
    amount: 697,
    plan: "scale",
    planAmount: 697,
    minutesBucket: 5000,
    pricePerMinute: 0.23,
    paymentType: "subscription",
    eventId: `initial_pay_${Date.now()}`,
    invoiceId: "inv_1",
    orderId: "ord_1",
    paidAt: new Date().toISOString(),
  });
  console.log("✅ PASS: Payment processed.");

  // 2️⃣ Pipeline B: Usage Logic
  console.log("2️⃣ Pipeline B: Usage Logic (7-Day Grace)...");
  await supabaseServer.from("usage").insert({
    client_id: TEST_ID,
    duration_minutes_exact: 10,
    created_at: new Date().toISOString(),
  });

  await finalizeUsageInvoice({
    clientId: TEST_ID,
    fromISO: new Date(Date.now() - 86400000).toISOString(),
    toISO: new Date(Date.now() + 60000).toISOString(),
    pricePerMinute: 0.23,
    eventId: `initial_usage_${Date.now()}`,
    graceDays: 7,
  });

  const { data: bClient } = await supabaseServer
    .from("clients")
    .select("agent_status, usage_invoice_due_at")
    .eq("id", TEST_ID)
    .single();

  if (bClient?.agent_status === "active" && bClient?.usage_invoice_due_at) {
    console.log("✅ PASS: Usage detected. Grace period active.");
  } else {
    console.error("❌ FAIL: Pipeline B Logic Failed", bClient);
  }

  // 3️⃣ Pipeline C: Killswitch
  console.log("3️⃣ Pipeline C: Forced Grace Expiry (Killswitch)...");
  await supabaseServer.from("clients").update({
    usage_invoice_due_at: new Date(Date.now() - 1000).toISOString(),
    paused_reason: "usage_unpaid",
  }).eq("id", TEST_ID);

  const { data: rawC } = await supabaseServer
    .from("clients")
    .select("*")
    .eq("id", TEST_ID)
    .single();

  await enforceUsagePayment(rawC);

  const { data: cClient } = await supabaseServer
    .from("clients")
    .select("agent_status")
    .eq("id", TEST_ID)
    .single();

  if (cClient?.agent_status === "paused") {
    console.log("✅ PASS: Killswitch triggered correctly.");
  } else {
    console.error("❌ FAIL: Killswitch failed.");
  }

  console.log("\n--- IDEMPOTENCY & SAFETY (4-7) ---");

  // 4️⃣ Zero usage
  console.log("4️⃣ Test: Zero-usage safety...");
  await supabaseServer.from("clients").update({
    usage_invoice_due_at: null,
    agent_status: "active",
  }).eq("id", TEST_ID);

  await finalizeUsageInvoice({
    clientId: TEST_ID,
    fromISO: new Date().toISOString(),
    toISO: new Date().toISOString(),
    pricePerMinute: 0.23,
    eventId: `zero_test_${Date.now()}`,
    graceDays: 7,
  });

  const { data: dClient } = await supabaseServer
    .from("clients")
    .select("usage_invoice_due_at")
    .eq("id", TEST_ID)
    .single();

  if (!dClient?.usage_invoice_due_at) {
    console.log("✅ PASS: Zero usage safety.");
  } else {
    console.error("❌ FAIL: Zero usage created debt.");
  }

  // 5️⃣ Duplicate usage idempotency
  console.log("5️⃣ Test: Duplicate usage idempotency...");
  const usageEventId = `usage_dup_${Date.now()}`;
  
  await supabaseServer.from("usage").insert({
    client_id: TEST_ID,
    duration_minutes_exact: 10,
    created_at: "2025-12-23T12:00:00Z"
  });

  await finalizeUsageInvoice({
    clientId: TEST_ID,
    fromISO: "2025-12-23T00:00:00Z",
    toISO: "2025-12-23T23:59:59Z",
    pricePerMinute: 0.23,
    eventId: usageEventId,
    graceDays: 7,
  });

  await finalizeUsageInvoice({
    clientId: TEST_ID,
    fromISO: "2025-12-23T00:00:00Z",
    toISO: "2025-12-23T23:59:59Z",
    pricePerMinute: 0.23,
    eventId: usageEventId,
    graceDays: 7,
  });

  const { count: usageCount } = await supabaseServer
    .from("payments")
    .select("*", { count: "exact", head: true })
    .eq("lemon_event_id", usageEventId);

  if (usageCount === 1) {
    console.log("✅ PASS: Duplicate usage ignored.");
  } else {
    console.error(`❌ FAIL: Expected 1 record, found ${usageCount}.`);
  }


  // 6️⃣ Enforcement no-op
  console.log("6️⃣ Test: Enforcement no-op...");
  await supabaseServer.from("clients").update({
    usage_invoice_due_at: new Date(Date.now() + 86400000).toISOString(),
    agent_status: "active",
  }).eq("id", TEST_ID);

  const { data: rawE } = await supabaseServer
    .from("clients")
    .select("*")
    .eq("id", TEST_ID)
    .single();

  await enforceUsagePayment(rawE);

  const { data: eClient } = await supabaseServer
    .from("clients")
    .select("agent_status")
    .eq("id", TEST_ID)
    .single();

  if (eClient?.agent_status === "active") {
    console.log("✅ PASS: Enforcement skipped correctly.");
  }

  // 7️⃣ Resume idempotency
  console.log("7️⃣ Test: Resume idempotency...");
  const payEventId = "paddle_evt_unique_999";

  const payload = {
    clientId: TEST_ID,
    amount: 10,
    plan: "scale",
    planAmount: 697,
    minutesBucket: 0,
    pricePerMinute: 0.23,
    paymentType: "usage" as any,
    eventId: payEventId,
    invoiceId: "inv_res",
    orderId: "ord_res",
    paidAt: new Date().toISOString(),
  };

  await handlePaymentSuccess(payload);
  await handlePaymentSuccess(payload);

  const { count: payCount } = await supabaseServer
    .from("payments")
    .select("*", { count: "exact", head: true })
    .eq("lemon_event_id", payEventId);

  if (payCount === 1) {
    console.log("✅ PASS: Duplicate webhooks ignored.");
  }

  console.log("\n--- 🆕 FINAL INVOICING TEST (8) ---");
  console.log("8️⃣ Test: Usage charge triggered exactly once...");

  const lastBilledAt = new Date(Date.now() - (48 * 60 * 60 * 1000)).toISOString();
  // 🔥 Set the due date to "now" so the cron actually picks it up
  const invoiceDueAt = new Date().toISOString(); 

  await supabaseServer.from("clients").update({
    agent_status: "active",
    usage_invoice_sent_at: null,
    usage_invoice_due_at: invoiceDueAt, // 🚨 CRITICAL: Cron won't run without this
    last_usage_billed_at: lastBilledAt,
    paddle_subscription_id: REAL_PADDLE_SUB_ID,
    paddle_price_usage_id: REAL_PADDLE_USAGE_PRICE_ID,
    paused_reason: null 
  }).eq("id", TEST_ID);

  await supabaseServer.from("usage").insert({
    client_id: TEST_ID,
    duration_minutes_exact: 100,
    created_at: new Date(Date.now() - (24 * 60 * 60 * 1000)).toISOString()
  });

  console.log("📡 Triggering Billing Cron...");
  const response = await triggerBillingCron();
  const result = await response.json();
  console.log("📊 Cron Result Metadata:", JSON.stringify(result, null, 2));

  // 📂 EXTENSIVE DIAGNOSTIC LOGS
  const { data: fClientFull } = await supabaseServer
    .from("clients")
    .select("*")
    .eq("id", TEST_ID)
    .single();

  console.log("📂 [INTERNAL CLIENT STATE DIAGNOSTIC]:", {
    id: fClientFull?.id,
    agent_status: fClientFull?.agent_status,
    usage_invoice_sent_at: fClientFull?.usage_invoice_sent_at,
    usage_invoice_due_at: fClientFull?.usage_invoice_due_at, // 🔍 Checking if this is set
    paddle_address_id: fClientFull?.paddle_address_id,      // 🔍 Checking if this exists
    last_usage_billed_at: fClientFull?.last_usage_billed_at,
    paused_reason: fClientFull?.paused_reason,
    paddle_customer_id: fClientFull?.paddle_customer_id,
    paddle_sub_id: fClientFull?.paddle_subscription_id
  });

  // 🔎 ADDED: SPECIFIC SKIP DIAGNOSIS
  if (!fClientFull?.usage_invoice_sent_at) {
      if (!fClientFull?.usage_invoice_due_at) console.error("❌ SKIP DETECTED: usage_invoice_due_at is NULL");
      if (!fClientFull?.paddle_address_id) console.error("❌ SKIP DETECTED: paddle_address_id is NULL");
      if (!fClientFull?.paddle_price_usage_id) console.error("❌ SKIP DETECTED: paddle_price_usage_id is NULL");
  }

  if (fClientFull?.usage_invoice_sent_at) {
    console.log("✅ PASS: Usage charge triggered.");
    const originalTime = fClientFull.usage_invoice_sent_at;

    await triggerBillingCron();
    const { data: fClient2 } = await supabaseServer
      .from("clients")
      .select("usage_invoice_sent_at")
      .eq("id", TEST_ID)
      .single();

    if (fClient2?.usage_invoice_sent_at === originalTime) {
      console.log("✅ PASS: Idempotency preserved.");
    } else {
      console.error("❌ FAIL: Charge retriggered.");
    }
  } else {
    console.error("❌ FAIL: Usage charge not triggered.");
    console.log("👉 DIAGNOSIS: If above 'SKIP DETECTED' logs are empty, Paddle rejected the API call. Check server logs for PADDLE_CREATE_FAIL.");
  }

  console.log("\n🏁 FINAL VERDICT: IF 8/8 GREEN, YOU ARE DONE.");
}

runAudit();
