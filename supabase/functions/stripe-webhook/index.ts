// StackLab Tomball -- Stripe webhook. Stripe calls this when money moves; it
// records the payment once (apply_stripe_payment is idempotent on the txn id)
// and marks the booking, class, day pass or membership paid.

import Stripe from "npm:stripe@17.7.0";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2025-02-24.acacia",
  httpClient: Stripe.createFetchHttpClient(),
});
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const crypto = Stripe.createSubtleCryptoProvider();

const TYPE: Record<string, string> = { res: "rental", reg: "class", mem: "membership", drop: "dropin" };
const LABEL: Record<string, string> = { res: "Court rental", reg: "Class", mem: "Gym-access membership", drop: "Gym-access day pass" };
const chicagoDate = (ts: number) => new Date(ts * 1000).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

function parseItems(s?: string | null) {
  return (s ?? "").split("|").filter(Boolean).map((x) => {
    const [kind, id, amount] = x.split(":");
    return { kind, id, amount: Number(amount) };
  });
}

async function apply(txnId: string, kind: string, id: string, amount: number, desc: string, ref: Record<string, unknown>, patch = {}) {
  const { data, error } = await admin.rpc("apply_stripe_payment", {
    p_txn_id: txnId, p_kind: kind, p_item_id: id, p_amount: amount,
    p_type: TYPE[kind] ?? kind, p_desc: desc, p_stripe: ref, p_patch: patch,
  });
  if (error) throw error;
  console.log(data ? "recorded" : "already recorded", txnId, kind, id, amount);
}

async function memberIdFor(subId: string | null | undefined) {
  if (!subId) return null;
  const sub = await stripe.subscriptions.retrieve(subId);
  return sub.metadata?.member_id ?? null;
}

async function handle(event: Stripe.Event) {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const s = event.data.object as Stripe.Checkout.Session;
      if (s.mode === "payment" && s.payment_status === "paid") {
        const items = parseItems(s.metadata?.items);
        for (const [i, it] of items.entries()) {
          await apply(`stripe_${s.id}_${i}`, it.kind, it.id, it.amount, `${LABEL[it.kind] ?? "Payment"} (paid online)`,
            { session: s.id, payment_intent: s.payment_intent });
        }
      } else if (s.mode === "subscription" && s.metadata?.member_id) {
        await admin.rpc("patch_item", {
          p_kind: "mem", p_item_id: s.metadata.member_id,
          p_patch: { stripeSub: s.subscription, stripeCustomer: s.customer, autopay: true },
        });
      }
      return;
    }

    case "invoice.paid": {
      const inv = event.data.object as Stripe.Invoice;
      if (!inv.amount_paid) return;  // $0 trial invoice
      const amount = inv.amount_paid / 100;
      const ref = { invoice: inv.id, number: inv.number, url: inv.hosted_invoice_url };
      const subId = typeof inv.subscription === "string" ? inv.subscription : inv.subscription?.id;
      if (subId) {
        const memberId = inv.subscription_details?.metadata?.member_id ?? await memberIdFor(subId);
        if (!memberId) return;
        const end = inv.lines?.data?.[0]?.period?.end;
        await apply(`stripe_${inv.id}`, "mem", memberId, amount, "Gym-access membership (autopay)", ref,
          { stripeSub: subId, stripeCustomer: inv.customer, autopay: true, ...(end ? { nextBill: chicagoDate(end) } : {}) });
        return;
      }
      const items = parseItems(inv.metadata?.items);
      for (const [i, it] of items.entries()) {
        await apply(`stripe_${inv.id}_${i}`, it.kind, it.id, it.amount, `${LABEL[it.kind] ?? "Payment"} (invoice ${inv.number ?? ""})`.trim(), ref,
          { invoice: { id: inv.id, number: inv.number, url: inv.hosted_invoice_url, amount: it.amount, status: "paid", at: new Date().toISOString() } });
      }
      return;
    }

    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const memberId = sub.metadata?.member_id;
      if (!memberId) return;
      const ended = event.type === "customer.subscription.deleted" || sub.status === "canceled";
      const cancelling = ended || sub.cancel_at_period_end;
      const end = sub.items?.data?.[0]?.current_period_end ?? (sub as any).current_period_end;
      const patch: Record<string, unknown> = cancelling
        ? { status: "cancelled", cancelledAt: chicagoDate(Math.floor(Date.now() / 1000)), autopay: false, ...(end ? { nextBill: chicagoDate(end) } : {}) }
        : { status: "active", cancelledAt: "", autopay: true };
      if (ended) patch.stripeSub = null;
      await admin.rpc("patch_item", { p_kind: "mem", p_item_id: memberId, p_patch: patch });
      return;
    }

    case "invoice.payment_failed": {
      const inv = event.data.object as Stripe.Invoice;
      const subId = typeof inv.subscription === "string" ? inv.subscription : inv.subscription?.id;
      const memberId = inv.subscription_details?.metadata?.member_id ?? await memberIdFor(subId);
      if (memberId) await admin.rpc("patch_item", { p_kind: "mem", p_item_id: memberId, p_patch: { paymentFailedAt: new Date().toISOString() } });
      return;
    }
  }
}

Deno.serve(async (req) => {
  const sig = req.headers.get("Stripe-Signature");
  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig!, Deno.env.get("STRIPE_WEBHOOK_SECRET")!, undefined, crypto);
  } catch (e) {
    console.error("bad signature", e);
    return new Response("Bad signature", { status: 400 });
  }
  try {
    await handle(event);
    return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error(event.type, event.id, e);
    return new Response("Handler error", { status: 500 });  // Stripe retries
  }
});
