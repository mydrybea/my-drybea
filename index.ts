// supabase/functions/send-push/index.ts
//
// Deploy with:  supabase functions deploy send-push
// Then set two secrets (Supabase Dashboard -> Edge Functions -> send-push -> Secrets,
// or `supabase secrets set`):
//   ONESIGNAL_APP_ID        = the App ID from OneSignal -> Settings -> Keys & IDs
//   ONESIGNAL_REST_API_KEY  = the REST API Key from the same page (keep secret!)
//   PUSH_WEBHOOK_SECRET     = any random string you make up yourself
//
// This function does ONE job: take a Supabase "Database Webhook" payload
// (fired by Postgres on INSERT/UPDATE of a specific table) and translate it
// into a real OneSignal push, targeted at the right person via the
// "External ID" set client-side by initPushForCurrentUser() in app.js.
//
// ---- Wiring it up in Supabase (Dashboard -> Database -> Webhooks) ----
// Create ONE webhook per (table, event) row below, all pointing at this same
// function's URL (https://<project-ref>.functions.supabase.co/send-push),
// with an HTTP header:  Authorization: Bearer <PUSH_WEBHOOK_SECRET>
//
//   Table                        Event    Why
//   ---------------------------  -------  -----------------------------------
//   advance_requests             INSERT   owner: staff asked for an advance
//   advance_requests             UPDATE   staff: their advance was decided
//   attendance                   INSERT   owner: someone checked in
//   attendance                   UPDATE   owner: checked out / work note
//   attendance_corrections       INSERT   owner: correction requested
//   attendance_corrections       UPDATE   staff: correction was decided
//   staff_commission_claims      INSERT   owner: new sale to verify
//   staff_commission_claims      UPDATE   staff: their commission claim was decided
//   driver_cod_handovers         INSERT   owner: cash handed over
//   staff_tasks                  INSERT   staff: new task assigned
//   staff_announcements          INSERT   all staff/drivers/distributors of that business
//   distributor_commission_claims INSERT  owner: new distributor sale
//   distributor_commission_claims UPDATE  distributor: commission decided
//   orders                        INSERT  driver: order created already assigned to them
//   orders                        UPDATE  driver: newly assigned/reassigned a delivery (assigned_driver_id changed)
//
// Each row mirrors a notification builder already living in app.js (nbAdvanceRequested,
// nbCheckedIn, etc.) — keep the wording in sync if you change one side.

const ONESIGNAL_APP_ID = Deno.env.get('ONESIGNAL_APP_ID') ?? '';
const ONESIGNAL_REST_API_KEY = Deno.env.get('ONESIGNAL_REST_API_KEY') ?? '';
const PUSH_WEBHOOK_SECRET = Deno.env.get('PUSH_WEBHOOK_SECRET') ?? '';

type WebhookPayload = {
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  table: string;
  schema: string;
  record: Record<string, any> | null;
  old_record: Record<string, any> | null;
};

type PushPlan = {
  // Exactly one of these two should be set.
  externalId?: string;
  businessTag?: string; // sends to everyone tagged business_id = this value
  excludeExternalId?: string; // used with businessTag, e.g. don't ping the owner about their own announcement
  title: string;
  body: string;
  data?: Record<string, any>;
};

function fmt(n: number) {
  return Math.round(Number(n) || 0).toLocaleString('en-US');
}

// Mirrors the nb*() builder functions in app.js — same events, same wording,
// just producing a push payload instead of an in-page toast.
function buildPushPlan(payload: WebhookPayload): PushPlan | null {
  const { table, type, record, old_record } = payload;
  const r = record || {};
  const o = old_record || {};

  if (table === 'advance_requests') {
    if (type === 'INSERT') {
      return { externalId: r.owner_id, title: '💸 New advance request',
        body: `${r.staff_name || 'A staff member'} requested Rs. ${fmt(r.amount)}`,
        data: { tab: 'my-staff' } };
    }
    if (type === 'UPDATE' && r.status !== o.status && r.status !== 'pending') {
      return { externalId: r.staff_id, title: r.status === 'approved' ? '✅ Advance approved' : '❌ Advance rejected',
        body: `Rs. ${fmt(r.amount)} request was ${r.status}`, data: { tab: 'advance' } };
    }
  }

  if (table === 'attendance') {
    if (type === 'INSERT') {
      return { externalId: r.owner_id, title: `🕒 ${r.staff_name || 'A staff member'} checked in`,
        body: 'Day started', data: { tab: 'my-staff' } };
    }
    if (type === 'UPDATE') {
      if (r.check_out && !o.check_out) {
        return { externalId: r.owner_id, title: `🕒 ${r.staff_name || 'A staff member'} checked out`,
          body: 'Day ended', data: { tab: 'my-staff' } };
      }
      if (r.work_note && r.work_note !== o.work_note) {
        return { externalId: r.owner_id, title: '📝 Work update',
          body: `${r.staff_name || 'A staff member'} posted a work update`, data: { tab: 'my-staff' } };
      }
    }
  }

  if (table === 'attendance_corrections') {
    if (type === 'INSERT') {
      return { externalId: r.owner_id, title: '🚩 Correction request',
        body: `${r.staff_name || 'A staff member'} asked to correct ${r.field === 'check_in' ? 'check-in' : 'check-out'} time`,
        data: { tab: 'my-staff' } };
    }
    if (type === 'UPDATE' && r.status !== o.status && r.status !== 'pending') {
      return { externalId: r.staff_id, title: r.status === 'approved' ? '✅ Correction approved' : '❌ Correction rejected',
        body: `${r.field === 'check_in' ? 'Check-in' : 'Check-out'} time correction was ${r.status}`, data: { tab: 'attendance' } };
    }
  }

  if (table === 'staff_commission_claims') {
    if (type === 'INSERT') {
      return { externalId: r.owner_id, title: '🧾 New sale to verify',
        body: `${r.customer_name || 'A sale'} · Rs. ${fmt(r.order_total)} awaiting verification`, data: { tab: 'my-staff' } };
    }
    if (type === 'UPDATE' && r.status !== o.status && r.status !== 'pending') {
      return { externalId: r.staff_id, title: r.status === 'approved' ? '✅ Commission approved' : '❌ Commission rejected',
        body: `Your commission claim was ${r.status}`, data: { tab: 'my-income' } };
    }
  }

  if (table === 'driver_cod_handovers' && type === 'INSERT') {
    return { externalId: r.owner_id, title: '💰 Cash handed over',
      body: `${r.driver_name || 'A driver'} handed over Rs. ${fmt(r.amount)}`, data: { tab: 'delivery' } };
  }

  if (table === 'staff_tasks' && type === 'INSERT') {
    return { externalId: r.staff_id, title: '📋 New task assigned',
      body: r.title || 'Check My Tasks', data: { tab: 'my-tasks' } };
  }

  if (table === 'staff_announcements' && type === 'INSERT') {
    // Broadcast: every staff/driver/distributor tagged with this owner's
    // business_id (see initPushForCurrentUser() in app.js), never the owner
    // themselves (they're the one who posted it).
    return { businessTag: r.owner_id, excludeExternalId: r.owner_id,
      title: `📣 ${r.title || 'New notice'}`, body: r.message || '', data: { tab: 'announcements' } };
  }

  if (table === 'distributor_commission_claims') {
    if (type === 'INSERT') {
      return { externalId: r.owner_id, title: '🧾 New distributor sale',
        body: `${r.distributor_reference || 'A distributor'} · Rs. ${fmt(r.order_total)} — commission pending`, data: { tab: 'delivery' } };
    }
    if (type === 'UPDATE' && o.status === 'pending' && r.status && r.status !== 'pending' && r.status !== o.status) {
      return { externalId: r.distributor_id, title: r.status === 'approved' ? '✅ Commission approved' : '❌ Commission rejected',
        body: `Rs. ${fmt(r.commission_amount)} commission was ${r.status}`, data: { tab: 'my-income' } };
    }
  }

  if (table === 'orders') {
    // Column is assigned_driver_id (not driver_id) — matches app.js and the
    // actual schema. INSERT covers an order created already assigned to a
    // driver; UPDATE covers a dispatcher assigning/reassigning an existing
    // order, guarded so re-saving an already-assigned order doesn't re-fire.
    if (type === 'INSERT' && r.assigned_driver_id) {
      return { externalId: r.assigned_driver_id, title: '🚚 New Delivery Assigned',
        body: r.address || 'Check My Deliveries', data: { tab: 'my-deliveries' } };
    }
    if (type === 'UPDATE' && r.assigned_driver_id && r.assigned_driver_id !== o.assigned_driver_id) {
      return { externalId: r.assigned_driver_id, title: '🚚 New Delivery Assigned',
        body: r.address || 'Check My Deliveries', data: { tab: 'my-deliveries' } };
    }
  }

  return null; // nothing worth pushing for this event
}

async function sendOneSignalPush(plan: PushPlan) {
  const base = {
    app_id: ONESIGNAL_APP_ID,
    target_channel: 'push',
    headings: { en: plan.title },
    contents: { en: plan.body || ' ' },
    data: plan.data || {},
  };

  const body = plan.businessTag
    ? {
        ...base,
        filters: [
          { field: 'tag', key: 'business_id', relation: '=', value: plan.businessTag },
          ...(plan.excludeExternalId
            ? [{ operator: 'AND' }, { field: 'external_id', relation: '!=', value: plan.excludeExternalId }]
            : []),
        ],
      }
    : { ...base, include_aliases: { external_id: [String(plan.externalId)] } };

  const res = await fetch('https://api.onesignal.com/notifications', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Current OneSignal REST API (api.onesignal.com) expects the "Key"
      // prefix, not "Basic" — see https://documentation.onesignal.com/reference/quick-start-api-guide
      Authorization: `Key ${ONESIGNAL_REST_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) console.error('OneSignal send failed:', res.status, json);
  return { ok: res.ok, status: res.status, json };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  if (PUSH_WEBHOOK_SECRET) {
    const auth = req.headers.get('authorization') || '';
    if (auth !== `Bearer ${PUSH_WEBHOOK_SECRET}`) {
      return new Response('Unauthorized', { status: 401 });
    }
  }

  let payload: WebhookPayload;
  try {
    payload = await req.json();
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  const plan = buildPushPlan(payload);
  if (!plan || (!plan.externalId && !plan.businessTag)) {
    // Not every INSERT/UPDATE on a watched table is worth a push (e.g. an
    // advance_requests UPDATE that isn't a status change yet) — that's
    // expected and not an error.
    return new Response(JSON.stringify({ skipped: true }), { status: 200 });
  }

  const result = await sendOneSignalPush(plan);
  return new Response(JSON.stringify(result), { status: result.ok ? 200 : 502 });
});
