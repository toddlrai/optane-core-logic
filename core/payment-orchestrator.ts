import { NextRequest, NextResponse } from "next/server";
import { handlePaymentSuccess } from "@/lib/db/rpc";
import { resumeAgent } from "@/lib/billing/agent";
import { supabaseServer } from "@/lib/supabase-server";
import { logError, logInfo, logWarn } from "@/lib/monitoring/logger";
import crypto from "crypto";

// 🔒 Signature Verification Utility
function verifyPaddleSignature(req: NextRequest, rawBody: string) {
  const signature = req.headers.get("paddle-signature") || "";
  const secret = process.env.PADDLE_WEBHOOK_SECRET || "";
  if (!signature || !secret) return false;

  const [tsPart, hmacPart] = signature.split(";");
  const timestamp = tsPart?.split("=")[1];
  const hmac = hmacPart?.split("=")[1];
  if (!timestamp || !hmac) return false;

  const signedPayload = `${timestamp}:${rawBody}`;

  const expectedHmac = crypto
    .createHmac("sha256", secret)
    .update(signedPayload)
    .digest("hex");

  return expectedHmac === hmac;
}

// 📊 Rank Helper for Logic
const RANKS: Record<string, number> = {
  starter: 1,
  growth: 2,
  scale: 3,
  pro: 4,
  usage: 0,
};

export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  if (!verifyPaddleSignature(req, rawBody)) {
    return NextResponse.json({ error: "Invalid Signature" }, { status: 401 });
  }

  // Healthchecks.io Check
  await fetch("https://hc-ping.com/49ba88ab-4abd-4aaf-ade8-3fa37faa757a").catch(() => null);
  
  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { event_type, data } = event;
  
  // Robust Client ID Extraction
  const clientId =
    data?.custom_data?.client_id ||
    data?.custom_data?.["custom_data[client_id]"];

  if (!clientId) return NextResponse.json({ received: true });

  const PLAN_BY_PRICE: Record<
    string,
    {
      plan: "starter" | "growth" | "scale" | "pro" | "usage";
      amount: number;
      minutes: number;
      rank: number;
      price_per_minute: number;
      paymentType: "subscription" | "usage";
    }
  > = {
    pri_01kcgn71kmeypsjan8aqw1snf6: {
      plan: "starter",
      amount: 297,
      minutes: 1000,
      rank: 1,
      price_per_minute: 0.29,
      paymentType: "subscription",
    },
    pri_01kcgp2hssyxaq4kyrxxegjvjv: {
      plan: "growth",
      amount: 497,
      minutes: 2500,
      rank: 2,
      price_per_minute: 0.26,
      paymentType: "subscription",
    },
    pri_01kcgpmajyawrje6emz4edyet5: {
      plan: "scale",
      amount: 697,
      minutes: 5000,
      rank: 3,
      price_per_minute: 0.23,
      paymentType: "subscription",
    },
    pri_01kd56vwkfm7v52yjes8ymavt3: {
      plan: "pro",
      amount: 997,
      minutes: 10000,
      rank: 4,
      price_per_minute: 0.20,
      paymentType: "subscription",
    },
    // ✅ USAGE PRICE — SHARED FOR ALL CLIENTS
    pri_01kd5qrbh5d1hadyfa15sp0m51: {
      plan: "usage",
      amount: 0,
      minutes: 0,
      rank: 0,
      price_per_minute: 0,
      paymentType: "usage",
    },
  };

  try {
    // 🔍 FETCH EXISTING CLIENT STATE (Needed for Email Havoc & Ranking)
    const { data: clientRecord } = await supabaseServer
      .from("clients")
      .select("plan_type, email, paddle_customer_id")
      .eq("id", clientId)
      .single();

    if (clientRecord) {
      // 🚨 EMAIL HAVOC FIX: If user paid with a new email, update DB immediately.
      // This ensures we always send invoices to the active payer.
      const webhookEmail = data.customer?.email;
      if (webhookEmail && clientRecord.email !== webhookEmail) {
        await supabaseServer
          .from("clients")
          .update({ 
             email: webhookEmail,
             // Optional: Update paddle_customer_id if it changed too
             paddle_customer_id: data.customer_id || clientRecord.paddle_customer_id 
          })
          .eq("id", clientId);
        
        logWarn("Client email updated via webhook", { clientId, old: clientRecord.email, new: webhookEmail });
      }
    }

    if (event_type === "transaction.completed") {
      const item = data.items?.[0];
      const priceId =
        item?.price?.id ||
        item?.price_id ||
        item?.product?.price_id;

      const planConfig = PLAN_BY_PRICE[priceId];

      if (!planConfig) {
        logWarn("Unknown priceId in transaction.completed", {
          priceId,
          clientId,
        });
        return NextResponse.json({ received: true });
      }

      const paidAt = data.billed_at || new Date().toISOString();

      // 🔥 USAGE PAYMENT PATH
      if (planConfig.paymentType === "usage") {
        await supabaseServer
          .from("clients")
          .update({
            usage_invoice_due_at: null,
            last_usage_billed_at: paidAt,
          })
          .eq("id", clientId);

        await handlePaymentSuccess({
          clientId,
          // For usage, we trust the billed amount (converted to number)
          amount: Number(data.details?.totals?.grand_total || 0) / 100,
          plan: "usage",
          planAmount: 0,
          minutesBucket: 0,
          pricePerMinute: 0,
          paymentType: "usage",
          eventId: data.id,
          invoiceId: data.invoice_id || null,
          orderId: data.order_id || null,
          paidAt,
        });

        await resumeAgent(clientId);

        logInfo("Usage payment processed", { clientId });
        return NextResponse.json({ received: true });
      }

      // 🔥 SUBSCRIPTION PAYMENT PATH (UPGRADE / DOWNGRADE / RENEW)
      
      // 1. CURRENCY FIX: Use Hardcoded USD Amount for Subscriptions
      // Ignore the INR/AUD amount from Paddle. Log the USD value of the plan.
      const amount = planConfig.amount;

      // 2. RANKING LOGIC (Upgrade vs Downgrade)
      let finalPaymentType: "subscription" | "upgrade" | "downgrade" | "renewal" = "subscription";
      
      if (clientRecord?.plan_type) {
        // Extract plain plan name (e.g. "starter" from "starter_monthly")
        const currentPlanKey = clientRecord.plan_type.split("_")[0].toLowerCase(); 
        const oldRank = RANKS[currentPlanKey] || 0;
        const newRank = planConfig.rank;

        if (newRank > oldRank) finalPaymentType = "upgrade";
        else if (newRank < oldRank) finalPaymentType = "downgrade";
        else finalPaymentType = "renewal";
      }

      await handlePaymentSuccess({
        clientId,
        amount, // Now strictly USD
        plan: planConfig.plan,
        planAmount: planConfig.amount,
        minutesBucket: planConfig.minutes,
        pricePerMinute: planConfig.price_per_minute,
        // Pass the calculated type (Requires DB enum update if 'upgrade' not allowed, else use "subscription")
        // Assuming your DB handles the string or you map it. 
        // If handlePaymentSuccess is strict, cast it: 
        paymentType: finalPaymentType as any, 
        eventId: data.id,
        invoiceId: data.invoice_id || null,
        orderId: data.order_id || null,
        paidAt,
      });

      await resumeAgent(clientId);

      logInfo(`Subscription processed: ${finalPaymentType}`, {
        clientId,
        plan: planConfig.plan,
        amountUSD: amount
      });
    }

    if (
      event_type === "subscription.activated" ||
      event_type === "subscription.updated"
    ) {
      await supabaseServer
        .from("clients")
        .update({
          next_billing_date: data.next_billed_at,
          renewal_status: "active",
        })
        .eq("id", clientId);
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    logError("Paddle webhook processing failed", err);
    return NextResponse.json({ error: "Internal Error" }, { status: 500 });
  }
}
