// StackLab Tomball -- Stripe actions for the booking site.
// The Stripe secret key lives only here (Supabase secret STRIPE_SECRET_KEY).
// Every amount is read from the database, never from the browser.
//
// POST { action, ... } with the signed-in user's Supabase JWT:
//   checkout          { items?: [{kind,id}] }  one-time payment for bookings, classes, day passes
//   membership        { id }                   monthly subscription (Stripe Billing) for a membership
//   portal            {}                       Stripe customer portal: card on file, receipts, cancel
//   invoice           { kind, id }             owner only: email a Stripe invoice for an amount due
//   cancelMembership  { id }                   owner only: stop autopay at the end of the paid month

import Stripe from "npm:stripe@17.7.0";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2025-02-24.acacia",
  httpClient: Stripe.createFetchHttpClient(),
});
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const SITE = (Deno.env.get("SITE_URL") ?? "https://stacklabtomball.com").replace(/\/$/, "");
const MEMBERSHIP_PRICE = "stacklab_membership_monthly";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
class Oops extends Error { constructor(msg: string, public status = 400) { super(msg); } }

const TABLE: Record<string, string> = { res: "reservations", reg: "regs", mem: "members", drop: "dropins" };
const TYPE: Record<string, string> = { res: "rental", reg: "class", mem: "membership", drop: "dropin" };
const cents = (n: number) => Math.round(n * 100);
const r2 = (n: number) => Math.round(n * 100) / 100;

type Item = { kind: string; id: string; row: any; amount: number; label: string; email: string; name: string };

async function loadItem(kind: string, id: string): Promise<Item> {
  const table = TABLE[kind];
  if (!table) throw new Oops("Unknown item type.");
  const { data, error } = await admin.from(table).select("id,user_id,data").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw new Oops("That item was not found.", 404);
  const d = data.data ?? {};
  let amount = 0, label = "", email = "", name = "";
  if (kind === "res") {
    amount = d.status === "confirmed" ? r2((d.total ?? 0) - (d.paid ?? 0)) : 0;
    label = `Court rental ${d.code ?? ""} – ${d.date}`.trim();
    email = d.customer?.email ?? ""; name = d.customer?.name ?? "";
  } else if (kind === "reg") {
    amount = d.status === "active" ? r2(d.due ?? 0) : 0;
    const cls = await admin.from("classes").select("data").eq("id", d.classId).maybeSingle();
    label = `Class: ${cls.data?.data?.name ?? "class"} (${d.name ?? ""})`;
    email = d.email ?? ""; name = d.name ?? "";
  } else if (kind === "mem") {
    amount = r2(d.owed ?? 0);
    label = "Gym-access membership";
    email = d.email ?? ""; name = d.name ?? "";
  } else {
    amount = r2(d.due ?? 0);
    label = `Gym-access day pass – ${d.date}`;
    email = d.email ?? ""; name = d.name ?? "";
  }
  return { kind, id, row: data, amount, label, email, name };
}

const mine = (it: Item, user: any) =>
  it.row.user_id === user.id || (it.email && it.email.toLowerCase() === (user.email ?? "").toLowerCase());

async function customerFor(email: string, name: string, userId?: string) {
  const found = await stripe.customers.list({ email, limit: 1 });
  if (found.data.length) return found.data[0].id;
  const c = await stripe.customers.create({ email, name, metadata: userId ? { user_id: userId } : {} });
  return c.id;
}

// "res:abc:40" items list carried in Stripe metadata (500-char limit per value).
const encodeItems = (items: Item[]) => items.map((i) => `${i.kind}:${i.id}:${i.amount.toFixed(2)}`).join("|");

async function myDues(user: any): Promise<Item[]> {
  const out: Item[] = [];
  for (const kind of ["res", "reg", "drop"]) {
    const { data, error } = await admin.from(TABLE[kind]).select("id").eq("user_id", user.id);
    if (error) throw error;
    for (const r of data ?? []) {
      const it = await loadItem(kind, r.id);
      if (it.amount > 0) out.push(it);
    }
  }
  return out;
}

async function handle(req: Request) {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: auth } = await admin.auth.getUser(token);
  const user = auth?.user;
  if (!user) throw new Oops("Please log in again.", 401);
  const { data: own } = await admin.from("owners").select("user_id").eq("user_id", user.id).maybeSingle();
  const isOwner = !!own;
  const body = await req.json().catch(() => ({}));

  switch (body.action) {
    case "checkout": {
      let items: Item[];
      if (Array.isArray(body.items) && body.items.length) {
        items = await Promise.all(body.items.slice(0, 12).map((x: any) => loadItem(String(x.kind), String(x.id))));
        if (!items.every((i) => mine(i, user))) throw new Oops("That item is not on your account.", 403);
      } else {
        items = await myDues(user);
      }
      items = items.filter((i) => i.kind !== "mem" && i.amount > 0);
      if (!items.length) throw new Oops("Nothing is due on your account.");
      const customer = await customerFor(user.email!, items[0].name, user.id);
      const meta = { user_id: user.id, items: encodeItems(items) };
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer,
        client_reference_id: user.id,
        line_items: items.map((i) => ({
          quantity: 1,
          price_data: { currency: "usd", unit_amount: cents(i.amount), product_data: { name: i.label } },
        })),
        metadata: meta,
        payment_intent_data: { metadata: meta, description: "StackLab Tomball" },
        success_url: `${SITE}/book/?stripe=paid#pay`,
        cancel_url: `${SITE}/book/?stripe=cancelled#pay`,
      });
      return { url: session.url };
    }

    case "membership": {
      const it = await loadItem("mem", String(body.id));
      if (!mine(it, user)) throw new Oops("That membership is not on your account.", 403);
      const d = it.row.data;
      if (d.status !== "active") throw new Oops("This membership is not active.");
      if (d.stripeSub) throw new Oops("Automatic payments are already on for this membership.");
      const customer = await customerFor(user.email!, it.name, user.id);
      const prices = await stripe.prices.list({ lookup_keys: [MEMBERSHIP_PRICE], active: true, limit: 1 });
      if (!prices.data.length) throw new Oops("Membership price is not set up in Stripe.", 500);
      // Already paid for this month at the desk: start charging at the next renewal date.
      const renew = Date.parse(`${d.nextBill}T12:00:00-06:00`) / 1000;
      const trial = it.amount <= 0 && renew > Date.now() / 1000 + 3 * 86400 ? Math.floor(renew) : undefined;
      const meta = { member_id: it.id, user_id: user.id };
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer,
        client_reference_id: user.id,
        line_items: [{ price: prices.data[0].id, quantity: 1 }],
        subscription_data: { metadata: meta, ...(trial ? { trial_end: trial } : {}) },
        metadata: meta,
        success_url: `${SITE}/book/?stripe=member#pay`,
        cancel_url: `${SITE}/book/?stripe=cancelled#pay`,
      });
      return { url: session.url };
    }

    case "portal": {
      const found = await stripe.customers.list({ email: user.email!, limit: 1 });
      if (!found.data.length) throw new Oops("You have no card on file yet.");
      const s = await stripe.billingPortal.sessions.create({ customer: found.data[0].id, return_url: `${SITE}/book/#pay` });
      return { url: s.url };
    }

    case "invoice": {
      if (!isOwner) throw new Oops("Owners only.", 403);
      const it = await loadItem(String(body.kind), String(body.id));
      if (it.amount <= 0) throw new Oops("Nothing is due on this item.");
      if (!it.email) throw new Oops("This customer has no email address.");
      const customer = await customerFor(it.email, it.name, it.row.user_id ?? undefined);
      const meta = { items: encodeItems([it]) };
      const inv = await stripe.invoices.create({
        customer, collection_method: "send_invoice", days_until_due: 7, metadata: meta,
        description: "StackLab Tomball, 18618 FM 2920, Tomball TX",
      });
      await stripe.invoiceItems.create({ customer, invoice: inv.id, amount: cents(it.amount), currency: "usd", description: it.label });
      await stripe.invoices.finalizeInvoice(inv.id!);
      const sent = await stripe.invoices.sendInvoice(inv.id!);
      const invoice = { id: sent.id, number: sent.number, url: sent.hosted_invoice_url, amount: it.amount, at: new Date().toISOString(), status: "sent" };
      await admin.rpc("patch_item", { p_kind: it.kind, p_item_id: it.id, p_patch: { invoice } });
      return { url: sent.hosted_invoice_url, number: sent.number };
    }

    case "cancelMembership": {
      const it = await loadItem("mem", String(body.id));
      if (!isOwner && !mine(it, user)) throw new Oops("Not allowed.", 403);
      const sub = it.row.data.stripeSub;
      if (!sub) return { ok: true, stripe: false };
      await stripe.subscriptions.update(sub, { cancel_at_period_end: true });
      return { ok: true, stripe: true };
    }
  }
  throw new Oops("Unknown action.");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    return json(await handle(req));
  } catch (e) {
    const status = e instanceof Oops ? e.status : 500;
    console.error(e);
    return json({ error: e instanceof Oops ? e.message : "Payment service error. Please try again." }, status);
  }
});
