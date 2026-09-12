/* ==================== EVENT DELEGATION (PHASE 1 REFACTOR) ====================
   Pilot: Staff / Salary / Attendance / Advance sections only.
   Replaces inline onclick="fn(args)" with data-action / data-id / data-args
   attributes, handled by ONE delegated listener below. No business logic
   changed — this only changes how the click reaches the same functions.
   data-id      -> passed as the 1st argument (e.g. a row's ${row.id})
   data-args    -> JSON array of any further literal arguments
   Example: <button data-action="decideAdvance" data-id="${r.id}" data-args='["approved"]'>
            -> calls decideAdvance(r.id, "approved") exactly like the old onclick did. */
document.addEventListener('click', function (e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const fn = window[action];
  if (typeof fn !== 'function') {
    console.warn('[data-action] no function found for:', action);
    return;
  }
  const args = [];
  if (el.dataset.id !== undefined) args.push(el.dataset.id);
  if (el.dataset.args !== undefined) {
    try { args.push(...JSON.parse(el.dataset.args)); }
    catch (err) { console.warn('[data-action] bad data-args on', action, err); }
  }
  fn.apply(null, args);
});

// Extracted from a repeated inline onclick (was: activateAppTab('profile') then
// scroll salaryStaffSelect into view after a short delay). Same behavior, named.
function focusSalaryStaffSelect() {
  activateAppTab('profile');
  setTimeout(() => document.getElementById('salaryStaffSelect')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 120);
}
window.focusSalaryStaffSelect = focusSalaryStaffSelect;

/* BUSINESS-CLASS ICON SYSTEM — VISUAL ONLY.
   No database, auth, Supabase, calculations or business logic changed. */
document.addEventListener('DOMContentLoaded', function () {
  if (window.lucide) {
    lucide.createIcons({
      attrs: {
        'stroke-width': 1.9,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round'
      }
    });
  }
  // Reflect the saved notification-sound preference on the bell icon.
  try {
    var soundOn = localStorage.getItem('mydrybea_notify_sound_on') !== 'off';
    var btn = document.getElementById('notifyCenterSoundToggle');
    if (btn) {
      btn.classList.toggle('muted', !soundOn);
      btn.title = soundOn ? 'Notification sound: on' : 'Notification sound: off';
      var icon = btn.querySelector('i');
      if (icon) icon.setAttribute('data-lucide', soundOn ? 'bell' : 'bell-off');
      if (window.lucide) lucide.createIcons();
    }
  } catch (e) {}
});

(function(){
"use strict";

// ==================== CONSTANTS ====================
const PACKS = {
  50:   { label:'50g',  fish:45,  dust:5,  grind:2,  pack:13.5, qty:1000, mrp:170 },
  100:  { label:'100g', fish:90,  dust:10, grind:4,  pack:43,   qty:500,  mrp:350 },
  500:  { label:'500g', fish:475, dust:25, grind:20, pack:130,  qty:50,   mrp:1750 },
  1000: { label:'1kg',  fish:950, dust:50, grind:40, pack:140,  qty:50,   mrp:3500 }
};
const DEFAULT_FIXED = { transport:110000, firewood:30000, workers:220000, other:220000 };
// Default grinding yields — % of Umbalakada that survives grinding into
// usable flakes; the rest is lost as fine dust. Overridden by
// state.linnaGrindYield / balayaGrindYield / premiumGrindYield (editable
// in the Costing tab's "Grinding Yield & Dust Loss" fields) once the app
// has loaded state — see getGrindYields() below. These constants remain
// the fallback for any code path that runs before state is ready.
const LINNA_USABLE = 0.80;
const BALAYA_USABLE = 0.90;
const PREMIUM_USABLE = 0.65;
const PACKING_LABOUR_PCT = 0.05;
const STORAGE_KEY = 'mydrybea_v34_state';
const HISTORY_KEY = 'mydrybea_v34_history';
const ORDERS_KEY = 'mydrybea_v34_orders';
const CUSTOMERS_KEY = 'mydrybea_v34_customers';
const SNAPSHOTS_KEY = 'mydrybea_v34_snapshots';
const MAX_SNAPSHOTS = 5;
// A delivered order counts as "on time" for the Delivery Performance dashboard
// if it was delivered within this many hours of the driver tapping "Start
// Delivery" (shipped_at). Purely a reporting threshold — doesn't affect pay,
// status, or anything else. Adjust here if the business wants a stricter/looser bar.
const DELIVERY_ONTIME_HOURS = 24;
// Default pickup point (Drybea Market), used until the owner sets their own via
// "Change Pickup Location" on the Delivery page. Once set, the owner's choice
// (stored on their profile as pickup_lat/pickup_lng/pickup_label) always wins,
// and feeds the Delivery page's live map + each driver's direction line.
const DEFAULT_PICKUP_LOCATION = { lat: 5.984411, lng: 80.7312384, name: 'Drybea Market (Pickup)' };
function getPickupLocation() {
  if (userProfile && userProfile.pickup_lat != null && userProfile.pickup_lng != null) {
    return {
      lat: Number(userProfile.pickup_lat),
      lng: Number(userProfile.pickup_lng),
      name: userProfile.pickup_label || 'Pickup Point'
    };
  }
  return DEFAULT_PICKUP_LOCATION;
}
const USER_KEY = 'mydrybea_v34_user';
const SUPABASE_URL = 'https://dztuyfiiyxllnvciunjv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR6dHV5ZmlpeXhsbG52Y2l1bmp2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgwMDg3NjUsImV4cCI6MjEwMzU4NDc2NX0.NT5_fvlwZZr_MQMgerYaIZYHeeJ9l9SrConqcN50M84';

// ==================== SUPABASE ====================
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: 'sb-dztuyfiiyxllnvciunjv-auth-token'
  }
});

// Confirms (and, if needed, silently refreshes) the Supabase session's access
// token right before a write. Needed because drivers/owners often leave the
// app open for hours — screen locked, tab backgrounded — during which mobile
// browsers throttle/freeze JS timers and autoRefreshToken's scheduled refresh
// can simply never fire. The token then sits expired in storage and the next
// save fails with a raw "JWT expired" error from the server. getSession()
// checks expiry itself and uses the refresh token to get a new one when
// needed, so calling it first fixes that silently in the common case. As a
// belt-and-braces measure, if the token is already expired (or expiring
// within the next minute) we also force an explicit refreshSession() call —
// getSession()'s own silent refresh can lose a race with a frozen background
// tab and hand back a session that LOOKS present but carries a dead token,
// which is what let "JWT expired" through even with this check in place. If
// the refresh token itself is dead (real logout / long-expired session),
// there's nothing to recover — send the user to log in again instead of
// letting the save fail with a confusing error.
async function ensureFreshSession() {
  try {
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error || !session) {
      alert('⚠️ Your session has expired. Please log in again.');
      window.location.replace('login.html');
      return false;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (!session.expires_at || session.expires_at - nowSec < 60) {
      const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession();
      if (refreshErr || !refreshed?.session) {
        alert('⚠️ Your session has expired. Please log in again.');
        window.location.replace('login.html');
        return false;
      }
    }
    return true;
  } catch (e) {
    console.error('Session refresh check failed:', e);
    return true; // don't block the save on a check that itself failed to reach the network
  }
}

// Last-resort safety net: if a Supabase write still comes back with a
// JWT/token error despite ensureFreshSession() having just run (a stale
// token race, or a token that expired in the few seconds between the check
// and the request going out), force one real refresh and retry the write
// exactly once before giving up. fn must be a zero-argument function that
// performs the write and returns its Supabase `{ data, error }` result (or
// throws) — call it again inside fn each time, don't reuse a promise.
function isJwtExpiredError(err) {
  const msg = String(err && (err.message || err) || '').toLowerCase();
  return msg.includes('jwt expired') || msg.includes('jwt is expired') || (msg.includes('jwt') && msg.includes('expired')) || msg.includes('pgrst301');
}
async function withSessionRetry(fn) {
  let result;
  try {
    result = await fn();
  } catch (e) {
    if (!isJwtExpiredError(e)) throw e;
    result = { error: e };
  }
  if (result && result.error && isJwtExpiredError(result.error)) {
    console.warn('Write hit an expired token after the pre-check — forcing a refresh and retrying once.');
    const { error: refreshErr } = await supabase.auth.refreshSession();
    if (refreshErr) return result; // nothing more we can do — return the original error to the caller
    result = await fn();
  }
  return result;
}
window.withSessionRetry = withSessionRetry;

let currentUser = null;
let userProfile = null;
let userRole = 'owner';   // 'owner' | 'staff' | 'driver' | 'distributor'
let businessId = null;    // the effective account whose data everyone on the team shares

async function loadUserProfile() {
  if (!currentUser) return;
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', currentUser.id)
      .maybeSingle();
    if (error) throw error;

    if (!data) {
      // First-ever login for this account: they become an "owner" of their own business.
      const { error: insertErr } = await supabase
        .from('profiles')
        .insert({ id: currentUser.id, role: 'owner' });
      if (insertErr) throw insertErr;
      userProfile = { id: currentUser.id, role: 'owner', owner_id: null };
    } else {
      userProfile = data;
    }

    userRole = userProfile.role === 'staff' ? 'staff' : (userProfile.role === 'driver' ? 'driver' : (userProfile.role === 'distributor' ? 'distributor' : 'owner'));
    businessId = (userRole === 'staff' || userRole === 'driver' || userRole === 'distributor') ? userProfile.owner_id : currentUser.id;
  } catch (e) {
    console.error('Load profile error:', e);
    // Fail safe: treat as an independent owner of their own data.
    userRole = 'owner';
    businessId = currentUser.id;
  }
  applyRoleUI();
  initPushForCurrentUser();
  // PERFORMANCE: these role-specific data loads (staff tasks/notices/
  // performance/commission, or driver deliveries, or distributor claims)
  // used to be awaited right here, which blocked the ENTIRE rest of login
  // — including the main dashboard's own data — on a whole extra network
  // round trip for panels the user isn't even looking at yet. Each of
  // these functions already renders its own UI the moment its data
  // arrives and already catches its own errors internally, so there's
  // nothing unsafe about letting them run in the background: we fire
  // them off here without awaiting, so they load *concurrently* with the
  // main dashboard data instead of *before* it. This alone removes one
  // full sequential network wave from every login, which is where most
  // of the mobile-perceived lag was coming from.
  if (userRole === 'driver') {
    loadMyDeliveries();
    startDriverDeliveriesRealtime();
    updateDriverNotifyPermUI();
  } else if (userRole === 'distributor') {
    loadDistributorCommissionClaims();
  } else {
    loadMyStaffData(false);
    startAppNotifyRealtime();
  }
}

const STAFF_ALLOWED_TABS = ['staff-home','orders','my-salary','profile','expenses','products'];
// 'driver-home' is a real overview page, separate from the 'my-deliveries'
// list — drivers land here first, then tap into My Deliveries / My Earnings.
const DRIVER_ALLOWED_TABS = ['driver-home','my-deliveries','my-earnings','my-reviews','profile','products'];
// Distributor previously had only 2 tabs (product-agent, profile), so their
// bottom nav could never fill out to 5 buttons like Staff and Driver do.
// Added 'orders', 'expenses' and 'products' — the same three generic,
// business-scoped tabs Staff accounts already use safely (they're
// businessId-scoped, not owner-only). Distributors will now see the same
// shared orders/expenses/products views a staff account sees.
// 'product-agent' was renamed to 'my-income' (a dedicated Commission/Income
// page) and 'distributor-home' was added as a real overview page, separate
// from it — distributors land on Home first, then tap into My Income.
const DISTRIBUTOR_ALLOWED_TABS = ['distributor-home','my-income','commission-summary','orders','expenses','products','profile'];

// ---- Bottom/top nav bar visibility — exactly 5 tabs per role, no "More" ----
// These are separate from the *_ALLOWED_TABS above (which still govern what
// each role is actually permitted to open via activateAppTab/quick actions).
// Profile is deliberately left out of all four lists: it now lives in the
// dedicated header icon (#headerProfileBtn) instead of taking a nav slot.
// Anything else a role can reach but that isn't one of its 5 nav tabs still
// works exactly as before — it's just reached via a quick-action tile
// (Dashboard for Owner, Staff Home for Staff, etc.) rather than the bar.
const OWNER_NAV_TABS = ['dashboard','orders','sales','income','products'];
const STAFF_NAV_TABS = ['staff-home','orders','my-salary','expenses','products'];
const DRIVER_NAV_TABS = ['driver-home','my-deliveries','my-earnings','my-reviews','products'];
const DISTRIBUTOR_NAV_TABS = ['distributor-home','my-income','orders','expenses','products'];

// ---- Skeleton loading — grey shimmer placeholders while a Home page's
// data is still being fetched, instead of showing "Rs. 0" / "—" for a
// beat before the real numbers arrive. showSkeletons(tabId) is called
// right before that tab's async load kicks off; each tab's own render
// function (renderDriverHome, refreshStaffHome, renderDistributorHome)
// calls hideSkeletons(tabId) once it has set the real text — a version
// counter guards against a slow older load clearing skeletons a newer,
// faster one already filled in.
const SKELETON_IDS_BY_TAB = {
  'driver-home': ['driverHomeActive', 'driverHomeDeliveredToday', 'driverHomeTodayPay', 'driverHomeRating'],
  'staff-home': ['staffHomeOrders', 'staffHomeCommission', 'staffHomeTasks', 'staffHomeHours'],
  'distributor-home': ['distHomeLevel', 'distHomeRate', 'distHomeSalesCount', 'distHomeCommission']
};
function showSkeletons(tabId) {
  const ids = SKELETON_IDS_BY_TAB[tabId];
  if (!ids) return;
  ids.forEach(id => { const el = $(id); if (el) el.classList.add('skel-on'); });
}
function hideSkeletons(tabId) {
  const ids = SKELETON_IDS_BY_TAB[tabId];
  if (!ids) return;
  ids.forEach(id => { const el = $(id); if (el) el.classList.remove('skel-on'); });
}
window.showSkeletons = showSkeletons;
window.hideSkeletons = hideSkeletons;

function applyRoleUI() {
  const isStaff = userRole === 'staff';
  const isDriver = userRole === 'driver';
  const isDistributor = userRole === 'distributor';
  const isRestricted = isStaff || isDriver || isDistributor; // anyone who isn't the owner

  // Owner-only controls: hidden for both staff and driver.
  document.querySelectorAll('[data-owner-only]').forEach(el => {
    el.style.display = isRestricted ? 'none' : '';
  });

  // Staff-only elements (nav tabs + inline blocks) — visible only for staff.
  document.querySelectorAll('[data-staff-only]').forEach(el => {
    const tab = el.getAttribute('data-tab');
    el.style.display = (isStaff && (!tab || STAFF_ALLOWED_TABS.includes(tab))) ? 'flex' : 'none';
  });

  // Driver-only elements (nav tabs + inline blocks) — visible only for drivers.
  document.querySelectorAll('[data-driver-only]').forEach(el => {
    const tab = el.getAttribute('data-tab');
    el.style.display = (isDriver && (!tab || DRIVER_ALLOWED_TABS.includes(tab))) ? 'flex' : 'none';
  });

  // Driver-only block-level cards (not nav buttons, so must not be forced to flex).
  document.querySelectorAll('[data-driver-only-card]').forEach(el => {
    el.style.display = isDriver ? '' : 'none';
  });

  // Distributor-only block-level cards (not nav buttons, so must not be forced to flex).
  document.querySelectorAll('[data-distributor-only-card]').forEach(el => {
    el.style.display = isDistributor ? '' : 'none';
  });

  // Distributor-only elements (nav tabs + inline blocks) — visible only for distributors.
  document.querySelectorAll('[data-distributor-only]').forEach(el => {
    const tab = el.getAttribute('data-tab');
    el.style.display = (isDistributor && (!tab || DISTRIBUTOR_ALLOWED_TABS.includes(tab))) ? 'flex' : 'none';
  });

  // Every nav tab button: lock down to exactly the 5 nav tabs each role
  // sees in the bar (Profile and everything else still work — they just
  // live behind the header profile icon / quick-action tiles instead).
  document.querySelectorAll('.tab-btn').forEach(el => {
    const tab = el.getAttribute('data-tab');
    if (isStaff) {
      el.style.display = STAFF_NAV_TABS.includes(tab) ? 'flex' : 'none';
    } else if (isDriver) {
      el.style.display = DRIVER_NAV_TABS.includes(tab) ? 'flex' : 'none';
    } else if (isDistributor) {
      el.style.display = DISTRIBUTOR_NAV_TABS.includes(tab) ? 'flex' : 'none';
    } else {
      el.style.display = OWNER_NAV_TABS.includes(tab) ? 'flex' : 'none';
    }
  });

  const navEl = document.querySelector('.app-nav');
  if (navEl) {
    navEl.classList.toggle('staff-nav', isStaff);
    navEl.classList.toggle('driver-nav', isDriver);
    navEl.classList.toggle('distributor-nav', isDistributor);
  }

  const roleBadge = $('roleBadge');
  if (roleBadge) {
    const icon = isDriver ? 'truck' : (isStaff ? 'user-round' : (isDistributor ? 'badge-percent' : 'crown'));
    const label = isDriver ? 'Driver' : (isStaff ? 'Staff' : (isDistributor ? 'Distributor' : 'Owner'));
    roleBadge.innerHTML = `<i class="business-icon icon-inline" data-lucide="${icon}" aria-hidden="true"></i> ${label}`;
  }

  // Profile tab: for staff/driver/distributor accounts, show the real name the
  // owner registered them under (userProfile.display_name) instead of the
  // generic email-derived name updateAuthUI() sets at login (before this
  // profile data has loaded). Distributors additionally get their Agent
  // Reference shown automatically here — no lookup or selection needed.
  if (currentUser) {
    const profileNameEl = $('profileName');
    if (profileNameEl) {
      const emailName = ((currentUser.email || 'Business Owner').split('@')[0].replace(/[._-]+/g, ' ').trim() || 'Business Owner').replace(/\b\w/g, c => c.toUpperCase());
      profileNameEl.textContent = (isRestricted && userProfile && userProfile.display_name) ? userProfile.display_name : emailName;
    }
    if (isDistributor) {
      const refId = (userProfile && userProfile.distributor_reference) || ('AGT-' + currentUser.id.slice(0,8).toUpperCase());
      if ($('profileDistRefIdValue')) $('profileDistRefIdValue').textContent = refId;
    }
  }
  if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } });

  const ownerSalaryTab = document.querySelector('[data-tab="staff-salary"]');
  if (ownerSalaryTab) ownerSalaryTab.style.display = isRestricted ? 'none' : '';

  const ownerSalaryEditor = $('salaryPanel');
  if (ownerSalaryEditor && isRestricted) ownerSalaryEditor.style.display = 'none';

  // Staff, drivers and distributors all land on their own dedicated overview
  // (Home) page first, separate from their operational list/detail pages.
  if (typeof activateAppTab === 'function') {
    if (isStaff) activateAppTab('staff-home');
    else if (isDriver) activateAppTab('driver-home');
    else if (isDistributor) activateAppTab('distributor-home');
  }
}

async function loadStaffList() {
  if (!currentUser || userRole !== 'owner') return;
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('owner_id', currentUser.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    renderStaffList(data || []); staffListCache = data || []; if (typeof renderOwnerStaffPerformance === 'function') renderOwnerStaffPerformance();
  } catch (e) {
    console.error('Load staff error:', e);
  }
}

function renderStaffList(list) {
  const tbody = $('staffBody');
  if (!tbody) return;
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;opacity:.5;padding:14px;">No staff added yet.</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(s => {
    const isDrv = s.role === 'driver';
    const isDist = s.role === 'distributor';
    const badge = isDrv
      ? '<span style="background:#eef;color:#334;padding:2px 7px;border-radius:6px;font-size:11px;font-weight:700;">🚚 Driver</span>'
      : (isDist ? '<span style="background:#fef3e0;color:#7a4d00;padding:2px 7px;border-radius:6px;font-size:11px;font-weight:700;">🏷️ Distributor</span>' : '');
    return `
    <tr>
      <td>${s.display_name || '(no name)'} ${badge}</td>
      <td style="font-size:11px;word-break:break-all;">${isDist ? (s.distributor_reference || ('AGT-' + String(s.id).slice(0,8).toUpperCase())) : s.id}</td>
      <td data-owner-only><button class="btn btn-sm btn-danger" aria-label="Remove" data-action="removeStaffMember" data-id="${s.id}"><i class="business-icon" data-lucide="trash-2" aria-hidden="true"></i></button></td>
    </tr>
  `;
  }).join('');
  // Only actual staff (not drivers/distributors) go into salary/commission pickers.
  populateSalaryStaffSelect(list.filter(s => s.role !== 'driver' && s.role !== 'distributor'));
  populateDriverSelects(list.filter(s => s.role === 'driver'));
  populateDistributorSelects(list.filter(s => s.role === 'distributor'));
  if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } });
}

let driverListCache = [];
function populateDriverSelects(drivers) {
  driverListCache = drivers || [];
  renderDelivery();
}

let distributorListCache = [];
function populateDistributorSelects(distributors) {
  distributorListCache = distributors || [];
  const sel = $('orderReferralDistributorSelect');
  if (sel) {
    // Owners who also do their own distribution/marketing couldn't attribute a
    // sale's commission to themselves, since this list only ever contained
    // accounts with role='distributor'. Pin a "Me (Owner)" option to the top
    // — same commission-tier logic applies, tracked under the owner's own id.
    const selfOption = (userRole === 'owner' && currentUser)
      ? (() => {
          const selfName = (userProfile && userProfile.display_name) || (currentUser.email ? currentUser.email.split('@')[0] : 'Me');
          const selfRef = (userProfile && userProfile.distributor_reference) || ('AGT-' + currentUser.id.slice(0,8).toUpperCase());
          return `<option value="${currentUser.id}">⭐ Me (${escapeHtmlSafe(selfName)}) — ${escapeHtmlSafe(selfRef)}</option>`;
        })()
      : '';
    sel.innerHTML = '<option value="">No distributor</option>' + selfOption + distributorListCache.map(d =>
      `<option value="${d.id}">${escapeHtmlSafe(d.display_name || 'Distributor')} — ${escapeHtmlSafe(d.distributor_reference || ('AGT-' + String(d.id).slice(0,8).toUpperCase()))}</option>`
    ).join('');
  }
  renderDistributorsPanel();
}

async function addStaffMember() {
  if (userRole !== 'owner') { alert('Only the business owner can add staff.'); return; }
  const uid = $('staffUid').value.trim();
  const name = $('staffName').value.trim();
  const roleSelect = $('staffRoleSelect');
  const roleVal = roleSelect ? roleSelect.value : 'staff';
  const role = roleVal === 'driver' ? 'driver' : (roleVal === 'distributor' ? 'distributor' : 'staff');
  if (!uid) { alert("Enter the team member's Supabase User ID."); return; }
  if (uid === currentUser.id) { alert('That is your own account.'); return; }

  if (!(await ensureFreshSession())) return;
  try {
    const { error } = await supabase.from('profiles').upsert({
      id: uid,
      role: role,
      owner_id: currentUser.id,
      display_name: name || null
    });
    if (error) throw error;
    alert(role === 'driver'
      ? '✅ Driver added. They can now log in and see their assigned deliveries.'
      : role === 'distributor'
      ? '✅ Product Distributor added. They can now log in and see their Product Agent commission dashboard.'
      : '✅ Staff member added. They can now log in and see your shared Orders, Customers & Expenses.');
    $('staffUid').value = '';
    $('staffName').value = '';
    await loadStaffList();
  } catch (e) {
    console.error('Add staff error:', e);
    alert('❌ Could not add: ' + e.message + '\n\nMake sure this User ID already exists in Supabase → Authentication → Users.');
  }
}

async function removeStaffMember(uid) {
  if (!confirm("Remove this staff member's access?")) return;
  if (!(await ensureFreshSession())) return;
  try {
    const { error } = await supabase.from('profiles').delete().eq('id', uid).eq('owner_id', currentUser.id);
    if (error) throw error;
    await loadStaffList();
  } catch (e) {
    console.error('Remove staff error:', e);
    // Drivers who have (or ever had) deliveries assigned to them can't be deleted
    // outright — the orders table's assigned_driver_id foreign key blocks it, since
    // that would either orphan those rows or silently erase "who delivered this"
    // history. Offer to clear the assignment on their orders first, then retry —
    // this keeps the orders themselves (and any delivered/COD/pay data on them)
    // intact, it just unlinks them from this driver's now-removed account.
    if (/orders_assigned_driver_id_fkey/i.test(e.message || '')) {
      const clear = confirm(
        "This person has delivery orders assigned to them, so they can't be removed yet.\n\n" +
        "Clear the driver assignment on those orders (the orders and their history stay — " +
        "only the link to this account is removed) and then remove them?"
      );
      if (!clear) return;
      try {
        const { error: clearErr } = await supabase.from('orders')
          .update({ assigned_driver_id: null })
          .eq('assigned_driver_id', uid);
        if (clearErr) throw clearErr;
        const { error: retryErr } = await supabase.from('profiles').delete().eq('id', uid).eq('owner_id', currentUser.id);
        if (retryErr) throw retryErr;
        await loadStaffList();
        renderDelivery();
        updateStatus('✅ Staff removed and their past orders unassigned');
      } catch (e2) {
        console.error('Remove staff (after clearing orders) error:', e2);
        alert('❌ Still could not remove staff: ' + e2.message);
      }
    } else {
      alert('❌ Could not remove staff: ' + e.message);
    }
  }
}

// ==================== STAFF SALARY (owner-only) ====================
let staffListCache = [];
let salaryEntries = [];
let salaryMode = 'daily';
let currentSalaryStaffId = '';
const SAL_TYPE_LABEL = { daily: '⚡ Daily', bonus: '➕ Bonus', advance: '💸 Advance', deduction: '➖ Deduction' };

function populateSalaryStaffSelect(list) {
  staffListCache = list || [];
  const sel = $('salaryStaffSelect');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">-- Select staff --</option>' +
    staffListCache.map(s => `<option value="${s.id}">${s.display_name || '(no name)'}</option>`).join('');
  if (prev && staffListCache.some(s => s.id === prev)) {
    sel.value = prev;
  } else {
    currentSalaryStaffId = '';
    if ($('salaryPanel')) $('salaryPanel').style.display = 'none';
  }
  const notice = $('salaryNoStaffNotice');
  if (notice) notice.style.display = staffListCache.length ? 'none' : '';
}

function setSalaryMode(mode) {
  salaryMode = mode;
  document.querySelectorAll('#salaryPanel .mode-toggle .btn').forEach(b => b.classList.toggle('active', b.dataset.smode === mode));
  if ($('salaryModeDaily')) $('salaryModeDaily').style.display = mode === 'daily' ? '' : 'none';
  if ($('salaryModeAdvanced')) $('salaryModeAdvanced').style.display = mode === 'advanced' ? '' : 'none';
}

let smartAttendanceRows = [];
let smartSalaryMonth = '';

function initSmartSalaryMonth(){
  const el = $('smartSalaryMonth');
  if (!el) return;
  if (!smartSalaryMonth) smartSalaryMonth = new Date().toISOString().slice(0,7);
  el.value = smartSalaryMonth;
}

function getSmartMonth(){
  const el = $('smartSalaryMonth');
  smartSalaryMonth = (el && el.value) || smartSalaryMonth || new Date().toISOString().slice(0,7);
  return smartSalaryMonth;
}

function getCommissionForStaffMonth(staffId, month){
  if(!staffId)return 0;
  // Commission is claim-based, never customer-master based. Staff do not load the customer list.
  const claims=(window.staffCommissionClaims||[]).filter(c=>{
    if(String(c.staff_id)!==String(staffId)) return false;
    if(c.status!=='approved') return false;
    const d=new Date(c.verified_at||c.submitted_at||0);
    if(Number.isNaN(d.getTime())) return false;
    return d.toISOString().slice(0,7)===month;
  });
  return claims.reduce((s,c)=>s+(Number(c.commission_amount)||0),0);
}

async function refreshSmartSalary(){
  if (!currentSalaryStaffId) return;
  const month = getSmartMonth();
  const staff = staffListCache.find(s => s.id === currentSalaryStaffId);
  const base = Number(staff && staff.base_salary) || 0;
  const dailyRate = Number(staff && staff.daily_rate) || 0;

  try {
    const start = month + '-01';
    const endDate = new Date(Number(month.slice(0,4)), Number(month.slice(5,7)), 0);
    const end = month + '-' + String(endDate.getDate()).padStart(2,'0');

    const { data: attendance, error: aErr } = await supabase
      .from('attendance')
      .select('*')
      .eq('staff_id', currentSalaryStaffId)
      .gte('work_date', start)
      .lte('work_date', end)
      .order('work_date', { ascending:false });
    if (aErr) throw aErr;
    smartAttendanceRows = attendance || [];

    const monthEntries = (salaryEntries || []).filter(s => (s.entry_date || '').slice(0,7) === month);
    const daily = monthEntries.filter(s => s.entry_type === 'daily').reduce((a,s)=>a+Number(s.amount||0),0);
    const bonus = monthEntries.filter(s => s.entry_type === 'bonus').reduce((a,s)=>a+Number(s.amount||0),0);
    const minus = monthEntries.filter(s => s.entry_type === 'advance' || s.entry_type === 'deduction').reduce((a,s)=>a+Number(s.amount||0),0);
    const paid = daily + bonus - minus;
    const days = smartAttendanceRows.filter(r => r.check_in).length;
    const hours = smartAttendanceRows.reduce((sum,r)=>{
      if (!r.check_in || !r.check_out) return sum;
      return sum + Math.max(0,(new Date(r.check_out)-new Date(r.check_in))/3600000);
    },0);
    const otHours = smartAttendanceRows.reduce((sum,r)=>{
      if (!r.check_in || !r.check_out) return sum;
      const h = Math.max(0,(new Date(r.check_out)-new Date(r.check_in))/3600000);
      return sum + Math.max(0,h-8);
    },0);
    const hourly = dailyRate > 0 ? dailyRate / 8 : 0;
    const otValue = otHours * hourly * 1.5;
    const target = base > 0 ? base : daily;
    const balance = Math.max(0, target + bonus + commission - minus - daily);

    const set=(id,val)=>{const el=$(id);if(el)el.textContent=val;};
    set('smartBaseTarget',fmt(target));
    set('smartPaid',fmt(paid));
    set('smartBalance',fmt(balance));
    set('smartDays',String(days));
    set('smartHours',hours.toFixed(1));
    set('smartOtHours',otHours.toFixed(1));
    set('smartBonus',fmt(bonus));
    set('smartMinus',fmt(minus));
    set('smartOtValue',fmt(otValue));

    const insight = $('smartSalaryInsight');
    if (insight) {
      if (!days) insight.textContent = '⚠️ No attendance records found for this month.';
      else if (otHours > 0 && dailyRate <= 0) insight.textContent = `💡 ${otHours.toFixed(1)} overtime hours detected. Set a daily rate to estimate OT value.`;
      else if (balance > 0) insight.textContent = `💡 Payroll balance: ${fmt(balance)}. Estimated OT is ${fmt(otValue)}.`;
      else insight.textContent = '✅ Payroll is fully covered for this month.';
    }
  } catch(e) {
    console.error('Smart payroll error:',e);
    const insight=$('smartSalaryInsight');
    if(insight) insight.textContent='⚠️ Could not load attendance/payroll insights.';
  }
}

async function addEstimatedOTToPayroll(){
  if (!currentSalaryStaffId) { alert('Select a staff member first.'); return; }
  const month = getSmartMonth();
  const staff = staffListCache.find(s => s.id === currentSalaryStaffId);
  const dailyRate = Number(staff && staff.daily_rate) || 0;
  const otHours = smartAttendanceRows.reduce((sum,r)=>{
    if (!r.check_in || !r.check_out) return sum;
    return sum + Math.max(0,((new Date(r.check_out)-new Date(r.check_in))/3600000)-8);
  },0);
  const value = otHours * (dailyRate/8) * 1.5;
  if (value <= 0) { alert(dailyRate > 0 ? 'No overtime value to add for this month.' : 'Set the staff daily rate first.'); return; }
  if (!confirm(`Add estimated OT of ${fmt(value)} as a bonus for ${month}?`)) return;
  const ok = await insertSalaryEntry({
    entry_date: month + '-' + new Date(Number(month.slice(0,4)), Number(month.slice(5,7)), 0).getDate().toString().padStart(2,'0'),
    amount: Math.round(value),
    entry_type: 'bonus',
    note: `Estimated OT — ${otHours.toFixed(1)} hrs × 1.5`
  });
  if (ok) await refreshSmartSalary();
}

function printSmartPayslip(){
  if (!currentSalaryStaffId) { alert('Select a staff member first.'); return; }
  const staff = staffListCache.find(s => s.id === currentSalaryStaffId);
  const month = getSmartMonth();
  const rows = (salaryEntries || []).filter(s => (s.entry_date||'').slice(0,7)===month);
  const daily = rows.filter(s=>s.entry_type==='daily').reduce((a,s)=>a+Number(s.amount||0),0);
  const bonus = rows.filter(s=>s.entry_type==='bonus').reduce((a,s)=>a+Number(s.amount||0),0);
  const minus = rows.filter(s=>s.entry_type==='advance'||s.entry_type==='deduction').reduce((a,s)=>a+Number(s.amount||0),0);
  const base = Number(staff && staff.base_salary)||0;
  const commission = getCommissionForStaffMonth(currentUser.id, month);
   const net = (base || daily) + bonus + commission - minus;
  const w = window.open('', '_blank', 'width=760,height=900');
  if(!w){alert('Please allow pop-ups to print the payslip.');return;}
  w.document.write(`<!doctype html><html><head><title>MY DRYBEA Payslip</title><style>
    body{font-family:Arial,sans-serif;padding:32px;color:#10231b}h1{margin:0;color:#059669}h2{margin:6px 0 24px}
    .box{border:1px solid #ddd;border-radius:12px;padding:18px;margin:14px 0}.row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eee}.total{font-size:20px;font-weight:800;color:#059669;border-top:2px solid #d4af37;border-bottom:0;margin-top:8px;padding-top:14px}
    small{color:#667} @media print{button{display:none}}
  </style></head><body><h1>MY DRYBEA</h1><h2>Staff Payslip — ${month}</h2>
  <div class="box"><strong>Staff:</strong> ${staff?.display_name||'Staff Member'}<br><small>Generated ${new Date().toLocaleString()}</small></div>
  <div class="box">
    <div class="row"><span>Base / Daily Payroll</span><strong>${fmt(base||daily)}</strong></div>
    <div class="row"><span>Bonus</span><strong>${fmt(bonus)}</strong></div>
    <div class="row"><span>Advance + Deductions</span><strong>-${fmt(minus)}</strong></div>
    <div class="row total"><span>Net Payable</span><strong>${fmt(net)}</strong></div>
  </div><button onclick="window.print()">Print</button></body></html>`);
  w.document.close(); w.focus(); setTimeout(()=>w.print(),250);
}

async function onSalaryStaffChange() {
  const staffId = $('salaryStaffSelect').value;
  currentSalaryStaffId = staffId;
  const panel = $('salaryPanel');
  if (!staffId) { if (panel) panel.style.display = 'none'; return; }
  if (panel) panel.style.display = '';
  $('salDailyDate').value = new Date().toISOString().slice(0, 10);
  $('salEntryDate').value = new Date().toISOString().slice(0, 10);
  initSmartSalaryMonth();

  const staff = staffListCache.find(s => s.id === staffId);
  $('salBaseMonthly').value = (staff && staff.base_salary) || 0;
  $('salDailyRate').value = (staff && staff.daily_rate) || 0;

  await loadSalaryHistory(staffId);
  await refreshSmartSalary();
}

async function saveSalarySettings() {
  if (!currentSalaryStaffId) { alert('Select a staff member first.'); return; }
  const base_salary = Number($('salBaseMonthly').value) || 0;
  const daily_rate = Number($('salDailyRate').value) || 0;
  if (!(await ensureFreshSession())) return;
  try {
    const { error } = await supabase.from('profiles').update({ base_salary, daily_rate }).eq('id', currentSalaryStaffId);
    if (error) throw error;
    const staff = staffListCache.find(s => s.id === currentSalaryStaffId);
    if (staff) { staff.base_salary = base_salary; staff.daily_rate = daily_rate; }
    updateStatus('✅ Salary settings saved');
  } catch (e) {
    console.error('Save salary settings error:', e);
    alert('❌ Could not save salary settings: ' + e.message);
  }
}

async function saveDailySalary() {
  if (!currentSalaryStaffId) { alert('Select a staff member first.'); return; }
  const date = $('salDailyDate').value || new Date().toISOString().slice(0, 10);
  const amount = Number($('salDailyAmount').value) || 0;
  const note = $('salDailyNote').value.trim();
  if (amount <= 0) { alert('Enter an amount greater than 0!'); return; }
  const ok = await insertSalaryEntry({ entry_date: date, amount, entry_type: 'daily', note });
  if (ok) { $('salDailyAmount').value = 0; $('salDailyNote').value = ''; }
}

async function addSalaryEntry() {
  if (!currentSalaryStaffId) { alert('Select a staff member first.'); return; }
  const type = $('salEntryType').value;
  const date = $('salEntryDate').value || new Date().toISOString().slice(0, 10);
  const amount = Number($('salEntryAmount').value) || 0;
  const note = $('salEntryNote').value.trim();
  if (amount <= 0) { alert('Enter an amount greater than 0!'); return; }
  const ok = await insertSalaryEntry({ entry_date: date, amount, entry_type: type, note });
  if (ok) { $('salEntryAmount').value = 0; $('salEntryNote').value = ''; }
}

async function insertSalaryEntry({ entry_date, amount, entry_type, note }) {
  if (!currentUser) { alert('Please login first.'); return false; }
  const staff = staffListCache.find(s => s.id === currentSalaryStaffId);
  const row = {
    owner_id: currentUser.id,
    staff_id: currentSalaryStaffId,
    staff_name: staff ? (staff.display_name || null) : null,
    entry_date,
    amount,
    entry_type,
    note: note || null,
    created_by: currentUser.id
  };
  if (!(await ensureFreshSession())) return;
  try {
    const { data, error } = await supabase.from('staff_salaries').insert(row).select().single();
    if (error) throw error;
    salaryEntries.unshift(data);
    renderSalaryHistory();
    await refreshSmartSalary();
    updateStatus('✅ Salary entry saved');
    return true;
  } catch (e) {
    console.error('Save salary entry error:', e);
    alert('❌ Could not save salary entry: ' + e.message);
    return false;
  }
}

async function loadSalaryHistory(staffId) {
  try {
    const { data, error } = await supabase
      .from('staff_salaries')
      .select('*')
      .eq('staff_id', staffId)
      .order('entry_date', { ascending: false });
    if (error) throw error;
    salaryEntries = data || [];
    renderSalaryHistory();
  } catch (e) {
    console.error('Load salary history error:', e);
    updateStatus('⚠️ Could not load salary history');
  }
}

async function editSalaryEntry(id) {
  const s = salaryEntries.find(x => String(x.id) === String(id));
  if (!s) { alert('Entry not found.'); return; }
  const newAmountStr = prompt('Amount (Rs.):', s.amount);
  if (newAmountStr === null) return;
  const newAmount = Number(newAmountStr);
  if (!newAmount || newAmount <= 0) { alert('Enter a valid amount greater than 0.'); return; }
  const newNoteStr = prompt('Note (optional):', s.note || '');
  if (newNoteStr === null) return;
  if (!(await ensureFreshSession())) return;
  try {
    const { data, error } = await supabase.from('staff_salaries')
      .update({ amount: newAmount, note: newNoteStr.trim() || null })
      .eq('id', id).select().single();
    if (error) throw error;
    const idx = salaryEntries.findIndex(x => String(x.id) === String(id));
    if (idx >= 0) salaryEntries[idx] = data;
    renderSalaryHistory();
    await refreshSmartSalary();
    updateStatus('✅ Salary entry updated');
  } catch (e) {
    console.error('Update salary entry error:', e);
    alert('❌ Could not update entry: ' + e.message);
  }
}
window.editSalaryEntry = editSalaryEntry;

async function deleteSalaryEntry(id) {
  if (!confirm('Delete this salary entry?')) return;
  if (!(await ensureFreshSession())) return;
  try {
    const { error } = await supabase.from('staff_salaries').delete().eq('id', id);
    if (error) throw error;
    salaryEntries = salaryEntries.filter(s => s.id !== id);
    renderSalaryHistory();
    await refreshSmartSalary();
    updateStatus('🗑️ Salary entry deleted');
  } catch (e) {
    console.error('Delete salary entry error:', e);
    alert('❌ Could not delete: ' + e.message);
  }
}

function renderSalaryHistory() {
  const tbody = $('salaryHistoryBody');
  if (!tbody) return;
  if (!salaryEntries.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;opacity:0.5;padding:14px;">No salary entries yet.</td></tr>';
  } else {
    tbody.innerHTML = salaryEntries.map(s => `
      <tr>
        <td>${s.entry_date}</td>
        <td>${SAL_TYPE_LABEL[s.entry_type] || s.entry_type}</td>
        <td>${fmt(s.amount)}</td>
        <td>${s.note || '-'}</td>
        <td>${actionMenuHTML([
          { label: 'Edit', icon: '✏️', onclick: `editSalaryEntry('${s.id}')` },
          { label: 'Delete', icon: '🗑️', danger: true, onclick: `deleteSalaryEntry('${s.id}')` }
        ])}</td>
      </tr>
    `).join('');
  }
  updateSalarySummary();
}

function updateSalarySummary() {
  const ym = new Date().toISOString().slice(0, 7);
  const thisMonth = salaryEntries.filter(s => (s.entry_date || '').slice(0, 7) === ym);
  const daily = thisMonth.filter(s => s.entry_type === 'daily').reduce((a, s) => a + Number(s.amount), 0);
  const bonus = thisMonth.filter(s => s.entry_type === 'bonus').reduce((a, s) => a + Number(s.amount), 0);
  const minus = thisMonth.filter(s => s.entry_type === 'advance' || s.entry_type === 'deduction').reduce((a, s) => a + Number(s.amount), 0);
  const net = daily + bonus - minus;
  if ($('salSumDaily')) $('salSumDaily').textContent = fmt(daily);
  if ($('salSumBonus')) $('salSumBonus').textContent = fmt(bonus);
  if ($('salSumMinus')) $('salSumMinus').textContent = fmt(minus);
  if ($('salSumNet')) $('salSumNet').textContent = fmt(net);
}

let isAuthModeLogin = true; // true=login, false=signup

// ==================== MY SALARY (staff-only, read-only view of own data) ====================
let myFullSalaryEntries = [];

let mySmartAttendanceRows = [];
let mySmartSalaryMonth = '';

function initMySmartSalaryMonth(){
  const el = $('mySmartSalaryMonth');
  if (!el) return;
  if (!mySmartSalaryMonth) mySmartSalaryMonth = new Date().toISOString().slice(0,7);
  el.value = mySmartSalaryMonth;
}

function getMySmartMonth(){
  const el = $('mySmartSalaryMonth');
  mySmartSalaryMonth = (el && el.value) || mySmartSalaryMonth || new Date().toISOString().slice(0,7);
  return mySmartSalaryMonth;
}

async function refreshMySmartSalary(){
  if (!currentUser || userRole !== 'staff') return;
  const month = getMySmartMonth();
  const base = Number((userProfile && userProfile.base_salary) || 0);
  const dailyRate = Number((userProfile && userProfile.daily_rate) || 0);

  try {
    const start = month + '-01';
    const endDate = new Date(Number(month.slice(0,4)), Number(month.slice(5,7)), 0);
    const end = month + '-' + String(endDate.getDate()).padStart(2,'0');

    const { data: attendance, error: aErr } = await supabase
      .from('attendance')
      .select('*')
      .eq('staff_id', currentUser.id)
      .gte('work_date', start)
      .lte('work_date', end)
      .order('work_date', { ascending:false });
    if (aErr) throw aErr;
    mySmartAttendanceRows = attendance || [];

    const rows = (myFullSalaryEntries || []).filter(s => (s.entry_date || '').slice(0,7) === month);
    const daily = rows.filter(s => s.entry_type === 'daily').reduce((a,s)=>a+Number(s.amount||0),0);
    const bonus = rows.filter(s => s.entry_type === 'bonus').reduce((a,s)=>a+Number(s.amount||0),0);
    const minus = rows.filter(s => s.entry_type === 'advance' || s.entry_type === 'deduction').reduce((a,s)=>a+Number(s.amount||0),0);
    const paid = daily + bonus - minus;

    const days = mySmartAttendanceRows.filter(r => r.check_in).length;
    const hours = mySmartAttendanceRows.reduce((sum,r)=>{
      if (!r.check_in || !r.check_out) return sum;
      return sum + Math.max(0,(new Date(r.check_out)-new Date(r.check_in))/3600000);
    },0);
    const otHours = mySmartAttendanceRows.reduce((sum,r)=>{
      if (!r.check_in || !r.check_out) return sum;
      const h = Math.max(0,(new Date(r.check_out)-new Date(r.check_in))/3600000);
      return sum + Math.max(0,h-8);
    },0);

    const hourly = dailyRate > 0 ? dailyRate / 8 : 0;
    const otValue = otHours * hourly * 1.5;
    const target = base > 0 ? base : daily;
    const balance = Math.max(0, target + bonus - minus - daily);

    const set=(id,val)=>{const el=$(id);if(el)el.textContent=val;};
    set('mySmartTarget',fmt(target));
    set('mySmartPaid',fmt(paid));
    set('mySmartBalance',fmt(balance));
    set('mySmartDays',String(days));
    set('mySmartHours',hours.toFixed(1));
    set('mySmartOtHours',otHours.toFixed(1));
    set('mySmartBonus',fmt(bonus));
    set('mySmartMinus',fmt(minus));
    set('mySmartOtValue',fmt(otValue));

    const insight = $('mySmartSalaryInsight');
    if (insight) {
      if (!days) insight.textContent = '⚠️ No attendance records found for this month.';
      else if (otHours > 0 && dailyRate <= 0) insight.textContent = `💡 ${otHours.toFixed(1)} overtime hours detected. OT value is not estimated because no daily rate is set.`;
      else if (balance > 0) insight.textContent = `💡 ${fmt(balance)} remains against the payroll target. Estimated OT: ${fmt(otValue)}.`;
      else insight.textContent = '✅ Your recorded payroll is fully covered for this month.';
    }
  } catch(e) {
    console.error('My smart payroll error:',e);
    const insight=$('mySmartSalaryInsight');
    if(insight) insight.textContent='⚠️ Could not load your attendance/payroll insights.';
  }
}

function printMySmartPayslip(){
  if (!currentUser || userRole !== 'staff') return;
  const month = getMySmartMonth();
  const rows = (myFullSalaryEntries || []).filter(s => (s.entry_date||'').slice(0,7)===month);
  const daily = rows.filter(s=>s.entry_type==='daily').reduce((a,s)=>a+Number(s.amount||0),0);
  const bonus = rows.filter(s=>s.entry_type==='bonus').reduce((a,s)=>a+Number(s.amount||0),0);
  const minus = rows.filter(s=>s.entry_type==='advance'||s.entry_type==='deduction').reduce((a,s)=>a+Number(s.amount||0),0);
  const base = Number((userProfile && userProfile.base_salary)||0);
  const net = (base || daily) + bonus - minus;
  const w = window.open('', '_blank', 'width=760,height=900');
  if(!w){alert('Please allow pop-ups to print your payslip.');return;}
  const staffName = (userProfile && userProfile.display_name) || currentUser.email || 'Staff Member';
  w.document.write(`<!doctype html><html><head><title>MY DRYBEA Payslip</title><style>
    body{font-family:Arial,sans-serif;padding:32px;color:#10231b}h1{margin:0;color:#059669}h2{margin:6px 0 24px}
    .box{border:1px solid #ddd;border-radius:12px;padding:18px;margin:14px 0}.row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eee}.total{font-size:20px;font-weight:800;color:#059669;border-top:2px solid #d4af37;border-bottom:0;margin-top:8px;padding-top:14px}
    small{color:#667} @media print{button{display:none}}
  </style></head><body><h1>MY DRYBEA</h1><h2>Staff Payslip — ${month}</h2>
  <div class="box"><strong>Staff:</strong> ${staffName}<br><small>Read-only payslip • Generated ${new Date().toLocaleString()}</small></div>
  <div class="box">
    <div class="row"><span>Base / Daily Payroll</span><strong>${fmt(base||daily)}</strong></div>
    <div class="row"><span>Bonus</span><strong>${fmt(bonus)}</strong></div>
    <div class="row"><span>Advance + Deductions</span><strong>-${fmt(minus)}</strong></div>
    <div class="row total"><span>Net Payable</span><strong>${fmt(net)}</strong></div>
  </div><button onclick="window.print()">Print</button></body></html>`);
  w.document.close(); w.focus(); setTimeout(()=>w.print(),250);
}

async function loadMySalary() {
  if (!currentUser) return;
  try {
    const { data, error } = await supabase
      .from('staff_salaries')
      .select('*')
      .eq('staff_id', currentUser.id)
      .order('entry_date', { ascending: false });
    if (error) throw error;
    myFullSalaryEntries = data || [];
    if ($('mySalBase')) $('mySalBase').textContent = fmt((userProfile && userProfile.base_salary) || 0);
    if ($('mySalDailyRate')) $('mySalDailyRate').textContent = fmt((userProfile && userProfile.daily_rate) || 0);
    initMySmartSalaryMonth();
    renderMySalary();
    await refreshMySmartSalary();
  } catch (e) {
    console.error('Load my salary error:', e);
    updateStatus('⚠️ Could not load salary');
  }
}

function renderMySalary() {
  const tbody = $('mySalaryHistoryBody');
  if (tbody) {
    tbody.innerHTML = myFullSalaryEntries.length ? myFullSalaryEntries.map(s => `
      <tr>
        <td>${s.entry_date}</td>
        <td>${SAL_TYPE_LABEL[s.entry_type] || s.entry_type}</td>
        <td>${fmt(s.amount)}</td>
        <td>${s.note || '-'}</td>
      </tr>
    `).join('') : '<tr><td colspan="4" style="text-align:center;opacity:.5;padding:14px;">No entries yet.</td></tr>';
  }
  const ym = new Date().toISOString().slice(0, 7);
  const thisMonth = myFullSalaryEntries.filter(s => (s.entry_date || '').slice(0, 7) === ym);
  const daily = thisMonth.filter(s => s.entry_type === 'daily').reduce((a, s) => a + Number(s.amount), 0);
  const bonus = thisMonth.filter(s => s.entry_type === 'bonus').reduce((a, s) => a + Number(s.amount), 0);
  const minus = thisMonth.filter(s => s.entry_type === 'advance' || s.entry_type === 'deduction').reduce((a, s) => a + Number(s.amount), 0);
  if ($('mySalSumDaily')) $('mySalSumDaily').textContent = fmt(daily);
  if ($('mySalSumBonus')) $('mySalSumBonus').textContent = fmt(bonus);
  if ($('mySalSumMinus')) $('mySalSumMinus').textContent = fmt(minus);
  if ($('mySalSumNet')) $('mySalSumNet').textContent = fmt(daily + bonus - minus);
}

// ==================== DAILY PAY (staff-only) ====================
function renderDailyPay() {
  const ym = new Date().toISOString().slice(0, 7);
  const dailyThisMonth = myFullSalaryEntries
    .filter(s => s.entry_type === 'daily' && (s.entry_date || '').slice(0, 7) === ym)
    .sort((a, b) => (a.entry_date < b.entry_date ? 1 : -1));
  const total = dailyThisMonth.reduce((a, s) => a + Number(s.amount), 0);
  if ($('dpDaysCount')) $('dpDaysCount').textContent = dailyThisMonth.length;
  if ($('dpMonthTotal')) $('dpMonthTotal').textContent = fmt(total);
  const tbody = $('dpListBody');
  if (tbody) {
    tbody.innerHTML = dailyThisMonth.length ? dailyThisMonth.map(s => `
      <tr><td>${s.entry_date}</td><td>${fmt(s.amount)}</td><td>${s.note || '-'}</td></tr>
    `).join('') : '<tr><td colspan="3" style="text-align:center;opacity:.5;padding:14px;">No daily pay logged this month yet.</td></tr>';
  }
}

// ==================== MY WORK UPDATE (staff-only) ====================
function todayStr() { return new Date().toISOString().slice(0, 10); }

function updateWorkUpdateStats() {
  const today = todayStr();
  const ym = today.slice(0, 7);
  const mine = orders.filter(o => o.createdBy === currentUser.id);
  const todayCount = mine.filter(o => (o.createdAt || '').slice(0, 10) === today).length;
  const monthCount = mine.filter(o => (o.createdAt || '').slice(0, 7) === ym).length;
  if ($('wuOrdersToday')) $('wuOrdersToday').textContent = todayCount;
  if ($('wuOrdersMonth')) $('wuOrdersMonth').textContent = monthCount;
}

async function saveWorkNote() {
  if (!currentUser) { alert('Please login first.'); return; }
  const note = $('wuNoteText').value.trim();
  if (!note) { alert('Write something first!'); return; }
  if (!(await ensureFreshSession())) return;
  try {
    const { error } = await supabase.from('attendance').upsert({
      owner_id: businessId,
      staff_id: currentUser.id,
      staff_name: (userProfile && userProfile.display_name) || null,
      work_date: todayStr(),
      work_note: note
    }, { onConflict: 'staff_id,work_date' });
    if (error) throw error;
    updateStatus('✅ Work update saved');
    $('wuNoteText').value = '';
    await loadWorkUpdateHistory();
  } catch (e) {
    console.error('Save work note error:', e);
    alert('❌ Could not save work update: ' + e.message);
  }
}

async function loadWorkUpdateHistory() {
  if (!currentUser) return;
  try {
    const { data, error } = await supabase
      .from('attendance')
      .select('*')
      .eq('staff_id', currentUser.id)
      .order('work_date', { ascending: false })
      .limit(30);
    if (error) throw error;
    const tbody = $('wuHistoryBody');
    if (!tbody) return;
    const rows = (data || []).filter(r => r.work_note);
    tbody.innerHTML = rows.length ? rows.map(r => {
      const dayOrders = orders.filter(o => o.createdBy === currentUser.id && (o.createdAt || '').slice(0, 10) === r.work_date).length;
      return `<tr><td>${r.work_date}</td><td>${dayOrders}</td><td>${r.work_note}</td></tr>`;
    }).join('') : '<tr><td colspan="3" style="text-align:center;opacity:.5;padding:14px;">No updates yet.</td></tr>';
  } catch (e) {
    console.error('Load work update history error:', e);
  }
}

// ==================== ATTENDANCE (staff-only) ====================
let todayAttendanceRow = null;
let attendanceBusy = false;      // guards against double-tap firing two requests
let attendanceTickTimer = null;  // live "time so far" ticker while a day is in progress

// Wrap any Supabase call so a flaky connection can never leave the UI stuck forever.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error((label || 'This') + ' is taking too long. Check your connection and try again.')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// "5m" / "2h" / "2h 15m" instead of a misleading "0.0 hrs" on short days.
function formatDuration(ms) {
  if (!ms || ms < 0) return '-';
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h <= 0) return m + 'm';
  if (m === 0) return h + 'h';
  return h + 'h ' + m + 'm';
}

// Manual ON/OFF time helpers — staff can pick a time other than "right now"
// (e.g. logging a check-in they forgot to tap earlier) or correct a saved one.
function nowHHMM() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function isoToHHMM(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
// Builds today's date (local) at the chosen HH:MM, then returns it as an ISO
// timestamp — same storage format startDay/endDay already used for "now".
function timeInputToISO(timeStr) {
  const d = new Date();
  if (timeStr) {
    const [hh, mm] = timeStr.split(':').map(Number);
    if (!Number.isNaN(hh) && !Number.isNaN(mm)) d.setHours(hh, mm, 0, 0);
  }
  return d.toISOString();
}

// Button visual states: 'active' (tappable), 'loading' (mid-request), 'done'
// (already completed — check icon, muted), 'locked' (not available yet — muted).
// 'done'/'locked' use dedicated CSS classes (see <style>) so they always look
// visually disabled, regardless of the button's own themed colors.
function setAttendBtnState(btn, mode, icon, label) {
  if (!btn) return;
  btn.classList.remove('attend-btn-done', 'attend-btn-locked');
  if (mode === 'loading') {
    btn.disabled = true;
    btn.innerHTML = '<span class="mini-spin" aria-hidden="true"></span>' + label;
    return;
  }
  if (mode === 'done') {
    btn.disabled = true;
    btn.classList.add('attend-btn-done');
    btn.innerHTML = '<i class="business-icon icon-inline" data-lucide="check" aria-hidden="true"></i> ' + label;
  } else if (mode === 'locked') {
    btn.disabled = true;
    btn.classList.add('attend-btn-locked');
    btn.innerHTML = '<i class="business-icon icon-inline" data-lucide="' + icon + '" aria-hidden="true"></i> ' + label;
  } else {
    btn.disabled = false;
    btn.innerHTML = '<i class="business-icon icon-inline" data-lucide="' + icon + '" aria-hidden="true"></i> ' + label;
  }
  if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } });
}

function stopAttendanceTicker() {
  if (attendanceTickTimer) { clearInterval(attendanceTickTimer); attendanceTickTimer = null; }
}

async function loadTodayAttendance() {
  if (!currentUser) return;
  try {
    const { data, error } = await withTimeout(
      supabase.from('attendance').select('*').eq('staff_id', currentUser.id).eq('work_date', todayStr()).maybeSingle(),
      12000, "Loading today's status"
    );
    if (error) throw error;
    todayAttendanceRow = data || null;
    renderTodayAttendanceStatus();
  } catch (e) {
    console.error('Load today attendance error:', e);
    const box = $('attendTodayStatus');
    if (box) { box.textContent = "⚠️ Couldn't load today's status — pull to refresh or tap the tab again."; box.className = 'notice warn'; }
  }
}

function renderTodayAttendanceStatus() {
  const box = $('attendTodayStatus');
  const startBtn = $('attendStartBtn');
  const endBtn = $('attendEndBtn');
  const startTimeInput = $('attendStartTime');
  const endTimeInput = $('attendEndTime');
  const startTimeSave = $('attendStartTimeSave');
  const endTimeSave = $('attendEndTimeSave');
  if (!box) return;
  stopAttendanceTicker();
  if (attendanceBusy) return; // an action is mid-flight; its own code owns the UI right now

  if (!todayAttendanceRow || !todayAttendanceRow.check_in) {
    box.textContent = "You haven't started today yet.";
    box.className = 'notice warn';
    setAttendBtnState(startBtn, 'active', 'play', 'Start Day');
    setAttendBtnState(endBtn, 'locked', 'square', 'End Day');
    if (startTimeInput && !startTimeInput.value) startTimeInput.value = nowHHMM();
    if (endTimeInput && !endTimeInput.value) endTimeInput.value = nowHHMM();
    if (startTimeSave) startTimeSave.disabled = true;
    if (endTimeSave) endTimeSave.disabled = true;
  } else if (!todayAttendanceRow.check_out) {
    const inTime = new Date(todayAttendanceRow.check_in);
    const tick = () => { box.textContent = '🟢 Checked in at ' + inTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' — ' + formatDuration(Date.now() - inTime.getTime()) + ' so far.'; };
    tick();
    attendanceTickTimer = setInterval(tick, 30000);
    box.className = 'notice';
    setAttendBtnState(startBtn, 'done', 'play', 'Started');
    setAttendBtnState(endBtn, 'active', 'square', 'End Day');
    if (startTimeInput) startTimeInput.value = isoToHHMM(todayAttendanceRow.check_in);
    if (endTimeInput && !endTimeInput.value) endTimeInput.value = nowHHMM();
    if (startTimeSave) startTimeSave.disabled = false;
    if (endTimeSave) endTimeSave.disabled = true;
  } else {
    const hrs = formatDuration(new Date(todayAttendanceRow.check_out) - new Date(todayAttendanceRow.check_in));
    box.textContent = '✅ Day complete — ' + new Date(todayAttendanceRow.check_in).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' to ' + new Date(todayAttendanceRow.check_out).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' (' + hrs + ').';
    box.className = 'notice';
    setAttendBtnState(startBtn, 'done', 'play', 'Started');
    setAttendBtnState(endBtn, 'done', 'square', 'Ended');
    if (startTimeInput) startTimeInput.value = isoToHHMM(todayAttendanceRow.check_in);
    if (endTimeInput) endTimeInput.value = isoToHHMM(todayAttendanceRow.check_out);
    if (startTimeSave) startTimeSave.disabled = false;
    if (endTimeSave) endTimeSave.disabled = false;
  }

  // Reflect any correction request(s) awaiting the owner's decision, and block
  // filing a duplicate request for the same field while one is still pending.
  const pending = myPendingCorrections.filter(c => c.status === 'pending');
  const note = $('attendCorrectionNote');
  if (note) {
    if (pending.length) {
      note.style.display = 'block';
      note.textContent = '🚩 ' + pending.length + ' correction request' + (pending.length > 1 ? 's' : '') + ' awaiting your owner\'s approval.';
    } else {
      note.style.display = 'none';
    }
  }
  if (startTimeSave && pending.some(c => c.field === 'check_in')) startTimeSave.disabled = true;
  if (endTimeSave && pending.some(c => c.field === 'check_out')) endTimeSave.disabled = true;
}

async function startDay() {
  if (!currentUser) { alert('Please login first.'); return; }
  if (attendanceBusy) return; // ignore extra taps while one is already in flight
  attendanceBusy = true;
  stopAttendanceTicker();
  const startBtn = $('attendStartBtn'), endBtn = $('attendEndBtn'), box = $('attendTodayStatus');
  // ANTI-CHEAT: ON time is NOT taken from the time input or the device clock —
  // it is stamped by the database server (see attendance_clock_in() in the
  // Supabase migration) the instant this request lands, so a staff member can't
  // fake an earlier/later start by editing the time picker or their phone's clock.
  setAttendBtnState(startBtn, 'loading', 'play', 'Starting…');
  setAttendBtnState(endBtn, 'locked', 'square', 'End Day');
  if (box) { box.textContent = '⏳ Starting your day…'; box.className = 'notice'; }
  if (!(await ensureFreshSession())) return;
  try {
    const { data, error } = await withTimeout(
      supabase.rpc('attendance_clock_in', {
        p_owner_id: businessId,
        p_staff_name: (userProfile && userProfile.display_name) || null
      }),
      15000, 'Starting your day'
    );
    if (error) throw error;
    todayAttendanceRow = data;
    updateStatus('✅ Day started');
    loadAttendanceLog();
    loadMyPendingCorrections();
    notifyOwnerAttendance('in', data.check_in);
  } catch (e) {
    console.error('Start day error:', e);
    alert('❌ Could not start day: ' + e.message + '\nTap Start Day to try again.');
  } finally {
    attendanceBusy = false;
    renderTodayAttendanceStatus();
  }
}

async function endDay() {
  if (!currentUser) return;
  if (attendanceBusy) return;
  attendanceBusy = true;
  stopAttendanceTicker();
  const startBtn = $('attendStartBtn'), endBtn = $('attendEndBtn'), box = $('attendTodayStatus');
  setAttendBtnState(startBtn, 'done', 'play', 'Started');
  setAttendBtnState(endBtn, 'loading', 'square', 'Ending…');
  if (box) { box.textContent = '⏳ Ending your day…'; box.className = 'notice'; }
  if (!(await ensureFreshSession())) return;
  try {
    // ANTI-CHEAT: OFF time is stamped server-side too (attendance_clock_out()),
    // same reasoning as startDay() — the server clock can never be behind or
    // ahead of the real check-in, so a "2 minute shift" like the one in the
    // screenshot simply can't be logged as a fake full day any more.
    const { data, error } = await withTimeout(
      supabase.rpc('attendance_clock_out'),
      15000, 'Ending your day'
    );
    if (error) throw error;
    todayAttendanceRow = data;
    updateStatus('✅ Day ended');
    loadAttendanceLog();
    loadMyPendingCorrections();
    notifyOwnerAttendance('out', data.check_out);
  } catch (e) {
    console.error('End day error:', e);
    alert('❌ Could not end day: ' + e.message + '\nTap End Day to try again.');
  } finally {
    attendanceBusy = false;
    renderTodayAttendanceStatus();
  }
}

// ANTI-CHEAT: staff can no longer edit a logged ON/OFF time directly — that
// was exactly the hole that let anyone rewrite their own hours. Instead this
// files a request; only the owner's decideAttendanceCorrection() (via the
// decide_attendance_correction() RPC, which checks auth.uid() = owner_id
// server-side) can actually change a stored time. which: 'in' | 'out'.
let myPendingCorrections = [];

async function requestAttendanceCorrection(which) {
  if (!currentUser || !todayAttendanceRow) return;
  if (attendanceBusy) return;
  const field = which === 'in' ? 'check_in' : 'check_out';
  if (myPendingCorrections.some(c => c.field === field && c.status === 'pending')) {
    alert('You already have a pending correction request for this time — wait for your owner to review it first.');
    return;
  }
  const input = which === 'in' ? $('attendStartTime') : $('attendEndTime');
  const saveBtn = which === 'in' ? $('attendStartTimeSave') : $('attendEndTimeSave');
  const timeVal = input?.value;
  if (!timeVal) { alert('Pick the correct time first.'); return; }
  const reason = prompt('Why does this time need correcting? (your owner will see this)');
  if (reason === null) return; // cancelled
  if (!reason.trim()) { alert('Please add a short reason.'); return; }
  const iso = timeInputToISO(timeVal);
  attendanceBusy = true;
  const originalHtml = saveBtn ? saveBtn.innerHTML : '';
  if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<span class="mini-spin" aria-hidden="true"></span>'; }
  if (!(await ensureFreshSession())) return;
  try {
    const { error } = await withTimeout(
      supabase.rpc('request_attendance_correction', {
        p_field: field,
        p_requested_time: iso,
        p_reason: reason.trim()
      }),
      12000, 'Sending correction request'
    );
    if (error) throw error;
    updateStatus('📨 Correction request sent to owner');
    await loadMyPendingCorrections();
  } catch (e) {
    console.error('Request attendance correction error:', e);
    alert('❌ Could not send correction request: ' + e.message);
  } finally {
    attendanceBusy = false;
    if (saveBtn) saveBtn.innerHTML = originalHtml;
    renderTodayAttendanceStatus();
  }
}

async function loadMyPendingCorrections() {
  if (!currentUser) return;
  try {
    const { data, error } = await supabase.from('attendance_corrections').select('*')
      .eq('staff_id', currentUser.id).eq('work_date', todayStr()).order('requested_at', { ascending: false });
    if (error) throw error;
    myPendingCorrections = data || [];
  } catch (e) {
    console.error('Load my corrections error:', e);
  } finally {
    renderTodayAttendanceStatus();
  }
}

async function loadAttendanceLog() {
  if (!currentUser) return;
  const tbody = $('attendLogBody');
  try {
    const ym = todayStr().slice(0, 7);
    const { data, error } = await withTimeout(
      supabase.from('attendance').select('*').eq('staff_id', currentUser.id).gte('work_date', ym + '-01').order('work_date', { ascending: false }),
      12000, "Loading this month's log"
    );
    if (error) throw error;
    if (!tbody) return;
    tbody.innerHTML = (data && data.length) ? data.map(r => {
      const hrs = (r.check_in && r.check_out) ? formatDuration(new Date(r.check_out) - new Date(r.check_in)) : '-';
      const inT = r.check_in ? new Date(r.check_in).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-';
      const outT = r.check_out ? new Date(r.check_out).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-';
      return `<tr><td>${r.work_date}</td><td>${inT}</td><td>${outT}</td><td>${hrs}</td></tr>`;
    }).join('') : '<tr><td colspan="4" style="text-align:center;opacity:.5;padding:14px;">No attendance logged this month yet.</td></tr>';
  } catch (e) {
    console.error('Load attendance log error:', e);
    if (tbody) tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;opacity:.5;padding:14px;">Couldn\'t load this month\'s log — try again.</td></tr>';
  }
}

// Best-effort WhatsApp ping to the owner when a staff member starts/ends their day.
// Mirrors notifyOwnerWhatsApp() used for advance requests: never blocks or fails the
// attendance save above, which has already completed by the time this runs.
//
// FALLBACK NUMBER: if the owner hasn't saved a number yet on the "Business WhatsApp
// Number" screen (Profile tab), we still notify this number so nothing gets missed.
// Once the owner saves their own number there, THEIR saved number is always used
// instead — this constant only covers the "nothing saved yet" case.
const DEFAULT_OWNER_WHATSAPP = '94762432963';

async function notifyOwnerAttendance(action, whenIso) {
  try {
    if (!businessId) return;
    const { data, error } = await supabase.from('profiles').select('whatsapp_number').eq('id', businessId).maybeSingle();
    if (error) throw error;
    const rawNumber = (data && data.whatsapp_number) ? data.whatsapp_number : DEFAULT_OWNER_WHATSAPP;
    const staffName = (userProfile && userProfile.display_name) || 'A staff member';
    const timeStr = new Date(whenIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const verb = action === 'in' ? 'started' : 'ended';
    const emoji = action === 'in' ? '🟢' : '🔴';
    const msg = `${emoji} Attendance\n${staffName} ${verb} work at ${timeStr}\nDate: ${todayStr()}`;
    const digits = String(rawNumber).replace(/[^0-9]/g, '');
    const waLink = 'https://wa.me/' + digits + '?text=' + encodeURIComponent(msg);
    // Wrapped in try/catch: some mobile in-app browsers throw instead of
    // returning null when a popup is blocked. The fallback button below
    // always covers that case.
    try { window.open(waLink, '_blank'); } catch (_e) { /* ignored */ }
    showAttendWaFallback(waLink, action);
  } catch (e) {
    console.error('Attendance WhatsApp notify error:', e);
  }
}

function showAttendWaFallback(waLink, action) {
  const holder = $('attendTodayStatus')?.closest('.card');
  if (!holder) return;
  document.getElementById('attendWaFallbackLink')?.remove();
  const link = document.createElement('a');
  link.href = waLink; link.target = '_blank'; link.rel = 'noopener';
  link.className = 'btn btn-sm'; link.style.marginTop = '10px'; link.style.display = 'inline-flex'; link.id = 'attendWaFallbackLink';
  link.innerHTML = '📲 Tap to notify owner you ' + (action === 'in' ? 'started' : 'ended') + ' your day';
  holder.appendChild(link);
}

// ==================== ADVANCE REQUESTS ====================
async function submitAdvanceRequest() {
  if (!currentUser) { alert('Please login first.'); return; }
  const amount = Number($('advAmount').value) || 0;
  const reason = $('advReason').value.trim();
  if (amount <= 0) { alert('Enter an amount greater than 0!'); return; }
  const btn = document.querySelector('button[data-action="submitAdvanceRequest"]');
  if (btn) { btn.disabled = true; btn.dataset.originalText = btn.textContent; btn.textContent = 'Sending…'; }
  if (!(await ensureFreshSession())) return;
  try {
    // Saving the request is the priority — nothing here should ever be able
    // to silently kill this before the insert happens (see notifyOwnerWhatsApp
    // for why the WhatsApp step is fully separate and non-blocking).
    const { error } = await supabase.from('advance_requests').insert({
      owner_id: businessId,
      staff_id: currentUser.id,
      staff_name: (userProfile && userProfile.display_name) || null,
      amount, reason: reason || null, status: 'pending',
      requested_at: new Date().toISOString()
    });
    if (error) throw error;
    $('advAmount').value = 0;
    $('advReason').value = '';
    updateStatus('✅ Advance request sent');
    await loadMyAdvanceRequests();
    await notifyOwnerWhatsApp(amount, reason);
  } catch (e) {
    console.error('Advance request error:', e);
    alert('❌ Could not send request: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = btn.dataset.originalText || 'Request & Notify Owner'; }
  }
}

async function notifyOwnerWhatsApp(amount, reason) {
  try {
    const { data, error } = await supabase.from('profiles').select('whatsapp_number,display_name').eq('id', businessId).maybeSingle();
    if (error) throw error;
    const rawNumber = (data && data.whatsapp_number) ? data.whatsapp_number : DEFAULT_OWNER_WHATSAPP;
    const staffName = (userProfile && userProfile.display_name) || 'A staff member';
    const msg = `💸 Advance Request\nFrom: ${staffName}\nAmount: Rs. ${amount}\nReason: ${reason || '-'}\n\nPlease open the app to approve or reject.`;
    const digits = String(rawNumber).replace(/[^0-9]/g, '');
    const waLink = 'https://wa.me/' + digits + '?text=' + encodeURIComponent(msg);
    // Best-effort auto-open. Wrapped in try/catch because some mobile
    // in-app browsers (WhatsApp/Instagram/FB webviews) throw instead of
    // just returning null when popups are blocked — a throw here must
    // NEVER be able to affect the request that was already saved above.
    try { window.open(waLink, '_blank'); } catch (_e) { /* ignored, fallback button below always shown */ }
    showAdvanceWaFallback(waLink);
  } catch (e) {
    console.error('WhatsApp notify error:', e);
    updateStatus('⚠️ Request saved, but the WhatsApp message could not be prepared.');
  }
}

function showAdvanceWaFallback(waLink) {
  const holder = $('advReason')?.closest('.card');
  if (!holder) return;
  document.getElementById('advWaFallbackLink')?.remove();
  const link = document.createElement('a');
  link.href = waLink; link.target = '_blank'; link.rel = 'noopener';
  link.className = 'btn btn-primary'; link.style.marginTop = '10px'; link.id = 'advWaFallbackLink';
  link.innerHTML = '📲 Tap to notify owner on WhatsApp';
  holder.appendChild(link);
}

async function loadMyAdvanceRequests() {
  if (!currentUser) return;
  try {
    const { data, error } = await supabase
      .from('advance_requests')
      .select('*')
      .eq('staff_id', currentUser.id)
      .order('requested_at', { ascending: false });
    if (error) throw error;
    const tbody = $('advMyHistoryBody');
    if (!tbody) return;
    tbody.innerHTML = (data && data.length) ? data.map(r => `
      <tr>
        <td>${(r.requested_at || '').slice(0, 10)}</td>
        <td>${fmt(r.amount)}</td>
        <td>${r.reason || '-'}</td>
        <td><span class="status-pill ${r.status}">${r.status}</span></td>
      </tr>
    `).join('') : '<tr><td colspan="4" style="text-align:center;opacity:.5;padding:14px;">No requests yet.</td></tr>';
  } catch (e) {
    console.error('Load my advance requests error:', e);
  }
}

// ==================== OWNER: ADVANCE APPROVALS + WHATSAPP NUMBER ====================
async function saveOwnerWhatsapp() {
  if (!currentUser || userRole !== 'owner') return;
  const num = $('ownerWhatsapp').value.trim();
  if (!(await ensureFreshSession())) return;
  try {
    const { error } = await supabase.from('profiles').update({ whatsapp_number: num || null }).eq('id', currentUser.id);
    if (error) throw error;
    updateStatus('✅ WhatsApp number saved');
  } catch (e) {
    console.error('Save owner whatsapp error:', e);
    alert('❌ Could not save number: ' + e.message);
  }
}

async function saveDriverWhatsapp() {
  if (!currentUser || userRole !== 'driver') return;
  const num = $('driverWhatsapp').value.trim();
  if (!(await ensureFreshSession())) return;
  try {
    const { error } = await supabase.from('profiles').update({ whatsapp_number: num || null }).eq('id', currentUser.id);
    if (error) throw error;
    if (driverListCache && driverListCache.length) {
      const me = driverListCache.find(d => String(d.id) === String(currentUser.id));
      if (me) me.whatsapp_number = num || null;
    }
    updateStatus('✅ WhatsApp number saved — the owner can now reach you here');
  } catch (e) {
    console.error('Save driver whatsapp error:', e);
    alert('❌ Could not save number: ' + e.message);
  }
}
window.saveDriverWhatsapp = saveDriverWhatsapp;

async function loadOwnerAdvanceRequests() {
  if (!currentUser || userRole !== 'owner') return;
  if (document.hidden) return; // skip background work while the app tab isn't visible
  if (!advanceRealtimeChannel) startAdvanceRealtime();
  try {
    const { data, error } = await supabase
      .from('advance_requests')
      .select('*')
      .eq('owner_id', currentUser.id)
      .order('requested_at', { ascending: false });
    if (error) throw error;
    renderOwnerAdvanceRequests(data || []);
  } catch (e) {
    console.error('Load owner advance requests error:', e);
  }
}

function renderOwnerAdvanceRequests(list) {
  const tbody = $('advOwnerBody');
  if (tbody) {
    tbody.innerHTML = list.length ? list.map(r => `
      <tr>
        <td>${r.staff_name || '(no name)'}</td>
        <td>${(r.requested_at || '').slice(0, 10)}</td>
        <td>${fmt(r.amount)}</td>
        <td>${r.reason || '-'}</td>
        <td><span class="status-pill ${r.status}">${r.status}</span></td>
        <td>${r.status === 'pending' ? `
          <button class="btn btn-sm btn-primary" data-action="decideAdvance" data-id="${r.id}" data-args='["approved"]'>✅</button>
          <button class="btn btn-sm btn-danger" data-action="decideAdvance" data-id="${r.id}" data-args='["rejected"]'>❌</button>
        ` : '-'}</td>
      </tr>
    `).join('') : '<tr><td colspan="6" style="text-align:center;opacity:.5;padding:14px;">No advance requests yet.</td></tr>';
  }
  // Mirror the same rows into the MY STAFF tab's table so both places
  // always agree, regardless of which tab was opened first.
  const tbody2 = $('ownerStaffAdvanceBody');
  if (tbody2 && tbody) tbody2.innerHTML = tbody.innerHTML;
  const pending = list.filter(r => r.status === 'pending').length;
  updateAdvancePendingBadge(pending);
}

function updateAdvancePendingBadge(pending) {
  const mini = $('ownerPendingAdvances');
  if (mini) mini.textContent = pending;
  const badge = $('myStaffAdvanceBadge');
  if (badge) {
    if (pending > 0) { badge.textContent = pending > 99 ? '99+' : String(pending); badge.style.display = 'inline-block'; }
    else { badge.style.display = 'none'; }
  }
}

async function decideAdvance(id, status) {
  if (!currentUser) return;
  if (!(await ensureFreshSession())) return;
  try {
    const { error } = await supabase.from('advance_requests').update({
      status, decided_at: new Date().toISOString(), decided_by: currentUser.id
    }).eq('id', id).eq('owner_id', currentUser.id);
    if (error) throw error;
    updateStatus(status === 'approved' ? '✅ Advance approved' : '❌ Advance rejected');
    await loadOwnerAdvanceRequests();
  } catch (e) {
    console.error('Decide advance error:', e);
    alert('❌ Could not update request: ' + e.message);
  }
}



// ==================== STATE ====================
let state = {
  theme: 'dark',
  linnaPrice: 1750,
  balayaPrice: 2200,
  kawalamPrice: 1000,
  packSize: '100',
  mixRatio: '40/0/60',
  customLinna: 40,
  customBalaya: 20,
  customKawalam: 40,
  mode: 'mrp',
  targetProfit: 30,
  customSp: 350,
  monthlyQty: 500,
  // Grinding yield % per fish type — % of Umbalakada that survives grinding
  // into usable flakes for packing; the remainder is lost as dust. See
  // getGrindYields() and calculatePack()'s dust math.
  linnaGrindYield: 80,
  balayaGrindYield: 90,
  premiumGrindYield: 65,
  dashQty: {50:1000, 100:500, 500:50, 1000:50},
  dashSp: {50:170, 100:350, 500:1750, 1000:3500},
  // Editable per-pack MRP & Wholesale prices, shown/edited in the Dynamic
  // Pricing Suggestions table. Defaults match the original hard-coded
  // PACKS[key].mrp constants so nothing changes until the owner edits them.
  // getPackPrice() below is the single place that reads these (with a
  // fallback to PACKS[key].mrp for safety), so any future call site can
  // switch to editable pricing just by going through that helper.
  packPrices: {
    50:   { mrp: 170,  wholesale: 170 },
    100:  { mrp: 350,  wholesale: 350 },
    500:  { mrp: 1750, wholesale: 1750 },
    1000: { mrp: 3500, wholesale: 3500 }
  },
  // Which of the two prices above the Dynamic Pricing Suggestions table is
  // currently calculating against — toggled by the owner via #dpPriceBasis.
  dpPriceBasis: 'mrp',
  // Pack size (g) -> catalog product id (Products tab), set via "Link Packs
  // to Store Products" on the Daily Costing & Trends sub-tab. Once set,
  // logging (or deleting) a Daily Product Batch automatically moves that
  // product's Stock via applyStockMovement() — see addDailyProductBatch().
  packProductMap: { 50: '', 100: '', 500: '', 1000: '' },
  overhead: {...DEFAULT_FIXED},
  // Umbalakada varieties tracked in the Production tab's Daily Production
  // Log. The 3 core types stay wired to linnaPrice/balayaPrice/kawalamPrice
  // above (everything else in the app — Quick Profit Calculator, quotes,
  // PDFs, pack pricing — is still built around those three), so their
  // price lives there, not here. Extra varieties the owner adds get their
  // own `price` field on the entry itself. See ensureUmbalakadaTypes().
  umbalakadaTypes: [
    { id: 'linna', name: 'Linna', core: true },
    { id: 'balaya', name: 'Balaya', core: true },
    { id: 'kawalam', name: 'Premium Mix', core: true }
  ],
  production: {
    rawLinna: 180, rawBalaya: 250, rawKawalam: 60,
    yieldLinna: 6, yieldBalaya: 6, yieldKawalam: 7,
    dailyRawKg: 500, workDays: 22,
    prodTransport: 110000, prodFirewood: 30000,
    prodWorkers: 220000, prodOther: 220000, prodIce: 35000,
    finLinna: 1750, finBalaya: 2200, finKawalam: 1000,
    ingSaltPrice: 120, ingSaltGrams: 0,
    ingGorakaPrice: 1200, ingGorakaGrams: 0,
    ingTurmericPrice: 1800, ingTurmericGrams: 0,
    ingCinnamonPrice: 3500, ingCinnamonGrams: 0,
    ingCurryLeafPrice: 400, ingCurryLeafGrams: 0,
    ingTamarindPrice: 900, ingTamarindGrams: 0
  }
};
let history = [];
let orders = [];
let customers = [];
let products = [];
let productImageFile = null;
let snapshots = [];
let lastSaveTime = null;
let saveTimer = null;
let appInitialized = false;

// ==================== HELPERS ====================
const $ = id => document.getElementById(id);

// ============================================================
// ROW ACTION MENU (three-dot / kebab) — one shared component used
// everywhere a row/card has "Edit / Delete / ..." buttons (Sales,
// Customers, Orders, Products, Expenses, Fish Bills, Production,
// Salary, Recurring Expenses, Distributor Activity, Staff Tasks,
// Notices, History). Build with actionMenuHTML(items) inside any
// render...() template string; each item = { label, onclick, danger, icon }.
// `onclick` is a raw JS expression string, e.g. "editSale('123')".
// ============================================================
function actionMenuHTML(items) {
  const rows = (items || []).filter(Boolean).map(it => {
    const cls = 'action-menu-item' + (it.danger ? ' danger' : '');
    const icon = it.icon ? `<span class="action-menu-icon">${it.icon}</span>` : '';
    return `<button type="button" class="${cls}" onclick="event.stopPropagation();closeAllActionMenus();${it.onclick}">${icon}<span>${it.label}</span></button>`;
  }).join('');
  if (!rows) return '';
  return `<div class="action-menu"><button type="button" class="action-menu-trigger" onclick="event.stopPropagation();toggleActionMenu(this)" aria-haspopup="true" aria-label="Actions">⋮</button><div class="action-menu-list">${rows}</div></div>`;
}

function closeAllActionMenus() {
  document.querySelectorAll('.action-menu.open').forEach(m => m.classList.remove('open'));
}

function toggleActionMenu(btn) {
  const menu = btn.closest('.action-menu');
  const list = menu.querySelector('.action-menu-list');
  const wasOpen = menu.classList.contains('open');
  closeAllActionMenus();
  if (wasOpen) return;
  menu.classList.add('open');
  const r = btn.getBoundingClientRect();
  list.style.left = '-9999px';
  list.style.top = (r.bottom + 6) + 'px';
  const lw = list.offsetWidth || 160;
  let left = r.right - lw;
  if (left < 8) left = 8;
  const maxLeft = window.innerWidth - lw - 8;
  if (left > maxLeft) left = Math.max(8, maxLeft);
  list.style.left = left + 'px';
  const lh = list.offsetHeight || 0;
  if (r.bottom + 6 + lh > window.innerHeight) {
    list.style.top = Math.max(8, r.top - lh - 6) + 'px';
  }
}

document.addEventListener('click', closeAllActionMenus);
document.addEventListener('scroll', closeAllActionMenus, true);
window.addEventListener('resize', closeAllActionMenus);
window.actionMenuHTML = actionMenuHTML;
window.toggleActionMenu = toggleActionMenu;
window.closeAllActionMenus = closeAllActionMenus;
const fmt = n => 'Rs. ' + (isFinite(n)?n:0).toLocaleString('en-LK', {maximumFractionDigits:2, minimumFractionDigits:0});
const fmt2 = n => (isFinite(n)?n:0).toLocaleString('en-LK', {maximumFractionDigits:2, minimumFractionDigits:2});

function getMixPct() {
  const ratio = state.mixRatio;
  if (ratio === 'custom') {
    const l = Number(state.customLinna)||0;
    const b = Number(state.customBalaya)||0;
    const k = 100 - l - b;
    return { linna: l/100, balaya: b/100, kawalam: (k >= 0 ? k : 0)/100 };
  }
  const [l,b,k] = ratio.split('/').map(Number);
  return { linna: l/100, balaya: b/100, kawalam: k/100 };
}

// Reads the owner's editable grinding-yield % (Costing tab) with a safe
// fallback to the original hardcoded constants for any call site that runs
// before state has loaded. Returns fractions (0-1), not percentages.
function getGrindYields() {
  const s = (typeof state !== 'undefined' && state) ? state : {};
  const clampFrac = (v, fallback) => {
    const n = Number(v);
    return (isFinite(n) && n > 0) ? Math.min(n, 100) / 100 : fallback;
  };
  return {
    linna: clampFrac(s.linnaGrindYield, LINNA_USABLE),
    balaya: clampFrac(s.balayaGrindYield, BALAYA_USABLE),
    premium: clampFrac(s.premiumGrindYield, PREMIUM_USABLE)
  };
}

// Returns the owner-editable MRP or Wholesale price for a pack size,
// falling back to the original hard-coded PACKS[key].mrp constant if the
// state doesn't have it yet (older saved state, or a bad/blank value).
// basis is 'mrp' or 'wholesale'; defaults to whatever the Dynamic Pricing
// table is currently set to (state.dpPriceBasis).
function getPackPrice(sizeKey, basis) {
  basis = basis || state.dpPriceBasis || 'mrp';
  const entry = (state.packPrices && state.packPrices[sizeKey]) || {};
  const val = Number(entry[basis]);
  if (isFinite(val) && val > 0) return val;
  return PACKS[sizeKey].mrp;
}

// Owner edits an MRP/Wholesale price cell in the Dynamic Pricing table.
// Persists into state.packPrices immediately (so the UI/local save never
// waits on the network), then best-effort mirrors it into the dedicated
// pack_prices Supabase table too (see supabase-setup-pack-pricing-and-
// inventory.sql). If that table hasn't been created yet, this silently
// no-ops — the app_data JSON blob already keeps the value safe either way.
function updatePackPrice(sizeKey, basis, value) {
  if (!state.packPrices) state.packPrices = {};
  if (!state.packPrices[sizeKey]) state.packPrices[sizeKey] = { mrp: PACKS[sizeKey].mrp, wholesale: PACKS[sizeKey].mrp };
  const n = Number(value);
  state.packPrices[sizeKey][basis] = isFinite(n) && n >= 0 ? n : 0;
  renderDynamicPricing();
  onDataChange();
  syncPackPriceToCloud(sizeKey);
}
window.updatePackPrice = updatePackPrice;

async function syncPackPriceToCloud(sizeKey) {
  if (!currentUser) return;
  const entry = state.packPrices[sizeKey];
  try {
    const { error } = await supabase.from('pack_prices').upsert({
      owner_id: businessId,
      pack_size_g: Number(sizeKey),
      mrp: entry.mrp,
      wholesale: entry.wholesale,
      updated_at: new Date().toISOString()
    }, { onConflict: 'owner_id,pack_size_g' });
    if (error) throw error;
  } catch (e) {
    // pack_prices table not created yet on this project — state is still
    // safely saved in the app_data JSON blob via onDataChange() above.
    console.warn('Cloud pack price sync skipped (run supabase-setup-pack-pricing-and-inventory.sql to enable):', e.message || e);
  }
}

// Pulls the dedicated pack_prices rows (if the table exists) into state on
// login/app start, so they win over an older cached app_data JSON value —
// the dedicated table is the source of truth once it's set up.
async function loadPackPricesFromCloud() {
  if (!currentUser) return;
  try {
    const { data, error } = await supabase.from('pack_prices').select('*').eq('owner_id', businessId);
    if (error) throw error;
    if (!data || data.length === 0) return;
    if (!state.packPrices) state.packPrices = {};
    data.forEach(row => {
      state.packPrices[row.pack_size_g] = { mrp: Number(row.mrp) || 0, wholesale: Number(row.wholesale) || 0 };
    });
    renderDynamicPricing();
  } catch (e) {
    // Table doesn't exist yet — keep using whatever's already in state
    // (from the app_data JSON blob / hard-coded defaults).
    console.warn('Load pack prices error (run supabase-setup-pack-pricing-and-inventory.sql to enable):', e.message || e);
  }
}
window.loadPackPricesFromCloud = loadPackPricesFromCloud;

// Owner switches which price the Dynamic Pricing table calculates against.
function onDpBasisChange() {
  const el = $('dpPriceBasis');
  state.dpPriceBasis = el ? el.value : 'mrp';
  renderDynamicPricing();
  onDataChange();
}
window.onDpBasisChange = onDpBasisChange;

function calculatePack(sizeKey, linnaPrice, balayaPrice, premiumPrice, mixPct, mode, targetProfit, customSp) {
  const p = PACKS[sizeKey];
  const gy = getGrindYields();
  const linnaUsableG = p.fish * mixPct.linna;
  const balayaUsableG = p.fish * mixPct.balaya;
  const premiumUsableG = p.fish * mixPct.kawalam;
  // Umbalakada required BEFORE grinding — inflated to cover the fine dust
  // that grinding will strip out, so the pack still ends up with the
  // usable weight above after grinding.
  const linnaRawG = linnaUsableG / gy.linna;
  const balayaRawG = balayaUsableG / gy.balaya;
  const premiumRawG = premiumUsableG / gy.premium;
  // Dust lost per type = Umbalakada fed in minus usable flakes that make it
  // into the pack. You paid full Umbalakada price for this weight even
  // though none of it ends up in the customer's pack.
  const linnaDustG = linnaRawG - linnaUsableG;
  const balayaDustG = balayaRawG - balayaUsableG;
  const premiumDustG = premiumRawG - premiumUsableG;
  const totalDustG = linnaDustG + balayaDustG + premiumDustG;
  const totalUmbalakadaRequiredG = linnaRawG + balayaRawG + premiumRawG;
  const linnaCost = (linnaRawG/1000) * linnaPrice;
  const balayaCost = (balayaRawG/1000) * balayaPrice;
  const premiumCost = (premiumRawG/1000) * premiumPrice;
  const rawFishCost = linnaCost + balayaCost + premiumCost;
  // Cost of the material that becomes dust — already included inside
  // linna/balaya/premiumCost above (informational only, not added again).
  const dustCost = (linnaDustG/1000) * linnaPrice + (balayaDustG/1000) * balayaPrice + (premiumDustG/1000) * premiumPrice;
  const baseCost = rawFishCost + p.grind + p.pack;
  let sp;
  if (mode === 'profit') sp = (baseCost + targetProfit) / (1 - PACKING_LABOUR_PCT);
  else if (mode === 'sp') sp = customSp;
  else sp = p.mrp;
  const packingLabour = sp * PACKING_LABOUR_PCT;
  const totalCost = baseCost + packingLabour;
  const profit = sp - totalCost;
  const margin = sp > 0 ? (profit/sp)*100 : 0;
  return {
    p, linnaRawG, balayaRawG, premiumRawG, linnaCost, balayaCost, premiumCost, rawFishCost, baseCost, sp, packingLabour, totalCost, profit, margin,
    linnaDustG, balayaDustG, premiumDustG, totalDustG, totalUmbalakadaRequiredG, dustCost
  };
}

function getFixedCost() {
  return Object.values(state.overhead).reduce((a,b)=>a+b,0);
}

// ==================== UMBALAKADA VARIETIES (Production tab) ====================
// Lets the owner track any number of Umbalakada varieties in the Daily
// Production Log — not just the fixed Linna/Balaya/Premium Mix three the
// Costing calculator's pack-pricing math (calculatePack, quotes, PDFs,
// Quick Profit Calculator) is built around. The 3 core types stay wired to
// state.linnaPrice/balayaPrice/kawalamPrice so nothing that already depends
// on them changes. Extra varieties the owner adds here are for day-to-day
// grinding & cost tracking — they feed the Grinding & Dust section's totals
// and dust-cost valuation, but not the pack pricing formulas.
let umbalakadaGroundTodayByType = {};

function ensureUmbalakadaTypes() {
  if (!Array.isArray(state.umbalakadaTypes) || !state.umbalakadaTypes.some(t => t && t.core)) {
    const existingCustom = Array.isArray(state.umbalakadaTypes) ? state.umbalakadaTypes.filter(t => t && !t.core) : [];
    state.umbalakadaTypes = [
      { id: 'linna', name: 'Linna', core: true },
      { id: 'balaya', name: 'Balaya', core: true },
      { id: 'kawalam', name: 'Premium Mix', core: true },
      ...existingCustom
    ];
  }
  return state.umbalakadaTypes;
}

function getUmbalakadaTypePrice(t) {
  if (t.id === 'linna') return Number(state.linnaPrice) || 0;
  if (t.id === 'balaya') return Number(state.balayaPrice) || 0;
  if (t.id === 'kawalam') return Number(state.kawalamPrice) || 0;
  return Number(t.price) || 0;
}

// ==================== PRODUCTION LOG ⇄ TODAY'S PURCHASE (live sync) ====================
// This used to be a second manual entry table ("Umbalakada Varieties &
// Prices") that duplicated what the owner already types into the Costing
// tab's "Today's Umbalakada Purchase" sub-tab. Removed in favour of this:
// whatever purchase round(s) are saved for today in daily_purchase_log
// (saveDailyPurchaseEntry() — multiple rounds/day allowed) are aggregated
// here and pushed straight into the Daily Production Log's grind & dust
// fields automatically. No re-typing, and it re-syncs the moment a new
// purchase round is saved/deleted or this data is reloaded — see the
// syncUmbalakadaGroundFromPurchaseLog() call sites (saveDailyPurchaseEntry,
// deleteDailyPurchaseEntry, switchCostingTab('daypurchase'), and the
// Production tab's tab-open handler).
let umbalakadaTodaysPurchasePriceByType = {}; // { linna, balaya, kawalam } -> weighted avg Rs./kg actually paid today
let lastPurchaseSyncEntryCount = 0;

function syncUmbalakadaGroundFromPurchaseLog() {
  const today = todayIso();
  const todays = (dailyPurchaseLogCache || []).filter(r => r.log_date === today);
  lastPurchaseSyncEntryCount = todays.length;

  const sums = {
    linna: { kg: 0, value: 0 },
    balaya: { kg: 0, value: 0 },
    kawalam: { kg: 0, value: 0 }
  };
  let totalPurchasedKg = 0, totalGrindOutputKg = 0, totalDustRecoveredKg = 0, totalDustReusedKg = 0;

  todays.forEach(r => {
    sums.linna.kg += Number(r.qty_linna) || 0;
    sums.linna.value += (Number(r.qty_linna) || 0) * (Number(r.price_linna) || 0);
    sums.balaya.kg += Number(r.qty_balaya) || 0;
    sums.balaya.value += (Number(r.qty_balaya) || 0) * (Number(r.price_balaya) || 0);
    sums.kawalam.kg += Number(r.qty_premium) || 0;
    sums.kawalam.value += (Number(r.qty_premium) || 0) * (Number(r.price_premium) || 0);
    totalPurchasedKg += Number(r.total_kg) || 0;
    totalGrindOutputKg += Number(r.grind_output_kg) || 0;
    totalDustRecoveredKg += Number(r.dust_recovered_kg) || 0;
    totalDustReusedKg += Number(r.dust_reused_kg) || 0;
  });

  umbalakadaGroundTodayByType = { linna: sums.linna.kg, balaya: sums.balaya.kg, kawalam: sums.kawalam.kg };
  umbalakadaTodaysPurchasePriceByType = {
    linna: sums.linna.kg > 0 ? sums.linna.value / sums.linna.kg : 0,
    balaya: sums.balaya.kg > 0 ? sums.balaya.value / sums.balaya.kg : 0,
    kawalam: sums.kawalam.kg > 0 ? sums.kawalam.value / sums.kawalam.kg : 0
  };

  // Auto-fill Grinding & Dust from the purchase entries — same derivation
  // the Costing tab's calculator uses (dust = purchased − grind output).
  // Only overwrites once there's actually something saved for today, so an
  // owner's manual correction isn't clobbered by an empty sync.
  if (todays.length > 0) {
    const dustGeneratedKg = Math.max(totalPurchasedKg - totalGrindOutputKg, 0);
    const dustUsedKg = totalDustReusedKg + totalDustRecoveredKg;
    if ($('dpDustGeneratedKg')) $('dpDustGeneratedKg').value = Math.round(dustGeneratedKg * 100) / 100;
    if ($('dpDustUsedKg')) $('dpDustUsedKg').value = Math.round(dustUsedKg * 100) / 100;
  }

  renderUmbalakadaPurchaseSyncTable();
}
window.syncUmbalakadaGroundFromPurchaseLog = syncUmbalakadaGroundFromPurchaseLog;

// Sums today's per-variety kg (from the sync above) into the "Umbalakada
// Ground Today" field the Grinding & Dust dust-loss math already reads, and
// works out a real weighted-average price/kg actually paid today.
function recalcUmbalakadaGrindTotals() {
  const list = ensureUmbalakadaTypes().filter(t => t.core);
  let totalKg = 0, totalValue = 0;
  const breakdown = [];
  list.forEach(t => {
    const kg = Number(umbalakadaGroundTodayByType[t.id]) || 0;
    const price = Number(umbalakadaTodaysPurchasePriceByType[t.id]) || getUmbalakadaTypePrice(t);
    totalKg += kg;
    totalValue += kg * price;
    if (kg > 0) breakdown.push({ id: t.id, name: t.name, price, kg });
  });
  lastUmbalakadaBreakdownForSave = breakdown;
  window.umbalakadaBreakdownTotalKg = totalKg;
  window.umbalakadaBreakdownAvgPrice = totalKg > 0 ? totalValue / totalKg : 0;

  const totalEl = $('umbTotalGroundKg'), avgEl = $('umbAvgPricePerKg');
  if (totalEl) totalEl.textContent = fmt2(totalKg) + ' kg';
  if (avgEl) avgEl.textContent = fmt(window.umbalakadaBreakdownAvgPrice);
  if (totalKg > 0 && $('dpUmbalakadaGroundKg')) $('dpUmbalakadaGroundKg').value = fmt2(totalKg);
  updateDailyProductionSummaryLive();
}
window.recalcUmbalakadaGrindTotals = recalcUmbalakadaGrindTotals;

// Read-only display — the 3 core varieties, priced and weighed from today's
// actual saved purchase entries. Nothing here is hand-typed any more.
function renderUmbalakadaPurchaseSyncTable() {
  const tbody = $('umbTypesBody');
  if (!tbody) return;
  const rows = ensureUmbalakadaTypes().filter(t => t.core);
  tbody.innerHTML = rows.map(t => {
    const kg = Number(umbalakadaGroundTodayByType[t.id]) || 0;
    const price = Number(umbalakadaTodaysPurchasePriceByType[t.id]) || 0;
    return `<tr>
      <td><strong>${t.name}</strong></td>
      <td>${price > 0 ? fmt(price) : '<span style="opacity:.5;">—</span>'}</td>
      <td>${kg > 0 ? fmt2(kg) + ' kg' : '<span style="opacity:.5;">0 kg</span>'}</td>
    </tr>`;
  }).join('');

  const noteEl = $('umbSyncNote');
  if (noteEl) {
    noteEl.textContent = lastPurchaseSyncEntryCount > 0
      ? `🔄 Synced live from ${lastPurchaseSyncEntryCount} purchase update${lastPurchaseSyncEntryCount > 1 ? 's' : ''} saved today in the Costing tab's "Today's Umbalakada Purchase".`
      : `No purchase entries saved for today yet — add one in the Costing tab's "Today's Umbalakada Purchase" sub-tab and it'll show up here automatically.`;
  }

  recalcUmbalakadaGrindTotals();
}
window.renderUmbalakadaPurchaseSyncTable = renderUmbalakadaPurchaseSyncTable;

function getAllocatedOverheadPerPack() {
  let totalPacks = 0;
  Object.keys(PACKS).forEach(key => { totalPacks += state.dashQty[key] || 0; });
  const fixed = getFixedCost();
  return totalPacks > 0 ? fixed / totalPacks : 0;
}

// ==================== CHARTS ====================
let costChart = null, prodChart = null, dpMonthlyChart = null, ingBreakdownChart = null, dpDustProfitChart = null, costingGrindOutputChart = null, costBreakdownChart = null;
let dailyProductionLogCache = [];
let lastProdAvgRawCostPerKg = 0, lastProdIngredientsCostPerKg = 0, lastProdOverheadCostPerKg = 0;
let lastProdAvgCostPerKg = 0, lastProdAvgMarketPrice = 0, lastProdAvgProfitPerKg = 0;
// The numbers Save Today's Snapshot actually writes — normally identical to
// the estimates above, but diverge once a custom selling price is entered.
let lastProdAvgCostPerKgForSave = 0, lastProdAvgProfitPerKgForSave = 0;
let lastProdIngredientsCostPerKgForSave = 0, lastProdAvgMarketPriceForSave = 0;
// Daily grinding & dust figures — computed live by updateDailyProductionSummaryLive()
// and written as-is by saveDailyProductionLog(). See the SQL comment above
// saveDailyProductionLog() for the matching production_cost_log columns.
let lastDustGeneratedKgForSave = 0, lastDustUsedKgForSave = 0, lastDustRemovedKgForSave = 0;
let lastDustSalePriceForSave = 0, lastDustWasteCostForSave = 0, lastDustRecoveryValueForSave = 0;
let lastNetDustImpactForSave = 0, lastNetProfitInclDustForSave = 0, lastUmbalakadaGroundKgForSave = 0;
// Grind-by-fish-type split (Linna/Balaya/Premium) — today's groundKg divided
// using the mix ratio in effect when saved, so it stays historically
// accurate even if the mix ratio changes later. Output-by-product qty/profit
// — today's pack counts (Production tab) priced with calculatePack() at
// save time, so Costing tab's per-product profit table has something to
// read even before the owner revisits that day.
let lastLinnaGroundKgForSave = 0, lastBalayaGroundKgForSave = 0, lastPremiumGroundKgForSave = 0;
let lastOutputByProductForSave = { 50: 0, 100: 0, 500: 0, 1000: 0 };
let lastOutputTotalProfitForSave = 0;
// Per-variety grind breakdown from the "Umbalakada Varieties & Prices" table
// — [{id, name, price, kg}] for every variety with kg > 0 today. Written to
// production_cost_log.umbalakada_variety_breakdown on save (see the SQL
// comment above saveDailyProductionLog()).
let lastUmbalakadaBreakdownForSave = [];
// Per-fish-type snapshot from the last calcProduction() run — used by the
// Production Batches feature to know each type's current yield factor and
// total cost/kg without re-deriving it. Keyed by fish type name.
let lastProdCostByType = {};

function getChartColors() {
  const isDark = state.theme === 'dark';
  return {
    text: isDark ? '#d1fae5' : '#065f46',
    grid: isDark ? 'rgba(16,185,129,0.1)' : 'rgba(5,150,105,0.1)',
    border: isDark ? 'rgba(16,185,129,0.2)' : 'rgba(5,150,105,0.15)'
  };
}

// Guards every "new Chart(...)" call. If the Chart.js library failed to
// load (blocked CDN, offline first-visit before the service worker cached
// it, etc.) `Chart` is undefined and calling `new Chart(...)` throws — and
// because that line sits partway through bigger functions like
// calcProduction()/renderDailyProductionLog(), the throw silently kills the
// rest of that function too. This wraps the risky part so one broken chart
// can't take anything else down, and leaves a visible message in the
// chart's box instead of an unexplained blank area.
function safeRenderChart(canvasId, renderFn) {
  const canvas = $(canvasId);
  if (!canvas) return null;
  try {
    if (typeof Chart === 'undefined') {
      throw new Error('Chart.js did not load (offline or the CDN is blocked)');
    }
    return renderFn();
  } catch (err) {
    console.error('Chart render failed for #' + canvasId + ':', err);
    const wrap = canvas.closest('.chart-wrap') || canvas.parentElement;
    if (wrap) {
      wrap.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;text-align:center;padding:12px;opacity:.6;font-size:.85rem;">📉 Chart couldn\'t load (check your internet connection) — the numbers above are still accurate.</div>';
    }
    return null;
  }
}

// Doughnut showing today's ingredient spend split by spice — only shown
// once there's actually something to show, so it doesn't sit there empty
// on a fresh/zeroed form.
const ING_SLICE_COLORS = ['#38bdf8','#a78bfa','#fbbf24','#fb923c','#34d399','#f472b6'];
function renderIngredientBreakdownChart(breakdown, totalCost) {
  const wrap = $('ingBreakdownWrap');
  if (!wrap) return;
  const nonZero = (breakdown || []).filter(b => b.cost > 0);
  if (!totalCost || totalCost <= 0 || nonZero.length === 0) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'block';
  safeRenderChart('ingBreakdownChart', () => {
    const colors = getChartColors();
    const ctx = $('ingBreakdownChart').getContext('2d');
    const chartData = {
      labels: nonZero.map(b => b.label),
      datasets: [{
        data: nonZero.map(b => Math.round(b.cost)),
        backgroundColor: nonZero.map((_, i) => ING_SLICE_COLORS[i % ING_SLICE_COLORS.length]),
        borderColor: 'transparent',
        hoverOffset: 8
      }]
    };
    if (ingBreakdownChart) { ingBreakdownChart.data = chartData; ingBreakdownChart.update(); }
    else {
      ingBreakdownChart = new Chart(ctx, {
        type: 'doughnut',
        data: chartData,
        options: {
          responsive: true, maintainAspectRatio: false, cutout: '62%',
          plugins: {
            legend: { position: 'right', labels: { boxWidth: 10, font: { size: 11, family: 'Inter' }, color: colors.text, usePointStyle: true, pointStyle: 'circle' } },
            tooltip: {
              callbacks: {
                label: (item) => {
                  const pct = totalCost > 0 ? (item.parsed / totalCost * 100).toFixed(1) : '0';
                  return ` ${item.label}: Rs. ${item.parsed.toLocaleString()} (${pct}%)`;
                }
              }
            }
          }
        }
      });
    }
  });
}


// Mirrors the Pack Result numbers into the Costing tab's hero banner
// (#costingHero). Pure display reflection — no separate calculation, so it
// can never disagree with the Pack Result card below it. Guarded for older
// cached HTML that doesn't have the hero elements yet.
function updateCostingHero(r) {
  const spEl = $('heroSp'), profitEl = $('heroProfit'), marginEl = $('heroMargin'), costEl = $('heroCost');
  if (!spEl) return;
  spEl.textContent = fmt(r.sp);
  profitEl.textContent = fmt(r.profit);
  marginEl.textContent = fmt2(r.margin) + '%';
  costEl.textContent = fmt(r.totalCost);
  const profitKpi = profitEl.closest('.chero-kpi');
  if (profitKpi) profitKpi.classList.toggle('bad', r.profit < 0);
}
window.updateCostingHero = updateCostingHero;

function calcAll() {
  state.linnaPrice = Number($('linnaPrice').value) || 0;
  state.balayaPrice = Number($('balayaPrice').value) || 0;
  state.kawalamPrice = Number($('kawalamPrice').value) || 0;
  state.packSize = $('packSize').value;
  state.mixRatio = $('mixRatio').value;
  state.customLinna = Number($('customLinna').value) || 0;
  state.customBalaya = Number($('customBalaya').value) || 0;
  state.customKawalam = Number($('customKawalam').value) || 0;
  state.targetProfit = Number($('targetProfit').value) || 0;
  state.customSp = Number($('customSp').value) || 0;
  state.monthlyQty = Number($('monthlyQty').value) || 0;
  state.linnaGrindYield = Number($('linnaGrindYield').value) || state.linnaGrindYield;
  state.balayaGrindYield = Number($('balayaGrindYield').value) || state.balayaGrindYield;
  state.premiumGrindYield = Number($('premiumGrindYield').value) || state.premiumGrindYield;

  const mix = getMixPct();
  const mixTotal = Math.round((mix.linna + mix.balaya + mix.kawalam) * 100);
  $('mixWarning').style.display = (state.mixRatio === 'custom' && mixTotal !== 100) ? 'block' : 'none';
  $('mixTotal').textContent = mixTotal;

  const r = calculatePack(state.packSize, state.linnaPrice, state.balayaPrice, state.kawalamPrice, mix, state.mode, state.targetProfit, state.customSp);

  $('outSp').textContent = fmt(r.sp);
  $('outProfit').textContent = fmt(r.profit);
  $('outMargin').textContent = fmt2(r.margin) + '%';
  $('outCost').textContent = fmt(r.totalCost);
  $('profitStat').className = 'stat ' + (r.profit >= 0 ? 'good' : 'bad');
  updateCostingHero(r);
  if ($('outUmbalakadaRequired')) $('outUmbalakadaRequired').textContent = fmt2(r.totalUmbalakadaRequiredG) + ' g';
  if ($('outDustLoss')) {
    const dustPct = r.totalUmbalakadaRequiredG > 0 ? (r.totalDustG / r.totalUmbalakadaRequiredG) * 100 : 0;
    $('outDustLoss').textContent = fmt2(r.totalDustG) + ' g (' + fmt2(dustPct) + '%)';
  }
  if ($('dustLossNote')) {
    $('dustLossNote').textContent = `To fill this ${r.p.label} pack, ${fmt2(r.totalUmbalakadaRequiredG)}g of Umbalakada goes into the grinder — ${fmt2(r.totalDustG)}g of that (worth ${fmt(r.dustCost)}) is lost as fine dust, leaving ${fmt2(r.p.fish)}g of usable flakes. That dust cost is already folded into the fish cost rows below, not added twice.`;
  }

  const rows = [
    [`Linna Umbalakada (${fmt2(r.linnaRawG)}g in → ${fmt2(r.linnaRawG - r.linnaDustG)}g usable, ${fmt2(r.linnaDustG)}g dust)`, r.linnaCost],
    [`Balaya Umbalakada (${fmt2(r.balayaRawG)}g in → ${fmt2(r.balayaRawG - r.balayaDustG)}g usable, ${fmt2(r.balayaDustG)}g dust)`, r.balayaCost],
    [`Premium Mix Umbalakada (${fmt2(r.premiumRawG)}g in → ${fmt2(r.premiumRawG - r.premiumDustG)}g usable, ${fmt2(r.premiumDustG)}g dust)`, r.premiumCost],
    ['Grinding labour', r.p.grind],
    ['Packaging', r.p.pack],
    ['Packing labour (5%)', r.packingLabour],
    ['Total Cost', r.totalCost]
  ];
  $('breakdownBody').innerHTML = rows.map(([label,val],i) =>
    `<tr class="${i===rows.length-1?'total-row':''}"><td>${label}</td><td class="num">${fmt(val)}</td></tr>`
  ).join('');

  const monthlyRevenue = r.sp * state.monthlyQty;
  const monthlyProfit = r.profit * state.monthlyQty;
  $('monthlyBody').innerHTML = `
    <tr><td>Monthly Revenue</td><td class="num">${fmt(monthlyRevenue)}</td></tr>
    <tr><td>Monthly Cost</td><td class="num">${fmt(r.totalCost * state.monthlyQty)}</td></tr>
    <tr class="total-row"><td>Monthly Profit</td><td class="num">${fmt(monthlyProfit)}</td></tr>
  `;

  const colors = getChartColors();
  const ctx = $('costChart').getContext('2d');
  const data = {
    labels: ['Linna','Balaya','Premium Mix','Grind','Pack','Labour','Profit'],
    datasets: [{
      data: [r.linnaCost, r.balayaCost, r.premiumCost, r.p.grind, r.p.pack, r.packingLabour, Math.max(r.profit,0)],
      backgroundColor: ['#38bdf8','#a78bfa','#10b981','#fbbf24','#f87171','#818cf8','#34d399'],
      borderWidth: 0,
      hoverOffset: 6
    }]
  };
  if (costChart) { costChart.data = data; costChart.update(); }
  else {
    costChart = new Chart(ctx, {
      type: 'doughnut',
      data,
      options: {
        responsive:true,
        maintainAspectRatio:false,
        cutout: '60%',
        plugins:{
          legend:{
            position:'bottom',
            labels:{
              boxWidth:10,
              font:{size:11, family:'Inter'},
              color: colors.text,
              padding: 12,
              usePointStyle: true,
              pointStyle: 'circle'
            }
          }
        }
      }
    });
  }

  calcScenario();
  calcBulk();
  calcDashboard();
  renderDynamicPricing();
  renderGrindingDustAllPacksTable();
}

// ==================== GRINDING & DUST — ALL PACKS ====================
// For every pack size, shows how much Umbalakada must be fed into the
// grinder and how much of that is lost as dust, using the CURRENT mix
// ratio and the editable grind-yield % above. Independent of pricing mode
// (dust math only depends on pack weight, mix and yields), so it always
// reflects every product at once — not just the pack size selected above.
function renderGrindingDustAllPacksTable() {
  const tbody = $('grindDustAllPacksBody');
  if (!tbody) return;
  const mix = getMixPct();
  tbody.innerHTML = Object.keys(PACKS).map(key => {
    const r = calculatePack(key, state.linnaPrice, state.balayaPrice, state.kawalamPrice, mix, 'mrp', 0, 0);
    const dustPct = r.totalUmbalakadaRequiredG > 0 ? (r.totalDustG / r.totalUmbalakadaRequiredG) * 100 : 0;
    return `<tr><td>${r.p.label}</td><td class="num">${fmt2(r.totalUmbalakadaRequiredG)} g</td><td class="num">${fmt2(r.p.fish)} g</td><td class="num">${fmt2(r.totalDustG)} g</td><td class="num">${fmt2(dustPct)}%</td><td class="num">${fmt(r.dustCost)}</td></tr>`;
  }).join('');
}
window.renderGrindingDustAllPacksTable = renderGrindingDustAllPacksTable;

// ==================== DYNAMIC PRICING SUGGESTIONS ====================
// Recomputes, for every pack size, what selling price would be needed to
// hit a target margin % given the CURRENT fish prices & mix ratio set
// above — independent of which pack size is selected for the main
// calculator. Purely suggestive: never writes back to MRP/state.
function renderDynamicPricing() {
  const tbody = $('dynamicPricingBody');
  if (!tbody) return;
  const targetMarginEl = $('dpTargetMargin');
  const targetMargin = targetMarginEl ? (Number(targetMarginEl.value) || 0) : 25;
  const mix = getMixPct();

  // Which price basis the owner has selected — MRP or Wholesale. Keeps the
  // <select> in sync in case renderDynamicPricing() was called from
  // somewhere other than the select's own onchange (e.g. after loading
  // state from the cloud).
  const basisEl = $('dpPriceBasis');
  const basis = state.dpPriceBasis || 'mrp';
  if (basisEl && basisEl.value !== basis) basisEl.value = basis;
  const basisLabel = basis === 'wholesale' ? 'Wholesale' : 'MRP';
  const headerEl = $('dpCurrentPriceHeader');
  if (headerEl) headerEl.textContent = `Current ${basisLabel}`;

  const rows = Object.keys(PACKS).map(k => {
    const p = PACKS[k];
    const currentPrice = getPackPrice(k, basis);
    let r;
    try {
      // Feed the owner's editable price in via 'sp' mode instead of the
      // hard-coded PACKS[k].mrp, so Current Cost/Margin/Suggestion all
      // react to whichever price (MRP or Wholesale) is selected.
      r = calculatePack(k, state.linnaPrice, state.balayaPrice, state.kawalamPrice, mix, 'sp', 0, currentPrice);
    } catch (e) { return null; }
    const currentCost = r.totalCost;
    const currentMargin = currentPrice > 0 ? ((currentPrice - currentCost) / currentPrice) * 100 : 0;
    // Solve sp such that: sp = baseCost + sp*PACKING_LABOUR_PCT + sp*(targetMargin/100)
    const denom = 1 - PACKING_LABOUR_PCT - (targetMargin / 100);
    const suggestedSp = denom > 0 ? r.baseCost / denom : null;
    const diff = suggestedSp !== null ? suggestedSp - currentPrice : null;
    return { key: k, label: p.label, price: currentPrice, cost: currentCost, margin: currentMargin, suggestedSp, diff };
  }).filter(Boolean);

  tbody.innerHTML = rows.map(row => {
    const marginColor = row.margin < targetMargin ? '#d45d55' : '#0a8f43';
    let suggestionHtml = '—';
    if (row.suggestedSp !== null) {
      if (row.diff > 1) {
        suggestionHtml = `<span style="color:#d45d55;font-weight:700;">⬆ Increase ${fmt(row.diff)}</span>`;
      } else if (row.diff < -1) {
        suggestionHtml = `<span style="color:#0a8f43;font-weight:700;">⬇ Can lower ${fmt(Math.abs(row.diff))}</span>`;
      } else {
        suggestionHtml = `<span style="opacity:.6;">✓ No change needed</span>`;
      }
    }
    return `<tr>
      <td>${row.label}</td>
      <td class="num"><input type="number" class="editable-sp" value="${row.price}" style="width:90px;min-height:32px;text-align:right;" onchange="updatePackPrice('${row.key}','${basis}',this.value)"></td>
      <td class="num">${fmt(row.cost)}</td>
      <td class="num" style="color:${marginColor};font-weight:700;">${fmt2(row.margin)}%</td>
      <td class="num">${row.suggestedSp !== null ? fmt(row.suggestedSp) : '—'}</td>
      <td class="num">${suggestionHtml}</td>
    </tr>`;
  }).join('');
}
window.renderDynamicPricing = renderDynamicPricing;

function calcScenario() {
  const sizeKey = state.packSize;
  const scCEl = $('scC'), scCSpEl = $('scCSp');
  const mixA = $('scA').value.split('/').map(Number);
  const mixB = $('scB').value.split('/').map(Number);
  // Scenario C is optional in the DOM (older cached HTML) — fall back to
  // Scenario B's mix/price so calcScenario() never throws if it's missing.
  const mixC = scCEl ? scCEl.value.split('/').map(Number) : mixB;
  const spA = Number($('scASp').value) || 0;
  const spB = Number($('scBSp').value) || 0;
  const spC = scCSpEl ? (Number(scCSpEl.value) || 0) : spB;
  const rA = calculatePack(sizeKey, state.linnaPrice, state.balayaPrice, state.kawalamPrice, {linna:mixA[0]/100,balaya:mixA[1]/100,kawalam:mixA[2]/100}, 'sp', 0, spA);
  const rB = calculatePack(sizeKey, state.linnaPrice, state.balayaPrice, state.kawalamPrice, {linna:mixB[0]/100,balaya:mixB[1]/100,kawalam:mixB[2]/100}, 'sp', 0, spB);
  const rC = calculatePack(sizeKey, state.linnaPrice, state.balayaPrice, state.kawalamPrice, {linna:mixC[0]/100,balaya:mixC[1]/100,kawalam:mixC[2]/100}, 'sp', 0, spC);
  const metrics = [
    ['Fish Cost', rA.rawFishCost, rB.rawFishCost, rC.rawFishCost, 'cost'],
    ['Total Cost', rA.totalCost, rB.totalCost, rC.totalCost, 'cost'],
    ['Profit', rA.profit, rB.profit, rC.profit, 'profit'],
    ['Margin %', rA.margin, rB.margin, rC.margin, 'profit'],
    ['Umbalakada Required (g)', rA.totalUmbalakadaRequiredG, rB.totalUmbalakadaRequiredG, rC.totalUmbalakadaRequiredG, 'cost'],
    ['Dust Loss (g)', rA.totalDustG, rB.totalDustG, rC.totalDustG, 'cost']
  ];
  $('scenarioBody').innerHTML = metrics.map(m => {
    const [label, a, b, c, kind] = m;
    const vals = [['A',a],['B',b],['C',c]];
    // 'cost'-type metrics: lowest wins. 'profit'-type: highest wins. Ties (all
    // equal) show "Tie" rather than crowning an arbitrary winner.
    const best = vals.every(v => v[1] === a) ? 'Tie'
      : (kind === 'cost' ? vals.reduce((m1, v) => v[1] < m1[1] ? v : m1) : vals.reduce((m1, v) => v[1] > m1[1] ? v : m1))[0];
    const fmtVal = (v) => label.includes('%') ? fmt2(v)+'%' : label.includes('(g)') ? fmt2(v)+' g' : fmt(v);
    return `<tr><td>${label}</td><td class="num">${fmtVal(a)}</td><td class="num">${fmtVal(b)}</td><td class="num">${fmtVal(c)}</td><td class="num"><span class="badge badge-good">${best}</span></td></tr>`;
  }).join('');
}

// ==================== COSTING TAB — SUB-TABS ====================
// "pricing" = Raw Materials/Scenarios/Dynamic Pricing (inputs & what-if).
// "daily"   = live Grind→Output snapshot + monthly trend chart, sourced
// from the same dailyProductionLogCache the Production tab uses.
function switchCostingTab(tab) {
  ['pricing', 'daily', 'daypurchase', 'readymade', 'orderbuy', 'breakdown'].forEach(t => {
    const panel = $(`costingTab-${t}`);
    if (panel) panel.style.display = (t === tab) ? '' : 'none';
  });
  document.querySelectorAll('.costing-subtab').forEach(btn => {
    btn.classList.toggle('btn-primary', btn.getAttribute('data-costing-tab') === tab);
  });
  if (tab === 'daily') { renderCostingGrindOutputChart(); populatePackProductMapSelects(); renderDailyStoreHistory(); }
  if (tab === 'daypurchase') {
    calcDailyPurchase();
    const logDateEl = $('dpbLogDate');
    if (logDateEl && !logDateEl.value) logDateEl.value = todayIso();
    loadDailyPurchaseLog().then(() => { renderDailyPurchaseHistory(); syncUmbalakadaGroundFromPurchaseLog(); });
  }
  if (tab === 'readymade') {
    loadFishBillsFromCloud().then(() => renderReadymadeBills());
  }
  if (tab === 'orderbuy') calcOrderToBuy();
  if (tab === 'breakdown') renderCostBreakdown();
}
window.switchCostingTab = switchCostingTab;

// ==================== COSTING TAB — COST BREAKDOWN ANALYTICS ====================
// Category-wise view of the same `expenses` array as the Expenses tab, for
// any date range the owner picks. Always agrees exactly with Expenses and
// the Profit chart — no separate data entry, just a different lens on the
// same records.
const CB_SLICE_COLORS = ['#f87171', '#fbbf24', '#10b981', '#4b9cff', '#9a72ff', '#ee9a3d', '#27b9b1', '#8fa3ad', '#f472b6', '#38bdf8', '#a3e635', '#fb923c', '#c084fc', '#94a3b8'];

function onCostBreakdownRangeChange() {
  const presetEl = $('cbRangePreset');
  if (!presetEl) return;
  const showCustom = presetEl.value === 'custom';
  if ($('cbCustomFromWrap')) $('cbCustomFromWrap').style.display = showCustom ? '' : 'none';
  if ($('cbCustomToWrap')) $('cbCustomToWrap').style.display = showCustom ? '' : 'none';
  if (showCustom) {
    if ($('cbCustomFrom') && !$('cbCustomFrom').value) $('cbCustomFrom').value = todayIso();
    if ($('cbCustomTo') && !$('cbCustomTo').value) $('cbCustomTo').value = todayIso();
  }
  renderCostBreakdown();
}
window.onCostBreakdownRangeChange = onCostBreakdownRangeChange;

// Resolves the selected preset (or custom dates) into actual from/to Date
// bounds. 'all' returns both as null, meaning "no bound" — every expense
// ever recorded is included.
function costBreakdownRangeBounds() {
  const preset = $('cbRangePreset') ? $('cbRangePreset').value : 'month';
  const now = new Date();
  let from = null, to = null;
  if (preset === 'today') {
    from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  } else if (preset === 'week') {
    const day = now.getDay(); // 0 = Sunday
    const diffToMonday = (day === 0 ? 6 : day - 1);
    from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diffToMonday);
    to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  } else if (preset === 'month') {
    from = new Date(now.getFullYear(), now.getMonth(), 1);
    to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  } else if (preset === 'year') {
    from = new Date(now.getFullYear(), 0, 1);
    to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  } else if (preset === 'custom') {
    const fromStr = $('cbCustomFrom') ? $('cbCustomFrom').value : '';
    const toStr = $('cbCustomTo') ? $('cbCustomTo').value : '';
    from = fromStr ? parseSummaryDate(fromStr) : null;
    to = toStr ? parseSummaryDate(toStr) : null;
    if (to) to = new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59, 999);
  }
  // preset === 'all' falls through with from/to both still null.
  return { from, to };
}

function renderCostBreakdown() {
  const body = $('cbBreakdownBody');
  if (!body) return;
  const setStat = (id, v) => { const el = $(id); if (el) el.textContent = v; };

  const { from, to } = costBreakdownRangeBounds();
  const inRange = (dateStr) => {
    const d = parseSummaryDate(dateStr);
    if (!d) return false;
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  };
  const entries = (expenses || []).filter(e => inRange(e.date));

  const catTotals = {}, catCounts = {};
  let total = 0;
  entries.forEach(e => {
    const cat = e.category || 'Other';
    const amt = Number(e.amount) || 0;
    catTotals[cat] = (catTotals[cat] || 0) + amt;
    catCounts[cat] = (catCounts[cat] || 0) + 1;
    total += amt;
  });
  const catLabel = (c) => COSTING_CATEGORY_LABELS[c] || c;
  const sortedCats = Object.keys(catTotals).sort((a, b) => catTotals[b] - catTotals[a]);

  // ---- Stat cards ----
  setStat('cbStatTotal', fmt(total));
  setStat('cbStatEntries', String(entries.length));
  setStat('cbStatAvg', fmt(entries.length ? total / entries.length : 0));
  setStat('cbStatTop', sortedCats.length ? `${catLabel(sortedCats[0])} (${fmt(catTotals[sortedCats[0]])})` : '—');

  // ---- Table ----
  if (sortedCats.length === 0) {
    body.innerHTML = '<tr><td colspan="4" style="text-align:center;opacity:.5;padding:20px;">No costs in this period.</td></tr>';
  } else {
    body.innerHTML = sortedCats.map(c => {
      const amt = catTotals[c];
      const pct = total > 0 ? (amt / total * 100) : 0;
      return `<tr>
        <td>${catLabel(c)}</td>
        <td class="num">${fmt(amt)}</td>
        <td class="num">${pct.toFixed(1)}%</td>
        <td class="num">${catCounts[c]}</td>
      </tr>`;
    }).join('');
  }

  // ---- Doughnut chart ----
  safeRenderChart('costBreakdownChart', () => {
    const colors = getChartColors();
    const ctx = $('costBreakdownChart').getContext('2d');
    const chartData = {
      labels: sortedCats.length ? sortedCats.map(catLabel) : ['No costs yet'],
      datasets: [{
        data: sortedCats.length ? sortedCats.map(c => Math.round(catTotals[c])) : [1],
        backgroundColor: sortedCats.length ? sortedCats.map((_, i) => CB_SLICE_COLORS[i % CB_SLICE_COLORS.length]) : ['#e5e7eb'],
        borderColor: 'transparent',
        hoverOffset: 8
      }]
    };
    if (costBreakdownChart) { costBreakdownChart.data = chartData; costBreakdownChart.update(); }
    else {
      costBreakdownChart = new Chart(ctx, {
        type: 'doughnut',
        data: chartData,
        options: {
          responsive: true, maintainAspectRatio: false, cutout: '62%',
          plugins: {
            legend: { position: 'right', labels: { boxWidth: 10, font: { size: 11, family: 'Inter' }, color: colors.text, usePointStyle: true, pointStyle: 'circle' } },
            tooltip: {
              callbacks: {
                label: (item) => {
                  const pct = total > 0 ? (item.parsed / total * 100).toFixed(1) : '0';
                  return ` ${item.label}: Rs. ${item.parsed.toLocaleString()} (${pct}%)`;
                }
              }
            }
          }
        }
      });
    }
  });

  const note = $('cbBreakdownNote');
  if (note) {
    const rangeLabel = $('cbRangePreset') && $('cbRangePreset').value === 'all' ? 'all recorded costs' : 'the selected period';
    note.textContent = `Showing ${rangeLabel} — pulled straight from Expenses; add or edit entries there and this updates automatically.`;
  }
}
window.renderCostBreakdown = renderCostBreakdown;

// Today's Grind→Output stat cards + the monthly trend chart, in the Costing
// tab's "Daily Costing & Trends" sub-tab. Reads the same dailyProductionLogCache
// that Production tab's Daily Production Log populates (umbalakada_ground_kg,
// kg_produced per log_date) — no separate fetch or table needed.
function renderCostingGrindOutputChart() {
  const groundEl = $('costingGrindTodayKg'), outputEl = $('costingOutputTodayKg'),
        yieldEl = $('costingYieldTodayPct'), noteEl = $('costingGrindOutputNote'),
        yieldCard = $('costingYieldTodayCard');
  if (!groundEl) return; // sub-tab not in the DOM (older cached HTML)

  const entries = dailyProductionLogCache || [];
  const todayEntry = entries.find(r => r.log_date === todayIso());

  const groundToday = Number(todayEntry?.umbalakada_ground_kg) || 0;
  const outputToday = Number(todayEntry?.kg_produced) || 0;
  const yieldToday = groundToday > 0 ? (outputToday / groundToday) * 100 : 0;

  groundEl.textContent = fmt2(groundToday) + ' kg';
  outputEl.textContent = fmt2(outputToday) + ' kg';
  yieldEl.textContent = fmt2(yieldToday) + '%';
  if (yieldCard) yieldCard.classList.toggle('bad', groundToday > 0 && yieldToday < 50);
  if (noteEl) {
    noteEl.textContent = todayEntry
      ? `From today's Daily Production Log entry — ${fmt2(groundToday)}kg ground in, ${fmt2(outputToday)}kg finished product out.`
      : 'No Daily Production Log entry for today yet — add one from the Production tab.';
  }

  // ---- Grind Breakdown by Fish Type (Today) ----
  // Prefer the split saved with that day's entry (accurate to that day's mix
  // ratio at save time); fall back to splitting groundToday with the CURRENT
  // mix ratio if the entry predates this feature (old rows won't have these
  // columns yet).
  const typeBody = $('costingGrindByTypeBody');
  if (typeBody) {
    const mixNow = getMixPct();
    const hasSavedSplit = todayEntry && (todayEntry.linna_ground_kg != null || todayEntry.balaya_ground_kg != null || todayEntry.premium_ground_kg != null);
    const typeRows = [
      { label: 'Linna', pct: mixNow.linna, kg: hasSavedSplit ? Number(todayEntry.linna_ground_kg) || 0 : groundToday * mixNow.linna },
      { label: 'Balaya', pct: mixNow.balaya, kg: hasSavedSplit ? Number(todayEntry.balaya_ground_kg) || 0 : groundToday * mixNow.balaya },
      { label: 'Premium Mix', pct: mixNow.kawalam, kg: hasSavedSplit ? Number(todayEntry.premium_ground_kg) || 0 : groundToday * mixNow.kawalam }
    ];
    typeBody.innerHTML = typeRows.map(t => `<tr><td>${t.label}</td><td class="num">${fmt2(t.pct * 100)}%</td><td class="num">${fmt2(t.kg)} kg</td></tr>`).join('');
  }

  // ---- Output by Product — Profit (Today), with Profitability Ranking ----
  // Qty comes from today's saved log (typed in the Production tab); cost,
  // MRP and profit are recalculated LIVE from current fish prices & mix —
  // same "always current" approach as the Dynamic Pricing table above.
  // Best/Worst badges only appear once at least 2 packs have qty > 0 today
  // — ranking a single product against itself isn't meaningful.
  const outBody = $('costingOutputByProductBody'), outTotalEl = $('costingOutputByProductTotal');
  if (outBody) {
    const mixNow = getMixPct();
    let grandTotalProfit = 0;
    const rowData = Object.keys(PACKS).map(key => {
      const p = PACKS[key];
      const qty = todayEntry ? (Number(todayEntry['output_qty_' + key]) || 0) : 0;
      let costPerPack = 0, profitPerPack = 0;
      try {
        const r = calculatePack(key, state.linnaPrice, state.balayaPrice, state.kawalamPrice, mixNow, 'mrp', 0, 0);
        costPerPack = r.totalCost;
        profitPerPack = r.profit;
      } catch (e) {}
      const lineProfit = profitPerPack * qty;
      grandTotalProfit += lineProfit;
      return { key, label: p.label, qty, costPerPack, profitPerPack, lineProfit };
    });
    const withQty = rowData.filter(r => r.qty > 0);
    const rankable = withQty.length >= 2;
    let bestKey = null, worstKey = null;
    if (rankable) {
      bestKey = withQty.reduce((m, r) => r.lineProfit > m.lineProfit ? r : m).key;
      worstKey = withQty.reduce((m, r) => r.lineProfit < m.lineProfit ? r : m).key;
    }
    outBody.innerHTML = rowData.map(r => {
      const badge = r.key === bestKey ? ' <span class="badge badge-good">🏆 Best</span>'
        : r.key === worstKey ? ' <span class="badge badge-bad">⚠️ Lowest</span>' : '';
      return `<tr><td>${r.label}${badge}</td><td class="num">${r.qty}</td><td class="num">${fmt(r.costPerPack)}</td><td class="num" style="color:${r.profitPerPack>=0?'#0a8f43':'#d45d55'};font-weight:700;">${fmt(r.profitPerPack)}</td><td class="num">${fmt(r.lineProfit)}</td></tr>`;
    }).join('');
    if (outTotalEl) {
      outTotalEl.textContent = withQty.length > 0
        ? `Total Profit from today's output (all packs): ${fmt(grandTotalProfit)} — recalculates instantly if fish prices or the mix ratio change.`
        : 'No pack quantities added for today yet — tap "Add Product" above, or enter them in the Production tab.';
    }
  }

  renderCostingWeekOverWeek();
  renderCostingAnomalyCheck();

  if (!$('costingGrindOutputChart')) return;
  const colors = getChartColors();
  safeRenderChart('costingGrindOutputChart', () => {
    const ctx = $('costingGrindOutputChart').getContext('2d');
    const sortedEntries = [...entries].sort((a, b) => a.log_date.localeCompare(b.log_date));
    const chartData = {
      labels: sortedEntries.map(r => r.log_date.slice(8, 10) + '/' + r.log_date.slice(5, 7)),
      datasets: [
        { type: 'bar', label: 'Umbalakada Ground (kg)', data: sortedEntries.map(r => Number(r.umbalakada_ground_kg) || 0), backgroundColor: 'rgba(251,146,60,0.55)', borderRadius: 4, order: 2 },
        { type: 'bar', label: 'Finished Output (kg)', data: sortedEntries.map(r => Number(r.kg_produced) || 0), backgroundColor: 'rgba(16,185,129,0.55)', borderRadius: 4, order: 2 },
        { type: 'line', label: 'Yield %', data: sortedEntries.map(r => {
            const g = Number(r.umbalakada_ground_kg) || 0, o = Number(r.kg_produced) || 0;
            return g > 0 ? Math.round((o / g) * 100) : 0;
          }), borderColor: 'rgba(56,189,248,1)', backgroundColor: 'rgba(56,189,248,0.1)', fill: false, tension: 0.3, pointRadius: 3, yAxisID: 'y1', order: 1 }
      ]
    };
    if (costingGrindOutputChart) { costingGrindOutputChart.data = chartData; costingGrindOutputChart.update(); }
    else {
      costingGrindOutputChart = new Chart(ctx, {
        type: 'bar',
        data: chartData,
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11, family: 'Inter' }, color: colors.text, padding: 12, usePointStyle: true, pointStyle: 'circle' } },
            tooltip: {
              callbacks: {
                label: (item) => item.dataset.label === 'Yield %' ? ` Yield: ${item.parsed.y}%` : ` ${item.dataset.label}: ${item.parsed.y.toLocaleString()} kg`
              }
            }
          },
          scales: {
            y: { position: 'left', grid: { color: colors.grid }, ticks: { color: colors.text, font: { size: 10 } }, title: { display: true, text: 'kg', color: colors.text, font: { size: 10 } } },
            y1: { position: 'right', min: 0, max: 100, grid: { display: false }, ticks: { color: colors.text, font: { size: 10 } }, title: { display: true, text: 'Yield %', color: colors.text, font: { size: 10 } } },
            x: { grid: { display: false }, ticks: { color: colors.text, font: { size: 10 } } }
          }
        }
      });
    }
  });
}
window.renderCostingGrindOutputChart = renderCostingGrindOutputChart;

// ==================== COSTING TAB — TODAY'S PURCHASE → BEST PACK ====================
// Pure live calculator, same spirit as the "Pricing & Scenarios" sub-tab —
// nothing is saved to Supabase here. Takes TODAY's actual multi-type
// Umbalakada purchase (Linna + Balaya + Premium, each optional, bought at
// different kg/price), an actual Grind Output (kg), auto-derives dust
// weight (Purchased − Grind Output), nets off any dust sale income + other
// costs, then prices EVERY pack size against that real Net Cost/kg and
// ranks them by PROFIT PER KG (not profit per pack, which would always
// favour the 1kg pack) so the "best" pack is a fair comparison.
let dpbMarketPriceOverride = {}; // { '50': 200, ... } — set only once the owner edits a cell

// Holds the last computed result from calcDailyPurchase() so
// saveDailyPurchaseEntry() can save exactly what's on screen without
// recomputing the whole calculator a second time. Set at the end of
// calcDailyPurchase(), read (not mutated) by the save function.
let lastDpbCalc = null;

function calcDailyPurchase() {
  const body = $('dpbBestPackBody');
  if (!body) return; // sub-tab not in the DOM (older cached HTML)

  const rows = [
    { key: 'Linna', qtyId: 'dpbQtyLinna', priceId: 'dpbPriceLinna', costId: 'dpbCostLinna', finField: 'finLinna' },
    { key: 'Balaya', qtyId: 'dpbQtyBalaya', priceId: 'dpbPriceBalaya', costId: 'dpbCostBalaya', finField: 'finBalaya' },
    { key: 'Premium Mix', qtyId: 'dpbQtyPremium', priceId: 'dpbPricePremium', costId: 'dpbCostPremium', finField: 'finKawalam' }
  ];

  let totalKg = 0, totalRawCost = 0, weightedFinPriceSum = 0;
  rows.forEach(r => {
    const qty = Number($(r.qtyId).value) || 0;
    const price = Number($(r.priceId).value) || 0;
    const cost = qty * price;
    totalKg += qty;
    totalRawCost += cost;
    // Finished/market price per kg for this type comes straight from the
    // Production tab's "Finished Umbalakada Market Prices" fields, so this
    // stays in sync without duplicating those numbers here.
    const finEl = $(r.finField);
    const finPrice = finEl ? (Number(finEl.value) || 0) : 0;
    weightedFinPriceSum += qty * finPrice;
    const costEl = $(r.costId);
    if (costEl) costEl.textContent = fmt(cost);
  });

  $('dpbTotalKg').textContent = fmt2(totalKg) + ' kg';
  $('dpbTotalCost').textContent = fmt(totalRawCost);

  // Grind Output is no longer typed in by hand — it's auto-calculated from
  // today's purchase qty per type × that type's Grinding Yield % (set on
  // the Costing tab, getGrindYields()). The field itself is now read-only
  // and just displays this computed number.
  const gyToday = getGrindYields();
  const qtyLinna = Number($('dpbQtyLinna').value) || 0;
  const qtyBalaya = Number($('dpbQtyBalaya').value) || 0;
  const qtyPremium = Number($('dpbQtyPremium').value) || 0;
  const grindOutputKg = Math.round(
    (qtyLinna * gyToday.linna + qtyBalaya * gyToday.balaya + qtyPremium * gyToday.premium) * 100
  ) / 100;
  const grindOutputEl = $('dpbGrindOutputKg');
  if (grindOutputEl) grindOutputEl.value = grindOutputKg;

  const dustRecoveredKgRaw = Number($('dpbDustRecoveredKg').value) || 0;
  const dustSalePrice = Number($('dpbDustSalePrice').value) || 0;
  const dustReusedKgRaw = Number($('dpbDustReusedKg').value) || 0;
  const otherCosts = Number($('dpbOtherCosts').value) || 0;

  const dustKg = totalKg - grindOutputKg; // auto-derived, not entered
  const dustPct = totalKg > 0 ? (dustKg / totalKg) * 100 : 0;
  const dustAvailable = Math.max(dustKg, 0);

  // Dust can be split three ways: reused back into the product, sold off
  // separately, or wasted. Reused + Sold can never exceed the dust that
  // actually exists — cap them (reused first, sold from what's left) so the
  // three numbers always add up cleanly.
  const dustReusedKg = Math.min(Math.max(dustReusedKgRaw, 0), dustAvailable);
  const dustRecoveredKg = Math.min(Math.max(dustRecoveredKgRaw, 0), Math.max(dustAvailable - dustReusedKg, 0));
  const dustWastedKg = Math.max(dustAvailable - dustReusedKg - dustRecoveredKg, 0);

  const dustWarnEl = $('dpbDustWarning');
  if (dustWarnEl) {
    if (grindOutputKg > totalKg && totalKg > 0) {
      dustWarnEl.style.display = 'block';
      dustWarnEl.textContent = `⚠️ Grind Output (${fmt2(grindOutputKg)}kg) can't be more than what you bought (${fmt2(totalKg)}kg) — check the numbers above.`;
    } else if ((dustReusedKgRaw + dustRecoveredKgRaw) > dustAvailable && dustAvailable > 0) {
      dustWarnEl.style.display = 'block';
      dustWarnEl.textContent = `⚠️ Dust Reused (${fmt2(dustReusedKgRaw)}kg) + Dust Sold (${fmt2(dustRecoveredKgRaw)}kg) is more than the ${fmt2(dustAvailable)}kg of dust you actually have — capped to fit.`;
    } else {
      dustWarnEl.style.display = 'none';
    }
  }

  // Reused dust is mixed straight back into the packs, so it adds directly
  // to the sellable/usable output — it dilutes cost per kg exactly the way
  // real reused dust would.
  const usableOutputKg = grindOutputKg + dustReusedKg;
  const dustIncome = dustRecoveredKg * dustSalePrice;
  const grossCost = totalRawCost + otherCosts;
  const netCost = grossCost - dustIncome;
  const costPerKgUsable = usableOutputKg > 0 ? netCost / usableOutputKg : 0;
  const weightedFinPricePerKg = totalKg > 0 ? weightedFinPriceSum / totalKg : 0;

  // Full Profit = what selling all of today's usable output at market price
  // brings in, minus everything it cost (raw material + other costs),
  // plus whatever the recovered dust sold for. Product Profit and Dust
  // Profit are just that same total split into two labelled pieces — Dust
  // Profit never gets double-subtracted from Product Profit.
  const productRevenue = usableOutputKg * weightedFinPricePerKg;
  const fullProfitToday = productRevenue - grossCost + dustIncome;
  const dustProfitToday = dustIncome;
  const productProfitToday = fullProfitToday - dustProfitToday;

  $('dpbStatPurchased').textContent = fmt2(totalKg) + ' kg';
  $('dpbStatOutput').textContent = fmt2(grindOutputKg) + ' kg';
  $('dpbStatDust').textContent = fmt2(dustAvailable) + ' kg (' + fmt2(Math.max(dustPct, 0)) + '%)';
  $('dpbStatNetCostPerKg').textContent = fmt(costPerKgUsable);

  const dustReusedEl = $('dpbStatDustReused'); if (dustReusedEl) dustReusedEl.textContent = fmt2(dustReusedKg) + ' kg';
  const dustSoldEl = $('dpbStatDustSold'); if (dustSoldEl) dustSoldEl.textContent = fmt2(dustRecoveredKg) + ' kg';
  const dustWastedEl = $('dpbStatDustWasted'); if (dustWastedEl) dustWastedEl.textContent = fmt2(dustWastedKg) + ' kg';
  const usableOutputEl = $('dpbStatUsableOutput'); if (usableOutputEl) usableOutputEl.textContent = fmt2(usableOutputKg) + ' kg';

  const productProfitEl = $('dpbStatProductProfit'); if (productProfitEl) productProfitEl.textContent = fmt(productProfitToday);
  const dustProfitEl = $('dpbStatDustProfit'); if (dustProfitEl) dustProfitEl.textContent = fmt(dustProfitToday);
  const fullProfitEl = $('dpbStatFullProfit'); if (fullProfitEl) fullProfitEl.textContent = fmt(fullProfitToday);

  if (usableOutputKg <= 0 || totalKg <= 0) {
    body.innerHTML = `<tr><td colspan="7" style="text-align:center;opacity:.5;padding:16px;">Enter today's purchase and Grind Output above.</td></tr>`;
    $('dpbBestPackNote').textContent = 'Enter today\'s purchase and grind output above to see the best pack.';
    return;
  }

  // Cost/pack = this pack's share of the raw+dust-net cost + the same
  // grinding-labour & packaging-cost assumptions used on the Pricing &
  // Scenarios sub-tab (PACKS[key].grind / .pack), so numbers stay consistent
  // across sub-tabs.
  const packRows = Object.keys(PACKS).map(key => {
    const p = PACKS[key];
    const grams = Number(key);
    const rawShare = costPerKgUsable * (grams / 1000);
    const costPerPack = rawShare + p.grind + p.pack;

    const defaultMarketPrice = weightedFinPricePerKg > 0 ? weightedFinPricePerKg * (grams / 1000) : p.mrp;
    const marketPrice = (dpbMarketPriceOverride[key] != null) ? dpbMarketPriceOverride[key] : defaultMarketPrice;

    const profit = marketPrice - costPerPack;
    const margin = marketPrice > 0 ? (profit / marketPrice) * 100 : 0;
    const profitPerKg = grams > 0 ? profit / (grams / 1000) : 0;

    return { key, label: p.label, costPerPack, marketPrice, profit, margin, profitPerKg };
  });

  const bestKey = packRows.reduce((best, r) => (r.profitPerKg > best.profitPerKg ? r : best), packRows[0]).key;

  body.innerHTML = packRows.map(r => {
    const isBest = r.key === bestKey;
    const verdict = isBest
      ? '<span class="badge badge-good">⭐ Best Pack</span>'
      : (r.profit >= 0 ? '<span class="badge badge-good">Profit</span>' : '<span class="badge badge-bad">Loss</span>');
    return `<tr${isBest ? ' style="background:rgba(14,164,114,.07);"' : ''}>
      <td>${r.label}</td>
      <td class="num">${fmt(r.costPerPack)}</td>
      <td class="num"><input type="number" class="editable-sp" value="${r.marketPrice.toFixed(2)}" style="width:90px;min-height:32px;text-align:right;" onchange="setDpbMarketPrice('${r.key}',this.value)"></td>
      <td class="num"><span class="badge ${r.profit>=0?'badge-good':'badge-bad'}">${fmt(r.profit)}</span></td>
      <td class="num">${fmt2(r.margin)}%</td>
      <td class="num">${fmt(r.profitPerKg)}</td>
      <td>${verdict}</td>
    </tr>`;
  }).join('');

  const bestRow = packRows.find(r => r.key === bestKey);
  $('dpbBestPackNote').textContent = `From today's purchase: ${bestRow.label} gives the best profit at ${fmt(bestRow.profitPerKg)}/kg (${fmt(bestRow.profit)}/pack, ${fmt2(bestRow.margin)}% margin). Market prices are editable per pack above.`;

  // Snapshot everything needed to save this exact calculation as a history
  // row — see saveDailyPurchaseEntry().
  lastDpbCalc = {
    qtyLinna, priceLinna: Number($('dpbPriceLinna').value) || 0,
    qtyBalaya, priceBalaya: Number($('dpbPriceBalaya').value) || 0,
    qtyPremium, pricePremium: Number($('dpbPricePremium').value) || 0,
    totalKg, totalCost: totalRawCost,
    avgPricePerKg: totalKg > 0 ? totalRawCost / totalKg : 0,
    grindOutputKg, dustRecoveredKg, dustSalePrice, dustReusedKg, dustWastedKg,
    otherCosts, netCostPerKg: costPerKgUsable, usableOutputKg,
    productProfit: productProfitToday, dustProfit: dustProfitToday, fullProfit: fullProfitToday,
    bestPackKey: bestRow.key, bestPackLabel: bestRow.label, bestPackProfitPerKg: bestRow.profitPerKg
  };
}
window.calcDailyPurchase = calcDailyPurchase;

function setDpbMarketPrice(key, value) {
  dpbMarketPriceOverride[key] = Number(value) || 0;
  calcDailyPurchase();
}
window.setDpbMarketPrice = setDpbMarketPrice;

// ==================== TODAY'S PURCHASE — SAVE & HISTORY ====================
// Every "Save / Update Today's Entry" click INSERTS a new row into
// daily_purchase_log (not an upsert-per-date) so the owner can save several
// updates in one day — e.g. bought Linna in the morning at one price, then
// a second round in the afternoon at another — and the History table below
// becomes a real timeline of every purchase/price change, not just one
// snapshot per date.
//
// Run this SQL once in the Supabase SQL editor to enable this feature:
//
//   create table if not exists daily_purchase_log (
//     id uuid primary key default gen_random_uuid(),
//     owner_id uuid not null references auth.users(id) on delete cascade,
//     log_date date not null,
//     qty_linna numeric default 0, price_linna numeric default 0,
//     qty_balaya numeric default 0, price_balaya numeric default 0,
//     qty_premium numeric default 0, price_premium numeric default 0,
//     total_kg numeric default 0, total_cost numeric default 0,
//     avg_price_per_kg numeric default 0,
//     grind_output_kg numeric default 0,
//     dust_recovered_kg numeric default 0, dust_sale_price numeric default 0,
//     dust_reused_kg numeric default 0, dust_wasted_kg numeric default 0,
//     other_costs numeric default 0,
//     net_cost_per_kg numeric default 0, usable_output_kg numeric default 0,
//     product_profit numeric default 0, dust_profit numeric default 0, full_profit numeric default 0,
//     best_pack_key text, best_pack_label text, best_pack_profit_per_kg numeric default 0,
//     note text, created_by uuid, created_at timestamptz default now()
//   );
//   alter table daily_purchase_log enable row level security;
//   create policy "owner reads own purchase log" on daily_purchase_log
//     for select using (owner_id = auth.uid());
//   create policy "owner writes own purchase log" on daily_purchase_log
//     for insert with check (owner_id = auth.uid());
//   create policy "owner deletes own purchase log" on daily_purchase_log
//     for delete using (owner_id = auth.uid());

let dailyPurchaseLogCache = [];

async function loadDailyPurchaseLog() {
  if (!currentUser || userRole !== 'owner') { dailyPurchaseLogCache = []; return dailyPurchaseLogCache; }
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const { data, error } = await withSessionRetry(() => supabase.from('daily_purchase_log')
      .select('*').eq('owner_id', currentUser.id).gte('log_date', cutoff.toISOString().slice(0, 10))
      .order('created_at', { ascending: false }));
    if (error) throw error;
    dailyPurchaseLogCache = data || [];
  } catch (e) {
    console.warn('Daily purchase log load skipped:', e?.message || e);
    dailyPurchaseLogCache = [];
  }
  return dailyPurchaseLogCache;
}
window.loadDailyPurchaseLog = loadDailyPurchaseLog;

async function saveDailyPurchaseEntry() {
  if (userRole !== 'owner') { alert('Only the owner can save purchase entries.'); return; }
  if (!currentUser) { alert('Please login first.'); return; }

  // Make sure lastDpbCalc reflects exactly what's on screen right now.
  calcDailyPurchase();
  const c = lastDpbCalc;
  if (!c || c.totalKg <= 0) { alert('Enter today\'s purchase (qty & price) above before saving.'); return; }

  const logDateEl = $('dpbLogDate');
  const logDate = (logDateEl && logDateEl.value) ? logDateEl.value : todayIso();
  const note = ($('dpbLogNote') && $('dpbLogNote').value.trim()) || null;

  const row = {
    owner_id: currentUser.id,
    log_date: logDate,
    qty_linna: c.qtyLinna, price_linna: c.priceLinna,
    qty_balaya: c.qtyBalaya, price_balaya: c.priceBalaya,
    qty_premium: c.qtyPremium, price_premium: c.pricePremium,
    total_kg: c.totalKg, total_cost: c.totalCost, avg_price_per_kg: c.avgPricePerKg,
    grind_output_kg: c.grindOutputKg,
    dust_recovered_kg: c.dustRecoveredKg, dust_sale_price: c.dustSalePrice,
    dust_reused_kg: c.dustReusedKg, dust_wasted_kg: c.dustWastedKg,
    other_costs: c.otherCosts,
    net_cost_per_kg: c.netCostPerKg, usable_output_kg: c.usableOutputKg,
    product_profit: c.productProfit, dust_profit: c.dustProfit, full_profit: c.fullProfit,
    best_pack_key: String(c.bestPackKey), best_pack_label: c.bestPackLabel, best_pack_profit_per_kg: c.bestPackProfitPerKg,
    note, created_by: currentUser.id
  };

  if (!(await ensureFreshSession())) return;
  try {
    const { data, error } = await supabase.from('daily_purchase_log').insert(row).select().single();
    if (error) throw error;
    dailyPurchaseLogCache.unshift(data);
    if ($('dpbLogNote')) $('dpbLogNote').value = '';
    renderDailyPurchaseHistory();
    syncUmbalakadaGroundFromPurchaseLog(); // push straight into the Daily Production Log in real time
    updateStatus('✅ Purchase entry saved to history — Daily Production Log updated automatically');
  } catch (e) {
    console.error('Save daily purchase entry error:', e);
    const missingTable = /relation .* does not exist/i.test(e?.message || '');
    alert('❌ Could not save entry: ' + (e?.message || String(e)) + (missingTable ? '\n\nThe daily_purchase_log table hasn\'t been created in Supabase yet — run the SQL setup in the comment above saveDailyPurchaseEntry() in app.js.' : ''));
  }
}
window.saveDailyPurchaseEntry = saveDailyPurchaseEntry;

async function deleteDailyPurchaseEntry(id) {
  if (userRole !== 'owner') return;
  if (!confirm('Delete this saved purchase entry?')) return;
  try {
    const { error } = await withSessionRetry(() => supabase.from('daily_purchase_log').delete().eq('id', id).eq('owner_id', currentUser.id));
    if (error) throw error;
    dailyPurchaseLogCache = dailyPurchaseLogCache.filter(r => String(r.id) !== String(id));
    renderDailyPurchaseHistory();
    syncUmbalakadaGroundFromPurchaseLog(); // re-sync in case today's entry was removed
    updateStatus('🗑️ Purchase entry deleted');
  } catch (e) {
    alert('❌ Could not delete entry: ' + (e?.message || String(e)));
  }
}
window.deleteDailyPurchaseEntry = deleteDailyPurchaseEntry;

let dpbHistoryChart = null;

function renderDailyPurchaseHistory() {
  const body = $('dpbHistoryBody');
  if (!body) return; // sub-tab not in the DOM (older cached HTML)

  // Cache comes back newest-first (created_at desc) — keep that order for
  // the table, but chronological (oldest-first) for the trend chart.
  const entries = dailyPurchaseLogCache || [];

  const typeCell = (qty, price) => (Number(qty) > 0)
    ? `${fmt2(Number(qty))}kg @ ${fmt(Number(price))}`
    : '—';

  if (entries.length === 0) {
    body.innerHTML = `<tr><td colspan="10" style="text-align:center;opacity:.5;padding:16px;">No saved entries yet.</td></tr>`;
    $('dpbHistoryNote').textContent = 'No saved entries yet — use "Save / Update Today\'s Entry" above to start your history.';
  } else {
    body.innerHTML = entries.map(e => {
      const when = e.created_at ? new Date(e.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : e.log_date;
      return `<tr>
        <td>${when}${e.note ? `<br><span style="opacity:.6;font-size:.85em;">${e.note}</span>` : ''}</td>
        <td>${typeCell(e.qty_linna, e.price_linna)}</td>
        <td>${typeCell(e.qty_balaya, e.price_balaya)}</td>
        <td>${typeCell(e.qty_premium, e.price_premium)}</td>
        <td class="num">${fmt2(Number(e.total_kg) || 0)} kg</td>
        <td class="num">${fmt(Number(e.avg_price_per_kg) || 0)}</td>
        <td class="num" style="font-weight:700;">${fmt(Number(e.net_cost_per_kg) || 0)}</td>
        <td>${e.best_pack_label || '—'}</td>
        <td class="num"><span class="badge ${Number(e.full_profit) >= 0 ? 'badge-good' : 'badge-bad'}">${fmt(Number(e.full_profit) || 0)}</span></td>
        <td><button type="button" class="btn btn-xs btn-danger" onclick="deleteDailyPurchaseEntry('${e.id}')"><i class="business-icon icon-inline" data-lucide="trash-2" aria-hidden="true"></i></button></td>
      </tr>`;
    }).join('');
    $('dpbHistoryNote').textContent = `${entries.length} saved entr${entries.length === 1 ? 'y' : 'ies'} in the last 30 days.`;
  }

  // Summary stat cards — "1kg price and other details" at a glance.
  const latest = entries[0] || null;
  const previous = entries[1] || null;
  $('dpbHistLastRawPrice').textContent = latest ? fmt(Number(latest.avg_price_per_kg) || 0) : '—';
  $('dpbHistLastNetCost').textContent = latest ? fmt(Number(latest.net_cost_per_kg) || 0) : '—';

  const trendEl = $('dpbHistTrend'), trendCard = $('dpbHistTrendCard');
  if (latest && previous) {
    const diff = (Number(latest.net_cost_per_kg) || 0) - (Number(previous.net_cost_per_kg) || 0);
    const arrow = diff > 0 ? '▲' : (diff < 0 ? '▼' : '—');
    trendEl.textContent = `${arrow} ${fmt(Math.abs(diff))}/kg`;
    if (trendCard) trendCard.className = 'stat ' + (diff > 0 ? 'bad' : (diff < 0 ? 'good' : ''));
  } else {
    trendEl.textContent = '—';
    if (trendCard) trendCard.className = 'stat';
  }

  const sevenDaysAgo = new Date(); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const last7d = entries.filter(e => e.log_date >= sevenDaysAgo.toISOString().slice(0, 10));
  const avg7d = last7d.length > 0
    ? last7d.reduce((sum, e) => sum + (Number(e.net_cost_per_kg) || 0), 0) / last7d.length
    : 0;
  $('dpbHist7dAvg').textContent = last7d.length > 0 ? fmt(avg7d) : '—';

  // Trend chart — Net Cost/kg over time, oldest to newest.
  if (!$('dpbHistoryChart')) return;
  const colors = getChartColors();
  safeRenderChart('dpbHistoryChart', () => {
    const ctx = $('dpbHistoryChart').getContext('2d');
    const chronological = [...entries].reverse();
    const chartData = {
      labels: chronological.map(e => e.created_at ? new Date(e.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' }) : e.log_date),
      datasets: [
        { label: 'Net Cost/kg (usable)', data: chronological.map(e => Number(e.net_cost_per_kg) || 0), borderColor: 'rgba(56,189,248,1)', backgroundColor: 'rgba(56,189,248,0.12)', fill: true, tension: 0.3, pointRadius: 3 },
        { label: 'Blended Price/kg (raw)', data: chronological.map(e => Number(e.avg_price_per_kg) || 0), borderColor: 'rgba(251,146,60,1)', backgroundColor: 'rgba(251,146,60,0.08)', fill: false, tension: 0.3, pointRadius: 3 }
      ]
    };
    if (dpbHistoryChart) { dpbHistoryChart.data = chartData; dpbHistoryChart.update(); }
    else {
      dpbHistoryChart = new Chart(ctx, {
        type: 'line',
        data: chartData,
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11, family: 'Inter' }, color: colors.text, padding: 12, usePointStyle: true, pointStyle: 'circle' } },
            tooltip: { callbacks: { label: (item) => ` ${item.dataset.label}: Rs. ${item.parsed.y.toLocaleString()}` } }
          },
          scales: {
            y: { grid: { color: colors.grid }, ticks: { color: colors.text, font: { size: 10 } }, title: { display: true, text: 'Rs./kg', color: colors.text, font: { size: 10 } } },
            x: { grid: { display: false }, ticks: { color: colors.text, font: { size: 10 } } }
          }
        }
      });
    }
  });
}
window.renderDailyPurchaseHistory = renderDailyPurchaseHistory;

// ==================== COSTING TAB — QUICK MARKET DECISION ====================
// For standing AT the market, before any actual grinding has happened.
// Estimates usable output/dust from weight offered using the Grinding
// Yield % already saved on the Pricing & Scenarios sub-tab (getGrindYields()
// — same source of truth as calculatePack()), so this needs no new inputs
// the owner hasn't already set once. The Mix Variation table reuses
// calculatePack()/PACKS directly — zero duplicated pricing logic.
const QM_MIX_PRESETS = [
  { label: '40% Linna / 0% Balaya / 60% Premium', mix: { linna: 0.40, balaya: 0.00, kawalam: 0.60 } },
  { label: '60% Linna / 0% Balaya / 40% Premium', mix: { linna: 0.60, balaya: 0.00, kawalam: 0.40 } },
  { label: '35% Linna / 20% Balaya / 45% Premium', mix: { linna: 0.35, balaya: 0.20, kawalam: 0.45 } },
  { label: '25% Linna / 15% Balaya / 60% Premium', mix: { linna: 0.25, balaya: 0.15, kawalam: 0.60 } },
  { label: '20% Linna / 40% Balaya / 40% Premium', mix: { linna: 0.20, balaya: 0.40, kawalam: 0.40 } }
];

let lastQmEstOutputKg = 0, lastQmEstDustKg = 0, lastQmTotalWeightKg = 0;

function calcQuickMarket() {
  const body = $('qmMixVariationBody');
  if (!body) return; // sub-tab not in the DOM (older cached HTML)

  const unit = $('qmUnit').value || 'kg';
  const unitDivisor = unit === 'g' ? 1000 : 1; // convert entered weight to kg
  const unitLabel = unit === 'g' ? 'g' : 'kg';
  const headerEl = $('qmUnitHeader');
  if (headerEl) headerEl.textContent = unitLabel;

  const gy = getGrindYields(); // { linna, balaya, premium } as fractions, e.g. 0.8
  const rows = [
    { key: 'Linna', qtyId: 'qmQtyLinna', priceId: 'qmPriceLinna', costId: 'qmCostLinna', outId: 'qmOutLinna', yield: gy.linna },
    { key: 'Balaya', qtyId: 'qmQtyBalaya', priceId: 'qmPriceBalaya', costId: 'qmCostBalaya', outId: 'qmOutBalaya', yield: gy.balaya },
    { key: 'Premium Mix', qtyId: 'qmQtyPremium', priceId: 'qmPricePremium', costId: 'qmCostPremium', outId: 'qmOutPremium', yield: gy.premium }
  ];

  let totalWeightKg = 0, totalCost = 0, totalOutputKg = 0;
  rows.forEach(r => {
    const enteredQty = Number($(r.qtyId).value) || 0;
    const price = Number($(r.priceId).value) || 0;
    const qtyKg = enteredQty / unitDivisor;
    const cost = qtyKg * price;
    const outputKg = qtyKg * r.yield;
    totalWeightKg += qtyKg;
    totalCost += cost;
    totalOutputKg += outputKg;
    const costEl = $(r.costId), outEl = $(r.outId);
    if (costEl) costEl.textContent = fmt(cost);
    if (outEl) outEl.textContent = fmt2(outputKg) + ' kg';
  });

  const dustKg = Math.max(totalWeightKg - totalOutputKg, 0);
  const costPerKgUsable = totalOutputKg > 0 ? totalCost / totalOutputKg : 0;

  lastQmTotalWeightKg = totalWeightKg;
  lastQmEstOutputKg = totalOutputKg;
  lastQmEstDustKg = dustKg;

  $('qmStatTotalWeight').textContent = fmt2(totalWeightKg) + ' kg';
  $('qmStatTotalCost').textContent = fmt(totalCost);
  $('qmStatEstOutput').textContent = fmt2(totalOutputKg) + ' kg';
  $('qmStatEstDust').textContent = fmt2(dustKg) + ' kg';
  $('qmStatCostPerKg').textContent = fmt(costPerKgUsable);

  // ---- Mix Variation Comparison — independent of the weight entered above,
  // this always compares TODAY's fish prices (Pricing & Scenarios sub-tab)
  // across every preset mix & pack size, so it's useful even with 0kg typed
  // in (e.g. deciding what to ask for before a price is even quoted). If
  // prices ARE entered above for a type, they override the saved Raw
  // Materials price for that type only, so the comparison reflects what's
  // actually on offer right now.
  const priceOverride = {
    linna: (Number($('qmPriceLinna').value) || 0) || state.linnaPrice,
    balaya: (Number($('qmPriceBalaya').value) || 0) || state.balayaPrice,
    kawalam: (Number($('qmPricePremium').value) || 0) || state.kawalamPrice
  };

  let overallBest = null;
  const mixRows = QM_MIX_PRESETS.map(preset => {
    let bestForMix = null;
    Object.keys(PACKS).forEach(key => {
      let r;
      try {
        r = calculatePack(key, priceOverride.linna, priceOverride.balaya, priceOverride.kawalam, preset.mix, 'mrp', 0, 0);
      } catch (e) { return; }
      const usableKg = r.p.fish / 1000;
      const profitPerKg = usableKg > 0 ? r.profit / usableKg : 0;
      const costPerKg = usableKg > 0 ? r.totalCost / usableKg : 0;
      const candidate = { packLabel: r.p.label, costPerKg, profitPerKg, margin: r.margin };
      if (!bestForMix || candidate.profitPerKg > bestForMix.profitPerKg) bestForMix = candidate;
    });
    const row = { mixLabel: preset.label, ...bestForMix };
    if (!overallBest || row.profitPerKg > overallBest.profitPerKg) overallBest = row;
    return row;
  });

  body.innerHTML = mixRows.map(r => {
    const isBest = overallBest && r.mixLabel === overallBest.mixLabel && r.packLabel === overallBest.packLabel;
    const verdict = isBest ? '<span class="badge badge-good">⭐ Best Right Now</span>' : (r.profitPerKg >= 0 ? '<span class="badge badge-good">Profit</span>' : '<span class="badge badge-bad">Loss</span>');
    return `<tr${isBest ? ' style="background:rgba(14,164,114,.07);"' : ''}>
      <td>${r.mixLabel}</td>
      <td>${r.packLabel}</td>
      <td class="num">${fmt(r.costPerKg)}</td>
      <td class="num">${fmt(r.profitPerKg)}</td>
      <td class="num">${fmt2(r.margin)}%</td>
      <td>${verdict}</td>
    </tr>`;
  }).join('');

  if (overallBest) {
    $('qmOverallBestNote').textContent = `Right now, the ${overallBest.mixLabel} mix packed as ${overallBest.packLabel} gives the best profit: ${fmt(overallBest.profitPerKg)}/kg (${fmt2(overallBest.margin)}% margin).`;
  }
}
window.calcQuickMarket = calcQuickMarket;

// Pre-fills the Production tab's existing Daily Production Log fields with
// this session's estimated totals, then jumps there so the owner can review
// (and adjust once actual grinding is done) before hitting that tab's own
// "Save Today's Snapshot" — this never saves to Supabase by itself.
function sendQuickMarketToProduction() {
  if (lastQmTotalWeightKg <= 0) { alert('Enter a weight above first.'); return; }
  calcQuickMarket();
  if ($('dpUmbalakadaGroundKg')) $('dpUmbalakadaGroundKg').value = fmt2(lastQmTotalWeightKg);
  if ($('dpDustGeneratedKg')) $('dpDustGeneratedKg').value = fmt2(lastQmEstDustKg);
  if ($('dpKgProduced')) $('dpKgProduced').value = fmt2(lastQmEstOutputKg);
  updateDailyProductionSummaryLive();
  if (typeof activateAppTab === 'function') activateAppTab('production');
  updateStatus('📦 Estimated output sent to Daily Production Log — review & click "Save Today\'s Snapshot" there.');
}
window.sendQuickMarketToProduction = sendQuickMarketToProduction;

// ==================== COSTING TAB — ORDER → WHAT TO BUY ====================
// Reverse of Quick Market Decision: given an ORDER (pack size + qty),
// answers "how much of each type do I need to buy". Reuses calculatePack()
// per pack, then scales its per-pack raw-weight/cost numbers by the order
// qty — no separate math, so this always agrees with every other sub-tab.
function calcOrderToBuy() {
  const body = $('obBuyBody');
  if (!body) return; // sub-tab not in the DOM (older cached HTML)

  const packSize = $('obPackSize').value;
  const qty = Number($('obQty').value) || 0;
  const mixChoice = $('obMix').value;

  let mix, mixLabel;
  if (mixChoice === 'auto') {
    // Pick whichever of the 5 preset mixes is most profitable for THIS
    // pack size at today's prices — same presets as Quick Market Decision.
    let best = null;
    QM_MIX_PRESETS.forEach(preset => {
      let r;
      try {
        r = calculatePack(packSize, state.linnaPrice, state.balayaPrice, state.kawalamPrice, preset.mix, 'mrp', 0, 0);
      } catch (e) { return; }
      if (!best || r.profit > best.profit) best = { preset, r };
    });
    mix = best ? best.preset.mix : QM_MIX_PRESETS[0].mix;
    mixLabel = best ? best.preset.label : QM_MIX_PRESETS[0].label;
  } else {
    const preset = QM_MIX_PRESETS[Number(mixChoice)] || QM_MIX_PRESETS[0];
    mix = preset.mix;
    mixLabel = preset.label;
  }

  $('obMixNote').textContent = mixChoice === 'auto'
    ? `🏆 Auto-picked for best profit on this pack size: ${mixLabel}`
    : `Using: ${mixLabel}`;

  let r;
  try {
    r = calculatePack(packSize, state.linnaPrice, state.balayaPrice, state.kawalamPrice, mix, 'mrp', 0, 0);
  } catch (e) { return; }

  const typeRows = [
    { label: 'Linna', rawKg: (r.linnaRawG / 1000) * qty, price: state.linnaPrice, cost: r.linnaCost * qty },
    { label: 'Balaya', rawKg: (r.balayaRawG / 1000) * qty, price: state.balayaPrice, cost: r.balayaCost * qty },
    { label: 'Premium Mix', rawKg: (r.premiumRawG / 1000) * qty, price: state.kawalamPrice, cost: r.premiumCost * qty }
  ];

  body.innerHTML = typeRows.map(t => `<tr>
    <td><strong>${t.label}</strong></td>
    <td class="num">${fmt2(t.rawKg)} kg</td>
    <td class="num">${fmt(t.price)}</td>
    <td class="num">${fmt(t.cost)}</td>
  </tr>`).join('');

  const totalKg = typeRows.reduce((a, t) => a + t.rawKg, 0);
  const totalRawCost = typeRows.reduce((a, t) => a + t.cost, 0);
  $('obTotalKg').textContent = fmt2(totalKg) + ' kg';
  $('obTotalRawCost').textContent = fmt(totalRawCost);

  const totalCost = r.totalCost * qty;
  const revenue = r.sp * qty;
  const profit = r.profit * qty;

  $('obStatTotalCost').textContent = fmt(totalCost);
  $('obStatRevenue').textContent = fmt(revenue);
  $('obStatProfit').textContent = fmt(profit);
  $('obStatMargin').textContent = fmt2(r.margin) + '%';
  const profitStatEl = $('obStatProfit') && $('obStatProfit').closest('.stat');
  if (profitStatEl) profitStatEl.classList.toggle('bad', profit < 0);
}
window.calcOrderToBuy = calcOrderToBuy;

// ==================== COSTING TAB — "ADD PRODUCT" BATCH LOG (today's pack output) ====================
// Lets the owner log today's pack output right from the Costing tab's
// "Output by Product" card — ADDITIVELY. Each "Add Batch" inserts its own
// row into daily_product_batches (a separate table, one row per batch, as
// many batches/day as you like). The sum of today's batches is then written
// to production_cost_log.output_qty_* via a partial upsert (only those
// columns — grind/dust/cost fields already saved for today are untouched).
// NOTE: the Production tab's "Daily Production Log" → "Save Today's
// Snapshot" still writes output_qty_* directly from its own manual fields —
// if that's saved AFTER batches were added here, it will overwrite the
// batch-computed total for today with whatever's typed there. Use one or
// the other for a given day to avoid the two fighting over today's total.
let dailyProductBatchesCache = [];

// ==================== PACK → STORE PRODUCT LINKING + DAILY STORE ====================
// Bridges "how much did I produce today" (Daily Production Log / batches,
// above) with the real Product catalog's Stock (Products tab). Nothing new
// in Supabase is needed — the mapping lives in state.packProductMap (synced
// via the existing app_data blob), and stock changes go through the SAME
// applyStockMovement()/adjust_product_stock() RPC the Restock/Adjust Stock
// buttons already use on the Products tab.
function populatePackProductMapSelects() {
  Object.keys(PACKS).forEach(key => {
    const sel = $('ppmMap' + key);
    if (!sel) return;
    const current = (state.packProductMap && state.packProductMap[key]) || '';
    sel.innerHTML = '<option value="">— Not linked —</option>' +
      (products || []).map(p => `<option value="${p.id}">${p.name}</option>`).join('');
    sel.value = current;
  });
}
window.populatePackProductMapSelects = populatePackProductMapSelects;

function onPackProductMapChange() {
  if (!state.packProductMap) state.packProductMap = {};
  Object.keys(PACKS).forEach(key => {
    const sel = $('ppmMap' + key);
    if (sel) state.packProductMap[key] = sel.value;
  });
  onDataChange();
  renderDailyStoreHistory();
}
window.onPackProductMapChange = onPackProductMapChange;

// For each pack size in qtyByKey with qty > 0 and a linked product, moves
// that qty of Stock (sign=+1 for a batch added, -1 to reverse one deleted).
// Silently skips unlinked sizes — never blocks the batch save/delete itself.
async function applyPackBatchStockMovements(qtyByKey, note, sign) {
  const map = state.packProductMap || {};
  for (const key of Object.keys(PACKS)) {
    const qty = Number(qtyByKey[key]) || 0;
    const productId = map[key];
    if (qty > 0 && productId) {
      await applyStockMovement(productId, qty * sign, 'production', note || `${PACKS[key].label} — daily production`);
    }
  }
}

// Day-by-day table on the Daily Costing & Trends sub-tab — reuses
// dailyProductionLogCache (already loaded for the month by the Production
// tab / renderCostingGrindOutputChart), so no extra fetch needed. "Current
// Stock" is each linked product's live stock right now, not a historical
// snapshot for that day (Stock History on the Products tab has the
// day-by-day movement log if that level of detail is needed).
function renderDailyStoreHistory() {
  const body = $('dailyStoreHistoryBody');
  if (!body) return;
  const entries = [...(dailyProductionLogCache || [])].sort((a, b) => b.log_date.localeCompare(a.log_date));
  if (entries.length === 0) {
    body.innerHTML = '<tr><td colspan="6" style="text-align:center;opacity:.5;padding:14px;">No production logged yet this month.</td></tr>';
    return;
  }
  const map = state.packProductMap || {};
  const stockSummary = Object.keys(PACKS)
    .filter(key => map[key])
    .map(key => {
      const p = (products || []).find(pr => String(pr.id) === String(map[key]));
      return p ? `${PACKS[key].label}: ${p.stockQty}` : null;
    })
    .filter(Boolean)
    .join(' · ') || '—';

  body.innerHTML = entries.map(e => `<tr>
    <td>${e.log_date}</td>
    <td class="num">${Number(e.output_qty_50) || 0}</td>
    <td class="num">${Number(e.output_qty_100) || 0}</td>
    <td class="num">${Number(e.output_qty_500) || 0}</td>
    <td class="num">${Number(e.output_qty_1000) || 0}</td>
    <td class="num">${stockSummary}</td>
  </tr>`).join('');
}
window.renderDailyStoreHistory = renderDailyStoreHistory;



async function loadDailyProductBatches() {
  if (!currentUser || userRole !== 'owner') { dailyProductBatchesCache = []; return dailyProductBatchesCache; }
  try {
    const { data, error } = await withSessionRetry(() => supabase.from('daily_product_batches')
      .select('*').eq('owner_id', currentUser.id).eq('log_date', todayIso()).order('created_at', { ascending: true }));
    if (error) throw error;
    dailyProductBatchesCache = data || [];
  } catch (e) {
    console.warn('Daily product batches load skipped:', e?.message || e);
    dailyProductBatchesCache = [];
  }
  return dailyProductBatchesCache;
}
window.loadDailyProductBatches = loadDailyProductBatches;

function computeTodayBatchSums() {
  const sums = { 50: 0, 100: 0, 500: 0, 1000: 0 };
  (dailyProductBatchesCache || []).forEach(b => {
    sums[50] += Number(b.qty_50) || 0;
    sums[100] += Number(b.qty_100) || 0;
    sums[500] += Number(b.qty_500) || 0;
    sums[1000] += Number(b.qty_1000) || 0;
  });
  return sums;
}

// Sums today's batches and writes the total into production_cost_log —
// same partial-upsert approach as before, just fed by the batch sum instead
// of a single overwritten input.
async function recomputeTodayProductOutput() {
  if (!currentUser) return;
  const sums = computeTodayBatchSums();
  const mixNow = getMixPct();
  let outputTotalProfit = 0;
  Object.keys(PACKS).forEach(key => {
    const qty = sums[key] || 0;
    if (qty > 0) {
      try {
        const r = calculatePack(key, state.linnaPrice, state.balayaPrice, state.kawalamPrice, mixNow, 'mrp', 0, 0);
        outputTotalProfit += r.profit * qty;
      } catch (e) {}
    }
  });
  const row = {
    owner_id: currentUser.id,
    log_date: todayIso(),
    output_qty_50: sums[50] || 0,
    output_qty_100: sums[100] || 0,
    output_qty_500: sums[500] || 0,
    output_qty_1000: sums[1000] || 0,
    output_total_profit: outputTotalProfit,
    created_by: currentUser.id
  };
  if (!(await ensureFreshSession())) return;
  const { data, error } = await supabase.from('production_cost_log')
    .upsert(row, { onConflict: 'owner_id,log_date' }).select().single();
  if (error) throw error;
  const idx = dailyProductionLogCache.findIndex(r => r.log_date === data.log_date);
  if (idx >= 0) dailyProductionLogCache[idx] = data; else dailyProductionLogCache.push(data);
  renderCostingGrindOutputChart();
}

function renderDailyProductBatchList() {
  const body = $('adpBatchListBody'), noteEl = $('adpBatchTotalsNote');
  if (!body) return;
  const batches = dailyProductBatchesCache || [];
  if (batches.length === 0) {
    body.innerHTML = `<tr><td colspan="3" style="text-align:center;opacity:.5;padding:14px;">No batches added yet today.</td></tr>`;
  } else {
    body.innerHTML = batches.map(b => {
      const time = b.created_at ? new Date(b.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
      const parts = [];
      Object.keys(PACKS).forEach(key => {
        const qty = Number(b['qty_' + key]) || 0;
        if (qty > 0) parts.push(`${qty}× ${PACKS[key].label}`);
      });
      const breakdown = parts.join(', ') + (b.note ? ` <span style="opacity:.6;">— ${b.note}</span>` : '');
      return `<tr><td>${time}</td><td>${breakdown || '—'}</td><td><button type="button" class="btn btn-xs btn-danger" onclick="deleteDailyProductBatch('${b.id}')"><i class="business-icon icon-inline" data-lucide="trash-2" aria-hidden="true"></i></button></td></tr>`;
    }).join('');
  }
  if (noteEl) {
    const sums = computeTodayBatchSums();
    const totalParts = Object.keys(PACKS).map(key => `${sums[key] || 0}× ${PACKS[key].label}`).join(' · ');
    noteEl.textContent = `Total today (${batches.length} batch${batches.length === 1 ? '' : 'es'}): ${totalParts}`;
  }
}
window.renderDailyProductBatchList = renderDailyProductBatchList;

async function openAddDailyProductModal() {
  if (userRole !== 'owner') { alert('Only the owner can add product output.'); return; }
  Object.keys(PACKS).forEach(key => { const el = $('adpQty' + key); if (el) el.value = 0; });
  if ($('adpNote')) $('adpNote').value = '';
  $('addDailyProductModal').classList.add('active');
  await loadDailyProductBatches();
  renderDailyProductBatchList();
}
window.openAddDailyProductModal = openAddDailyProductModal;

async function addDailyProductBatch() {
  if (userRole !== 'owner') { alert('Only the owner can add product output.'); return; }
  if (!currentUser) { alert('Please login first.'); return; }

  const qtyByKey = {};
  let anyQty = false;
  Object.keys(PACKS).forEach(key => {
    const qty = Number($('adpQty' + key) && $('adpQty' + key).value) || 0;
    qtyByKey[key] = qty;
    if (qty > 0) anyQty = true;
  });
  if (!anyQty) { alert('Enter at least one pack quantity for this batch.'); return; }

  const note = ($('adpNote') && $('adpNote').value.trim()) || null;
  const row = {
    owner_id: currentUser.id,
    log_date: todayIso(),
    qty_50: qtyByKey[50] || 0,
    qty_100: qtyByKey[100] || 0,
    qty_500: qtyByKey[500] || 0,
    qty_1000: qtyByKey[1000] || 0,
    note,
    created_by: currentUser.id
  };

  if (!(await ensureFreshSession())) return;
  try {
    const { data, error } = await supabase.from('daily_product_batches').insert(row).select().single();
    if (error) throw error;
    dailyProductBatchesCache.push(data);
    await applyPackBatchStockMovements(qtyByKey, note ? `Batch: ${note}` : 'Daily production batch', 1);
    Object.keys(PACKS).forEach(key => { const el = $('adpQty' + key); if (el) el.value = 0; });
    if ($('adpNote')) $('adpNote').value = '';
    await recomputeTodayProductOutput();
    renderDailyProductBatchList();
    renderDailyStoreHistory();
    updateStatus("✅ Batch added — linked products restocked");
  } catch (e) {
    console.error('Add daily product batch error:', e);
    const missingTable = /relation .* does not exist/i.test(e?.message || '');
    alert('❌ Could not add batch: ' + (e?.message || String(e)) + (missingTable ? '\n\nThe daily_product_batches table hasn\'t been created in Supabase yet — run the SQL setup for this feature.' : ''));
  }
}
window.addDailyProductBatch = addDailyProductBatch;

async function deleteDailyProductBatch(id) {
  if (userRole !== 'owner') return;
  if (!confirm('Delete this batch?')) return;
  try {
    const batch = (dailyProductBatchesCache || []).find(b => String(b.id) === String(id));
    const { error } = await withSessionRetry(() => supabase.from('daily_product_batches').delete().eq('id', id).eq('owner_id', currentUser.id));
    if (error) throw error;
    dailyProductBatchesCache = dailyProductBatchesCache.filter(b => String(b.id) !== String(id));
    if (batch) {
      const qtyByKey = { 50: batch.qty_50, 100: batch.qty_100, 500: batch.qty_500, 1000: batch.qty_1000 };
      await applyPackBatchStockMovements(qtyByKey, 'Batch deleted — stock reversed', -1);
    }
    await recomputeTodayProductOutput();
    renderDailyProductBatchList();
    renderDailyStoreHistory();
    updateStatus('🗑️ Batch deleted — linked stock reversed');
  } catch (e) {
    alert('❌ Could not delete batch: ' + (e?.message || String(e)));
  }
}
window.deleteDailyProductBatch = deleteDailyProductBatch;


// ==================== COSTING TAB — UMBALAKADA → ORDER COSTING ENTRY ====================
// One-place daily entry chaining the whole story together: today's
// Umbalakada purchase (type & price/kg) -> grind output & dust used ->
// which Final Product (pack size) it became -> how that product was sold
// -> which Order (if any) it's linked to -> the Income. Saving an entry
// writes it to `costing_entries`, and — if an income amount is entered —
// ALSO auto-inserts a matching row into `sales` (mirroring the same shape
// addSale() uses) so the income shows up in the Sales diary / Income tab
// immediately, with no separate manual entry needed there.
//
// REQUIRED ONE-TIME SUPABASE SETUP (run once in the SQL editor):
//
//   create table if not exists public.costing_entries (
//     id uuid primary key default gen_random_uuid(),
//     owner_id uuid not null references auth.users(id) on delete cascade,
//     entry_date date not null default current_date,
//     umbalakada_type text not null default 'linna',       -- linna | balaya | premium
//     price_per_kg numeric not null default 0,
//     purchased_kg numeric not null default 0,
//     grind_output_kg numeric not null default 0,
//     used_umbalakada_kg numeric not null default 0,
//     used_dust_kg numeric not null default 0,
//     final_product_g integer not null default 0,          -- pack size in grams: 50/100/500/1000
//     output_qty integer not null default 0,                -- packs produced
//     sale_type text not null default 'unsold',              -- unsold | retail | wholesale | distributor
//     order_id uuid references public.orders(id) on delete set null,
//     sale_id uuid references public.sales(id) on delete set null,
//     income numeric not null default 0,
//     notes text,
//     created_by uuid not null references auth.users(id),
//     created_at timestamptz not null default now()
//   );
//   alter table public.costing_entries enable row level security;
//   create policy "Owner can manage own costing entries"
//     on public.costing_entries for all
//     using (owner_id = auth.uid())
//     with check (owner_id = auth.uid());
//   create index if not exists costing_entries_owner_date_idx on public.costing_entries(owner_id, entry_date);

let costingEntries = []; // [{id, date, umbalakadaType, pricePerKg, purchasedKg, grindOutputKg, usedUmbalakadaKg, usedDustKg, finalProductG, outputQty, saleType, orderId, saleId, income, notes, createdAt}]

function dbCostingEntryToLocal(e) {
  return {
    id: e.id,
    date: e.entry_date,
    umbalakadaType: e.umbalakada_type || 'linna',
    pricePerKg: Number(e.price_per_kg) || 0,
    purchasedKg: Number(e.purchased_kg) || 0,
    grindOutputKg: Number(e.grind_output_kg) || 0,
    usedUmbalakadaKg: Number(e.used_umbalakada_kg) || 0,
    usedDustKg: Number(e.used_dust_kg) || 0,
    finalProductG: Number(e.final_product_g) || 0,
    outputQty: Number(e.output_qty) || 0,
    saleType: e.sale_type || 'unsold',
    orderId: e.order_id || null,
    saleId: e.sale_id || null,
    income: Number(e.income) || 0,
    notes: e.notes || '',
    createdAt: e.created_at
  };
}

async function loadCostingEntriesFromCloud() {
  if (!currentUser || userRole !== 'owner') { costingEntries = []; return costingEntries; }
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const { data, error } = await withSessionRetry(() => supabase.from('costing_entries')
      .select('*').eq('owner_id', currentUser.id).gte('entry_date', monthStart)
      .order('entry_date', { ascending: false }).order('created_at', { ascending: false }));
    if (error) throw error;
    costingEntries = (data || []).map(dbCostingEntryToLocal);
  } catch (e) {
    console.warn('Costing entries load skipped:', e?.message || e);
    costingEntries = [];
  }
  return costingEntries;
}
window.loadCostingEntriesFromCloud = loadCostingEntriesFromCloud;

// Autofills Price/kg from the same Raw Materials prices set in Pricing &
// Scenarios above (still editable — the actual price paid today can differ).
function onCostingEntryTypeChange() {
  const typeSel = $('ceType'), priceEl = $('cePricePerKg');
  if (!typeSel || !priceEl) return;
  const priceByType = { linna: state.linnaPrice, balaya: state.balayaPrice, premium: state.kawalamPrice };
  priceEl.value = priceByType[typeSel.value] || 0;
}
window.onCostingEntryTypeChange = onCostingEntryTypeChange;

// Fills the "Link to Order" dropdown from the already-loaded Orders list —
// most recent first, showing ref no / customer / pack / total so the owner
// can find today's order without leaving this form.
function populateCostingEntryOrderPicker() {
  const sel = $('ceOrderId');
  if (!sel) return;
  const current = sel.value;
  const recent = (orders || []).slice(0, 200);
  sel.innerHTML = '<option value="">— None —</option>' + recent.map(o => {
    const label = `${o.orderRefNo || ('#' + String(o.id).slice(0, 8))} — ${o.customerName || 'N/A'} — ${o.product}g x${o.qty} — Rs. ${o.total}`;
    return `<option value="${o.id}">${label.replace(/</g, '&lt;')}</option>`;
  }).join('');
  if (current && recent.some(o => String(o.id) === String(current))) sel.value = current;
}
window.populateCostingEntryOrderPicker = populateCostingEntryOrderPicker;

// Picking an order fills Sale Type + Final Product + Income from that
// order automatically (only overwrites Income if it's still 0, so a manual
// figure the owner already typed is never clobbered).
function onCostingEntryOrderPick() {
  const sel = $('ceOrderId');
  if (!sel || !sel.value) return;
  const o = (orders || []).find(x => String(x.id) === String(sel.value));
  if (!o) return;
  const productSel = $('ceFinalProduct');
  if (productSel && [...productSel.options].some(opt => opt.value === String(o.product))) {
    productSel.value = String(o.product);
  }
  const saleTypeSel = $('ceSaleType');
  if (saleTypeSel && saleTypeSel.value === 'unsold') saleTypeSel.value = 'retail';
  const incomeEl = $('ceIncome');
  if (incomeEl && (Number(incomeEl.value) || 0) === 0) incomeEl.value = o.total;
  const qtyEl = $('ceOutputQty');
  if (qtyEl && (Number(qtyEl.value) || 0) === 0) qtyEl.value = o.qty;
}
window.onCostingEntryOrderPick = onCostingEntryOrderPick;

async function saveCostingEntry() {
  if (userRole !== 'owner') { alert('Only the owner can save costing entries.'); return; }
  if (!currentUser) { alert('Please login first.'); return; }

  const date = $('ceDate').value || todayIso();
  const umbalakadaType = $('ceType').value;
  const pricePerKg = Number($('cePricePerKg').value) || 0;
  const purchasedKg = Number($('cePurchasedKg').value) || 0;
  const grindOutputKg = Number($('ceGrindOutputKg').value) || 0;
  const usedUmbalakadaKg = Number($('ceUsedUmbalakadaKg').value) || 0;
  const usedDustKg = Number($('ceUsedDustKg').value) || 0;
  const finalProductG = Number($('ceFinalProduct').value) || 0;
  const outputQty = Number($('ceOutputQty').value) || 0;
  const saleType = $('ceSaleType').value;
  const orderId = $('ceOrderId').value || null;
  const income = Number($('ceIncome').value) || 0;
  const notes = $('ceNotes').value.trim();

  if (purchasedKg <= 0 && grindOutputKg <= 0 && usedUmbalakadaKg <= 0) {
    alert('Enter at least Purchased, Grind Output or Used Umbalakada kg.');
    return;
  }

  const row = {
    owner_id: currentUser.id,
    entry_date: date,
    umbalakada_type: umbalakadaType,
    price_per_kg: pricePerKg,
    purchased_kg: purchasedKg,
    grind_output_kg: grindOutputKg,
    used_umbalakada_kg: usedUmbalakadaKg,
    used_dust_kg: usedDustKg,
    final_product_g: finalProductG,
    output_qty: outputQty,
    sale_type: saleType,
    order_id: orderId,
    income,
    notes,
    created_by: currentUser.id
  };

  if (!(await ensureFreshSession())) return;
  let savedEntry = null;
  try {
    const { data, error } = await supabase.from('costing_entries').insert(row).select().single();
    if (error) throw error;
    savedEntry = data;
  } catch (e) {
    console.error('Save costing entry error:', e);
    const missingTable = /relation .* does not exist/i.test(e?.message || '');
    alert('❌ Could not save entry: ' + (e?.message || String(e)) + (missingTable ? '\n\nThe costing_entries table hasn\'t been created in Supabase yet — see the SQL setup comment above saveCostingEntry() in app.js.' : ''));
    return;
  }

  // Income > 0 -> mirror straight into Sales so it lands in Income/Sales
  // reporting automatically, without a separate manual Sales entry.
  if (income > 0) {
    const linkedOrder = orderId ? (orders || []).find(o => String(o.id) === String(orderId)) : null;
    const productLabel = PACKS && PACKS[finalProductG] ? PACKS[finalProductG].label : (finalProductG ? finalProductG + 'g' : 'Umbalakada Product');
    const saleTypeLabel = { retail: 'Retail', wholesale: 'Wholesale', distributor: 'Distributor', unsold: 'Unsold' }[saleType] || saleType;
    const qtyForSale = outputQty > 0 ? outputQty : 1;
    const materialCost = usedUmbalakadaKg * pricePerKg;
    const saleRow = {
      user_id: businessId,
      sale_date: date,
      product_name: `${productLabel} Umbalakada (${saleTypeLabel})`,
      customer_name: linkedOrder ? linkedOrder.customerName : null,
      quantity: qtyForSale,
      unit_price: income / qtyForSale,
      total_amount: income,
      cost_amount: materialCost,
      wage_amount: 0,
      marketing_channel: null,
      marketing_cost: 0,
      amount_paid: income,
      notes: `Auto-generated from Costing Tab entry (${date})${linkedOrder ? ' — linked to order ' + (linkedOrder.orderRefNo || linkedOrder.id) : ''}`,
      created_by: currentUser.id,
      payment_method: 'cash'
    };
    try {
      let { data: saleData, error: saleErr } = await supabase.from('sales').insert(saleRow).select().single();
      if (saleErr && /column|schema|does not exist/i.test(saleErr.message || '')) {
        const fallback = { ...saleRow }; delete fallback.product_id;
        ({ data: saleData, error: saleErr } = await supabase.from('sales').insert(fallback).select().single());
      }
      if (saleErr) throw saleErr;
      sales.unshift(dbSaleToLocal(saleData));
      const { data: updated, error: updErr } = await supabase.from('costing_entries')
        .update({ sale_id: saleData.id }).eq('id', savedEntry.id).select().single();
      if (!updErr && updated) savedEntry = updated;
    } catch (e) {
      console.warn('Costing entry saved, but auto-mirroring to Sales failed:', e?.message || e);
      updateStatus('⚠️ Entry saved, but income could not be mirrored to Sales: ' + (e?.message || String(e)));
    }
  }

  costingEntries.unshift(dbCostingEntryToLocal(savedEntry));
  renderCostingEntries();
  if (typeof renderCostingGrindOutputChart === 'function') renderCostingGrindOutputChart();

  // Reset the form (keep the date so a run of entries for the same day is fast).
  $('cePurchasedKg').value = 0; $('ceGrindOutputKg').value = 0; $('ceUsedUmbalakadaKg').value = 0;
  $('ceUsedDustKg').value = 0; $('ceOutputQty').value = 0; $('ceIncome').value = 0; $('ceNotes').value = '';
  $('ceSaleType').value = 'unsold'; $('ceOrderId').value = '';

  updateStatus('✅ Costing entry saved' + (income > 0 ? ' — income sent to Sales/Income' : ''));
}
window.saveCostingEntry = saveCostingEntry;

function renderCostingEntries() {
  const body = $('costingEntriesBody');
  if (!body) return;
  const typeLabels = { linna: 'Linna', balaya: 'Balaya', premium: 'Premium Mix' };
  const saleTypeLabels = { unsold: 'Not sold', retail: 'Retail', wholesale: 'Wholesale', distributor: 'Distributor' };

  if (costingEntries.length === 0) {
    body.innerHTML = '<tr><td colspan="12" style="text-align:center;opacity:.6;">No costing entries yet — add one above.</td></tr>';
  } else {
    body.innerHTML = costingEntries.map(e => {
      const order = e.orderId ? (orders || []).find(o => String(o.id) === String(e.orderId)) : null;
      const orderLabel = order ? (order.orderRefNo || ('#' + String(order.id).slice(0, 8))) : '—';
      return `<tr>
        <td>${e.date}</td>
        <td>${typeLabels[e.umbalakadaType] || e.umbalakadaType}</td>
        <td class="num">Rs. ${fmt2(e.pricePerKg)}</td>
        <td class="num">${fmt2(e.purchasedKg)} kg</td>
        <td class="num">${fmt2(e.grindOutputKg)} kg</td>
        <td class="num">${fmt2(e.usedUmbalakadaKg)} kg</td>
        <td class="num">${fmt2(e.usedDustKg)} kg</td>
        <td>${e.finalProductG ? (PACKS && PACKS[e.finalProductG] ? PACKS[e.finalProductG].label : e.finalProductG + 'g') : '—'}</td>
        <td>${saleTypeLabels[e.saleType] || e.saleType}</td>
        <td>${orderLabel}</td>
        <td class="num">Rs. ${fmt2(e.income)}</td>
        <td><button class="btn btn-sm btn-danger" onclick="deleteCostingEntry('${e.id}')" title="Delete"><i class="business-icon icon-inline" data-lucide="trash-2" aria-hidden="true"></i></button></td>
      </tr>`;
    }).join('');
  }

  const sums = costingEntries.reduce((acc, e) => {
    acc.purchased += e.purchasedKg; acc.used += e.usedUmbalakadaKg; acc.dust += e.usedDustKg; acc.income += e.income;
    return acc;
  }, { purchased: 0, used: 0, dust: 0, income: 0 });
  if ($('ceSumPurchasedKg')) $('ceSumPurchasedKg').textContent = fmt2(sums.purchased) + ' kg';
  if ($('ceSumUsedKg')) $('ceSumUsedKg').textContent = fmt2(sums.used) + ' kg';
  if ($('ceSumDustKg')) $('ceSumDustKg').textContent = fmt2(sums.dust) + ' kg';
  if ($('ceSumIncome')) $('ceSumIncome').textContent = 'Rs. ' + fmt2(sums.income);

  if (typeof lucide !== 'undefined') lucide.createIcons();
}
window.renderCostingEntries = renderCostingEntries;

async function deleteCostingEntry(id) {
  if (userRole !== 'owner') return;
  const entry = costingEntries.find(e => String(e.id) === String(id));
  if (!entry) return;
  const alsoSale = entry.saleId ? ' This also removes its matching income record from Sales.' : '';
  if (!confirm('Delete this costing entry?' + alsoSale)) return;
  try {
    const { error } = await supabase.from('costing_entries').delete().eq('id', id).eq('owner_id', currentUser.id);
    if (error) throw error;
    if (entry.saleId) {
      await supabase.from('sales').delete().eq('id', entry.saleId);
      sales = sales.filter(s => String(s.id) !== String(entry.saleId));
    }
    costingEntries = costingEntries.filter(e => String(e.id) !== String(id));
    renderCostingEntries();
    updateStatus('🗑️ Costing entry deleted');
  } catch (e) {
    alert('❌ Could not delete entry: ' + (e?.message || String(e)));
  }
}
window.deleteCostingEntry = deleteCostingEntry;

// Small average helper — used by the Week-over-Week and Anomaly Check cards
// below. Ignores null/undefined entries (e.g. a day with groundKg = 0 has no
// meaningful yield%, so it's excluded rather than counted as 0%).
function avgOf(arr) {
  const vals = arr.filter(v => v != null && isFinite(v));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

// ---- Week-over-Week: This Week vs Last Week (rolling 7-day windows, not
// calendar weeks — simpler and always meaningful regardless of what day it
// is). Ground/Output/Profit totals, side by side with a % change. ----
function renderCostingWeekOverWeek() {
  const body = $('costingWowBody'), noteEl = $('costingWowNote');
  if (!body) return;
  const entries = dailyProductionLogCache || [];
  const msDay = 86400000;
  const todayMs = new Date(todayIso() + 'T00:00:00').getTime();
  const bucket = (loDays, hiDays) => {
    const out = { ground: 0, output: 0, profit: 0, days: 0 };
    entries.forEach(r => {
      const dMs = new Date(r.log_date + 'T00:00:00').getTime();
      const daysAgo = Math.round((todayMs - dMs) / msDay);
      if (daysAgo < loDays || daysAgo > hiDays) return;
      const profit = r.net_profit_incl_dust != null ? Number(r.net_profit_incl_dust) : (Number(r.total_profit) || 0);
      out.ground += Number(r.umbalakada_ground_kg) || 0;
      out.output += Number(r.kg_produced) || 0;
      out.profit += profit;
      out.days++;
    });
    return out;
  };
  const thisWeek = bucket(0, 6);
  const lastWeek = bucket(7, 13);

  const pctChange = (now, prev) => {
    if (prev === 0) return now === 0 ? null : (now > 0 ? Infinity : -Infinity);
    return ((now - prev) / Math.abs(prev)) * 100;
  };
  const fmtChange = (pct) => {
    if (pct === null) return '<span style="opacity:.5;">—</span>';
    if (pct === Infinity) return '<span class="badge badge-good">New ⬆</span>';
    if (pct === -Infinity) return '<span class="badge badge-bad">New ⬇</span>';
    const arrow = pct >= 0 ? '⬆' : '⬇';
    const cls = pct >= 0 ? 'badge-good' : 'badge-bad';
    return `<span class="badge ${cls}">${arrow} ${fmt2(Math.abs(pct))}%</span>`;
  };

  const rows = [
    ['Umbalakada Ground (kg)', thisWeek.ground, lastWeek.ground, false],
    ['Finished Output (kg)', thisWeek.output, lastWeek.output, false],
    ['Total Profit (Rs.)', thisWeek.profit, lastWeek.profit, true]
  ];
  body.innerHTML = rows.map(([label, now, prev, isMoney]) => {
    const fmtVal = (v) => isMoney ? fmt(v) : fmt2(v) + ' kg';
    return `<tr><td>${label}</td><td class="num">${fmtVal(now)}</td><td class="num">${fmtVal(prev)}</td><td class="num">${fmtChange(pctChange(now, prev))}</td></tr>`;
  }).join('');

  if (noteEl) {
    noteEl.textContent = (thisWeek.days === 0 && lastWeek.days === 0)
      ? 'No Daily Production Log entries yet — save a few days from the Production tab to see week-over-week trends.'
      : `This Week = last ${thisWeek.days || 0} logged day(s) (rolling 7-day window ending today). Last Week = the 7 days before that (${lastWeek.days || 0} logged day(s)).`;
  }
}
window.renderCostingWeekOverWeek = renderCostingWeekOverWeek;

// ---- Anomaly Check: flags today's entry if yield% or profit/kg deviates
// sharply (±30%+) from the trailing average of the prior logged days. Meant
// to catch data-entry mistakes or a genuinely unusual day — not a hard
// error, just a "worth double-checking" nudge. ----
function renderCostingAnomalyCheck() {
  const card = $('costingAnomalyCard'), noteEl = $('costingAnomalyNote');
  if (!card || !noteEl) return;
  const THRESH = 0.30; // 30% deviation trigger
  const entries = dailyProductionLogCache || [];
  const todayEntry = entries.find(r => r.log_date === todayIso());

  if (!todayEntry) {
    card.style.display = 'none';
    return;
  }
  const prior = [...entries]
    .filter(r => r.log_date !== todayIso())
    .sort((a, b) => b.log_date.localeCompare(a.log_date))
    .slice(0, 14);

  if (prior.length < 3) {
    card.style.display = 'none';
    return;
  }

  const priorYields = prior.map(r => {
    const g = Number(r.umbalakada_ground_kg) || 0, o = Number(r.kg_produced) || 0;
    return g > 0 ? (o / g) * 100 : null;
  });
  const avgYield = avgOf(priorYields);
  const avgProfitPerKg = avgOf(prior.map(r => Number(r.profit_per_kg)));

  const todayGround = Number(todayEntry.umbalakada_ground_kg) || 0;
  const todayOutput = Number(todayEntry.kg_produced) || 0;
  const todayYield = todayGround > 0 ? (todayOutput / todayGround) * 100 : null;
  const todayProfitPerKg = Number(todayEntry.profit_per_kg) || 0;

  const flags = [];
  if (todayYield != null && avgYield > 0) {
    const dev = (todayYield - avgYield) / avgYield;
    if (Math.abs(dev) >= THRESH) {
      flags.push(`📉 Yield ${dev > 0 ? 'up' : 'down'} ${fmt2(Math.abs(dev) * 100)}% vs your last ${prior.length}-day average (${fmt2(avgYield)}% → today ${fmt2(todayYield)}%) — worth double-checking today's Ground/Kg Produced entries.`);
    }
  }
  if (avgProfitPerKg !== 0) {
    const dev = (todayProfitPerKg - avgProfitPerKg) / Math.abs(avgProfitPerKg);
    if (Math.abs(dev) >= THRESH) {
      flags.push(`💰 Profit/kg ${dev > 0 ? 'up' : 'down'} ${fmt2(Math.abs(dev) * 100)}% vs your last ${prior.length}-day average (Rs. ${fmt2(avgProfitPerKg)} → today Rs. ${fmt2(todayProfitPerKg)}) — check today's fish prices or selling price.`);
    }
  }

  if (flags.length === 0) {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';
  noteEl.innerHTML = flags.map(f => `<div style="margin-bottom:6px;">${f}</div>`).join('');
}
window.renderCostingAnomalyCheck = renderCostingAnomalyCheck;

function calcBulk() {
  const targetKg = Number($('bulkTarget').value) || 0;
  const dustPct = Number($('bulkDustPct').value) || 0;
  const mix = getMixPct();
  const dustKg = targetKg * (dustPct/100);
  const fishKg = targetKg - dustKg;
  const linnaWhole = (fishKg * mix.linna) / LINNA_USABLE;
  const balayaWhole = (fishKg * mix.balaya) / BALAYA_USABLE;
  const premiumWhole = (fishKg * mix.kawalam) / PREMIUM_USABLE;
  const fishCost = (linnaWhole * state.linnaPrice) + (balayaWhole * state.balayaPrice) + (premiumWhole * state.kawalamPrice);
  $('bulkLinna').textContent = linnaWhole.toFixed(1) + ' kg';
  $('bulkBalaya').textContent = balayaWhole.toFixed(1) + ' kg';
  $('bulkKawalam').textContent = premiumWhole.toFixed(1) + ' kg';
  $('bulkCost').textContent = fmt(fishCost);
}

function calcDashboard() {
  const mix = getMixPct();
  let totalRevenue = 0, totalVarCost = 0, totalProfit = 0;
  let rows = '';
  Object.keys(PACKS).forEach(key => {
    const qty = state.dashQty[key] || 0;
    const sp = state.dashSp[key] || PACKS[key].mrp;
    const r = calculatePack(key, state.linnaPrice, state.balayaPrice, state.kawalamPrice, mix, 'sp', 0, sp);
    const monthlyProfit = r.profit * qty;
    totalRevenue += r.sp * qty;
    totalVarCost += r.totalCost * qty;
    totalProfit += monthlyProfit;
    rows += `<tr><td>${PACKS[key].label}</td><td><input type="number" class="editable-qty" data-size="${key}" value="${qty}" style="width:70px;min-height:36px;" onchange="onDataChange()"></td><td><input type="number" class="editable-sp" data-size="${key}" value="${sp}" style="width:90px;min-height:36px;" onchange="onDataChange()"></td><td class="num">${fmt(r.totalCost)}</td><td class="num">${fmt(r.profit)}</td><td class="num"><span class="badge ${monthlyProfit>=0?'badge-good':'badge-bad'}">${fmt(monthlyProfit)}</span></td></tr>`;
  });
  $('dashBody').innerHTML = rows;
  const fixed = getFixedCost();
  const net = totalProfit - fixed;
  const incomeRevenue = $('incomeRevenue');
  const incomeGross = $('incomeGrossProfit');
  const incomeFixed = $('incomeFixed');
  const incomeNet = $('incomeNet');
  const incomeMargin = $('incomeMargin');
  if (incomeRevenue) incomeRevenue.textContent = fmt(totalRevenue);
  if (incomeGross) incomeGross.textContent = fmt(totalProfit);
  if (incomeFixed) incomeFixed.textContent = fmt(fixed);
  if (incomeNet) incomeNet.textContent = fmt(net);
  if (incomeMargin) incomeMargin.textContent = totalRevenue > 0 ? ((net / totalRevenue) * 100).toFixed(1) + '%' : '0%';
  $('netProfitOut').textContent = fmt(net);
  $('netProfitOut').style.color = net >= 0 ? '#10b981' : '#f87171';

  document.querySelectorAll('.editable-qty').forEach(inp => {
    inp.oninput = () => { state.dashQty[inp.dataset.size] = Number(inp.value)||0; onDataChange(); };
  });
  document.querySelectorAll('.editable-sp').forEach(inp => {
    inp.oninput = () => { state.dashSp[inp.dataset.size] = Number(inp.value)||0; onDataChange(); };
  });
}

// ==================== PRODUCTION ====================
// ==================== QUICK PROFIT CALCULATOR (Production tab) ====================
// Simple mode for the owner: only "Fish Type", "Raw Fish Price" and "Raw Fish
// Quantity (kg)" are touched here. Yield / Ingredients Rs./kg / Overhead
// Rs./kg / Market Price all come live from the Advanced Settings section
// (still calculated in calcProduction() below), so Quick Calculator profit
// can never drift out of sync with the detailed model — it's just a focused
// read+write view onto the same numbers.
function toggleProdAdvanced() {
  const wrap = $('prodAdvancedWrap');
  const label = $('prodAdvancedToggleLabel');
  if (!wrap) return;
  const show = wrap.style.display === 'none';
  wrap.style.display = show ? '' : 'none';
  if (label) label.textContent = show ? 'Hide Advanced Settings' : 'Show Advanced Settings';
}

// Map Quick Calculator fish type -> the matching Advanced raw price field id.
const QC_RAW_PRICE_FIELD = { 'Linna': 'rawLinna', 'Balaya': 'rawBalaya', 'Premium Mix': 'rawKawalam' };

// Fish type changed -> pull that type's current Raw Price from Advanced
// Settings into the Quick Calculator field, then recalc.
function onQcFishTypeChange() {
  const type = $('qcFishType').value;
  const fieldId = QC_RAW_PRICE_FIELD[type];
  const qcPriceEl = $('qcRawPrice');
  if (fieldId && qcPriceEl && $(fieldId)) qcPriceEl.value = $(fieldId).value;
  onDataChange();
}

// Owner edits Raw Fish Price directly in the Quick Calculator -> write it
// straight back into the matching Advanced Settings field, so the two never
// disagree and the detailed table/chart update too.
function onQcRawPriceChange() {
  const type = $('qcFishType') ? $('qcFishType').value : 'Linna';
  const fieldId = QC_RAW_PRICE_FIELD[type];
  const qcPriceEl = $('qcRawPrice');
  if (fieldId && qcPriceEl && $(fieldId)) $(fieldId).value = qcPriceEl.value;
  onDataChange();
}

// Called from calcProduction() with the same fishTypes / ingredientsCostPerKg
// / fixedPerKg it just computed, so nothing is duplicated or recalculated
// differently.
function updateQuickProfitCalc(fishTypes, ingredientsCostPerKg, fixedPerKg) {
  const typeEl = $('qcFishType');
  if (!typeEl) return; // guard for older cached HTML without the Quick Calculator
  const type = typeEl.value || 'Linna';
  const ft = fishTypes.find(f => f.name === type) || fishTypes[0];
  if (!ft) return;

  // Keep the price field showing the live Advanced value, unless the owner
  // is actively typing in it right now.
  const qcPriceEl = $('qcRawPrice');
  if (qcPriceEl && document.activeElement !== qcPriceEl) qcPriceEl.value = ft.rawPrice;

  const rawKg = Number($('qcRawKg') && $('qcRawKg').value) || 0;
  const finishedKg = ft.yield > 0 ? rawKg / ft.yield : 0;
  const rawCost = rawKg * ft.rawPrice;
  const ingredientsCost = ingredientsCostPerKg * finishedKg;
  const overheadCost = fixedPerKg * finishedKg;
  const totalCost = rawCost + ingredientsCost + overheadCost;
  const revenue = finishedKg * ft.finPrice;
  const profit = revenue - totalCost;
  const profitPerKg = finishedKg > 0 ? profit / finishedKg : 0;
  const margin = revenue > 0 ? (profit / revenue) * 100 : 0;

  if ($('qcFinishedKg')) $('qcFinishedKg').textContent = finishedKg.toFixed(1) + ' kg';
  if ($('qcTotalCost')) $('qcTotalCost').textContent = fmt(totalCost);
  if ($('qcRevenue')) $('qcRevenue').textContent = fmt(revenue);
  if ($('qcProfit')) $('qcProfit').textContent = fmt(profit);
  if ($('qcProfitPerKg')) $('qcProfitPerKg').textContent = fmt(profitPerKg) + '/kg';
  if ($('qcMargin')) $('qcMargin').textContent = fmt2(margin) + '%';

  const statEl = $('qcProfitStat');
  if (statEl) statEl.className = 'stat accent ' + (profit >= 0 ? 'good' : 'bad');
  const verdictEl = $('qcVerdict');
  if (verdictEl) {
    verdictEl.textContent = rawKg > 0 ? (profit >= 0 ? '✅ PROFIT' : '⚠️ LOSS') : 'Enter a Kg quantity above';
    verdictEl.className = 'badge ' + (rawKg > 0 ? (profit >= 0 ? 'badge-good' : 'badge-bad') : '');
  }
}

function calcProduction() {
  const rawLinna = Number($('rawLinna').value) || 0;
  const rawBalaya = Number($('rawBalaya').value) || 0;
  const rawPremium = Number($('rawKawalam').value) || 0;
  const yLinna = Number($('yieldLinna').value) || 1;
  const yBalaya = Number($('yieldBalaya').value) || 1;
  const yPremium = Number($('yieldKawalam').value) || 1;
  const dailyRaw = Number($('dailyRawKg').value) || 0;
  const days = Number($('workDays').value) || 1;
  const fixedCost = (Number($('prodTransport').value)||0) + (Number($('prodFirewood').value)||0) + (Number($('prodWorkers').value)||0) + (Number($('prodOther').value)||0) + (Number($('prodIce').value)||0);
  const finLinna = Number($('finLinna').value) || 0;
  const finBalaya = Number($('finBalaya').value) || 0;
  const finPremium = Number($('finKawalam').value) || 0;

  const avgYield = (yLinna + yBalaya + yPremium) / 3;
  // Today's finished output, derived straight from Daily Raw Fish (kg) —
  // this is what actual ingredient spend today gets divided across, so
  // there's no separate "kg produced" step just to price ingredients.
  const todaysFinishedOutput = avgYield > 0 ? dailyRaw / avgYield : 0;

  // Ingredients: each spice is priced per kg, and "Qty Used Today" is the
  // real kg you actually used for today's whole raw fish batch — not a
  // theoretical ratio. Total spend today ÷ today's finished output = a
  // real, live Rs./kg ingredients cost.
  const INGREDIENTS = [
    { key:'ingSalt', label:'Salt' },
    { key:'ingGoraka', label:'Garcinia (Goraka)' },
    { key:'ingTurmeric', label:'Turmeric' },
    { key:'ingCinnamon', label:'Cinnamon' },
    { key:'ingCurryLeaf', label:'Curry / Pandan Leaves' },
    { key:'ingTamarind', label:'Tamarind' }
  ];
  let ingredientsCostToday = 0;
  const ingBreakdown = []; // {label, cost} — feeds the ingredient cost breakdown doughnut
  INGREDIENTS.forEach(ing => {
    const price = Number($(ing.key + 'Price').value) || 0;
    const qty = Number($(ing.key + 'Grams').value) || 0; // holds "kg used today"
    const cost = price * qty;
    ingredientsCostToday += cost;
    ingBreakdown.push({ label: ing.label, cost });
    const costEl = $(ing.key + 'Cost');
    if (costEl) costEl.textContent = fmt(cost);
  });
  const ingredientsCostPerKg = todaysFinishedOutput > 0 ? ingredientsCostToday / todaysFinishedOutput : 0;
  $('ingTotalCost').textContent = fmt(ingredientsCostToday);
  const perKgEl = $('ingCostPerKgNote');
  if (perKgEl) perKgEl.textContent = todaysFinishedOutput > 0
    ? `= Rs. ${fmt2(ingredientsCostPerKg)} /kg finished output (today's est. output: ${fmt2(todaysFinishedOutput)} kg)`
    : `Enter Daily Raw Fish (kg) above to calculate Rs./kg`;
  $('prodIngredientsPerKg').textContent = fmt(ingredientsCostPerKg);
  updateIngredientVarianceAlert(ingredientsCostPerKg);
  renderIngredientBreakdownChart(ingBreakdown, ingredientsCostToday);

  const monthlyRawKg = dailyRaw * days;
  $('prodMonthlyRaw').textContent = monthlyRawKg.toFixed(0) + ' kg';

  const monthlyFinished = monthlyRawKg / avgYield;
  $('prodMonthlyFinished').textContent = monthlyFinished.toFixed(1) + ' kg';

  const fixedPerKg = monthlyFinished > 0 ? fixedCost / monthlyFinished : 0;
  $('prodFixedPerKg').textContent = fmt(fixedPerKg);

  const fishTypes = [
    { name:'Linna', rawPrice:rawLinna, yield:yLinna, finPrice:finLinna },
    { name:'Balaya', rawPrice:rawBalaya, yield:yBalaya, finPrice:finBalaya },
    { name:'Premium Mix', rawPrice:rawPremium, yield:yPremium, finPrice:finPremium }
  ];

  let totalCostSum = 0, rawCostSum = 0;
  let html = '';
  const labels = [], costs = [], prices = [], profitsData = [], marketPrices = [], margins = [];
  lastProdCostByType = {};

  fishTypes.forEach(ft => {
    const rawCostPerKg = ft.rawPrice * ft.yield;
    const totalCostPerKg = rawCostPerKg + ingredientsCostPerKg + fixedPerKg;
    const profitPerKg = ft.finPrice - totalCostPerKg;
    const margin = ft.finPrice > 0 ? (profitPerKg/ft.finPrice)*100 : 0;
    const verdict = profitPerKg > 0 ? '<span class="badge badge-good">PROFIT</span>' : '<span class="badge badge-bad">LOSS</span>';

    // Snapshot for Production Batches: yield factor + total cost/kg per type,
    // captured fresh every time the Production Model recalculates.
    lastProdCostByType[ft.name] = { yieldFactor: ft.yield, totalCostPerKg, rawCostPerKg };

    totalCostSum += totalCostPerKg;
    rawCostSum += rawCostPerKg;
    labels.push(ft.name);
    costs.push(Math.round(rawCostPerKg));
    prices.push(Math.round(totalCostPerKg));
    profitsData.push(Math.round(profitPerKg));
    marketPrices.push(Math.round(ft.finPrice));
    margins.push(Math.round(margin * 10) / 10);

    html += `<tr>
      <td><strong>${ft.name}</strong></td>
      <td>${fmt(rawCostPerKg)}</td>
      <td>${fmt(ingredientsCostPerKg)}</td>
      <td>${fmt(fixedPerKg)}</td>
      <td>${fmt(totalCostPerKg)}</td>
      <td>${fmt(ft.finPrice)}</td>
      <td class="num"><span class="badge ${profitPerKg>=0?'badge-good':'badge-bad'}">${fmt(profitPerKg)}</span></td>
      <td class="num">${fmt2(margin)}%</td>
      <td>${verdict}</td>
    </tr>`;
  });

  $('prodBody').innerHTML = html;
  updateQuickProfitCalc(fishTypes, ingredientsCostPerKg, fixedPerKg);

  const avgCostPerKg = totalCostSum / 3;
  $('prodAvgCost').textContent = fmt(avgCostPerKg);
  // Fallback entry for batches marked "Other / Mixed" fish type.
  lastProdCostByType['Other'] = { yieldFactor: avgYield, totalCostPerKg: avgCostPerKg, rawCostPerKg: rawCostSum / 3 };
  window.dispatchEvent(new CustomEvent('production-model-updated'));

  const avgFinPrice = (finLinna + finBalaya + finPremium) / 3;
  const avgProfitPerKg = avgFinPrice - avgCostPerKg;
  const breakEven = avgProfitPerKg > 0 ? fixedCost / avgProfitPerKg : Infinity;
  $('breakEvenKg').textContent = isFinite(breakEven) ? breakEven.toFixed(0) + ' kg' : 'N/A (not profitable)';

  // Expose today's averages for the Daily Production Log below (live snapshot
  // + what gets saved when "Save Today's Snapshot" is clicked).
  lastProdAvgRawCostPerKg = rawCostSum / 3;
  lastProdIngredientsCostPerKg = ingredientsCostPerKg;
  lastProdOverheadCostPerKg = fixedPerKg;
  lastProdAvgCostPerKg = avgCostPerKg;
  lastProdAvgMarketPrice = avgFinPrice;
  lastProdAvgProfitPerKg = avgProfitPerKg;
  renderUmbalakadaPurchaseSyncTable(); // local re-render only — cloud sync happens via syncUmbalakadaGroundFromPurchaseLog()
  updateDailyProductionSummaryLive();

  const colors = getChartColors();
  safeRenderChart('prodChart', () => {
    const ctx = $('prodChart').getContext('2d');
    const chartData = {
      labels: labels,
      datasets: [
        { type: 'bar', label:'Raw Cost/kg', data: costs, backgroundColor: 'rgba(56,189,248,0.85)', borderRadius: 6, yAxisID: 'y', order: 2 },
        { type: 'bar', label:'Total Cost/kg', data: prices, backgroundColor: 'rgba(16,185,129,0.85)', borderRadius: 6, yAxisID: 'y', order: 2 },
        { type: 'bar', label:'Market Price/kg', data: marketPrices, backgroundColor: 'rgba(251,191,36,0.85)', borderRadius: 6, yAxisID: 'y', order: 2 },
        { type: 'bar', label:'Profit/kg', data: profitsData, backgroundColor: profitsData.map(p => p >= 0 ? 'rgba(167,139,250,0.85)' : 'rgba(248,113,113,0.85)'), borderRadius: 6, yAxisID: 'y', order: 2 },
        { type: 'line', label:'Margin %', data: margins, borderColor: '#f472b6', backgroundColor: '#f472b6', borderWidth: 2, pointRadius: 4, pointHoverRadius: 6, tension: 0.3, yAxisID: 'y1', order: 1 }
      ]
    };
    if (prodChart) { prodChart.data = chartData; prodChart.update(); }
    else {
      prodChart = new Chart(ctx, {
        type:'bar',
        data: chartData,
        options: {
          responsive:true, maintainAspectRatio:false,
          interaction: { mode: 'index', intersect: false },
          plugins:{
            legend:{position:'bottom',labels:{boxWidth:10,font:{size:11,family:'Inter'},color:colors.text,padding:12,usePointStyle:true,pointStyle:'circle'}},
            tooltip:{
              callbacks:{
                label: (item) => {
                  const suffix = item.dataset.label === 'Margin %' ? '%' : '/kg';
                  const prefix = item.dataset.label === 'Margin %' ? '' : 'Rs. ';
                  return ` ${item.dataset.label}: ${prefix}${item.parsed.y}${suffix}`;
                }
              }
            }
          },
          scales:{
            y:{beginAtZero:true,grid:{color:colors.grid},ticks:{color:colors.text,font:{size:10},callback:(v)=>'Rs. '+v},title:{display:true,text:'Rs. per kg',color:colors.text,font:{size:10}}},
            y1:{position:'right',beginAtZero:true,grid:{display:false},ticks:{color:colors.text,font:{size:10},callback:(v)=>v+'%'},title:{display:true,text:'Margin %',color:colors.text,font:{size:10}}},
            x:{grid:{display:false},ticks:{color:colors.text,font:{size:10}}}
          },
          barPercentage: 0.75,
          categoryPercentage: 0.75
        }
      });
    }
  });

  state.production = {
    rawLinna, rawBalaya, rawKawalam: rawPremium,
    yieldLinna: yLinna, yieldBalaya: yBalaya, yieldKawalam: yPremium,
    dailyRawKg: dailyRaw, workDays: days,
    prodTransport: Number($('prodTransport').value)||0,
    prodFirewood: Number($('prodFirewood').value)||0,
    prodWorkers: Number($('prodWorkers').value)||0,
    prodOther: Number($('prodOther').value)||0,
    prodIce: Number($('prodIce').value)||0,
    finLinna, finBalaya, finKawalam: finPremium,
    ingSaltPrice: Number($('ingSaltPrice').value)||0, ingSaltGrams: Number($('ingSaltGrams').value)||0,
    ingGorakaPrice: Number($('ingGorakaPrice').value)||0, ingGorakaGrams: Number($('ingGorakaGrams').value)||0,
    ingTurmericPrice: Number($('ingTurmericPrice').value)||0, ingTurmericGrams: Number($('ingTurmericGrams').value)||0,
    ingCinnamonPrice: Number($('ingCinnamonPrice').value)||0, ingCinnamonGrams: Number($('ingCinnamonGrams').value)||0,
    ingCurryLeafPrice: Number($('ingCurryLeafPrice').value)||0, ingCurryLeafGrams: Number($('ingCurryLeafGrams').value)||0,
    ingTamarindPrice: Number($('ingTamarindPrice').value)||0, ingTamarindGrams: Number($('ingTamarindGrams').value)||0
  };
}

// ==================== DAILY PRODUCTION LOG (Production tab) ====================
// Lets the owner save a snapshot of today's production economics (the
// averages computed by calcProduction() above) as one row per calendar day,
// then shows a running monthly profit chart + daily table built from those
// saved snapshots. Saving the same day twice UPDATES that day's row instead
// of creating a duplicate (upsert on owner_id + log_date).
//
// REQUIRED ONE-TIME SUPABASE SETUP (run once in the SQL editor):
//
//   create table if not exists public.production_cost_log (
//     id uuid primary key default gen_random_uuid(),
//     owner_id uuid not null references auth.users(id) on delete cascade,
//     log_date date not null default current_date,
//     raw_cost_per_kg numeric not null default 0,
//     ingredients_cost_per_kg numeric not null default 0,
//     overhead_cost_per_kg numeric not null default 0,
//     total_cost_per_kg numeric not null default 0,
//     market_price_per_kg numeric not null default 0,
//     profit_per_kg numeric not null default 0,
//     kg_produced numeric not null default 0,
//     total_profit numeric not null default 0,
//     notes text,
//     created_by uuid not null references auth.users(id),
//     created_at timestamptz not null default now(),
//     unique (owner_id, log_date)
//   );
//   alter table public.production_cost_log enable row level security;
//   create policy "Owner can manage own production cost log"
//     on public.production_cost_log for all
//     using (owner_id = auth.uid())
//     with check (owner_id = auth.uid());
//   create index if not exists production_cost_log_owner_date_idx on public.production_cost_log(owner_id, log_date);
//
// Until that table exists, the summary cards above still update live from
// the calculator, but Save/load will show a clear error instead of failing
// silently.

function todayIso() { return new Date().toISOString().slice(0, 10); }

// Compares today's live Ingredients Cost/kg against the trailing average
// pulled from this month's saved Daily Production Log snapshots, and shows
// a warning banner under the Ingredients Cost table if it has swung more
// than 15% either way (e.g. a spice price spike). Needs at least 3 saved
// days of history before it says anything, so it won't fire on noise.
function updateIngredientVarianceAlert(currentCostPerKg) {
  const el = $('ingVarianceAlert');
  if (!el) return;
  const history = (dailyProductionLogCache || [])
    .map(r => Number(r.ingredients_cost_per_kg) || 0)
    .filter(v => v > 0)
    .slice(-30);
  if (history.length < 3) { el.style.display = 'none'; return; }
  const avg = history.reduce((s, v) => s + v, 0) / history.length;
  if (avg <= 0) { el.style.display = 'none'; return; }
  const variancePct = ((currentCostPerKg - avg) / avg) * 100;
  if (Math.abs(variancePct) < 15) { el.style.display = 'none'; return; }
  const up = variancePct > 0;
  el.style.display = '';
  el.innerHTML = `${up ? '⚠️' : '📉'} <strong>Ingredients cost/kg is ${up ? 'up' : 'down'} ${Math.abs(variancePct).toFixed(1)}%</strong> vs your ${history.length}-day average this month (Rs. ${avg.toFixed(2)}/kg) — today: Rs. ${currentCostPerKg.toFixed(2)}/kg.`;
}

// ==================== DAILY RAW FISH — AUTO-SYNC FROM FISH BILLS ====================
// The "Daily Raw Fish (kg)" field feeds the monthly production projection.
// Rather than typing that number twice, we sum it straight from today's
// Fish Bills (already entered in the Daily Fish Purchase Bills section) and
// offer it as a one-tap fill — never overwritten silently, so a manual
// correction is never clobbered by a bill entered later.
function computeTodayRawFishKgFromBills() {
  return (fishBills || [])
    .filter(b => isToday(b.date) && b.purchaseType !== 'readymade_umbalakada')
    .reduce((sum, b) => sum + (b.items || []).reduce((s, it) => s + (Number(it.quantityKg) || 0), 0), 0);
}

function syncDailyRawKgFromBills() {
  const noteEl = $('dailyRawKgAutoNote');
  const btn = $('dailyRawKgSyncBtn');
  if (!noteEl && !btn) return;
  const todayKg = computeTodayRawFishKgFromBills();
  const current = Number($('dailyRawKg') && $('dailyRawKg').value) || 0;
  if (noteEl) {
    if (todayKg <= 0) {
      noteEl.textContent = "No Fish Bills logged for today yet.";
    } else if (Math.abs(todayKg - current) < 0.05) {
      noteEl.textContent = `📋 Matches today's Fish Bills total (${fmt2(todayKg)} kg).`;
    } else {
      noteEl.textContent = `📋 Today's Fish Bills total: ${fmt2(todayKg)} kg (field currently shows ${fmt2(current)} kg).`;
    }
  }
  if (btn) btn.style.display = todayKg > 0 && Math.abs(todayKg - current) >= 0.05 ? '' : 'none';
}
window.syncDailyRawKgFromBills = syncDailyRawKgFromBills;

function applyDailyRawKgFromBills() {
  const todayKg = computeTodayRawFishKgFromBills();
  if (todayKg <= 0) { alert("No Fish Bills logged for today yet."); return; }
  $('dailyRawKg').value = todayKg.toFixed(1);
  onDataChange();
  syncDailyRawKgFromBills();
  updateStatus("✅ Daily Raw Fish (kg) filled from today's Fish Bills");
}
window.applyDailyRawKgFromBills = applyDailyRawKgFromBills;

function updateDailyProductionSummaryLive() {
  const costEl = $('dpTodayCost'), priceEl = $('dpTodayPrice'), profitEl = $('dpTodayProfit'), totalEl = $('dpTodayTotal');
  if (!costEl) return; // Daily Log card not in the DOM (e.g. different role view)
  const kgProduced = Number($('dpKgProduced') && $('dpKgProduced').value) || 0;

  // lastProdIngredientsCostPerKg is already today's real ingredients cost —
  // it comes straight from the "Qty Used Today" table above, not a fixed
  // recipe ratio — so no separate override layer is needed here.
  const costPerKg = lastProdAvgRawCostPerKg + lastProdIngredientsCostPerKg + lastProdOverheadCostPerKg;

  // Selling price: a manually-entered override (if any) beats the auto
  // average of Linna/Balaya/Premium Mix market prices from the calculator.
  const priceInput = $('dpMarketPrice');
  const priceOverride = priceInput ? Number(priceInput.value) || 0 : 0;
  const usingCustomPrice = priceOverride > 0;
  const marketPrice = usingCustomPrice ? priceOverride : lastProdAvgMarketPrice;

  const profitPerKg = marketPrice - costPerKg;
  const totalProfit = profitPerKg * kgProduced;

  costEl.textContent = fmt(costPerKg);
  priceEl.textContent = fmt(marketPrice);
  profitEl.textContent = fmt(profitPerKg);
  totalEl.textContent = fmt(totalProfit);

  const priceNoteEl = $('dpPriceSourceNote');
  if (priceNoteEl) {
    priceNoteEl.textContent = usingCustomPrice
      ? `💰 Using your custom selling price (Rs. ${fmt2(marketPrice)}/kg).`
      : `💰 Using the auto average of Linna/Balaya/Premium Mix prices (Rs. ${fmt2(marketPrice)}/kg) — enter a value above to override.`;
  }

  const profitCard = $('dpTodayProfitCard'), totalCard = $('dpTodayTotalCard');
  if (profitCard) profitCard.classList.toggle('bad', profitPerKg < 0);
  if (totalCard) totalCard.classList.toggle('bad', totalProfit < 0);

  // ---- Grinding & Dust (Today) ----
  const groundKg = Number($('dpUmbalakadaGroundKg') && $('dpUmbalakadaGroundKg').value) || 0;
  const dustGeneratedKg = Number($('dpDustGeneratedKg') && $('dpDustGeneratedKg').value) || 0;
  const dustUsedKg = Number($('dpDustUsedKg') && $('dpDustUsedKg').value) || 0;
  const dustSalePrice = Number($('dpDustSalePrice') && $('dpDustSalePrice').value) || 0;
  const dustRemovedKg = Math.max(dustGeneratedKg - dustUsedKg, 0);

  // Weighted average Umbalakada price/kg. If today's actual purchase has
  // synced in from the Costing tab (syncUmbalakadaGroundFromPurchaseLog()),
  // use that real weighted average; otherwise fall back to the fixed Mix
  // Ratio assumption from the Costing tab's Raw Materials card, same as before.
  const mix = getMixPct();
  const breakdownTotalKg = Number(window.umbalakadaBreakdownTotalKg) || 0;
  const avgUmbalakadaPricePerKg = breakdownTotalKg > 0
    ? (Number(window.umbalakadaBreakdownAvgPrice) || 0)
    : (mix.linna * state.linnaPrice) + (mix.balaya * state.balayaPrice) + (mix.kawalam * state.kawalamPrice);
  const dustWasteCost = dustRemovedKg * avgUmbalakadaPricePerKg;
  const dustRecoveryValue = dustUsedKg * dustSalePrice;
  const netDustImpact = dustRecoveryValue - dustWasteCost;
  const netProfitInclDust = totalProfit + netDustImpact;

  const dustRemovedEl = $('dpDustRemoved'), dustImpactEl = $('dpDustImpact'), netProfitEl = $('dpNetProfit');
  if (dustRemovedEl) dustRemovedEl.textContent = fmt2(dustRemovedKg) + ' kg';
  if (dustImpactEl) dustImpactEl.textContent = fmt(netDustImpact);
  if (netProfitEl) netProfitEl.textContent = fmt(netProfitInclDust);
  const dustImpactCard = $('dpDustImpactCard'), netProfitCard = $('dpNetProfitCard');
  if (dustImpactCard) dustImpactCard.classList.toggle('bad', netDustImpact < 0);
  if (netProfitCard) netProfitCard.classList.toggle('bad', netProfitInclDust < 0);

  const suggestNoteEl = $('dpDustSuggestNote');
  if (suggestNoteEl) {
    if (groundKg > 0) {
      const gy = getGrindYields();
      const usableFraction = (mix.linna * gy.linna) + (mix.balaya * gy.balaya) + (mix.kawalam * gy.premium);
      const suggestedDustKg = groundKg * Math.max(1 - usableFraction, 0);
      suggestNoteEl.textContent = `Based on your Grinding Yield % and current mix, ${fmt2(groundKg)}kg of Umbalakada should produce around ${fmt2(suggestedDustKg)}kg of dust — enter what actually came out above.`;
    } else {
      suggestNoteEl.textContent = '';
    }
  }

  // ---- Grind Breakdown by Fish Type (Today) — auto-split from groundKg
  // using the current Fish Mix Ratio (Pricing & Scenarios above), no extra
  // typing needed. Shown in the Costing tab's Daily Costing & Trends sub-tab.
  const linnaGroundKg = groundKg * mix.linna;
  const balayaGroundKg = groundKg * mix.balaya;
  const premiumGroundKg = groundKg * mix.kawalam;

  // ---- Output by Product (Today) — per-pack qty typed above, priced at
  // current fish costs & MRP via calculatePack(). Costing tab renders this
  // same breakdown live (recalculating with whatever prices are current),
  // this snapshot is just what gets written to the daily log on save.
  const outputByProduct = {};
  let outputTotalProfit = 0;
  Object.keys(PACKS).forEach(key => {
    const qty = Number($('dpOutQty' + key) && $('dpOutQty' + key).value) || 0;
    outputByProduct[key] = qty;
    if (qty > 0) {
      try {
        const r = calculatePack(key, state.linnaPrice, state.balayaPrice, state.kawalamPrice, mix, 'mrp', 0, 0);
        outputTotalProfit += r.profit * qty;
      } catch (e) {}
    }
  });

  // These are the numbers Save Today's Snapshot actually writes — kept in
  // sync here so the save always matches what's on screen.
  lastProdAvgCostPerKgForSave = costPerKg;
  lastProdAvgProfitPerKgForSave = profitPerKg;
  lastProdIngredientsCostPerKgForSave = lastProdIngredientsCostPerKg;
  lastProdAvgMarketPriceForSave = marketPrice;
  lastUmbalakadaGroundKgForSave = groundKg;
  lastDustGeneratedKgForSave = dustGeneratedKg;
  lastDustUsedKgForSave = dustUsedKg;
  lastDustRemovedKgForSave = dustRemovedKg;
  lastDustSalePriceForSave = dustSalePrice;
  lastDustWasteCostForSave = dustWasteCost;
  lastDustRecoveryValueForSave = dustRecoveryValue;
  lastNetDustImpactForSave = netDustImpact;
  lastNetProfitInclDustForSave = netProfitInclDust;
  lastLinnaGroundKgForSave = linnaGroundKg;
  lastBalayaGroundKgForSave = balayaGroundKg;
  lastPremiumGroundKgForSave = premiumGroundKg;
  lastOutputByProductForSave = outputByProduct;
  lastOutputTotalProfitForSave = outputTotalProfit;
}
window.updateDailyProductionSummaryLive = updateDailyProductionSummaryLive;

async function saveDailyProductionLog() {
  if (userRole !== 'owner') { alert('Only the owner can save the daily production log.'); return; }
  if (!currentUser) { alert('Please login first.'); return; }

  updateDailyProductionSummaryLive(); // make sure the *ForSave values are fresh
  const kgProduced = Number($('dpKgProduced').value) || 0;
  const notes = $('dpNote').value.trim();
  const totalProfit = lastProdAvgProfitPerKgForSave * kgProduced;

  // ---- SQL setup (run once in Supabase before dust fields will save) ----
  // ALTER TABLE production_cost_log
  //   ADD COLUMN IF NOT EXISTS umbalakada_ground_kg numeric DEFAULT 0,
  //   ADD COLUMN IF NOT EXISTS dust_generated_kg numeric DEFAULT 0,
  //   ADD COLUMN IF NOT EXISTS dust_used_kg numeric DEFAULT 0,
  //   ADD COLUMN IF NOT EXISTS dust_removed_kg numeric DEFAULT 0,
  //   ADD COLUMN IF NOT EXISTS dust_sale_price numeric DEFAULT 0,
  //   ADD COLUMN IF NOT EXISTS dust_waste_cost numeric DEFAULT 0,
  //   ADD COLUMN IF NOT EXISTS dust_recovery_value numeric DEFAULT 0,
  //   ADD COLUMN IF NOT EXISTS net_dust_impact numeric DEFAULT 0,
  //   ADD COLUMN IF NOT EXISTS net_profit_incl_dust numeric DEFAULT 0,
  //   ADD COLUMN IF NOT EXISTS linna_ground_kg numeric DEFAULT 0,
  //   ADD COLUMN IF NOT EXISTS balaya_ground_kg numeric DEFAULT 0,
  //   ADD COLUMN IF NOT EXISTS premium_ground_kg numeric DEFAULT 0,
  //   ADD COLUMN IF NOT EXISTS output_qty_50 integer DEFAULT 0,
  //   ADD COLUMN IF NOT EXISTS output_qty_100 integer DEFAULT 0,
  //   ADD COLUMN IF NOT EXISTS output_qty_500 integer DEFAULT 0,
  //   ADD COLUMN IF NOT EXISTS output_qty_1000 integer DEFAULT 0,
  //   ADD COLUMN IF NOT EXISTS output_total_profit numeric DEFAULT 0,
  //   ADD COLUMN IF NOT EXISTS umbalakada_variety_breakdown jsonb DEFAULT '[]'::jsonb;
  // (Existing owner_id-uuid RLS policy already covers these new columns —
  // no policy changes needed, this only adds columns to an already-owned row.)
  const row = {
    owner_id: currentUser.id,
    log_date: todayIso(),
    raw_cost_per_kg: lastProdAvgRawCostPerKg,
    ingredients_cost_per_kg: lastProdIngredientsCostPerKgForSave,
    overhead_cost_per_kg: lastProdOverheadCostPerKg,
    total_cost_per_kg: lastProdAvgCostPerKgForSave,
    market_price_per_kg: lastProdAvgMarketPriceForSave,
    profit_per_kg: lastProdAvgProfitPerKgForSave,
    kg_produced: kgProduced,
    linna_ground_kg: lastLinnaGroundKgForSave,
    balaya_ground_kg: lastBalayaGroundKgForSave,
    premium_ground_kg: lastPremiumGroundKgForSave,
    output_qty_50: lastOutputByProductForSave[50] || 0,
    output_qty_100: lastOutputByProductForSave[100] || 0,
    output_qty_500: lastOutputByProductForSave[500] || 0,
    output_qty_1000: lastOutputByProductForSave[1000] || 0,
    output_total_profit: lastOutputTotalProfitForSave,
    total_profit: totalProfit,
    umbalakada_ground_kg: lastUmbalakadaGroundKgForSave,
    dust_generated_kg: lastDustGeneratedKgForSave,
    dust_used_kg: lastDustUsedKgForSave,
    dust_removed_kg: lastDustRemovedKgForSave,
    dust_sale_price: lastDustSalePriceForSave,
    dust_waste_cost: lastDustWasteCostForSave,
    dust_recovery_value: lastDustRecoveryValueForSave,
    net_dust_impact: lastNetDustImpactForSave,
    net_profit_incl_dust: totalProfit + lastNetDustImpactForSave,
    umbalakada_variety_breakdown: lastUmbalakadaBreakdownForSave,
    notes,
    created_by: currentUser.id
  };

  if (!(await ensureFreshSession())) return;
  try {
    const { data, error } = await supabase.from('production_cost_log')
      .upsert(row, { onConflict: 'owner_id,log_date' }).select().single();
    if (error) throw error;
    const idx = dailyProductionLogCache.findIndex(r => r.log_date === data.log_date);
    if (idx >= 0) dailyProductionLogCache[idx] = data; else dailyProductionLogCache.push(data);
    renderDailyProductionLog();
    renderIncomeDailyDustSummary();
    updateStatus("✅ Today's production snapshot saved");
  } catch (e) {
    console.error('Save daily production log error:', e);
    const missingTable = /relation .* does not exist/i.test(e?.message || '');
    const missingColumn = /column .* does not exist/i.test(e?.message || '');
    alert('❌ Could not save snapshot: ' + (e?.message || String(e)) + (missingTable ? '\n\nThe production_cost_log table hasn\'t been created in Supabase yet — see the SQL setup comment above saveDailyProductionLog() in app.js.' : missingColumn ? '\n\nSome columns haven\'t been added to production_cost_log yet (dust-tracking, grind-by-type, output-by-product, or variety-breakdown) — run the ALTER TABLE SQL in the comment above saveDailyProductionLog() in app.js.' : ''));
  }
}
window.saveDailyProductionLog = saveDailyProductionLog;


async function loadDailyProductionLog() {
  if (!currentUser || userRole !== 'owner') { dailyProductionLogCache = []; return dailyProductionLogCache; }
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const { data, error } = await withSessionRetry(() => supabase.from('production_cost_log')
      .select('*').eq('owner_id', currentUser.id).gte('log_date', monthStart).order('log_date', { ascending: true }));
    if (error) throw error;
    dailyProductionLogCache = data || [];
  } catch (e) {
    console.warn('Daily production log load skipped:', e?.message || e);
    dailyProductionLogCache = [];
  }
  return dailyProductionLogCache;
}
window.loadDailyProductionLog = loadDailyProductionLog;

async function editDailyProductionLog(id) {
  if (userRole !== 'owner') return;
  const r = dailyProductionLogCache.find(x => String(x.id) === String(id));
  if (!r) { alert('Entry not found.'); return; }
  const kgStr = prompt('Kg produced:', r.kg_produced);
  if (kgStr === null) return;
  const kg = Number(kgStr);
  if (!kg || kg < 0) { alert('Enter a valid kg amount.'); return; }
  const notesStr = prompt('Notes (optional):', r.notes || '');
  if (notesStr === null) return;
  const totalProfit = Number(r.profit_per_kg || 0) * kg;
  try {
    const { data, error } = await withSessionRetry(() => supabase.from('production_cost_log')
      .update({ kg_produced: kg, notes: notesStr.trim(), total_profit: totalProfit })
      .eq('id', id).eq('owner_id', currentUser.id).select().single());
    if (error) throw error;
    const idx = dailyProductionLogCache.findIndex(x => String(x.id) === String(id));
    if (idx >= 0) dailyProductionLogCache[idx] = data;
    renderDailyProductionLog();
    updateStatus('✅ Production log entry updated');
  } catch (e) {
    alert('❌ Could not update entry: ' + (e?.message || String(e)));
  }
}
window.editDailyProductionLog = editDailyProductionLog;

async function deleteDailyProductionLog(id) {
  if (userRole !== 'owner') return;
  if (!confirm('Delete this day\'s production log entry?')) return;
  try {
    const { error } = await withSessionRetry(() => supabase.from('production_cost_log').delete().eq('id', id).eq('owner_id', currentUser.id));
    if (error) throw error;
    dailyProductionLogCache = dailyProductionLogCache.filter(r => r.id !== id);
    renderDailyProductionLog();
    updateStatus('🗑️ Production log entry deleted');
  } catch (e) {
    alert('❌ Could not delete entry: ' + (e?.message || String(e)));
  }
}
window.deleteDailyProductionLog = deleteDailyProductionLog;

function renderDailyProductionLog() {
  const tbody = $('dpLogBody');
  if (!tbody) return;

  const entries = [...dailyProductionLogCache].sort((a, b) => a.log_date.localeCompare(b.log_date));

  if (entries.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;opacity:.5;padding:20px;">No entries yet this month.</td></tr>';
  } else {
    tbody.innerHTML = [...entries].reverse().map(r => {
      const netProfitInclDust = r.net_profit_incl_dust !== undefined && r.net_profit_incl_dust !== null
        ? Number(r.net_profit_incl_dust) : Number(r.total_profit || 0);
      return `
      <tr>
        <td>${r.log_date}</td>
        <td>${fmt(r.total_cost_per_kg)}</td>
        <td>${fmt(r.market_price_per_kg)}</td>
        <td class="num"><span class="badge ${Number(r.profit_per_kg)>=0?'badge-good':'badge-bad'}">${fmt(r.profit_per_kg)}</span></td>
        <td>${Number(r.kg_produced || 0).toFixed(0)} kg</td>
        <td class="num">${Number(r.dust_removed_kg || 0).toFixed(2)} kg</td>
        <td class="num">${fmt(r.total_profit)}</td>
        <td class="num"><span class="badge ${netProfitInclDust>=0?'badge-good':'badge-bad'}">${fmt(netProfitInclDust)}</span></td>
        <td>${userRole === 'owner' ? actionMenuHTML([
          { label: 'Edit', icon: '✏️', onclick: `editDailyProductionLog('${r.id}')` },
          { label: 'Delete', icon: '🗑️', danger: true, onclick: `deleteDailyProductionLog('${r.id}')` }
        ]) : ''}</td>
      </tr>
    `;
    }).join('');
  }

  const colors = getChartColors();
  if (!$('dpMonthlyChart')) return;
  safeRenderChart('dpMonthlyChart', () => {
    const ctx = $('dpMonthlyChart').getContext('2d');
    const sortedEntries = [...entries].sort((a, b) => a.log_date.localeCompare(b.log_date));
    let running = 0;
    const cumulativeProfit = sortedEntries.map(r => { running += Number(r.total_profit) || 0; return Math.round(running); });
    const chartData = {
      labels: sortedEntries.map(r => r.log_date.slice(8, 10) + '/' + r.log_date.slice(5, 7)),
      datasets: [
        { type: 'bar', label: 'Cumulative Profit (Rs.)', data: cumulativeProfit, backgroundColor: 'rgba(16,185,129,0.25)', borderRadius: 4, yAxisID: 'y1', order: 3 },
        { type: 'line', label: 'Profit/kg', data: sortedEntries.map(r => Math.round(Number(r.profit_per_kg) || 0)), borderColor: 'rgba(16,185,129,1)', backgroundColor: 'rgba(16,185,129,0.15)', fill: true, tension: 0.3, pointRadius: 3, yAxisID: 'y', order: 1 },
        { type: 'line', label: 'Cost/kg', data: sortedEntries.map(r => Math.round(Number(r.total_cost_per_kg) || 0)), borderColor: 'rgba(248,113,113,1)', backgroundColor: 'rgba(248,113,113,0.08)', fill: false, tension: 0.3, pointRadius: 3, borderDash: [4,3], yAxisID: 'y', order: 2 },
        { type: 'line', label: 'Selling Price/kg', data: sortedEntries.map(r => Math.round(Number(r.market_price_per_kg) || 0)), borderColor: 'rgba(251,191,36,1)', backgroundColor: 'rgba(251,191,36,0.08)', fill: false, tension: 0.3, pointRadius: 3, borderDash: [4,3], yAxisID: 'y', order: 2 }
      ]
    };
    if (dpMonthlyChart) { dpMonthlyChart.data = chartData; dpMonthlyChart.update(); }
    else {
      dpMonthlyChart = new Chart(ctx, {
        type: 'line',
        data: chartData,
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11, family: 'Inter' }, color: colors.text, padding: 12, usePointStyle: true, pointStyle: 'circle' } },
            tooltip: {
              callbacks: {
                label: (item) => {
                  const isMoney = true;
                  return ` ${item.dataset.label}: ${isMoney ? 'Rs. ' : ''}${item.parsed.y.toLocaleString()}`;
                }
              }
            }
          },
          scales: {
            y: { position: 'left', grid: { color: colors.grid }, ticks: { color: colors.text, font: { size: 10 } }, title: { display: true, text: 'Rs. per kg', color: colors.text, font: { size: 10 } } },
            y1: { position: 'right', grid: { display: false }, ticks: { color: colors.text, font: { size: 10 } }, title: { display: true, text: 'Cumulative Rs.', color: colors.text, font: { size: 10 } } },
            x: { grid: { display: false }, ticks: { color: colors.text, font: { size: 10 } } }
          }
        }
      });
    }
  });

  // ---- Daily Profit Summary — Incl. Dust Impact ----
  if (!$('dpDustProfitChart')) return;
  safeRenderChart('dpDustProfitChart', () => {
    const ctx = $('dpDustProfitChart').getContext('2d');
    const sortedEntries = [...entries].sort((a, b) => a.log_date.localeCompare(b.log_date));
    const chartData = {
      labels: sortedEntries.map(r => r.log_date.slice(8, 10) + '/' + r.log_date.slice(5, 7)),
      datasets: [
        { label: 'Total Profit (before dust)', data: sortedEntries.map(r => Math.round(Number(r.total_profit) || 0)), backgroundColor: 'rgba(56,189,248,0.55)', borderRadius: 4 },
        { label: 'Net Profit (incl. dust)', data: sortedEntries.map(r => {
            const v = r.net_profit_incl_dust !== undefined && r.net_profit_incl_dust !== null ? Number(r.net_profit_incl_dust) : Number(r.total_profit || 0);
            return Math.round(v);
          }), backgroundColor: 'rgba(16,185,129,0.55)', borderRadius: 4 }
      ]
    };
    if (dpDustProfitChart) { dpDustProfitChart.data = chartData; dpDustProfitChart.update(); }
    else {
      dpDustProfitChart = new Chart(ctx, {
        type: 'bar',
        data: chartData,
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11, family: 'Inter' }, color: colors.text, padding: 12, usePointStyle: true, pointStyle: 'circle' } },
            tooltip: { callbacks: { label: (item) => ` ${item.dataset.label}: Rs. ${item.parsed.y.toLocaleString()}` } }
          },
          scales: {
            y: { grid: { color: colors.grid }, ticks: { color: colors.text, font: { size: 10 } } },
            x: { grid: { display: false }, ticks: { color: colors.text, font: { size: 10 } } }
          }
        }
      });
    }
  });

  // Keep the Costing tab's Grind→Output sub-tab in sync with whatever just
  // changed here, without a separate fetch (same cache, just a different view).
  renderCostingGrindOutputChart();
}
window.renderDailyProductionLog = renderDailyProductionLog;

// ==================== INCOME TAB — DAILY GRINDING & DUST SUMMARY ====================
// Reads the same dailyProductionLogCache the Production tab's Daily
// Production Log uses (loaded via loadDailyProductionLog()) so the Income
// tab shows the same day-by-day dust figures without a separate fetch.
function renderIncomeDailyDustSummary() {
  const groundEl = $('incomeDustGroundKg'), removedEl = $('incomeDustRemovedKg');
  const impactEl = $('incomeDustImpact'), netProfitEl = $('incomeDustNetProfit');
  const monthRemovedEl = $('incomeDustMonthRemoved'), monthImpactEl = $('incomeDustMonthImpact');
  const noteEl = $('incomeDustSummaryNote');
  if (!groundEl) return; // Income tab card not in the DOM (e.g. different role view)

  const today = todayIso();
  const entries = dailyProductionLogCache || [];
  const todayEntry = entries.find(r => r.log_date === today);
  const latest = todayEntry || [...entries].sort((a, b) => a.log_date.localeCompare(b.log_date)).pop();

  if (latest) {
    const netProfit = latest.net_profit_incl_dust !== undefined && latest.net_profit_incl_dust !== null
      ? Number(latest.net_profit_incl_dust) : Number(latest.total_profit || 0);
    groundEl.textContent = fmt2(Number(latest.umbalakada_ground_kg || 0)) + ' kg';
    removedEl.textContent = fmt2(Number(latest.dust_removed_kg || 0)) + ' kg';
    impactEl.textContent = fmt(Number(latest.net_dust_impact || 0));
    netProfitEl.textContent = fmt(netProfit);
    if (noteEl) {
      noteEl.textContent = todayEntry
        ? "Figures are from today's saved Daily Production Log snapshot."
        : `No snapshot saved for today yet — showing the most recent saved day (${latest.log_date}).`;
    }
  } else {
    groundEl.textContent = '0 kg';
    removedEl.textContent = '0 kg';
    impactEl.textContent = 'Rs. 0';
    netProfitEl.textContent = 'Rs. 0';
    if (noteEl) noteEl.textContent = "No Daily Production Log snapshot saved yet this month — save one from the Production tab.";
  }

  const monthDustRemoved = entries.reduce((sum, r) => sum + (Number(r.dust_removed_kg) || 0), 0);
  const monthDustImpact = entries.reduce((sum, r) => sum + (Number(r.net_dust_impact) || 0), 0);
  if (monthRemovedEl) monthRemovedEl.textContent = fmt2(monthDustRemoved) + ' kg';
  if (monthImpactEl) monthImpactEl.textContent = fmt(monthDustImpact);
}
window.renderIncomeDailyDustSummary = renderIncomeDailyDustSummary;

// ==================== ORDERS / CUSTOMERS ====================
function generateOrderId() {
  const now = new Date();
  const prefix = 'DRY';
  const year = now.getFullYear().toString().slice(2);
  const month = String(now.getMonth()+1).padStart(2,'0');
  const seq = String(orders.length + 1).padStart(4,'0');
  return `${prefix}${year}${month}-${seq}`;
}

function getCustomerName(id) {
  const c = customers.find(c => String(c.id) === String(id));
  if(c) return c.name;
  const o = (orders||[]).find(x => String(x.customerId) === String(id));
  return o?.customerName || 'Unknown';
}
function getCustomerAddress(id) {
  const c = customers.find(c => String(c.id) === String(id));
  if(c) return c.address || '';
  const o = (orders||[]).find(x => String(x.customerId) === String(id));
  return o?.address || '';
}
function getCustomerPhone(id) {
  const c = customers.find(c => String(c.id) === String(id));
  if(c) return c.phone || '';
  const o = (orders||[]).find(x => String(x.customerId) === String(id));
  return o?.customerPhone || '';
}

// ==================== SUPABASE-BACKED CUSTOMERS/ORDERS ====================
// customers/orders now live in their own dedicated Supabase tables
// (public.customers / public.orders) instead of the app_data JSON blob,
// so every device/browser sees the same live data.

function dbCustomerToLocal(c) {
  return { id: c.id, name: c.name, phone: c.phone || '', address: c.address || '', referralStaffId: c.referral_staff_id || null, referralStaffReference: c.referral_staff_reference || null, createdAt: c.created_at ? new Date(c.created_at).toLocaleDateString() : new Date().toLocaleDateString() };
}
function dbOrderToLocal(o) {
  return {
    id: o.id,
    customerId: o.customer_id || null,
    customerName: o.customer_name_snapshot || '',
    customerPhone: o.customer_phone_snapshot || '',
    orderRefNo: o.order_ref_no || null,
    productId: o.product_id || null,
    product: String(o.product_size_g),
    qty: Number(o.qty),
    unitPrice: Number(o.unit_price),
    total: Number(o.total),
    address: o.address || '',
    notes: o.notes || '',
    status: o.status || 'pending',
    createdBy: o.created_by || null,
    createdAt: o.created_at || new Date().toISOString(),
    referralStaffId: o.referral_staff_id || null,
    referralStaffReference: o.referral_staff_reference || null,
    referralStatus: o.referral_status || 'none',
    assignedDriverId: o.assigned_driver_id || null,
    deliveryKm: (o.delivery_km !== undefined && o.delivery_km !== null) ? Number(o.delivery_km) : null,
    deliveryLat: (o.delivery_lat !== undefined && o.delivery_lat !== null) ? Number(o.delivery_lat) : null,
    deliveryLng: (o.delivery_lng !== undefined && o.delivery_lng !== null) ? Number(o.delivery_lng) : null,
    routeSequence: (o.route_sequence !== undefined && o.route_sequence !== null) ? Number(o.route_sequence) : null,
    paymentMethod: o.payment_method || 'cod',
    codCollected: (o.cod_collected !== undefined && o.cod_collected !== null) ? Number(o.cod_collected) : null,
    deliveryPhotoUrl: o.delivery_photo_url || null,
    deliverySignature: o.delivery_signature || null,
    shippedAt: o.shipped_at || null,
    deliveredAt: o.delivered_at || null,
    failedReason: o.failed_reason || null,
    failedNotes: o.failed_notes || null,
    failedAt: o.failed_at || null,
    ratingToken: o.rating_token || null,
    customerRating: (o.customer_rating !== undefined && o.customer_rating !== null) ? Number(o.customer_rating) : null,
    ratingFeedback: o.rating_feedback || null,
    ratedAt: o.rated_at || null
  };
}

async function loadCustomersFromCloud() {
  if (!currentUser || userRole === 'staff') {
    if (userRole === 'staff') { customers = []; saveCustomers(); }
    return;
  }
  try {
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .eq('user_id', businessId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    customers = (data || []).map(dbCustomerToLocal);
    saveCustomers();
  } catch (e) {
    console.error('Load customers error:', e);
    updateStatus('⚠️ Could not load customers from cloud');
  }
}

async function loadOrdersFromCloud() {
  if (!currentUser) return;
  try {
    let q = supabase.from('orders').select('*').eq('user_id', businessId);
    if (userRole === 'staff') q = q.eq('created_by', currentUser.id);
    const { data, error } = await q.order('created_at', { ascending: false });
    if (error) throw error;
    orders = (data || []).map(dbOrderToLocal);
    saveOrders();
  } catch (e) {
    console.error('Load orders error:', e);
    updateStatus('⚠️ Could not load orders from cloud');
  }
}

// ==================== SUPABASE-BACKED PRODUCTS (catalog) ====================
// Owner-managed product catalog (image, wholesale & retail price) that
// auto-fills pricing into the Sales diary and the Orders form. Visible
// to staff too (read-only) so their Order form can auto-fill price;
// only the owner can add/edit/delete (also enforced by RLS).

function dbProductToLocal(p) {
  return {
    id: p.id,
    name: p.name,
    imageUrl: p.image_url || '',
    wholesalePrice: Number(p.wholesale_price) || 0,
    retailPrice: Number(p.retail_price) || 0,
    stockQty: Number(p.stock_qty) || 0,
    active: p.active !== false,
    createdAt: p.created_at || new Date().toISOString(),
  };
}

async function loadProductsFromCloud() {
  if (!currentUser) return;
  try {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('user_id', businessId)
      .eq('active', true)
      .order('created_at', { ascending: false });
    if (error) throw error;
    products = (data || []).map(dbProductToLocal);
    populateSaleProductDatalist();
    renderOrderProductPicker();
  } catch (e) {
    console.error('Load products error:', e);
  }
}

function renderProducts() {
  const grid = $('productsGrid');
  if (!grid) return;
  // Distributors now get a real Products tab (one of their 5 bottom-nav
  // buttons) instead of the old placeholder message — they see the same
  // read-only catalog view Staff already sees (edit/delete buttons below
  // only render for the owner either way).
  if (products.length === 0) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;opacity:.5;padding:20px;">No products yet — tap "Add Product" to build your catalog.</div>';
    return;
  }
  const isOwner = userRole === 'owner';
  grid.innerHTML = products.map(p => `
    <div class="card" style="padding:10px;">
      <img src="${p.imageUrl || ''}" onerror="this.style.display='none'" style="width:100%;max-width:250px;height:250px;object-fit:contain;border-radius:8px;background:#f8f8f8;margin:0 auto;display:${p.imageUrl ? 'block' : 'none'};">
      ${p.imageUrl ? '' : '<div style="width:100%;max-width:250px;height:250px;border-radius:8px;background:#f8f8f8;display:flex;align-items:center;justify-content:center;opacity:.4;font-size:.7rem;margin:0 auto;">No image</div>'}
      <div style="font-weight:700;margin-top:8px;font-size:.85rem;">${p.name}</div>
      <div style="font-size:.72rem;opacity:.7;margin-top:4px;">Wholesale: Rs. ${p.wholesalePrice.toLocaleString()}</div>
      <div style="font-size:.72rem;opacity:.7;">Retail: Rs. ${p.retailPrice.toLocaleString()}</div>
      <div style="font-size:.78rem;font-weight:700;margin-top:4px;color:${p.stockQty <= 0 ? '#d45d55' : (p.stockQty <= 10 ? '#c98a1a' : '#0a8f43')};">Stock: ${p.stockQty.toLocaleString()}${p.stockQty <= 0 ? ' · Out of stock' : (p.stockQty <= 10 ? ' · Low' : '')}</div>
      ${isOwner ? `<div class="btn-row" style="margin-top:8px;justify-content:flex-end;">
        ${actionMenuHTML([
          { label: 'Restock', icon: '📦', onclick: `restockProduct('${p.id}')` },
          { label: 'Adjust Stock', icon: '🛠️', onclick: `adjustProductStockPrompt('${p.id}')` },
          { label: 'Stock History', icon: '🧾', onclick: `openStockHistory('${p.id}')` },
          { label: 'Edit', icon: '✏️', onclick: `openEditProduct('${p.id}')` },
          { label: 'Delete', icon: '🗑️', danger: true, onclick: `deleteProduct('${p.id}')` }
        ])}
      </div>` : ''}
    </div>
  `).join('');
}

// ==================== PRODUCT INVENTORY — RESTOCK / ADJUST / HISTORY ====================
// All stock changes go through adjust_product_stock() in Supabase (one
// atomic update + history row — see supabase-setup-pack-pricing-and-
// inventory.sql). If that SQL hasn't been run yet on this project, the
// call fails cleanly and the owner sees exactly what to do next; nothing
// else in the app (sales, products) is affected either way.
async function applyStockMovement(productId, delta, movementType, note, saleId) {
  if (!productId || !delta) return;
  if (!(await ensureFreshSession())) return;
  try {
    const { error } = await withSessionRetry(() => supabase.rpc('adjust_product_stock', {
      p_product_id: productId,
      p_owner_id: businessId,
      p_delta: delta,
      p_movement_type: movementType,
      p_note: note || null,
      p_sale_id: saleId || null
    }));
    if (error) throw error;
    await loadProductsFromCloud();
    renderProducts();
  } catch (e) {
    console.warn('Stock movement skipped (run supabase-setup-pack-pricing-and-inventory.sql to enable inventory tracking):', e.message || e);
  }
}
window.applyStockMovement = applyStockMovement;

async function restockProduct(id) {
  if (userRole !== 'owner') { alert('Only the business owner can manage stock.'); return; }
  const p = products.find(x => String(x.id) === String(id));
  if (!p) return;
  const qtyStr = prompt(`Restock "${p.name}" — how many units are you adding? (Current stock: ${p.stockQty})`, '');
  if (qtyStr === null) return;
  const qty = Number(qtyStr);
  if (!isFinite(qty) || qty <= 0) { alert('Enter a positive quantity.'); return; }
  const note = prompt('Note (optional) — e.g. supplier name or batch:', '') || null;
  await applyStockMovement(id, qty, 'restock', note);
  updateStatus('✅ Stock added');
}
window.restockProduct = restockProduct;

async function adjustProductStockPrompt(id) {
  if (userRole !== 'owner') { alert('Only the business owner can manage stock.'); return; }
  const p = products.find(x => String(x.id) === String(id));
  if (!p) return;
  const deltaStr = prompt(`Adjust stock for "${p.name}" (Current stock: ${p.stockQty}).\nEnter a positive number to add, or a negative number to remove (e.g. -5 for damaged/lost stock):`, '');
  if (deltaStr === null) return;
  const delta = Number(deltaStr);
  if (!isFinite(delta) || delta === 0) { alert('Enter a non-zero number.'); return; }
  const note = prompt('Reason for this adjustment:', '') || null;
  await applyStockMovement(id, delta, 'adjustment', note);
  updateStatus('✅ Stock adjusted');
}
window.adjustProductStockPrompt = adjustProductStockPrompt;

async function openStockHistory(id) {
  const p = products.find(x => String(x.id) === String(id));
  if (!p) return;
  $('stockHistoryTitle').textContent = `Stock History — ${p.name}`;
  $('stockHistoryBody').innerHTML = '<tr><td colspan="5" style="text-align:center;opacity:.6;">Loading…</td></tr>';
  $('stockHistoryModal').classList.add('active');
  try {
    const { data, error } = await supabase
      .from('product_stock_movements')
      .select('*')
      .eq('product_id', id)
      .eq('owner_id', businessId)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    if (!data || data.length === 0) {
      $('stockHistoryBody').innerHTML = '<tr><td colspan="5" style="text-align:center;opacity:.6;">No stock movements yet.</td></tr>';
      return;
    }
    const typeLabel = { restock: '📦 Restock', sale: '🛒 Sale', order: '📋 Order', production: '🏭 Production', adjustment: '🛠️ Adjustment' };
    $('stockHistoryBody').innerHTML = data.map(m => `
      <tr>
        <td>${new Date(m.created_at).toLocaleString()}</td>
        <td>${typeLabel[m.movement_type] || m.movement_type}</td>
        <td class="num" style="color:${m.quantity_delta < 0 ? '#d45d55' : '#0a8f43'};font-weight:700;">${m.quantity_delta > 0 ? '+' : ''}${m.quantity_delta}</td>
        <td class="num">${m.resulting_stock}</td>
        <td>${m.note || '—'}</td>
      </tr>
    `).join('');
  } catch (e) {
    console.error('Load stock history error:', e);
    $('stockHistoryBody').innerHTML = `<tr><td colspan="5" style="text-align:center;opacity:.6;">Could not load history — run supabase-setup-pack-pricing-and-inventory.sql if you haven't yet.</td></tr>`;
  }
}
window.openStockHistory = openStockHistory;

function openNewProduct() {
  if (userRole !== 'owner') { alert('Only the business owner can manage products.'); return; }
  $('productModalTitle').textContent = 'New Product';
  $('productEditId').value = '';
  $('productExistingImageUrl').value = '';
  $('productName').value = '';
  $('productWholesalePrice').value = 0;
  $('productRetailPrice').value = 0;
  $('productImageFile').value = '';
  productImageFile = null;
  const preview = $('productImagePreview');
  if (preview) { preview.style.display = 'none'; preview.src = ''; }
  $('productModal').classList.add('active');
}

function openEditProduct(id) {
  const p = products.find(x => String(x.id) === String(id));
  if (!p) return;
  $('productModalTitle').textContent = 'Edit Product';
  $('productEditId').value = p.id;
  $('productExistingImageUrl').value = p.imageUrl || '';
  $('productName').value = p.name;
  $('productWholesalePrice').value = p.wholesalePrice;
  $('productRetailPrice').value = p.retailPrice;
  $('productImageFile').value = '';
  productImageFile = null;
  const preview = $('productImagePreview');
  if (preview) {
    if (p.imageUrl) { preview.src = p.imageUrl; preview.style.display = 'block'; }
    else { preview.style.display = 'none'; preview.src = ''; }
  }
  $('productModal').classList.add('active');
}

// FIX: product photos straight from a phone camera can be several MB, which
// made uploads slow and made the Products page slow to load (every card
// fetches a huge full-size image). We now resize the image on the device
// (canvas) into a fixed 250x250 square JPEG before it's ever uploaded — the
// FULL photo is scaled down to fit inside the square (never cropped) and
// centered on a white background, so every product's image is a small,
// fast-loading 250x250 file that shows the entire picture. Because every
// stored image is already exactly 250x250, it looks identical (fully
// visible, not cropped) everywhere it's shown — to the owner in the
// Products tab and to every other app member (staff/distributor/driver)
// who views the same catalog.
function compressImageFile(file, targetSize = 250, quality = 0.85) {
  return new Promise((resolve, reject) => {
    if (!file.type || !file.type.startsWith('image/')) { resolve(file); return; }
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = targetSize;
      canvas.height = targetSize;
      const ctx = canvas.getContext('2d');
      // White backdrop so the letterboxed edges (and transparent PNGs) don't turn black in JPEG.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, targetSize, targetSize);
      // Scale the FULL image (never cropped) to fit inside the 250x250 square, centered.
      const ratio = Math.min(targetSize / img.width, targetSize / img.height);
      const drawW = Math.round(img.width * ratio);
      const drawH = Math.round(img.height * ratio);
      const dx = Math.round((targetSize - drawW) / 2);
      const dy = Math.round((targetSize - drawH) / 2);
      ctx.drawImage(img, dx, dy, drawW, drawH);
      URL.revokeObjectURL(objectUrl);
      canvas.toBlob((blob) => {
        if (!blob) { resolve(file); return; }
        const baseName = (file.name || 'photo').replace(/\.[^./\\]+$/, '');
        resolve(new File([blob], `${baseName}.jpg`, { type: 'image/jpeg' }));
      }, 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); resolve(file); };
    img.src = objectUrl;
  });
}

async function previewProductImage() {
  const file = $('productImageFile').files && $('productImageFile').files[0];
  const preview = $('productImagePreview');
  if (!file) { productImageFile = null; return; }
  const compressed = await compressImageFile(file);
  productImageFile = compressed;
  const reader = new FileReader();
  reader.onload = (e) => { if (preview) { preview.src = e.target.result; preview.style.display = 'block'; } };
  reader.readAsDataURL(compressed);
}

async function saveProduct() {
  if (userRole !== 'owner') { alert('Only the business owner can manage products.'); return; }
  const editId = $('productEditId').value;
  const name = $('productName').value.trim();
  const wholesalePrice = Number($('productWholesalePrice').value) || 0;
  const retailPrice = Number($('productRetailPrice').value) || 0;
  if (!name) { alert('Product name is required!'); return; }
  if (!currentUser) { alert('Please login first.'); return; }

  const saveBtn = $('productSaveBtn');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; }
  if (!(await ensureFreshSession())) { if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Product'; } return; }

  try {
    let imageUrl = $('productExistingImageUrl').value || null;
    if (productImageFile) {
      const ext = (productImageFile.name && productImageFile.name.includes('.')) ? productImageFile.name.split('.').pop() : 'jpg';
      const path = `${businessId}/${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from('product-images').upload(path, productImageFile, { upsert: true, contentType: productImageFile.type || 'image/jpeg' });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from('product-images').getPublicUrl(path);
      imageUrl = pub?.publicUrl || imageUrl;
    }

    const row = { user_id: businessId, name, image_url: imageUrl, wholesale_price: wholesalePrice, retail_price: retailPrice, active: true };

    if (editId) {
      const { error } = await supabase.from('products').update(row).eq('id', editId).eq('user_id', businessId);
      if (error) throw error;
    } else {
      const { error } = await supabase.from('products').insert(row);
      if (error) throw error;
    }
  } catch (e) {
    console.error('Save product error:', e);
    alert('❌ Could not save product: ' + e.message);
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Product'; }
    return;
  }
  if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Product'; }
  closeModal('productModal');
  updateStatus('✅ Product saved');
  await loadProductsFromCloud();
  renderProducts();
}

async function deleteProduct(id) {
  if (userRole !== 'owner') { alert('Only the business owner can manage products.'); return; }
  if (!confirm('Delete this product? Existing sales/orders keep their recorded price.')) return;
  if (!(await ensureFreshSession())) return;
  try {
    const { error } = await supabase.from('products').update({ active: false }).eq('id', id).eq('user_id', businessId);
    if (error) throw error;
  } catch (e) {
    console.error('Delete product error:', e);
    alert('❌ Could not delete product: ' + e.message);
    return;
  }
  await loadProductsFromCloud();
  renderProducts();
  updateStatus('🗑️ Product removed');
}

// ---- Sales modal: type-ahead product datalist, auto-fills Unit Price ----
function populateSaleProductDatalist() {
  const dl = $('saleProductList');
  if (!dl) return;
  dl.innerHTML = products.map(p => `<option value="${p.name.replace(/"/g, '&quot;')}">`).join('');
}

function onSaleProductPick() {
  const val = ($('saleProduct').value || '').trim();
  const match = products.find(p => p.name === val);
  if (match) {
    $('saleUnitPrice').value = match.retailPrice;
    recalcSaleModal();
  }
}

// ---- Orders modal: catalog quick-pick chips, auto-fills Unit Price ----
function renderOrderProductPicker() {
  const wrap = $('orderProductPickerWrap');
  const holder = $('orderProductPicker');
  if (!wrap || !holder) return;
  if (products.length === 0) { wrap.style.display = 'none'; holder.innerHTML = ''; return; }
  wrap.style.display = 'block';
  const selectedId = $('orderProductId') ? $('orderProductId').value : '';
  holder.innerHTML = products.map(p => {
    const isSelected = String(selectedId) === String(p.id) && String(selectedId) !== '';
    return `
    <div class="om-catalog-card" data-pid="${p.id}" onclick="selectOrderProduct('${p.id}')" style="flex:0 0 auto;width:96px;text-align:center;cursor:pointer;border:2px solid ${isSelected ? '#0ea472' : 'var(--border-color,#3333)'};background:${isSelected ? 'rgba(14,164,114,.08)' : 'transparent'};border-radius:10px;padding:6px;position:relative;transition:border-color .15s,background .15s;">
      ${isSelected ? `<div style="position:absolute;top:4px;right:4px;width:16px;height:16px;border-radius:50%;background:#0ea472;color:#fff;font-size:11px;line-height:16px;">✓</div>` : ''}
      ${p.imageUrl
        ? `<div style="width:100%;height:80px;border-radius:6px;background:#f5f5f5;display:flex;align-items:center;justify-content:center;overflow:hidden;"><img src="${p.imageUrl}" style="max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;"></div>`
        : `<div style="width:100%;height:80px;border-radius:6px;background:#f0f0f0;"></div>`}
      <div style="font-size:.62rem;margin-top:4px;line-height:1.2;">${p.name}</div>
      <div style="font-size:.62rem;opacity:.7;">Rs. ${p.retailPrice.toLocaleString()}</div>
    </div>
  `;
  }).join('');
}

function selectOrderProduct(id) {
  const p = products.find(x => String(x.id) === String(id));
  if (!p) return;
  const already = String($('orderProductId')?.value || '') === String(p.id);
  // Tapping the already-selected catalog item again removes it from the order.
  if (already) {
    $('orderProductId').value = '';
  } else {
    $('orderProductId').value = p.id;
    $('orderUnitPrice').value = p.retailPrice;
  }
  renderOrderProductPicker();
  if (typeof updateOrderTotal === 'function') updateOrderTotal();
}

// ==================== SUPABASE-BACKED EXPENSES ====================
let expenses = [];

function dbExpenseToLocal(e) {
  return {
    id: e.id,
    date: e.expense_date,
    category: e.category,
    description: e.description || '',
    amount: Number(e.amount) || 0,
    createdAt: e.created_at
  };
}

async function loadExpensesFromCloud() {
  if (!currentUser) return;
  try {
    // No explicit owner filter here — RLS decides what's visible:
    // owners see every expense their team recorded, staff only see
    // the ones they personally added.
    const { data, error } = await supabase
      .from('expenses')
      .select('*')
      .order('expense_date', { ascending: false });
    if (error) throw error;
    expenses = (data || []).map(dbExpenseToLocal);
  } catch (e) {
    console.error('Load expenses error:', e);
    updateStatus('⚠️ Could not load expenses from cloud');
  }
}

function openNewExpense() {
  if ($('expEditId')) $('expEditId').value = '';
  if ($('expenseModalTitle')) $('expenseModalTitle').textContent = 'New Expense';
  if ($('expenseSaveBtn')) $('expenseSaveBtn').innerHTML = '✅ Save Expense';
  $('expDate').value = new Date().toISOString().slice(0, 10);
  $('expCategory').value = 'Transport';
  $('expDescription').value = '';
  $('expAmount').value = 0;
  if ($('expRecurring')) { $('expRecurring').checked = false; $('expRecurring').disabled = false; }
  $('expenseModal').classList.add('active');
}

function editExpense(id) {
  if (userRole !== 'owner') { alert('Only the owner can edit expenses.'); return; }
  const e = expenses.find(x => String(x.id) === String(id));
  if (!e) { alert('Expense not found.'); return; }
  $('expEditId').value = e.id;
  $('expDate').value = e.date;
  $('expCategory').value = e.category;
  $('expDescription').value = e.description || '';
  $('expAmount').value = e.amount;
  if ($('expRecurring')) { $('expRecurring').checked = false; $('expRecurring').disabled = true; }
  if ($('expenseModalTitle')) $('expenseModalTitle').textContent = 'Edit Expense';
  if ($('expenseSaveBtn')) $('expenseSaveBtn').innerHTML = '✅ Update Expense';
  $('expenseModal').classList.add('active');
}
window.editExpense = editExpense;

async function saveExpense() {
  const editId = $('expEditId') ? $('expEditId').value : '';
  const date = $('expDate').value || new Date().toISOString().slice(0, 10);
  const category = $('expCategory').value;
  const description = $('expDescription').value.trim();
  const amount = Number($('expAmount').value) || 0;
  const isRecurring = $('expRecurring') ? $('expRecurring').checked : false;

  if (!currentUser) { alert('Please login first.'); return; }
  if (amount <= 0) { alert('Enter an amount greater than 0!'); return; }

  if (editId) {
    if (userRole !== 'owner') { alert('Only the owner can edit expenses.'); return; }
    if (!(await ensureFreshSession())) return;
    try {
      const { data, error } = await supabase.from('expenses')
        .update({ expense_date: date, category, description, amount })
        .eq('id', editId).select().single();
      if (error) throw error;
      const idx = expenses.findIndex(x => String(x.id) === String(editId));
      if (idx >= 0) expenses[idx] = dbExpenseToLocal(data);
    } catch (e) {
      console.error('Update expense error:', e);
      alert('❌ Could not update expense: ' + e.message);
      return;
    }
    renderExpenses();
    renderProductCosting();
    updateMonthlySummary();
    closeModal('expenseModal');
    if ($('expRecurring')) $('expRecurring').disabled = false;
    updateStatus('✅ Expense updated');
    return;
  }

  const row = {
    expense_date: date,
    category,
    description,
    amount,
    created_by: currentUser.id
  };

  if (!(await ensureFreshSession())) return;
  try {
    const { data, error } = await supabase.from('expenses').insert(row).select().single();
    if (error) throw error;
    expenses.unshift(dbExpenseToLocal(data));
  } catch (e) {
    console.error('Save expense error:', e);
    alert('❌ Could not save expense: ' + e.message);
    return;
  }

  let recurringWarning = '';
  if (isRecurring) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const { data: rdata, error: rerror } = await supabase.from('recurring_expenses').insert({
        created_by: currentUser.id,
        category,
        description,
        amount,
        active: true,
        last_generated_date: date === today ? today : null
      }).select().single();
      if (rerror) throw rerror;
      recurringExpenses.unshift(rdata);
    } catch (e) {
      console.error('Save recurring rule error:', e);
      recurringWarning = ' (⚠️ but "repeat daily" failed: ' + e.message + ')';
    }
  }

  renderExpenses();
  renderRecurringExpenses();
  updateMonthlySummary();
  closeModal('expenseModal');
  if (recurringWarning) {
    alert('✅ Expense saved' + recurringWarning);
    updateStatus('⚠️ Expense saved, recurring rule failed');
  } else {
    updateStatus(isRecurring ? '✅ Expense saved — set to repeat daily' : '✅ Expense saved');
  }
}

async function deleteExpense(id) {
  if (userRole !== 'owner') { alert('Only the owner can delete expenses.'); return; }
  if (!confirm('Delete this expense?')) return;
  if (!currentUser) { alert('Please login first.'); return; }
  if (!(await ensureFreshSession())) return;
  try {
    const { error } = await supabase.from('expenses').delete().eq('id', id);
    if (error) throw error;
  } catch (e) {
    console.error('Delete expense error:', e);
    alert('❌ Could not delete expense: ' + e.message);
    return;
  }
  expenses = expenses.filter(e => e.id !== id);
  renderExpenses();
  updateMonthlySummary();
  updateStatus('🗑️ Expense deleted');
}

function renderExpenses() {
  const tbody = $('expensesBody');
  if (!tbody) return;
  if (expenses.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;opacity:0.5;padding:20px;">No expenses yet.</td></tr>';
  } else {
    tbody.innerHTML = expenses.map(e => `
      <tr>
        <td>${e.date}</td>
        <td>${e.category}</td>
        <td>${e.description || '-'}</td>
        <td>${fmt(e.amount)}</td>
        <td>${userRole === 'owner' ? actionMenuHTML([
          { label: 'Edit', icon: '✏️', onclick: `editExpense('${e.id}')` },
          { label: 'Delete', icon: '🗑️', danger: true, onclick: `deleteExpense('${e.id}')` }
        ]) : '<span style="opacity:.4;">—</span>'}</td>
      </tr>
    `).join('');
  }
  updateExpenseStats();
}

// ==================== DAILY PRODUCT COSTING (Products tab) ====================
// Reuses the same `expenses` table/array as the Expenses tab — every entry
// saved here shows up in Expenses too, and flows straight into
// updateMonthlySummary() / renderAnalytics() (Revenue vs Expenses vs Profit),
// so the profit chart updates automatically with no extra wiring.
const PRODUCT_COSTING_CATEGORIES = ['Raw Fish', 'Ingredients', 'Workers Salary', 'Staff Dining', 'Transport', 'Ice', 'Water', 'Electricity'];
const COSTING_CATEGORY_LABELS = { 'Workers Salary': 'Staff Salary', 'Staff Dining': 'Staff Meals' };

function isToday(dateStr) {
  const d = parseSummaryDate(dateStr);
  if (!d) return false;
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}
function isThisMonth(dateStr) {
  const d = parseSummaryDate(dateStr);
  if (!d) return false;
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

function openNewCosting() {
  if (userRole !== 'owner') { alert('Only the owner can add costing entries.'); return; }
  $('costingDate').value = new Date().toISOString().slice(0, 10);
  $('costingCategory').value = 'Raw Fish';
  $('costingNote').value = '';
  $('costingAmount').value = 0;
  $('costingModal').classList.add('active');
}

async function saveCosting() {
  const date = $('costingDate').value || new Date().toISOString().slice(0, 10);
  const category = $('costingCategory').value;
  const description = $('costingNote').value.trim();
  const amount = Number($('costingAmount').value) || 0;

  if (!currentUser) { alert('Please login first.'); return; }
  if (amount <= 0) { alert('Enter an amount greater than 0!'); return; }

  const row = { expense_date: date, category, description, amount, created_by: currentUser.id };
  if (!(await ensureFreshSession())) return;
  try {
    const { data, error } = await supabase.from('expenses').insert(row).select().single();
    if (error) throw error;
    expenses.unshift(dbExpenseToLocal(data));
  } catch (e) {
    console.error('Save costing error:', e);
    alert('❌ Could not save cost: ' + e.message);
    return;
  }

  renderProductCosting();
  renderExpenses();
  updateMonthlySummary();
  closeModal('costingModal');
  updateStatus('✅ Daily cost saved');
}

function renderProductCosting() {
  const tbody = $('costingBody');
  if (!tbody) return;
  const entries = (expenses || []).filter(e => PRODUCT_COSTING_CATEGORIES.includes(e.category));

  if (entries.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;opacity:0.5;padding:20px;">No costing entries yet.</td></tr>';
  } else {
    tbody.innerHTML = entries.map(e => `
      <tr>
        <td>${e.date}</td>
        <td>${COSTING_CATEGORY_LABELS[e.category] || e.category}</td>
        <td>${e.description || '-'}</td>
        <td>${fmt(e.amount)}</td>
        <td>${userRole === 'owner' ? actionMenuHTML([
          { label: 'Edit', icon: '✏️', onclick: `editExpense('${e.id}')` },
          { label: 'Delete', icon: '🗑️', danger: true, onclick: `deleteExpense('${e.id}').then(renderProductCosting)` }
        ]) : '<span style="opacity:.4;">—</span>'}</td>
      </tr>
    `).join('');
  }

  const todayEntries = entries.filter(e => isToday(e.date));
  const monthEntries = entries.filter(e => isThisMonth(e.date));
  const todayTotal = todayEntries.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const monthTotal = monthEntries.reduce((s, e) => s + (Number(e.amount) || 0), 0);

  const byCatToday = {};
  todayEntries.forEach(e => { byCatToday[e.category] = (byCatToday[e.category] || 0) + (Number(e.amount) || 0); });
  let topCat = '—';
  let topAmt = 0;
  Object.entries(byCatToday).forEach(([cat, amt]) => { if (amt > topAmt) { topAmt = amt; topCat = COSTING_CATEGORY_LABELS[cat] || cat; } });

  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('costingTodayTotal', fmt(todayTotal));
  set('costingMonthTotal', fmt(monthTotal));
  set('costingTopCategory', topAmt > 0 ? `${topCat} (${fmt(topAmt)})` : '—');
}

// ==================== DAILY FISH PURCHASE BILLS (Production tab) ====================
// Advanced version: one bill can hold several fish items bought from the
// same seller on the same day. Each saved bill mirrors its total into the
// `expenses` table (category "Raw Fish"), so Expenses + the Analytics
// Profit chart update automatically with no extra wiring. Extra payments
// made later against a seller's outstanding balance are tracked separately
// in `fish_payments` (cash-flow only — never double-counted as a cost).
let fishBills = [];      // [{id, billNo, date, sellerName, sellerPhone, items:[...], total, paidAmount, balance, method, reference, notes, linkedExpenseId, createdAt}]
let fishPayments = [];   // [{id, date, sellerName, sellerPhone, amount, method, reference, notes, createdAt}]
let fishBillItemRowSeq = 0;
let currentViewedFishBillId = null;

function dbFishBillToLocal(b, items) {
  return {
    id: b.id,
    billNo: b.bill_no,
    date: b.bill_date,
    purchaseType: b.purchase_type || 'raw_fish', // 'raw_fish' | 'readymade_umbalakada'
    sellerName: b.seller_name,
    sellerPhone: b.seller_phone,
    total: Number(b.total_amount) || 0,
    paidAmount: Number(b.paid_amount) || 0,
    balance: (Number(b.total_amount) || 0) - (Number(b.paid_amount) || 0),
    method: b.payment_method || 'cash',
    reference: b.payment_reference || '',
    notes: b.notes || '',
    linkedExpenseId: b.linked_expense_id || null,
    createdAt: b.created_at,
    items: (items || []).map(it => ({
      id: it.id,
      fishType: it.fish_type,
      quantityKg: Number(it.quantity_kg) || 0,
      pricePerKg: Number(it.price_per_kg) || 0,
      subtotal: Number(it.subtotal) || 0
    }))
  };
}
function dbFishPaymentToLocal(p) {
  return {
    id: p.id,
    date: p.payment_date,
    sellerName: p.seller_name,
    sellerPhone: p.seller_phone,
    amount: Number(p.amount) || 0,
    method: p.method || 'cash',
    reference: p.reference || '',
    notes: p.notes || '',
    createdAt: p.created_at
  };
}

async function loadFishBillsFromCloud() {
  if (!currentUser) return;
  try {
    const { data: bills, error: billErr } = await supabase.from('fish_bills').select('*').order('bill_date', { ascending: false }).order('created_at', { ascending: false });
    if (billErr) throw billErr;
    const billIds = (bills || []).map(b => b.id);
    let items = [];
    if (billIds.length) {
      const { data: itemRows, error: itemErr } = await supabase.from('fish_bill_items').select('*').in('bill_id', billIds);
      if (itemErr) throw itemErr;
      items = itemRows || [];
    }
    fishBills = (bills || []).map(b => dbFishBillToLocal(b, items.filter(it => it.bill_id === b.id)));
  } catch (e) {
    console.error('Load fish bills error:', e);
    updateStatus('⚠️ Could not load fish bills from cloud');
  }
}

async function loadFishPaymentsFromCloud() {
  if (!currentUser) return;
  try {
    const { data, error } = await supabase.from('fish_payments').select('*').order('payment_date', { ascending: false });
    if (error) throw error;
    fishPayments = (data || []).map(dbFishPaymentToLocal);
  } catch (e) {
    console.error('Load fish payments error:', e);
    updateStatus('⚠️ Could not load seller payments from cloud');
  }
}

function generateFishBillNo(dateStr, type) {
  const d = (dateStr || new Date().toISOString().slice(0, 10)).replace(/-/g, '');
  const prefix = type === 'readymade_umbalakada' ? 'RM' : 'FB';
  const countToday = fishBills.filter(b => b.billNo && b.billNo.startsWith(`${prefix}-${d}`)).length;
  return `${prefix}-${d}-${String(countToday + 1).padStart(3, '0')}`;
}

function knownSellers() {
  const map = {};
  fishBills.forEach(b => { if (b.sellerPhone) map[b.sellerPhone] = b.sellerName; });
  return map;
}

function populateSellerDatalists() {
  const map = knownSellers();
  const phoneList = $('knownSellerPhones');
  const nameList = $('knownSellerNames');
  if (phoneList) phoneList.innerHTML = Object.keys(map).map(phone => `<option value="${phone}">`).join('');
  if (nameList) nameList.innerHTML = Object.values(map).map(name => `<option value="${name}">`).join('');
}

function fillSellerNameFromPhone() {
  const phone = $('fbSellerPhone').value.trim();
  const map = knownSellers();
  if (map[phone] && !$('fbSellerName').value.trim()) $('fbSellerName').value = map[phone];
}

function addFishBillItemRow(prefill) {
  const tbody = $('fbItemsBody');
  if (!tbody) return;
  const rowId = 'fbi_' + (++fishBillItemRowSeq);
  const placeholder = window.currentFishBillType === 'readymade_umbalakada' ? 'e.g. Fine Ground Powder' : 'e.g. Skipjack Tuna';
  const tr = document.createElement('tr');
  tr.id = rowId;
  tr.innerHTML = `
    <td><input type="text" class="fbi-type" placeholder="${placeholder}" value="${prefill?.fishType || ''}" style="min-width:110px;"></td>
    <td><input type="number" class="fbi-qty" min="0" step="0.1" value="${prefill?.quantityKg || 0}" style="width:80px;" oninput="recalcFishBillTotal()"></td>
    <td><input type="number" class="fbi-price" min="0" value="${prefill?.pricePerKg || 0}" style="width:90px;" oninput="recalcFishBillTotal()"></td>
    <td class="fbi-subtotal" style="white-space:nowrap;">Rs. 0</td>
    <td><button type="button" class="btn btn-sm btn-danger" onclick="removeFishBillItemRow('${rowId}')">🗑️</button></td>
  `;
  tbody.appendChild(tr);
  recalcFishBillTotal();
}

function removeFishBillItemRow(rowId) {
  const tbody = $('fbItemsBody');
  const row = document.getElementById(rowId);
  if (row) row.remove();
  if (tbody && tbody.children.length === 0) addFishBillItemRow();
  recalcFishBillTotal();
}

function recalcFishBillTotal() {
  const tbody = $('fbItemsBody');
  if (!tbody) return;
  let total = 0;
  Array.from(tbody.children).forEach(row => {
    const qty = Number(row.querySelector('.fbi-qty')?.value) || 0;
    const price = Number(row.querySelector('.fbi-price')?.value) || 0;
    const subtotal = qty * price;
    total += subtotal;
    const cell = row.querySelector('.fbi-subtotal');
    if (cell) cell.textContent = fmt(subtotal);
  });
  $('fbTotal').value = total.toFixed(2);
  const paid = Number($('fbPaidAmount').value) || 0;
  $('fbBalance').value = Math.max(0, total - paid).toFixed(2);
}

function openNewFishBill(type) {
  const isReadymade = type === 'readymade_umbalakada';
  if (userRole !== 'owner') { alert(`Only the owner can add a ${isReadymade ? 'purchase' : 'fish'} bill.`); return; }
  window.currentFishBillType = isReadymade ? 'readymade_umbalakada' : 'raw_fish';

  if ($('fbModalTitle')) $('fbModalTitle').textContent = isReadymade ? 'New Ready-Made Umbalakada Bill' : 'New Fish Bill';
  if ($('fbModalSubtitle')) $('fbModalSubtitle').textContent = isReadymade
    ? "add every grade of ready-made Umbalakada bought in today — for days you're buying it in instead of grinding your own."
    : 'add every fish type bought from this seller today.';
  if ($('fbItemsLabel')) $('fbItemsLabel').textContent = isReadymade ? 'Umbalakada Items' : 'Fish Items';
  if ($('fbItemsTypeHeader')) $('fbItemsTypeHeader').textContent = isReadymade ? 'Grade / Description' : 'Fish Type';
  if ($('fbAddItemBtn')) $('fbAddItemBtn').innerHTML = `<i class="business-icon icon-inline" data-lucide="plus" aria-hidden="true"></i> Add Item`;

  const today = new Date().toISOString().slice(0, 10);
  $('fbDate').value = today;
  $('fbBillNoPreview').textContent = generateFishBillNo(today, window.currentFishBillType);
  $('fbSellerName').value = '';
  $('fbSellerPhone').value = '';
  $('fbItemsBody').innerHTML = '';
  addFishBillItemRow();
  $('fbPaidAmount').value = 0;
  $('fbPaymentMethod').value = 'cash';
  $('fbPaymentReference').value = '';
  $('fbNotes').value = '';
  recalcFishBillTotal();
  populateSellerDatalists();
  if (window.lucide) lucide.createIcons();
  $('fishBillModal').classList.add('active');
}
window.openNewFishBill = openNewFishBill;

async function saveFishBill() {
  const isReadymade = window.currentFishBillType === 'readymade_umbalakada';
  const date = $('fbDate').value || new Date().toISOString().slice(0, 10);
  const sellerName = $('fbSellerName').value.trim();
  const sellerPhone = $('fbSellerPhone').value.trim();
  const paidAmount = Number($('fbPaidAmount').value) || 0;
  const method = $('fbPaymentMethod').value;
  const reference = $('fbPaymentReference').value.trim();
  const notes = $('fbNotes').value.trim();

  const items = Array.from($('fbItemsBody').children).map(row => ({
    fishType: row.querySelector('.fbi-type')?.value.trim() || '',
    quantityKg: Number(row.querySelector('.fbi-qty')?.value) || 0,
    pricePerKg: Number(row.querySelector('.fbi-price')?.value) || 0
  })).filter(it => it.fishType && it.quantityKg > 0 && it.pricePerKg > 0)
    .map(it => ({ ...it, subtotal: it.quantityKg * it.pricePerKg }));

  const total = items.reduce((s, it) => s + it.subtotal, 0);

  if (!currentUser) { alert('Please login first.'); return; }
  if (!sellerName || !sellerPhone) { alert('Enter the seller name and phone number.'); return; }
  if (items.length === 0) { alert(`Add at least one ${isReadymade ? 'item' : 'fish item'} with quantity and price.`); return; }
  if (paidAmount > total) { alert('Amount given cannot be more than the bill total.'); return; }
  if (!(await ensureFreshSession())) return;

  const billNo = generateFishBillNo(date, window.currentFishBillType);
  const expenseCategory = isReadymade ? 'Ready-Made Umbalakada' : 'Raw Fish';

  // 1) Mirror the bill total into `expenses` (category "Raw Fish" or
  //    "Ready-Made Umbalakada") so it flows into Expenses + the Profit
  //    chart, and into the Income tab's Real Income panel, automatically.
  let linkedExpenseId = null;
  try {
    const itemSummary = items.map(it => `${it.fishType} ${it.quantityKg}kg`).join(', ');
    const { data: expData, error: expErr } = await supabase.from('expenses').insert({
      expense_date: date,
      category: expenseCategory,
      description: `Bill ${billNo} — ${itemSummary} — ${sellerName}`,
      amount: total,
      created_by: currentUser.id
    }).select().single();
    if (expErr) throw expErr;
    linkedExpenseId = expData.id;
    expenses.unshift(dbExpenseToLocal(expData));
  } catch (e) {
    console.error('Mirror fish bill to expenses error:', e);
    alert('❌ Could not save the cost record: ' + e.message);
    return;
  }

  // 2) Save the bill header.
  let savedBill = null;
  try {
    const { data, error } = await supabase.from('fish_bills').insert({
      business_id: businessId,
      bill_no: billNo,
      bill_date: date,
      purchase_type: window.currentFishBillType || 'raw_fish',
      seller_name: sellerName,
      seller_phone: sellerPhone,
      total_amount: total,
      paid_amount: paidAmount,
      payment_method: method,
      payment_reference: reference,
      notes,
      linked_expense_id: linkedExpenseId,
      created_by: currentUser.id
    }).select().single();
    if (error) throw error;
    savedBill = data;
  } catch (e) {
    console.error('Save fish bill error:', e);
    alert('❌ Could not save the bill: ' + e.message);
    return;
  }

  // 3) Save the line items.
  let savedItems = [];
  try {
    const itemRows = items.map(it => ({
      bill_id: savedBill.id,
      fish_type: it.fishType,
      quantity_kg: it.quantityKg,
      price_per_kg: it.pricePerKg,
      subtotal: it.subtotal
    }));
    const { data, error } = await supabase.from('fish_bill_items').insert(itemRows).select();
    if (error) throw error;
    savedItems = data || [];
  } catch (e) {
    console.error('Save fish bill items error:', e);
    alert('⚠️ Bill saved but items failed to save: ' + e.message);
  }

  fishBills.unshift(dbFishBillToLocal(savedBill, savedItems));
  renderFishBills();
  renderReadymadeBills();
  renderSellerLedger();
  renderProductCosting();
  renderExpenses();
  updateMonthlySummary();
  closeModal('fishBillModal');
  updateStatus(isReadymade ? `✅ Ready-made purchase bill ${billNo} saved — Income tab updated` : `✅ Fish bill ${billNo} saved`);
}

async function deleteFishBill(id) {
  if (userRole !== 'owner') { alert('Only the owner can delete a bill.'); return; }
  if (!confirm('Delete this fish bill? This also removes its matching cost from Expenses.')) return;
  if (!currentUser) { alert('Please login first.'); return; }
  if (!(await ensureFreshSession())) return;

  const bill = fishBills.find(b => b.id === id);
  try {
    const { error } = await supabase.from('fish_bills').delete().eq('id', id);
    if (error) throw error;
    if (bill?.linkedExpenseId) {
      await supabase.from('expenses').delete().eq('id', bill.linkedExpenseId);
      expenses = expenses.filter(e => e.id !== bill.linkedExpenseId);
    }
  } catch (e) {
    console.error('Delete fish bill error:', e);
    alert('❌ Could not delete: ' + e.message);
    return;
  }
  fishBills = fishBills.filter(b => b.id !== id);
  renderFishBills();
  renderReadymadeBills();
  renderSellerLedger();
  renderProductCosting();
  renderExpenses();
  updateMonthlySummary();
  updateStatus('🗑️ Fish bill deleted');
}

function viewFishBill(id) {
  const bill = fishBills.find(b => b.id === id);
  if (!bill) return;
  currentViewedFishBillId = id;
  const isReadymade = bill.purchaseType === 'readymade_umbalakada';
  if ($('fbvTitle')) $('fbvTitle').textContent = isReadymade ? 'Ready-Made Umbalakada Bill' : 'Fish Purchase Bill';
  if ($('fbvItemsHeader')) $('fbvItemsHeader').textContent = isReadymade ? 'Grade / Description' : 'Fish Type';
  $('fbvBillNo').textContent = `Bill No. ${bill.billNo}`;
  $('fbvDate').textContent = bill.date;
  $('fbvSeller').textContent = `${bill.sellerName} (${bill.sellerPhone})`;
  $('fbvItemsBody').innerHTML = bill.items.map(it => `
    <tr><td>${it.fishType}</td><td>${it.quantityKg}</td><td>${fmt(it.pricePerKg)}</td><td>${fmt(it.subtotal)}</td></tr>
  `).join('');
  $('fbvTotal').textContent = fmt(bill.total);
  $('fbvPaid').textContent = fmt(bill.paidAmount);
  $('fbvBalance').textContent = fmt(bill.balance);
  $('fbvMethod').textContent = bill.method;
  $('fbvReference').textContent = bill.reference ? `(Ref: ${bill.reference})` : '';
  $('fbvNotesWrap').style.display = bill.notes ? 'block' : 'none';
  $('fbvNotes').textContent = bill.notes || '';
  $('fishBillViewModal').classList.add('active');
}

function printFishBill(id) {
  const bill = fishBills.find(b => b.id === (id || currentViewedFishBillId));
  if (!bill) return;
  const isReadymade = bill.purchaseType === 'readymade_umbalakada';
  const docTitle = isReadymade ? 'Ready-Made Umbalakada Purchase Bill' : 'Fish Purchase Bill';
  const w = window.open('', '_blank', 'width=480,height=700');
  if (!w) { alert('Please allow pop-ups to print the bill.'); return; }
  const itemRows = bill.items.map(it => `
    <div class="row"><span>${it.fishType} — ${it.quantityKg}kg × ${fmt(it.pricePerKg)}</span><strong>${fmt(it.subtotal)}</strong></div>
  `).join('');
  w.document.write(`<!doctype html><html><head><title>${docTitle} ${bill.billNo}</title><style>
    body{font-family:Arial,sans-serif;padding:28px;color:#10231b}h1{margin:0;color:#059669;font-size:20px}h2{margin:4px 0 20px;font-size:15px;font-weight:600;color:#456}
    .box{border:1px solid #ddd;border-radius:12px;padding:16px;margin:12px 0}.row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #eee;font-size:14px}
    .total{font-size:17px;font-weight:800;color:#059669;border-top:2px solid #d4af37;border-bottom:0;margin-top:6px;padding-top:10px}
    .bad{color:#d45d55} small{color:#667} @media print{button{display:none}}
  </style></head><body>
  <h1>${docTitle}</h1><h2>${bill.billNo} — ${bill.date}</h2>
  <div class="box"><strong>Seller:</strong> ${bill.sellerName}<br><strong>Phone:</strong> ${bill.sellerPhone}</div>
  <div class="box">${itemRows}
    <div class="row total"><span>Bill Total</span><strong>${fmt(bill.total)}</strong></div>
    <div class="row"><span>Amount Given (${bill.method}${bill.reference ? ' — ' + bill.reference : ''})</span><strong>${fmt(bill.paidAmount)}</strong></div>
    <div class="row ${bill.balance > 0 ? 'bad' : ''}"><span>Balance Owed</span><strong>${fmt(bill.balance)}</strong></div>
  </div>
  ${bill.notes ? `<div class="box"><small>Note: ${bill.notes}</small></div>` : ''}
  <button onclick="window.print()">Print</button></body></html>`);
  w.document.close(); w.focus(); setTimeout(() => w.print(), 250);
}

function openSellerPayment(sellerName, sellerPhone) {
  if (userRole !== 'owner') { alert('Only the owner can record a payment.'); return; }
  $('spSellerName').value = sellerName;
  $('spSellerPhone').value = sellerPhone;
  $('sellerPaymentSubtitle').textContent = `Settle balance with ${sellerName} (${sellerPhone}).`;
  $('spDate').value = new Date().toISOString().slice(0, 10);
  $('spAmount').value = 0;
  $('spMethod').value = 'cash';
  $('spReference').value = '';
  $('spNotes').value = '';
  $('sellerPaymentModal').classList.add('active');
}

async function saveSellerPayment() {
  const sellerName = $('spSellerName').value;
  const sellerPhone = $('spSellerPhone').value;
  const date = $('spDate').value || new Date().toISOString().slice(0, 10);
  const amount = Number($('spAmount').value) || 0;
  const method = $('spMethod').value;
  const reference = $('spReference').value.trim();
  const notes = $('spNotes').value.trim();

  if (!currentUser) { alert('Please login first.'); return; }
  if (amount <= 0) { alert('Enter an amount greater than 0!'); return; }
  if (!(await ensureFreshSession())) return;

  const row = { business_id: businessId, seller_name: sellerName, seller_phone: sellerPhone, payment_date: date, amount, method, reference, notes, created_by: currentUser.id };
  try {
    const { data, error } = await supabase.from('fish_payments').insert(row).select().single();
    if (error) throw error;
    fishPayments.unshift(dbFishPaymentToLocal(data));
  } catch (e) {
    console.error('Save seller payment error:', e);
    alert('❌ Could not save payment: ' + e.message);
    return;
  }

  renderSellerLedger();
  renderFishBills();
  closeModal('sellerPaymentModal');
  if (document.getElementById('sellerHistoryModal')?.classList.contains('active')) {
    openSellerHistory(sellerName, sellerPhone);
  }
  updateStatus('✅ Payment recorded');
}

function sellerAggregate(sellerPhone) {
  const bills = fishBills.filter(b => b.sellerPhone === sellerPhone);
  const payments = fishPayments.filter(p => p.sellerPhone === sellerPhone);
  const bought = bills.reduce((s, b) => s + b.total, 0);
  const paidAtPurchase = bills.reduce((s, b) => s + b.paidAmount, 0);
  const extraPaid = payments.reduce((s, p) => s + p.amount, 0);
  const totalPaid = paidAtPurchase + extraPaid;
  const balance = bought - totalPaid;
  const lastDate = bills.length ? bills.map(b => b.date).sort().slice(-1)[0] : '—';
  const name = bills[0]?.sellerName || payments[0]?.sellerName || sellerPhone;
  return { name, phone: sellerPhone, bought, paid: totalPaid, balance, lastDate, bills, payments };
}

function renderFishBills() {
  const tbody = $('fishBillBody');
  const list = fishBills.filter(b => b.purchaseType !== 'readymade_umbalakada');
  if (tbody) {
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;opacity:0.5;padding:20px;">No fish bills yet.</td></tr>';
    } else {
      tbody.innerHTML = list.map(b => {
        const itemsSummary = b.items.map(it => `${it.fishType} ${it.quantityKg}kg`).join(', ') || '—';
        return `
        <tr>
          <td>${b.billNo}</td>
          <td>${b.date}</td>
          <td>${b.sellerName}<br><small style="opacity:.65;">${b.sellerPhone}</small></td>
          <td style="max-width:180px;">${itemsSummary}</td>
          <td>${fmt(b.total)}</td>
          <td>${fmt(b.paidAmount)}</td>
          <td>${b.balance > 0.01 ? `<span class="badge badge-warn">${fmt(b.balance)}</span>` : `<span class="badge badge-good">Settled</span>`}</td>
          <td style="text-transform:capitalize;">${b.method}</td>
          <td style="white-space:nowrap;">
            ${actionMenuHTML([
              { label: 'View', icon: '👁️', onclick: `viewFishBill('${b.id}')` },
              userRole === 'owner' ? { label: 'Delete', icon: '🗑️', danger: true, onclick: `deleteFishBill('${b.id}')` } : null
            ])}
          </td>
        </tr>`;
      }).join('');
    }
  }

  const todayBills = list.filter(b => isToday(b.date));
  const monthBills = list.filter(b => isThisMonth(b.date));
  const todayTotal = todayBills.reduce((s, b) => s + b.total, 0);
  const monthTotal = monthBills.reduce((s, b) => s + b.total, 0);

  const sellerPhones = [...new Set(fishBills.map(b => b.sellerPhone))];
  const aggregates = sellerPhones.map(sellerAggregate);
  const totalOwed = aggregates.reduce((s, a) => s + Math.max(0, a.balance), 0);
  const sellersWithDues = aggregates.filter(a => a.balance > 0.01).length;

  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('fishTodayTotal', fmt(todayTotal));
  set('fishMonthTotal', fmt(monthTotal));
  set('fishTotalOwed', fmt(totalOwed));
  set('fishSellersWithDues', sellersWithDues);
  calcRealIncome();
  syncDailyRawKgFromBills();
}
window.renderFishBills = renderFishBills;

// ==================== READY-MADE UMBALAKADA PURCHASE (Costing tab) ====================
// For days the owner doesn't grind their own Umbalakada and instead buys
// it ready-made/ground from another seller. Same full bill/invoice engine
// as the Fish Bills above (fish_bills + fish_bill_items, seller ledger,
// payments, printable invoice) — just tagged purchase_type =
// 'readymade_umbalakada' so it lists separately here instead of mixing
// into the Production tab's raw-fish bills, while still counting toward
// the real cost total on the Income tab (calcRealIncome() sums ALL
// fish_bills regardless of type — see the "Real Raw Material Cost" card).
function renderReadymadeBills() {
  const tbody = $('readymadeBillBody');
  const list = fishBills.filter(b => b.purchaseType === 'readymade_umbalakada');
  if (tbody) {
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;opacity:0.5;padding:20px;">No ready-made purchase bills yet.</td></tr>';
    } else {
      tbody.innerHTML = list.map(b => {
        const itemsSummary = b.items.map(it => `${it.fishType} ${it.quantityKg}kg`).join(', ') || '—';
        return `
        <tr>
          <td>${b.billNo}</td>
          <td>${b.date}</td>
          <td>${b.sellerName}<br><small style="opacity:.65;">${b.sellerPhone}</small></td>
          <td style="max-width:180px;">${itemsSummary}</td>
          <td>${fmt(b.total)}</td>
          <td>${fmt(b.paidAmount)}</td>
          <td>${b.balance > 0.01 ? `<span class="badge badge-warn">${fmt(b.balance)}</span>` : `<span class="badge badge-good">Settled</span>`}</td>
          <td style="white-space:nowrap;">
            ${actionMenuHTML([
              { label: 'View', icon: '👁️', onclick: `viewFishBill('${b.id}')` },
              userRole === 'owner' ? { label: 'Delete', icon: '🗑️', danger: true, onclick: `deleteFishBill('${b.id}')` } : null
            ])}
          </td>
        </tr>`;
      }).join('');
    }
  }

  const todayList = list.filter(b => isToday(b.date));
  const monthList = list.filter(b => isThisMonth(b.date));
  const todayTotal = todayList.reduce((s, b) => s + b.total, 0);
  const monthTotal = monthList.reduce((s, b) => s + b.total, 0);
  const todayQty = todayList.reduce((s, b) => s + b.items.reduce((si, it) => si + (Number(it.quantityKg) || 0), 0), 0);
  const todayAvgPrice = todayQty > 0 ? todayTotal / todayQty : 0;
  const sellerNamesToday = [...new Set(todayList.map(b => b.sellerName))];

  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('rmTodayTotal', fmt(todayTotal));
  set('rmMonthTotal', fmt(monthTotal));
  set('rmTodayQtyKg', fmt2(todayQty) + ' kg');
  set('rmTodayAvgPrice', fmt(todayAvgPrice));

  // ---- Income tab live card — same numbers, real time ----
  set('incomeReadymadeToday', fmt(todayTotal));
  set('incomeReadymadeTodayQty', fmt2(todayQty) + ' kg');
  set('incomeReadymadeTodaySeller', sellerNamesToday.length ? sellerNamesToday.join(', ') : '—');
  const noteEl = $('incomeReadymadeNote');
  if (noteEl) {
    noteEl.textContent = todayList.length > 0
      ? `🔄 Synced live from ${todayList.length} ready-made purchase bill${todayList.length > 1 ? 's' : ''} saved today in the Costing tab.`
      : 'No ready-made purchase bills saved for today.';
  }
}
window.renderReadymadeBills = renderReadymadeBills;

function renderSellerLedger() {
  const tbody = $('sellerLedgerBody');
  if (!tbody) return;

  const sellerPhones = [...new Set([...fishBills.map(b => b.sellerPhone), ...fishPayments.map(p => p.sellerPhone)])];
  if (sellerPhones.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;opacity:0.5;padding:20px;">No sellers yet.</td></tr>';
    return;
  }

  const aggregates = sellerPhones.map(sellerAggregate).sort((a, b) => b.balance - a.balance);

  tbody.innerHTML = aggregates.map(a => `
    <tr>
      <td>${a.name}</td>
      <td>${a.phone}</td>
      <td>${fmt(a.bought)}</td>
      <td>${fmt(a.paid)}</td>
      <td>${a.balance > 0.01 ? `<span class="badge badge-warn">${fmt(a.balance)}</span>` : `<span class="badge badge-good">Settled</span>`}</td>
      <td>${a.lastDate}</td>
      <td style="white-space:nowrap;">
        ${actionMenuHTML([
          { label: 'History', icon: '📜', onclick: `openSellerHistory('${a.name.replace(/'/g, "\\'")}','${a.phone}')` },
          userRole === 'owner' ? { label: 'Pay', icon: '💵', onclick: `openSellerPayment('${a.name.replace(/'/g, "\\'")}','${a.phone}')` } : null
        ])}
      </td>
    </tr>
  `).join('');
}

function openSellerHistory(sellerName, sellerPhone) {
  const a = sellerAggregate(sellerPhone);
  $('shSellerTitle').textContent = `${a.name} — History`;
  $('shSellerSubtitle').textContent = `Phone: ${a.phone}`;
  $('shTotalBilled').textContent = fmt(a.bought);
  $('shTotalPaid').textContent = fmt(a.paid);
  $('shBalance').textContent = fmt(a.balance);
  $('shBillsBody').innerHTML = a.bills.length ? a.bills.map(b => `
    <tr><td>${b.billNo}</td><td>${b.date}</td><td>${fmt(b.total)}</td><td>${fmt(b.paidAmount)}</td><td>${b.balance > 0.01 ? fmt(b.balance) : 'Settled'}</td></tr>
  `).join('') : '<tr><td colspan="5" style="text-align:center;opacity:.5;padding:12px;">No bills yet.</td></tr>';
  $('shPaymentsBody').innerHTML = a.payments.length ? a.payments.map(p => `
    <tr><td>${p.date}</td><td>${fmt(p.amount)}</td><td style="text-transform:capitalize;">${p.method}</td><td>${p.reference || '-'}</td></tr>
  `).join('') : '<tr><td colspan="4" style="text-align:center;opacity:.5;padding:12px;">No extra payments yet.</td></tr>';
  const payBtn = $('shPayBtn');
  if (payBtn) payBtn.onclick = () => openSellerPayment(a.name, a.phone);
  $('sellerHistoryModal').classList.add('active');
}

// ==================== PRODUCTION BATCHES (Batch / Lot Traceability) ====================
// A "batch" is one production run — e.g. today's Linna curing run. It
// records the raw kg used (optionally traced back to specific fish_bills
// line items), the planned finished output (from the Production Model's
// live yield factor), and later the actual finished output once
// curing/drying is done — so owners can see planned-vs-actual yield
// variance per batch and per fish type over time.
//
// REQUIRED ONE-TIME SUPABASE SETUP: run production_batches_setup.sql once
// in the Supabase SQL editor before using this feature.

let productionBatches = [];   // [{id, batchNo, date, fishType, rawKgUsed, yieldFactorSnapshot, plannedFinishedKg, actualFinishedKg, costPerKgSnapshot, status, notes, sources:[{id, fishBillId, fishBillItemId, kgAllocated}], createdAt}]
let batchSourceRowSeq = 0;

function dbBatchToLocal(b, sources) {
  return {
    id: b.id,
    batchNo: b.batch_no,
    date: b.batch_date,
    fishType: b.fish_type,
    rawKgUsed: Number(b.raw_kg_used) || 0,
    yieldFactorSnapshot: Number(b.yield_factor_snapshot) || 1,
    plannedFinishedKg: Number(b.planned_finished_kg) || 0,
    actualFinishedKg: b.actual_finished_kg !== null && b.actual_finished_kg !== undefined ? Number(b.actual_finished_kg) : null,
    costPerKgSnapshot: Number(b.cost_per_kg_snapshot) || 0,
    rawCostPerKgSnapshot: Number(b.raw_cost_per_kg_snapshot) || 0,
    ingredientsCostPerKgSnapshot: Number(b.ingredients_cost_per_kg_snapshot) || 0,
    fixedCostPerKgSnapshot: Number(b.fixed_cost_per_kg_snapshot) || 0,
    realRawCost: b.real_raw_cost !== null && b.real_raw_cost !== undefined ? Number(b.real_raw_cost) : null,
    status: b.status || 'in_progress',
    notes: b.notes || '',
    createdAt: b.created_at,
    sources: (sources || []).map(s => ({
      id: s.id,
      fishBillId: s.fish_bill_id,
      fishBillItemId: s.fish_bill_item_id,
      kgAllocated: Number(s.kg_allocated) || 0
    }))
  };
}

async function loadProductionBatchesFromCloud() {
  if (!currentUser) return;
  try {
    const { data: batches, error: bErr } = await supabase.from('production_batches').select('*').order('batch_date', { ascending: false }).order('created_at', { ascending: false });
    if (bErr) throw bErr;
    const batchIds = (batches || []).map(b => b.id);
    let sources = [];
    if (batchIds.length) {
      const { data: srcRows, error: sErr } = await supabase.from('production_batch_sources').select('*').in('batch_id', batchIds);
      if (sErr) throw sErr;
      sources = srcRows || [];
    }
    productionBatches = (batches || []).map(b => dbBatchToLocal(b, sources.filter(s => s.batch_id === b.id)));
  } catch (e) {
    console.error('Load production batches error:', e);
    const missingTable = /relation .* does not exist/i.test(e?.message || '');
    if (!missingTable) updateStatus('⚠️ Could not load production batches from cloud');
    productionBatches = [];
  }
}
window.loadProductionBatchesFromCloud = loadProductionBatchesFromCloud;

function generateBatchNo(dateStr) {
  const d = (dateStr || new Date().toISOString().slice(0, 10)).replace(/-/g, '');
  const countToday = productionBatches.filter(b => b.batchNo && b.batchNo.includes(d)).length;
  return `BATCH-${d}-${countToday + 1}`;
}

// kg of a fish_bill_item already allocated to OTHER batches (used to work
// out how much is still available to allocate to a new batch).
function kgAlreadyAllocated(fishBillItemId, excludeBatchId) {
  let used = 0;
  productionBatches.forEach(b => {
    if (b.id === excludeBatchId) return;
    (b.sources || []).forEach(s => {
      if (s.fishBillItemId === fishBillItemId) used += s.kgAllocated;
    });
  });
  return used;
}

// Recent (last 14 days) fish bill line items with remaining unallocated kg,
// regardless of exact fish-type label match (seller-recorded names vary),
// so the owner can tick whichever ones actually went into this batch.
function getAvailableFishBillSources() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 14);
  const rows = [];
  fishBills.filter(b => new Date(b.date) >= cutoff).forEach(bill => {
    (bill.items || []).forEach(item => {
      if (!item.id) return; // safety: only DB-backed items have ids
      const remaining = item.quantityKg - kgAlreadyAllocated(item.id, null);
      if (remaining > 0.01) {
        rows.push({
          fishBillId: bill.id, fishBillItemId: item.id, billNo: bill.billNo,
          sellerName: bill.sellerName, fishType: item.fishType, remainingKg: remaining
        });
      }
    });
  });
  return rows;
}

function refreshBatchSourcePicker() {
  const tbody = $('batchSourceBody');
  if (!tbody) return;
  const rows = getAvailableFishBillSources();
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;opacity:.5;padding:14px;">No recent unallocated fish bills.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((r, i) => `
    <tr>
      <td><input type="checkbox" class="bsrc-check" data-item-id="${r.fishBillItemId}" data-bill-id="${r.fishBillId}" data-max="${r.remainingKg}" onchange="onBatchSourceToggle(this)"></td>
      <td>${r.billNo}</td>
      <td>${r.sellerName}</td>
      <td>${r.fishType}</td>
      <td>${r.remainingKg.toFixed(1)} kg</td>
      <td><input type="number" class="bsrc-kg" min="0" step="0.1" max="${r.remainingKg}" value="0" disabled style="width:80px;" oninput="recalcBatchPlanned(true)"></td>
    </tr>
  `).join('');
}
window.refreshBatchSourcePicker = refreshBatchSourcePicker;

function onBatchSourceToggle(checkbox) {
  const row = checkbox.closest('tr');
  const kgInput = row.querySelector('.bsrc-kg');
  if (checkbox.checked) {
    kgInput.disabled = false;
    if (Number(kgInput.value) <= 0) kgInput.value = checkbox.dataset.max;
  } else {
    kgInput.disabled = true;
    kgInput.value = 0;
  }
  recalcBatchPlanned(true);
}
window.onBatchSourceToggle = onBatchSourceToggle;

// Recompute total raw kg (from ticked sources, unless the owner is editing
// the raw-kg field directly for manual/unrecorded stock) and the planned
// finished output for the currently selected fish type.
function recalcBatchPlanned(fromSources) {
  if (fromSources) {
    const tbody = $('batchSourceBody');
    let sum = 0;
    if (tbody) {
      Array.from(tbody.querySelectorAll('.bsrc-check:checked')).forEach(cb => {
        sum += Number(cb.closest('tr').querySelector('.bsrc-kg').value) || 0;
      });
    }
    // Only auto-fill from sources if at least one is ticked — otherwise
    // leave whatever the owner typed manually alone.
    if (sum > 0) $('batchRawKg').value = sum;
  }
  const fishType = $('batchFishType').value;
  const rawKg = Number($('batchRawKg').value) || 0;
  const info = lastProdCostByType[fishType] || lastProdCostByType['Other'] || { yieldFactor: 1, totalCostPerKg: 0 };
  const planned = info.yieldFactor > 0 ? rawKg / info.yieldFactor : 0;
  $('batchPlannedOut').value = planned.toFixed(1) + ' kg';
}
window.recalcBatchPlanned = recalcBatchPlanned;

function onBatchFishTypeChange() { recalcBatchPlanned(false); }
window.onBatchFishTypeChange = onBatchFishTypeChange;

function openNewBatchModal() {
  if (userRole !== 'owner') { alert('Only the owner can start a production batch.'); return; }
  const today = new Date().toISOString().slice(0, 10);
  $('batchDate').value = today;
  $('batchNoPreview').textContent = generateBatchNo(today);
  $('batchFishType').value = 'Linna';
  $('batchRawKg').value = 0;
  $('batchNotes').value = '';
  refreshBatchSourcePicker();
  recalcBatchPlanned(false);
  $('newBatchModal').classList.add('active');
}
window.openNewBatchModal = openNewBatchModal;

async function saveProductionBatch() {
  if (userRole !== 'owner') { alert('Only the owner can start a production batch.'); return; }
  if (!currentUser) { alert('Please login first.'); return; }

  const date = $('batchDate').value || new Date().toISOString().slice(0, 10);
  const fishType = $('batchFishType').value;
  const rawKg = Number($('batchRawKg').value) || 0;
  const notes = $('batchNotes').value.trim();

  if (rawKg <= 0) { alert('Enter the raw fish kg used for this batch.'); return; }
  if (!(await ensureFreshSession())) return;

  const info = lastProdCostByType[fishType] || lastProdCostByType['Other'] || { yieldFactor: 1, totalCostPerKg: 0, rawCostPerKg: 0 };
  const plannedFinishedKg = info.yieldFactor > 0 ? rawKg / info.yieldFactor : 0;
  const batchNo = generateBatchNo(date);

  const tbody = $('batchSourceBody');
  const sourceRows = tbody ? Array.from(tbody.querySelectorAll('.bsrc-check:checked')).map(cb => ({
    fishBillId: cb.dataset.billId,
    fishBillItemId: cb.dataset.itemId,
    kgAllocated: Number(cb.closest('tr').querySelector('.bsrc-kg').value) || 0
  })).filter(s => s.kgAllocated > 0) : [];

  // REAL COST: if this batch has linked fish-bill sources, work out what was
  // actually paid for that raw fish (real price_per_kg on those exact bill
  // items) instead of relying on the Production Model's manual raw-price
  // estimate. No sources ticked -> real_raw_cost stays null and the app
  // falls back to the estimate everywhere it's shown.
  let realRawCost = null;
  if (sourceRows.length > 0) {
    realRawCost = 0;
    sourceRows.forEach(s => {
      const bill = fishBills.find(b => b.id === s.fishBillId);
      const item = bill?.items?.find(it => it.id === s.fishBillItemId);
      const pricePerKg = item ? item.pricePerKg : (info.rawCostPerKg / (info.yieldFactor || 1));
      realRawCost += s.kgAllocated * pricePerKg;
    });
  }

  let savedBatch = null;
  try {
    const { data, error } = await supabase.from('production_batches').insert({
      business_id: businessId,
      batch_no: batchNo,
      batch_date: date,
      fish_type: fishType,
      raw_kg_used: rawKg,
      yield_factor_snapshot: info.yieldFactor,
      planned_finished_kg: plannedFinishedKg,
      cost_per_kg_snapshot: info.totalCostPerKg,
      raw_cost_per_kg_snapshot: info.rawCostPerKg || 0,
      ingredients_cost_per_kg_snapshot: lastProdIngredientsCostPerKg || 0,
      fixed_cost_per_kg_snapshot: lastProdOverheadCostPerKg || 0,
      real_raw_cost: realRawCost,
      status: 'in_progress',
      notes,
      created_by: currentUser.id
    }).select().single();
    if (error) throw error;
    savedBatch = data;
  } catch (e) {
    console.error('Save production batch error:', e);
    const missingTable = /relation .* does not exist/i.test(e?.message || '');
    alert('❌ Could not save batch: ' + e.message + (missingTable ? '\n\nThe production_batches table hasn\'t been created yet — run production_batches_setup.sql in Supabase first.' : ''));
    return;
  }

  let savedSources = [];
  if (sourceRows.length) {
    try {
      const rows = sourceRows.map(s => ({
        batch_id: savedBatch.id, fish_bill_id: s.fishBillId, fish_bill_item_id: s.fishBillItemId, kg_allocated: s.kgAllocated
      }));
      const { data, error } = await supabase.from('production_batch_sources').insert(rows).select();
      if (error) throw error;
      savedSources = data || [];
    } catch (e) {
      console.error('Save batch sources error:', e);
      alert('⚠️ Batch saved but its fish-bill sources failed to save: ' + e.message);
    }
  }

  productionBatches.unshift(dbBatchToLocal(savedBatch, savedSources));
  renderProductionBatches();
  closeModal('newBatchModal');
  updateStatus(`✅ Batch ${batchNo} started`);
}
window.saveProductionBatch = saveProductionBatch;

function openCompleteBatchModal(id) {
  const b = productionBatches.find(x => x.id === id);
  if (!b) return;
  $('completeBatchModal').dataset.batchId = id;
  $('cbBatchNoLabel').textContent = b.batchNo;
  $('cbRawIn').textContent = b.rawKgUsed.toFixed(1) + ' kg';
  $('cbPlannedOut').textContent = b.plannedFinishedKg.toFixed(1) + ' kg';
  $('cbActualKg').value = b.actualFinishedKg ?? b.plannedFinishedKg.toFixed(1);
  $('cbVarianceNotice').textContent = 'Enter actual output to see yield variance.';
  previewBatchVariance();
  $('completeBatchModal').classList.add('active');
}
window.openCompleteBatchModal = openCompleteBatchModal;

function previewBatchVariance() {
  const modal = $('completeBatchModal');
  const b = productionBatches.find(x => x.id === modal?.dataset.batchId);
  if (!b) return;
  const actual = Number($('cbActualKg').value) || 0;
  const planned = b.plannedFinishedKg;
  const varianceKg = actual - planned;
  const variancePct = planned > 0 ? (varianceKg / planned) * 100 : 0;
  const notice = $('cbVarianceNotice');
  const sign = varianceKg >= 0 ? '+' : '';
  notice.innerHTML = `${sign}${varianceKg.toFixed(1)} kg vs planned (<strong>${sign}${variancePct.toFixed(1)}%</strong>) ${variancePct < -5 ? '— below planned yield.' : variancePct > 5 ? '— above planned yield.' : '— close to plan.'}`;
}
window.previewBatchVariance = previewBatchVariance;

async function saveBatchCompletion() {
  if (userRole !== 'owner') { alert('Only the owner can complete a batch.'); return; }
  const id = $('completeBatchModal').dataset.batchId;
  const b = productionBatches.find(x => x.id === id);
  if (!b) return;
  const actualKg = Number($('cbActualKg').value) || 0;
  if (actualKg <= 0) { alert('Enter the actual finished kg.'); return; }
  if (!(await ensureFreshSession())) return;

  try {
    const { error } = await supabase.from('production_batches').update({
      actual_finished_kg: actualKg, status: 'completed',
      completed_by: currentUser.id, completed_at: new Date().toISOString()
    }).eq('id', id);
    if (error) throw error;
  } catch (e) {
    console.error('Complete batch error:', e);
    alert('❌ Could not complete batch: ' + e.message);
    return;
  }

  b.actualFinishedKg = actualKg;
  b.status = 'completed';
  renderProductionBatches();
  closeModal('completeBatchModal');
  updateStatus(`✅ Batch ${b.batchNo} marked complete`);
}
window.saveBatchCompletion = saveBatchCompletion;

async function deleteProductionBatch(id) {
  if (userRole !== 'owner') { alert('Only the owner can delete a batch.'); return; }
  if (!confirm('Delete this batch? This also removes its fish-bill source links (the original bills are unaffected).')) return;
  if (!(await ensureFreshSession())) return;
  try {
    const { error } = await supabase.from('production_batches').delete().eq('id', id);
    if (error) throw error;
  } catch (e) {
    alert('❌ Could not delete batch: ' + e.message);
    return;
  }
  productionBatches = productionBatches.filter(b => b.id !== id);
  renderProductionBatches();
  updateStatus('🗑️ Batch deleted');
}
window.deleteProductionBatch = deleteProductionBatch;

// Real cost/kg for a batch: uses the REAL price paid on its linked fish
// bills (realRawCost) once the batch has an actual finished kg, falling
// back to null (shown as "—", estimate column still shows the old number)
// when the batch has no linked sources or isn't completed yet.
function batchRealCostPerKg(b) {
  if (b.realRawCost === null || !b.actualFinishedKg || b.actualFinishedKg <= 0) return null;
  return (b.realRawCost / b.actualFinishedKg) + (b.ingredientsCostPerKgSnapshot || 0) + (b.fixedCostPerKgSnapshot || 0);
}
window.batchRealCostPerKg = batchRealCostPerKg;

function renderProductionBatches() {
  const tbody = $('batchBody');
  if (!tbody) return;

  if (productionBatches.length === 0) {
    tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;opacity:.5;padding:20px;">No batches yet. Start one above.</td></tr>';
  } else {
    tbody.innerHTML = productionBatches.map(b => {
      const hasActual = b.actualFinishedKg !== null;
      const variancePct = hasActual && b.plannedFinishedKg > 0 ? ((b.actualFinishedKg - b.plannedFinishedKg) / b.plannedFinishedKg) * 100 : null;
      const varianceCell = variancePct === null ? '—' : `<span class="badge ${Math.abs(variancePct) <= 5 ? 'badge-good' : 'badge-bad'}">${variancePct >= 0 ? '+' : ''}${variancePct.toFixed(1)}%</span>`;
      const statusBadge = b.status === 'completed' ? '<span class="badge badge-good">Completed</span>' : '<span class="badge badge-warn">In Progress</span>';
      const realCostPerKg = batchRealCostPerKg(b);
      const realCostCell = realCostPerKg !== null
        ? `<span class="badge badge-good" title="From actual fish-bill prices">✅ ${fmt(realCostPerKg)}</span>`
        : (b.realRawCost === null ? `<span title="No linked fish bills — showing estimate only" style="opacity:.5;">est. only</span>` : `<span style="opacity:.5;">— pending</span>`);
      const actions = b.status === 'completed'
        ? (userRole === 'owner' ? actionMenuHTML([{ label: 'Delete', icon: '🗑️', danger: true, onclick: `deleteProductionBatch('${b.id}')` }]) : '')
        : (userRole === 'owner' ? actionMenuHTML([
            { label: 'Complete', icon: '✅', onclick: `openCompleteBatchModal('${b.id}')` },
            { label: 'Delete', icon: '🗑️', danger: true, onclick: `deleteProductionBatch('${b.id}')` }
          ]) : '');
      return `<tr>
        <td>${b.batchNo}</td>
        <td>${b.date}</td>
        <td>${b.fishType}</td>
        <td>${b.rawKgUsed.toFixed(1)} kg</td>
        <td>${b.plannedFinishedKg.toFixed(1)} kg</td>
        <td>${hasActual ? b.actualFinishedKg.toFixed(1) + ' kg' : '—'}</td>
        <td class="num">${varianceCell}</td>
        <td>${fmt(b.costPerKgSnapshot)}</td>
        <td>${realCostCell}</td>
        <td>${statusBadge}</td>
        <td style="white-space:nowrap;">${actions}</td>
      </tr>`;
    }).join('');
  }

  const now = new Date();
  const monthStr = now.toISOString().slice(0, 7);
  const thisMonth = productionBatches.filter(b => (b.date || '').startsWith(monthStr));
  const inProgress = productionBatches.filter(b => b.status === 'in_progress').length;
  const completedThisMonth = thisMonth.filter(b => b.status === 'completed');
  const finishedKgThisMonth = completedThisMonth.reduce((s, b) => s + (b.actualFinishedKg || 0), 0);
  const variances = completedThisMonth
    .filter(b => b.plannedFinishedKg > 0)
    .map(b => ((b.actualFinishedKg - b.plannedFinishedKg) / b.plannedFinishedKg) * 100);
  const avgVariance = variances.length ? variances.reduce((s, v) => s + v, 0) / variances.length : 0;

  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('batchInProgressCount', inProgress);
  set('batchCompletedCount', completedThisMonth.length);
  set('batchAvgVariance', (avgVariance >= 0 ? '+' : '') + avgVariance.toFixed(1) + '%');
  set('batchMonthFinishedKg', finishedKgThisMonth.toFixed(0) + ' kg');
  calcRealIncome();
}
window.renderProductionBatches = renderProductionBatches;

// ==================== RECURRING (DAILY) EXPENSES ====================
let recurringExpenses = [];

async function loadRecurringExpenses() {
  if (!currentUser) return;
  try {
    const { data, error } = await supabase
      .from('recurring_expenses')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    recurringExpenses = data || [];
  } catch (e) {
    console.error('Load recurring expenses error:', e);
  }
}

// Runs once per login/session: for every ACTIVE recurring rule this user
// created that hasn't produced today's entry yet, insert today's expense
// and stamp last_generated_date so it won't duplicate if this runs again.
async function generateDueRecurringExpenses() {
  if (!currentUser) return;
  const today = new Date().toISOString().slice(0, 10);
  const due = recurringExpenses.filter(r =>
    r.active && r.created_by === currentUser.id && r.last_generated_date !== today
  );
  if (!due.length) return;

  // PERFORMANCE: these rules are independent of one another, so on a day
  // with several due at once (e.g. after being offline a while) they used
  // to go one full insert+update round trip at a time. One session check
  // up front, then all rules together — same idea as the main login batch.
  if (!(await ensureFreshSession())) return;
  await Promise.all(due.map(async (r) => {
  try {
      const { data, error } = await supabase.from('expenses').insert({
        expense_date: today,
        category: r.category,
        description: r.description ? r.description : '(Auto daily expense)',
        amount: r.amount,
        created_by: currentUser.id
      }).select().single();
      if (error) throw error;
      expenses.unshift(dbExpenseToLocal(data));

      const { error: uerr } = await supabase
        .from('recurring_expenses')
        .update({ last_generated_date: today })
        .eq('id', r.id);
      if (uerr) throw uerr;
      r.last_generated_date = today;
    } catch (e) {
      console.error('Auto-generate recurring expense failed:', e);
    }
  }));
  renderExpenses();
  renderRecurringExpenses();
  updateMonthlySummary();
  updateStatus('🔁 Daily recurring expenses added');
}

async function editRecurringExpense(id) {
  const r = recurringExpenses.find(x => String(x.id) === String(id));
  if (!r) { alert('Entry not found.'); return; }
  const descStr = prompt('Description:', r.description || '');
  if (descStr === null) return;
  const amtStr = prompt('Amount (Rs.):', r.amount);
  if (amtStr === null) return;
  const amt = Number(amtStr);
  if (!amt || amt <= 0) { alert('Enter a valid amount greater than 0.'); return; }
  if (!(await ensureFreshSession())) return;
  try {
    const { error } = await supabase.from('recurring_expenses')
      .update({ description: descStr.trim(), amount: amt }).eq('id', id);
    if (error) throw error;
    r.description = descStr.trim(); r.amount = amt;
    renderRecurringExpenses();
    updateStatus('✅ Recurring expense updated');
  } catch (e) {
    console.error('Update recurring expense error:', e);
    alert('❌ Could not update: ' + e.message);
  }
}
window.editRecurringExpense = editRecurringExpense;

function renderRecurringExpenses() {
  const tbody = $('recurringExpensesBody');
  if (!tbody) return;
  const visible = recurringExpenses.filter(r => r.created_by === currentUser?.id || userRole === 'owner');
  if (!visible.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;opacity:0.5;padding:14px;">No recurring expenses set. Tick "Repeat this every day" when adding an expense.</td></tr>';
    return;
  }
  tbody.innerHTML = visible.map(r => `
    <tr>
      <td>${r.category}</td>
      <td>${r.description || '-'}</td>
      <td>${fmt(r.amount)}</td>
      <td>${r.active ? '🟢 Active' : '⏸️ Paused'}</td>
      <td>
        ${actionMenuHTML([
          { label: 'Edit', icon: '✏️', onclick: `editRecurringExpense('${r.id}')` },
          { label: r.active ? 'Pause' : 'Resume', icon: r.active ? '⏸️' : '▶️', onclick: `toggleRecurringExpense('${r.id}', ${!r.active})` },
          { label: 'Delete', icon: '🗑️', danger: true, onclick: `deleteRecurringExpense('${r.id}')` }
        ])}
      </td>
    </tr>
  `).join('');
}

async function toggleRecurringExpense(id, newActive) {
  if (!(await ensureFreshSession())) return;
  try {
    const { error } = await supabase.from('recurring_expenses').update({ active: newActive }).eq('id', id);
    if (error) throw error;
    const r = recurringExpenses.find(x => x.id === id);
    if (r) r.active = newActive;
    renderRecurringExpenses();
    updateStatus(newActive ? '<i class="business-icon icon-inline" data-lucide="play" aria-hidden="true"></i> Recurring expense resumed' : '⏸️ Recurring expense paused');
  } catch (e) {
    console.error('Toggle recurring expense error:', e);
    alert('❌ Could not update: ' + e.message);
  }
}

async function deleteRecurringExpense(id) {
  if (!confirm('Stop this recurring expense? Past auto-added entries stay in your Expenses list.')) return;
  if (!(await ensureFreshSession())) return;
  try {
    const { error } = await supabase.from('recurring_expenses').delete().eq('id', id);
    if (error) throw error;
    recurringExpenses = recurringExpenses.filter(r => r.id !== id);
    renderRecurringExpenses();
    updateStatus('🗑️ Recurring expense removed');
  } catch (e) {
    console.error('Delete recurring expense error:', e);
    alert('❌ Could not delete: ' + e.message);
  }
}

// ==================== SUPABASE-BACKED SALES / DAILY BUSINESS DIARY ====================
let sales = [];
let salesFilterState = { from: '', to: '', text: '' };

function dbSaleToLocal(s) {
  const total = Number(s.total_amount) || 0;
  const cost = Number(s.cost_amount) || 0;
  const wage = Number(s.wage_amount) || 0;
  const mktCost = Number(s.marketing_cost) || 0;
  const paid = Number(s.amount_paid) || 0;
  return {
    id: s.id,
    date: s.sale_date,
    product: s.product_name,
    productId: s.product_id || null,
    customer: s.customer_name || '',
    qty: Number(s.quantity) || 0,
    unitPrice: Number(s.unit_price) || 0,
    total,
    cost,
    wage,
    marketingChannel: s.marketing_channel || '',
    marketingCost: mktCost,
    paid,
    pending: Math.max(0, total - paid),
    profit: total - cost - wage - mktCost,
    notes: s.notes || '',
    createdAt: s.created_at,
    paymentMethod: s.payment_method || 'cash',
    chequeNumber: s.cheque_number || '',
    chequeBank: s.cheque_bank || '',
    chequeDate: s.cheque_date || '',
    chequeStatus: s.cheque_status || 'pending',
    depositBank: s.deposit_bank || '',
    depositRef: s.deposit_ref || '',
    depositDate: s.deposit_date || ''
  };
}

async function loadSalesFromCloud() {
  if (!currentUser) return;
  try {
    const { data, error } = await supabase
      .from('sales')
      .select('*')
      .eq('user_id', businessId)
      .order('sale_date', { ascending: false });
    if (error) throw error;
    sales = (data || []).map(dbSaleToLocal);
  } catch (e) {
    console.error('Load sales error:', e);
    updateStatus('⚠️ Could not load sales from cloud');
  }
}

function openNewSale() {
  $('saleModalTitle').textContent = 'New Sale';
  $('saleEditId').value = '';
  $('saleDate').value = new Date().toISOString().slice(0, 10);
  $('saleProduct').value = '';
  populateSaleProductDatalist();
  $('saleCustomer').value = '';
  $('saleQty').value = 1;
  $('saleUnitPrice').value = 0;
  $('saleTotal').value = 0;
  $('saleCost').value = 0;
  $('saleWage').value = 0;
  $('saleMarketingChannel').value = '';
  $('saleMarketingCost').value = 0;
  $('salePaid').value = 0;
  $('saleNotes').value = '';
  if ($('salePaymentMethod')) $('salePaymentMethod').value = 'cash';
  if ($('saleChequeNumber')) $('saleChequeNumber').value = '';
  if ($('saleChequeBank')) $('saleChequeBank').value = '';
  if ($('saleChequeDate')) $('saleChequeDate').value = new Date().toISOString().slice(0, 10);
  if ($('saleChequeStatus')) $('saleChequeStatus').value = 'pending';
  if ($('saleDepositBank')) $('saleDepositBank').value = '';
  if ($('saleDepositRef')) $('saleDepositRef').value = '';
  if ($('saleDepositDate')) $('saleDepositDate').value = new Date().toISOString().slice(0, 10);
  togglePaymentMethodFields();
  recalcSaleModal();
  $('saleModal').classList.add('active');
}

// Shows/hides the Cheque or Deposit detail block based on the chosen
// Payment Method — keeps the form short unless it's actually needed.
function togglePaymentMethodFields() {
  const method = $('salePaymentMethod') ? $('salePaymentMethod').value : 'cash';
  if ($('saleChequeFields')) $('saleChequeFields').style.display = (method === 'cheque') ? 'block' : 'none';
  if ($('saleDepositFields')) $('saleDepositFields').style.display = (method === 'deposit') ? 'block' : 'none';
}

function editSale(id) {
  const s = sales.find(x => x.id === id);
  if (!s) return;
  $('saleModalTitle').textContent = 'Edit Sale';
  $('saleEditId').value = s.id;
  $('saleDate').value = s.date;
  $('saleProduct').value = s.product;
  $('saleCustomer').value = s.customer;
  $('saleQty').value = s.qty;
  $('saleUnitPrice').value = s.unitPrice;
  $('saleTotal').value = s.total;
  $('saleCost').value = s.cost;
  $('saleWage').value = s.wage;
  $('saleMarketingChannel').value = s.marketingChannel;
  $('saleMarketingCost').value = s.marketingCost;
  $('salePaid').value = s.paid;
  $('saleNotes').value = s.notes;
  if ($('salePaymentMethod')) $('salePaymentMethod').value = s.paymentMethod || 'cash';
  if ($('saleChequeNumber')) $('saleChequeNumber').value = s.chequeNumber || '';
  if ($('saleChequeBank')) $('saleChequeBank').value = s.chequeBank || '';
  if ($('saleChequeDate')) $('saleChequeDate').value = s.chequeDate || '';
  if ($('saleChequeStatus')) $('saleChequeStatus').value = s.chequeStatus || 'pending';
  if ($('saleDepositBank')) $('saleDepositBank').value = s.depositBank || '';
  if ($('saleDepositRef')) $('saleDepositRef').value = s.depositRef || '';
  if ($('saleDepositDate')) $('saleDepositDate').value = s.depositDate || '';
  togglePaymentMethodFields();
  recalcSaleModal();
  $('saleModal').classList.add('active');
}

// Keeps Total in sync with Qty × Unit Price unless the user is editing
// Total directly (skipAuto=true), and always refreshes the live profit/
// pending preview at the bottom of the modal.
function recalcSaleModal(skipAuto) {
  const qty = Number($('saleQty').value) || 0;
  const unitPrice = Number($('saleUnitPrice').value) || 0;
  if (!skipAuto) $('saleTotal').value = (qty * unitPrice) || 0;
  const total = Number($('saleTotal').value) || 0;
  const cost = Number($('saleCost').value) || 0;
  const wage = Number($('saleWage').value) || 0;
  const mktCost = Number($('saleMarketingCost').value) || 0;
  const paid = Number($('salePaid').value) || 0;
  const profit = total - cost - wage - mktCost;
  const pending = Math.max(0, total - paid);
  if ($('saleLiveProfit')) $('saleLiveProfit').textContent = fmt(profit);
  if ($('saleLivePending')) $('saleLivePending').textContent = fmt(pending);
}

async function saveSale() {
  const editId = $('saleEditId').value;
  const date = $('saleDate').value || new Date().toISOString().slice(0, 10);
  const product = $('saleProduct').value.trim();
  const customer = $('saleCustomer').value.trim();
  const qty = Number($('saleQty').value) || 0;
  const unitPrice = Number($('saleUnitPrice').value) || 0;
  const total = Number($('saleTotal').value) || 0;
  const cost = Number($('saleCost').value) || 0;
  const wage = Number($('saleWage').value) || 0;
  const marketingChannel = $('saleMarketingChannel').value;
  const marketingCost = Number($('saleMarketingCost').value) || 0;
  const paid = Number($('salePaid').value) || 0;
  const notes = $('saleNotes').value.trim();
  const paymentMethod = $('salePaymentMethod') ? $('salePaymentMethod').value : 'cash';
  const chequeNumber = $('saleChequeNumber') ? $('saleChequeNumber').value.trim() : '';
  const chequeBank = $('saleChequeBank') ? $('saleChequeBank').value.trim() : '';
  const chequeDate = $('saleChequeDate') ? $('saleChequeDate').value : '';
  const chequeStatus = $('saleChequeStatus') ? $('saleChequeStatus').value : 'pending';
  const depositBank = $('saleDepositBank') ? $('saleDepositBank').value.trim() : '';
  const depositRef = $('saleDepositRef') ? $('saleDepositRef').value.trim() : '';
  const depositDate = $('saleDepositDate') ? $('saleDepositDate').value : '';

  if (!currentUser) { alert('Please login first.'); return; }
  if (!product) { alert('Enter a product name!'); return; }
  if (total <= 0) { alert('Total sale amount must be greater than 0!'); return; }
  if (paid > 0 && paymentMethod === 'cheque' && !chequeNumber) { alert('Enter the cheque number!'); return; }
  if (paid > 0 && paymentMethod === 'deposit' && !depositRef) { alert('Enter the deposit slip / reference number!'); return; }

  const matchedProduct = products.find(p => p.name === product);
  const oldSale = editId ? sales.find(s => s.id === editId) : null;
  const row = {
    user_id: businessId,
    sale_date: date,
    product_name: product,
    product_id: matchedProduct ? matchedProduct.id : null,
    customer_name: customer || null,
    quantity: qty,
    unit_price: unitPrice,
    total_amount: total,
    cost_amount: cost,
    wage_amount: wage,
    marketing_channel: marketingChannel || null,
    marketing_cost: marketingCost,
    amount_paid: paid,
    notes: notes || null,
    created_by: currentUser.id,
    payment_method: paymentMethod,
    cheque_number: paymentMethod === 'cheque' ? (chequeNumber || null) : null,
    cheque_bank: paymentMethod === 'cheque' ? (chequeBank || null) : null,
    cheque_date: paymentMethod === 'cheque' ? (chequeDate || null) : null,
    cheque_status: paymentMethod === 'cheque' ? chequeStatus : null,
    deposit_bank: paymentMethod === 'deposit' ? (depositBank || null) : null,
    deposit_ref: paymentMethod === 'deposit' ? (depositRef || null) : null,
    deposit_date: paymentMethod === 'deposit' ? (depositDate || null) : null
  };

  if (!(await ensureFreshSession())) return;
  try {
    if (editId) {
      let { data, error } = await supabase.from('sales').update(row).eq('id', editId).select().single();
      if (error && /column|schema|does not exist/i.test(error.message||'')) {
        const fallback = {...row}; delete fallback.product_id;
        ({ data, error } = await supabase.from('sales').update(fallback).eq('id', editId).select().single());
      }
      if (error) throw error;
      const idx = sales.findIndex(s => s.id === editId);
      if (idx !== -1) sales[idx] = dbSaleToLocal(data);
    } else {
      let { data, error } = await supabase.from('sales').insert(row).select().single();
      if (error && /column|schema|does not exist/i.test(error.message||'')) {
        const fallback = {...row}; delete fallback.product_id;
        ({ data, error } = await supabase.from('sales').insert(fallback).select().single());
      }
      if (error) throw error;
      sales.unshift(dbSaleToLocal(data));
    }
  } catch (e) {
    console.error('Save sale error:', e);
    alert('❌ Could not save sale: ' + e.message);
    return;
  }

  renderSales();
  closeModal('saleModal');
  updateStatus(editId ? '✅ Sale updated' : '✅ Sale saved to diary');

  // Inventory reconciliation — deduct/adjust stock for whichever product
  // this sale is now tied to. Runs after the sale itself is safely saved,
  // and never blocks or rolls back the sale if inventory isn't set up yet.
  const newProductId = matchedProduct ? matchedProduct.id : null;
  const newSaleId = editId || (sales[0] && sales[0].id);
  if (editId && oldSale) {
    if (oldSale.productId && oldSale.productId === newProductId) {
      const delta = (oldSale.qty || 0) - qty; // net stock change vs the original deduction
      if (delta !== 0) await applyStockMovement(newProductId, delta, 'sale', `Sale updated (${date})`, newSaleId);
    } else {
      if (oldSale.productId) await applyStockMovement(oldSale.productId, oldSale.qty || 0, 'adjustment', `Sale product changed away from this item (${date})`, newSaleId);
      if (newProductId) await applyStockMovement(newProductId, -qty, 'sale', `Sale updated (${date})`, newSaleId);
    }
  } else if (!editId && newProductId) {
    await applyStockMovement(newProductId, -qty, 'sale', `Sale on ${date}${customer ? ' to ' + customer : ''}`, newSaleId);
  }
}

async function deleteSale(id) {
  if (userRole !== 'owner') { alert('Only the owner can delete sales.'); return; }
  if (!confirm('Delete this sale entry?')) return;
  if (!currentUser) { alert('Please login first.'); return; }
  if (!(await ensureFreshSession())) return;
  const existing = sales.find(s => s.id === id);
  try {
    const { error } = await supabase.from('sales').delete().eq('id', id);
    if (error) throw error;
  } catch (e) {
    console.error('Delete sale error:', e);
    alert('❌ Could not delete sale: ' + e.message);
    return;
  }
  sales = sales.filter(s => s.id !== id);
  renderSales();
  updateStatus('🗑️ Sale deleted');
  if (existing && existing.productId && existing.qty) {
    await applyStockMovement(existing.productId, existing.qty, 'adjustment', `Sale deleted (${existing.date})`, id);
  }
}

// Quick action: collect the full pending balance in one tap.
async function markSalePaid(id) {
  const s = sales.find(x => x.id === id);
  if (!s) return;
  if (!confirm('Mark the remaining Rs. ' + s.pending.toFixed(2) + ' as paid?')) return;
  if (!(await ensureFreshSession())) return;
  try {
    const { data, error } = await supabase.from('sales').update({ amount_paid: s.total }).eq('id', id).select().single();
    if (error) throw error;
    const idx = sales.findIndex(x => x.id === id);
    if (idx !== -1) sales[idx] = dbSaleToLocal(data);
  } catch (e) {
    console.error('Mark paid error:', e);
    alert('❌ Could not update payment: ' + e.message);
    return;
  }
  renderSales();
  updateStatus('✅ Payment collected');
}

function clearSalesFilter() {
  $('salesFilterFrom').value = '';
  $('salesFilterTo').value = '';
  $('salesFilterProduct').value = '';
  renderSales();
}

function setSalesFilterToday() {
  const today = todayStr();
  $('salesFilterFrom').value = today;
  $('salesFilterTo').value = today;
  renderSales();
}

function getFilteredSales() {
  const from = $('salesFilterFrom') ? $('salesFilterFrom').value : '';
  const to = $('salesFilterTo') ? $('salesFilterTo').value : '';
  const text = $('salesFilterProduct') ? $('salesFilterProduct').value.trim().toLowerCase() : '';
  const payMethod = $('salesFilterPayment') ? $('salesFilterPayment').value : '';
  return sales.filter(s => {
    if (from && s.date < from) return false;
    if (to && s.date > to) return false;
    if (text && !(s.product.toLowerCase().includes(text) || (s.customer || '').toLowerCase().includes(text))) return false;
    if (payMethod && s.paymentMethod !== payMethod) return false;
    return true;
  });
}

// Cheque short badge shown in the Payment column + Cheque/Deposit Tracker card.
function paymentMethodBadge(s) {
  if (s.paymentMethod === 'cheque') {
    const st = s.chequeStatus || 'pending';
    const map = { pending: ['⏳ Pending', '#c2410c', '#ffedd5'], cleared: ['✅ Cleared', '#16a34a', '#dcfce7'], bounced: ['❌ Bounced', '#b91c1c', '#fee2e2'] };
    const [label, color, bg] = map[st] || map.pending;
    return `🧾 Cheque${s.chequeNumber ? ' #' + s.chequeNumber : ''}<br><span style="display:inline-block;margin-top:2px;padding:1px 7px;border-radius:999px;font-size:10px;font-weight:700;color:${color};background:${bg};">${label}</span>`;
  }
  if (s.paymentMethod === 'deposit') {
    return `🏦 Deposit${s.depositRef ? '<br><small style="opacity:.65;">' + s.depositRef + '</small>' : ''}`;
  }
  return '💵 Cash';
}

// Owner/staff can flip a cheque between Pending / Cleared / Bounced as the
// bank confirms it — keeps the Cheque & Deposit Tracker trustworthy.
async function updateChequeStatus(id, status) {
  const s = sales.find(x => x.id === id);
  if (!s) return;
  if (!(await ensureFreshSession())) return;
  try {
    const { data, error } = await supabase.from('sales').update({ cheque_status: status }).eq('id', id).select().single();
    if (error) throw error;
    const idx = sales.findIndex(x => x.id === id);
    if (idx !== -1) sales[idx] = dbSaleToLocal(data);
  } catch (e) {
    console.error('Update cheque status error:', e);
    alert('❌ Could not update cheque status: ' + e.message);
    return;
  }
  renderSales();
  updateStatus(status === 'cleared' ? '✅ Cheque marked cleared' : status === 'bounced' ? '⚠️ Cheque marked bounced' : '⏳ Cheque marked pending');
}

// Paid in full / part-paid / nothing paid yet — used for the Status column
// and for coloured badges across the tab.
function saleStatus(s) {
  if (s.pending <= 0) return { label: 'Paid', color: '#16a34a', bg: '#dcfce7' };
  if (s.paid > 0) return { label: 'Partial', color: '#c2410c', bg: '#ffedd5' };
  return { label: 'Pending', color: '#b91c1c', bg: '#fee2e2' };
}

function statusBadge(s) {
  const st = saleStatus(s);
  return `<span style="display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700;color:${st.color};background:${st.bg};">${st.label}</span>`;
}

function renderSales() {
  const tbody = $('salesBody');
  if (!tbody) return;
  const list = getFilteredSales();

  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="16" style="text-align:center;opacity:0.5;padding:20px;">No sales logged yet. Tap "Add Sale" to start today\'s diary.</td></tr>';
  } else {
    tbody.innerHTML = list.map(s => {
      const margin = s.total > 0 ? (s.profit / s.total * 100) : 0;
      return `
      <tr>
        <td>${s.date}</td>
        <td>${s.product}</td>
        <td>${s.customer || '-'}</td>
        <td>${s.qty}</td>
        <td>${fmt(s.unitPrice)}</td>
        <td>${fmt(s.total)}</td>
        <td>${fmt(s.cost)}</td>
        <td>${fmt(s.wage)}</td>
        <td>${s.marketingChannel ? s.marketingChannel + (s.marketingCost ? ' (' + fmt(s.marketingCost) + ')' : '') : '-'}</td>
        <td style="color:${s.profit >= 0 ? '#16a34a' : '#dc2626'};font-weight:700;">${fmt(s.profit)}</td>
        <td>${margin.toFixed(0)}%</td>
        <td>${fmt(s.paid)}</td>
        <td style="font-size:11px;">${paymentMethodBadge(s)}</td>
        <td>${s.pending > 0 ? '<span style="color:#c2410c;font-weight:700;">' + fmt(s.pending) + '</span>' : '<span style="opacity:.5;">Rs. 0</span>'}</td>
        <td>${statusBadge(s)}</td>
        <td>
          ${actionMenuHTML([
            { label: 'Edit', icon: '✏️', onclick: `editSale('${s.id}')` },
            userRole === 'owner' ? { label: 'Delete', icon: '🗑️', danger: true, onclick: `deleteSale('${s.id}')` } : null
          ])}
        </td>
      </tr>
    `;
    }).join('');
  }

  renderSalesByDay(list);
  renderSalesPending(list);
  renderSalesProductPerformance(list);
  renderSalesChequeDepositTracker(list);
  renderSalesSummaryChart(list);
  updateSalesStats();
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// ---- Cheque & Deposit Tracker: every non-cash payment, with clearance status ----
function renderSalesChequeDepositTracker(list) {
  const tbody = $('salesChequeDepositBody');
  if (!tbody) return;
  const entries = list.filter(s => s.paymentMethod === 'cheque' || s.paymentMethod === 'deposit');
  if (!entries.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;opacity:0.5;padding:14px;">No cheques or deposits in view.</td></tr>';
    return;
  }
  tbody.innerHTML = entries.map(s => {
    const isCheque = s.paymentMethod === 'cheque';
    const bank = isCheque ? (s.chequeBank || '-') : (s.depositBank || '-');
    const ref = isCheque ? (s.chequeNumber || '-') : (s.depositRef || '-');
    const refDate = isCheque ? (s.chequeDate || '-') : (s.depositDate || '-');
    let statusHtml;
    if (isCheque) {
      const st = s.chequeStatus || 'pending';
      const map = { pending: ['⏳ Pending', '#c2410c', '#ffedd5'], cleared: ['✅ Cleared', '#16a34a', '#dcfce7'], bounced: ['❌ Bounced', '#b91c1c', '#fee2e2'] };
      const [label, color, bg] = map[st] || map.pending;
      statusHtml = `
        <span style="display:inline-block;margin-bottom:4px;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700;color:${color};background:${bg};">${label}</span><br>
        ${st !== 'cleared' ? `<button class="btn btn-sm" style="padding:2px 8px;font-size:11px;" onclick="updateChequeStatus('${s.id}','cleared')">Mark Cleared</button>` : ''}
        ${st !== 'bounced' ? `<button class="btn btn-sm btn-danger" style="padding:2px 8px;font-size:11px;" onclick="updateChequeStatus('${s.id}','bounced')">Mark Bounced</button>` : ''}
        ${st !== 'pending' ? `<button class="btn btn-sm" style="padding:2px 8px;font-size:11px;" onclick="updateChequeStatus('${s.id}','pending')">Reset</button>` : ''}
      `;
    } else {
      statusHtml = '<span style="display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700;color:#16a34a;background:#dcfce7;">🏦 Deposited</span>';
    }
    return `
      <tr>
        <td>${s.date}</td>
        <td>${s.product}</td>
        <td>${s.customer || '-'}</td>
        <td>${isCheque ? '🧾 Cheque' : '🏦 Deposit'}</td>
        <td>${bank}</td>
        <td>${ref}</td>
        <td>${refDate}</td>
        <td>${fmt(s.paid)}</td>
        <td>${statusHtml}</td>
      </tr>
    `;
  }).join('');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// ---- Live Summary charts: 14-day revenue/profit trend + payment method mix ----
let salesTrendChart = null, salesPaymentChart = null;
function renderSalesSummaryChart(list) {
  const colors = getChartColors();

  // 14-day trend (based on today, regardless of the active date filter, so
  // the chart always shows real recent momentum).
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const revenueByDay = {}, profitByDay = {};
  sales.forEach(s => {
    if (!days.includes(s.date)) return;
    revenueByDay[s.date] = (revenueByDay[s.date] || 0) + s.total;
    profitByDay[s.date] = (profitByDay[s.date] || 0) + s.profit;
  });
  const trendCanvas = $('salesTrendChart');
  if (trendCanvas) {
    const data = {
      labels: days.map(d => d.slice(5)),
      datasets: [
        { label: 'Revenue', data: days.map(d => revenueByDay[d] || 0), borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,.15)', tension: .35, fill: true },
        { label: 'Profit', data: days.map(d => profitByDay[d] || 0), borderColor: '#d4af37', backgroundColor: 'rgba(212,175,55,.12)', tension: .35, fill: true }
      ]
    };
    const opts = {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: colors.text, boxWidth: 12 } } },
      scales: { x: { ticks: { color: colors.text, maxRotation: 0 }, grid: { display: false } }, y: { ticks: { color: colors.text }, grid: { color: colors.grid } } }
    };
    if (salesTrendChart) { salesTrendChart.data = data; salesTrendChart.options = opts; salesTrendChart.update(); }
    else salesTrendChart = new Chart(trendCanvas.getContext('2d'), { type: 'line', data, options: opts });
  }

  // Payment method mix — respects the active filter (matches the stat cards).
  let cash = 0, cheque = 0, deposit = 0;
  list.forEach(s => {
    if (s.paymentMethod === 'cheque') cheque += s.paid;
    else if (s.paymentMethod === 'deposit') deposit += s.paid;
    else cash += s.paid;
  });
  const payCanvas = $('salesPaymentChart');
  if (payCanvas) {
    const data = {
      labels: ['Cash', 'Cheque', 'Deposit'],
      datasets: [{ data: [cash, cheque, deposit], backgroundColor: ['#10b981', '#f97316', '#818cf8'], borderWidth: 0, hoverOffset: 6 }]
    };
    const opts = { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { color: colors.text, boxWidth: 12 } } } };
    if (salesPaymentChart) { salesPaymentChart.data = data; salesPaymentChart.update(); }
    else salesPaymentChart = new Chart(payCanvas.getContext('2d'), { type: 'doughnut', data, options: opts });
  }

  // Stat mini-cards for the filtered view.
  const received = cash + cheque + deposit;
  const pending = list.reduce((sum, s) => sum + s.pending, 0);
  const chequesAwaiting = list.filter(s => s.paymentMethod === 'cheque' && (s.chequeStatus || 'pending') === 'pending').length;
  if ($('statPayCash')) $('statPayCash').textContent = fmt(cash);
  if ($('statPayCheque')) $('statPayCheque').textContent = fmt(cheque);
  if ($('statPayDeposit')) $('statPayDeposit').textContent = fmt(deposit);
  if ($('statPayReceived')) $('statPayReceived').textContent = fmt(received);
  if ($('statPayPending')) $('statPayPending').textContent = fmt(pending);
  if ($('statChequeAwaiting')) $('statChequeAwaiting').textContent = chequesAwaiting;
}

// True "daily diary" view — one row per calendar day with that day's totals,
// most recent day first.
function renderSalesByDay(list) {
  const tbody = $('salesByDayBody');
  if (!tbody) return;
  const byDay = {};
  list.forEach(s => {
    const d = byDay[s.date] || { count: 0, revenue: 0, profit: 0, wage: 0, pending: 0 };
    d.count += 1;
    d.revenue += s.total;
    d.profit += s.profit;
    d.wage += s.wage;
    d.pending += s.pending;
    byDay[s.date] = d;
  });
  const days = Object.entries(byDay).sort((a, b) => b[0].localeCompare(a[0]));
  tbody.innerHTML = days.length ? days.map(([date, d]) => `
    <tr>
      <td>${date}</td>
      <td>${d.count}</td>
      <td>${fmt(d.revenue)}</td>
      <td style="color:${d.profit >= 0 ? '#16a34a' : '#dc2626'};font-weight:700;">${fmt(d.profit)}</td>
      <td>${fmt(d.wage)}</td>
      <td>${d.pending > 0 ? '<span style="color:#c2410c;font-weight:700;">' + fmt(d.pending) + '</span>' : '<span style="opacity:.5;">Rs. 0</span>'}</td>
    </tr>
  `).join('') : '<tr><td colspan="6" style="text-align:center;opacity:0.5;padding:14px;">No days recorded yet.</td></tr>';
}

function renderSalesPending(list) {
  const tbody = $('salesPendingBody');
  if (!tbody) return;
  const pending = list.filter(s => s.pending > 0);
  if (!pending.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;opacity:0.5;padding:14px;">No pending payments — everything in view is fully paid. 🎉</td></tr>';
    return;
  }
  tbody.innerHTML = pending.map(s => `
    <tr>
      <td>${s.date}</td>
      <td>${s.product}</td>
      <td>${s.customer || '-'}</td>
      <td>${fmt(s.total)}</td>
      <td>${fmt(s.paid)}</td>
      <td style="color:#c2410c;font-weight:700;">${fmt(s.pending)}</td>
      <td><button class="btn btn-sm btn-primary" onclick="markSalePaid('${s.id}')"><i class="business-icon icon-inline" data-lucide="hand-coins" aria-hidden="true"></i> Collect</button></td>
    </tr>
  `).join('');
}

function renderSalesProductPerformance(list) {
  const byProduct = {};
  const byChannel = {};
  list.forEach(s => {
    const p = byProduct[s.product] || { units: 0, revenue: 0, profit: 0, marketing: 0 };
    p.units += s.qty;
    p.revenue += s.total;
    p.profit += s.profit;
    p.marketing += s.marketingCost;
    byProduct[s.product] = p;

    const chan = s.marketingChannel || 'Organic / None';
    const c = byChannel[chan] || { spend: 0, count: 0, revenue: 0 };
    c.spend += s.marketingCost;
    c.count += 1;
    c.revenue += s.total;
    byChannel[chan] = c;
  });

  const prodBody = $('salesProductBody');
  let topSeller = null;
  if (prodBody) {
    const entries = Object.entries(byProduct).sort((a, b) => b[1].revenue - a[1].revenue);
    if (entries.length) topSeller = entries[0];
    prodBody.innerHTML = entries.length ? entries.map(([name, d]) => `
      <tr>
        <td>${name}</td>
        <td>${d.units}</td>
        <td>${fmt(d.revenue)}</td>
        <td style="color:${d.profit >= 0 ? '#16a34a' : '#dc2626'};font-weight:700;">${fmt(d.profit)}</td>
        <td>${fmt(d.marketing)}</td>
      </tr>
    `).join('') : '<tr><td colspan="5" style="text-align:center;opacity:0.5;padding:14px;">No data yet.</td></tr>';
  }

  const chanBody = $('salesChannelBody');
  if (chanBody) {
    const entries = Object.entries(byChannel).sort((a, b) => b[1].revenue - a[1].revenue);
    chanBody.innerHTML = entries.length ? entries.map(([name, d]) => {
      const roi = d.spend > 0 ? (d.revenue / d.spend) : null;
      return `
      <tr>
        <td>${name}</td>
        <td>${fmt(d.spend)}</td>
        <td>${d.count}</td>
        <td>${fmt(d.revenue)}</td>
        <td>${roi !== null ? roi.toFixed(1) + 'x' : '—'}</td>
      </tr>
    `;
    }).join('') : '<tr><td colspan="5" style="text-align:center;opacity:0.5;padding:14px;">No data yet.</td></tr>';
  }

  const notice = $('salesTopSellerNotice');
  if (notice) {
    if (topSeller) {
      notice.style.display = 'block';
      notice.innerHTML = `<i class="business-icon icon-inline" data-lucide="trophy" aria-hidden="true"></i> Best seller in view: <strong>${topSeller[0]}</strong> — ${fmt(topSeller[1].revenue)} revenue, ${fmt(topSeller[1].profit)} profit.`;
      if (typeof lucide !== 'undefined') lucide.createIcons();
    } else {
      notice.style.display = 'none';
    }
  }
}

function updateSalesStats() {
  const today = todayStr();
  const monthPrefix = today.slice(0, 7);

  const todaysSales = sales.filter(s => s.date === today);
  const monthSales = sales.filter(s => s.date.slice(0, 7) === monthPrefix);

  const salesToday = todaysSales.reduce((sum, s) => sum + s.total, 0);
  const profitToday = todaysSales.reduce((sum, s) => sum + s.profit, 0);
  const wageToday = todaysSales.reduce((sum, s) => sum + s.wage, 0);
  const salesMonth = monthSales.reduce((sum, s) => sum + s.total, 0);
  const profitMonth = monthSales.reduce((sum, s) => sum + s.profit, 0);
  const pendingTotal = sales.reduce((sum, s) => sum + s.pending, 0);

  if ($('statSalesToday')) $('statSalesToday').textContent = fmt(salesToday);
  if ($('statProfitToday')) $('statProfitToday').textContent = fmt(profitToday);
  if ($('statWageToday')) $('statWageToday').textContent = fmt(wageToday);
  if ($('statSalesMonth')) $('statSalesMonth').textContent = fmt(salesMonth);
  if ($('statProfitMonth')) $('statProfitMonth').textContent = fmt(profitMonth);
  if ($('statPendingTotal')) $('statPendingTotal').textContent = fmt(pendingTotal);

  const badge = $('salesQuickBadge');
  if (badge) {
    const pendingCount = sales.filter(s => s.pending > 0).length;
    if (pendingCount > 0) { badge.style.display = 'inline-block'; badge.textContent = pendingCount; }
    else { badge.style.display = 'none'; }
  }
}

function exportSalesCSV() {
  const list = getFilteredSales();
  if (!list.length) { alert('No sales to export.'); return; }
  const header = ['Date','Product','Customer','Qty','Unit Price','Total','Cost','Wage','Marketing Channel','Marketing Cost','Profit','Margin %','Paid','Payment Method','Cheque No.','Cheque Bank','Cheque Date','Cheque Status','Deposit Bank','Deposit Ref','Deposit Date','Pending','Status','Notes'];
  const rows = list.map(s => {
    const margin = s.total > 0 ? (s.profit / s.total * 100) : 0;
    return [s.date, s.product, s.customer, s.qty, s.unitPrice, s.total, s.cost, s.wage, s.marketingChannel, s.marketingCost, s.profit, margin.toFixed(1), s.paid, s.paymentMethod, s.chequeNumber, s.chequeBank, s.chequeDate, s.chequeStatus, s.depositBank, s.depositRef, s.depositDate, s.pending, saleStatus(s).label, (s.notes || '').replace(/[\r\n,]+/g, ' ')];
  });
  const csv = [header, ...rows].map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'sales-diary-' + todayStr() + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function updateExpenseStats() {
  const total = expenses.reduce((sum, e) => sum + e.amount, 0);
  const now = new Date();
  const thisMonth = expenses
    .filter(e => {
      const d = new Date(e.date);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    })
    .reduce((sum, e) => sum + e.amount, 0);
  const elMonth = $('statExpThisMonth');
  const elTotal = $('statExpTotal');
  const elCount = $('statExpCount');
  if (elMonth) elMonth.textContent = fmt(thisMonth);
  if (elTotal) elTotal.textContent = fmt(total);
  if (elCount) elCount.textContent = expenses.length;
}

function exportExpensesCSV() {
  if (expenses.length === 0) { alert('No expenses to export.'); return; }
  const rows = [['Date', 'Category', 'Description', 'Amount']];
  expenses.forEach(e => rows.push([e.date, e.category, e.description, e.amount.toFixed(2)]));
  downloadCSV(rows, 'mydrybea_expenses.csv');
}

async function saveCustomer() {
  const editId = $('custEditId') ? $('custEditId').value : '';
  const name = $('custName').value.trim();
  const phone = $('custPhone').value.trim();
  const address = $('custAddress').value.trim();
  if (!name) { alert('Customer name is required!'); return; }
  if (!currentUser) { alert('Please login first.'); return; }

  let referralStaffId = userRole === 'staff' ? currentUser.id : null;
  let referralStaffReference = userRole === 'staff' ? (userProfile?.staff_reference || '') : null;
  if (userRole === 'owner') {
    referralStaffId = $('custReferralStaffSelect')?.value || null;
    referralStaffReference = referralStaffId ? (staffListCache||[]).find(s=>String(s.id)===String(referralStaffId))?.staff_reference || '' : null;
  }

  if (editId) {
    if (userRole !== 'owner') { alert('Only the business owner can edit customers.'); return; }
    const updates = { name, phone, address, referral_staff_id: referralStaffId, referral_staff_reference: referralStaffReference };
    if (!(await ensureFreshSession())) return;
    try {
      let result = await supabase.from('customers').update(updates).eq('id', editId).eq('user_id', businessId);
      if (result.error && /column|schema|does not exist/i.test(result.error.message||'')) {
        const fallback = {...updates}; delete fallback.referral_staff_id; delete fallback.referral_staff_reference;
        result = await supabase.from('customers').update(fallback).eq('id', editId).eq('user_id', businessId);
      }
      if (result.error) throw result.error;
    } catch (e) {
      console.error('Update customer error:', e);
      alert('❌ Could not update customer: ' + e.message);
      return;
    }
    const c = customers.find(x => String(x.id) === String(editId));
    if (c) { c.name = name; c.phone = phone; c.address = address; c.referralStaffId = referralStaffId; c.referralStaffReference = referralStaffReference; }
    saveCustomers(); renderCustomers(); updateCustomerSelect(); closeModal('customerModal');
    $('custEditId').value = ''; $('custName').value = ''; $('custPhone').value = ''; $('custAddress').value = '';
    updateStatus('✅ Customer updated');
    return;
  }

  const row = { id: Date.now().toString(), user_id: businessId, name, phone, address, referral_staff_id: referralStaffId, referral_staff_reference: referralStaffReference };
  if (!(await ensureFreshSession())) return;
  try {
    let result = await supabase.from('customers').insert(row);
    if (result.error && /column|schema|does not exist/i.test(result.error.message||'')) {
      const fallback = {...row}; delete fallback.referral_staff_id; delete fallback.referral_staff_reference;
      result = await supabase.from('customers').insert(fallback);
    }
    if (result.error) throw result.error;
  } catch (e) {
    console.error('Save customer error:', e);
    alert('❌ Could not save customer: ' + e.message);
    return;
  }
  customers.unshift({ id: row.id, name, phone, address, referralStaffId, referralStaffReference, createdAt: new Date().toLocaleDateString() });
  saveCustomers(); renderCustomers(); updateCustomerSelect(); closeModal('customerModal');
  $('custName').value = ''; $('custPhone').value = ''; $('custAddress').value = '';
  updateStatus('✅ Customer saved with referral reference');
}

function renderCustomers() {
  const tbody = $('customersBody');
  const isStaff = userRole === 'staff';
  if (isStaff) { if(tbody) tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;opacity:.45;padding:20px;">Customer master list is owner-only.</td></tr>'; return; }
  if (customers.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${isStaff ? 4 : 5}" style="text-align:center;opacity:0.5;padding:20px;">No customers yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = customers.map(c => `
    <tr>
      <td>${c.id.slice(-4)}</td>
      <td><strong>${c.name}</strong></td>
      ${isStaff ? '' : `<td>${c.phone || '-'}</td>`}
      <td>${c.address || '-'}</td>
      <td>${actionMenuHTML([
        { label: 'Edit', icon: '✏️', onclick: `editCustomer('${c.id}')` },
        { label: 'Delete', icon: '🗑️', danger: true, onclick: `deleteCustomer('${c.id}')` }
      ])}</td>
    </tr>
  `).join('');
}

async function deleteCustomer(id) {
  if (!confirm('Delete this customer?')) return;
  if (!currentUser) { alert('Please login first.'); return; }
  if (!(await ensureFreshSession())) return;
  try {
    const { error } = await supabase.from('customers').delete().eq('id', id).eq('user_id', businessId);
    if (error) throw error;
  } catch (e) {
    console.error('Delete customer error:', e);
    alert('❌ Could not delete customer: ' + e.message);
    return;
  }
  customers = customers.filter(c => c.id !== id);
  saveCustomers();
  renderCustomers();
  updateCustomerSelect();
  renderOrders();
  updateStatus('🗑️ Customer deleted');
}

function updateCustomerSelect() {
  const select = $('orderCustomer');
  if (userRole === 'staff') { if(select) select.innerHTML = '<option value="">Staff sale — customer details entered in this order</option>'; return; }
  // A distributor-attributed sale doesn't require a customer on the master
  // list, so "no customer" is always a valid, selectable choice here — not
  // just a dead end shown when the list happens to be empty.
  const noCustomerOption = '<option value="">— No customer (optional) —</option>';
  if (customers.length === 0) {
    select.innerHTML = noCustomerOption;
    return;
  }
  select.innerHTML = noCustomerOption + customers.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
}

function syncOrderSizeChips() {
  const val = String($('orderProduct')?.value || '');
  document.querySelectorAll('#orderSizeGrid .om-size-chip').forEach(chip => {
    const active = chip.getAttribute('data-size') === val;
    chip.classList.toggle('active', active);
    chip.setAttribute('aria-checked', active ? 'true' : 'false');
  });
}

function selectOrderSize(size) {
  const sel = $('orderProduct');
  if (sel) sel.value = size;
  syncOrderSizeChips();
  updateOrderTotal();
}

function stepOrderQty(delta) {
  const input = $('orderQty');
  if (!input) return;
  let v = (parseInt(input.value, 10) || 0) + delta;
  if (v < 1) v = 1;
  input.value = v;
  updateOrderTotal();
}

function updateOrderTotal() {
  const qty = Math.max(0, Number($('orderQty')?.value) || 0);
  const price = Math.max(0, Number($('orderUnitPrice')?.value) || 0);
  const total = qty * price;
  const totalEl = $('orderTotalValue');
  const subEl = $('orderTotalSub');
  if (totalEl) totalEl.textContent = (typeof fmt === 'function') ? fmt(total) : ('Rs. ' + total);
  if (subEl) subEl.textContent = qty + ' × ' + ((typeof fmt === 'function') ? fmt(price) : ('Rs. ' + price));
  updateDistributorCommissionPreview();
}

// Keeps the Customer field's hint text honest: a distributor-attributed sale
// doesn't need a customer, so say so as soon as a distributor is picked.
function updateOrderCustomerHint() {
  const hint = $('orderCustomerHint');
  if (!hint) return;
  const distId = userRole === 'distributor' ? currentUser?.id : ($('orderReferralDistributorSelect')?.value || '');
  hint.textContent = distId
    ? 'Optional for a distributor sale — pick one only if this order also has a specific customer.'
    : 'Select the customer for this order.';
}

// Live estimate of the commission a picked distributor (or the owner
// themselves, via the "Me" option) would earn on this order, using the same
// tier-rate logic as the real commission claim created on submit.
function updateDistributorCommissionPreview() {
  const box = $('orderDistCommissionPreview');
  if (!box) return;
  const distId = userRole === 'distributor' ? currentUser?.id : ($('orderReferralDistributorSelect')?.value || '');
  if (!distId || typeof computeDistributorCommissionRate !== 'function') { box.style.display = 'none'; return; }
  const qty = Math.max(0, Number($('orderQty')?.value) || 0);
  const price = Math.max(0, Number($('orderUnitPrice')?.value) || 0);
  const total = qty * price;
  const rate = computeDistributorCommissionRate(distId, total);
  const amount = Math.round(total * rate);
  const fmtVal = (v) => (typeof fmt === 'function') ? fmt(v) : ('Rs. ' + v);
  box.style.display = '';
  box.innerHTML = `<i class="business-icon icon-inline" data-lucide="badge-percent" aria-hidden="true"></i> Estimated commission at current tier: <strong>${(rate*100).toFixed(0)}%</strong> of ${fmtVal(total)} = <strong>${fmtVal(amount)}</strong>`;
  if (window.lucide) lucide.createIcons({attrs:{'stroke-width':1.9,'stroke-linecap':'round','stroke-linejoin':'round'}});
}

function onOrderDistributorChange() {
  updateOrderCustomerHint();
  updateDistributorCommissionPreview();
}

// Owner convenience: auto-fill delivery address from the selected customer
// (only when the address field is still empty, so it never overwrites a manual edit).
function onOrderCustomerChange() {
  const addrEl = $('orderAddress');
  const customerId = $('orderCustomer')?.value;
  if (addrEl && !addrEl.value.trim() && customerId) {
    const addr = getCustomerAddress(customerId);
    if (addr) addrEl.value = addr;
  }
  const c = customers.find(x => String(x.id) === String(customerId));
  if ($('orderReferralStaffSelect') && c?.referralStaffId) $('orderReferralStaffSelect').value = c.referralStaffId;
}

function openNewOrder() {
  const staffBlock=document.querySelector('[data-staff-order-customer]');
  const ownerBlock=document.querySelector('[data-owner-order-customer]');
  const paymentBlock=document.querySelector('[data-owner-order-payment]');
  const staffReferralBlock=document.querySelector('[data-owner-staff-referral-block]');
  const distSelectBlock=document.querySelector('[data-owner-dist-select-block]');
  const distSelfBlock=document.querySelector('[data-distributor-self-block]');
  if(userRole==='staff'){
    if(staffBlock) staffBlock.style.display='';
    if(ownerBlock) ownerBlock.style.display='none';
    if(paymentBlock) paymentBlock.style.display='none';
    const ref=document.querySelector('[data-owner-order-referral]'); if(ref) ref.style.display='none';
    if($('staffOrderCustomerName')) $('staffOrderCustomerName').value='';
    if($('staffOrderCustomerPhone')) $('staffOrderCustomerPhone').value='';
  } else {
    if(staffBlock) staffBlock.style.display='none';
    if(ownerBlock) ownerBlock.style.display='';
    if(paymentBlock) paymentBlock.style.display='';
    updateCustomerSelect();
    const f=document.querySelector('[data-owner-order-referral]'); if(f) f.style.display='';
    if(userRole==='distributor'){
      // A distributor placing their own order is always the one earning the
      // commission on it — no dropdown to fill in. Hide the owner-only staff
      // referral picker and the "pick any distributor" select, and show a
      // locked, auto-filled summary of this distributor's own name,
      // reference and current commission tier instead.
      if(staffReferralBlock) staffReferralBlock.style.display='none';
      if(distSelectBlock) distSelectBlock.style.display='none';
      if(distSelfBlock) distSelfBlock.style.display='';
      const myName=(userProfile && userProfile.display_name) || currentUser.email?.split('@')[0] || 'You';
      const myRef=(userProfile && userProfile.distributor_reference) || ('AGT-' + currentUser.id.slice(0,8).toUpperCase());
      const myStats=computeDistributorStats(currentUser.id);
      if($('orderDistSelfName')) $('orderDistSelfName').textContent=myName;
      if($('orderDistSelfRef')) $('orderDistSelfRef').textContent=myRef;
      if($('orderDistSelfRate')) $('orderDistSelfRate').textContent=(myStats.currentRate*100).toFixed(0)+'%';
      // Refresh from the latest commission claims in case they weren't loaded
      // yet this session, so the displayed tier/rate is never stale.
      loadDistributorCommissionClaims().then(() => {
        const freshStats=computeDistributorStats(currentUser.id);
        if($('orderDistSelfRate')) $('orderDistSelfRate').textContent=(freshStats.currentRate*100).toFixed(0)+'%';
      });
    } else {
      if(staffReferralBlock) staffReferralBlock.style.display='';
      if(distSelectBlock) distSelectBlock.style.display='';
      if(distSelfBlock) distSelfBlock.style.display='none';
      populateStaffReferralSelectors();
      // Distributor dropdown previously relied on loadStaffList() having already run
      // from some other tab (Orders/My Staff) earlier in the session — if New Order
      // was opened before that, the "Product Distributor" field showed no options at
      // all beyond the placeholder. Force a fresh load here so it's always populated.
      loadStaffList();
      const c=customers.find(x=>String(x.id)===String($('orderCustomer').value)); if($('orderReferralStaffSelect') && c?.referralStaffId) $('orderReferralStaffSelect').value=c.referralStaffId;
    }
  }
  $('orderAddress').value = '';
  $('orderNotes').value = '';
  $('orderQty').value = 1;
  $('orderUnitPrice').value = 350;
  if ($('orderPaymentMethod')) $('orderPaymentMethod').value = 'cod';
  if ($('orderProduct')) $('orderProduct').value = '50';
  if ($('orderProductId')) $('orderProductId').value = '';
  syncOrderSizeChips();
  renderOrderProductPicker();
  updateOrderCustomerHint();
  updateOrderTotal();
  $('orderModal').classList.add('active');
  if(window.lucide) lucide.createIcons({attrs:{'stroke-width':1.9,'stroke-linecap':'round','stroke-linejoin':'round'}});
}

function openNewCustomer() {
  if ($('custEditId')) $('custEditId').value = '';
  if ($('customerModalTitle')) $('customerModalTitle').textContent = 'New Customer';
  if ($('customerSaveBtn')) $('customerSaveBtn').innerHTML = '<i class="business-icon icon-inline" data-lucide="save" aria-hidden="true"></i> Save Customer';
  $('custName').value = ''; $('custPhone').value = ''; $('custAddress').value = '';
  const ref = document.querySelector('[data-staff-referral-field]');
  if(ref) ref.style.display = userRole === 'staff' ? '' : 'none';
  if($('custReferralStaffName') && userRole === 'staff') $('custReferralStaffName').textContent = ((userProfile&&userProfile.display_name)||currentUser?.email||'Staff') + ' · ' + ((userProfile&&userProfile.staff_reference)||('STF-'+currentUser.id.slice(0,8).toUpperCase()));
  if(userRole==='owner'){ populateStaffReferralSelectors(); const f=document.querySelector('[data-owner-referral-field]'); if(f) f.style.display=''; if($('custReferralStaffSelect')) $('custReferralStaffSelect').value=''; }
  if (window.lucide) lucide.createIcons({attrs:{'stroke-width':1.9,'stroke-linecap':'round','stroke-linejoin':'round'}});
  $('customerModal').classList.add('active');
}

function editCustomer(id) {
  if (userRole !== 'owner') { alert('Only the business owner can edit customers.'); return; }
  const c = customers.find(x => String(x.id) === String(id));
  if (!c) { alert('Customer not found.'); return; }
  if(userRole==='owner'){ populateStaffReferralSelectors(); const f=document.querySelector('[data-owner-referral-field]'); if(f) f.style.display=''; }
  const ref = document.querySelector('[data-staff-referral-field]');
  if (ref) ref.style.display = 'none';
  $('custEditId').value = c.id;
  $('custName').value = c.name || '';
  $('custPhone').value = c.phone || '';
  $('custAddress').value = c.address || '';
  if ($('custReferralStaffSelect') && c.referralStaffId) $('custReferralStaffSelect').value = c.referralStaffId;
  if ($('customerModalTitle')) $('customerModalTitle').textContent = 'Edit Customer';
  if ($('customerSaveBtn')) $('customerSaveBtn').innerHTML = '<i class="business-icon icon-inline" data-lucide="save" aria-hidden="true"></i> Update Customer';
  if (window.lucide) lucide.createIcons({attrs:{'stroke-width':1.9,'stroke-linecap':'round','stroke-linejoin':'round'}});
  $('customerModal').classList.add('active');
}
window.editCustomer = editCustomer;

async function createOrder() {
  const product = $('orderProduct').value;
  const qty = Number($('orderQty').value) || 0;
  const unitPrice = Number($('orderUnitPrice').value) || 0;
  const notes = $('orderNotes').value.trim();
  if (qty <= 0) { alert('Quantity must be at least 1!'); return; }
  if (unitPrice <= 0) { alert('Unit price required!'); return; }
  if (!currentUser) { alert('Please login first.'); return; }
  if (!(await ensureFreshSession())) return;

  // STAFF MODE: no customer master list. The sale itself owns the customer snapshot.
  if (userRole === 'staff') {
    const customerName = $('staffOrderCustomerName')?.value.trim() || '';
    const customerPhone = $('staffOrderCustomerPhone')?.value.trim() || '';
    const address = $('orderAddress').value.trim();
    if (!customerName) { alert('Customer name is required.'); return; }
    if (!address) { alert('Delivery address is required.'); return; }

    try {
      // Server creates the immutable random SALE REF and the pending commission claim atomically.
      const { data, error } = await withSessionRetry(() => supabase.rpc('create_staff_sale_secure', {
        p_product_size_g: Number(product) || 0,
        p_qty: qty,
        p_unit_price: unitPrice,
        p_customer_name: customerName,
        p_customer_phone: customerPhone,
        p_customer_address: address,
        p_notes: notes
      }));
      if (error) throw error;
      const row = data;
      orders.unshift({
        id: row.id,
        customerId: row.customer_id || null,
        customerName: row.customer_name_snapshot || customerName,
        customerPhone: row.customer_phone_snapshot || customerPhone,
        product, qty, unitPrice, total: Number(row.total)||qty*unitPrice,
        address: row.customer_address_snapshot || address,
        notes: row.notes || notes,
        status: row.status || 'pending',
        createdBy: row.created_by || currentUser.id,
        createdAt: row.created_at || new Date().toISOString(),
        orderRefNo: row.order_ref_no,
        referralStaffId: row.referral_staff_id || currentUser.id,
        referralStaffReference: row.referral_staff_reference || userProfile?.staff_reference || '',
        referralStatus: row.referral_status || 'pending_verification'
      });
      saveOrders();
      await loadCommissionClaims();
      renderOrders(); renderDelivery(); updateOrderStats();
      closeModal('orderModal');
      $('staffOrderCustomerName').value=''; $('staffOrderCustomerPhone').value='';
      $('orderQty').value=1; $('orderUnitPrice').value=350; $('orderAddress').value=''; $('orderNotes').value='';
      if ($('orderProduct')) $('orderProduct').value = '50';
      syncOrderSizeChips(); updateOrderTotal();
      updateStatus(`🔐 Sale ${row.order_ref_no} created · pending owner verification`);
    } catch (e) {
      console.error('Secure staff sale error:', e);
      alert('❌ Could not create secure sale: ' + e.message);
    }
    return;
  }

  // OWNER MODE: existing customer master workflow remains available.
  const customerId = $('orderCustomer').value;
  const address = $('orderAddress').value.trim() || getCustomerAddress(customerId);
  // A distributor-attributed sale doesn't need a customer on the master list —
  // the distributor is what drives the commission, so only ONE of
  // customer / distributor needs to be set, not both.
  const referralDistributorId = userRole === 'distributor' ? currentUser.id : ($('orderReferralDistributorSelect')?.value || null);
  if (!customerId && !referralDistributorId) { alert('Select a customer, or pick a distributor for this sale.'); return; }
  const customer = customers.find(c=>String(c.id)===String(customerId));
  let referralStaffId = customer?.referralStaffId || null;
  let referralStaffReference = customer?.referralStaffReference || null;
  if ($('orderReferralStaffSelect')?.value) {
    referralStaffId = $('orderReferralStaffSelect').value;
    referralStaffReference = (staffListCache||[]).find(s=>String(s.id)===String(referralStaffId))?.staff_reference || null;
  }
  const total = qty * unitPrice;
  const paymentMethod = $('orderPaymentMethod')?.value === 'prepaid' ? 'prepaid' : 'cod';
  const productId = $('orderProductId') ? $('orderProductId').value || null : null;
  const row = { id: generateOrderId(), user_id: businessId, customer_id: customerId || null, product_size_g: Number(product)||0, product_id: productId, qty, unit_price:unitPrice, total, address, notes, status:'pending', created_by:currentUser.id, referral_staff_id:referralStaffId, referral_staff_reference:referralStaffReference, referral_status:referralStaffId?'pending_verification':'none', payment_method:paymentMethod };
  try {
    let { data, error } = await withSessionRetry(() => supabase.from('orders').insert(row).select().single());
    if (error && /column|schema|does not exist/i.test(error.message||'')) {
      // products-feature-setup.sql not run yet on this project — retry without product_id.
      const fallback = {...row}; delete fallback.product_id;
      ({ data, error } = await withSessionRetry(() => supabase.from('orders').insert(fallback).select().single()));
    }
    if (error) throw error;
    if (referralStaffId) {
      const claim = { owner_id: businessId, staff_id:String(referralStaffId), staff_reference:referralStaffReference||'', order_id:String(data.id), customer_id:String(customerId), customer_name:customer?.name||'', customer_phone:customer?.phone||'', order_total:total, commission_rate:STAFF_COMMISSION_RATE, commission_amount:0, status:'pending', order_ref_no:data.order_ref_no||null, order_snapshot:{order_id:data.id,order_ref_no:data.order_ref_no||null,customer_id:customerId,customer_name:customer?.name||'',product_size_g:Number(product)||0,qty,unit_price:unitPrice,total,address,notes,created_by:currentUser.id,referral_staff_id:String(referralStaffId),referral_staff_reference:referralStaffReference} };
      const { error: ce } = await supabase.from('staff_commission_claims').insert(claim);
      if (ce) console.error('Owner referral claim create failed:',ce);
    }
    if (referralDistributorId) {
      const distStats = computeDistributorStats(referralDistributorId);
      const distRate = computeDistributorCommissionRate(referralDistributorId, total);
      const distributor = (distributorListCache||[]).find(d=>String(d.id)===String(referralDistributorId));
      // Covers both: (a) a distributor-role user placing their own order, and
      // (b) the owner picking the "Me (Owner)" option in the dropdown — in
      // both cases the selected id is the current account's own id, and there
      // is no distributorListCache entry for it, so fall back to the
      // account's own distributor_reference (or a generated one).
      const distReference = distributor?.distributor_reference || (String(referralDistributorId) === String(currentUser.id) ? ((userProfile && userProfile.distributor_reference) || ('AGT-' + currentUser.id.slice(0,8).toUpperCase())) : '');
      const distClaim = {
        owner_id: businessId,
        distributor_id: String(referralDistributorId),
        distributor_reference: distReference,
        order_id: String(data.id),
        order_ref_no: data.order_ref_no || null,
        customer_name: customer?.name || '',
        order_total: total,
        marketing_level: distStats.marketingLevel,
        business_quality: distStats.businessQuality,
        commission_rate: distRate,
        commission_amount: Math.round(total * distRate),
        // Held as 'pending' until the order is actually delivered — see
        // finalizeDistributorCommissionForOrder(), called from cycleStatus(),
        // confirmDelivery() and confirmBatchDelivery() once status becomes
        // 'delivered' (or 'rejected' if the order is cancelled first).
        status: 'pending',
        order_snapshot: { order_id: data.id, order_ref_no: data.order_ref_no || null, product_size_g: Number(product)||0, qty, unit_price: unitPrice, total }
      };
      const { error: dce } = await withSessionRetry(() => supabase.from('distributor_commission_claims').insert(distClaim));
      if (dce) console.error('Distributor commission claim create failed:', dce);
      else loadDistributorCommissionClaims();
    }
  } catch (e) { console.error('Create order error:',e); alert('❌ Could not save order: '+e.message); return; }
  orders.unshift({id:row.id,customerId,productId,product,qty,unitPrice,total,address,notes,status:'pending',createdBy:currentUser.id,createdAt:new Date().toISOString(),referralStaffId,referralStaffReference,referralStatus:referralStaffId?'pending_verification':'none',orderRefNo:row.order_ref_no||null,paymentMethod});
  // Order placed against a catalog product -> stock is committed right away
  // (not just when a Sale is logged), so the Products tab reflects orders
  // the moment they're created. Reversed automatically if the order is
  // later cancelled/reactivated (see cycleStatus()) or deleted (see deleteOrder()).
  if (productId) await applyStockMovement(productId, -qty, 'order', `New order${customer ? ' — ' + customer.name : ''}`);
  saveOrders(); renderOrders(); renderDelivery(); updateOrderStats(); closeModal('orderModal');
  $('orderQty').value=1; $('orderUnitPrice').value=350; $('orderAddress').value=''; $('orderNotes').value='';
  if ($('orderPaymentMethod')) $('orderPaymentMethod').value = 'cod';
  if ($('orderProduct')) $('orderProduct').value = '50';
  if ($('orderProductId')) $('orderProductId').value = '';
  if ($('orderReferralDistributorSelect')) $('orderReferralDistributorSelect').value = '';
  updateOrderCustomerHint();
  syncOrderSizeChips(); updateOrderTotal();
  updateStatus(referralStaffId ? '📨 Sale sent to owner for commission verification' : (referralDistributorId ? '✅ Order created · distributor commission recorded' : '✅ Order created'));
}
function renderOrders() {
  const tbody = $('ordersBody');
  if (!tbody) return;
  // OWNER: sees every order in the business.
  // STAFF: sees only sales created by that staff member.
  const visibleOrders = userRole === 'staff'
    ? (orders || []).filter(o => String(o.createdBy || '') === String(currentUser?.id || ''))
    : (orders || []);

  if (visibleOrders.length === 0) {
    const msg = userRole === 'staff' ? 'No sales created by you yet.' : 'No orders yet.';
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;opacity:0.5;padding:20px;">${msg}</td></tr>`;
    return;
  }

  const claims = window.staffCommissionClaims || [];
  // Precompute lookups once instead of calling orders.indexOf()/claims.find() per row
  // (that was O(n²) and got noticeably slow once order history grew).
  const orderIndexById = new Map(orders.map((o, i) => [String(o.id), i]));
  const claimsByOrderKey = new Map();
  claims.forEach(c => {
    if (userRole !== 'owner' && String(c.staff_id) !== String(currentUser?.id)) return;
    claimsByOrderKey.set(String(c.order_ref_no || '') + '|' + String(c.order_id), c);
  });
  tbody.innerHTML = visibleOrders.map((order) => {
    const index = orderIndexById.get(String(order.id));
    const claim = claimsByOrderKey.get(String(order.orderRefNo || '') + '|' + String(order.id));
    const commissionCell = claim?.status === 'approved'
      ? `<div style="font-weight:900;color:#087b3e;">+ ${fmt(Number(claim.commission_amount)||0)}</div><small style="color:#087b3e;">12% Verified</small>`
      : (claim?.status === 'pending' ? '<small style="color:#a27b1b;font-weight:800;">Pending verification</small>' : '<small style="opacity:.45;">—</small>');
    const actions = userRole === 'owner'
      ? actionMenuHTML([
          { label: 'View Invoice', icon: '🧾', onclick: `viewInvoice(${index})` },
          { label: 'Change Status', icon: '🔄', onclick: `cycleStatus(${index})` },
          order.deliveryPhotoUrl ? { label: 'Delivery Proof', icon: '🛡️', onclick: `viewDeliveryProof(${index})` } : null,
          order.status === 'failed' ? { label: 'Reschedule', icon: '↺', onclick: `rescheduleFailedOrder(${index})` } : null,
          { label: 'Delete', icon: '🗑️', danger: true, onclick: `deleteOrder(${index})` }
        ])
      : '<span style="font-size:.68rem;font-weight:800;opacity:.55;">VIEW ONLY</span>';
    return `<tr>
      <td><strong>${order.id}</strong></td>
      <td>${new Date(order.createdAt).toLocaleDateString()}</td>
      <td><strong>${escapeHtmlSafe(order.customerName || getCustomerName(order.customerId) || 'Customer')}</strong>${order.orderRefNo?`<br><small style="font-weight:900;letter-spacing:.06em;opacity:.7;">${escapeHtmlSafe(order.orderRefNo)}</small>`:''}</td>
      <td>${order.qty} × ${order.product}g</td>
      <td>${fmt(order.total)}</td>
      <td>${getStatusBadge(order.status)}</td>
      <td>${commissionCell}</td>
      <td>${actions}</td>
    </tr>`;
  }).join('');
  if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } });
  updateOrdersNewBadge(visibleOrders);
}

// "New" here = orders still sitting at 'pending' (not yet shipped/actioned) —
// same idea as the My Staff advance-request badge: a count of things that
// still need someone's attention, shown right on the nav tab.
function updateOrdersNewBadge(visibleOrders) {
  const badge = $('ordersNewBadge');
  if (!badge) return;
  const count = (visibleOrders || []).filter(o => o.status === 'pending').length;
  if (count > 0) { badge.textContent = count > 99 ? '99+' : String(count); badge.style.display = 'inline-block'; }
  else { badge.style.display = 'none'; }
}

function getStatusBadge(status) {
  switch(status) {
    case 'pending': return '<span class="badge badge-pending">⏳ Pending</span>';
    case 'shipped': return '<span class="badge badge-shipped"><i class="business-icon icon-inline" data-lucide="truck" aria-hidden="true"></i> Shipped</span>';
    case 'delivered': return '<span class="badge badge-delivered"><i class="business-icon icon-inline" data-lucide="circle-check" aria-hidden="true"></i> Delivered</span>';
    case 'cancelled': return '<span class="badge badge-cancelled"><i class="business-icon icon-inline" data-lucide="circle-x" aria-hidden="true"></i> Cancelled</span>';
    case 'failed': return '<span class="badge badge-cancelled"><i class="business-icon icon-inline" data-lucide="circle-alert" aria-hidden="true"></i> Delivery Failed</span>';
    default: return status;
  }
}

async function cycleStatus(index) {
  if (userRole !== 'owner') { alert('🔒 Only the business owner can change order status.'); return; }
  const cycle = ['pending', 'shipped', 'delivered', 'cancelled'];
  const order = orders[index];
  if (!currentUser) { alert('Please login first.'); return; }
  const newStatus = cycle[(cycle.indexOf(order.status) + 1) % cycle.length];
  if (!(await ensureFreshSession())) return;
  try {
    const { error } = await withSessionRetry(() => supabase.from('orders').update({ status: newStatus }).eq('id', order.id).eq('user_id', businessId));
    if (error) throw error;
  } catch (e) {
    console.error('Update order status error:', e);
    alert('❌ Could not update order status: ' + e.message);
    return;
  }
  const prevStatus = order.status;
  order.status = newStatus;
  saveOrders();
  renderOrders();
  renderDelivery();
  updateOrderStats();
  updateMonthlySummary();
  // Commission only becomes real once delivery actually happens, and never
  // happens if the order gets cancelled first — see finalizeDistributorCommissionForOrder().
  if (newStatus === 'delivered') finalizeDistributorCommissionForOrder(order.id, 'approved');
  else if (newStatus === 'cancelled') finalizeDistributorCommissionForOrder(order.id, 'rejected');
  // Stock was committed the moment this order was created (see createOrder()).
  // Cancelling it releases that stock back to the shelf; reviving a
  // previously-cancelled order (cycling past 'cancelled' back to 'pending')
  // commits it again.
  if (order.productId) {
    if (newStatus === 'cancelled' && prevStatus !== 'cancelled') {
      await applyStockMovement(order.productId, order.qty, 'adjustment', `Order ${order.orderRefNo || ''} cancelled — stock released`.trim());
    } else if (prevStatus === 'cancelled' && newStatus !== 'cancelled') {
      await applyStockMovement(order.productId, -order.qty, 'order', `Order ${order.orderRefNo || ''} reactivated — stock committed`.trim());
    }
  }
  updateStatus('🔄 Order status updated');
}

async function deleteOrder(index) {
  if (userRole !== 'owner') { alert('🔒 Only the business owner can delete orders.'); return; }
  if (!confirm('Delete this order?')) return;
  if (!currentUser) { alert('Please login first.'); return; }
  if (!(await ensureFreshSession())) return;
  const order = orders[index];
  try {
    const { error } = await supabase.from('orders').delete().eq('id', order.id).eq('user_id', businessId);
    if (error) throw error;
  } catch (e) {
    console.error('Delete order error:', e);
    alert('❌ Could not delete order: ' + e.message);
    return;
  }
  // If the order was still holding committed stock (never cancelled first),
  // deleting it must give that stock back — otherwise it's lost forever.
  if (order.productId && order.status !== 'cancelled') {
    await applyStockMovement(order.productId, order.qty, 'adjustment', `Order ${order.orderRefNo || ''} deleted — stock released`.trim());
  }
  orders.splice(index, 1);
  saveOrders();
  renderOrders();
  renderDelivery();
  updateOrderStats();
  updateMonthlySummary();
  updateStatus('🗑️ Order deleted');
}

function updateOrderStats() {
  $('statTotalOrders').textContent = orders.length;
  $('statDelivered').textContent = orders.filter(o => o.status === 'delivered').length;
  $('statPending').textContent = orders.filter(o => o.status === 'pending').length;
  $('statCancelled').textContent = orders.filter(o => o.status === 'cancelled').length;

  // COD reconcile: cash the driver has actually collected (delivered COD orders) vs
  // cash still expected because the COD order hasn't been delivered yet.
  const codCollectedEl = $('statCodCollected');
  const codOutstandingEl = $('statCodOutstanding');
  if (codCollectedEl || codOutstandingEl) {
    let collected = 0, outstanding = 0;
    (orders || []).forEach(o => {
      const isCod = (o.paymentMethod || 'cod') === 'cod';
      if (!isCod) return;
      if (o.status === 'delivered') collected += Number(o.codCollected != null ? o.codCollected : o.total) || 0;
      else if (o.status === 'pending' || o.status === 'shipped') outstanding += Number(o.total) || 0;
    });
    if (codCollectedEl) codCollectedEl.textContent = fmt(collected);
    if (codOutstandingEl) codOutstandingEl.textContent = fmt(outstanding);
  }
}

// ==================== DRIVER PAY (distance-based, tiered discount) ====================
// Rs. 50 per km base rate. Trips over 20km get a 7% discount off the gross, trips over
// 35km get a 10% discount off the gross (the higher tier replaces the lower one; they
// don't stack).
const DRIVER_PAY_RATE_PER_KM = 50;

function calculateDriverPay(km) {
  const distance = Number(km) || 0;
  if (!(distance > 0)) return { distance: 0, rate: DRIVER_PAY_RATE_PER_KM, discountPct: 0, gross: 0, discount: 0, pay: 0 };
  const discountPct = distance > 35 ? 10 : (distance > 20 ? 7 : 0);
  const gross = distance * DRIVER_PAY_RATE_PER_KM;
  const discount = gross * (discountPct / 100);
  const pay = gross - discount;
  return { distance, rate: DRIVER_PAY_RATE_PER_KM, discountPct, gross, discount, pay };
}
window.calculateDriverPay = calculateDriverPay;

function renderDelPayPreview() {
  const el = $('delPayCalcResult');
  const input = $('delPayCalcKm');
  if (!el || !input) return;
  const km = Number(input.value) || 0;
  if (km <= 0) { el.textContent = "Enter a distance to see the driver's pay."; return; }
  const r = calculateDriverPay(km);
  el.innerHTML = `<strong>${km} km</strong> → Rs. ${r.gross.toLocaleString()} gross` +
    (r.discountPct ? ` − ${r.discountPct}% (Rs. ${Math.round(r.discount).toLocaleString()}) = ` : ' = ') +
    `<strong>Rs. ${Math.round(r.pay).toLocaleString()}</strong> driver pay.`;
}
window.renderDelPayPreview = renderDelPayPreview;

function renderDeliveryStats() {
  const pendingEl = $('delStatPending');
  const deliveredTodayEl = $('delStatDeliveredToday');
  const kmMonthEl = $('delStatKmMonth');
  const payMonthEl = $('delStatPayMonth');
  if (!pendingEl && !deliveredTodayEl && !kmMonthEl && !payMonthEl) return;
  const today = todayStr();
  const monthPrefix = today.slice(0, 7);
  let pending = 0, deliveredToday = 0, kmMonth = 0, payMonth = 0;
  orders.forEach(o => {
    if (o.status === 'cancelled') return;
    if (o.status === 'pending' || o.status === 'shipped') pending++;
    const created = (o.createdAt || '').slice(0, 10);
    if (o.status === 'delivered' && created === today) deliveredToday++;
    if ((o.createdAt || '').slice(0, 7) === monthPrefix && o.deliveryKm) {
      kmMonth += Number(o.deliveryKm) || 0;
      payMonth += calculateDriverPay(o.deliveryKm).pay;
    }
  });
  if (pendingEl) pendingEl.textContent = pending;
  if (deliveredTodayEl) deliveredTodayEl.textContent = deliveredToday;
  if (kmMonthEl) kmMonthEl.textContent = `${kmMonth.toFixed(1)} km`;
  if (payMonthEl) payMonthEl.textContent = `Rs. ${Math.round(payMonth).toLocaleString()}`;
}
window.renderDeliveryStats = renderDeliveryStats;

function renderDeliveryDriverStats() {
  const tbody = $('deliveryDriverStatsBody');
  const onlineCountEl = $('delStatDrivers');
  if (!tbody) return;
  if (!driverListCache.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;opacity:.5;padding:18px;">No drivers added yet. Use "Add Driver" above.</td></tr>';
    if (onlineCountEl) onlineCountEl.textContent = '0';
    return;
  }
  const today = todayStr();
  const monthPrefix = today.slice(0, 7);
  let onlineCount = 0;
  tbody.innerHTML = driverListCache.map(d => {
    const mine = orders.filter(o => String(o.assignedDriverId || '') === String(d.id) && o.status !== 'cancelled');
    const todayOrders = mine.filter(o => (o.createdAt || '').slice(0, 10) === today);
    const todayKm = todayOrders.reduce((s, o) => s + (Number(o.deliveryKm) || 0), 0);
    const todayPay = todayOrders.reduce((s, o) => s + calculateDriverPay(o.deliveryKm).pay, 0);
    const monthPay = mine.filter(o => (o.createdAt || '').slice(0, 7) === monthPrefix)
      .reduce((s, o) => s + calculateDriverPay(o.deliveryKm).pay, 0);
    const lastSeen = driverLocationFreshness[String(d.id)];
    const isOnline = lastSeen && (Date.now() - lastSeen) < DRIVER_ONLINE_THRESHOLD_MS;
    if (isOnline) onlineCount++;
    const statusBadge = isOnline
      ? '<span style="color:#1a7f37;font-weight:600;">🟢 Online</span>'
      : (lastSeen ? `<span style="opacity:.6;">⚪ Last seen ${Math.max(1, Math.round((Date.now() - lastSeen) / 60000))}m ago</span>` : '<span style="opacity:.5;">⚪ Not sharing</span>');
    // "Working %" = how much of today's shift (first share → now) actually had
    // location sharing ON. Needs shift_start_at to be from TODAY — a driver who
    // hasn't opened the app yet today (stale row from yesterday) shows "—"
    // rather than a misleading number computed against a shift that isn't real.
    const shift = driverShiftDataCache[String(d.id)];
    let workingPctCell = '<span style="opacity:.4;">—</span>';
    if (shift && shift.shiftStartAt && shift.shiftStartAt.slice(0, 10) === today) {
      const shiftMs = Date.now() - new Date(shift.shiftStartAt).getTime();
      if (shiftMs > 0) {
        const pct = Math.max(0, Math.min(100, Math.round((shift.activeSeconds * 1000 / shiftMs) * 100)));
        workingPctCell = `${pct}%`;
      }
    }
    return `<tr>
      <td>${escapeHtmlSafe(d.display_name || d.id.slice(0, 8))}</td>
      <td>${statusBadge}</td>
      <td>${todayOrders.length}</td>
      <td>${todayKm ? todayKm.toFixed(1) : '-'}</td>
      <td>Rs. ${Math.round(todayPay).toLocaleString()}</td>
      <td>${workingPctCell}</td>
      <td>Rs. ${Math.round(monthPay).toLocaleString()}</td>
      <td><button class="btn btn-sm btn-danger" data-action="removeStaffMember" data-id="${d.id}" aria-label="Remove driver"><i class="business-icon icon-inline" data-lucide="trash-2" aria-hidden="true"></i></button></td>
    </tr>`;
  }).join('');
  if (onlineCountEl) onlineCountEl.textContent = String(onlineCount);
  if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } });
}
window.renderDeliveryDriverStats = renderDeliveryDriverStats;

// ==================== DELIVERY PERFORMANCE DASHBOARD ====================
// On-time %, average delivery time, per-driver success rate and a breakdown
// of why deliveries fail. Pulls from the same `orders` array everything else
// on this tab already uses — no extra fetch needed.
// Which range the "Driver-wise Success Rate" table is filtered to: 'today' or 'all'.
let perfDriverRange = 'today';
function setPerfDriverRange(range) {
  perfDriverRange = range;
  const todayBtn = $('perfDriverRangeTodayBtn');
  const allBtn = $('perfDriverRangeAllBtn');
  if (todayBtn) todayBtn.classList.toggle('btn-primary', range === 'today');
  if (allBtn) allBtn.classList.toggle('btn-primary', range === 'all');
  renderDeliveryPerformance();
}
window.setPerfDriverRange = setPerfDriverRange;

function renderDeliveryPerformance() {
  const onTimeEl = $('perfOnTimePct');
  const avgTimeEl = $('perfAvgTime');
  const successEl = $('perfSuccessRate');
  const ratingEl = $('perfAvgRating');
  const driverBody = $('perfDriverBody');
  const reasonsCanvas = $('perfFailedReasonsChart');
  const reasonsNote = $('perfFailedReasonsNote');
  if (!onTimeEl && !driverBody && !reasonsCanvas) return; // panel not on this page

  const live = (orders || []).filter(o => o.status !== 'cancelled');
  const delivered = live.filter(o => o.status === 'delivered');
  const failed = live.filter(o => o.status === 'failed');
  const attempts = delivered.length + failed.length;

  // On-time % + average delivery time — only orders with BOTH a shipped_at and
  // delivered_at timestamp can be judged (older orders predating this feature won't have shipped_at).
  const timed = delivered.filter(o => o.shippedAt && o.deliveredAt);
  const durationsMs = timed.map(o => new Date(o.deliveredAt) - new Date(o.shippedAt)).filter(ms => ms >= 0);
  const onTimeCount = durationsMs.filter(ms => ms <= DELIVERY_ONTIME_HOURS * 3600 * 1000).length;
  const onTimePct = durationsMs.length ? Math.round((onTimeCount / durationsMs.length) * 100) : null;
  const avgMs = durationsMs.length ? durationsMs.reduce((a, b) => a + b, 0) / durationsMs.length : null;

  const successPct = attempts ? Math.round((delivered.length / attempts) * 100) : null;
  const rated = delivered.filter(o => o.customerRating);
  const avgRating = rated.length ? (rated.reduce((s, o) => s + o.customerRating, 0) / rated.length) : null;

  if (onTimeEl) onTimeEl.textContent = onTimePct != null ? `${onTimePct}%` : '—';
  if (avgTimeEl) avgTimeEl.textContent = avgMs != null ? formatDurationShort(avgMs) : '—';
  if (successEl) successEl.textContent = attempts ? `${successPct}% (${delivered.length}/${attempts})` : '—';
  if (ratingEl) ratingEl.textContent = avgRating != null ? `⭐ ${avgRating.toFixed(1)} (${rated.length})` : '—';

  // ---- Driver-wise success rate ----
  if (driverBody) {
    if (!driverListCache.length) {
      driverBody.innerHTML = '<tr><td colspan="4" style="text-align:center;opacity:.5;padding:14px;">No drivers added yet.</td></tr>';
    } else {
      const today = todayStr();
      // "Today" = attempts (delivered or failed) that were actually resolved today —
      // by delivered_at/failed_at when present, falling back to created_at for older
      // rows recorded before those timestamp columns existed.
      const isToday = (o, dateField) => ((o[dateField] || o.createdAt || '').slice(0, 10)) === today;
      const deliveredForRange = perfDriverRange === 'today' ? delivered.filter(o => isToday(o, 'deliveredAt')) : delivered;
      const failedForRange = perfDriverRange === 'today' ? failed.filter(o => isToday(o, 'failedAt')) : failed;
      driverBody.innerHTML = driverListCache.map(d => {
        const mineDelivered = deliveredForRange.filter(o => String(o.assignedDriverId || '') === String(d.id)).length;
        const mineFailed = failedForRange.filter(o => String(o.assignedDriverId || '') === String(d.id)).length;
        const mineAttempts = mineDelivered + mineFailed;
        const pct = mineAttempts ? Math.round((mineDelivered / mineAttempts) * 100) : null;
        return `<tr>
          <td>${escapeHtmlSafe(d.display_name || d.id.slice(0, 8))}</td>
          <td>${mineDelivered}</td>
          <td>${mineFailed}</td>
          <td>${pct != null ? pct + '%' : '—'}</td>
        </tr>`;
      }).join('');
    }
  }

  // ---- Failed-delivery reasons breakdown (bar chart) ----
  if (reasonsCanvas) {
    const reasonCounts = {};
    failed.forEach(o => {
      const r = o.failedReason || 'Unspecified';
      reasonCounts[r] = (reasonCounts[r] || 0) + 1;
    });
    const labels = Object.keys(reasonCounts);
    const colors = getChartColors();
    const data = {
      labels: labels.length ? labels : ['No failed deliveries'],
      datasets: [{
        label: 'Failed deliveries',
        data: labels.length ? labels.map(l => reasonCounts[l]) : [0],
        backgroundColor: '#f87171', borderRadius: 6
      }]
    };
    const opts = {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: colors.text }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: colors.text, precision: 0 }, grid: { color: colors.grid } }
      }
    };
    if (perfFailedReasonsChart) { perfFailedReasonsChart.data = data; perfFailedReasonsChart.options = opts; perfFailedReasonsChart.update(); }
    else perfFailedReasonsChart = new Chart(reasonsCanvas.getContext('2d'), { type: 'bar', data, options: opts });
    if (reasonsNote) reasonsNote.textContent = failed.length ? `${failed.length} failed deliveries recorded.` : 'No failed deliveries recorded yet — great!';
  }
}
window.renderDeliveryPerformance = renderDeliveryPerformance;

// Formats a millisecond duration as "Xh Ym" (or "Ym" if under an hour) for the
// Delivery Performance dashboard's "Avg Delivery Time" stat.
function formatDurationShort(ms) {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function renderDelivery() {
  const tbody = $('deliveryBody');
  if (!tbody) { renderDeliveryStats(); renderDeliveryPerformance(); return; }
  const activeOrders = orders.filter(o => o.status !== 'cancelled');
  if (activeOrders.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;opacity:0.5;padding:20px;">No active deliveries.</td></tr>';
    renderDeliveryStats();
    renderDeliveryDriverStats();
    renderDeliveryPerformance();
    populateRiderFeedbackSelect();
    renderRiderFeedback();
    return;
  }
  const orderIndexById = new Map(orders.map((o, i) => [String(o.id), i]));
  const hasDrivers = userRole === 'owner' && driverListCache.length > 0;
  tbody.innerHTML = activeOrders.map(order => {
    const realIndex = orderIndexById.get(String(order.id));
    const driverCell = userRole !== 'owner' ? '' : (hasDrivers ? `
      <select style="padding:4px 6px;font-size:12px;border-radius:6px;" onchange="assignDriver('${order.id}', this.value)">
        <option value="">— Unassigned —</option>
        ${driverListCache.map(d => `<option value="${d.id}" ${String(order.assignedDriverId||'')===String(d.id)?'selected':''}>${d.display_name || d.id.slice(0,8)}</option>`).join('')}
      </select>` : '<span style="opacity:.4;">No drivers added</span>');
    const kmCell = userRole === 'owner'
      ? `<input type="number" min="0" step="0.1" value="${order.deliveryKm != null ? order.deliveryKm : ''}" placeholder="km" style="width:70px;padding:4px 6px;font-size:12px;border-radius:6px;" onchange="updateDeliveryKm('${order.id}', this.value)">`
      : (order.deliveryKm ? `${order.deliveryKm} km` : '-');
    const pay = calculateDriverPay(order.deliveryKm);
    const payCell = pay.distance > 0
      ? `Rs. ${Math.round(pay.pay).toLocaleString()}${pay.discountPct ? ` <span style="opacity:.55;font-size:11px;">(-${pay.discountPct}%)</span>` : ''}`
      : '-';
    return `<tr>
      <td><strong>${order.id}</strong></td>
      <td>${getCustomerName(order.customerId)}</td>
      <td>${order.address || '-'}</td>
      <td>${getStatusBadge(order.status)}</td>
      <td>${driverCell}</td>
      <td>${kmCell}</td>
      <td>${payCell}</td>
      <td><button class="btn btn-sm" onclick="cycleStatus(${realIndex})"><i class="business-icon icon-inline" data-lucide="refresh-cw" aria-hidden="true"></i> Update</button></td>
    </tr>`;
  }).join('');
  if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } });
  renderDeliveryStats();
  renderDeliveryDriverStats();
  renderDeliveryPerformance();
  populateRiderFeedbackSelect();
  renderRiderFeedback();
}

async function assignDriver(orderId, driverId) {
  if (userRole !== 'owner') return;
  if (!(await ensureFreshSession())) return;
  try {
    const { error } = await supabase.from('orders')
      .update({ assigned_driver_id: driverId || null })
      .eq('id', orderId).eq('user_id', businessId);
    if (error) throw error;
    const o = orders.find(x => String(x.id) === String(orderId));
    if (o) o.assignedDriverId = driverId || null;
    saveOrders();
    renderDeliveryDriverStats();
    if (driverId && o) notifyDriverOnWhatsApp(driverId, o);
    updateStatus(driverId ? '🚚 Driver assigned' : '🚚 Driver unassigned');
  } catch (e) {
    console.error('Assign driver error:', e);
    alert('❌ Could not assign driver: ' + e.message + '\n\nMake sure the "assigned_driver_id" column exists on the orders table in Supabase (see the setup notes for this feature).');
  }
}
window.assignDriver = assignDriver;

// Best-effort WhatsApp "push": opens a pre-filled wa.me link to the driver's own
// saved number (see the "My WhatsApp Number" card on their Profile tab). If the
// driver hasn't saved a number yet, this quietly does nothing — the in-app /
// browser notification (see notifyDriverNewDelivery) still reaches them.
function notifyDriverOnWhatsApp(driverId, order) {
  const driver = (driverListCache || []).find(d => String(d.id) === String(driverId));
  const num = driver && driver.whatsapp_number;
  if (!num) return;
  const digits = String(num).replace(/\D/g, '');
  if (!digits) return;
  const label = order.orderRefNo || order.id;
  const msg = `🚚 New delivery assigned!\nOrder: ${label}\nCustomer: ${getCustomerName(order.customerId)}\nAddress: ${order.address || '-'}\nTotal: Rs. ${Number(order.total || 0).toLocaleString()}\n\nOpen the MY DRYBEA app → My Deliveries to see it.`;
  window.open('https://wa.me/' + digits + '?text=' + encodeURIComponent(msg), '_blank');
}

async function updateDeliveryKm(orderId, kmValue) {
  if (userRole !== 'owner') return;
  const km = kmValue === '' ? null : Math.max(0, Number(kmValue) || 0);
  if (!(await ensureFreshSession())) return;
  try {
    const { error } = await supabase.from('orders')
      .update({ delivery_km: km })
      .eq('id', orderId).eq('user_id', businessId);
    if (error) throw error;
    const o = orders.find(x => String(x.id) === String(orderId));
    if (o) o.deliveryKm = km;
    saveOrders();
    renderDelivery();
    updateStatus(km != null ? `📏 Distance saved: ${km} km` : '📏 Distance cleared');
  } catch (e) {
    console.error('Update delivery km error:', e);
    alert('❌ Could not save distance: ' + e.message + '\n\nMake sure the "delivery_km" column exists on the orders table in Supabase (numeric type).');
  }
}
window.updateDeliveryKm = updateDeliveryKm;

// ==================== DRIVER: MY DELIVERIES ====================
let myDeliveries = [];

// ==================== BATCH DELIVERY MODE ====================
// Lets a driver tick several "shipped" (out-for-delivery) orders that are
// physically close together and confirm them all delivered in one pass —
// one shared proof photo (+ optional shared signature), with each order's
// own COD amount still editable individually. See openBatchDeliverModal /
// confirmBatchDelivery below.
let batchSelectedIds = new Set(); // order ids (as strings) currently ticked
let batchGroupsCache = [];        // last computed nearby-order clusters, indexed for selectBatchGroup()
let batchDeliverPhotoFile = null;

async function loadMyDeliveries() {
  if (!currentUser || userRole !== 'driver') return;
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('assigned_driver_id', currentUser.id)
      .order('created_at', { ascending: true });
    if (error) throw error;
    myDeliveries = data || [];
    renderMyDeliveries();
    updateStatus('☁️ Deliveries loaded');
  } catch (e) {
    console.error('Load my deliveries error:', e);
    updateStatus('⚠️ Could not load deliveries: ' + e.message);
  }
}

// Which "My Deliveries" sub-tab is currently shown: 'active' (everything not
// yet delivered — pending, out for delivery, or a failed attempt to retry)
// or 'history' (already delivered).
let myDeliveriesActiveTab = 'active';

function switchMyDeliveriesTab(tab) {
  myDeliveriesActiveTab = tab;
  ['active', 'history'].forEach(t => {
    const panel = $(`myDelTab-${t}`);
    if (panel) panel.style.display = (t === tab) ? '' : 'none';
  });
  document.querySelectorAll('.my-del-subtab').forEach(btn => {
    btn.classList.toggle('btn-primary', btn.getAttribute('data-mydel-tab') === tab);
  });
}
window.switchMyDeliveriesTab = switchMyDeliveriesTab;

// Builds one <tr> for a delivery row. `mode` controls which action buttons show:
// 'active' (pending/shipped/failed — Start, batch checkbox + Mark Delivered/Report
// Issue, or Retry, depending on status), 'history' (delivered — read-only).
function buildMyDeliveryRow(o, stopBadge, navOriginParam, mode) {
  const addr = o.address || '';
  const destParam = (o.delivery_lat != null && o.delivery_lng != null)
    ? `${o.delivery_lat},${o.delivery_lng}`
    : addr;
  const mapsUrl = destParam ? `https://www.google.com/maps/dir/?api=1${navOriginParam}&destination=${encodeURIComponent(destParam)}` : '';
  const codLabel = (o.payment_method || 'cod') === 'cod'
    ? `<br><small style="opacity:.7;font-weight:700;">💵 COD Rs. ${Number(o.total || 0).toLocaleString()}${o.status==='delivered' && o.cod_collected!=null ? ' • collected Rs. '+Number(o.cod_collected).toLocaleString() : ''}</small>`
    : '';
  const failedHint = o.status === 'failed' && o.failed_reason
    ? `<br><small style="color:#c0392b;">⚠️ ${escapeHtmlSafe(o.failed_reason)}${o.failed_notes ? ' — '+escapeHtmlSafe(o.failed_notes) : ''}</small>`
    : '';
  const payHint = o.delivery_km
    ? `<br><small style="opacity:.55;">${o.delivery_km} km • Rs. ${Math.round(calculateDriverPay(o.delivery_km).pay).toLocaleString()} pay</small>`
    : '';
  const hasPin = o.delivery_lat != null && o.delivery_lng != null;
  const pinHint = mode !== 'history'
    ? (hasPin
        ? '<br><small style="color:#1a7f4b;">📍 Pin set</small>'
        : '<br><small style="opacity:.5;">📍 No exact pin yet</small>')
    : '';
  const setPinBtn = mode !== 'history'
    ? `<button class="btn btn-sm" onclick="openSetPinModal('${o.id}')" style="margin-right:6px;" title="Drop an exact map pin for this address"><i class="business-icon icon-inline" data-lucide="map-pinned" aria-hidden="true"></i> ${hasPin ? 'Edit Pin' : 'Set Pin'}</button>`
    : '';
  const ratingCell = o.status === 'delivered'
    ? (o.customer_rating
        ? `<br><small style="opacity:.7;">⭐ Rated ${o.customer_rating}/5${o.rating_feedback ? ' — '+escapeHtmlSafe(o.rating_feedback) : ''}</small>`
        : (o.rating_token ? `<button class="btn btn-sm" onclick="openRatingLinkModal('${o.id}')" title="Show a QR / WhatsApp link for the customer to rate this delivery"><i class="business-icon icon-inline" data-lucide="star" aria-hidden="true"></i> Send Rating Link</button>` : ''))
    : '';
  const navBtn = mapsUrl ? `<a href="${mapsUrl}" target="_blank" rel="noopener" class="btn btn-sm" style="margin-right:6px;"><i class="business-icon icon-inline" data-lucide="map-pin" aria-hidden="true"></i> Navigate</a>` : '';

  if (mode === 'active') {
    const selectCb = o.status === 'shipped'
      ? `<input type="checkbox" class="batch-select-cb" title="Select for batch delivery" onchange="toggleBatchSelect('${o.id}', this.checked)" ${batchSelectedIds.has(String(o.id)) ? 'checked' : ''} style="margin-right:6px;vertical-align:middle;width:16px;height:16px;">`
      : '';
    let nextBtn = '';
    if (o.status === 'pending') {
      nextBtn = `<button class="btn btn-sm btn-primary" onclick="driverMarkStatus('${o.id}','shipped')"><i class="business-icon icon-inline" data-lucide="truck" aria-hidden="true"></i> Start Delivery</button>`;
    } else if (o.status === 'shipped') {
      nextBtn = `<button class="btn btn-sm btn-primary" onclick="openDeliverModal('${o.id}')" style="margin-right:6px;"><i class="business-icon icon-inline" data-lucide="circle-check" aria-hidden="true"></i> Mark Delivered</button>
        <button class="btn btn-sm" onclick="openFailedModal('${o.id}')"><i class="business-icon icon-inline" data-lucide="circle-alert" aria-hidden="true"></i> Report Issue</button>`;
    } else if (o.status === 'failed') {
      nextBtn = `<button class="btn btn-sm btn-primary" onclick="driverMarkStatus('${o.id}','shipped')"><i class="business-icon icon-inline" data-lucide="rotate-ccw" aria-hidden="true"></i> Retry Delivery</button>`;
    }
    return `<tr>
      <td>${selectCb}${stopBadge}</td>
      <td><strong>${o.order_ref_no || String(o.id).slice(0,8)}</strong></td>
      <td>${escapeHtmlSafe(o.customer_name_snapshot || o.customer_address_snapshot || '-')}</td>
      <td>${escapeHtmlSafe(addr || '-')}${codLabel}${payHint}${pinHint}</td>
      <td>${getStatusBadge(o.status)}${failedHint}</td>
      <td>${navBtn}${setPinBtn}${nextBtn}</td>
    </tr>`;
  }
  // mode === 'history'
  const deliveredAgo = o.delivered_at ? new Date(o.delivered_at).toLocaleString() : '-';
  return `<tr>
    <td><strong>${o.order_ref_no || String(o.id).slice(0,8)}</strong></td>
    <td>${escapeHtmlSafe(o.customer_name_snapshot || o.customer_address_snapshot || '-')}</td>
    <td>${escapeHtmlSafe(addr || '-')}${codLabel}${payHint}</td>
    <td>${deliveredAgo}</td>
    <td>${ratingCell || '<span style="opacity:.4;">—</span>'}</td>
  </tr>`;
}

function renderMyDeliveries() {
  const activeBody = $('myDeliveriesActiveBody');
  const historyBody = $('myDeliveriesHistoryBody');
  if (!activeBody && !historyBody) return;
  // Drop any batch selections that no longer point at a "shipped" order of
  // ours (e.g. it was reassigned, cancelled, or already delivered elsewhere).
  if (batchSelectedIds.size) {
    const stillShippable = new Set(myDeliveries.filter(o => o.status === 'shipped').map(o => String(o.id)));
    Array.from(batchSelectedIds).forEach(id => { if (!stillShippable.has(id)) batchSelectedIds.delete(id); });
  }
  const allActive = myDeliveries.filter(o => o.status === 'pending' || o.status === 'shipped' || o.status === 'failed');
  const done = myDeliveries.filter(o => o.status === 'delivered');

  // If every active stop has an optimized route_sequence, number them in that
  // order; otherwise fall back to assignment order.
  const hasFullRoute = allActive.length > 0 && allActive.every(o => o.route_sequence != null);
  const orderedActive = hasFullRoute
    ? [...allActive].sort((a, b) => (a.route_sequence || 0) - (b.route_sequence || 0))
    : allActive;
  const stopIndex = new Map(orderedActive.map((o, i) => [String(o.id), i + 1]));
  const stopBadgeFor = (o) => hasFullRoute
    ? `<span class="badge" style="background:#eef;color:#334;font-weight:700;">${stopIndex.get(String(o.id))}</span>`
    : `<span style="opacity:.35;">${stopIndex.get(String(o.id))}</span>`;

  // Every "Navigate" link should route starting from the pickup point (Drybea
  // Market, or whatever the owner has set), not from wherever the driver's
  // phone happens to be right now — same fixed-origin rule as the Route
  // Optimizer (see getDriverStartPosition()).
  const navOrigin = getPickupLocation();
  const navOriginParam = `&origin=${navOrigin.lat},${navOrigin.lng}`;

  if (activeBody) {
    activeBody.innerHTML = orderedActive.length
      ? orderedActive.map(o => buildMyDeliveryRow(o, stopBadgeFor(o), navOriginParam, 'active')).join('')
      : '<tr><td colspan="6" style="text-align:center;opacity:.5;padding:20px;">No deliveries assigned to you right now.</td></tr>';
    renderBatchGroupsBar();
    updateBatchActionBar();
  }
  if (historyBody) {
    const doneSorted = done.slice().sort((a, b) => new Date(b.delivered_at || b.created_at || 0) - new Date(a.delivered_at || a.created_at || 0));
    historyBody.innerHTML = doneSorted.length
      ? doneSorted.map(o => buildMyDeliveryRow(o, '', navOriginParam, 'history')).join('')
      : '<tr><td colspan="5" style="text-align:center;opacity:.5;padding:20px;">No deliveries completed yet.</td></tr>';
  }
  if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } });
  updateMyDeliveriesNewBadge();
}

// "New" here = deliveries assigned to this driver that are still 'pending'
// (i.e. not started yet — driver hasn't tapped "Start Delivery"). Mirrors the
// Orders tab's badge and the My Staff advance-request badge.
function updateMyDeliveriesNewBadge() {
  const badge = $('myDeliveriesNewBadge');
  if (!badge) return;
  const count = (myDeliveries || []).filter(o => o.status === 'pending').length;
  if (count > 0) { badge.textContent = count > 99 ? '99+' : String(count); badge.style.display = 'inline-block'; }
  else { badge.style.display = 'none'; }
}

// ==================== DRIVER: MY REVIEWS (customer feedback per order, self view) ====================
// Read-only, built entirely from the driver's own `myDeliveries` (already
// loaded for the My Deliveries tab — no extra fetch needed). Shows every
// delivered order the customer actually rated, newest first.
function renderMyReviews() {
  const tbody = $('myReviewsBody');
  const avgEl = $('myReviewsAvg');
  const countEl = $('myReviewsCount');
  if (!tbody && !avgEl && !countEl) return; // panel not on this page / not a driver
  const rated = (myDeliveries || []).filter(o => o.status === 'delivered' && o.customer_rating != null);
  const sorted = rated.slice().sort((a, b) => new Date(b.rated_at || b.delivered_at || 0) - new Date(a.rated_at || a.delivered_at || 0));
  const avg = rated.length ? (rated.reduce((s, o) => s + Number(o.customer_rating), 0) / rated.length) : null;
  if (avgEl) avgEl.textContent = avg != null ? `⭐ ${avg.toFixed(1)}` : '—';
  if (countEl) countEl.textContent = String(rated.length);
  if (tbody) {
    tbody.innerHTML = sorted.length ? sorted.map(o => {
      const full = Math.round(Number(o.customer_rating));
      const stars = '⭐'.repeat(full) + `<span style="opacity:.25;">${'⭐'.repeat(Math.max(0, 5 - full))}</span>`;
      const when = o.rated_at ? new Date(o.rated_at).toLocaleDateString() : (o.delivered_at ? new Date(o.delivered_at).toLocaleDateString() : '-');
      return `<tr>
        <td><strong>${o.order_ref_no || String(o.id).slice(0, 8)}</strong></td>
        <td>${escapeHtmlSafe(o.customer_name_snapshot || o.customer_address_snapshot || '-')}</td>
        <td>${when}</td>
        <td>${stars}</td>
        <td>${o.rating_feedback ? escapeHtmlSafe(o.rating_feedback) : '<span style="opacity:.4;">No written feedback</span>'}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="5" style="text-align:center;opacity:.5;padding:14px;">No customer feedback yet.</td></tr>';
  }
}
window.renderMyReviews = renderMyReviews;

// ==================== DRIVER: HOME (rider overview, separate from My Deliveries) ====================
// Lightweight dashboard a driver lands on first. Reuses the same `myDeliveries`
// array already loaded for My Deliveries / My Earnings — no extra fetch needed.
function renderDriverHome() {
  if (!$('driverHomeActive')) return; // panel not on this page / not a driver
  const name = (userProfile && userProfile.display_name) || currentUser?.email?.split('@')[0] || 'Rider';
  if ($('driverHomeName')) $('driverHomeName').textContent = name;

  const list = myDeliveries || [];
  const today = todayStr();
  const active = list.filter(o => o.status === 'pending' || o.status === 'shipped' || o.status === 'failed');
  const deliveredToday = list.filter(o => o.status === 'delivered' && (o.delivered_at || o.created_at || '').slice(0, 10) === today);
  const todayPay = deliveredToday.reduce((s, o) => s + calculateDriverPay(o.delivery_km).pay, 0);

  if ($('driverHomeActive')) $('driverHomeActive').textContent = String(active.length);
  if ($('driverHomeDeliveredToday')) $('driverHomeDeliveredToday').textContent = String(deliveredToday.length);
  if ($('driverHomeTodayPay')) $('driverHomeTodayPay').textContent = 'Rs. ' + Math.round(todayPay).toLocaleString();

  const rated = list.filter(o => o.status === 'delivered' && o.customer_rating != null);
  const avg = rated.length ? (rated.reduce((s, o) => s + Number(o.customer_rating), 0) / rated.length) : null;
  if ($('driverHomeRating')) $('driverHomeRating').textContent = avg != null ? `⭐ ${avg.toFixed(1)}` : '—';
  hideSkeletons('driver-home');

  const hasFullRoute = active.length > 0 && active.every(o => o.route_sequence != null);
  const ordered = hasFullRoute ? [...active].sort((a, b) => (a.route_sequence || 0) - (b.route_sequence || 0)) : active;
  const nextStops = $('driverHomeNextStops');
  if (nextStops) {
    nextStops.innerHTML = ordered.length
      ? ordered.slice(0, 4).map((o, i) => `<div class="task-row"><div class="task-main"><strong>${i + 1}. ${o.order_ref_no || String(o.id).slice(0, 8)}</strong><small>${escapeHtmlSafe(o.address || '-')}</small></div>${getStatusBadge(o.status)}</div>`).join('')
      : '<div class="notice">No deliveries assigned to you right now.</div>';
  }
  if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } });
}
window.renderDriverHome = renderDriverHome;

// ==================== OWNER: RIDER FEEDBACK (per-driver customer reviews) ====================
// Owner picks a rider from the Delivery page and sees every order that rider
// delivered with the customer's rating + written feedback. Reuses the same
// `orders` array and `driverListCache` already loaded for the rest of this
// page — no extra fetch needed.
let riderFeedbackDriverId = '';

function populateRiderFeedbackSelect() {
  const sel = $('riderFeedbackDriverSelect');
  if (!sel) return;
  const prev = riderFeedbackDriverId;
  sel.innerHTML = '<option value="">— Select a rider —</option>' +
    driverListCache.map(d => `<option value="${d.id}">${escapeHtmlSafe(d.display_name || d.id.slice(0, 8))}</option>`).join('');
  if (prev && driverListCache.some(d => String(d.id) === String(prev))) sel.value = prev;
  else riderFeedbackDriverId = '';
}

function onRiderFeedbackDriverChange(val) {
  riderFeedbackDriverId = val;
  renderRiderFeedback();
}
window.onRiderFeedbackDriverChange = onRiderFeedbackDriverChange;

function renderRiderFeedback() {
  const tbody = $('riderFeedbackBody');
  const avgEl = $('riderFeedbackAvg');
  const countEl = $('riderFeedbackCount');
  if (!tbody) return;
  if (!riderFeedbackDriverId) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;opacity:.5;padding:14px;">Select a rider above to see their reviews.</td></tr>';
    if (avgEl) avgEl.textContent = '—';
    if (countEl) countEl.textContent = '0';
    return;
  }
  const mine = (orders || []).filter(o => String(o.assignedDriverId || '') === String(riderFeedbackDriverId) && o.customerRating != null);
  const sorted = mine.slice().sort((a, b) => new Date(b.ratedAt || b.deliveredAt || 0) - new Date(a.ratedAt || a.deliveredAt || 0));
  const avg = mine.length ? (mine.reduce((s, o) => s + Number(o.customerRating), 0) / mine.length) : null;
  if (avgEl) avgEl.textContent = avg != null ? `⭐ ${avg.toFixed(1)}` : '—';
  if (countEl) countEl.textContent = String(mine.length);
  tbody.innerHTML = sorted.length ? sorted.map(o => {
    const full = Math.round(Number(o.customerRating));
    const stars = '⭐'.repeat(full) + `<span style="opacity:.25;">${'⭐'.repeat(Math.max(0, 5 - full))}</span>`;
    const when = o.ratedAt ? new Date(o.ratedAt).toLocaleDateString() : (o.deliveredAt ? new Date(o.deliveredAt).toLocaleDateString() : '-');
    return `<tr>
      <td><strong>${o.orderRefNo || String(o.id).slice(0, 8)}</strong></td>
      <td>${escapeHtmlSafe(getCustomerName(o.customerId))}</td>
      <td>${when}</td>
      <td>${stars}</td>
      <td>${o.ratingFeedback ? escapeHtmlSafe(o.ratingFeedback) : '<span style="opacity:.4;">No written feedback</span>'}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="5" style="text-align:center;opacity:.5;padding:14px;">No reviews for this rider yet.</td></tr>';
}
window.renderRiderFeedback = renderRiderFeedback;

// ==================== DRIVER: MY EARNINGS (pay-per-km + COD handover) ====================
// Read-only pay summary built entirely from the driver's own `myDeliveries`
// (already loaded for the My Deliveries tab — no extra order fetch needed),
// plus a self-reported cash-handover log so a driver can tell the owner
// "I gave you Rs. X" without a phone call, and the owner gets notified
// instantly (see the driver_cod_handovers realtime hookup below).
let driverHandovers = []; // this driver's own logged cash handovers to the owner

async function loadDriverHandovers() {
  if (!currentUser || userRole !== 'driver') return;
  try {
    const { data, error } = await supabase
      .from('driver_cod_handovers')
      .select('*')
      .eq('driver_id', currentUser.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    driverHandovers = data || [];
    renderMyEarnings();
  } catch (e) {
    console.error('Load driver handovers error:', e);
  }
}
window.loadDriverHandovers = loadDriverHandovers;

function startOfWeek(d) {
  const date = new Date(d);
  const day = date.getDay(); // 0 = Sunday
  const diff = (day === 0 ? -6 : 1) - day; // shift so Monday starts the week
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

function renderMyEarnings() {
  if (!$('myEarnTodayPay')) return; // panel not on this page / not a driver
  const today = todayStr();
  const monthPrefix = today.slice(0, 7);
  const weekStart = startOfWeek(new Date());

  const delivered = (myDeliveries || []).filter(o => o.status === 'delivered');
  const sumPay = (list) => list.reduce((s, o) => s + calculateDriverPay(o.delivery_km).pay, 0);
  const sumKm = (list) => list.reduce((s, o) => s + (Number(o.delivery_km) || 0), 0);
  const dayOf = (o) => (o.delivered_at || o.created_at || '').slice(0, 10);

  const todayList = delivered.filter(o => dayOf(o) === today);
  const weekList = delivered.filter(o => new Date(o.delivered_at || o.created_at || 0) >= weekStart);
  const monthList = delivered.filter(o => dayOf(o).slice(0, 7) === monthPrefix);

  $('myEarnTodayPay').textContent = 'Rs. ' + Math.round(sumPay(todayList)).toLocaleString();
  $('myEarnTodayKm').textContent = sumKm(todayList).toFixed(1) + ' km';
  $('myEarnWeekPay').textContent = 'Rs. ' + Math.round(sumPay(weekList)).toLocaleString();
  $('myEarnMonthPay').textContent = 'Rs. ' + Math.round(sumPay(monthList)).toLocaleString();
  $('myEarnMonthKm').textContent = sumKm(monthList).toFixed(1) + ' km';

  // COD collected only counts orders actually marked delivered with a recorded
  // collection amount — matches the same fields the proof-of-delivery flow saves.
  const isCollectedCod = (o) => (o.payment_method || 'cod') === 'cod' && o.cod_collected != null;
  const codCollectedMonth = monthList.filter(isCollectedCod).reduce((s, o) => s + Number(o.cod_collected || 0), 0);
  const handedOverMonth = (driverHandovers || [])
    .filter(h => (h.created_at || '').slice(0, 7) === monthPrefix)
    .reduce((s, h) => s + Number(h.amount || 0), 0);
  // Outstanding is all-time collected minus all-time handed over — cash a
  // driver is still holding doesn't reset just because the month rolled over.
  const codCollectedAll = delivered.filter(isCollectedCod).reduce((s, o) => s + Number(o.cod_collected || 0), 0);
  const handedOverAll = (driverHandovers || []).reduce((s, h) => s + Number(h.amount || 0), 0);
  const outstanding = codCollectedAll - handedOverAll;

  if ($('myEarnCodCollected')) $('myEarnCodCollected').textContent = 'Rs. ' + Math.round(codCollectedMonth).toLocaleString();
  if ($('myEarnCodHanded')) $('myEarnCodHanded').textContent = 'Rs. ' + Math.round(handedOverMonth).toLocaleString();
  if ($('myEarnCodOutstanding')) $('myEarnCodOutstanding').textContent = 'Rs. ' + Math.round(outstanding).toLocaleString();

  const tbody = $('myEarningsDeliveriesBody');
  if (tbody) {
    const rows = [...delivered]
      .sort((a, b) => new Date(b.delivered_at || b.created_at || 0) - new Date(a.delivered_at || a.created_at || 0))
      .slice(0, 30);
    tbody.innerHTML = rows.length ? rows.map(o => {
      const pay = calculateDriverPay(o.delivery_km);
      const codText = isCollectedCod(o) ? ('Rs. ' + Number(o.cod_collected).toLocaleString()) : '—';
      const when = o.delivered_at ? new Date(o.delivered_at).toLocaleDateString() : (o.created_at ? new Date(o.created_at).toLocaleDateString() : '-');
      return `<tr>
        <td>${when}</td>
        <td>${o.order_ref_no || String(o.id).slice(0, 8)}</td>
        <td>${o.delivery_km ? Number(o.delivery_km).toFixed(1) + ' km' : '-'}</td>
        <td>Rs. ${Math.round(pay.pay).toLocaleString()}</td>
        <td>${codText}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="5" style="text-align:center;opacity:.5;padding:14px;">No completed deliveries yet.</td></tr>';
  }

  const htbody = $('myEarningsHandoverBody');
  if (htbody) {
    htbody.innerHTML = (driverHandovers || []).length ? driverHandovers.map(h => `<tr>
      <td>${h.created_at ? new Date(h.created_at).toLocaleString() : '-'}</td>
      <td>Rs. ${Number(h.amount || 0).toLocaleString()}</td>
      <td>${escapeHtmlSafe(h.note || '-')}</td>
    </tr>`).join('') : '<tr><td colspan="3" style="text-align:center;opacity:.5;padding:14px;">No cash handovers logged yet.</td></tr>';
  }
}
window.renderMyEarnings = renderMyEarnings;

async function submitCodHandover() {
  if (!currentUser || userRole !== 'driver') return;
  const amountInput = $('codHandoverAmount');
  const noteInput = $('codHandoverNote');
  const amount = Number(amountInput && amountInput.value);
  if (!(amount > 0)) { alert('Enter the amount you handed over (must be more than 0).'); return; }
  if (!businessId) { alert('Could not find your business owner — try logging out and back in.'); return; }
  if (!(await ensureFreshSession())) return;
  try {
    const { error } = await supabase.from('driver_cod_handovers').insert({
      driver_id: currentUser.id,
      owner_id: businessId,
      driver_name: (userProfile && userProfile.display_name) || null,
      amount,
      note: (noteInput && noteInput.value || '').trim() || null
    });
    if (error) throw error;
    if (amountInput) amountInput.value = '';
    if (noteInput) noteInput.value = '';
    updateStatus('✅ Handover logged');
    loadDriverHandovers();
  } catch (e) {
    console.error('Log handover error:', e);
    alert('❌ Could not log handover: ' + e.message + '\n\nMake sure the "driver_cod_handovers" table exists in Supabase (see setup notes).');
  }
}
window.submitCodHandover = submitCodHandover;

// ---- Batch selection state helpers ----

function toggleBatchSelect(orderId, checked) {
  const id = String(orderId);
  if (checked) batchSelectedIds.add(id); else batchSelectedIds.delete(id);
  updateBatchActionBar(); // just the count/bar — don't re-render the table mid-tick, or checkboxes would jump around
}
window.toggleBatchSelect = toggleBatchSelect;

function clearBatchSelection() {
  batchSelectedIds.clear();
  renderMyDeliveries();
}
window.clearBatchSelection = clearBatchSelection;

function updateBatchActionBar() {
  const bar = $('batchActionBar');
  if (!bar) return;
  const n = batchSelectedIds.size;
  if (n < 2) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  const countEl = $('batchSelectedCount');
  if (countEl) countEl.textContent = `${n} selected for batch delivery`;
}

// Groups the driver's currently out-for-delivery orders that have a known
// location (from the route optimizer's geocoding or a manually-set pin) into
// clusters of stops within `radiusKm` of each other, so the driver can select
// a whole cluster in one tap instead of ticking boxes one by one. Simple
// single-linkage clustering (union-find) — good enough for the small,
// same-area batches a delivery run actually has.
function computeNearbyGroups(radiusKm = 0.35) {
  const candidates = myDeliveries.filter(o => o.status === 'shipped' && o.delivery_lat != null && o.delivery_lng != null);
  const n = candidates.length;
  if (n < 2) return [];
  const parent = candidates.map((_, i) => i);
  function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
  function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (haversineKm(candidates[i].delivery_lat, candidates[i].delivery_lng, candidates[j].delivery_lat, candidates[j].delivery_lng) <= radiusKm) {
        union(i, j);
      }
    }
  }
  const groupsMap = {};
  candidates.forEach((o, i) => { const r = find(i); (groupsMap[r] = groupsMap[r] || []).push(o); });
  return Object.values(groupsMap).filter(g => g.length >= 2).sort((a, b) => b.length - a.length);
}

function renderBatchGroupsBar() {
  const bar = $('batchGroupsBar');
  if (!bar) return;
  batchGroupsCache = computeNearbyGroups();
  if (!batchGroupsCache.length) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
  bar.style.display = 'block';
  bar.innerHTML = `<div style="font-size:12px;font-weight:700;opacity:.7;margin-bottom:6px;"><i class="business-icon icon-inline" data-lucide="map-pin" aria-hidden="true"></i> Nearby stops — select a whole group in one tap:</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      ${batchGroupsCache.map((g, i) => `<button type="button" class="btn btn-sm" onclick="selectBatchGroup(${i})">${g.length} nearby — ${escapeHtmlSafe(g[0].address || g[0].customer_name_snapshot || 'stops')}</button>`).join('')}
    </div>`;
  if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } });
}

function selectBatchGroup(i) {
  const g = batchGroupsCache[i];
  if (!g) return;
  g.forEach(o => batchSelectedIds.add(String(o.id)));
  renderMyDeliveries();
}
window.selectBatchGroup = selectBatchGroup;

// Opens the batch confirmation modal for every currently-ticked, still-shipped order.
function openBatchDeliverModal() {
  if (userRole !== 'driver') return;
  const selected = myDeliveries.filter(o => batchSelectedIds.has(String(o.id)) && o.status === 'shipped');
  if (selected.length < 1) { alert('Tick at least one out-for-delivery order first.'); return; }
  batchDeliverPhotoFile = null;
  $('batchDeliverPhotoInput').value = '';
  $('batchDeliverPhotoPreview').style.display = 'none';
  $('batchDeliverTitle').textContent = `Confirm ${selected.length} Deliveries`;
  $('batchDeliverList').innerHTML = selected.map(o => {
    const isCod = (o.payment_method || 'cod') === 'cod';
    return `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #eee;">
      <div>
        <strong>${o.order_ref_no || String(o.id).slice(0,8)}</strong> — ${escapeHtmlSafe(o.customer_name_snapshot || 'Customer')}<br>
        <small style="opacity:.65;">${escapeHtmlSafe(o.address || '-')}</small>
      </div>
      ${isCod ? `<div class="input-prefix" style="width:120px;flex:none;"><span>Rs.</span><input type="number" min="0" step="1" id="batchCod_${o.id}" value="${Number(o.total || 0)}"></div>` : ''}
    </div>`;
  }).join('');
  $('batchDeliverModal').classList.add('active');
  setTimeout(() => { initSignaturePad('batchDeliverSignaturePad'); clearSignaturePad('batchDeliverSignaturePad'); }, 50);
  if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } });
}
window.openBatchDeliverModal = openBatchDeliverModal;

function handleBatchDeliveryPhotoChange(e) {
  const file = e.target.files && e.target.files[0];
  const preview = $('batchDeliverPhotoPreview');
  if (!file) { batchDeliverPhotoFile = null; if (preview) preview.style.display = 'none'; return; }
  batchDeliverPhotoFile = file;
  if (preview) { preview.src = URL.createObjectURL(file); preview.style.display = 'block'; }
}
window.handleBatchDeliveryPhotoChange = handleBatchDeliveryPhotoChange;

// Confirms every order that was selected when the modal was opened: one shared
// proof photo (and shared signature, if drawn) uploaded once, then each order
// updated with its own COD amount — mirroring confirmDelivery() but batched.
async function confirmBatchDelivery() {
  if (userRole !== 'driver') return;
  const selected = myDeliveries.filter(o => batchSelectedIds.has(String(o.id)) && o.status === 'shipped');
  if (!selected.length) { closeModal('batchDeliverModal'); return; }
  if (!batchDeliverPhotoFile) { alert('📷 A delivery photo is required before you can confirm.'); return; }
  const btn = $('batchDeliverConfirmBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Uploading...'; }
  if (!(await ensureFreshSession())) return;
  try {
    const ext = (batchDeliverPhotoFile.name && batchDeliverPhotoFile.name.includes('.')) ? batchDeliverPhotoFile.name.split('.').pop() : 'jpg';
    const path = `${businessId}/batch-${Date.now()}.${ext}`;
    const { error: upErr } = await supabase.storage.from('delivery-proofs').upload(path, batchDeliverPhotoFile, { upsert: true, contentType: batchDeliverPhotoFile.type || 'image/jpeg' });
    if (upErr) throw upErr;
    const { data: pub } = supabase.storage.from('delivery-proofs').getPublicUrl(path);
    const photoUrl = pub?.publicUrl || null;

    const signatureCanvas = $('batchDeliverSignaturePad');
    const signatureData = (sigHasStroke && signatureCanvas) ? signatureCanvas.toDataURL('image/png') : null;
    const deliveredAt = new Date().toISOString();

    const results = await Promise.all(selected.map(async (o) => {
      try {
        const isCod = (o.payment_method || 'cod') === 'cod';
        const codInput = isCod ? $('batchCod_' + o.id) : null;
        const codCollected = isCod ? (Number(codInput && codInput.value) || 0) : null;
        const update = {
          status: 'delivered',
          delivery_photo_url: photoUrl,
          delivery_signature: signatureData,
          cod_collected: codCollected,
          delivered_at: deliveredAt,
          rating_token: o.rating_token || genRatingToken()
        };
        // Same auto-distance lock-in as the single-order flow, in case the GPS-tracked trip is one of these stops.
        if (activeTrip && String(activeTrip.orderId) === String(o.id)) {
          update.delivery_km = Number(activeTrip.km.toFixed(2));
        }
        const { error } = await withSessionRetry(() => supabase.from('orders').update(update).eq('id', o.id).eq('assigned_driver_id', currentUser.id));
        if (error) throw error;
        finalizeDistributorCommissionForOrder(o.id, 'approved');
        if (activeTrip && String(activeTrip.orderId) === String(o.id)) activeTrip = null;
        Object.assign(o, update);
        return { id: o.id, ok: true };
      } catch (e) {
        console.error('Batch deliver error for order ' + o.id + ':', e);
        return { id: o.id, ok: false, message: e.message };
      }
    }));

    updateLiveTripKmUI();
    const okResults = results.filter(r => r.ok);
    const failed = results.filter(r => !r.ok);
    okResults.forEach(r => batchSelectedIds.delete(String(r.id))); // clear only the ones that succeeded; leave failures ticked for retry
    closeModal('batchDeliverModal');
    renderMyDeliveries();
    if (!failed.length) {
      updateStatus(`✅ ${okResults.length} deliveries confirmed with proof`);
    } else {
      updateStatus(`⚠️ ${okResults.length}/${selected.length} confirmed — ${failed.length} failed, still selected for retry`);
      alert('Some deliveries could not be confirmed:\n' + failed.map(f => `• Order ${f.id}: ${f.message}`).join('\n'));
    }
  } catch (e) {
    console.error('Confirm batch delivery error:', e);
    alert('❌ Could not upload the delivery photo: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="business-icon icon-inline" data-lucide="circle-check" aria-hidden="true"></i> Confirm All Delivered'; if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } }); }
  }
}
window.confirmBatchDelivery = confirmBatchDelivery;

// Builds the customer-facing "rate this delivery" link + WhatsApp message for
// an order (no login needed on the customer's end — see initPublicRatingPage,
// wired up on ?rate=&rt= at the top of DOMContentLoaded). Returns null if the
// order isn't found or doesn't have a rating token yet.
function buildRatingLinkInfo(orderId) {
  const o = (myDeliveries || []).find(x => String(x.id) === String(orderId))
    || (typeof orders !== 'undefined' ? orders.find(x => String(x.id) === String(orderId)) : null);
  if (!o) return null;
  const token = o.rating_token || o.ratingToken;
  if (!token) return null;
  const phone = o.customer_phone_snapshot || o.customerPhone || '';
  const name = o.customer_name_snapshot || o.customerName || 'Customer';
  const base = window.location.origin + window.location.pathname;
  const link = `${base}?rate=${encodeURIComponent(orderId)}&rt=${encodeURIComponent(token)}`;
  const msg = `Hi ${name}! 🙏 Thanks for your order — could you take 10 seconds to rate your delivery?\n${link}`;
  const digits = String(phone).replace(/\D/g, '');
  const waLink = digits ? ('https://wa.me/' + digits + '?text=' + encodeURIComponent(msg)) : ('https://wa.me/?text=' + encodeURIComponent(msg));
  return { order: o, orderId, name, phone, link, msg, waLink };
}

// Opens a pre-filled WhatsApp message to the customer with their personal
// rating link. opts.silent suppresses the "not ready yet" alert and the
// blocked-popup status message.
function shareDeliveryRatingLink(orderId, opts) {
  const silent = !!(opts && opts.silent);
  const info = buildRatingLinkInfo(orderId);
  if (!info) { if (!silent) alert('⭐ Rating link isn\'t ready for this delivery yet — try again in a moment.'); return false; }
  const win = window.open(info.waLink, '_blank');
  if (!win && !silent) {
    updateStatus('⚠️ Your browser blocked the WhatsApp popup — tap "Send Rating Link" to open it manually.');
  }
  return !!win;
}
window.shareDeliveryRatingLink = shareDeliveryRatingLink;

// ==================== RATING LINK MODAL (QR + WhatsApp, shown to the rider) ====================
// Shown right after a driver confirms a delivery, and from "Send Rating Link"
// in delivery history. Gives the rider two ways to get the customer's rating
// link into the customer's hands: a QR they can scan on the spot (no need for
// the customer's phone number / WhatsApp to be reachable), or the existing
// pre-filled WhatsApp message.
let ratingLinkModalOrderId = null;

function openRatingLinkModal(orderId) {
  const info = buildRatingLinkInfo(orderId);
  if (!info) { alert('⭐ Rating link isn\'t ready for this delivery yet — try again in a moment.'); return false; }
  ratingLinkModalOrderId = orderId;
  const label = info.order.order_ref_no || info.order.orderRefNo || String(orderId).slice(0, 8);
  $('ratingLinkOrderLabel').textContent = `${label} — ${info.name}`;
  $('ratingLinkQr').innerHTML = '';
  const img = document.createElement('img');
  img.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(info.link)}`;
  img.alt = 'Scan to rate this delivery';
  img.style.borderRadius = '8px';
  img.style.maxWidth = '100%';
  $('ratingLinkQr').appendChild(img);
  $('ratingLinkModal').classList.add('active');
  return true;
}
window.openRatingLinkModal = openRatingLinkModal;

function closeRatingLinkModal() {
  $('ratingLinkModal').classList.remove('active');
  ratingLinkModalOrderId = null;
}
window.closeRatingLinkModal = closeRatingLinkModal;

function sendRatingLinkFromModal() {
  if (!ratingLinkModalOrderId) return;
  shareDeliveryRatingLink(ratingLinkModalOrderId);
}
window.sendRatingLinkFromModal = sendRatingLinkFromModal;

async function copyRatingLinkFromModal() {
  if (!ratingLinkModalOrderId) return;
  const info = buildRatingLinkInfo(ratingLinkModalOrderId);
  if (!info) return;
  try {
    await navigator.clipboard.writeText(info.link);
    updateStatus('🔗 Rating link copied');
  } catch (e) {
    prompt('Copy this link:', info.link);
  }
}
window.copyRatingLinkFromModal = copyRatingLinkFromModal;

// ==================== AUTO DISTANCE (GPS-based km) ====================
// Replaces manual km entry for the driver: while a delivery is "shipped", GPS
// pings (from the location-sharing watch below) are summed into a running
// trip distance using the haversine formula, with basic noise/jump filtering.
let activeTrip = null; // { orderId, km, lastCoords }

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ==================== MULTI-STOP ROUTE OPTIMIZER ====================
// Free stack: OpenStreetMap Nominatim for geocoding (no API key), straight-line
// (haversine) nearest-neighbour ordering. This isn't turn-by-turn driving
// distance, but for a handful of same-area stops it gives a very good "visit
// these in this order" suggestion — and costs nothing to run.
// Requires two extra columns on the `orders` table: delivery_lat, delivery_lng
// (double precision, nullable) and route_sequence (integer, nullable).

async function geocodeAddress(address) {
  if (!address || !address.trim()) return null;
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=lk&q=${encodeURIComponent(address)}`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return null;
    const results = await res.json();
    if (!results || !results.length) return null;
    const lat = Number(results[0].lat), lng = Number(results[0].lon);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    return { lat, lng };
  } catch (e) {
    console.warn('Geocode error for address "' + address + '":', e.message);
    return null;
  }
}

// Geocodes and saves coordinates for one order if it doesn't have them yet.
// Mutates the order object in-place (delivery_lat/delivery_lng) on success.
async function ensureOrderGeocoded(order) {
  if (order.delivery_lat != null && order.delivery_lng != null) return true;
  if (!order.address) return false;
  const coords = await geocodeAddress(order.address);
  if (!coords) return false;
  order.delivery_lat = coords.lat;
  order.delivery_lng = coords.lng;
  try {
    await supabase.from('orders').update({ delivery_lat: coords.lat, delivery_lng: coords.lng }).eq('id', order.id);
  } catch (e) {
    console.warn('Could not save geocoded coordinates for order ' + order.id + ':', e.message);
  }
  return true;
}

function getDriverStartPosition() {
  // Every delivery run starts from the shop's pickup point (Drybea Market, or
  // whatever the owner has set via "Change Pickup Location") — not wherever the
  // driver's phone happens to be when they open the app. Route optimization
  // must plan from that fixed origin so the suggested stop order matches the
  // real route the driver actually drives, starting from pickup.
  return Promise.resolve(getPickupLocation());
}

// Greedy nearest-neighbour: starting from `start`, repeatedly visit whichever
// remaining stop is closest to the current position. Simple, fast, and in
// practice close to optimal for the small (3-4 stop) batches drivers here
// actually carry.
function nearestNeighbourOrder(start, stops) {
  const remaining = stops.slice();
  const route = [];
  let current = start;
  while (remaining.length) {
    let bestIdx = 0, bestDist = Infinity;
    remaining.forEach((s, idx) => {
      const d = current ? haversineKm(current.lat, current.lng, s.delivery_lat, s.delivery_lng) : 0;
      if (d < bestDist) { bestDist = d; bestIdx = idx; }
    });
    const next = remaining.splice(bestIdx, 1)[0];
    route.push(next);
    current = { lat: next.delivery_lat, lng: next.delivery_lng };
  }
  return route;
}

function routeDistanceKm(start, stopsInOrder) {
  let total = 0, current = start;
  stopsInOrder.forEach(s => {
    if (current) total += haversineKm(current.lat, current.lng, s.delivery_lat, s.delivery_lng);
    current = { lat: s.delivery_lat, lng: s.delivery_lng };
  });
  return total;
}

async function optimizeDeliveryRoute() {
  if (userRole !== 'driver') return;
  if (!(await ensureFreshSession())) return;
  const btn = $('optimizeRouteBtn');
  const status = $('routeOptimizeStatus');
  const active = myDeliveries.filter(o => o.status === 'pending' || o.status === 'shipped');
  if (active.length < 2) {
    if (status) status.textContent = 'Need at least 2 active deliveries to optimize.';
    return;
  }
  if (btn) btn.disabled = true;
  if (status) status.textContent = '📍 Locating your stops…';

  // Geocode any stops that don't have coordinates yet. Sequential with a small
  // delay to stay within Nominatim's fair-use rate limit (max ~1 request/sec).
  const missing = active.filter(o => o.delivery_lat == null || o.delivery_lng == null);
  for (const o of missing) {
    await ensureOrderGeocoded(o);
    await new Promise(r => setTimeout(r, 1100));
  }

  const locatable = active.filter(o => o.delivery_lat != null && o.delivery_lng != null);
  const unlocatable = active.filter(o => o.delivery_lat == null || o.delivery_lng == null);
  if (locatable.length < 2) {
    if (status) status.textContent = '⚠️ Could not locate enough addresses to optimize (check they include a city/area name).';
    if (btn) btn.disabled = false;
    return;
  }

  if (status) status.textContent = '🧭 Calculating best order…';
  const start = await getDriverStartPosition();

  const naiveDistance = routeDistanceKm(start, locatable);
  const optimized = nearestNeighbourOrder(start, locatable);
  const optimizedDistance = routeDistanceKm(start, optimized);

  // Persist the new order so it survives a refresh, and so the owner's view
  // (if ever extended to show it) stays in sync.
  let seq = 1;
  const updates = optimized.map(o => {
    const mySeq = seq++;
    o.route_sequence = mySeq;
    return supabase.from('orders').update({ route_sequence: mySeq }).eq('id', o.id);
  });
  // Unlocatable stops go to the end, in their existing order, so nothing gets lost.
  unlocatable.forEach(o => { o.route_sequence = seq++; });
  try { await Promise.all(updates); } catch (e) { console.warn('Save route order error:', e); }

  renderMyDeliveries();
  if (btn) btn.disabled = false;
  const saved = naiveDistance - optimizedDistance;
  if (status) {
    status.textContent = saved > 0.05
      ? `✅ Route optimized — about ${saved.toFixed(1)} km less driving than the original order.`
      : '✅ Route optimized.';
  }
  updateStatus('🗺️ Delivery route optimized');
}
window.optimizeDeliveryRoute = optimizeDeliveryRoute;

// ==================== ADDRESS PIN-DROP ON MAP ====================
// Backup/override for geocoded coordinates: the driver, standing at the real
// address, drops (or drags) a pin on a Leaflet map to lock in the exact
// delivery_lat/delivery_lng. This is more reliable than text-address geocoding
// (which can miss rural/informal addresses entirely) and feeds straight into
// the Route Optimizer distances and the delivery geofence alert.
let setPinOrderId = null;
let setPinMap = null;
let setPinMarker = null;

function openSetPinModal(orderId) {
  if (userRole !== 'driver') return;
  const o = myDeliveries.find(x => String(x.id) === String(orderId));
  if (!o) return;
  setPinOrderId = orderId;
  $('setPinOrderLabel').textContent = (o.order_ref_no || String(o.id).slice(0, 8)) + ' — ' + (o.address || 'No address text on file');
  $('setPinModal').classList.add('active');
  // Leaflet needs the container visible before it can measure it correctly, so
  // build/refresh the map on the next tick, once the modal has actually shown.
  setTimeout(() => initSetPinMap(o), 50);
}
window.openSetPinModal = openSetPinModal;

function initSetPinMap(order) {
  const el = document.getElementById('setPinMap');
  if (!el || typeof L === 'undefined') return;
  const startLat = order.delivery_lat != null ? order.delivery_lat : (driverLastCoords ? driverLastCoords.lat : 7.8731);
  const startLng = order.delivery_lng != null ? order.delivery_lng : (driverLastCoords ? driverLastCoords.lng : 80.7718);
  const startZoom = order.delivery_lat != null ? 16 : (driverLastCoords ? 15 : 8);
  if (!setPinMap) {
    setPinMap = L.map(el).setView([startLat, startLng], startZoom);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(setPinMap);
    setPinMap.on('click', (e) => placeSetPinMarker(e.latlng.lat, e.latlng.lng));
  } else {
    setPinMap.setView([startLat, startLng], startZoom);
  }
  setTimeout(() => setPinMap && setPinMap.invalidateSize(), 60);
  if (order.delivery_lat != null && order.delivery_lng != null) {
    placeSetPinMarker(order.delivery_lat, order.delivery_lng);
  } else if (setPinMarker) {
    setPinMap.removeLayer(setPinMarker);
    setPinMarker = null;
    updateSetPinCoordsLabel(null);
  } else {
    updateSetPinCoordsLabel(null);
  }
}

function placeSetPinMarker(lat, lng) {
  if (!setPinMap) return;
  if (setPinMarker) {
    setPinMarker.setLatLng([lat, lng]);
  } else {
    setPinMarker = L.marker([lat, lng], { draggable: true }).addTo(setPinMap);
    setPinMarker.on('dragend', () => {
      const p = setPinMarker.getLatLng();
      updateSetPinCoordsLabel(p);
    });
  }
  updateSetPinCoordsLabel({ lat, lng });
}

function updateSetPinCoordsLabel(latlng) {
  const label = $('setPinCoordsLabel');
  if (!label) return;
  label.textContent = latlng ? `📍 ${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}` : 'Tap the map to drop a pin';
}

function usePinMyLocation() {
  if (!navigator.geolocation) { alert('Location is not supported on this device/browser.'); return; }
  const label = $('setPinCoordsLabel');
  if (label) label.textContent = '📍 Getting your current location…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      if (setPinMap) setPinMap.setView([latitude, longitude], 17);
      placeSetPinMarker(latitude, longitude);
    },
    (err) => { if (label) label.textContent = '⚠️ Could not get your location: ' + err.message; },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
}
window.usePinMyLocation = usePinMyLocation;

async function saveSetPinLocation() {
  if (!setPinOrderId || !setPinMarker) { alert('📍 Tap the map (or use "Use My Current Location") to drop a pin first.'); return; }
  const { lat, lng } = setPinMarker.getLatLng();
  if (!(await ensureFreshSession())) return;
  try {
    const { error } = await supabase.from('orders')
      .update({ delivery_lat: lat, delivery_lng: lng })
      .eq('id', setPinOrderId).eq('assigned_driver_id', currentUser.id);
    if (error) throw error;
    const o = myDeliveries.find(x => String(x.id) === String(setPinOrderId));
    if (o) { o.delivery_lat = lat; o.delivery_lng = lng; }
    // An exact pin overrides any earlier optimizer ordering built on a rougher
    // geocode — clear the saved sequence so the driver knows to re-optimize.
    if (o) o.route_sequence = null;
    closeModal('setPinModal');
    renderMyDeliveries();
    updateStatus('📍 Delivery pin saved');
  } catch (e) {
    console.error('Save pin error:', e);
    alert('❌ Could not save the pin: ' + e.message + '\n\nMake sure the delivery_lat/delivery_lng columns exist on the orders table.');
  }
}
window.saveSetPinLocation = saveSetPinLocation;

function updateLiveTripKmUI() {
  const el = $('liveTripKm');
  if (!el) return;
  el.textContent = activeTrip ? `📏 Auto-tracking trip: ${activeTrip.km.toFixed(2)} km so far` : '';
}

async function driverMarkStatus(orderId, newStatus) {
  if (userRole !== 'driver') return;
  if (!(await ensureFreshSession())) return;
  try {
    const update = { status: newStatus };
    // Stamp the moment the trip actually starts — this is what the owner's
    // Delivery Performance dashboard uses for on-time % and average delivery time.
    if (newStatus === 'shipped') update.shipped_at = new Date().toISOString();
    const { error } = await withSessionRetry(() => supabase.from('orders')
      .update(update)
      .eq('id', orderId).eq('assigned_driver_id', currentUser.id));
    if (error) throw error;
    const o = myDeliveries.find(x => String(x.id) === String(orderId));
    if (o) Object.assign(o, update);
    if (newStatus === 'shipped') {
      // FIX: previously this reused whatever driverLastCoords happened to be —
      // which could be several minutes old, left over from a PREVIOUS delivery,
      // or simply null if location sharing hadn't sent a ping yet. That made
      // the trip's starting point wrong, which threw off every km reading that
      // followed. Now we grab a fresh, high-accuracy GPS fix at the exact
      // moment "Start Delivery" is tapped, so the trip always starts from
      // wherever the driver actually is right now.
      activeTrip = { orderId, km: 0, lastCoords: null };
      updateLiveTripKmUI();
      if (!driverLocationSharing) startDriverLocationSharing(); // needed so GPS pings actually flow in
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            // Only apply if this is still the active trip (driver hasn't already moved on to another one).
            if (activeTrip && String(activeTrip.orderId) === String(orderId) && !activeTrip.lastCoords) {
              activeTrip.lastCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
              driverLastCoords = activeTrip.lastCoords;
            }
          },
          (err) => console.warn('Could not get a fresh start location, will use the first GPS ping instead:', err.message),
          { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
        );
      }
    }
    renderMyDeliveries();
    // A driver marking the order delivered is a real delivery just like the
    // owner doing it via cycleStatus()/confirmDelivery()/confirmBatchDelivery()
    // — all three of those finalize the pending distributor commission claim
    // to 'approved' on delivery. This path was missing that call, so any
    // order delivered by a driver left its distributor commission stuck on
    // 'pending' forever and it never showed up as real commission anywhere.
    if (newStatus === 'delivered') finalizeDistributorCommissionForOrder(orderId, 'approved');
    updateStatus(newStatus === 'delivered' ? '✅ Marked delivered' : '🚚 Delivery started — auto-tracking distance');
  } catch (e) {
    console.error('Driver status update error:', e);
    alert('❌ Could not update delivery status: ' + e.message + '\n\nMake sure the "shipped_at" column exists on the orders table (see setup notes).');
  }
}
window.driverMarkStatus = driverMarkStatus;

// ==================== DRIVER: PROOF OF DELIVERY / COD / FAILED DELIVERY ====================
let deliverModalOrderId = null;
let deliverPhotoFile = null;
let sigCtx = null, sigDrawing = false, sigHasStroke = false;

function initSignaturePad(canvasId) {
  const canvas = $(canvasId || 'deliverSignaturePad');
  if (!canvas || canvas.__wired) return;
  canvas.__wired = true;
  sigCtx = canvas.getContext('2d');
  sigCtx.lineWidth = 2.2;
  sigCtx.lineCap = 'round';
  sigCtx.strokeStyle = '#1a1a1a';
  const posFromEvent = (e) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width, scaleY = canvas.height / rect.height;
    const point = e.touches ? e.touches[0] : e;
    return { x: (point.clientX - rect.left) * scaleX, y: (point.clientY - rect.top) * scaleY };
  };
  const start = (e) => { sigDrawing = true; sigHasStroke = true; const p = posFromEvent(e); sigCtx.beginPath(); sigCtx.moveTo(p.x, p.y); e.preventDefault(); };
  const move = (e) => { if (!sigDrawing) return; const p = posFromEvent(e); sigCtx.lineTo(p.x, p.y); sigCtx.stroke(); e.preventDefault(); };
  const end = () => { sigDrawing = false; };
  canvas.addEventListener('mousedown', start); canvas.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  canvas.addEventListener('touchstart', start, { passive: false }); canvas.addEventListener('touchmove', move, { passive: false });
  canvas.addEventListener('touchend', end);
}

function clearSignaturePad(canvasId) {
  const canvas = $(canvasId || 'deliverSignaturePad');
  if (!canvas || !sigCtx) return;
  sigCtx.clearRect(0, 0, canvas.width, canvas.height);
  sigHasStroke = false;
}
window.clearSignaturePad = clearSignaturePad;

function handleDeliveryPhotoChange(e) {
  const file = e.target.files && e.target.files[0];
  const preview = $('deliverPhotoPreview');
  if (!file) { deliverPhotoFile = null; if (preview) preview.style.display = 'none'; return; }
  deliverPhotoFile = file;
  if (preview) {
    preview.src = URL.createObjectURL(file);
    preview.style.display = 'block';
  }
}
window.handleDeliveryPhotoChange = handleDeliveryPhotoChange;

function openDeliverModal(orderId) {
  const o = myDeliveries.find(x => String(x.id) === String(orderId));
  if (!o) return;
  deliverModalOrderId = orderId;
  deliverPhotoFile = null;
  $('deliverPhotoInput').value = '';
  $('deliverPhotoPreview').style.display = 'none';
  $('deliverConfirmOrderLabel').textContent = `Order ${o.order_ref_no || String(o.id).slice(0,8)} — ${o.customer_name_snapshot || 'Customer'}`;
  const isCod = (o.payment_method || 'cod') === 'cod';
  $('deliverCodSection').style.display = isCod ? '' : 'none';
  if (isCod) $('deliverCodAmount').value = Number(o.total || 0);
  $('deliverConfirmModal').classList.add('active');
  setTimeout(() => { initSignaturePad(); clearSignaturePad(); }, 50);
  if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } });
}
window.openDeliverModal = openDeliverModal;

// Short random token used in the public rating link (?rate=orderId&rt=token).
// Doesn't need to be a full UUID — just unguessable enough that a stranger
// can't rate someone else's delivery by trying random order ids.
function genRatingToken() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID().replace(/-/g, '');
  return Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}

async function confirmDelivery() {
  if (userRole !== 'driver' || !deliverModalOrderId) return;
  if (!deliverPhotoFile) { alert('📷 A delivery photo is required before you can confirm.'); return; }
  const o = myDeliveries.find(x => String(x.id) === String(deliverModalOrderId));
  if (!o) return;
  const btn = $('deliverConfirmBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Uploading...'; }
  if (!(await ensureFreshSession())) return;
  try {
    const ext = (deliverPhotoFile.name && deliverPhotoFile.name.includes('.')) ? deliverPhotoFile.name.split('.').pop() : 'jpg';
    const path = `${businessId}/${o.id}-${Date.now()}.${ext}`;
    const { error: upErr } = await supabase.storage.from('delivery-proofs').upload(path, deliverPhotoFile, { upsert: true, contentType: deliverPhotoFile.type || 'image/jpeg' });
    if (upErr) throw upErr;
    const { data: pub } = supabase.storage.from('delivery-proofs').getPublicUrl(path);
    const photoUrl = pub?.publicUrl || null;

    const signatureCanvas = $('deliverSignaturePad');
    const signatureData = (sigHasStroke && signatureCanvas) ? signatureCanvas.toDataURL('image/png') : null;

    const isCod = (o.payment_method || 'cod') === 'cod';
    const codCollected = isCod ? (Number($('deliverCodAmount').value) || 0) : null;

    const update = {
      status: 'delivered',
      delivery_photo_url: photoUrl,
      delivery_signature: signatureData,
      cod_collected: codCollected,
      delivered_at: new Date().toISOString(),
      rating_token: o.rating_token || genRatingToken() // lets us send a "rate your delivery" link afterwards
    };
    // Auto-distance: if this order's trip was being GPS-tracked, lock in the final figure.
    if (activeTrip && String(activeTrip.orderId) === String(o.id)) {
      update.delivery_km = Number(activeTrip.km.toFixed(2));
    }
    const { error } = await withSessionRetry(() => supabase.from('orders').update(update).eq('id', o.id).eq('assigned_driver_id', currentUser.id));
    if (error) throw error;
    finalizeDistributorCommissionForOrder(o.id, 'approved');

    if (activeTrip && String(activeTrip.orderId) === String(o.id)) { activeTrip = null; updateLiveTripKmUI(); }
    Object.assign(o, update);
    closeModal('deliverConfirmModal');
    renderMyDeliveries();
    updateStatus('✅ Delivery confirmed with proof'
      + (isCod ? ` • Rs. ${codCollected.toLocaleString()} collected` : ''));
    // Straight after confirming, show the rider a QR + WhatsApp option to get
    // the customer's rating link across — QR works even if WhatsApp/the
    // customer's number isn't reachable right now.
    openRatingLinkModal(o.id);
  } catch (e) {
    console.error('Confirm delivery error:', e);
    alert('❌ Could not confirm delivery: ' + e.message + '\n\nMake sure the delivery-proofs storage bucket and the delivery_photo_url / delivery_signature / cod_collected / delivered_at / rating_token columns exist (see setup notes).');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="business-icon icon-inline" data-lucide="circle-check" aria-hidden="true"></i> Confirm Delivered'; if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } }); }
  }
}
window.confirmDelivery = confirmDelivery;

function openFailedModal(orderId) {
  const o = myDeliveries.find(x => String(x.id) === String(orderId));
  if (!o) return;
  deliverModalOrderId = orderId;
  $('deliverFailedReason').value = '';
  $('deliverFailedNotes').value = '';
  $('deliverFailedOrderLabel').textContent = `Order ${o.order_ref_no || String(o.id).slice(0,8)} — ${o.customer_name_snapshot || 'Customer'}`;
  $('deliverFailedModal').classList.add('active');
}
window.openFailedModal = openFailedModal;

async function confirmFailedDelivery() {
  if (userRole !== 'driver' || !deliverModalOrderId) return;
  const reason = $('deliverFailedReason').value;
  if (!reason) { alert('Please select a reason.'); return; }
  const notes = $('deliverFailedNotes').value.trim();
  const o = myDeliveries.find(x => String(x.id) === String(deliverModalOrderId));
  if (!o) return;
  if (!(await ensureFreshSession())) return;
  try {
    const update = { status: 'failed', failed_reason: reason, failed_notes: notes, failed_at: new Date().toISOString() };
    const { error } = await supabase.from('orders').update(update).eq('id', o.id).eq('assigned_driver_id', currentUser.id);
    if (error) throw error;
    Object.assign(o, update);
    closeModal('deliverFailedModal');
    renderMyDeliveries();
    updateStatus('⚠️ Delivery issue reported');
  } catch (e) {
    console.error('Report failed delivery error:', e);
    alert('❌ Could not report the issue: ' + e.message + '\n\nMake sure the failed_reason / failed_notes / failed_at columns exist on the orders table (see setup notes).');
  }
}
window.confirmFailedDelivery = confirmFailedDelivery;

// ==================== OWNER: VIEW PROOF / RESCHEDULE ====================
function viewDeliveryProof(index) {
  const order = orders[index];
  if (!order) return;
  $('proofOrderLabel').textContent = `Order ${order.orderRefNo || order.id} — ${order.customerName || getCustomerName(order.customerId)}`;
  const isCod = (order.paymentMethod || 'cod') === 'cod';
  const codLine = isCod
    ? `<div class="field"><label>Cash Collected</label><div style="font-weight:800;font-size:1.05rem;">${order.codCollected != null ? fmt(order.codCollected) : '<span style="opacity:.5;">Not recorded</span>'} <span style="opacity:.5;font-weight:400;">/ order total ${fmt(order.total)}</span></div></div>`
    : '';
  const photoBlock = order.deliveryPhotoUrl
    ? `<div class="field"><label>Delivery Photo</label><img src="${order.deliveryPhotoUrl}" style="max-width:100%;max-height:320px;border-radius:10px;border:1px solid #ddd;"></div>`
    : '<div class="field"><label>Delivery Photo</label><small style="opacity:.5;">No photo on file.</small></div>';
  const sigBlock = order.deliverySignature
    ? `<div class="field"><label>Customer Signature</label><img src="${order.deliverySignature}" style="max-width:100%;max-height:150px;border:1px solid #ddd;border-radius:10px;background:#fff;"></div>`
    : '';
  const failedBlock = order.status === 'failed'
    ? `<div class="notice warn" style="margin-top:10px;"><strong>Delivery failed:</strong> ${escapeHtmlSafe(order.failedReason||'')}${order.failedNotes ? ' — '+escapeHtmlSafe(order.failedNotes) : ''}</div>`
    : '';
  $('proofContent').innerHTML = codLine + photoBlock + sigBlock + failedBlock;
  $('deliveryProofModal').classList.add('active');
}
window.viewDeliveryProof = viewDeliveryProof;

async function rescheduleFailedOrder(index) {
  if (userRole !== 'owner') return;
  const order = orders[index];
  if (!order || order.status !== 'failed') return;
  if (!confirm('Reschedule this order? It will go back to Pending for the assigned driver.')) return;
  if (!(await ensureFreshSession())) return;
  try {
    const { error } = await supabase.from('orders').update({ status: 'pending', failed_reason: null, failed_notes: null }).eq('id', order.id).eq('user_id', businessId);
    if (error) throw error;
    order.status = 'pending'; order.failedReason = null; order.failedNotes = null;
    saveOrders(); renderOrders(); updateOrderStats();
    updateStatus('🔄 Order rescheduled to Pending');
  } catch (e) {
    console.error('Reschedule order error:', e);
    alert('❌ Could not reschedule order: ' + e.message);
  }
}
window.rescheduleFailedOrder = rescheduleFailedOrder;

let driverDeliveriesChannel = null;
function startDriverDeliveriesRealtime() {
  if (!currentUser || userRole !== 'driver' || driverDeliveriesChannel) return;
  driverDeliveriesChannel = supabase
    .channel('driver-deliveries-' + currentUser.id)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'orders', filter: `assigned_driver_id=eq.${currentUser.id}`
    }, (payload) => {
      const wasAssignedBefore = payload.old && String(payload.old.assigned_driver_id || '') === String(currentUser.id);
      const isNewAssignment = payload.eventType === 'INSERT' || (payload.eventType === 'UPDATE' && !wasAssignedBefore);
      if (isNewAssignment && payload.new) notifyDriverNewDelivery(payload.new);
      loadMyDeliveries();
    })
    .subscribe();
}

// In-app toast (always) + native browser notification (if the driver granted
// permission) whenever a new order lands on this driver's list — the closest
// thing to a phone push notification this stack can do without a backend.
function notifyDriverNewDelivery(o) {
  const label = o.order_ref_no || String(o.id || '').slice(0, 8);
  const addr = o.address || '';
  showAppNotification('🚚 New Delivery Assigned', `${label} — ${addr || 'Check My Deliveries'}`, 'info', {
    tab: 'my-deliveries',
    details: [
      { label: 'Order', value: label },
      { label: 'Address', value: addr || '-' },
      { label: 'Total', value: 'Rs. ' + Number(o.total || 0).toLocaleString() }
    ]
  });
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      const n = new Notification('🚚 New delivery assigned', { body: `${label} — ${addr || 'Open the app to see it'}`, tag: 'delivery-' + o.id });
      n.onclick = () => { window.focus(); n.close(); };
    } catch (e) { console.warn('Native notification failed:', e); }
  }
}

// Lets the driver opt in to native browser notifications (so alerts still show
// up even if the app tab is in the background). Wired to a button on My Deliveries.
function requestDriverNotifyPermission() {
  if (typeof Notification === 'undefined') { alert('Notifications are not supported on this device/browser.'); return; }
  Notification.requestPermission().then(perm => {
    updateDriverNotifyPermUI();
    if (perm === 'granted') updateStatus('🔔 Delivery alerts enabled');
    else if (perm === 'denied') updateStatus('🔕 Notifications blocked — enable them in your browser/site settings to get alerts');
  });
}
window.requestDriverNotifyPermission = requestDriverNotifyPermission;

function updateDriverNotifyPermUI() {
  const btn = $('driverNotifyPermBtn');
  if (!btn) return;
  if (typeof Notification === 'undefined') { btn.style.display = 'none'; return; }
  const granted = Notification.permission === 'granted';
  btn.innerHTML = granted
    ? '<i class="business-icon icon-inline" data-lucide="bell-ring" aria-hidden="true"></i> Delivery Alerts: On'
    : '<i class="business-icon icon-inline" data-lucide="bell" aria-hidden="true"></i> Enable Delivery Alerts';
  btn.classList.toggle('btn-primary', granted);
  if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } });
}

// ==================== LIVE DRIVER LOCATION TRACKING ====================
// Free stack: OpenStreetMap tiles + Leaflet.js (no API key), Supabase Realtime for live pins,
// with a polling fallback in case Realtime replication isn't enabled for driver_locations.

// ---- Owner side: live map of all sharing drivers ----
let ownerDriverMap = null;
let ownerDriverMarkers = {};
let ownerDriverAccuracyCircles = {};
let ownerPickupMarker = null;
let ownerDriverLocationsChannel = null;
let driverLocationPollTimer = null;
let driverLocationFreshness = {}; // driver_id -> last-updated timestamp (ms)
let driverShiftDataCache = {}; // driver_id -> { shiftStartAt: iso|null, activeSeconds: number } — see "daily working %" below
let ownerDriverMapLastFitKey = null; // which set of markers the map was last auto-fitted to (see BUG FIX below)
const DRIVER_ONLINE_THRESHOLD_MS = 90 * 1000; // no ping in 90s = treated as offline/stale on the map

// ---- Breadcrumb trail: the ACTUAL path a driver has driven, from their real GPS
// fixes, instead of a straight guessed line. No routing service, so it can never
// be "wrong" the way a road-snapped line could be with a bad geocode — it's
// literally just where the phone has been. Built client-side from every location
// update the owner's map receives, so it needs no schema change and starts fresh
// each time the owner opens the map (older history isn't stored/replayed).
let ownerDriverBreadcrumbs = {}; // driver_id -> [[lat,lng], ...]
const BREADCRUMB_MIN_MOVE_M = 20;   // ignore GPS jitter under this distance so the trail stays clean
const BREADCRUMB_MAX_POINTS = 400;  // cap memory/rendering cost per driver
const DRIVER_ROUTE_COLORS = ['#2563eb', '#dc2626', '#059669', '#7c3aed', '#ea580c', '#0891b2', '#db2777'];
function colorForDriver(driverId) {
  const idx = driverListCache.findIndex(d => String(d.id) === String(driverId));
  return DRIVER_ROUTE_COLORS[(idx >= 0 ? idx : 0) % DRIVER_ROUTE_COLORS.length];
}

function initOwnerDriverMap() {
  if (userRole !== 'owner') return;
  const el = document.getElementById('ownerDriverMap');
  if (!el || typeof L === 'undefined') return;
  const pickup = getPickupLocation();
  if (!ownerDriverMap) {
    ownerDriverMap = L.map(el, { zoomControl: true }).setView([pickup.lat, pickup.lng], 11); // default: centered on the pickup point
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(ownerDriverMap);
    // Pickup marker — always shown, doesn't depend on any driver being online.
    // Position/label refresh automatically if the owner changes it later (see
    // updateOwnerPickupMarker), no need to recreate the map.
    ownerPickupMarker = L.circleMarker([pickup.lat, pickup.lng], {
      radius: 9, color: '#b45309', weight: 3, fillColor: '#f59e0b', fillOpacity: 0.9
    }).addTo(ownerDriverMap).bindPopup(`<strong>🏭 ${escapeHtmlSafe(pickup.name)}</strong><br><small>Pickup point for every delivery</small>`);
    startOwnerDriverLocationsRealtime();
  }
  // FIX: the map container sits inside a tab-panel that's display:none whenever this tab
  // isn't active. Leaflet measures the container's size at creation time, so if that size
  // was 0 (hidden), the map renders grey/broken tiles until told to recompute. Previously
  // this recompute only ran once, on first init — so returning to this tab later (after the
  // very first paint) could leave the map stuck broken. Now it re-runs every time the tab
  // opens, not just the first time.
  setTimeout(() => ownerDriverMap && ownerDriverMap.invalidateSize(), 150);
}

// ==================== DELIVERY HEATMAP ====================
// Plots every geocoded delivery address (from Route Optimizer or a driver's
// manual pin-drop) as a density heatmap, so the owner can see which areas
// generate the most orders — useful for driver allocation and zone pricing.
let deliveryHeatmapMap = null, deliveryHeatmapLayer = null;

function initDeliveryHeatmap() {
  if (userRole !== 'owner') return;
  const el = document.getElementById('deliveryHeatmapMap');
  const note = $('deliveryHeatmapNote');
  if (!el || typeof L === 'undefined' || typeof L.heatLayer !== 'function') return;
  const pickup = getPickupLocation();
  if (!deliveryHeatmapMap) {
    deliveryHeatmapMap = L.map(el).setView([pickup.lat, pickup.lng], 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(deliveryHeatmapMap);
  }
  setTimeout(() => deliveryHeatmapMap && deliveryHeatmapMap.invalidateSize(), 150);

  const points = (orders || [])
    .filter(o => o.status !== 'cancelled' && o.deliveryLat != null && o.deliveryLng != null)
    .map(o => [o.deliveryLat, o.deliveryLng, 1]);

  if (deliveryHeatmapLayer) { deliveryHeatmapMap.removeLayer(deliveryHeatmapLayer); deliveryHeatmapLayer = null; }
  if (points.length) {
    deliveryHeatmapLayer = L.heatLayer(points, { radius: 28, blur: 20, maxZoom: 15 }).addTo(deliveryHeatmapMap);
  }
  if (note) {
    note.textContent = points.length
      ? `Showing ${points.length} geocoded delivery location${points.length === 1 ? '' : 's'}.`
      : 'No geocoded delivery locations yet — coordinates are captured when a driver runs "Optimize Route" or drops a pin on an address.';
  }
}
window.initDeliveryHeatmap = initDeliveryHeatmap;

function startDriverLocationPolling() {
  if (driverLocationPollTimer || userRole !== 'owner') return;
  // FIX: don't rely on Supabase Realtime alone — if replication isn't turned on for the
  // driver_locations table (a common setup step people forget), the realtime channel
  // subscribes successfully but never actually fires, and the map silently goes stale.
  // Polling every 15s guarantees the map keeps updating either way.
  driverLocationPollTimer = setInterval(loadDriverLocations, 15000);
}

async function loadDriverLocations() {
  if (userRole !== 'owner' || !currentUser) return;
  // Same fix as the pickup-location save: this runs on a 15s timer for as long as
  // the owner leaves the Delivery tab open, so it's exactly the kind of call that
  // hits an access token that expired quietly in the background. Confirm/refresh
  // the session before the query instead of letting it fail with a raw JWT error
  // every single poll.
  if (!(await ensureFreshSession())) return;
  try {
    const { data, error } = await supabase.from('driver_locations').select('*').eq('owner_id', currentUser.id);
    if (error) throw error;
    renderOwnerDriverMarkers(data || []);
  } catch (e) {
    console.error('Load driver locations error:', e);
    const countEl = $('liveMapDriverCount');
    if (countEl) {
      countEl.textContent = /jwt|expired|not authenticated|401/i.test(e.message || '')
        ? '⚠️ Session expired — refreshing…' // ensureFreshSession() will catch this on the next poll and redirect if it truly can't recover
        : '⚠️ Could not load driver locations: ' + e.message;
    }
  }
}
window.loadDriverLocations = loadDriverLocations;

function renderOwnerDriverMarkers(rows) {
  if (!ownerDriverMap) return;
  const seenAny = new Set();
  const seenOnline = new Set();
  const now = Date.now();
  (rows || []).forEach(r => {
    if (r.latitude == null || r.longitude == null) return;
    const id = String(r.driver_id);
    seenAny.add(id);
    const updatedMs = r.updated_at ? new Date(r.updated_at).getTime() : 0;
    driverLocationFreshness[id] = updatedMs;
    const isFresh = (now - updatedMs) < DRIVER_ONLINE_THRESHOLD_MS;
    if (isFresh) seenOnline.add(id);
    const driver = driverListCache.find(d => String(d.id) === id);
    const label = (driver && driver.display_name) || 'Driver';
    const ago = updatedMs ? Math.max(0, Math.round((now - updatedMs) / 1000)) : null;
    const agoTxt = ago == null ? 'unknown' : (ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`);
    // Accuracy comes straight from the driver's phone GPS (metres of uncertainty).
    // A pin that looks "wrong" is very often just a low-accuracy fix (Wi-Fi/cell
    // location instead of true GPS) rather than a bug — showing the radius and a
    // plain-language note makes that obvious instead of leaving the owner to guess.
    const acc = (r.accuracy != null && isFinite(r.accuracy)) ? Math.round(r.accuracy) : null;
    const accNote = acc == null ? '' : (acc > 300
      ? `<br><small style="color:#c0392b;">⚠️ Weak signal — accurate to ~${acc}m, pin may be off</small>`
      : `<br><small style="opacity:.6;">Accurate to ~${acc}m</small>`);
    const popupHtml = `<strong>${escapeHtmlSafe(label)}</strong><br><small>${isFresh ? '🟢 Live' : '⚪ Stale'} — updated ${agoTxt}</small>${accNote}`;
    if (ownerDriverMarkers[id]) {
      ownerDriverMarkers[id].setLatLng([r.latitude, r.longitude]).setPopupContent(popupHtml);
      ownerDriverMarkers[id].setOpacity(isFresh ? 1 : 0.45);
    } else {
      ownerDriverMarkers[id] = L.marker([r.latitude, r.longitude], { opacity: isFresh ? 1 : 0.45 }).addTo(ownerDriverMap).bindPopup(popupHtml);
    }
    // Cache the driver's daily working-% inputs (see driverSendLocation) so
    // renderDeliveryDriverStats() can show it without a second query.
    if (isFresh) driverShiftDataCache[id] = { shiftStartAt: r.shift_start_at || null, activeSeconds: Number(r.active_seconds_today) || 0 };
    // Only extend the breadcrumb trail for a fresh fix — a stale/offline reading
    // is the driver's last known spot, not a new point they've actually reached.
    if (isFresh) appendBreadcrumbPoint(id, r.latitude, r.longitude);
    // Draw/update the accuracy circle only when it's actually worth showing (a
    // tight GPS fix under ~30m would just clutter the map with a barely-visible
    // ring) and only for live drivers, so stale circles don't linger.
    if (acc != null && acc > 30 && isFresh) {
      if (ownerDriverAccuracyCircles[id]) {
        ownerDriverAccuracyCircles[id].setLatLng([r.latitude, r.longitude]).setRadius(acc);
      } else {
        ownerDriverAccuracyCircles[id] = L.circle([r.latitude, r.longitude], {
          radius: acc, color: '#2563eb', weight: 1, fillColor: '#2563eb', fillOpacity: 0.08
        }).addTo(ownerDriverMap);
      }
    } else if (ownerDriverAccuracyCircles[id]) {
      ownerDriverMap.removeLayer(ownerDriverAccuracyCircles[id]);
      delete ownerDriverAccuracyCircles[id];
    }
  });
  Object.keys(ownerDriverMarkers).forEach(id => {
    if (!seenAny.has(id)) {
      ownerDriverMap.removeLayer(ownerDriverMarkers[id]); delete ownerDriverMarkers[id]; delete driverLocationFreshness[id];
      delete driverShiftDataCache[id];
      if (ownerDriverAccuracyCircles[id]) { ownerDriverMap.removeLayer(ownerDriverAccuracyCircles[id]); delete ownerDriverAccuracyCircles[id]; }
      // Driver's gone from the driver_locations table entirely (not just offline) —
      // drop their breadcrumb trail too rather than leaving an orphaned line on the map.
      if (ownerDriverBreadcrumbPolylines[id]) { ownerDriverMap.removeLayer(ownerDriverBreadcrumbPolylines[id]); delete ownerDriverBreadcrumbPolylines[id]; }
      delete ownerDriverBreadcrumbs[id];
    }
  });
  const countEl = $('liveMapDriverCount');
  if (countEl) {
    countEl.textContent = seenOnline.size
      ? `🟢 ${seenOnline.size} online now`
      : (seenAny.size ? `⚪ ${seenAny.size} driver(s) sharing, but no fresh signal right now` : 'No drivers sharing location right now');
  }
  // Breadcrumb trail: the actual path each currently-online driver has driven
  // (real GPS points, starting from the pickup point), not a guessed straight
  // line — see appendBreadcrumbPoint/renderOwnerDriverBreadcrumbs below.
  renderOwnerDriverBreadcrumbs(Array.from(seenOnline));
  const markers = Object.values(ownerDriverMarkers);
  if (ownerPickupMarker) markers.push(ownerPickupMarker);
  if (markers.length) {
    // BUG FIX: this used to call fitBounds() on every single call to this function —
    // which runs on every 15s poll AND every realtime ping from ANY driver (so
    // potentially every few seconds). That silently re-centered/re-zoomed the map
    // out from under the owner while they were trying to pan or zoom in on a
    // specific driver, making the map feel broken/unusable for anything but a
    // glance. Now it only auto-fits when the actual set of visible drivers changes
    // (one comes online or goes offline) — a driver simply moving no longer yanks
    // the view around.
    const fitKey = Object.keys(ownerDriverMarkers).sort().join(',');
    if (fitKey !== ownerDriverMapLastFitKey) {
      ownerDriverMapLastFitKey = fitKey;
      const group = L.featureGroup(markers);
      try { ownerDriverMap.fitBounds(group.getBounds().pad(0.3), { maxZoom: 14 }); } catch (e) {}
    }
  }
  renderDeliveryDriverStats();
}

// Adds a new point to a driver's breadcrumb trail — but only if it's actually
// moved a meaningful distance from the last recorded point, so a parked/idle
// driver's tiny GPS jitter doesn't turn the trail into a fuzzy scribble.
function appendBreadcrumbPoint(id, lat, lng) {
  const trail = ownerDriverBreadcrumbs[id] || (ownerDriverBreadcrumbs[id] = []);
  if (trail.length) {
    const [lastLat, lastLng] = trail[trail.length - 1];
    const movedKm = haversineKm(lastLat, lastLng, lat, lng);
    if (movedKm * 1000 < BREADCRUMB_MIN_MOVE_M) return;
  } else {
    // Seed the very first point with the fixed pickup location, so the trail
    // visibly starts from the shop/warehouse rather than wherever the driver
    // happened to be when the owner's map first loaded.
    const pickup = getPickupLocation();
    trail.push([pickup.lat, pickup.lng]);
  }
  trail.push([lat, lng]);
  if (trail.length > BREADCRUMB_MAX_POINTS) trail.splice(0, trail.length - BREADCRUMB_MAX_POINTS);
}

// Draws (or updates) a solid line tracing each currently-online driver's actual
// GPS breadcrumb trail — real fixes the phone has reported, not a routing
// guess — so the owner sees exactly where that driver has really been today.
let ownerDriverBreadcrumbPolylines = {};
function renderOwnerDriverBreadcrumbs(onlineDriverIds) {
  if (!ownerDriverMap) return;
  const idsSet = new Set(onlineDriverIds.map(String));
  idsSet.forEach(id => {
    const trail = ownerDriverBreadcrumbs[id];
    if (!trail || trail.length < 2) {
      if (ownerDriverBreadcrumbPolylines[id]) { ownerDriverMap.removeLayer(ownerDriverBreadcrumbPolylines[id]); delete ownerDriverBreadcrumbPolylines[id]; }
      return;
    }
    const color = colorForDriver(id);
    if (ownerDriverBreadcrumbPolylines[id]) {
      ownerDriverBreadcrumbPolylines[id].setLatLngs(trail).setStyle({ color });
    } else {
      ownerDriverBreadcrumbPolylines[id] = L.polyline(trail, { color, weight: 3, opacity: 0.75 }).addTo(ownerDriverMap);
    }
  });
  Object.keys(ownerDriverBreadcrumbPolylines).forEach(id => {
    if (!idsSet.has(id)) { ownerDriverMap.removeLayer(ownerDriverBreadcrumbPolylines[id]); delete ownerDriverBreadcrumbPolylines[id]; }
  });
}

// Moves the pickup marker/popup on the already-built map to match whatever
// getPickupLocation() currently returns — called right after the owner saves
// a new pickup location, so the map updates instantly without a full rebuild.
function updateOwnerPickupMarker() {
  if (!ownerDriverMap || !ownerPickupMarker) return;
  const pickup = getPickupLocation();
  ownerPickupMarker.setLatLng([pickup.lat, pickup.lng])
    .setPopupContent(`<strong>🏭 ${escapeHtmlSafe(pickup.name)}</strong><br><small>Pickup point for every delivery</small>`);
  ownerDriverMap.panTo([pickup.lat, pickup.lng]);
}

// ==================== OWNER: CHANGE PICKUP LOCATION ====================
// Lets the owner set/move their own shop/warehouse pickup point (instead of it
// being fixed in code) — saved on their profile so it's theirs to control and
// persists across logins/devices.
let ownerPickupMap = null;
let ownerPickupMarkerEdit = null;

function openOwnerPickupModal() {
  if (userRole !== 'owner') return;
  const pickup = getPickupLocation();
  $('ownerPickupLabel').value = (userProfile && userProfile.pickup_label) || '';
  $('ownerPickupModal').classList.add('active');
  setTimeout(() => initOwnerPickupMap(pickup), 50);
}
window.openOwnerPickupModal = openOwnerPickupModal;

function initOwnerPickupMap(pickup) {
  const el = document.getElementById('ownerPickupMap');
  if (!el || typeof L === 'undefined') return;
  if (!ownerPickupMap) {
    ownerPickupMap = L.map(el).setView([pickup.lat, pickup.lng], 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(ownerPickupMap);
    ownerPickupMap.on('click', (e) => placeOwnerPickupMarker(e.latlng.lat, e.latlng.lng));
  } else {
    ownerPickupMap.setView([pickup.lat, pickup.lng], 15);
  }
  setTimeout(() => ownerPickupMap && ownerPickupMap.invalidateSize(), 60);
  placeOwnerPickupMarker(pickup.lat, pickup.lng);
}

function placeOwnerPickupMarker(lat, lng) {
  if (!ownerPickupMap) return;
  if (ownerPickupMarkerEdit) {
    ownerPickupMarkerEdit.setLatLng([lat, lng]);
  } else {
    ownerPickupMarkerEdit = L.marker([lat, lng], { draggable: true }).addTo(ownerPickupMap);
    ownerPickupMarkerEdit.on('dragend', () => {
      const p = ownerPickupMarkerEdit.getLatLng();
      updateOwnerPickupCoordsLabel(p);
    });
  }
  updateOwnerPickupCoordsLabel({ lat, lng });
}

function updateOwnerPickupCoordsLabel(latlng) {
  const label = $('ownerPickupCoordsLabel');
  if (!label) return;
  label.textContent = latlng ? `📍 ${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}` : 'Tap the map to move the pin';
}

function useOwnerPickupMyLocation() {
  if (!navigator.geolocation) { alert('Location is not supported on this device/browser.'); return; }
  const label = $('ownerPickupCoordsLabel');
  if (label) label.textContent = '📍 Getting your current location…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      if (ownerPickupMap) ownerPickupMap.setView([latitude, longitude], 16);
      placeOwnerPickupMarker(latitude, longitude);
    },
    (err) => { if (label) label.textContent = '⚠️ Could not get your location: ' + err.message; },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
}
window.useOwnerPickupMyLocation = useOwnerPickupMyLocation;

async function saveOwnerPickupLocation() {
  if (userRole !== 'owner' || !currentUser) return;
  if (!ownerPickupMarkerEdit) { alert('📍 Tap the map (or use "Use My Current Location") to place the pin first.'); return; }
  if (!(await ensureFreshSession())) return;
  const { lat, lng } = ownerPickupMarkerEdit.getLatLng();
  const label = $('ownerPickupLabel').value.trim();
  try {
    const { error } = await supabase.from('profiles')
      .update({ pickup_lat: lat, pickup_lng: lng, pickup_label: label || null })
      .eq('id', currentUser.id);
    if (error) throw error;
    if (userProfile) { userProfile.pickup_lat = lat; userProfile.pickup_lng = lng; userProfile.pickup_label = label || null; }
    closeModal('ownerPickupModal');
    updateOwnerPickupMarker();
    loadDriverLocations(); // redraw route lines from the new pickup point immediately
    updateStatus('✅ Pickup location saved');
  } catch (e) {
    console.error('Save pickup location error:', e);
    // A JWT/auth error here means the session died *after* ensureFreshSession's
    // check (e.g. mid-request) — not a schema problem, so don't show the
    // misleading "columns exist" hint for it.
    if (/jwt|expired|not authenticated|401/i.test(e.message || '')) {
      alert('⚠️ Your session expired while saving. Please log in again and try once more.');
      window.location.replace('login.html');
    } else {
      alert('❌ Could not save the pickup location: ' + e.message + '\n\nMake sure the pickup_lat/pickup_lng/pickup_label columns exist on the profiles table.');
    }
  }
}
window.saveOwnerPickupLocation = saveOwnerPickupLocation;

function startOwnerDriverLocationsRealtime() {
  if (!currentUser || userRole !== 'owner' || ownerDriverLocationsChannel) return;
  ownerDriverLocationsChannel = supabase
    .channel('owner-driver-locations-' + currentUser.id)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'driver_locations', filter: `owner_id=eq.${currentUser.id}`
    }, () => { loadDriverLocations(); })
    .subscribe();
}

// ---- Driver side: opt-in location sharing ----
let driverLocationWatchId = null;
let driverLocationSharing = false;
let driverLocationLastSent = 0;
let driverLastCoords = null;      // most recent raw fix, good or bad — used for the trip km counter
let driverLastGoodCoords = null;  // most recent fix that cleared the accuracy bar — this is what gets shown to the owner
let driverLocationShareStartTs = 0;
let driverLocationHeartbeat = null;

// ---- Daily "working %" tracking ----
// Working % = how much of today's shift the driver actually had location
// sharing switched on. "Shift" starts at the first time-share of the day and
// runs to now; "on" time accumulates only while sharing is actually active.
// Tracked in localStorage (survives app restarts/reloads through the day) and
// pushed to Supabase alongside each location update so the OWNER can see it
// too — not just the driver on their own device.
function driverShiftStorageKey() { return `mydrybea_v34_shift_${(currentUser && currentUser.id) || 'anon'}`; }
function loadDriverShiftState() {
  let s;
  try { s = JSON.parse(localStorage.getItem(driverShiftStorageKey())); } catch (e) { s = null; }
  const today = todayStr();
  if (!s || s.date !== today) s = { date: today, shiftStartAt: null, accumulatedMs: 0, sessionStartTs: null };
  return s;
}
function saveDriverShiftState(s) {
  try { localStorage.setItem(driverShiftStorageKey(), JSON.stringify(s)); } catch (e) {}
}
// Call when sharing turns ON: opens today's shift (if not already open) and starts an active session.
function driverShiftSessionStart() {
  const s = loadDriverShiftState();
  if (!s.shiftStartAt) s.shiftStartAt = new Date().toISOString();
  if (!s.sessionStartTs) s.sessionStartTs = Date.now();
  saveDriverShiftState(s);
}
// Call when sharing turns OFF: folds the just-finished session into the accumulated total.
function driverShiftSessionStop() {
  const s = loadDriverShiftState();
  if (s.sessionStartTs) { s.accumulatedMs += Date.now() - s.sessionStartTs; s.sessionStartTs = null; }
  saveDriverShiftState(s);
}
// Called frequently (every send/heartbeat) while sharing is ON: folds elapsed time
// into the accumulated total and resets the checkpoint. This means if the browser/app
// is killed outright without ever calling driverShiftSessionStop(), at most a few
// seconds since the last checkpoint go uncounted — never hours of "phantom" active
// time from a session that never got closed out properly.
function driverShiftCheckpoint() {
  const s = loadDriverShiftState();
  if (s.sessionStartTs) {
    s.accumulatedMs += Date.now() - s.sessionStartTs;
    s.sessionStartTs = Date.now();
    saveDriverShiftState(s);
  }
}
// Returns { shiftStartAtIso, activeSeconds } for whatever should be sent to Supabase right now.
function getDriverShiftStatsForUpload() {
  const s = loadDriverShiftState();
  const liveMs = s.accumulatedMs + (s.sessionStartTs ? (Date.now() - s.sessionStartTs) : 0);
  return { shiftStartAtIso: s.shiftStartAt, activeSeconds: Math.round(liveMs / 1000) };
}
// A GPS fix worse than this (metres of uncertainty) is treated as "not good enough
// to show" rather than sent as-is — this is what was putting the pin a whole
// province away: phones fall back to Wi-Fi/cell-tower location (accuracy in the
// tens of km, sometimes country-level) when they can't get a real GPS lock yet,
// and the old code forwarded that straight to the owner's map as if it were exact.
const GOOD_GPS_ACCURACY_M = 500;
// If no fix ever clears that bar within this long, send the best we've got anyway
// (heavily flagged) rather than leaving the driver invisible on the map forever —
// some devices/locations genuinely can't get better than a rough fix.
const GPS_FALLBACK_GRACE_MS = 45000;

function toggleDriverLocationSharing() {
  if (userRole !== 'driver') return;
  if (driverLocationSharing) stopDriverLocationSharing();
  else startDriverLocationSharing();
}
window.toggleDriverLocationSharing = toggleDriverLocationSharing;

function startDriverLocationSharing() {
  if (!navigator.geolocation) { alert('Location is not supported on this device/browser.'); return; }
  driverLastGoodCoords = null;
  driverLocationShareStartTs = Date.now();
  driverShiftSessionStart();
  const status = $('driverLocationStatus');
  if (status) status.textContent = '📡 Getting your location…';
  // FIX: send an immediate fix right away instead of waiting for the first watchPosition
  // callback (which can take a while, or never fire if the device isn't moving) — this is
  // why the owner used to see "sharing on" but no pin appear for a long time.
  navigator.geolocation.getCurrentPosition(
    (pos) => { driverSendLocation(pos.coords.latitude, pos.coords.longitude, true, pos.coords.accuracy); },
    (err) => {
      console.warn('Initial location fix failed:', err.message);
      // Don't leave this silent — on mobile there's no console to see it in, so the
      // button used to just look "stuck" with no clue why. Still keep watchPosition
      // running below; a real fix may still arrive from it shortly after.
      if (status && driverLocationSharing) status.textContent = geolocationErrorMessage(err) + ' Still trying…';
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
  driverLocationWatchId = navigator.geolocation.watchPosition(
    (pos) => { driverSendLocation(pos.coords.latitude, pos.coords.longitude, false, pos.coords.accuracy); },
    (err) => {
      console.error('Geolocation error:', err);
      // FIX: previously ANY error here (including a plain GPS timeout — very common on
      // mobile indoors / weak signal, which fires repeatedly and is not fatal) immediately
      // called stopDriverLocationSharing(). That flipped the button straight back to
      // "Share My Location" within seconds of tapping it, looking like the tap did nothing
      // ("stuck") when really it was working but just hadn't gotten a GPS lock yet.
      // Now: only a real permission denial turns sharing off. Everything else just shows
      // a status message and keeps the watch running — the browser keeps retrying and a
      // later fix (or the 20s heartbeat once one arrives) will clear the warning.
      const status = $('driverLocationStatus');
      if (err.code === err.PERMISSION_DENIED) {
        if (status) status.textContent = '⚠️ ' + geolocationErrorMessage(err) + ' — sharing stopped.';
        stopDriverLocationSharing();
      } else if (status) {
        status.textContent = '⚠️ ' + geolocationErrorMessage(err) + ' — still sharing, retrying…';
      }
    },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 }
  );
  // FIX: some phones pause/throttle watchPosition callbacks once the driver stops moving or
  // the screen dims, so the owner's map would freeze at the last spot and look "broken" even
  // though the driver hadn't gone anywhere. A heartbeat resends the last known GOOD fix every
  // 20s regardless — never a bad one — so the "updated Xs ago" freshness on the owner's map
  // stays accurate without ever re-sending a wrong position.
  driverLocationHeartbeat = setInterval(() => {
    if (driverLastGoodCoords) driverSendLocation(driverLastGoodCoords.lat, driverLastGoodCoords.lng, true, driverLastGoodCoords.accuracy);
  }, 20000);
  driverLocationSharing = true;
  updateDriverLocationUI();
}

// Turns a raw GeolocationPositionError into a short, mobile-friendly message.
// Kept separate so both the initial fix and the ongoing watch show the same wording.
function geolocationErrorMessage(err) {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return 'Location permission is blocked for this site — enable it in your phone/browser settings.';
    case err.POSITION_UNAVAILABLE:
      return "Couldn't get a GPS fix (weak signal).";
    case err.TIMEOUT:
      return 'GPS is taking a while (weak signal or indoors).';
    default:
      return 'Location error: ' + err.message;
  }
}

function stopDriverLocationSharing() {
  if (driverLocationWatchId != null) { navigator.geolocation.clearWatch(driverLocationWatchId); driverLocationWatchId = null; }
  if (driverLocationHeartbeat != null) { clearInterval(driverLocationHeartbeat); driverLocationHeartbeat = null; }
  driverLocationSharing = false;
  driverShiftSessionStop();
  updateDriverLocationUI();
}

function updateDriverLocationUI() {
  const btn = $('driverLocationToggleBtn');
  const status = $('driverLocationStatus');
  if (btn) {
    btn.innerHTML = driverLocationSharing
      ? '<i class="business-icon icon-inline" data-lucide="map-pin-off" aria-hidden="true"></i> Stop Sharing Location'
      : '<i class="business-icon icon-inline" data-lucide="map-pin" aria-hidden="true"></i> Share My Location';
    btn.classList.toggle('btn-primary', driverLocationSharing);
  }
  if (status) status.textContent = driverLocationSharing
    ? 'On — the owner can see your live location while you deliver'
    : 'Off — turn on so the owner can see you on the map while delivering';
  if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } });
}

// Upserts a driver_locations row, gracefully dropping any column Supabase
// doesn't recognize yet (e.g. `accuracy`, `shift_start_at`, `active_seconds_today`
// before their migration has been run) and retrying, instead of failing the
// whole location update — and thus silently going invisible on the owner's
// map — over one missing optional column. Generalizes the accuracy-column
// fallback that used to be hardcoded here to cover every optional field.
async function upsertDriverLocationResilient(payload) {
  let attempt = { ...payload };
  for (let i = 0; i < 4; i++) {
    const { error } = await supabase.from('driver_locations').upsert(attempt, { onConflict: 'driver_id' });
    if (!error) return { error: null };
    const m = /column ["']?([a-zA-Z0-9_]+)["']? does not exist/i.exec(error.message || '');
    if (m && attempt.hasOwnProperty(m[1])) {
      delete attempt[m[1]];
      continue; // retry without that column
    }
    return { error }; // some other error — don't loop forever
  }
  return { error: new Error('Could not save location after removing unrecognized columns.') };
}

async function driverSendLocation(lat, lng, force, accuracy) {
  driverLastCoords = { lat, lng, accuracy };
  const acc = (typeof accuracy === 'number' && isFinite(accuracy)) ? Math.round(accuracy) : null;
  // Checkpoint the "working %" shift clock on every fix — even one that gets
  // filtered out below by the accuracy gate — because the driver still has
  // sharing switched ON and is out working; that's what this stat measures,
  // not whether any particular fix was precise enough to forward.
  driverShiftCheckpoint();

  // ---- Accuracy gate: don't forward a fix that's too rough to be useful ----
  // This is the actual fix for the pin showing miles from the driver's real spot:
  // a poor fix (Wi-Fi/cell-tower estimate, tens of km of uncertainty) is now held
  // back instead of being upserted straight to the owner's map. We wait for GPS to
  // lock on to something under GOOD_GPS_ACCURACY_M; only after a grace period with
  // nothing better do we give up and send the rough one anyway (heavily flagged),
  // so a driver genuinely stuck with a weak signal still shows up eventually.
  if (acc != null && acc > GOOD_GPS_ACCURACY_M) {
    const withinGrace = (Date.now() - driverLocationShareStartTs) < GPS_FALLBACK_GRACE_MS;
    if (withinGrace || driverLastGoodCoords) {
      // Either still waiting for the first good lock, or we already have a good
      // fix on record — in both cases, don't push this rough one. The status
      // line still updates so the driver can see it's actively trying.
      const status = $('driverLocationStatus');
      if (status && driverLocationSharing && !driverLastGoodCoords) {
        status.textContent = `📡 Getting a precise GPS lock… (currently accurate to ~${(acc/1000).toFixed(1)}km — go outdoors if possible)`;
      }
      return;
    }
    // Grace period expired and we've never had a good fix at all — send this one
    // anyway so the driver isn't invisible forever, but it's clearly marked as
    // approximate both here and in the accuracy circle the owner sees.
  }

  driverLastGoodCoords = { lat, lng, accuracy: acc };

  // Auto-distance: accumulate onto the active trip on every GPS fix (not just the
  // throttled network sends below), filtering tiny GPS jitter (<5m) and unrealistic
  // jumps (>2km between fixes, almost certainly a bad fix) so the total stays sane.
  if (activeTrip) {
    if (activeTrip.lastCoords) {
      const d = haversineKm(activeTrip.lastCoords.lat, activeTrip.lastCoords.lng, lat, lng);
      if (d >= 0.005 && d <= 2) {
        activeTrip.km += d;
        activeTrip.lastCoords = { lat, lng };
      } else if (d > 2) {
        // FIX: previously a single implausible jump (>2km between two fixes) left
        // the reference point untouched, so every later fix kept being compared
        // against that same stale point. If the driver had genuinely moved on,
        // the distance to that old point could stay above 2km forever — meaning
        // the km counter got permanently stuck for the rest of the trip. Now a
        // big jump just resets the reference point (we don't count the jump
        // itself, since we can't tell a bad GPS fix from a real move), so normal
        // accumulation always resumes on the very next fix instead of never.
        activeTrip.lastCoords = { lat, lng };
      }
      // else: under 5m — GPS jitter while stationary, ignored entirely.
    } else {
      activeTrip.lastCoords = { lat, lng };
    }
    updateLiveTripKmUI();
  }

  const now = Date.now();
  if (!force && now - driverLocationLastSent < 8000) return; // throttle: ~once per 8s, saves battery & bandwidth
  driverLocationLastSent = now;
  const basePayload = {
    driver_id: currentUser.id,
    owner_id: businessId,
    latitude: lat,
    longitude: lng,
    updated_at: new Date().toISOString()
  };
  if (acc != null) basePayload.accuracy = acc;
  // "Working %" inputs — shift_start_at (when today's shift began) and
  // active_seconds_today (accumulated ON time) — sent alongside every location
  // update so the owner's Drivers & Earnings table can show it without a
  // separate query. Optional columns: see upsertDriverLocationResilient below,
  // which drops any column Supabase doesn't recognize yet and retries, the
  // same graceful pattern already used for the `accuracy` column.
  const shiftStats = getDriverShiftStatsForUpload();
  if (shiftStats.shiftStartAtIso) basePayload.shift_start_at = shiftStats.shiftStartAtIso;
  basePayload.active_seconds_today = shiftStats.activeSeconds;
  try {
    const { error } = await upsertDriverLocationResilient(basePayload);
    if (error) throw error;
    // FIX: surface success/failure on-screen. Previously a failed upsert (e.g. a missing
    // RLS policy or unique constraint on driver_id) only logged to the browser console —
    // the driver would see "Sharing: On" and have no idea the owner's map was never
    // actually receiving anything.
    const status = $('driverLocationStatus');
    if (status && driverLocationSharing) {
      const accTxt = acc != null ? ` • ±${acc}m accuracy` : '';
      const warnTxt = (acc != null && acc > 300) ? ' ⚠️ Weak GPS signal — enable Precise/High-accuracy Location in your phone settings for a correct pin.' : '';
      status.textContent = 'On — last sent ' + nowHHMM() + accTxt + ' • the owner can see you on the map' + warnTxt;
    }
    if (activeTrip) {
      // Debounced save of the running trip distance so the owner's Delivery tab
      // reflects it live too (they can still override the figure manually).
      const km = Number(activeTrip.km.toFixed(2));
      supabase.from('orders').update({ delivery_km: km }).eq('id', activeTrip.orderId).eq('assigned_driver_id', currentUser.id)
        .then(({ error: kmErr }) => { if (kmErr) console.warn('Auto-km save error:', kmErr); });
      const o = myDeliveries.find(x => String(x.id) === String(activeTrip.orderId));
      if (o) o.delivery_km = km;
    }
  } catch (e) {
    console.error('Send location error:', e);
    const status = $('driverLocationStatus');
    if (status) status.textContent = '⚠️ Could not send location: ' + e.message;
  }
}

function viewInvoice(index) {
  const order = orders[index];
  const customerName = order.customerName || getCustomerName(order.customerId);
  const customerAddress = order.address || getCustomerAddress(order.customerId);
  const customerPhone = userRole === 'staff' ? (order.customerPhone || '') : getCustomerPhone(order.customerId);

  const invoiceHTML = `
    <div class="inv-card">
      <div class="inv-header">
        <div style="display:flex;align-items:center;gap:12px;">
          <img src="logo.jpg" alt="MY DRYBEA" style="width:52px;height:52px;border-radius:10px;object-fit:cover;border:2px solid #d4af37;" onerror="this.style.display='none'">
          <div>
            <h1>MY DRYBEA</h1>
            <p style="font-size:0.85rem;color:#666;">Seafood Market • Umbalakada Enterprise</p>
          </div>
        </div>
        <div style="text-align:right;">
          <h2 style="font-size:1.2rem;color:#10b981;">INVOICE</h2>
          <p style="font-size:0.85rem;"><strong>ID:</strong> ${order.id}</p>
          <p style="font-size:0.85rem;"><strong>Date:</strong> ${new Date(order.createdAt).toLocaleDateString()}</p>
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;margin-bottom:16px;font-size:0.9rem;">
        <div>
          <p><strong>Bill To:</strong></p>
          <p style="font-size:1.05rem;font-weight:700;">${customerName}</p>
          <p>${customerPhone ? '📞 '+customerPhone : ''}</p>
          <p>${customerAddress || 'N/A'}</p>
        </div>
        <div style="text-align:right;">
          <p><strong>Status:</strong> <span style="font-weight:800;color:#059669;">${order.status.toUpperCase()}</span></p>
        </div>
      </div>
      <table>
        <thead><tr><th>Item Description</th><th style="text-align:center;">Qty</th><th style="text-align:right;">Unit Price</th><th style="text-align:right;">Total</th></tr></thead>
        <tbody>
          <tr>
            <td><strong>Umbalakada (${order.product}g Pack)</strong></td>
            <td style="text-align:center;">${order.qty}</td>
            <td style="text-align:right;">${fmt(order.unitPrice)}</td>
            <td style="text-align:right;">${fmt(order.total)}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr><td colspan="3" style="text-align:right;font-size:1rem;"><strong>Grand Total:</strong></td><td style="text-align:right;font-size:1.1rem;color:#047857;"><strong>${fmt(order.total)}</strong></td></tr>
        </tfoot>
      </table>
      ${order.notes ? `<p style="margin-top:12px;font-size:0.85rem;background:#f9f9f9;padding:8px;border-radius:6px;"><strong>Special Notes:</strong> ${order.notes}</p>` : ''}
      <p style="margin-top:20px;text-align:center;color:#a8842c;font-weight:700;font-size:0.95rem;">Thank you for choosing MY DRYBEA! 🐟</p>
    </div>
  `;

  $('invoicePrintArea').innerHTML = invoiceHTML;

  const modal = document.createElement('div');
  modal.className = 'modal-backdrop active';
  modal.innerHTML = `
    <div class="modal">
      <h3><span class="pro-title-icon green" aria-hidden="true"><i class="business-icon" data-lucide="chart-no-axes-combined" aria-hidden="true"></i></span><span>Invoice</span></h3><p class="pro-subtitle green">Choose how to deliver the finished invoice.</p>
      <div class="btn-row" style="justify-content:center;">
        <button class="btn btn-primary" onclick="printInvoicePDF(); closeThisModal()"><i class="business-icon icon-inline" data-lucide="file-text" aria-hidden="true"></i> Print / PDF</button>
        <button class="btn btn-whatsapp" onclick="shareInvoiceWhatsApp(${index}); closeThisModal()"><i class="business-icon icon-inline" data-lucide="message-circle" aria-hidden="true"></i> WhatsApp</button>
        <button class="btn" onclick="closeThisModal()">Close</button>
      </div>
    </div>
  `;
  modal.id = 'invoiceOptionsModal';
  document.body.appendChild(modal);
}

function printInvoicePDF() { window.print(); }

function shareInvoiceWhatsApp(index) {
  const order = orders[index];
  const customerName = getCustomerName(order.customerId);
  const customerAddress = order.address || getCustomerAddress(order.customerId);
  const customerPhone = userRole === 'staff' ? '' : getCustomerPhone(order.customerId);
  let message = `🧾 *MY DRYBEA - INVOICE*\n\n`;
  message += `*Order ID:* ${order.id}\n`;
  if (order.orderRefNo) message += `*Sale Ref:* ${order.orderRefNo}\n`;
  message += `*Date:* ${new Date(order.createdAt).toLocaleDateString()}\n`;
  message += `*Customer:* ${customerName}\n`;
  if (customerPhone) message += `*Phone:* ${customerPhone}\n`;
  if (customerAddress) message += `*Address:* ${customerAddress}\n`;
  message += `\n*Item:* Umbalakada ${order.product}g Pack\n`;
  message += `*Quantity:* ${order.qty}\n`;
  message += `*Unit Price:* ${fmt(order.unitPrice)}\n`;
  message += `*Total:* ${fmt(order.total)}\n`;
  message += `*Status:* ${order.status.toUpperCase()}\n`;
  if (order.notes) message += `*Notes:* ${order.notes}\n`;
  message += `\n_Thank you for your business! 🐟_`;
  window.open('https://wa.me/?text=' + encodeURIComponent(message), '_blank');
}

function closeThisModal() {
  const modal = document.getElementById('invoiceOptionsModal');
  if (modal) modal.remove();
}

function closeModal(id) { $(id).classList.remove('active'); }

// ==================== HISTORY ====================
function saveOrder() {
  const mix = getMixPct();
  const r = calculatePack(state.packSize, state.linnaPrice, state.balayaPrice, state.kawalamPrice, mix, state.mode, state.targetProfit, state.customSp);
  const overheadPerPack = getAllocatedOverheadPerPack();
  const netProfitPerPack = r.profit - overheadPerPack;
  history.push({
    date: new Date().toLocaleString(),
    pack: state.packSize,
    mix: state.mixRatio === 'custom' ? `${state.customLinna}/${state.customBalaya}/${state.customKawalam}` : state.mixRatio,
    sp: r.sp,
    cost: r.totalCost,
    profit: r.profit,
    netProfit: netProfitPerPack
  });
  saveHistory();
  renderHistory();
  onDataChange();
  alert('Order saved to history!');
}

function renderHistory() {
  const tbody = $('historyBody');
  if (history.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;opacity:0.5;padding:20px;">No orders saved yet.</td></tr>';
    return;
  }
  tbody.innerHTML = history.map((order, index) => {
    return `<tr>
      <td>${order.date}</td>
      <td>${order.pack}</td>
      <td>${order.mix}</td>
      <td>${fmt(order.sp)}</td>
      <td>${fmt(order.cost)}</td>
      <td>${fmt(order.profit)}</td>
      <td>${fmt(order.netProfit)}</td>
      <td>${actionMenuHTML([{ label: 'Delete', icon: '🗑️', danger: true, onclick: `deleteHistoryEntry(${index})` }])}</td>
    </tr>`;
  }).join('');
}

function deleteHistoryEntry(index) {
  history.splice(index, 1);
  saveHistory();
  renderHistory();
  onDataChange();
}

function clearHistory() {
  if (confirm('Clear all history?')) {
    history = [];
    saveHistory();
    renderHistory();
    onDataChange();
  }
}

// ==================== STORAGE & SYNC ====================
function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(e) {}
}
function saveHistory() {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch(e) {}
}
function saveOrders() {
  try { localStorage.setItem(ORDERS_KEY, JSON.stringify(orders)); } catch(e) {}
}
function saveCustomers() {
  try { localStorage.setItem(CUSTOMERS_KEY, JSON.stringify(customers)); } catch(e) {}
}
function saveSnapshots() {
  try { localStorage.setItem(SNAPSHOTS_KEY, JSON.stringify(snapshots)); } catch(e) {}
}

function loadState() {
  try { state = Object.assign({}, state, JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}); } catch(e) {}
  if (!state.production) state.production = {
    rawLinna: 180, rawBalaya: 250, rawKawalam: 60,
    yieldLinna: 6, yieldBalaya: 6, yieldKawalam: 7,
    dailyRawKg: 500, workDays: 22,
    prodTransport: 110000, prodFirewood: 30000,
    prodWorkers: 220000, prodOther: 220000, prodIce: 35000,
    finLinna: 1750, finBalaya: 2200, finKawalam: 1000,
    ingSaltPrice: 120, ingSaltGrams: 0,
    ingGorakaPrice: 1200, ingGorakaGrams: 0,
    ingTurmericPrice: 1800, ingTurmericGrams: 0,
    ingCinnamonPrice: 3500, ingCinnamonGrams: 0,
    ingCurryLeafPrice: 400, ingCurryLeafGrams: 0,
    ingTamarindPrice: 900, ingTamarindGrams: 0
  };
  // Older saved states may already have a production object but predate the
  // ingredients/ice fields below — patch in defaults for any missing keys
  // instead of dropping the user's existing raw/yield/cost numbers.
  const productionDefaults = {
    prodIce: 35000,
    ingSaltPrice: 120, ingSaltGrams: 0,
    ingGorakaPrice: 1200, ingGorakaGrams: 0,
    ingTurmericPrice: 1800, ingTurmericGrams: 0,
    ingCinnamonPrice: 3500, ingCinnamonGrams: 0,
    ingCurryLeafPrice: 400, ingCurryLeafGrams: 0,
    ingTamarindPrice: 900, ingTamarindGrams: 0
  };
  Object.keys(productionDefaults).forEach(k => {
    if (state.production[k] === undefined) state.production[k] = productionDefaults[k];
  });
  // Backfill editable MRP/Wholesale pricing for state saved before this
  // feature existed — one pack at a time, so a partially-saved object
  // (e.g. only some sizes edited) doesn't lose the sizes it already has.
  if (!state.packPrices) state.packPrices = {};
  Object.keys(PACKS).forEach(key => {
    const existing = state.packPrices[key] || {};
    state.packPrices[key] = {
      mrp: isFinite(Number(existing.mrp)) && Number(existing.mrp) > 0 ? Number(existing.mrp) : PACKS[key].mrp,
      wholesale: isFinite(Number(existing.wholesale)) && Number(existing.wholesale) > 0 ? Number(existing.wholesale) : PACKS[key].mrp
    };
  });
  if (state.dpPriceBasis !== 'mrp' && state.dpPriceBasis !== 'wholesale') state.dpPriceBasis = 'mrp';
  // Backfill for state saved before Umbalakada Varieties existed, and guard
  // against a corrupted/empty array wiping out the 3 core types.
  if (!Array.isArray(state.umbalakadaTypes) || !state.umbalakadaTypes.some(t => t && t.core)) {
    const existingCustom = Array.isArray(state.umbalakadaTypes) ? state.umbalakadaTypes.filter(t => t && !t.core) : [];
    state.umbalakadaTypes = [
      { id: 'linna', name: 'Linna', core: true },
      { id: 'balaya', name: 'Balaya', core: true },
      { id: 'kawalam', name: 'Premium Mix', core: true },
      ...existingCustom
    ];
  }
}
function loadHistory() { try { history = JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch(e) { history = []; } }
function loadOrders() { try { orders = JSON.parse(localStorage.getItem(ORDERS_KEY)) || []; } catch(e) { orders = []; } }
function loadCustomers() { try { customers = JSON.parse(localStorage.getItem(CUSTOMERS_KEY)) || []; } catch(e) { customers = []; } }
function loadSnapshots() { try { snapshots = JSON.parse(localStorage.getItem(SNAPSHOTS_KEY)) || []; } catch(e) { snapshots = []; } }

function takeSnapshot() {
  const data = { state, history, orders, customers };
  snapshots.push({ time: new Date().toISOString(), data });
  if (snapshots.length > MAX_SNAPSHOTS) snapshots.shift();
  saveSnapshots();
}

function restoreFromSnapshot(index) {
  if (index >= snapshots.length) return;
  const snap = snapshots[index];
  if (!snap) return;
  takeSnapshot();
  Object.assign(state, snap.data.state);
  history = snap.data.history || [];
  orders = snap.data.orders || [];
  customers = snap.data.customers || [];
  syncUI();
  calcAll();
  calcDashboard();
  calcProduction();
  renderHistory();
  renderOrders();
  renderCustomers();
  renderDelivery();
  updateOrderStats();
  updateCustomerSelect();
  saveAll();
  updateStatus('Snapshot restored');
}

function saveAll() {
  saveState();
  saveHistory();
  saveOrders();
  saveCustomers();
  lastSaveTime = new Date();
  updateStatus('Data saved locally');
}

function onDataChange() {
  calcAll();
  calcProduction();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveAll();
    takeSnapshot();
    if (currentUser) {
      cloudSaveSilent();
    }
    updateStatus('Data auto-saved');
    saveTimer = null;
  }, 800);
}

function updateStatus(msg) {
  const el = $('dataStatus');
  if (el) {
    const dot = el.querySelector('.dot');
    if (dot) dot.className = 'dot green';
    el.innerHTML = `<span class="dot green"></span> ${msg}${lastSaveTime ? ' · '+lastSaveTime.toLocaleTimeString() : ''}`;
  }
  const footerEl = $('footerStatus');
  if (footerEl) {
    const dot = footerEl.querySelector('.dot');
    if (dot) dot.className = 'dot green';
    footerEl.innerHTML = `<span class="dot green"></span> ${currentUser ? '☁️ Cloud' : 'Local'}`;
  }
}

// ==================== CLOUD SYNC ====================
async function cloudSave() {
  if (!currentUser) { alert('Please login first.'); return; }
  try {
    const payload = { state, history }; // customers/orders now live in their own tables
    const { error } = await supabase
      .from('app_data')
      .upsert({ user_id: currentUser.id, data: payload, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    if (error) throw error;
    updateStatus('Cloud save successful');
    alert('✅ Data saved to cloud successfully!');
  } catch (e) {
    console.error('Cloud save error:', e);
    alert('❌ Cloud save failed: ' + e.message);
  }
}

// Silent cloud save (no alerts)
async function cloudSaveSilent() {
  if (!currentUser) return;
  try {
    const payload = { state, history }; // customers/orders now live in their own tables
    const { error } = await supabase
      .from('app_data')
      .upsert({ user_id: currentUser.id, data: payload, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    if (error) throw error;
    updateStatus('☁️ Synced');
  } catch (e) {
    console.error('Silent cloud save error:', e);
  }
}

async function cloudLoad() {
  if (!currentUser) { alert('Please login first.'); return; }
  try {
    const { data, error } = await supabase
      .from('app_data')
      .select('data')
      .eq('user_id', currentUser.id)
      .order('updated_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    if (!data || data.length === 0) {
      // No cloud data yet — first time user. Just use local defaults.
      updateStatus('No cloud data found — using local');
      return;
    }
    const payload = data[0].data;
    if (!payload || !payload.state) {
      updateStatus('Cloud data invalid — using local');
      return;
    }
    // Take snapshot before overwriting
    takeSnapshot();
    Object.assign(state, payload.state);
    history = payload.history || [];
    syncUI();
    calcAll();
    calcProduction();
    renderHistory();
    saveAll();
    // customers/orders/expenses live in their own tables — refresh those too
    await Promise.all([userRole==='owner'?loadCustomersFromCloud():Promise.resolve(), loadOrdersFromCloud(), loadExpensesFromCloud(), loadProductsFromCloud(), userRole==='owner'?loadPackPricesFromCloud():Promise.resolve()]);
    renderOrders();
    renderCustomers();
    renderDelivery();
    updateOrderStats();
    updateCustomerSelect();
    renderExpenses();
    await loadRecurringExpenses();
    await generateDueRecurringExpenses();
    renderRecurringExpenses();
    if (userRole === 'owner') {
      // Load pending advance requests right away and start live sync so the
      // owner sees new staff requests (and the nav badge) immediately after
      // login — not only after manually opening MY STAFF / Profile.
      try { await loadMyStaffOwnerData(); } catch (e) { console.warn('Advance init load:', e); }
      startAdvanceRealtime();
      try { await loadSalesFromCloud(); updateSalesStats(); } catch (e) { console.warn('Sales init load:', e); }
    }
    updateStatus('☁️ Cloud data loaded');
  } catch (e) {
    console.error('Cloud load error:', e);
    updateStatus('Cloud load failed — using local');
  }
}

// ==================== AUTH ====================
async function openAuthModal() {
  $('authModal').classList.add('active');
  $('authError').style.display = 'none';
  isAuthModeLogin = true;
  $('authTitle').textContent = '🔐 Login';
  $('authActionBtn').textContent = 'Login';
}

function toggleAuthMode() {
  isAuthModeLogin = !isAuthModeLogin;
  $('authTitle').textContent = isAuthModeLogin ? '🔐 Login' : '📝 Create Account';
  $('authActionBtn').textContent = isAuthModeLogin ? 'Login' : 'Create Account';
  $('authError').style.display = 'none';
}

async function authAction() {
  const email = $('authEmail').value.trim();
  const password = $('authPassword').value.trim();
  if (!email || !password) {
    $('authError').textContent = 'Email and password required.';
    $('authError').style.display = 'block';
    return;
  }

  $('authError').style.display = 'none';
  try {
    let result;
    if (isAuthModeLogin) {
      result = await supabase.auth.signInWithPassword({ email, password });
      if (result.error) throw result.error;
      currentUser = result.data.user;
    } else {
      result = await supabase.auth.signUp({ email, password });
      if (result.error) throw result.error;
      currentUser = result.data.user;
      alert('✅ Account created! Please verify your email if required.');
    }
    closeModal('authModal');
    updateAuthUI();
    // Load cloud data after login
    await loadUserProfile();
    await cloudLoad();
    updateStatus('✅ Logged in as ' + currentUser.email);
  } catch (e) {
    $('authError').textContent = e.message;
    $('authError').style.display = 'block';
  }
}

async function logout() {
  stopCommissionRealtime();
  stopDistributorCommissionRealtime();
  stopAdvanceRealtime();
  stopAppNotifyRealtime();
  logoutPushForCurrentUser();
  if (typeof stopDriverLocationSharing === 'function') stopDriverLocationSharing();
  await supabase.auth.signOut();
  currentUser = null;
  userProfile = null;
  userRole = 'owner';
  businessId = null;
  window.location.replace('login.html');
}

function updateAuthUI() {
  const btn = $('authBtn');
  if (currentUser) {
    btn.innerHTML = '<i class="business-icon" data-lucide="user-round" aria-hidden="true"></i><span class="sr-only">Account</span>';
    btn.title = currentUser.email || 'Account';
    btn.setAttribute('aria-label', currentUser.email || 'Account');
    btn.onclick = logout;
    const profileEmail = $('profileEmail');
    const profileName = $('profileName');
    const profileAction = $('profileAuthAction');
    if (profileEmail) profileEmail.textContent = currentUser.email || 'Signed in';
    if (profileName) profileName.textContent = ((currentUser.email || 'Business Owner').split('@')[0].replace(/[._-]+/g, ' ').trim() || 'Business Owner').replace(/\b\w/g, c => c.toUpperCase());
    if (profileAction) { profileAction.textContent = 'Sign Out'; profileAction.onclick = logout; }
    const nameEl = $('mobileUserName');
    if (nameEl) {
      const emailName = (currentUser.email || 'Business Owner').split('@')[0].replace(/[._-]+/g, ' ').trim();
      nameEl.textContent = emailName ? emailName.replace(/\b\w/g, c => c.toUpperCase()) : 'Business Owner';
    }
    if (window.lucide) lucide.createIcons();
  } else {
    const profileEmail = $('profileEmail');
    const profileName = $('profileName');
    const profileAction = $('profileAuthAction');
    if (profileEmail) profileEmail.textContent = 'Not signed in';
    if (profileName) profileName.textContent = 'Business Owner';
    if (profileAction) { profileAction.textContent = 'Login'; profileAction.onclick = openAuthModal; }
    btn.innerHTML = '<i class="business-icon" data-lucide="user-round" aria-hidden="true"></i><span class="sr-only">Login</span>';
    btn.title = 'Login';
    btn.setAttribute('aria-label', 'Login');
    btn.onclick = openAuthModal;
    if (window.lucide) lucide.createIcons();
  }
}

// ==================== BACKUP / RESTORE ====================
function backupJSON() {
  const data = { state, history, orders, customers };
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mydrybea_backup_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
}

function restoreJSON(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const imported = JSON.parse(e.target.result);
      if (!imported.state) throw new Error('Invalid backup: missing state');
      takeSnapshot();
      if (imported.state) { Object.assign(state, imported.state); }
      if (imported.history) { history = imported.history; }
      if (imported.orders) { orders = imported.orders; }
      if (imported.customers) { customers = imported.customers; }
      syncUI();
      calcAll();
      calcProduction();
      renderHistory();
      renderOrders();
      renderCustomers();
      renderDelivery();
      updateOrderStats();
      updateCustomerSelect();
      saveAll();
      updateStatus('Backup restored');
      alert('✅ Backup restored successfully!');
    } catch(err) {
      alert('Invalid backup file: ' + err.message);
    }
  };
  reader.readAsText(file);
}

function resetAll() {
  if (confirm('Reset all data to defaults? A snapshot will be taken.')) {
    takeSnapshot();
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(HISTORY_KEY);
    localStorage.removeItem(ORDERS_KEY);
    localStorage.removeItem(CUSTOMERS_KEY);
    location.reload();
  }
}

function resetDash() {
  state.dashQty = {50:1000, 100:500, 500:50, 1000:50};
  state.dashSp = {50:170, 100:350, 500:1750, 1000:3500};
  calcDashboard();
  onDataChange();
}

// ==================== MODE / THEME ====================
function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.mode-toggle .btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  $('targetProfitField').style.display = mode === 'profit' ? 'block' : 'none';
  $('customSpField').style.display = mode === 'sp' ? 'block' : 'none';
  onDataChange();
}

function toggleCustomMix() {
  state.mixRatio = $('mixRatio').value;
  $('customMixWrap').style.display = state.mixRatio === 'custom' ? 'block' : 'none';
  if (state.mixRatio === 'custom') syncCustomMix();
}

function syncCustomMix() {
  let l = Number($('customLinna').value) || 0;
  let b = Number($('customBalaya').value) || 0;
  if (l < 0) l = 0; if (l > 100) l = 100;
  if (b < 0) b = 0; if (b > 100) b = 100;
  if (l + b > 100) b = 100 - l;
  $('customLinna').value = l;
  $('customBalaya').value = b;
  $('customKawalam').value = Math.max(0, 100 - l - b);
  state.customLinna = l;
  state.customBalaya = b;
  state.customKawalam = Math.max(0, 100 - l - b);
}

function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', state.theme);
  $('themeToggle').innerHTML = '<i class="business-icon" data-lucide="moon" aria-hidden="true"></i>';
  if (window.lucide) lucide.createIcons();
  if (costChart) { costChart.destroy(); costChart = null; }
  if (prodChart) { prodChart.destroy(); prodChart = null; }
  if (dpMonthlyChart) { dpMonthlyChart.destroy(); dpMonthlyChart = null; }
  if (dpDustProfitChart) { dpDustProfitChart.destroy(); dpDustProfitChart = null; }
  if (ingBreakdownChart) { ingBreakdownChart.destroy(); ingBreakdownChart = null; }
  if (trendChart) { trendChart.destroy(); trendChart = null; }
  if (orderStatusChart) { orderStatusChart.destroy(); orderStatusChart = null; }
  if (productMixChart) { productMixChart.destroy(); productMixChart = null; }
  if (expenseCatChart) { expenseCatChart.destroy(); expenseCatChart = null; }
  if (profitBySizeChart) { profitBySizeChart.destroy(); profitBySizeChart = null; }
  onDataChange();
}

function toggleAcc() { $('overheadAcc').classList.toggle('open'); }

// ==================== APP LOCK ====================
function lockApp() {
  if (!confirm('Lock the app and return to the login screen?')) return;
  supabase.auth.signOut().finally(() => {
    window.location.replace('login.html');
  });
}

function openQR() {
  $('qrModal').classList.add('active');
  const payload = `MY DRYBEA | Linna: Rs.${state.linnaPrice}/kg | Balaya: Rs.${state.balayaPrice}/kg | Premium: Rs.${state.kawalamPrice}/kg | Mix: ${state.mixRatio} | Pack: ${state.packSize}`;
  $('qrcode').innerHTML = '';
  const img = document.createElement('img');
  img.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(payload)}`;
  img.style.borderRadius = '8px';
  img.style.maxWidth = '100%';
  $('qrcode').appendChild(img);
}

function closeQR() { $('qrModal').classList.remove('active'); }

// ==================== CSV EXPORTS ====================
function exportCSV() {
  const mix = getMixPct();
  const rows = [
    ['MY DRYBEA Cost Sheet'],
    ['Generated', new Date().toLocaleDateString()],
    ['Linna Price/kg', state.linnaPrice],
    ['Balaya Price/kg', state.balayaPrice],
    ['Premium Mix Price/kg', state.kawalamPrice],
    ['Mix Ratio (L/B/P)', state.mixRatio],
    [],
    ['Pack Size','Linna Cost','Balaya Cost','Premium Cost','Pack+Labour','Total Cost','SP','Profit','Margin%']
  ];
  Object.keys(PACKS).forEach(key => {
    const r = calculatePack(key, state.linnaPrice, state.balayaPrice, state.kawalamPrice, mix, 'mrp', 0, PACKS[key].mrp);
    rows.push([PACKS[key].label, r.linnaCost.toFixed(2), r.balayaCost.toFixed(2), r.premiumCost.toFixed(2), (r.p.grind+r.p.pack+r.packingLabour).toFixed(2), r.totalCost.toFixed(2), r.sp.toFixed(2), r.profit.toFixed(2), r.margin.toFixed(1)+'%']);
  });
  downloadCSV(rows, 'mydrybea_cost_sheet.csv');
}

function exportDashCSV() {
  const mix = getMixPct();
  const rows = [['Size','Qty','SP','Cost/Pack','Profit/Pack','Monthly Profit']];
  Object.keys(PACKS).forEach(key => {
    const qty = state.dashQty[key]||0;
    const sp = state.dashSp[key]||PACKS[key].mrp;
    const r = calculatePack(key, state.linnaPrice, state.balayaPrice, state.kawalamPrice, mix, 'sp', 0, sp);
    rows.push([PACKS[key].label, qty, sp, r.totalCost.toFixed(2), r.profit.toFixed(2), (r.profit*qty).toFixed(2)]);
  });
  downloadCSV(rows, 'mydrybea_dashboard.csv');
}

function exportHistoryCSV() {
  if (history.length === 0) { alert('No history to export.'); return; }
  const rows = [['Date','Pack','Mix','SP','Cost','Profit','Net Profit']];
  history.forEach(order => {
    rows.push([order.date, order.pack, order.mix, order.sp.toFixed(2), order.cost.toFixed(2), order.profit.toFixed(2), order.netProfit.toFixed(2)]);
  });
  downloadCSV(rows, 'mydrybea_order_history.csv');
}

function downloadCSV(rows, filename) {
  let csv = '\uFEFF';
  rows.forEach(r => { csv += r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',') + '\n'; });
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

// ==================== UI SYNC ====================
function syncUI() {
  $('linnaPrice').value = state.linnaPrice;
  $('balayaPrice').value = state.balayaPrice;
  $('kawalamPrice').value = state.kawalamPrice;
  $('packSize').value = state.packSize;
  $('mixRatio').value = state.mixRatio;
  $('customLinna').value = state.customLinna;
  $('customBalaya').value = state.customBalaya;
  $('customKawalam').value = state.customKawalam;
  $('targetProfit').value = state.targetProfit;
  $('customSp').value = state.customSp;
  $('monthlyQty').value = state.monthlyQty;
  if ($('linnaGrindYield')) $('linnaGrindYield').value = state.linnaGrindYield;
  if ($('balayaGrindYield')) $('balayaGrindYield').value = state.balayaGrindYield;
  if ($('premiumGrindYield')) $('premiumGrindYield').value = state.premiumGrindYield;
  $('ohTransport').value = state.overhead.transport;
  $('ohFirewood').value = state.overhead.firewood;
  $('ohWorkers').value = state.overhead.workers;
  $('ohOther').value = state.overhead.other;
  $('rawLinna').value = state.production.rawLinna;
  $('rawBalaya').value = state.production.rawBalaya;
  $('rawKawalam').value = state.production.rawKawalam;
  $('yieldLinna').value = state.production.yieldLinna;
  $('yieldBalaya').value = state.production.yieldBalaya;
  $('yieldKawalam').value = state.production.yieldKawalam;
  $('dailyRawKg').value = state.production.dailyRawKg;
  $('workDays').value = state.production.workDays;
  $('prodTransport').value = state.production.prodTransport;
  $('prodFirewood').value = state.production.prodFirewood;
  $('prodWorkers').value = state.production.prodWorkers;
  $('prodOther').value = state.production.prodOther;
  $('prodIce').value = state.production.prodIce;
  $('finLinna').value = state.production.finLinna;
  $('finBalaya').value = state.production.finBalaya;
  $('finKawalam').value = state.production.finKawalam;
  $('ingSaltPrice').value = state.production.ingSaltPrice;
  $('ingSaltGrams').value = state.production.ingSaltGrams;
  $('ingGorakaPrice').value = state.production.ingGorakaPrice;
  $('ingGorakaGrams').value = state.production.ingGorakaGrams;
  $('ingTurmericPrice').value = state.production.ingTurmericPrice;
  $('ingTurmericGrams').value = state.production.ingTurmericGrams;
  $('ingCinnamonPrice').value = state.production.ingCinnamonPrice;
  $('ingCinnamonGrams').value = state.production.ingCinnamonGrams;
  $('ingCurryLeafPrice').value = state.production.ingCurryLeafPrice;
  $('ingCurryLeafGrams').value = state.production.ingCurryLeafGrams;
  $('ingTamarindPrice').value = state.production.ingTamarindPrice;
  $('ingTamarindGrams').value = state.production.ingTamarindGrams;
  toggleCustomMix();
  setMode(state.mode);
  if (state.theme === 'dark') {
    document.documentElement.setAttribute('data-theme','dark');
    $('themeToggle').innerHTML = '<i class="business-icon" data-lucide="moon" aria-hidden="true"></i>';
  } else {
    document.documentElement.setAttribute('data-theme','light');
    $('themeToggle').innerHTML = '<i class="business-icon" data-lucide="moon" aria-hidden="true"></i>';
  }
  if (window.lucide) lucide.createIcons();
}

// ==================== MONTHLY SUMMARY ====================
function parseSummaryDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? new Date(value) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function updateMonthlySummary() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const day = now.getDate();
  const monthName = now.toLocaleDateString(undefined, { month:'long', year:'numeric' });
  const range = `01 — ${String(day).padStart(2,'0')} ${now.toLocaleDateString(undefined,{month:'short'})} (${daysInMonth} days in month)`;

  const inCurrentMonth = (value) => {
    const d = parseSummaryDate(value);
    return d && d.getFullYear() === year && d.getMonth() === month;
  };

  const monthOrders = (orders || []).filter(o => inCurrentMonth(o.createdAt));
  const activeOrders = monthOrders.filter(o => o.status !== 'cancelled');
  const cancelled = monthOrders.filter(o => o.status === 'cancelled');
  const delivered = monthOrders.filter(o => o.status === 'delivered');
  const pending = monthOrders.filter(o => !['delivered','cancelled'].includes(o.status));
  const revenue = activeOrders.reduce((sum,o) => sum + (Number(o.total)||0), 0);
  const deliveredRevenue = delivered.reduce((sum,o) => sum + (Number(o.total)||0), 0);
  const pendingRevenue = pending.reduce((sum,o) => sum + (Number(o.total)||0), 0);
  const units = activeOrders.reduce((sum,o) => sum + (Number(o.qty)||0), 0);
  const avg = activeOrders.length ? revenue / activeOrders.length : 0;

  const monthExpenses = (expenses || []).filter(e => inCurrentMonth(e.date || e.createdAt));
  const expenseTotal = monthExpenses.reduce((sum,e) => sum + (Number(e.amount)||0), 0);
  const netCash = revenue - expenseTotal;

  const set = (id, value) => { const el = $(id); if (el) el.textContent = value; };
  set('summaryMonthName', monthName);
  set('summaryDateRange', range);
  set('summaryLiveText', `Live • updated ${now.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`);
  set('summaryNetCash', fmt(netCash));
  set('summaryRevenue', fmt(revenue));
  set('summaryExpenses', fmt(expenseTotal));
  set('summaryOrders', monthOrders.length);
  set('summaryOrdersSub', `${delivered.length} delivered • ${pending.length} pending`);
  set('summaryUnits', units);
  set('summaryAvgOrder', fmt(avg));
  set('summaryDeliveredRevenue', fmt(deliveredRevenue));
  set('summaryPendingRevenue', fmt(pendingRevenue));
  set('summaryCancelled', cancelled.length);
  set('summaryDaysElapsed', `${day} / ${daysInMonth}`);

  const net = $('summaryNetCash');
  if (net) net.style.color = netCash >= 0 ? '#0a8f43' : '#d45d55';
  const note = $('summaryNote');
  if (note) {
    note.textContent = `Reporting period: 01–${String(day).padStart(2,'0')} ${monthName}. Revenue comes from recorded non-cancelled orders; expenses come from expense records dated in the current month. The figures refresh automatically as new data is loaded or saved.`;
  }
  calcRealIncome();
}

// ==================== REAL PROFIT (Income tab — Production → Income Linking) ====================
// Unlike the "Monthly Mix" planner above (dashBody/incomeRevenue etc., which
// uses manually-typed quantities & selling prices), this pulls ONLY real
// recorded data: actual orders, actual fish-purchase bills, actual other
// expenses, and actual finished output from completed production batches.
// No extra fetch needed — orders/expenses/fishBills/productionBatches are
// already loaded elsewhere; this just recomputes from those live arrays.
function calcRealIncome() {
  const revenueEl = $('realIncomeRevenue');
  if (!revenueEl) return; // Income tab not in the DOM for this role — skip

  const now = new Date();
  const inMonth = (value) => {
    const d = parseSummaryDate(value);
    return d && d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  };

  const monthOrders = (orders || []).filter(o => inMonth(o.createdAt) && o.status !== 'cancelled');
  const realRevenue = monthOrders.reduce((s, o) => s + (Number(o.total) || 0), 0);

  const monthFishBills = (fishBills || []).filter(b => inMonth(b.date));
  const realRawCost = monthFishBills.reduce((s, b) => s + b.total, 0);
  const realReadymadeCost = monthFishBills.filter(b => b.purchaseType === 'readymade_umbalakada').reduce((s, b) => s + b.total, 0);

  // Everything else the owner has logged as an expense this month, EXCLUDING
  // "Raw Fish" (already counted above via fishBills, to avoid double-counting
  // — every fish bill also mirrors into expenses under that exact category).
  const monthOtherExpenses = (expenses || []).filter(e => inMonth(e.date || e.createdAt) && e.category !== 'Raw Fish');
  const realOtherExpenses = monthOtherExpenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);

  const realNetProfit = realRevenue - realRawCost - realOtherExpenses;
  const realMargin = realRevenue > 0 ? (realNetProfit / realRevenue) * 100 : 0;

  const monthCompletedBatches = (productionBatches || []).filter(b => inMonth(b.date) && b.status === 'completed');
  const realOutputKg = monthCompletedBatches.reduce((s, b) => s + (b.actualFinishedKg || 0), 0);
  const realCostPerKgProduced = realOutputKg > 0 ? realRawCost / realOutputKg : 0;

  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('realIncomeRevenue', fmt(realRevenue));
  set('realIncomeRawCost', fmt(realRawCost));
  set('realIncomeOtherExp', fmt(realOtherExpenses));
  set('realIncomeNet', fmt(realNetProfit));
  set('realIncomeMargin', realMargin.toFixed(1) + '%');
  set('realIncomeOutputKg', realOutputKg.toFixed(1) + ' kg');
  set('realIncomeCostPerKg', fmt(realCostPerKgProduced));
  set('realIncomeReadymadeCost', fmt(realReadymadeCost));

  const netEl = $('realIncomeNet');
  if (netEl) netEl.style.color = realNetProfit >= 0 ? '#10b981' : '#f87171';
}
window.calcRealIncome = calcRealIncome;

// ==================== ANALYTICS ====================
let trendChart = null, orderStatusChart = null, productMixChart = null, expenseCatChart = null, profitBySizeChart = null, perfFailedReasonsChart = null, newReturningChart = null;

function analyticsMonthKey(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
function analyticsMonthLabel(d) { return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' }); }

function renderAnalytics() {
  const colors = getChartColors();
  const now = new Date();

  // ---- Build the last 6 calendar months (oldest first) ----
  const months = [];
  for (let i = 5; i >= 0; i--) months.push(new Date(now.getFullYear(), now.getMonth() - i, 1));
  const monthMap = {};
  months.forEach(d => { monthMap[analyticsMonthKey(d)] = { revenue: 0, expenses: 0 }; });

  (orders || []).forEach(o => {
    const d = parseSummaryDate(o.createdAt);
    if (!d || o.status === 'cancelled') return;
    const bucket = monthMap[analyticsMonthKey(d)];
    if (bucket) bucket.revenue += Number(o.total) || 0;
  });
  (expenses || []).forEach(e => {
    const d = parseSummaryDate(e.date || e.createdAt);
    if (!d) return;
    const bucket = monthMap[analyticsMonthKey(d)];
    if (bucket) bucket.expenses += Number(e.amount) || 0;
  });

  const labels = months.map(analyticsMonthLabel);
  const revenueData = months.map(d => monthMap[analyticsMonthKey(d)].revenue);
  const expenseData = months.map(d => monthMap[analyticsMonthKey(d)].expenses);
  const profitData = revenueData.map((r, i) => r - expenseData[i]);

  const totalRevenue = revenueData.reduce((a, b) => a + b, 0);
  const totalExpenses = expenseData.reduce((a, b) => a + b, 0);
  const totalProfit = totalRevenue - totalExpenses;
  let bestIdx = 0;
  profitData.forEach((p, i) => { if (p > profitData[bestIdx]) bestIdx = i; });

  const set = (id, val) => { const el = $(id); if (el) el.textContent = val; };
  set('anRevenue6m', fmt(totalRevenue));
  set('anExpenses6m', fmt(totalExpenses));
  set('anProfit6m', fmt(totalProfit));
  set('anBestMonth', labels[bestIdx] || '—');
  set('anBestMonthSub', profitData.some(p => p !== 0) ? `Profit ${fmt(profitData[bestIdx])}` : 'No data yet');

  // ---- Simple forecast: linear regression over the 6 monthly points ----
  function linearForecast(values) {
    const n = values.length;
    const xs = values.map((_, i) => i);
    const sumX = xs.reduce((a, b) => a + b, 0);
    const sumY = values.reduce((a, b) => a + b, 0);
    const sumXY = xs.reduce((a, x, i) => a + x * values[i], 0);
    const sumXX = xs.reduce((a, x) => a + x * x, 0);
    const denom = (n * sumXX - sumX * sumX);
    const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
    const intercept = (sumY - slope * sumX) / n;
    return Math.max(0, slope * n + intercept); // predict at x = n (next month)
  }
  const hasEnoughData = revenueData.some(v => v > 0);
  const forecastRevenue = hasEnoughData ? linearForecast(revenueData) : 0;
  const forecastExpenses = hasEnoughData ? linearForecast(expenseData) : 0;
  const forecastProfit = forecastRevenue - forecastExpenses;
  set('anForecastRevenue', hasEnoughData ? fmt(forecastRevenue) : '—');
  set('anForecastProfit', hasEnoughData ? `Estimated profit ${fmt(forecastProfit)}` : 'Not enough data yet');

  // ---- Revenue vs Expenses vs Profit trend (line), with next-month forecast ----
  const trendCanvas = $('trendChart');
  if (trendCanvas) {
    const forecastLabels = [...labels, hasEnoughData ? 'Next (est.)' : ''];
    const revForecastLine = [...Array(revenueData.length - 1).fill(null), revenueData[revenueData.length - 1], forecastRevenue];
    const profitForecastLine = [...Array(profitData.length - 1).fill(null), profitData[profitData.length - 1], forecastProfit];
    const data = {
      labels: forecastLabels,
      datasets: [
        { label: 'Revenue', data: [...revenueData, null], borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,.12)', tension: .35, fill: true },
        { label: 'Expenses', data: [...expenseData, null], borderColor: '#f87171', backgroundColor: 'rgba(248,113,113,.10)', tension: .35, fill: true },
        { label: 'Profit', data: [...profitData, null], borderColor: '#d4af37', backgroundColor: 'rgba(212,175,55,.10)', tension: .35, fill: true },
        { label: 'Revenue forecast', data: hasEnoughData ? revForecastLine : [], borderColor: '#10b981', borderDash: [6, 4], borderWidth: 2, pointStyle: 'star', backgroundColor: 'transparent', tension: 0, fill: false },
        { label: 'Profit forecast', data: hasEnoughData ? profitForecastLine : [], borderColor: '#d4af37', borderDash: [6, 4], borderWidth: 2, pointStyle: 'star', backgroundColor: 'transparent', tension: 0, fill: false }
      ]
    };
    const opts = {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: colors.text } } },
      scales: {
        x: { ticks: { color: colors.text }, grid: { color: colors.grid } },
        y: { ticks: { color: colors.text }, grid: { color: colors.grid } }
      }
    };
    if (trendChart) { trendChart.data = data; trendChart.options = opts; trendChart.update(); }
    else trendChart = new Chart(trendCanvas.getContext('2d'), { type: 'line', data, options: opts });
  }

  // ---- Order status mix (all-time, doughnut) ----
  const statusCounts = { pending: 0, delivered: 0, cancelled: 0, other: 0 };
  (orders || []).forEach(o => {
    const s = (o.status || 'pending').toLowerCase();
    if (s === 'pending') statusCounts.pending++;
    else if (s === 'delivered') statusCounts.delivered++;
    else if (s === 'cancelled') statusCounts.cancelled++;
    else statusCounts.other++;
  });
  const statusCanvas = $('orderStatusChart');
  if (statusCanvas) {
    const data = {
      labels: ['Pending', 'Delivered', 'Cancelled', 'Other'],
      datasets: [{
        data: [statusCounts.pending, statusCounts.delivered, statusCounts.cancelled, statusCounts.other],
        backgroundColor: ['#fbbf24', '#10b981', '#f87171', '#818cf8'], borderWidth: 0, hoverOffset: 6
      }]
    };
    const opts = { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { color: colors.text, boxWidth: 12 } } } };
    if (orderStatusChart) { orderStatusChart.data = data; orderStatusChart.update(); }
    else orderStatusChart = new Chart(statusCanvas.getContext('2d'), { type: 'doughnut', data, options: opts });
  }

  // ---- Product mix: units sold per pack size (all-time, bar) ----
  const packTotals = {};
  Object.keys(PACKS).forEach(k => packTotals[k] = 0);
  (orders || []).forEach(o => {
    if (o.status === 'cancelled') return;
    const key = String(o.product);
    if (packTotals.hasOwnProperty(key)) packTotals[key] += Number(o.qty) || 0;
  });
  const mixCanvas = $('productMixChart');
  if (mixCanvas) {
    const data = {
      labels: Object.keys(PACKS).map(k => PACKS[k].label),
      datasets: [{ label: 'Units sold', data: Object.keys(PACKS).map(k => packTotals[k]), backgroundColor: '#4b9cff', borderRadius: 6 }]
    };
    const opts = {
      responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
      scales: { x: { ticks: { color: colors.text }, grid: { display: false } }, y: { ticks: { color: colors.text }, grid: { color: colors.grid } } }
    };
    if (productMixChart) { productMixChart.data = data; productMixChart.update(); }
    else productMixChart = new Chart(mixCanvas.getContext('2d'), { type: 'bar', data, options: opts });
  }

  // ---- Expenses by category (all-time, doughnut) ----
  const catTotals = {};
  (expenses || []).forEach(e => {
    const cat = e.category || 'Other';
    catTotals[cat] = (catTotals[cat] || 0) + (Number(e.amount) || 0);
  });
  const catLabels = Object.keys(catTotals);
  const catColors = ['#f87171', '#fbbf24', '#10b981', '#4b9cff', '#9a72ff', '#ee9a3d', '#27b9b1', '#8fa3ad'];
  const expCanvas = $('expenseCatChart');
  if (expCanvas) {
    const data = {
      labels: catLabels.length ? catLabels : ['No expenses yet'],
      datasets: [{
        data: catLabels.length ? catLabels.map(c => catTotals[c]) : [1],
        backgroundColor: catLabels.length ? catLabels.map((_, i) => catColors[i % catColors.length]) : ['#e5e7eb'],
        borderWidth: 0, hoverOffset: 6
      }]
    };
    const opts = { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { color: colors.text, boxWidth: 12 } } } };
    if (expenseCatChart) { expenseCatChart.data = data; expenseCatChart.update(); }
    else expenseCatChart = new Chart(expCanvas.getContext('2d'), { type: 'doughnut', data, options: opts });
  }

  // ---- Top 5 customers by revenue (all-time, table) ----
  const customerTotals = {};
  (orders || []).forEach(o => {
    if (o.status === 'cancelled') return;
    const name = o.customerName || 'Unknown';
    customerTotals[name] = (customerTotals[name] || 0) + (Number(o.total) || 0);
  });
  const topCustomers = Object.entries(customerTotals).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const tbl = $('topCustomersTable');
  if (tbl) {
    tbl.innerHTML = topCustomers.length
      ? topCustomers.map(([name, total]) => `<tr><td>${escapeHtmlSafe(name)}</td><td>${fmt(total)}</td></tr>`).join('')
      : '<tr><td colspan="2" style="text-align:center;opacity:.5;padding:14px;">No orders recorded yet.</td></tr>';
  }

  // ---- Profit per pack size (all-time) ----
  // Cost is estimated from the CURRENT costing settings (fish prices & mix
  // ratio on the Costing tab) applied to every historical order of that
  // size — actual cost at the time of each order may have differed.
  const mixForCosting = (typeof getMixPct === 'function') ? getMixPct() : { linna: 1, balaya: 0, kawalam: 0 };
  const sizeStats = {};
  Object.keys(PACKS).forEach(k => { sizeStats[k] = { revenue: 0, units: 0 }; });
  (orders || []).forEach(o => {
    if (o.status === 'cancelled') return;
    const key = String(o.product);
    if (!sizeStats[key]) return;
    sizeStats[key].revenue += Number(o.total) || 0;
    sizeStats[key].units += Number(o.qty) || 0;
  });
  const sizeLabels = Object.keys(PACKS).map(k => PACKS[k].label);
  const sizeRevenue = [], sizeCost = [], sizeProfit = [], sizeMargin = [];
  Object.keys(PACKS).forEach(k => {
    const stat = sizeStats[k];
    let unitCost = 0;
    try {
      unitCost = calculatePack(k, state.linnaPrice, state.balayaPrice, state.kawalamPrice, mixForCosting, state.mode, state.targetProfit, state.customSp).totalCost;
    } catch (e) { unitCost = 0; }
    const cost = unitCost * stat.units;
    const profit = stat.revenue - cost;
    sizeRevenue.push(stat.revenue);
    sizeCost.push(cost);
    sizeProfit.push(profit);
    sizeMargin.push(stat.revenue > 0 ? (profit / stat.revenue) * 100 : null);
  });
  const profitSizeCanvas = $('profitBySizeChart');
  if (profitSizeCanvas) {
    const data = {
      labels: sizeLabels,
      datasets: [
        { label: 'Revenue', data: sizeRevenue, backgroundColor: '#4b9cff', borderRadius: 6 },
        { label: 'Est. Cost', data: sizeCost, backgroundColor: '#f87171', borderRadius: 6 },
        { label: 'Est. Profit', data: sizeProfit, backgroundColor: '#10b981', borderRadius: 6 }
      ]
    };
    const opts = {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { color: colors.text, boxWidth: 12 } } },
      scales: { x: { ticks: { color: colors.text }, grid: { display: false } }, y: { ticks: { color: colors.text }, grid: { color: colors.grid } } }
    };
    if (profitBySizeChart) { profitBySizeChart.data = data; profitBySizeChart.update(); }
    else profitBySizeChart = new Chart(profitSizeCanvas.getContext('2d'), { type: 'bar', data, options: opts });
  }
  const noteEl = $('profitBySizeNote');
  if (noteEl) {
    const withMargin = sizeLabels.map((lbl, i) => ({ lbl, margin: sizeMargin[i] })).filter(x => x.margin !== null);
    if (withMargin.length) {
      const best = withMargin.reduce((a, b) => b.margin > a.margin ? b : a);
      const worst = withMargin.reduce((a, b) => b.margin < a.margin ? b : a);
      noteEl.textContent = `Best margin: ${best.lbl} (${fmt2(best.margin)}%). Lowest margin: ${worst.lbl} (${fmt2(worst.margin)}%). Cost is estimated using the current fish prices & mix ratio set in the Costing tab — actual historical cost may vary.`;
    } else {
      noteEl.textContent = 'Cost is estimated using the current fish prices & mix ratio set in the Costing tab — actual historical cost may vary. No sales recorded yet to estimate margins.';
    }
  }

  // ---- New vs Returning customers (this month) + repeat purchase rate (all-time) ----
  // "New" = a customer whose very first non-cancelled order ever falls in the
  // current calendar month. "Returning" = ordered this month but had at least
  // one earlier order. Repeat rate looks at all-time: what share of everyone
  // who has ever ordered has ordered more than once — a simple loyalty signal
  // that's useful once a team is juggling many customers day to day.
  const custFirstOrder = {}, custOrderCount = {};
  (orders || []).forEach(o => {
    if (o.status === 'cancelled') return;
    const d = parseSummaryDate(o.createdAt);
    if (!d) return;
    const name = o.customerName || 'Unknown';
    custOrderCount[name] = (custOrderCount[name] || 0) + 1;
    if (!custFirstOrder[name] || d < custFirstOrder[name]) custFirstOrder[name] = d;
  });
  const totalCustomersAllTime = Object.keys(custOrderCount).length;
  const repeatCustomers = Object.values(custOrderCount).filter(c => c > 1).length;
  const repeatRate = totalCustomersAllTime ? (repeatCustomers / totalCustomersAllTime) * 100 : 0;

  const custOrderedThisMonth = new Set();
  (orders || []).forEach(o => {
    if (o.status === 'cancelled') return;
    const d = parseSummaryDate(o.createdAt);
    if (!d || d.getFullYear() !== now.getFullYear() || d.getMonth() !== now.getMonth()) return;
    custOrderedThisMonth.add(o.customerName || 'Unknown');
  });
  let newThisMonth = 0, returningThisMonth = 0;
  custOrderedThisMonth.forEach(name => {
    const first = custFirstOrder[name];
    if (first && first.getFullYear() === now.getFullYear() && first.getMonth() === now.getMonth()) newThisMonth++;
    else returningThisMonth++;
  });
  set('anNewCustomers', String(newThisMonth));
  set('anReturningCustomers', String(returningThisMonth));
  set('anRepeatRate', totalCustomersAllTime ? fmt2(repeatRate) + '%' : '—');
  set('anRepeatRateSub', totalCustomersAllTime ? `${repeatCustomers} of ${totalCustomersAllTime} customers have ordered more than once` : 'No customers recorded yet');

  const newRetCanvas = $('newReturningChart');
  if (newRetCanvas) {
    const hasAny = newThisMonth + returningThisMonth > 0;
    const data = {
      labels: hasAny ? ['New this month', 'Returning this month'] : ['No orders this month'],
      datasets: [{
        data: hasAny ? [newThisMonth, returningThisMonth] : [1],
        backgroundColor: hasAny ? ['#4b9cff', '#10b981'] : ['#e5e7eb'],
        borderWidth: 0, hoverOffset: 6
      }]
    };
    const opts = { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { color: colors.text, boxWidth: 12 } } } };
    if (newReturningChart) { newReturningChart.data = data; newReturningChart.update(); }
    else newReturningChart = new Chart(newRetCanvas.getContext('2d'), { type: 'doughnut', data, options: opts });
  }

  // ---- Customer churn detection: past customers inactive 30+ days ----
  const CHURN_DAYS = 30;
  const customerLastOrder = {};
  (orders || []).forEach(o => {
    if (o.status === 'cancelled') return;
    const d = parseSummaryDate(o.createdAt);
    if (!d) return;
    const name = o.customerName || 'Unknown';
    const existing = customerLastOrder[name];
    if (!existing || d > existing.date) {
      customerLastOrder[name] = { date: d, phone: o.customerPhone || '', orderCount: (existing ? existing.orderCount : 0) + 1 };
    } else if (existing) {
      existing.orderCount += 1;
    }
  });
  const msPerDay = 1000 * 60 * 60 * 24;
  const churnList = Object.entries(customerLastOrder)
    .map(([name, info]) => ({ name, ...info, daysSince: Math.floor((now - info.date) / msPerDay) }))
    .filter(c => c.daysSince >= CHURN_DAYS)
    .sort((a, b) => b.daysSince - a.daysSince);
  set('anChurnCount', String(churnList.length));
  const churnTbl = $('churnTable');
  if (churnTbl) {
    churnTbl.innerHTML = churnList.length
      ? churnList.slice(0, 10).map(c => `<tr><td>${escapeHtmlSafe(c.name)}</td><td>${c.daysSince} days ago</td><td>${escapeHtmlSafe(c.phone || '-')}</td></tr>`).join('')
      : '<tr><td colspan="3" style="text-align:center;opacity:.5;padding:14px;">All customers ordered within the last 30 days. 🎉</td></tr>';
  }
}
window.renderAnalytics = renderAnalytics;

// ==================== STAFF BUSINESS SUITE ====================
const STAFF_COMMISSION_RATE = 0.12;
const MY_STAFF_DATA_KEY = 'mydrybea_my_staff_data_v5';
const STAFF_CLOUD_TABLES = {
  tasks:'staff_tasks', notices:'staff_announcements', uploads:'staff_referral_uploads',
  performance:'staff_performance', commission:'staff_commission_settings'
};

function escapeHtmlSafe(v){const d=document.createElement('div');d.textContent=String(v??'');return d.innerHTML;}
function effectiveOwnerId(){return userRole==='owner' ? (currentUser?.id||null) : (userProfile?.owner_id||businessId||null);}
function getMyStaffDataState(){try{return JSON.parse(localStorage.getItem(MY_STAFF_DATA_KEY)||'{}')||{};}catch(e){return {};}}
function saveMyStaffDataState(state){try{localStorage.setItem(MY_STAFF_DATA_KEY,JSON.stringify(state));}catch(e){}}
function cacheStaffData(state){saveMyStaffDataState({...getMyStaffDataState(),...state});}
function setMyStaffStatus(text){const el=$('myStaffDataStatus');if(el)el.textContent=text;}
function taskDone(t){return String(t?.status||'pending').toLowerCase()==='completed';}

async function cloudLoadStaffTasks(){
  const owner=effectiveOwnerId(); if(!owner)return [];
  const q=userRole==='owner'
    ? supabase.from('staff_tasks').select('*').eq('owner_id',owner).order('created_at',{ascending:false})
    : supabase.from('staff_tasks').select('*').eq('staff_id',currentUser.id).order('created_at',{ascending:false});
  const {data,error}=await q; if(error)throw error; cacheStaffData({tasks:data||[]}); return data||[];
}

async function cloudLoadNotices(){
  const owner=effectiveOwnerId(); if(!owner)return [];
  const q=userRole==='owner'
    ? supabase.from('staff_announcements').select('*').eq('owner_id',owner).order('created_at',{ascending:false})
    : supabase.from('staff_announcements').select('*').eq('owner_id',owner).eq('active',true).order('created_at',{ascending:false});
  const {data,error}=await q; if(error)throw error; cacheStaffData({notices:data||[]}); return data||[];
}

async function cloudLoadReferralUploads(){
  const owner=effectiveOwnerId(); if(!owner)return [];
  const q=userRole==='owner'
    ? supabase.from('staff_referral_uploads').select('*').eq('owner_id',owner).order('created_at',{ascending:false})
    : supabase.from('staff_referral_uploads').select('*').eq('staff_id',currentUser.id).order('created_at',{ascending:false});
  const {data,error}=await q; if(error)throw error; cacheStaffData({referralUploads:data||[]}); return data||[];
}

async function cloudLoadPerformance(month){
  const owner=effectiveOwnerId(); if(!owner)return [];
  const first=month+'-01';
  const d=new Date(first+'T00:00:00'); d.setMonth(d.getMonth()+1);
  const next=d.toISOString().slice(0,10);
  const q=userRole==='owner'
    ? supabase.from('staff_performance').select('*').eq('owner_id',owner).gte('period_start',first).lt('period_start',next)
    : supabase.from('staff_performance').select('*').eq('staff_id',currentUser.id).gte('period_start',first).lt('period_start',next);
  const {data,error}=await q; if(error)throw error; cacheStaffData({performanceRows:data||[]}); return data||[];
}

async function cloudLoadCommission(){
  const owner=effectiveOwnerId(); if(!owner)return null;
  const {data,error}=await supabase.from('staff_commission_settings').select('*').eq('owner_id',owner).maybeSingle();
  if(error)throw error; if(data)cacheStaffData({commissionSettings:data}); return data;
}

async function cloudEnsureCommission(){
  if(userRole!=='owner'||!currentUser)return;
  const {data,error}=await supabase.from('staff_commission_settings')
    .upsert({owner_id:currentUser.id,rate:STAFF_COMMISSION_RATE,mode:'auto',updated_at:new Date().toISOString()},{onConflict:'owner_id'})
    .select().single();
  if(error)throw error; cacheStaffData({commissionSettings:data});
}

async function saveMyStaffData(silent=false){
  if(!currentUser||userRole!=='owner')return;
  try{
    await cloudEnsureCommission();
    await Promise.all([
      cloudLoadStaffTasks(),cloudLoadNotices(),cloudLoadReferralUploads(),
      cloudLoadPerformance(new Date().toISOString().slice(0,7)),cloudLoadCommission()
    ]);
    cacheStaffData({ownerId:currentUser.id,savedAt:new Date().toISOString()});
    setMyStaffStatus('☁️ Synced '+new Date().toLocaleTimeString());
    if(!silent)updateStatus('☁️ MY STAFF synced with Supabase');
  }catch(e){
    console.error('MY STAFF save:',e); setMyStaffStatus('⚠️ Cloud sync failed — local cache kept');
    if(!silent)alert('❌ MY STAFF sync failed: '+e.message);
  }
}

async function loadMyStaffData(showStatus=false){
  if(!currentUser)return;
  try{
    await Promise.all([
      cloudLoadStaffTasks(),cloudLoadNotices(),cloudLoadReferralUploads(),
      cloudLoadPerformance(new Date().toISOString().slice(0,7)),cloudLoadCommission()
    ]);
    setMyStaffStatus('☁️ Loaded from Supabase '+new Date().toLocaleTimeString());
    if(showStatus)updateStatus('☁️ MY STAFF cloud data loaded');
  }catch(e){
    console.error('MY STAFF cloud load:',e); setMyStaffStatus('⚠️ Cloud unavailable — local cache active');
    if(showStatus)updateStatus('⚠️ Cloud unavailable — using local cache');
  }
  renderOwnerStaffPerformance();renderOwnerStaffManagement();renderStaffTasks();renderStaffAnnouncements();renderOwnerStaffUploads();
}

function exportMyStaffData(){
  if(!currentUser||userRole!=='owner')return;
  const state={...getMyStaffDataState(),exportedAt:new Date().toISOString(),ownerId:currentUser.id};
  const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='mydrybea_my_staff_backup_'+todayStr()+'.json';a.click();URL.revokeObjectURL(a.href);
  updateStatus('⬇️ MY STAFF backup exported');
}

async function importMyStaffData(ev){
  if(!currentUser||userRole!=='owner')return; const file=ev.target.files?.[0]; if(!file)return;
  const r=new FileReader();
  r.onload=async()=>{if(!(await ensureFreshSession()))return;try{
    const state=JSON.parse(r.result); if(state.ownerId&&state.ownerId!==currentUser.id)throw new Error('This backup belongs to another owner.');
    saveMyStaffDataState({...state,ownerId:currentUser.id});
    if(Array.isArray(state.tasks))for(const t of state.tasks){
      const row={owner_id:currentUser.id,staff_id:t.staff_id,title:t.title,description:t.description||null,status:t.status||'pending',priority:t.priority||'normal',due_date:t.due_date||null};
      const {error}=await supabase.from('staff_tasks').insert(row);if(error)throw error;
    }
    if(Array.isArray(state.notices))for(const n of state.notices){
      const {error}=await supabase.from('staff_announcements').insert({owner_id:currentUser.id,title:n.title,message:n.message||n.body||'',active:n.active!==false});if(error)throw error;
    }
    await loadMyStaffData(true);updateStatus('✅ MY STAFF backup imported');
  }catch(e){alert('❌ Import failed: '+e.message);}finally{ev.target.value='';}}; r.readAsText(file);
}

function getStaffLocalTasks(){
  const c=getMyStaffDataState().tasks; return Array.isArray(c)?c.filter(x=>String(x.staff_id)===String(currentUser?.id)):[];
}

async function addStaffTask(){
  if(userRole!=='owner'){alert('Tasks are assigned by the business owner.');return;}
  if(!currentUser)return; const title=($('staffTaskTitle')?.value||'').trim(),priority=$('staffTaskPriority')?.value||'normal';
  if(!title)return alert('Enter a task first.'); const owner=effectiveOwnerId();
  if(!(await ensureFreshSession()))return;try{
    const {data,error}=await supabase.from('staff_tasks').insert({owner_id:owner,staff_id:currentUser.id,title,priority,status:'pending'}).select().single();
    if(error)throw error; cacheStaffData({tasks:[data,...(getMyStaffDataState().tasks||[])]}); $('staffTaskTitle').value='';
    renderStaffTasks();refreshStaffHome();updateStatus('✅ Task saved to Supabase');
  }catch(e){alert('❌ Task save failed: '+e.message);}
}

async function toggleStaffTask(id){
  if(!(await ensureFreshSession()))return;try{
    const task=(getMyStaffDataState().tasks||[]).find(t=>t.id===id); if(!task)return;
    const next=taskDone(task)?'pending':'completed';
    const {data,error}=await supabase.from('staff_tasks').update({status:next,completed_at:next==='completed'?new Date().toISOString():null,updated_at:new Date().toISOString()}).eq('id',id).eq('staff_id',currentUser.id).select().single();
    if(error)throw error; cacheStaffData({tasks:(getMyStaffDataState().tasks||[]).map(x=>x.id===id?data:x)});renderStaffTasks();refreshStaffHome();
  }catch(e){alert('❌ Task update failed: '+e.message);}
}

async function deleteStaffTask(id){
  if(userRole==='staff'){ alert('Tasks are assigned and managed by the business owner. You can mark them Done/Reopen.'); return; }
  if(!(await ensureFreshSession()))return;try{const {error}=await supabase.from('staff_tasks').delete().eq('id',id).eq('staff_id',currentUser.id);if(error)throw error;cacheStaffData({tasks:(getMyStaffDataState().tasks||[]).filter(x=>x.id!==id)});renderStaffTasks();refreshStaffHome();}
  catch(e){alert('❌ Task delete failed: '+e.message);}
}

function renderStaffTasks(){
  const list=getStaffLocalTasks(),el=$('staffTaskList');if(!el)return;
  const rows=list.length?list.map(x=>`<div class="task-row"><div class="task-main ${taskDone(x)?'task-done':''}"><strong>${escapeHtmlSafe(x.title)}</strong><small><span class="priority-pill ${x.priority==='high'?'high':'normal'}">${x.priority==='high'?'HIGH':'NORMAL'}</span> · ${new Date(x.created_at||Date.now()).toLocaleDateString()}</small></div><div style="display:flex;gap:6px;"><button class="btn btn-sm ${taskDone(x)?'':'btn-primary'}" data-action="toggleStaffTask" data-id="${x.id}"><i class="business-icon" data-lucide="${taskDone(x)?'rotate-ccw':'check'}"></i><span>${taskDone(x)?'Reopen':'Done'}</span></button></div></div>`).join(''):'<div class="notice">No assigned tasks yet.</div>';
  el.innerHTML=rows;if(window.lucide)lucide.createIcons();
  const home=$('staffHomeTasksList');if(home)home.innerHTML=list.filter(x=>!taskDone(x)).slice(0,4).map(x=>`<div class="task-row"><div class="task-main"><strong>${escapeHtmlSafe(x.title)}</strong><small>${x.priority==='high'?'High priority':'Normal'}</small></div><i class="business-icon" data-lucide="chevron-right"></i></div>`).join('')||'<div class="notice">No open tasks.</div>';if(window.lucide)lucide.createIcons();
}

function getStaffNotices(){const c=getMyStaffDataState().notices;return Array.isArray(c)?c:[];}
function renderStaffAnnouncements(){
  const list=getStaffNotices();
  const html=list.map(n=>`<div class="notice-row"><div class="notice-main"><strong>${escapeHtmlSafe(n.title)}</strong><small>${escapeHtmlSafe(n.message||n.body||'')} · ${new Date(n.created_at||Date.now()).toLocaleDateString()}</small></div><i class="business-icon" data-lucide="bell"></i></div>`).join('')||'<div class="notice">No announcements yet.</div>';
  if($('staffNoticeList'))$('staffNoticeList').innerHTML=html;if(window.lucide)lucide.createIcons();
  if($('staffHomeNotices'))$('staffHomeNotices').innerHTML=list.slice(0,3).map(n=>`<div class="notice-row"><div class="notice-main"><strong>${escapeHtmlSafe(n.title)}</strong><small>${escapeHtmlSafe(n.message||n.body||'')}</small></div></div>`).join('')||'<div class="notice">No notices yet.</div>';
}

function refreshMyCommission(){
  if(!currentUser)return;const now=new Date(),y=now.getFullYear(),m=now.getMonth();
  const claims=(window.staffCommissionClaims||[]).filter(c=>c.status==='approved');
  const eligible=claims.filter(c=>{const d=new Date(c.verified_at||c.submitted_at||0);return String(c.staff_id)===String(currentUser.id)&&d.getFullYear()===y&&d.getMonth()===m;});
  const sales=eligible.reduce((s,c)=>s+(Number(c.order_total)||0),0),commission=eligible.reduce((s,c)=>s+(Number(c.commission_amount)||0),0);
  if($('commissionMonthTotal'))$('commissionMonthTotal').textContent=fmt(commission);if($('commissionSalesTotal'))$('commissionSalesTotal').textContent=fmt(sales);if($('commissionSalesCount'))$('commissionSalesCount').textContent=eligible.length;
  const body=$('commissionHistoryBody');if(body)body.innerHTML=eligible.map(c=>`<tr><td>${new Date(c.verified_at||c.submitted_at||Date.now()).toLocaleDateString()}</td><td>${escapeHtmlSafe(c.customer_name||'Customer')}</td><td>${fmt(Number(c.order_total)||0)}</td><td>${fmt(Number(c.commission_amount)||0)}</td><td><span class="status-pill approved">approved</span></td></tr>`).join('')||'<tr><td colspan="5" style="text-align:center;opacity:.5;padding:14px;">No eligible sales this month.</td></tr>';
}

// REMOVED (anti-cheat): this used to let staff insert self-reported sales
// numbers with zero verification against real orders. Real commission is
// calculated only from verified orders -> staff_commission_claims -> owner
// approval (see verifyCommissionClaim()), which cannot be faked this way.
function parseReferralUploadText(text,name){if(/\.json$/i.test(name)){const x=JSON.parse(text);return Array.isArray(x)?x:(Array.isArray(x.records)?x.records:[]);}const lines=text.split(/\r?\n/).filter(x=>x.trim());if(lines.length<2)return [];const headers=lines[0].split(',').map(x=>x.trim().replace(/^"|"$/g,''));return lines.slice(1).map(line=>{const vals=line.split(',').map(x=>x.trim().replace(/^"|"$/g,''));const o={};headers.forEach((h,i)=>o[h]=vals[i]||'');return o;});}
function getStaffReferralUploads(){const c=getMyStaffDataState().referralUploads;return Array.isArray(c)?c:[];}

async function deleteStaffReferralUpload(id){
  if(userRole!=='owner'||!confirm('Delete this uploaded referral data?'))return;
  // Current RLS grants staff/owner read and staff insert. Do not issue a delete that the current policy set cannot authorize.
  alert('This upload is retained for audit. Deletion is disabled by the current Supabase RLS policy.');
}

function getOwnerPerformanceState(){
  const rows=getMyStaffDataState().performanceRows||[];const local=getMyStaffDataState().performanceEdits||{};const out={};
  rows.forEach(x=>{out[x.staff_id]={...x};});Object.keys(local).forEach(k=>{out[k]={...(out[k]||{}),...local[k]};});return out;
}
function saveOwnerPerformanceLocal(staffId,patch){
  const state=getMyStaffDataState(),edits=state.performanceEdits||{};edits[staffId]={...(edits[staffId]||{}),...patch,updated_at:new Date().toISOString()};saveMyStaffDataState({...state,performanceEdits:edits});
}
async function saveOwnerPerformance(staffId,patch){
  if(userRole!=='owner')return;saveOwnerPerformanceLocal(staffId,patch);setMyStaffStatus('✓ Performance note saved locally');
}
async function editOwnerStaffPerformance(staffId){
  if(userRole!=='owner')return;try{const target=Number($('staffTarget_'+staffId)?.value)||0,note=$('staffNote_'+staffId)?.value||'',status=$('staffStatus_'+staffId)?.value||'active';await saveOwnerPerformance(staffId,{target,note,status});renderOwnerStaffPerformance();updateStatus('✓ Staff performance settings saved locally');}catch(e){alert('❌ Performance save failed: '+e.message);}
}

async function ownerAssignStaffTask(){
  if(!currentUser||userRole!=='owner')return;const staffId=$('ownerTaskStaff')?.value||'',title=($('ownerTaskTitle')?.value||'').trim(),priority=$('ownerTaskPriority')?.value||'normal';if(!staffId||!title)return alert('Select a staff member and enter a task.');
  if(!(await ensureFreshSession()))return;try{const {data,error}=await supabase.from('staff_tasks').insert({owner_id:currentUser.id,staff_id:staffId,title,priority,status:'pending'}).select().single();if(error)throw error;cacheStaffData({tasks:[data,...(getMyStaffDataState().tasks||[])]});$('ownerTaskTitle').value='';renderOwnerStaffPerformance();renderOwnerStaffManagement();updateStatus('☁️ Task assigned to Supabase');}catch(e){alert('❌ Task assign failed: '+e.message);}
}

async function ownerPublishNotice(){
  if(!currentUser||userRole!=='owner')return;const title=($('ownerNoticeTitle')?.value||'').trim(),message=($('ownerNoticeBody')?.value||'').trim();if(!title||!message)return alert('Enter a notice title and message.');
  if(!(await ensureFreshSession()))return;try{const {data,error}=await supabase.from('staff_announcements').insert({owner_id:currentUser.id,title,message,active:true}).select().single();if(error)throw error;cacheStaffData({notices:[data,...(getMyStaffDataState().notices||[])]});$('ownerNoticeTitle').value='';$('ownerNoticeBody').value='';renderOwnerStaffManagement();renderStaffAnnouncements();updateStatus('☁️ Notice published to Supabase');}catch(e){alert('❌ Notice publish failed: '+e.message);}
}
async function ownerEditTask(id){if(userRole!=='owner')return;const task=(getMyStaffDataState().tasks||[]).find(x=>x.id===id);if(!task)return;const newTitle=prompt('Task title:',task.title||'');if(newTitle===null||!newTitle.trim())return;if(!(await ensureFreshSession()))return;try{const {data,error}=await supabase.from('staff_tasks').update({title:newTitle.trim(),updated_at:new Date().toISOString()}).eq('id',id).eq('owner_id',currentUser.id).select().single();if(error)throw error;cacheStaffData({tasks:(getMyStaffDataState().tasks||[]).map(x=>x.id===id?data:x)});renderOwnerStaffManagement();updateStatus('✅ Task updated');}catch(e){alert('❌ Task update failed: '+e.message);}}
window.ownerEditTask = ownerEditTask;
async function ownerToggleTask(id){if(userRole!=='owner')return;if(!(await ensureFreshSession()))return;try{const task=(getMyStaffDataState().tasks||[]).find(x=>x.id===id);if(!task)return;const {data,error}=await supabase.from('staff_tasks').update({status:taskDone(task)?'pending':'completed',completed_at:taskDone(task)?null:new Date().toISOString(),updated_at:new Date().toISOString()}).eq('id',id).eq('owner_id',currentUser.id).select().single();if(error)throw error;cacheStaffData({tasks:(getMyStaffDataState().tasks||[]).map(x=>x.id===id?data:x)});renderOwnerStaffManagement();renderOwnerStaffPerformance();}catch(e){alert('❌ Task update failed: '+e.message);}}
async function ownerDeleteTask(id){if(userRole!=='owner'||!confirm('Delete this task?'))return;if(!(await ensureFreshSession()))return;try{const {error}=await supabase.from('staff_tasks').delete().eq('id',id).eq('owner_id',currentUser.id);if(error)throw error;cacheStaffData({tasks:(getMyStaffDataState().tasks||[]).filter(x=>x.id!==id)});renderOwnerStaffManagement();renderOwnerStaffPerformance();}catch(e){alert('❌ Task delete failed: '+e.message);}}
async function ownerEditNotice(id){if(userRole!=='owner')return;const notice=(getMyStaffDataState().notices||[]).find(x=>x.id===id);if(!notice)return;const newTitle=prompt('Notice title:',notice.title||'');if(newTitle===null)return;const newMsg=prompt('Notice message:',notice.message||notice.body||'');if(newMsg===null)return;if(!(await ensureFreshSession()))return;try{const {data,error}=await supabase.from('staff_announcements').update({title:newTitle.trim(),message:newMsg.trim()}).eq('id',id).eq('owner_id',currentUser.id).select().single();if(error)throw error;cacheStaffData({notices:(getMyStaffDataState().notices||[]).map(x=>x.id===id?data:x)});renderOwnerStaffManagement();renderStaffAnnouncements();updateStatus('✅ Notice updated');}catch(e){alert('❌ Notice update failed: '+e.message);}}
window.ownerEditNotice = ownerEditNotice;
async function ownerDeleteNotice(id){if(userRole!=='owner'||!confirm('Delete this notice?'))return;if(!(await ensureFreshSession()))return;try{const {error}=await supabase.from('staff_announcements').delete().eq('id',id).eq('owner_id',currentUser.id);if(error)throw error;cacheStaffData({notices:(getMyStaffDataState().notices||[]).filter(x=>x.id!==id)});renderOwnerStaffManagement();renderStaffAnnouncements();}catch(e){alert('❌ Notice delete failed: '+e.message);}}

function renderOwnerStaffPerformance(){
  const list=staffListCache||[],month=new Date().toISOString().slice(0,7),perf=getOwnerPerformanceState();
  const claims=(window.staffCommissionClaims||[]).filter(c=>c.status==='approved' && String(c.submitted_at||c.verified_at||'').slice(0,7)===month);
  let totalSales=0,totalCommission=0;
  const rows=list.map(st=>{
    const eligible=claims.filter(c=>String(c.staff_id)===String(st.id));
    const sales=eligible.reduce((a,c)=>a+(Number(c.order_total)||0),0),commission=eligible.reduce((a,c)=>a+(Number(c.commission_amount)||0),0);totalSales+=sales;totalCommission+=commission;
    const open=(getMyStaffDataState().tasks||[]).filter(t=>String(t.staff_id)===String(st.id)&&!taskDone(t)).length,p=perf[st.id]||{};
    return `<tr><td><strong>${escapeHtmlSafe(st.display_name||'(no name)')}</strong><br><small>${escapeHtmlSafe(st.staff_reference||st.id||'')}</small></td><td><select id="staffStatus_${st.id}" class="staff-edit-input"><option value="active" ${(p.status||'active')==='active'?'selected':''}>Active</option><option value="paused" ${p.status==='paused'?'selected':''}>Paused</option></select></td><td>${eligible.length}</td><td>${fmt(sales)}</td><td><strong>12%</strong><br><small>Owner verified</small></td><td>${fmt(commission)}</td><td>${open}</td><td><input id="staffTarget_${st.id}" class="staff-edit-input" type="number" min="0" value="${Number(p.target)||0}" placeholder="Rs."></td><td><input id="staffNote_${st.id}" class="staff-edit-input" value="${escapeHtmlSafe(p.note||p.notes||'')}" placeholder="Owner note"></td><td><button class="btn btn-sm btn-primary" data-action="editOwnerStaffPerformance" data-id="${st.id}"><i class="business-icon" data-lucide="save"></i></button></td></tr>`;
  }).join('')||'<tr><td colspan="10" style="text-align:center;opacity:.5;padding:18px;">No staff added yet.</td></tr>';
  if($('ownerStaffPerformanceBody'))$('ownerStaffPerformanceBody').innerHTML=rows;if($('ownerStaffCount'))$('ownerStaffCount').textContent=list.length;if($('ownerStaffSales'))$('ownerStaffSales').textContent=fmt(totalSales);if($('ownerStaffCommission'))$('ownerStaffCommission').textContent=fmt(totalCommission);if($('ownerCommissionTotal2'))$('ownerCommissionTotal2').textContent=fmt(totalCommission);
  if($('ownerCommissionBody'))$('ownerCommissionBody').innerHTML=list.map(st=>{const cs=claims.filter(c=>String(c.staff_id)===String(st.id));const sales=cs.reduce((a,c)=>a+(Number(c.order_total)||0),0),commission=cs.reduce((a,c)=>a+(Number(c.commission_amount)||0),0);return `<tr><td>${escapeHtmlSafe(st.display_name||'(no name)')}</td><td>${fmt(sales)}</td><td>${fmt(commission)}</td></tr>`;}).join('')||'<tr><td colspan="3" style="text-align:center;opacity:.5;padding:18px;">No owner-verified commission sales this month.</td></tr>';
  const sel=$('ownerTaskStaff');if(sel){const prev=sel.value;sel.innerHTML='<option value="">-- Select staff --</option>'+list.map(st=>`<option value="${st.id}">${escapeHtmlSafe(st.display_name||'(no name)')}</option>`).join('');if(list.some(x=>x.id===prev))sel.value=prev;}
  if(window.lucide)lucide.createIcons();
}
function renderOwnerStaffManagement(){
  const tasks=getMyStaffDataState().tasks||[],notices=getMyStaffDataState().notices||[];
  const taskEl=$('ownerStaffTaskManagement');if(taskEl)taskEl.innerHTML=tasks.length?tasks.map(t=>`<div class="notice-row"><div class="notice-main"><strong>${escapeHtmlSafe(t.title)}</strong><small>${escapeHtmlSafe((staffListCache||[]).find(s=>String(s.id)===String(t.staff_id))?.display_name||t.staff_id||'Staff')} · ${taskDone(t)?'Completed':'Open'}</small></div>${actionMenuHTML([{label:taskDone(t)?'Reopen':'Mark Done',icon:taskDone(t)?'↺':'✅',onclick:`ownerToggleTask('${t.id}')`},{label:'Edit',icon:'✏️',onclick:`ownerEditTask('${t.id}')`},{label:'Delete',icon:'🗑️',danger:true,onclick:`ownerDeleteTask('${t.id}')`}])}</div>`).join(''):'<div class="notice">No assigned tasks.</div>';
  const noticeEl=$('ownerStaffNoticeManagement');if(noticeEl)noticeEl.innerHTML=notices.length?notices.map(n=>`<div class="notice-row"><div class="notice-main"><strong>${escapeHtmlSafe(n.title)}</strong><small>${escapeHtmlSafe(n.message||n.body||'')}</small></div>${actionMenuHTML([{label:'Edit',icon:'✏️',onclick:`ownerEditNotice('${n.id}')`},{label:'Delete',icon:'🗑️',danger:true,onclick:`ownerDeleteNotice('${n.id}')`}])}</div>`).join(''):'<div class="notice">No notices published.</div>';
}

function renderOwnerStaffUploads(){
  const el=$('ownerStaffUploadBody');if(!el)return;const list=getStaffReferralUploads();
  el.innerHTML=list.length?list.map(x=>{let meta={};try{meta=JSON.parse(x.notes||'{}')||{};}catch(e){}const staff=(staffListCache||[]).find(s=>String(s.id)===String(x.staff_id));return `<tr><td>${escapeHtmlSafe(staff?.display_name||meta.staff_name||x.staff_id||'Staff')}</td><td>${escapeHtmlSafe(meta.month||'-')}</td><td>${fmt(Number(meta.sales)||0)}</td><td>${Number(meta.record_count)||0}</td><td>${new Date(x.created_at||Date.now()).toLocaleString()}</td><td><span class="badge badge-pending">Retained</span></td></tr>`;}).join(''):'<tr><td colspan="6" style="text-align:center;opacity:.5;padding:18px;">No staff uploads yet.</td></tr>';
}

async function populateStaffReferralSelectors(){
  if(!currentUser) return;
  try{
    if(userRole==='owner') await loadStaffList();
    const list=staffListCache||[];
    const options='<option value="">No referral / Auto</option>'+list.map(s=>`<option value="${s.id}">${escapeHtmlSafe(s.display_name||'Staff')} — ${escapeHtmlSafe(s.staff_reference||'No Ref')}</option>`).join('');
    if($('custReferralStaffSelect')) $('custReferralStaffSelect').innerHTML=options;
    if($('orderReferralStaffSelect')) $('orderReferralStaffSelect').innerHTML=options;
  }catch(e){console.error('Staff reference selector error',e);}
}

// ==================== PRODUCT DISTRIBUTOR (PRODUCT AGENT) COMMISSION ====================
// Distributors are a separate account role (see profiles.role = 'distributor').
// Commission on a distributor-attributed sale is a flat rate set entirely by the
// distributor's lifetime APPROVED sales volume tier (not per-order factors):
//   Rs. 1 – 100,000      → 6%
//   Rs. 100,001 – 200,000 → 7%
//   Rs. 200,001 – 300,000 → 8%
//   Rs. 300,001 – 400,000 → 9%
//   Rs. 400,001 – 500,000 → 10%
//   Rs. 500,001+          → 12%
// The tier used for a new order is based on the distributor's volume BEFORE that
// order (i.e. their current standing) — the rate then locks in on that claim even
// as their lifetime volume keeps climbing afterward.
// The owner is the one who records the sale and picks the distributor (like the existing
// staff-referral flow), so no separate owner-verification step is needed — but the
// commission itself is only real once the order is actually delivered. The claim is
// created 'pending' at order time and flipped to 'approved' (or 'rejected' if the
// order is cancelled first) by finalizeDistributorCommissionForOrder(), called from
// cycleStatus(), confirmDelivery() and confirmBatchDelivery().
const DISTRIBUTOR_COMMISSION_TIERS = [
  { max: 100000,   rate: 0.06, label: 'Bronze'   },
  { max: 200000,   rate: 0.07, label: 'Silver'   },
  { max: 300000,   rate: 0.08, label: 'Gold'     },
  { max: 400000,   rate: 0.09, label: 'Platinum' },
  { max: 500000,   rate: 0.10, label: 'Diamond'  },
  { max: Infinity, rate: 0.12, label: 'Elite'    },
];
const DISTRIBUTOR_COMMISSION_MIN = DISTRIBUTOR_COMMISSION_TIERS[0].rate;
const DISTRIBUTOR_COMMISSION_MAX = DISTRIBUTOR_COMMISSION_TIERS[DISTRIBUTOR_COMMISSION_TIERS.length - 1].rate;

// Given a lifetime approved-volume figure, returns { index, tier, nextTier, intoTier, remainingToNext }.
function resolveDistributorTier(totalVolume){
  const vol = Number(totalVolume) || 0;
  let idx = DISTRIBUTOR_COMMISSION_TIERS.findIndex(t => vol <= t.max);
  if (idx === -1) idx = DISTRIBUTOR_COMMISSION_TIERS.length - 1;
  const tier = DISTRIBUTOR_COMMISSION_TIERS[idx];
  const nextTier = DISTRIBUTOR_COMMISSION_TIERS[idx + 1] || null;
  const prevCap = idx === 0 ? 0 : DISTRIBUTOR_COMMISSION_TIERS[idx - 1].max;
  const intoTier = vol - prevCap;
  const remainingToNext = nextTier ? Math.max(0, tier.max - vol) : 0;
  return { index: idx, tier, nextTier, intoTier, remainingToNext };
}

function computeDistributorStats(distributorId){
  const claims = (window.distributorCommissionClaims || []).filter(c =>
    String(c.distributor_id) === String(distributorId) && c.status === 'approved'
  );
  const totalVolume = claims.reduce((s,c)=>s+(Number(c.order_total)||0),0);
  const totalCommission = claims.reduce((s,c)=>s+(Number(c.commission_amount)||0),0);
  const salesCount = claims.length;
  // Payout tracking: of the commission actually earned (status='approved'), how
  // much has the owner marked as paid out vs. still owed. payout_status defaults
  // to 'unpaid' (via DB default) for every row until the owner marks it 'paid'.
  const totalPaid = claims.filter(c => c.payout_status === 'paid').reduce((s,c)=>s+(Number(c.commission_amount)||0),0);
  const totalUnpaid = totalCommission - totalPaid;

  const { tier, nextTier, remainingToNext, intoTier } = resolveDistributorTier(totalVolume);
  const marketingLevel = tier.label;
  const currentRate = tier.rate;
  const tierSpan = tier.max === Infinity ? 0 : tier.max - (DISTRIBUTOR_COMMISSION_TIERS[DISTRIBUTOR_COMMISSION_TIERS.indexOf(tier) - 1]?.max || 0);
  const tierProgressPct = nextTier ? Math.min(100, Math.max(0, tierSpan ? (intoTier / tierSpan) * 100 : 100)) : 100;

  // Kept for backward-compat display only (not used in rate calculation anymore).
  let businessQuality = 'New';
  if (salesCount >= 3) {
    const avgOrder = totalVolume / salesCount;
    if (avgOrder >= 15000) businessQuality = 'Excellent';
    else if (avgOrder >= 8000) businessQuality = 'Good';
    else businessQuality = 'Standard';
  }

  return {
    totalVolume, totalCommission, salesCount, marketingLevel, businessQuality,
    currentRate, nextTierLabel: nextTier ? nextTier.label : null,
    nextTierRate: nextTier ? nextTier.rate : null, remainingToNext, tierProgressPct,
    totalPaid, totalUnpaid,
  };
}

// Flat tier-based rate — the distributor's CURRENT standing (lifetime approved
// volume before this order) decides the rate for the whole order. orderTotal is
// accepted for call-site compatibility but no longer affects the rate.
function computeDistributorCommissionRate(distributorId, orderTotal){
  const stats = computeDistributorStats(distributorId);
  return stats.currentRate;
}

// Called once an order's fate is known — delivered (commission becomes real)
// or cancelled (commission never happens). Matches on order_id and only
// touches claims still 'pending', so it's safe to call for every order status
// change even when that order never had a distributor attached (no-op) or its
// claim was already finalized (no-op).
async function finalizeDistributorCommissionForOrder(orderId, outcome){
  if (!orderId) return;
  try {
    const update = outcome === 'approved'
      ? { status: 'approved', verified_at: new Date().toISOString() }
      : { status: 'rejected' };
    const { error } = await withSessionRetry(() => supabase.from('distributor_commission_claims')
      .update(update)
      .eq('order_id', String(orderId))
      .eq('status', 'pending'));
    if (error) { console.error('Distributor commission finalize failed:', error); return; }
    loadDistributorCommissionClaims();
  } catch (e) { console.error('Distributor commission finalize error:', e); }
}
window.finalizeDistributorCommissionForOrder = finalizeDistributorCommissionForOrder;

async function loadDistributorCommissionClaims(){
  if (!currentUser || (userRole !== 'owner' && userRole !== 'distributor')) return [];
  if (userRole === 'distributor' && !distributorCommissionRealtimeChannel) startDistributorCommissionRealtime();
  try {
    const query = userRole === 'owner'
      ? supabase.from('distributor_commission_claims').select('*').eq('owner_id', currentUser.id).order('submitted_at', { ascending: false })
      : supabase.from('distributor_commission_claims').select('*').eq('distributor_id', currentUser.id).order('submitted_at', { ascending: false });
    const { data, error } = await query;
    if (error) throw error;
    window.distributorCommissionClaims = data || [];
    // BUGFIX: this data refresh used to be completely silent — a new
    // distributor sale (owner side) or a commission being approved/rejected
    // (distributor side) updated the underlying arrays/UI but never fired a
    // toast/sound/notification-center entry like every other event in the
    // app does. See notifyDistributorClaimChanges() for the actual alert.
    notifyDistributorClaimChanges(window.distributorCommissionClaims, userRole);
    if (userRole === 'owner') renderDistributorsPanel();
    if (userRole === 'distributor') { renderProductAgentPage(); renderDistributorHome(); }
    return window.distributorCommissionClaims;
  } catch (e) {
    console.error('Distributor commission claims load:', e);
    return [];
  }
}

// Owner marks an earned (status='approved') distributor commission claim as
// paid out / not-yet-paid. Only the owner can touch payout — distributors can
// see their payout status but never set it themselves.
async function markDistributorCommissionPaid(claimId, note){
  if (userRole !== 'owner') { alert('Only the owner can mark a commission as paid.'); return; }
  if (!claimId) return;
  try{
    const update = { payout_status: 'paid', paid_at: new Date().toISOString() };
    if (note !== undefined) update.paid_note = note || null;
    const { error } = await withSessionRetry(() => supabase.from('distributor_commission_claims')
      .update(update).eq('id', String(claimId)).eq('status', 'approved'));
    if (error) { console.error('Mark distributor commission paid failed:', error); alert('❌ Could not mark as paid: ' + error.message); return; }
    await loadDistributorCommissionClaims();
    updateStatus('💰 Commission marked as paid');
  }catch(e){ console.error('Mark distributor commission paid error:', e); alert('❌ Could not mark as paid: ' + e.message); }
}
window.markDistributorCommissionPaid = markDistributorCommissionPaid;

// Reverts a claim back to unpaid — for correcting an accidental "Mark Paid" tap.
async function markDistributorCommissionUnpaid(claimId){
  if (userRole !== 'owner') { alert('Only the owner can change payout status.'); return; }
  if (!claimId) return;
  try{
    const { error } = await withSessionRetry(() => supabase.from('distributor_commission_claims')
      .update({ payout_status: 'unpaid', paid_at: null }).eq('id', String(claimId)));
    if (error) { console.error('Mark distributor commission unpaid failed:', error); alert('❌ Could not undo payout: ' + error.message); return; }
    await loadDistributorCommissionClaims();
    updateStatus('↩️ Commission reverted to unpaid');
  }catch(e){ console.error('Mark distributor commission unpaid error:', e); alert('❌ Could not undo payout: ' + e.message); }
}
window.markDistributorCommissionUnpaid = markDistributorCommissionUnpaid;

// Bulk action: marks every currently-filtered, earned-but-unpaid claim as paid
// in one go (e.g. "pay out everything owed to this distributor this month").
async function markFilteredDistributorCommissionsPaid(){
  if (userRole !== 'owner') { alert('Only the owner can mark commissions as paid.'); return; }
  const claims = getFilteredDistActivityCommissionClaims().filter(c => c.status === 'approved' && c.payout_status !== 'paid');
  if (!claims.length) { alert('Nothing unpaid in the current filter.'); return; }
  if (!confirm(`Mark ${claims.length} earned commission(s) totalling Rs. ${fmt(claims.reduce((s,c)=>s+(Number(c.commission_amount)||0),0))} as paid?`)) return;
  try{
    const ids = claims.map(c => String(c.id));
    const { error } = await withSessionRetry(() => supabase.from('distributor_commission_claims')
      .update({ payout_status: 'paid', paid_at: new Date().toISOString() }).in('id', ids).eq('status', 'approved'));
    if (error) { console.error('Bulk mark paid failed:', error); alert('❌ Could not mark as paid: ' + error.message); return; }
    await loadDistributorCommissionClaims();
    updateStatus(`💰 ${ids.length} commission(s) marked as paid`);
  }catch(e){ console.error('Bulk mark paid error:', e); alert('❌ Could not mark as paid: ' + e.message); }
}
window.markFilteredDistributorCommissionsPaid = markFilteredDistributorCommissionsPaid;

function renderDistributorsPanel(){
  const tbody = $('distributorsBody');
  if (!tbody) return;
  // The owner can now attribute sales to themselves via the "Me (Owner)"
  // option in New Order, so their own commission tier/earnings need a row
  // here too — otherwise there'd be no way to see it once they start using it.
  const selfRow = (userRole === 'owner' && currentUser) ? (() => {
    const stats = computeDistributorStats(currentUser.id);
    const selfName = (userProfile && userProfile.display_name) || (currentUser.email ? currentUser.email.split('@')[0] : 'Me');
    const selfRef = (userProfile && userProfile.distributor_reference) || ('AGT-' + currentUser.id.slice(0,8).toUpperCase());
    return `<tr style="background:var(--surface-2,#f6fef9);">
      <td>⭐ ${escapeHtmlSafe(selfName)} <span style="font-size:.68rem;color:var(--text-muted);">(Me)</span></td>
      <td>${escapeHtmlSafe(selfRef)}</td>
      <td>${stats.marketingLevel}</td>
      <td>${stats.businessQuality}</td>
      <td>${fmt(stats.totalCommission)}</td>
    </tr>`;
  })() : '';
  if (!distributorListCache.length) {
    tbody.innerHTML = selfRow || '<tr><td colspan="5" style="text-align:center;opacity:.5;padding:14px;">No product distributors added yet.</td></tr>';
    return;
  }
  tbody.innerHTML = selfRow + distributorListCache.map(d => {
    const stats = computeDistributorStats(d.id);
    return `<tr>
      <td>${escapeHtmlSafe(d.display_name || '(no name)')}</td>
      <td>${escapeHtmlSafe(d.distributor_reference || ('AGT-' + String(d.id).slice(0,8).toUpperCase()))}</td>
      <td>${stats.marketingLevel}</td>
      <td>${stats.businessQuality}</td>
      <td>${fmt(stats.totalCommission)}</td>
    </tr>`;
  }).join('');
}

function renderDistributorTierProgress(stats, elId){
  const el = $(elId);
  if (!el) return;
  if (!stats.nextTierLabel) {
    el.innerHTML = `<div class="notice" style="margin:10px 0 0;font-size:.75rem;color:#15803d;"><i class="business-icon icon-inline" data-lucide="trophy"></i> You've reached <b>Elite</b> — the top commission tier (12%). Every future approved sale earns the maximum rate.</div>`;
  } else {
    el.innerHTML = `
      <div style="margin-top:12px;">
        <div style="display:flex;justify-content:space-between;font-size:.72rem;color:var(--text-muted);margin-bottom:4px;">
          <span><b>${escapeHtmlSafe(stats.marketingLevel)}</b> — ${(stats.currentRate*100).toFixed(0)}% now</span>
          <span>Rs. ${fmt(stats.remainingToNext)} to <b>${escapeHtmlSafe(stats.nextTierLabel)}</b> (${(stats.nextTierRate*100).toFixed(0)}%)</span>
        </div>
        <div style="background:var(--surface-2,#eee);border-radius:99px;height:8px;overflow:hidden;">
          <div style="background:var(--accent-green,#1a9c5b);height:100%;border-radius:99px;width:${stats.tierProgressPct}%;transition:width .4s ease;"></div>
        </div>
      </div>`;
  }
  if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } });
}

function renderProductAgentPage(){
  if (userRole !== 'distributor' || !currentUser) return;
  const stats = computeDistributorStats(currentUser.id);
  if ($('distMarketingLevel')) $('distMarketingLevel').textContent = stats.marketingLevel;
  if ($('distBusinessQuality')) $('distBusinessQuality').textContent = stats.businessQuality;
  if ($('distCurrentRateRange')) $('distCurrentRateRange').textContent = (stats.currentRate * 100).toFixed(0) + '%';
  if ($('distTotalVolume')) $('distTotalVolume').textContent = fmt(stats.totalVolume);
  if ($('distTotalCommission')) $('distTotalCommission').textContent = fmt(stats.totalCommission);
  if ($('distSalesCount')) $('distSalesCount').textContent = stats.salesCount;
  if ($('distTotalPaid')) $('distTotalPaid').textContent = fmt(stats.totalPaid);
  if ($('distTotalUnpaid')) $('distTotalUnpaid').textContent = fmt(stats.totalUnpaid);
  renderDistributorTierProgress(stats, 'distTierProgress');
  const body = $('distCommissionHistoryBody');
  if (body) {
    const claims = window.distributorCommissionClaims || [];
    body.innerHTML = claims.map(c => {
      const isPaid = (c.payout_status || 'unpaid') === 'paid';
      const payoutCell = c.status !== 'approved'
        ? '<span style="opacity:.4;">—</span>'
        : (isPaid ? '<span class="status-pill approved">✅ Paid</span>' : '<span class="status-pill pending">Unpaid</span>');
      return `<tr>
        <td>${new Date(c.submitted_at || Date.now()).toLocaleDateString()}</td>
        <td>${escapeHtmlSafe(c.order_ref_no || '-')}</td>
        <td>${fmt(Number(c.order_total) || 0)}</td>
        <td>${((Number(c.commission_rate) || 0) * 100).toFixed(1)}%</td>
        <td>${fmt(Number(c.commission_amount) || 0)}</td>
        <td><span class="status-pill ${c.status === 'approved' ? 'approved' : c.status === 'rejected' ? 'rejected' : 'pending'}">${c.status === 'approved' ? 'Earned' : c.status === 'rejected' ? 'Cancelled' : 'Pending delivery'}</span></td>
        <td>${payoutCell}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" style="text-align:center;opacity:.5;padding:14px;">No commission earned yet.</td></tr>';
  }
}
window.renderProductAgentPage = renderProductAgentPage;

// ==================== DISTRIBUTOR: COMMISSION EARNED SUMMARY (advanced report) ====================
// A dedicated, print/export-friendly analytics page for a distributor's own
// commission history — month-by-month trend, status mix, payout history and
// a "best month" callout. Reuses the same distributorCommissionClaims cache
// already loaded for Home/My Income, so opening this tab needs no extra fetch
// beyond the usual loadDistributorCommissionClaims() refresh.
let distCommTrendChart = null, distCommStatusChart = null;

function distCommMonthKey(dateStr){
  const d = new Date(dateStr || Date.now());
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
}
function distCommMonthLabel(key){
  const [y,m] = key.split('-').map(Number);
  return new Date(y, m-1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}
function distCommMonthShortLabel(key){
  const [y,m] = key.split('-').map(Number);
  return new Date(y, m-1, 1).toLocaleDateString(undefined, { month: 'short' }) + " '" + String(y).slice(-2);
}

function renderDistCommissionSummary(){
  if (userRole !== 'distributor' || !currentUser) return;
  const allClaims = window.distributorCommissionClaims || [];
  const earned = allClaims.filter(c => c.status === 'approved');
  const stats = computeDistributorStats(currentUser.id);
  const colors = (typeof getChartColors === 'function') ? getChartColors() : { text:'#334155', grid:'rgba(0,0,0,.08)' };

  // ---- Group EARNED claims into calendar-month buckets (all-time) ----
  const buckets = {}; // key -> { count, volume, commission, paid, unpaid }
  earned.forEach(c => {
    const key = distCommMonthKey(c.submitted_at);
    if (!buckets[key]) buckets[key] = { count:0, volume:0, commission:0, paid:0, unpaid:0 };
    const b = buckets[key];
    b.count++;
    b.volume += Number(c.order_total)||0;
    const amt = Number(c.commission_amount)||0;
    b.commission += amt;
    if ((c.payout_status||'unpaid') === 'paid') b.paid += amt; else b.unpaid += amt;
  });
  const allKeys = Object.keys(buckets).sort(); // chronological, oldest first

  // ---- This month vs last month (for the growth indicator) ----
  const now = new Date();
  const thisKey = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth()-1, 1);
  const lastKey = lastMonthDate.getFullYear() + '-' + String(lastMonthDate.getMonth()+1).padStart(2,'0');
  const thisMonthCommission = buckets[thisKey]?.commission || 0;
  const lastMonthCommission = buckets[lastKey]?.commission || 0;
  let growthText = '—', growthGood = true;
  if (lastMonthCommission > 0) {
    const pct = ((thisMonthCommission - lastMonthCommission) / lastMonthCommission) * 100;
    growthGood = pct >= 0;
    growthText = (pct >= 0 ? '▲ ' : '▼ ') + Math.abs(pct).toFixed(1) + '% vs last month';
  } else if (thisMonthCommission > 0) {
    growthText = '✨ First earnings this month'; growthGood = true;
  } else {
    growthText = 'No earnings yet this month'; growthGood = false;
  }

  // ---- Best month, all-time ----
  let bestKey = null, bestAmt = -1;
  allKeys.forEach(k => { if (buckets[k].commission > bestAmt) { bestAmt = buckets[k].commission; bestKey = k; } });

  // ---- Populate hero + stat grid ----
  if ($('commSummaryPeriod')) $('commSummaryPeriod').textContent = now.toLocaleDateString(undefined,{month:'long',year:'numeric'});
  if ($('commSummaryThisMonth')) $('commSummaryThisMonth').textContent = fmt(thisMonthCommission);
  if ($('commSummaryGrowth')) { $('commSummaryGrowth').textContent = growthText; $('commSummaryGrowth').style.color = growthGood ? '#15803d' : '#b91c1c'; }
  if ($('commSummaryLifetime')) $('commSummaryLifetime').textContent = fmt(stats.totalCommission);
  if ($('commSummaryUnpaid')) $('commSummaryUnpaid').textContent = fmt(stats.totalUnpaid);
  if ($('commSummaryPaid')) $('commSummaryPaid').textContent = fmt(stats.totalPaid);
  if ($('commSummaryAvgPerSale')) $('commSummaryAvgPerSale').textContent = fmt(stats.salesCount ? Math.round(stats.totalCommission/stats.salesCount) : 0);
  if ($('commSummarySalesCount')) $('commSummarySalesCount').textContent = stats.salesCount;
  if ($('commSummaryBestMonth')) $('commSummaryBestMonth').textContent = bestKey ? distCommMonthLabel(bestKey) : '—';
  if ($('commSummaryBestMonthAmt')) $('commSummaryBestMonthAmt').textContent = bestKey ? ('Rs. ' + fmt(bestAmt) + ' earned') : 'No earnings recorded yet';
  if ($('commSummaryTierLabel')) $('commSummaryTierLabel').textContent = stats.marketingLevel + ' — ' + (stats.currentRate*100).toFixed(0) + '%';
  renderDistributorTierProgress(stats, 'commSummaryTierProgress');

  // ---- Monthly trend chart: last 12 calendar months, zero-filled ----
  const last12Keys = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth()-i, 1);
    last12Keys.push(d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0'));
  }
  const trendCanvas = $('distCommTrendChart');
  if (trendCanvas && window.Chart) {
    const data = {
      labels: last12Keys.map(k => distCommMonthShortLabel(k)),
      datasets: [{
        label: 'Commission Earned',
        data: last12Keys.map(k => buckets[k]?.commission || 0),
        backgroundColor: last12Keys.map(k => k === thisKey ? '#d4af37' : 'rgba(16,185,129,.65)'),
        borderRadius: 6, maxBarThickness: 34
      }]
    };
    const opts = {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { ticks: { color: colors.text, maxRotation: 0 }, grid: { display: false } }, y: { ticks: { color: colors.text }, grid: { color: colors.grid } } }
    };
    if (distCommTrendChart) { distCommTrendChart.data = data; distCommTrendChart.options = opts; distCommTrendChart.update(); }
    else distCommTrendChart = new Chart(trendCanvas.getContext('2d'), { type: 'bar', data, options: opts });
  }

  // ---- Status mix donut: all-time claim counts by status ----
  const statusCanvas = $('distCommStatusChart');
  if (statusCanvas && window.Chart) {
    const pendingCount = allClaims.filter(c => c.status === 'pending').length;
    const approvedCount = earned.length;
    const rejectedCount = allClaims.filter(c => c.status === 'rejected').length;
    const data = {
      labels: ['Earned', 'Pending Delivery', 'Cancelled'],
      datasets: [{ data: [approvedCount, pendingCount, rejectedCount], backgroundColor: ['#10b981','#f59e0b','#ef4444'], borderWidth: 0, hoverOffset: 6 }]
    };
    const opts = { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { color: colors.text, boxWidth: 12 } } } };
    if (distCommStatusChart) { distCommStatusChart.data = data; distCommStatusChart.update(); }
    else distCommStatusChart = new Chart(statusCanvas.getContext('2d'), { type: 'doughnut', data, options: opts });
  }

  // ---- Monthly breakdown table: most recent first ----
  const tbody = $('commSummaryMonthlyBody');
  if (tbody) {
    const rows = allKeys.slice().reverse();
    tbody.innerHTML = rows.map(k => {
      const b = buckets[k];
      return `<tr${k===thisKey ? ' style="background:var(--surface-2,#f6fef9);"' : ''}>
        <td><strong>${distCommMonthLabel(k)}</strong></td>
        <td>${b.count}</td>
        <td>${fmt(b.volume)}</td>
        <td>${fmt(b.commission)}</td>
        <td>${fmt(b.paid)}</td>
        <td>${b.unpaid > 0 ? `<span class="status-pill pending">${fmt(b.unpaid)}</span>` : fmt(0)}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="6" style="text-align:center;opacity:.5;padding:14px;">No commission earned yet.</td></tr>';
  }

  // ---- Recent payouts: last 8 claims the owner has marked paid ----
  const payoutBody = $('commSummaryPayoutsBody');
  if (payoutBody) {
    const paidClaims = earned.filter(c => (c.payout_status||'unpaid') === 'paid' && c.paid_at)
      .sort((a,b) => new Date(b.paid_at) - new Date(a.paid_at)).slice(0, 8);
    payoutBody.innerHTML = paidClaims.map(c => `<tr>
        <td>${new Date(c.paid_at).toLocaleDateString()}</td>
        <td>${escapeHtmlSafe(c.order_ref_no || '-')}</td>
        <td>${fmt(Number(c.commission_amount)||0)}</td>
        <td>${escapeHtmlSafe(c.paid_note || '-')}</td>
      </tr>`).join('') || '<tr><td colspan="4" style="text-align:center;opacity:.5;padding:14px;">No payouts recorded yet.</td></tr>';
  }

  if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } });
}
window.renderDistCommissionSummary = renderDistCommissionSummary;

function exportDistCommissionSummaryCSV(){
  const allClaims = window.distributorCommissionClaims || [];
  const earned = allClaims.filter(c => c.status === 'approved');
  const buckets = {};
  earned.forEach(c => {
    const key = distCommMonthKey(c.submitted_at);
    if (!buckets[key]) buckets[key] = { count:0, volume:0, commission:0, paid:0, unpaid:0 };
    const b = buckets[key];
    b.count++; b.volume += Number(c.order_total)||0;
    const amt = Number(c.commission_amount)||0; b.commission += amt;
    if ((c.payout_status||'unpaid') === 'paid') b.paid += amt; else b.unpaid += amt;
  });
  const rows = [['Month','Sales Count','Order Volume','Commission Earned','Paid','Unpaid']];
  Object.keys(buckets).sort().forEach(k => {
    const b = buckets[k];
    rows.push([distCommMonthLabel(k), b.count, b.volume, b.commission, b.paid, b.unpaid]);
  });
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type:'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'my-commission-summary.csv'; document.body.appendChild(a); a.click(); a.remove();
}
window.exportDistCommissionSummaryCSV = exportDistCommissionSummaryCSV;

// ==================== DISTRIBUTOR: HOME (Product Agent overview, separate from My Income) ====================
// Lightweight dashboard a distributor lands on first. Reuses the same stats
// and claims already loaded for My Income — no extra fetch needed.
function renderDistributorHome() {
  if (userRole !== 'distributor' || !currentUser) return;
  if (!$('distHomeLevel')) return; // panel not on this page
  const name = (userProfile && userProfile.display_name) || currentUser.email?.split('@')[0] || 'Agent';
  if ($('distHomeName')) $('distHomeName').textContent = name;
  const refId = (userProfile && userProfile.distributor_reference) || ('AGT-' + currentUser.id.slice(0,8).toUpperCase());
  if ($('distHomeRefId')) $('distHomeRefId').textContent = refId;

  const stats = computeDistributorStats(currentUser.id);
  if ($('distHomeLevel')) $('distHomeLevel').textContent = stats.marketingLevel;
  if ($('distHomeRate')) $('distHomeRate').textContent = (stats.currentRate * 100).toFixed(0) + '%';
  if ($('distHomeSalesCount')) $('distHomeSalesCount').textContent = stats.salesCount;
  if ($('distHomeCommission')) $('distHomeCommission').textContent = fmt(stats.totalCommission);
  renderDistributorTierProgress(stats, 'distHomeTierProgress');
  hideSkeletons('distributor-home');

  const body = $('distHomeRecentBody');
  if (body) {
    const claims = (window.distributorCommissionClaims || []).slice(0, 5);
    body.innerHTML = claims.length ? claims.map(c => {
      const isPaid = (c.payout_status || 'unpaid') === 'paid';
      const payoutBadge = c.status !== 'approved' ? '' : (isPaid ? ' <span class="status-pill approved" style="font-size:.65rem;">Paid</span>' : ' <span class="status-pill pending" style="font-size:.65rem;">Unpaid</span>');
      return `<tr>
        <td>${new Date(c.submitted_at || Date.now()).toLocaleDateString()}</td>
        <td>${escapeHtmlSafe(c.order_ref_no || '-')}</td>
        <td>${fmt(Number(c.commission_amount) || 0)}</td>
        <td><span class="status-pill ${c.status === 'approved' ? 'approved' : c.status === 'rejected' ? 'rejected' : 'pending'}">${c.status === 'approved' ? 'Earned' : c.status === 'rejected' ? 'Cancelled' : 'Pending'}</span>${payoutBadge}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="4" style="text-align:center;opacity:.5;padding:14px;">No commission earned yet.</td></tr>';
  }
  if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } });
}
window.renderDistributorHome = renderDistributorHome;

async function loadCommissionClaims(){
  if(currentUser && userRole==='owner' && !commissionRealtimeChannel) startCommissionRealtime();
  if(!currentUser) return [];
  try{
    const q=userRole==='owner'
      ? supabase.from('staff_commission_claims').select('*').eq('owner_id',currentUser.id).order('submitted_at',{ascending:false})
      : supabase.from('staff_commission_claims').select('*').eq('staff_id',currentUser.id).order('submitted_at',{ascending:false});
    const {data,error}=await q; if(error) throw error;
    window.staffCommissionClaims=data||[];
    renderCommissionClaims();
    return data||[];
  }catch(e){console.error('Commission claims load:',e); return [];}
}

function renderCommissionClaims(){
  const body=$('ownerCommissionClaimsBody'); if(body && userRole==='owner'){
    const list=window.staffCommissionClaims||[];
    body.innerHTML=list.map(c=>`<tr><td><strong>${escapeHtmlSafe(c.staff_reference||'-')}</strong></td><td><strong>${escapeHtmlSafe(c.order_ref_no||'-')}</strong><br><small>${escapeHtmlSafe(c.order_id||'-')}</small></td><td>${escapeHtmlSafe(c.customer_name||'-')}</td><td>${fmt(Number(c.order_total)||0)}</td><td>${c.status==='approved'?fmt(Number(c.commission_amount)||0):'—'}</td><td><span class="status-pill ${c.status==='approved'?'approved':c.status==='rejected'?'rejected':'pending'}">${escapeHtmlSafe(c.status)}</span></td><td>${c.status==='pending'?`<button type="button" class="btn btn-xs btn-primary" onclick="verifyCommissionClaim('${c.id}','approved')">Approve</button> <button type="button" class="btn btn-xs btn-danger" onclick="verifyCommissionClaim('${c.id}','rejected')">Reject</button>`:'Verified'}</td></tr>`).join('')||'<tr><td colspan="7" style="text-align:center;opacity:.5;padding:18px;">No commission claims.</td></tr>';
  }
}

let commissionRealtimeChannel = null;
let commissionRealtimeTimer = null;
let commissionRefreshBusy = false;

async function refreshCommissionRealtime(){
  if(!currentUser || userRole!=='owner' || commissionRefreshBusy) return;
  if(document.hidden) return; // skip background work while the app tab isn't visible
  commissionRefreshBusy = true;
  try{
    await loadCommissionClaims();
    await loadOrdersFromCloud();
    try{ await loadStaffList(); }catch(e){}
    try{ await loadMyStaffData(false); }catch(e){}
    // A distributor placing (or being marked delivered for) an order from
    // their OWN Distributor app page writes straight to
    // distributor_commission_claims — it never touches staff_commission_claims
    // or orders in a way the two calls above would catch. Without this, the
    // owner's "Product Distributors" panel and the Distributor Activity Hub
    // (Sales tab) only ever updated when the OWNER themselves created/finalized
    // a distributor-attributed order — never when the distributor did it.
    try{ await loadDistributorCommissionClaims(); }catch(e){}
    renderOwnerStaffPerformance();
    renderOwnerStaffManagement();
    renderOrders();
    updateOrderStats();
    calcAll(); calcDashboard(); calcProduction(); updateMonthlySummary();
    refreshStaffHome(); refreshMyCommission();
    // Keep the Distributor Activity Hub (Sales tab) in sync too, if it's
    // the tab currently open — these are all null-safe no-ops otherwise.
    if (typeof renderDistActivityOverview === 'function') renderDistActivityOverview();
    if (typeof renderDistActivityCommission === 'function') renderDistActivityCommission();
  }catch(e){ console.warn('Commission realtime refresh:',e); }
  finally{ commissionRefreshBusy=false; }
}

function startCommissionRealtime(){
  if(!currentUser || userRole!=='owner' || !window.supabase) return;
  try{
    if(commissionRealtimeChannel){ supabase.removeChannel(commissionRealtimeChannel); commissionRealtimeChannel=null; }
    commissionRealtimeChannel = supabase.channel('mydrybea-commission-live')
      .on('postgres_changes',{event:'*',schema:'public',table:'staff_commission_claims',filter:`owner_id=eq.${currentUser.id}`},()=>refreshCommissionRealtime())
      .on('postgres_changes',{event:'*',schema:'public',table:'orders',filter:`user_id=eq.${currentUser.id}`},()=>refreshCommissionRealtime())
      // NEW: an order (and its commission claim) created or finalized from the
      // Distributor app page — by the distributor themselves — now reaches
      // the owner's screen the same way a staff sale already did.
      .on('postgres_changes',{event:'*',schema:'public',table:'distributor_commission_claims',filter:`owner_id=eq.${currentUser.id}`},()=>refreshCommissionRealtime())
      .subscribe((status)=>{ if(status==='SUBSCRIBED') console.log('MY DRYBEA commission realtime: connected'); });
    if(commissionRealtimeTimer) clearInterval(commissionRealtimeTimer);
    // Realtime channel above already pushes instant updates; this is just a safety-net
    // fallback in case a websocket event is missed, so it doesn't need to run every 5s.
    commissionRealtimeTimer=setInterval(()=>refreshCommissionRealtime(),45000);
  }catch(e){ console.warn('Commission realtime setup:',e); }
}

function stopCommissionRealtime(){
  try{ if(commissionRealtimeTimer) clearInterval(commissionRealtimeTimer); }catch(e){}
  commissionRealtimeTimer=null;
  try{ if(commissionRealtimeChannel) supabase.removeChannel(commissionRealtimeChannel); }catch(e){}
  commissionRealtimeChannel=null;
}

// ==================== DISTRIBUTOR: LIVE COMMISSION SYNC ====================
// Mirrors startCommissionRealtime()/stopCommissionRealtime() above, but for the
// distributor role. Without this, a distributor's commission claim being
// created (order placed) or flipped to 'approved' (order delivered) never
// reached their screen until they manually refreshed the page.
let distributorCommissionRealtimeChannel = null;
let distributorCommissionRealtimeTimer = null;
let distributorCommissionRefreshBusy = false;

async function refreshDistributorCommissionRealtime(){
  if(!currentUser || userRole!=='distributor' || distributorCommissionRefreshBusy) return;
  if(document.hidden) return; // skip background work while the app tab isn't visible
  distributorCommissionRefreshBusy = true;
  try{
    await loadDistributorCommissionClaims();
  }catch(e){ console.warn('Distributor commission realtime refresh:',e); }
  finally{ distributorCommissionRefreshBusy=false; }
}

function startDistributorCommissionRealtime(){
  if(!currentUser || userRole!=='distributor' || !window.supabase) return;
  try{
    if(distributorCommissionRealtimeChannel){ supabase.removeChannel(distributorCommissionRealtimeChannel); distributorCommissionRealtimeChannel=null; }
    distributorCommissionRealtimeChannel = supabase.channel('mydrybea-distributor-commission-live-'+currentUser.id)
      .on('postgres_changes',{event:'*',schema:'public',table:'distributor_commission_claims',filter:`distributor_id=eq.${currentUser.id}`},()=>refreshDistributorCommissionRealtime())
      .subscribe((status)=>{ if(status==='SUBSCRIBED') console.log('MY DRYBEA distributor commission realtime: connected'); });
    if(distributorCommissionRealtimeTimer) clearInterval(distributorCommissionRealtimeTimer);
    // Realtime channel above already pushes instant updates; this is just a safety-net
    // fallback in case a websocket event is missed (e.g. app was backgrounded on mobile).
    distributorCommissionRealtimeTimer=setInterval(()=>refreshDistributorCommissionRealtime(),45000);
  }catch(e){ console.warn('Distributor commission realtime setup:',e); }
}

function stopDistributorCommissionRealtime(){
  try{ if(distributorCommissionRealtimeTimer) clearInterval(distributorCommissionRealtimeTimer); }catch(e){}
  distributorCommissionRealtimeTimer=null;
  try{ if(distributorCommissionRealtimeChannel) supabase.removeChannel(distributorCommissionRealtimeChannel); }catch(e){}
  distributorCommissionRealtimeChannel=null;
}

// ==================== DISTRIBUTOR ACTIVITY HUB (Sales tab, owner-only) ====================
// A separate owner-facing workspace for managing distributors' field activity,
// commission and performance, built inside the Sales tab. This is intentionally
// NOT merged with, and does not move, the "Product Distributors" add/list panel
// that lives in Profile → Manage Staff (#distributorsBody / renderDistributorsPanel) —
// that panel stays exactly where it is and is still how distributor accounts get
// added. This hub reuses the same distributorListCache + distributor_commission_claims
// data already loaded for that panel, and adds a new distributor_activities table
// for manual field-activity logging (visits, calls, samples, follow-ups, notes).
//
// REQUIRED ONE-TIME SUPABASE SETUP (run once in the SQL editor):
//
//   create table if not exists public.distributor_activities (
//     id uuid primary key default gen_random_uuid(),
//     owner_id uuid not null references auth.users(id) on delete cascade,
//     distributor_id uuid not null references auth.users(id) on delete cascade,
//     activity_type text not null check (activity_type in ('visit','call','sample_drop','order_followup','payment_followup','note','other')),
//     activity_date date not null default current_date,
//     notes text,
//     outcome text check (outcome in ('positive','neutral','negative','no_response')),
//     next_followup_date date,
//     created_by uuid not null references auth.users(id),
//     created_at timestamptz not null default now()
//   );
//   alter table public.distributor_activities enable row level security;
//   create policy "Owner can manage own distributor activities"
//     on public.distributor_activities for all
//     using (owner_id = auth.uid())
//     with check (owner_id = auth.uid());
//   create index if not exists distributor_activities_owner_idx on public.distributor_activities(owner_id);
//   create index if not exists distributor_activities_dist_idx on public.distributor_activities(distributor_id);
//
// Until that table exists, the Activity Log tab still renders (empty) and shows
// a clear error on save instead of silently failing — Overview and Commission
// tabs work immediately since they only read data that already exists.
//
// ==================== DISTRIBUTOR COMMISSION PAYOUT TRACKING (Paid/Unpaid) ====================
// Separate from `status` (pending/approved/rejected — whether the commission was
// EARNED). `payout_status` tracks whether the owner has actually PAID OUT an
// earned (status='approved') commission to the distributor. Only earned claims
// are ever payable; pending/rejected claims are never marked paid.
//
// REQUIRED ONE-TIME SUPABASE SETUP (run once in the SQL editor):
//
//   alter table public.distributor_commission_claims
//     add column if not exists payout_status text not null default 'unpaid'
//       check (payout_status in ('unpaid','paid')),
//     add column if not exists paid_at timestamptz,
//     add column if not exists paid_note text;
//
// Until these columns exist, every claim is treated as 'unpaid' in the UI (the
// column read simply comes back undefined), and the "Mark Paid" action will
// fail with a clear Supabase error instead of silently doing nothing.

const DIST_ACTIVITY_TYPES = {
  visit: '🚶 Field Visit', call: '📞 Phone Call', sample_drop: '📦 Sample Drop',
  order_followup: '🧾 Order Follow-up', payment_followup: '💰 Payment Follow-up',
  note: '📝 Note', other: '• Other'
};
const DIST_ACTIVITY_OUTCOMES = {
  positive: '🟢 Positive', neutral: '🟡 Neutral', negative: '🔴 Negative', no_response: '⚪ No Response'
};
const DIST_FOLLOWUP_DUE_DAYS = 14; // no logged activity within this many days => "due"

let distributorActivitiesCache = [];

function populateDistActivityDistSelects(){
  const list = distributorListCache || [];
  const logOpts = '<option value="">-- Select distributor --</option>' + list.map(d =>
    `<option value="${d.id}">${escapeHtmlSafe(d.display_name || 'Distributor')} — ${escapeHtmlSafe(d.distributor_reference || ('AGT-' + String(d.id).slice(0,8).toUpperCase()))}</option>`
  ).join('');
  const filterOpts = '<option value="">All Distributors</option>' + list.map(d =>
    `<option value="${d.id}">${escapeHtmlSafe(d.display_name || 'Distributor')}</option>`
  ).join('');
  if ($('distActLogDistSelect')) { const cur=$('distActLogDistSelect').value; $('distActLogDistSelect').innerHTML = logOpts; $('distActLogDistSelect').value = cur; }
  if ($('distActLogFilterDist')) { const cur=$('distActLogFilterDist').value; $('distActLogFilterDist').innerHTML = filterOpts; $('distActLogFilterDist').value = cur; }
  if ($('distActCommDistFilter')) { const cur=$('distActCommDistFilter').value; $('distActCommDistFilter').innerHTML = filterOpts; $('distActCommDistFilter').value = cur; }
  if ($('distActLogFilterType') && !$('distActLogFilterType').dataset.filled) {
    $('distActLogFilterType').innerHTML = '<option value="">All Types</option>' +
      Object.entries(DIST_ACTIVITY_TYPES).map(([k,v]) => `<option value="${k}">${v}</option>`).join('');
    $('distActLogFilterType').dataset.filled = '1';
  }
}

function switchDistActivityView(view){
  document.querySelectorAll('.dist-act-switch button[data-dist-act-tab]').forEach(b => b.classList.toggle('is-active', b.dataset.distActTab === view));
  document.querySelectorAll('.dist-act-view[data-dist-act-view]').forEach(p => p.classList.toggle('is-active', p.dataset.distActView === view));
}
window.switchDistActivityView = switchDistActivityView;

async function loadDistributorActivities(){
  if (!currentUser || userRole !== 'owner') return [];
  try{
    const { data, error } = await withSessionRetry(() => supabase.from('distributor_activities')
      .select('*').eq('owner_id', currentUser.id).order('activity_date', { ascending: false }).order('created_at', { ascending: false }));
    if (error) throw error;
    distributorActivitiesCache = data || [];
    return distributorActivitiesCache;
  }catch(e){
    // Quiet failure (e.g. the SQL setup above hasn't been run yet) — Overview
    // and Commission tabs still work fine without this data.
    console.warn('Distributor activities load skipped:', e?.message || e);
    distributorActivitiesCache = [];
    return [];
  }
}

async function initDistributorActivityPanel(){
  if (userRole !== 'owner' || !currentUser) return;
  populateDistActivityDistSelects();
  if ($('distActLogDate') && !$('distActLogDate').value) $('distActLogDate').value = new Date().toISOString().slice(0,10);
  await Promise.all([ loadDistributorCommissionClaims(), loadDistributorActivities() ]);
  populateDistActivityDistSelects(); // distributorListCache may have just finished loading in parallel
  renderDistActivityOverview();
  renderDistActivityCommission();
  renderDistActivityLog();
}
window.initDistributorActivityPanel = initDistributorActivityPanel;

function lastActivityForDistributor(distId){
  const rows = distributorActivitiesCache.filter(a => String(a.distributor_id) === String(distId));
  if (!rows.length) return null;
  return rows.reduce((latest, r) => (!latest || new Date(r.activity_date) > new Date(latest.activity_date)) ? r : latest, null);
}

function distFollowupBadge(distId){
  const today = new Date(); today.setHours(0,0,0,0);
  const upcoming = distributorActivitiesCache
    .filter(a => String(a.distributor_id) === String(distId) && a.next_followup_date)
    .sort((a,b) => new Date(a.next_followup_date) - new Date(b.next_followup_date))[0];
  if (upcoming) {
    const due = new Date(upcoming.next_followup_date);
    const diffDays = Math.round((due - today) / 86400000);
    if (diffDays <= 0) return { cls:'due', label:'Follow-up due' };
    if (diffDays <= 3) return { cls:'soon', label:`Follow-up in ${diffDays}d` };
    return { cls:'ok', label:`Follow-up ${due.toLocaleDateString()}` };
  }
  const last = lastActivityForDistributor(distId);
  if (!last) return { cls:'due', label:'No activity yet' };
  const daysSince = Math.round((today - new Date(last.activity_date)) / 86400000);
  if (daysSince >= DIST_FOLLOWUP_DUE_DAYS) return { cls:'due', label:`${daysSince}d since last activity` };
  if (daysSince >= DIST_FOLLOWUP_DUE_DAYS - 5) return { cls:'soon', label:`${daysSince}d since last activity` };
  return { cls:'ok', label:`${daysSince}d since last activity` };
}

function renderDistActivityOverview(){
  const body = $('distActOverviewBody');
  const list = distributorListCache || [];
  if ($('distActStatCount')) $('distActStatCount').textContent = list.length;
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
  const activeThisMonth = new Set(distributorActivitiesCache.filter(a => new Date(a.activity_date) >= monthStart).map(a => String(a.distributor_id)));
  if ($('distActStatActive')) $('distActStatActive').textContent = activeThisMonth.size;
  const claims = window.distributorCommissionClaims || [];
  const commissionThisMonth = claims.filter(c => c.status === 'approved' && c.submitted_at && new Date(c.submitted_at) >= monthStart)
    .reduce((s,c) => s + (Number(c.commission_amount)||0), 0);
  if ($('distActStatCommission')) $('distActStatCommission').textContent = fmt(commissionThisMonth);
  const followupsDue = list.filter(d => distFollowupBadge(d.id).cls === 'due').length;
  if ($('distActStatFollowup')) $('distActStatFollowup').textContent = followupsDue;

  if (!body) return;
  if (!list.length) {
    body.innerHTML = '<tr><td colspan="8" style="text-align:center;opacity:.5;padding:14px;">No product distributors added yet. Add one from Profile → Manage Staff.</td></tr>';
    return;
  }
  body.innerHTML = list.map(d => {
    const stats = computeDistributorStats(d.id);
    const badge = distFollowupBadge(d.id);
    const last = lastActivityForDistributor(d.id);
    return `<tr>
      <td>${escapeHtmlSafe(d.display_name || '(no name)')}</td>
      <td>${escapeHtmlSafe(d.distributor_reference || ('AGT-' + String(d.id).slice(0,8).toUpperCase()))}</td>
      <td>${stats.marketingLevel}</td>
      <td>${fmt(stats.totalVolume)}</td>
      <td>${fmt(stats.totalCommission)}</td>
      <td>${last ? new Date(last.activity_date).toLocaleDateString() : '—'}</td>
      <td><span class="dist-act-followup-badge ${badge.cls}">${badge.label}</span></td>
      <td><button type="button" class="btn btn-xs" onclick="jumpToDistActivityLog('${d.id}')">Log Activity</button></td>
    </tr>`;
  }).join('');
}
window.renderDistActivityOverview = renderDistActivityOverview;

function jumpToDistActivityLog(distId){
  switchDistActivityView('log');
  if ($('distActLogDistSelect')) $('distActLogDistSelect').value = distId;
}
window.jumpToDistActivityLog = jumpToDistActivityLog;

// Shared filter logic for the Commission tab — used by the render function,
// the bulk "mark paid" action and the CSV export, so all three always agree
// on what's currently in view.
function getFilteredDistActivityCommissionClaims(){
  const distFilter = $('distActCommDistFilter')?.value || '';
  const statusFilter = $('distActCommStatusFilter')?.value || '';
  const payoutFilter = $('distActCommPayoutFilter')?.value || '';
  const from = $('distActCommFrom')?.value ? new Date($('distActCommFrom').value) : null;
  const to = $('distActCommTo')?.value ? new Date($('distActCommTo').value + 'T23:59:59') : null;
  let claims = (window.distributorCommissionClaims || []).slice();
  if (distFilter) claims = claims.filter(c => String(c.distributor_id) === String(distFilter));
  if (statusFilter) claims = claims.filter(c => c.status === statusFilter);
  if (payoutFilter) claims = claims.filter(c => (c.payout_status || 'unpaid') === payoutFilter);
  if (from) claims = claims.filter(c => c.submitted_at && new Date(c.submitted_at) >= from);
  if (to) claims = claims.filter(c => c.submitted_at && new Date(c.submitted_at) <= to);
  return claims;
}

function renderDistActivityCommission(){
  const body = $('distActCommissionBody');
  if (!body) return;
  const claims = getFilteredDistActivityCommissionClaims();

  const totalCount = claims.length;
  const totalOrder = claims.reduce((s,c) => s + (Number(c.order_total)||0), 0);
  const earnedClaims = claims.filter(c => c.status === 'approved');
  const totalCommission = earnedClaims.reduce((s,c) => s + (Number(c.commission_amount)||0), 0);
  const totalUnpaid = earnedClaims.filter(c => (c.payout_status||'unpaid') !== 'paid').reduce((s,c) => s + (Number(c.commission_amount)||0), 0);
  const totalPaidOut = totalCommission - totalUnpaid;
  if ($('distActCommFilteredCount')) $('distActCommFilteredCount').textContent = totalCount;
  if ($('distActCommFilteredTotal')) $('distActCommFilteredTotal').textContent = fmt(totalOrder);
  if ($('distActCommFilteredCommission')) $('distActCommFilteredCommission').textContent = fmt(totalCommission);
  if ($('distActCommFilteredUnpaid')) $('distActCommFilteredUnpaid').textContent = fmt(totalUnpaid);
  if ($('distActCommFilteredPaid')) $('distActCommFilteredPaid').textContent = fmt(totalPaidOut);

  const nameFor = (id) => { const d = (distributorListCache||[]).find(x => String(x.id)===String(id)); return d ? (d.display_name || 'Distributor') : 'Distributor'; };

  body.innerHTML = claims.map(c => {
    const isPaid = (c.payout_status || 'unpaid') === 'paid';
    let payoutCell;
    if (c.status !== 'approved') {
      payoutCell = '<span style="opacity:.4;">—</span>';
    } else if (isPaid) {
      payoutCell = `<span class="status-pill approved">✅ Paid</span>${c.paid_at ? `<br><small style="opacity:.6;">${new Date(c.paid_at).toLocaleDateString()}</small>` : ''}`;
    } else {
      payoutCell = '<span class="status-pill pending">Unpaid</span>';
    }
    let actionCell = '—';
    if (c.status === 'approved') {
      actionCell = isPaid
        ? `<button type="button" class="btn btn-xs" onclick="markDistributorCommissionUnpaid('${c.id}')">Undo</button>`
        : `<button type="button" class="btn btn-xs btn-primary" onclick="markDistributorCommissionPaid('${c.id}')"><i class="business-icon icon-inline" data-lucide="hand-coins" aria-hidden="true"></i> Mark Paid</button>`;
    }
    return `<tr>
      <td>${new Date(c.submitted_at || Date.now()).toLocaleDateString()}</td>
      <td>${escapeHtmlSafe(nameFor(c.distributor_id))}</td>
      <td>${escapeHtmlSafe(c.order_ref_no || '-')}</td>
      <td>${fmt(Number(c.order_total)||0)}</td>
      <td>${((Number(c.commission_rate)||0)*100).toFixed(1)}%</td>
      <td>${fmt(Number(c.commission_amount)||0)}</td>
      <td><span class="status-pill ${c.status==='approved'?'approved':c.status==='rejected'?'rejected':'pending'}">${c.status==='approved'?'Earned':c.status==='rejected'?'Cancelled':'Pending delivery'}</span></td>
      <td>${payoutCell}</td>
      <td>${actionCell}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="9" style="text-align:center;opacity:.5;padding:14px;">No commission claims match this filter.</td></tr>';
  if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } });
}
window.renderDistActivityCommission = renderDistActivityCommission;

function clearDistActivityCommissionFilter(){
  ['distActCommDistFilter','distActCommStatusFilter','distActCommPayoutFilter','distActCommFrom','distActCommTo'].forEach(id => { if ($(id)) $(id).value=''; });
  renderDistActivityCommission();
}
window.clearDistActivityCommissionFilter = clearDistActivityCommissionFilter;

function exportDistActivityCommissionCSV(){
  const claims = window.distributorCommissionClaims || [];
  const nameFor = (id) => { const d = (distributorListCache||[]).find(x => String(x.id)===String(id)); return d ? (d.display_name || 'Distributor') : 'Distributor'; };
  const rows = [['Date','Distributor','Order Ref','Order Total','Rate','Commission','Status','Payout Status','Paid Date']];
  claims.forEach(c => rows.push([
    new Date(c.submitted_at || Date.now()).toLocaleDateString(), nameFor(c.distributor_id), c.order_ref_no||'-',
    Number(c.order_total)||0, (((Number(c.commission_rate)||0)*100).toFixed(1))+'%', Number(c.commission_amount)||0, c.status,
    c.status === 'approved' ? ((c.payout_status||'unpaid')) : '-',
    c.paid_at ? new Date(c.paid_at).toLocaleDateString() : '-'
  ]));
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type:'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'distributor-commission.csv'; document.body.appendChild(a); a.click(); a.remove();
}
window.exportDistActivityCommissionCSV = exportDistActivityCommissionCSV;

async function addDistributorActivity(){
  if (userRole !== 'owner') { alert('Only the owner can log distributor activity.'); return; }
  const distId = $('distActLogDistSelect')?.value;
  if (!distId) { alert('Select a distributor first.'); return; }
  const type = $('distActLogType')?.value || 'note';
  const date = $('distActLogDate')?.value || new Date().toISOString().slice(0,10);
  const outcome = $('distActLogOutcome')?.value || null;
  const nextFollowup = $('distActLogNextFollowup')?.value || null;
  const notes = ($('distActLogNotes')?.value || '').trim();
  if (!(await ensureFreshSession())) return;
  const btn = document.querySelector('#distActivityCard .dist-act-view[data-dist-act-view="log"] .btn-primary');
  if (btn) { btn.disabled = true; btn.dataset.originalText = btn.textContent; btn.textContent = 'Saving…'; }
  try{
    const row = {
      owner_id: currentUser.id, distributor_id: distId, activity_type: type, activity_date: date,
      notes: notes || null, outcome: outcome || null, next_followup_date: nextFollowup || null, created_by: currentUser.id
    };
    const { data, error } = await withSessionRetry(() => supabase.from('distributor_activities').insert(row).select().single());
    if (error) throw error;
    distributorActivitiesCache.unshift(data);
    if ($('distActLogNotes')) $('distActLogNotes').value = '';
    if ($('distActLogOutcome')) $('distActLogOutcome').value = '';
    if ($('distActLogNextFollowup')) $('distActLogNextFollowup').value = '';
    renderDistActivityLog(); renderDistActivityOverview();
    updateStatus('✅ Distributor activity logged');
  }catch(e){
    console.error('Add distributor activity failed:', e);
    const missingTable = /relation .* does not exist/i.test(e?.message || '');
    alert('❌ Could not log activity:\n' + (e?.message || String(e)) + (missingTable ? '\n\nThe distributor_activities table hasn\'t been created in Supabase yet — see the SQL setup comment above initDistributorActivityPanel() in app.js.' : ''));
  }finally{
    if (btn) { btn.disabled = false; btn.textContent = btn.dataset.originalText || 'Log Activity'; }
  }
}
window.addDistributorActivity = addDistributorActivity;

async function editDistributorActivity(id){
  if (userRole !== 'owner') return;
  const a = distributorActivitiesCache.find(x => String(x.id) === String(id));
  if (!a) { alert('Activity not found.'); return; }
  const notesStr = prompt('Notes:', a.notes || '');
  if (notesStr === null) return;
  const followupStr = prompt('Next follow-up date (YYYY-MM-DD, blank for none):', a.next_followup_date || '');
  if (followupStr === null) return;
  if (!(await ensureFreshSession())) return;
  try{
    const { error } = await withSessionRetry(() => supabase.from('distributor_activities')
      .update({ notes: notesStr.trim() || null, next_followup_date: followupStr.trim() || null })
      .eq('id', id).eq('owner_id', currentUser.id));
    if (error) throw error;
    a.notes = notesStr.trim() || null; a.next_followup_date = followupStr.trim() || null;
    renderDistActivityLog(); renderDistActivityOverview();
    updateStatus('✅ Activity updated');
  }catch(e){
    console.error('Update distributor activity failed:', e);
    alert('❌ Could not update:\n' + (e?.message || String(e)));
  }
}
window.editDistributorActivity = editDistributorActivity;

async function deleteDistributorActivity(id){
  if (userRole !== 'owner') return;
  if (!confirm('Delete this activity entry?')) return;
  if (!(await ensureFreshSession())) return;
  try{
    const { error } = await withSessionRetry(() => supabase.from('distributor_activities').delete().eq('id', id).eq('owner_id', currentUser.id));
    if (error) throw error;
    distributorActivitiesCache = distributorActivitiesCache.filter(a => String(a.id) !== String(id));
    renderDistActivityLog(); renderDistActivityOverview();
  }catch(e){
    console.error('Delete distributor activity failed:', e);
    alert('❌ Could not delete:\n' + (e?.message || String(e)));
  }
}
window.deleteDistributorActivity = deleteDistributorActivity;

function renderDistActivityLog(){
  const body = $('distActLogBody');
  if (!body) return;
  const distFilter = $('distActLogFilterDist')?.value || '';
  const typeFilter = $('distActLogFilterType')?.value || '';
  let rows = distributorActivitiesCache.slice();
  if (distFilter) rows = rows.filter(a => String(a.distributor_id) === String(distFilter));
  if (typeFilter) rows = rows.filter(a => a.activity_type === typeFilter);

  const nameFor = (id) => { const d = (distributorListCache||[]).find(x => String(x.id)===String(id)); return d ? (d.display_name || 'Distributor') : 'Distributor'; };

  body.innerHTML = rows.map(a => `<tr>
      <td>${new Date(a.activity_date).toLocaleDateString()}</td>
      <td>${escapeHtmlSafe(nameFor(a.distributor_id))}</td>
      <td>${DIST_ACTIVITY_TYPES[a.activity_type] || escapeHtmlSafe(a.activity_type||'-')}</td>
      <td>${a.outcome ? (DIST_ACTIVITY_OUTCOMES[a.outcome]||escapeHtmlSafe(a.outcome)) : '—'}</td>
      <td style="max-width:220px;white-space:normal;">${escapeHtmlSafe(a.notes || '—')}</td>
      <td>${a.next_followup_date ? new Date(a.next_followup_date).toLocaleDateString() : '—'}</td>
      <td>${a.created_by === currentUser?.id ? 'You' : 'Owner'}</td>
      <td>${actionMenuHTML([
        { label: 'Edit', icon: '✏️', onclick: `editDistributorActivity('${a.id}')` },
        { label: 'Delete', icon: '🗑️', danger: true, onclick: `deleteDistributorActivity('${a.id}')` }
      ])}</td>
    </tr>`).join('') || '<tr><td colspan="8" style="text-align:center;opacity:.5;padding:14px;">No activity logged yet.</td></tr>';
}
window.renderDistActivityLog = renderDistActivityLog;

function clearDistActivityLogFilter(){
  ['distActLogFilterDist','distActLogFilterType'].forEach(id => { if ($(id)) $(id).value=''; });
  renderDistActivityLog();
}
window.clearDistActivityLogFilter = clearDistActivityLogFilter;

// ==================== ADVANCE REQUESTS: LIVE SYNC FOR OWNER ====================
// The moment staff submit/edit an advance request, the owner sees it instantly
// (table + pending badge) without needing to open MY STAFF or click Refresh.
let advanceRealtimeChannel = null;
let advanceRealtimeTimer = null;

function startAdvanceRealtime(){
  if(!currentUser || userRole!=='owner' || !window.supabase) return;
  try{
    if(advanceRealtimeChannel){ supabase.removeChannel(advanceRealtimeChannel); advanceRealtimeChannel=null; }
    advanceRealtimeChannel = supabase.channel('mydrybea-advance-live')
      .on('postgres_changes',{event:'*',schema:'public',table:'advance_requests',filter:`owner_id=eq.${currentUser.id}`},()=>loadOwnerAdvanceRequests())
      .subscribe((status)=>{ if(status==='SUBSCRIBED') console.log('MY DRYBEA advance realtime: connected'); });
    if(advanceRealtimeTimer) clearInterval(advanceRealtimeTimer);
    // Realtime channel above already pushes instant updates; this is just a safety-net
    // fallback in case a websocket event is missed, so it doesn't need to run every 5s.
    advanceRealtimeTimer=setInterval(()=>loadOwnerAdvanceRequests(),45000);
  }catch(e){ console.warn('Advance realtime setup:',e); }
}

function stopAdvanceRealtime(){
  try{ if(advanceRealtimeTimer) clearInterval(advanceRealtimeTimer); }catch(e){}
  advanceRealtimeTimer=null;
  try{ if(advanceRealtimeChannel) supabase.removeChannel(advanceRealtimeChannel); }catch(e){}
  advanceRealtimeChannel=null;
}

// ==================== APP NOTIFICATIONS (TOAST + SOUND) ====================
// Fires whenever the OTHER party (owner <-> staff) changes data that concerns
// you — new advance request, advance decided, attendance in/out, correction
// requested/decided, new task, new notice, new sale pending verification.
// Purely additive: never touches auth, Supabase writes, or existing calculations.
const NOTIFY_SOUND_KEY = 'mydrybea_notify_sound_on';
let notifySoundOn = true;
try { notifySoundOn = localStorage.getItem(NOTIFY_SOUND_KEY) !== 'off'; } catch(e){}

function toggleNotifySound(){
  notifySoundOn = !notifySoundOn;
  try{ localStorage.setItem(NOTIFY_SOUND_KEY, notifySoundOn ? 'on' : 'off'); }catch(e){}
  const btn = $('notifyCenterSoundToggle');
  if(btn){
    btn.classList.toggle('muted', !notifySoundOn);
    btn.title = notifySoundOn ? 'Notification sound: on' : 'Notification sound: off';
    const label = btn.querySelector('.nc-sound-label');
    if(label) label.textContent = notifySoundOn ? 'Sound' : 'Muted';
    const icon = btn.querySelector('i');
    if(icon){ icon.setAttribute('data-lucide', notifySoundOn ? 'bell' : 'bell-off'); if(window.lucide) lucide.createIcons(); }
  }
  if(notifySoundOn) playNotifySound();
}

// Short two-tone chime via Web Audio API — no external audio file needed,
// so it always works offline and inside the installed PWA.
let notifyAudioCtx = null;
// Browsers block audio.start() until a real user gesture has happened at
// least once on the page. A realtime event isn't a gesture, so without this
// unlock the very first sound (and sometimes every sound) would silently
// fail. We create/resume the context on the user's first tap anywhere in
// the app, so by the time a real notification needs to play, it's unlocked.
function unlockNotifyAudio(){
  try{
    notifyAudioCtx = notifyAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if(notifyAudioCtx.state === 'suspended') notifyAudioCtx.resume();
  }catch(e){}
}
document.addEventListener('click', unlockNotifyAudio, { once:true, passive:true });
document.addEventListener('touchstart', unlockNotifyAudio, { once:true, passive:true });

function playNotifySound(){
  if(!notifySoundOn) return;
  try{
    notifyAudioCtx = notifyAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if(notifyAudioCtx.state === 'suspended') notifyAudioCtx.resume();
    const now = notifyAudioCtx.currentTime;
    [[880,now,0.14],[1175,now+0.12,0.16]].forEach(([freq,start,dur])=>{
      const osc = notifyAudioCtx.createOscillator();
      const gain = notifyAudioCtx.createGain();
      osc.type = 'sine'; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.connect(gain); gain.connect(notifyAudioCtx.destination);
      osc.start(start); osc.stop(start + dur + 0.02);
    });
  }catch(e){ console.warn('Notify sound error:', e); }
}

// Each toast keeps its full detail (key/value rows) + an optional tab to jump
// to, so tapping it can open a proper detail view instead of just dismissing.
let appNotifyLog = {};
let appNotifySeq = 0;

// title/message in-app toast. type: 'info' | 'warn'.
// opts: { details:[{label,value}], tab:'advance', time:Date }
function showAppNotification(title, message, type, opts){
  opts = opts || {};
  const holder = $('appNotifyContainer');
  if(!holder) return;
  const nid = 'an' + (++appNotifySeq);
  appNotifyLog[nid] = { title, message, type, details: opts.details || [], tab: opts.tab || null, time: opts.time || new Date() };
  updateNotifyBadge();

  const card = document.createElement('div');
  card.className = 'app-notify' + (type === 'warn' ? ' an-warn' : '');
  card.dataset.nid = nid;
  card.innerHTML = `<div class="an-icon"><i class="business-icon" data-lucide="${type==='warn'?'alert-circle':'bell-ring'}" aria-hidden="true"></i></div>
    <div class="an-body"><div class="an-title">${escapeHtmlSafe(title)}</div><div class="an-msg">${escapeHtmlSafe(message||'')}</div></div>
    <button class="an-close" type="button" aria-label="Dismiss">✕</button>`;
  const remove = () => { card.classList.add('leaving'); setTimeout(()=>card.remove(), 220); };
  card.querySelector('.an-close').addEventListener('click', (ev)=>{ ev.stopPropagation(); remove(); });
  // Tapping the body of the card (not the ✕) opens the full detail view —
  // the card itself stays until it dismisses on its own or via ✕.
  card.addEventListener('click', () => openAppNotifyDetail(nid));
  holder.appendChild(card);
  if(window.lucide) lucide.createIcons();
  playNotifySound();
  const autoTimer = setTimeout(remove, 8000);
  card.addEventListener('click', () => clearTimeout(autoTimer), { once:true });
}

function openAppNotifyDetail(nid){
  const entry = appNotifyLog[nid];
  if(!entry) return;
  const titleEl = $('appNotifyDetailTitle');
  if(titleEl) titleEl.querySelector('span:last-child').textContent = entry.title.replace(/^[^\w]+/, '').trim() || entry.title;
  const timeEl = $('appNotifyDetailTime');
  if(timeEl) timeEl.textContent = entry.time.toLocaleString();
  const body = $('appNotifyDetailBody');
  if(body){
    const rows = (entry.details && entry.details.length) ? entry.details : [{label:'Details', value: entry.message || '-'}];
    body.innerHTML = rows.map(r => `<div class="an-detail-row"><span class="an-k">${escapeHtmlSafe(r.label)}</span><span class="an-v">${escapeHtmlSafe(r.value)}</span></div>`).join('');
  }
  const goBtn = $('appNotifyDetailGoBtn');
  if(goBtn){
    if(entry.tab){
      goBtn.style.display = '';
      goBtn.onclick = () => { closeModal('appNotifyDetailModal'); activateAppTab(entry.tab); };
    } else {
      goBtn.style.display = 'none';
      goBtn.onclick = null;
    }
  }
  const modal = $('appNotifyDetailModal');
  if(modal) modal.classList.add('active');
}

// ---- Notification Center: a persistent, always-checkable list of every
// notification received this session (the toasts above still auto-vanish
// after 8s, so this is the "did I miss anything?" view behind the bell). ----
function notifyCenterLastSeenKey(){ return 'mydrybea_notifycenter_lastseen_' + (currentUser?.id || 'anon'); }
function getNotifyCenterLastSeen(){ try{ return localStorage.getItem(notifyCenterLastSeenKey()); }catch(e){ return null; } }
function bumpNotifyCenterLastSeen(){ try{ localStorage.setItem(notifyCenterLastSeenKey(), new Date().toISOString()); }catch(e){} }

function updateNotifyBadge(){
  const badge = $('notifyBadge');
  if(!badge) return;
  const lastSeen = getNotifyCenterLastSeen();
  const entries = Object.values(appNotifyLog);
  const unread = lastSeen ? entries.filter(e => new Date(e.time).toISOString() > lastSeen).length : entries.length;
  if(unread > 0){
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.classList.add('show');
  } else {
    badge.classList.remove('show');
  }
}

function openNotifyCenter(){
  const list = $('notifyCenterList');
  if(!list) return;
  updatePushEnableButton();
  // Keep the sound toggle inside the panel in sync with the stored
  // preference every time the panel opens (it may have changed in
  // another tab/session since we last rendered it).
  const soundBtn = $('notifyCenterSoundToggle');
  if(soundBtn){
    soundBtn.classList.toggle('muted', !notifySoundOn);
    soundBtn.title = notifySoundOn ? 'Notification sound: on' : 'Notification sound: off';
    const label = soundBtn.querySelector('.nc-sound-label');
    if(label) label.textContent = notifySoundOn ? 'Sound' : 'Muted';
    const icon = soundBtn.querySelector('i');
    if(icon) icon.setAttribute('data-lucide', notifySoundOn ? 'bell' : 'bell-off');
  }
  const lastSeen = getNotifyCenterLastSeen();
  const entries = Object.entries(appNotifyLog).sort((a,b) => new Date(b[1].time) - new Date(a[1].time));
  if(entries.length === 0){
    list.innerHTML = `<div class="nc-empty"><i class="business-icon" data-lucide="bell-off" aria-hidden="true"></i>No notifications yet. New updates will show up here the moment they happen.</div>`;
  } else {
    list.innerHTML = entries.map(([nid, entry]) => {
      const unread = lastSeen ? new Date(entry.time).toISOString() > lastSeen : true;
      return `<button type="button" class="nc-item${entry.type==='warn'?' an-warn':''}${unread?' unread':''}" onclick="closeModal('notifyCenterModal');openAppNotifyDetail('${nid}')">
        <span class="nc-icon"><i class="business-icon" data-lucide="${entry.type==='warn'?'alert-circle':'bell-ring'}" aria-hidden="true"></i></span>
        <span class="nc-body">
          <span class="nc-title">${escapeHtmlSafe(entry.title)}</span>
          <span class="nc-msg">${escapeHtmlSafe(entry.message||'')}</span>
          <span class="nc-time">${new Date(entry.time).toLocaleString()}</span>
        </span>
      </button>`;
    }).join('');
  }
  if(window.lucide) lucide.createIcons({attrs:{'stroke-width':1.9,'stroke-linecap':'round','stroke-linejoin':'round'}});
  $('notifyCenterModal').classList.add('active');
  // Opening the center counts as "seen" — clear the badge.
  bumpNotifyCenterLastSeen();
  updateNotifyBadge();
}

// ---- Shared notification builders (used by BOTH the live realtime handlers
// below AND the catch-up sweep, so a missed-while-offline item looks exactly
// like a live one). Each returns [title, message, type, opts].
function nbAdvanceRequested(r){
  return ['💸 New advance request', `${r.staff_name||'A staff member'} requested Rs. ${fmt(r.amount)}`, 'warn', { tab:'my-staff', details:[
    {label:'Staff', value: r.staff_name || '-'}, {label:'Amount', value: 'Rs. '+fmt(r.amount)},
    {label:'Reason', value: r.reason || '-'}, {label:'Status', value: r.status || 'pending'},
    {label:'Requested at', value: r.requested_at ? new Date(r.requested_at).toLocaleString() : '-'}
  ]}];
}
function nbAdvanceDecided(r){
  return [r.status==='approved'?'✅ Advance approved':'❌ Advance rejected', `Rs. ${fmt(r.amount)} request was ${r.status}`, r.status==='approved'?'info':'warn', { tab:'advance', details:[
    {label:'Amount', value: 'Rs. '+fmt(r.amount)}, {label:'Reason', value: r.reason || '-'},
    {label:'Status', value: r.status}, {label:'Decided at', value: r.decided_at ? new Date(r.decided_at).toLocaleString() : '-'}
  ]}];
}
function nbCheckedIn(r){
  return ['🕒 '+(r.staff_name||'A staff member')+' checked in', 'Day started'+(r.work_note?' · left a work update':''), 'info', { tab:'my-staff', details:[
    {label:'Staff', value: r.staff_name || '-'}, {label:'Date', value: r.work_date || '-'},
    {label:'Check-in', value: r.check_in ? new Date(r.check_in).toLocaleTimeString() : '-'}, {label:'Work note', value: r.work_note || '-'}
  ]}];
}
function nbCheckedOut(r){
  return ['🕒 '+(r.staff_name||'A staff member')+' checked out', 'Day ended', 'info', { tab:'my-staff', details:[
    {label:'Staff', value: r.staff_name || '-'}, {label:'Date', value: r.work_date || '-'},
    {label:'Check-in', value: r.check_in ? new Date(r.check_in).toLocaleTimeString() : '-'},
    {label:'Check-out', value: r.check_out ? new Date(r.check_out).toLocaleTimeString() : '-'}, {label:'Work note', value: r.work_note || '-'}
  ]}];
}
function nbWorkUpdate(r){
  return ['📝 Work update', (r.staff_name||'A staff member')+' posted a work update', 'info', { tab:'my-staff', details:[
    {label:'Staff', value: r.staff_name || '-'}, {label:'Date', value: r.work_date || '-'}, {label:'Note', value: r.work_note || '-'}
  ]}];
}
function nbCorrectionRequested(r){
  return ['🚩 Correction request', `${r.staff_name||'A staff member'} asked to correct ${r.field==='check_in'?'check-in':'check-out'} time`, 'warn', { tab:'my-staff', details:[
    {label:'Staff', value: r.staff_name || '-'}, {label:'Date', value: r.work_date || '-'},
    {label:'Field', value: r.field==='check_in'?'Check-in':'Check-out'},
    {label:'Requested time', value: r.requested_time ? new Date(r.requested_time).toLocaleString() : '-'}, {label:'Reason', value: r.reason || '-'}
  ]}];
}
function nbNewSaleToVerify(r){
  return ['🧾 New sale to verify', `${r.customer_name||'A sale'} · Rs. ${fmt(Number(r.order_total)||0)} awaiting verification`, 'info', { tab:'my-staff', details:[
    {label:'Staff ref', value: r.staff_reference || '-'}, {label:'Order', value: r.order_ref_no || '-'},
    {label:'Customer', value: r.customer_name || '-'}, {label:'Sale total', value: 'Rs. '+fmt(Number(r.order_total)||0)},
    {label:'Commission (12%)', value: 'Rs. '+fmt(Number(r.order_total)*0.12||0)}
  ]}];
}
// Mirrors notifyDriverNewDelivery() (the in-tab/native-Notification version
// used by startDriverDeliveriesRealtime) but returns the same [title,message,
// type,opts] shape as every other nb* builder, so it can also be shown via
// showAppNotification() and reach a closed tab through the send-push webhook.
function nbNewDelivery(r){
  const label = r.order_ref_no || String(r.id||'').slice(0,8);
  return ['🚚 New Delivery Assigned', `${label} — ${r.address || 'Check My Deliveries'}`, 'info', { tab:'my-deliveries', details:[
    {label:'Order', value: label}, {label:'Address', value: r.address || '-'},
    {label:'Total', value: 'Rs. '+fmt(Number(r.total||0))}
  ]}];
}

function nbCodHandover(r){
  return ['💰 Cash handed over', `${r.driver_name||'A driver'} handed over Rs. ${fmt(r.amount)}`, 'info', { tab:'delivery', details:[
    {label:'Driver', value: r.driver_name || '-'}, {label:'Amount', value: 'Rs. '+fmt(r.amount)},
    {label:'Note', value: r.note || '-'}, {label:'Logged at', value: r.created_at ? new Date(r.created_at).toLocaleString() : '-'}
  ]}];
}
function nbNewTask(r){
  return ['📋 New task assigned', r.title||'Check My Tasks', 'info', { tab:'my-tasks', details:[
    {label:'Task', value: r.title || '-'}, {label:'Priority', value: r.priority || 'normal'}, {label:'Status', value: r.status || 'pending'}
  ]}];
}
function nbNewNotice(r){
  return ['📣 '+(r.title||'New notice'), r.message||'', 'info', { tab:'announcements', details:[
    {label:'Title', value: r.title || '-'}, {label:'Message', value: r.message || '-'}
  ]}];
}
function nbCorrectionDecided(r){
  return [r.status==='approved'?'✅ Correction approved':'❌ Correction rejected', (r.field==='check_in'?'Check-in':'Check-out')+' time correction was '+r.status, r.status==='approved'?'info':'warn', { tab:'attendance', details:[
    {label:'Field', value: r.field==='check_in'?'Check-in':'Check-out'},
    {label:'Requested time', value: r.requested_time ? new Date(r.requested_time).toLocaleString() : '-'},
    {label:'Status', value: r.status}, {label:'Reason', value: r.reason || '-'}
  ]}];
}

function nbDistSaleToVerify(r){
  return ['🧾 New distributor sale', `${r.distributor_reference||'A distributor'} · Rs. ${fmt(Number(r.order_total)||0)} — commission pending`, 'info', { tab:'delivery', details:[
    {label:'Distributor', value: r.distributor_reference || '-'}, {label:'Order', value: r.order_ref_no || '-'},
    {label:'Customer', value: r.customer_name || '-'}, {label:'Sale total', value: 'Rs. '+fmt(Number(r.order_total)||0)},
    {label:'Commission', value: 'Rs. '+fmt(Number(r.commission_amount)||0)}
  ]}];
}
function nbDistCommissionDecided(r){
  return [r.status==='approved'?'✅ Commission approved':'❌ Commission rejected', `Rs. ${fmt(Number(r.commission_amount)||0)} commission was ${r.status}`, r.status==='approved'?'info':'warn', { tab:'my-income', details:[
    {label:'Order', value: r.order_ref_no || '-'}, {label:'Commission', value: 'Rs. '+fmt(Number(r.commission_amount)||0)},
    {label:'Status', value: r.status}
  ]}];
}

// Mirrors nbDistCommissionDecided but for a staff member's own commission
// claim (staff_commission_claims) being approved/rejected by the owner via
// verifyCommissionClaim()/verify_staff_commission_claim.
function nbStaffCommissionDecided(r){
  return [r.status==='approved'?'✅ Commission approved':'❌ Commission rejected', `Your commission claim was ${r.status}`, r.status==='approved'?'info':'warn', { tab:'my-income', details:[
    {label:'Order', value: r.order_ref_no || '-'}, {label:'Status', value: r.status},
    {label:'Note', value: r.owner_note || '-'}
  ]}];
}

// ---- Distributor-claim change detection ----
// distributor_commission_claims is refreshed via a plain reload (see
// refreshCommissionRealtime / refreshDistributorCommissionRealtime), not via
// per-row postgres_changes handlers like the tables above, so there's no
// natural INSERT/UPDATE payload to hand to showAppNotification. Instead we
// remember what we've already surfaced and diff every reload against that:
// - owner: notify once per claim id the first time it's ever seen (a new
//   distributor sale waiting on verification/delivery).
// - distributor: notify when a claim we'd already seen as 'pending' flips to
//   'approved'/'rejected'.
// _distClaimNotifyPrimed guards the very first load per role so existing
// history isn't replayed as a flood of "new" notifications on login.
let _distClaimNotifyPrimed = { owner:false, distributor:false };
let _distClaimSeenIds = new Set();
let _distClaimStatusCache = {};
function notifyDistributorClaimChanges(list, role){
  if(role !== 'owner' && role !== 'distributor') return;
  try{
    if(!_distClaimNotifyPrimed[role]){
      (list||[]).forEach(c=>{
        if(role==='owner') _distClaimSeenIds.add(String(c.id));
        else _distClaimStatusCache[String(c.id)] = c.status;
      });
      _distClaimNotifyPrimed[role] = true;
      return;
    }
    (list||[]).forEach(c=>{
      const id = String(c.id);
      if(role==='owner'){
        if(!_distClaimSeenIds.has(id)){
          _distClaimSeenIds.add(id);
          showAppNotification(...nbDistSaleToVerify(c));
        }
      } else {
        const prevStatus = _distClaimStatusCache[id];
        if(prevStatus==='pending' && c.status && c.status!=='pending' && c.status!==prevStatus){
          showAppNotification(...nbDistCommissionDecided(c));
        }
        _distClaimStatusCache[id] = c.status;
      }
    });
  }catch(e){ console.warn('Distributor claim notify diff failed:', e); }
}

// ==================== PUSH NOTIFICATIONS (OneSignal) ====================
// Everything above (showAppNotification, the notification center, the bell
// badge) only fires while this tab is open — it's an in-page toast system,
// not a real push. This block wires the OneSignal Web SDK (initialized in
// index.html's <head>) to this app's own login state, so a SERVER-SIDE event
// (Supabase Database Webhook -> the send-push Edge Function -> OneSignal's
// REST API) can reach the person's phone/browser even with the tab closed or
// the phone locked. The client's only job here is identity: "this browser
// belongs to user X, in business Y, with role Z" — the actual sending always
// happens from the server, never from another user's open tab.
function pushOneSignalReady(fn){
  window.OneSignalDeferred = window.OneSignalDeferred || [];
  window.OneSignalDeferred.push(fn);
}

// Links this browser's push subscription to the logged-in Supabase user via
// OneSignal's "External ID", and tags it with business_id/role so a
// server-side broadcast (e.g. a staff announcement to everyone at once) can
// target a whole business without needing every individual external_id.
// Safe to call every login — OneSignal no-ops if already linked to this id.
function initPushForCurrentUser(){
  if(!currentUser) return;
  pushOneSignalReady(async function(OneSignal){
    try{
      await OneSignal.login(String(currentUser.id));
      if(businessId) await OneSignal.User.addTag('business_id', String(businessId));
      if(userRole) await OneSignal.User.addTag('role', userRole);
      updatePushEnableButton();
    }catch(e){
      // Known OneSignal Web SDK v16 quirk: login() can throw an internal
      // "Cannot read properties of undefined" error when called before this
      // browser has a push subscription/permission yet (nothing to attach
      // the external_id to). It's harmless here (caught, doesn't break the
      // app) and gets retried once permission is actually granted via
      // requestPushPermission() -> initPushForCurrentUser() again.
      console.warn('OneSignal login/tag failed:', e);
    }
  });
}

// Unlinks the subscription so a shared/public device stops being treated as
// this user once they log out (otherwise the next person to log in on the
// same phone could keep receiving the previous person's pushes).
function logoutPushForCurrentUser(){
  pushOneSignalReady(async function(OneSignal){
    try{ await OneSignal.logout(); }catch(e){}
  });
}

// Triggered by the "Enable Push Notifications" button in the Notification
// Center modal. Must be called from a real click (not auto-fired on login)
// so the browser's own permission prompt reliably shows instead of being
// silently suppressed.
function requestPushPermission(){
  // CRITICAL for iOS Safari: the permission prompt must be triggered
  // synchronously from the click that started it. Routing this through
  // pushOneSignalReady() pushes the call onto OneSignal's own queue, which
  // gets drained on a later tick — by the time OneSignal actually calls
  // requestPermission(), Safari no longer considers this a "live" user
  // gesture, so it silently skips the native prompt entirely (no popup ever
  // shows, permission stays stuck at "default" forever, and the app never
  // even shows up in iPhone Settings > Notifications). OneSignal has almost
  // always already finished loading by the time a logged-in user reaches
  // this button (it starts loading at page load), so call it directly off
  // window.OneSignal right here in the click handler to keep the gesture
  // intact, and only fall back to the deferred queue in the rare case
  // OneSignal genuinely isn't ready yet.
  const run = async function(OneSignal){
    try{
      await OneSignal.Notifications.requestPermission();
      updatePushEnableButton();
      // Same iOS PWA lag as updatePushEnableButton() above: trust the
      // browser's own Notification.permission first since it's accurate
      // the instant the user taps Allow, instead of waiting on OneSignal's
      // SDK-level flag which can take a few seconds to catch up.
      const nativeGranted = (typeof Notification !== 'undefined' && Notification.permission === 'granted');
      if(nativeGranted || OneSignal.Notifications.permission === true){
        updateStatus('🔔 Push notifications enabled');
        // Before permission is granted, this browser has no push subscription
        // yet, so the earlier OneSignal.login() call at app-login time has
        // nothing to attach the external_id to and silently fails inside the
        // SDK (harmless "login/tag failed" warning in the console). Now that
        // a real subscription exists, retry the login/tag linking so this
        // device actually gets linked to the current user.
        initPushForCurrentUser();
      } else {
        updateStatus('🔕 Push permission not granted — check your browser/site settings');
      }
    }catch(e){
      console.warn('OneSignal permission request failed:', e);
      alert('Push notifications aren\'t supported on this device/browser.');
    }
  };
  if(window.OneSignal && window.OneSignal.Notifications){
    run(window.OneSignal);
  } else {
    pushOneSignalReady(run);
  }
}
window.requestPushPermission = requestPushPermission;

// Reflects current permission state on the button, e.g. when the
// Notification Center is opened.
function updatePushEnableButton(){
  const btn = $('pushEnableBtn');
  if(!btn) return;
  pushOneSignalReady(function(OneSignal){
    try{
      // On iOS installed PWA, OneSignal's own Notifications.permission flag can
      // lag behind reality for a few seconds right after the user grants
      // permission (the push subscription is still registering in the
      // background), which made this button flicker back to "Enable Push
      // Notifications" even though permission really was granted. The
      // browser's own Notification.permission is synchronous and always
      // accurate, so check that first and only fall back to OneSignal's flag
      // if the native API isn't available on this browser.
      const nativeGranted = (typeof Notification !== 'undefined' && Notification.permission === 'granted');
      const granted = nativeGranted || OneSignal.Notifications.permission === true;
      btn.innerHTML = granted
        ? '<i class="business-icon icon-inline" data-lucide="bell-check" aria-hidden="true"></i> Push Notifications On'
        : '<i class="business-icon icon-inline" data-lucide="bell-plus" aria-hidden="true"></i> Enable Push Notifications';
      btn.disabled = granted;
      if(window.lucide) lucide.createIcons({attrs:{'stroke-width':1.9,'stroke-linecap':'round','stroke-linejoin':'round'}});
    }catch(e){}
  });
}
window.updatePushEnableButton = updatePushEnableButton;

let appNotifyChannel = null;
let appNotifyHeartbeat = null;

function startAppNotifyRealtime(){
  if(!currentUser || !window.supabase) return;
  try{
    if(appNotifyChannel){ supabase.removeChannel(appNotifyChannel); appNotifyChannel=null; }
    const ch = supabase.channel('mydrybea-app-notify-'+currentUser.id);

    if(userRole === 'owner'){
      ch.on('postgres_changes',{event:'INSERT',schema:'public',table:'advance_requests',filter:`owner_id=eq.${currentUser.id}`},(p)=> showAppNotification(...nbAdvanceRequested(p.new||{})));
      ch.on('postgres_changes',{event:'INSERT',schema:'public',table:'attendance',filter:`owner_id=eq.${currentUser.id}`},(p)=> showAppNotification(...nbCheckedIn(p.new||{})));
      ch.on('postgres_changes',{event:'UPDATE',schema:'public',table:'attendance',filter:`owner_id=eq.${currentUser.id}`},(p)=>{
        const r=p.new||{}, o=p.old||{};
        if(r.check_out && !o.check_out) showAppNotification(...nbCheckedOut(r));
        else if(r.work_note && r.work_note!==o.work_note) showAppNotification(...nbWorkUpdate(r));
      });
      ch.on('postgres_changes',{event:'INSERT',schema:'public',table:'attendance_corrections',filter:`owner_id=eq.${currentUser.id}`},(p)=> showAppNotification(...nbCorrectionRequested(p.new||{})));
      ch.on('postgres_changes',{event:'INSERT',schema:'public',table:'staff_commission_claims',filter:`owner_id=eq.${currentUser.id}`},(p)=> showAppNotification(...nbNewSaleToVerify(p.new||{})));
      ch.on('postgres_changes',{event:'INSERT',schema:'public',table:'driver_cod_handovers',filter:`owner_id=eq.${currentUser.id}`},(p)=> showAppNotification(...nbCodHandover(p.new||{})));
      // A distributor submitting a sale for commission — same "needs owner
      // verification" shape as a staff sale, just a different source table.
      ch.on('postgres_changes',{event:'INSERT',schema:'public',table:'distributor_commission_claims',filter:`owner_id=eq.${currentUser.id}`},(p)=> showAppNotification(...nbDistSaleToVerify(p.new||{})));
    } else if(userRole === 'staff'){
      ch.on('postgres_changes',{event:'UPDATE',schema:'public',table:'advance_requests',filter:`staff_id=eq.${currentUser.id}`},(p)=>{
        const r=p.new||{}, o=p.old||{};
        if(r.status!==o.status && r.status!=='pending') showAppNotification(...nbAdvanceDecided(r));
      });
      ch.on('postgres_changes',{event:'INSERT',schema:'public',table:'staff_tasks',filter:`staff_id=eq.${currentUser.id}`},(p)=> showAppNotification(...nbNewTask(p.new||{})));
      if(businessId){
        ch.on('postgres_changes',{event:'INSERT',schema:'public',table:'staff_announcements',filter:`owner_id=eq.${businessId}`},(p)=> showAppNotification(...nbNewNotice(p.new||{})));
      }
      ch.on('postgres_changes',{event:'UPDATE',schema:'public',table:'attendance_corrections',filter:`staff_id=eq.${currentUser.id}`},(p)=>{
        const r=p.new||{}, o=p.old||{};
        if(r.status!==o.status && r.status!=='pending') showAppNotification(...nbCorrectionDecided(r));
      });
      // Owner approved/rejected this staff member's own commission claim.
      // Guard on status actually changing (not e.g. an unrelated column
      // update) and skip the initial pending->pending no-op.
      ch.on('postgres_changes',{event:'UPDATE',schema:'public',table:'staff_commission_claims',filter:`staff_id=eq.${currentUser.id}`},(p)=>{
        const r=p.new||{}, o=p.old||{};
        if(r.status!==o.status && r.status!=='pending') showAppNotification(...nbStaffCommissionDecided(r));
      });
    } else if(userRole === 'distributor'){
      // Owner approved/rejected this distributor's commission claim. Note:
      // markDistributorCommissionPaid()/markDistributorCommissionUnpaid() also
      // UPDATE this row (payout_status only) — the status!==o.status guard
      // means those payout-only updates correctly do NOT re-fire this.
      ch.on('postgres_changes',{event:'UPDATE',schema:'public',table:'distributor_commission_claims',filter:`distributor_id=eq.${currentUser.id}`},(p)=>{
        const r=p.new||{}, o=p.old||{};
        if(r.status!==o.status && r.status!=='pending') showAppNotification(...nbDistCommissionDecided(r));
      });
    } else if(userRole === 'driver'){
      // Same "new assignment" shape as startDriverDeliveriesRealtime's own
      // channel (which stays in charge of loadMyDeliveries()) — this one
      // only adds the notification-center/toast/push entry. INSERT covers an
      // order created pre-assigned to this driver; UPDATE covers a dispatcher
      // assigning an existing order, guarded so re-saving an already-assigned
      // order (address edit etc.) doesn't re-fire.
      ch.on('postgres_changes',{event:'INSERT',schema:'public',table:'orders',filter:`assigned_driver_id=eq.${currentUser.id}`},(p)=> showAppNotification(...nbNewDelivery(p.new||{})));
      ch.on('postgres_changes',{event:'UPDATE',schema:'public',table:'orders',filter:`assigned_driver_id=eq.${currentUser.id}`},(p)=>{
        const r=p.new||{}, o=p.old||{};
        if(String(o.assigned_driver_id||'')!==String(currentUser.id)) showAppNotification(...nbNewDelivery(r));
      });
    }

    ch.subscribe((status)=>{
      if(status==='SUBSCRIBED'){
        console.log('MY DRYBEA app-notify realtime: connected');
        // Fetch anything that happened while we were disconnected/closed,
        // right after the socket comes (back) up.
        catchUpMissedNotifications();
      }
    });
    appNotifyChannel = ch;

    // Wall-clock heartbeat: as long as the tab is open and nothing else has
    // moved "last seen" forward, keep nudging it so a crash/kill doesn't
    // leave the next catch-up scanning days of old history.
    if(appNotifyHeartbeat) clearInterval(appNotifyHeartbeat);
    appNotifyHeartbeat = setInterval(bumpAppNotifyLastSeen, 45000);
  }catch(e){ console.warn('App notify realtime setup:', e); }
}

function stopAppNotifyRealtime(){
  try{ if(appNotifyChannel) supabase.removeChannel(appNotifyChannel); }catch(e){}
  appNotifyChannel = null;
  if(appNotifyHeartbeat){ clearInterval(appNotifyHeartbeat); appNotifyHeartbeat=null; }
}

// ---- "Away from the app" / offline catch-up ----
// The realtime socket only delivers events while it's connected — anything
// that happened while the tab was closed, backgrounded, or the phone had no
// signal is simply missed by the .on() handlers above. This sweep asks
// Supabase directly for anything newer than the last time we were sure we
// were listening, and replays it through the same notification builders.
function appNotifyLastSeenKey(){ return 'mydrybea_notify_lastseen_' + (currentUser?.id || 'anon'); }
function getAppNotifyLastSeen(){ try{ return localStorage.getItem(appNotifyLastSeenKey()); }catch(e){ return null; } }
function bumpAppNotifyLastSeen(){ try{ localStorage.setItem(appNotifyLastSeenKey(), new Date().toISOString()); }catch(e){} }

let catchUpBusy = false;
async function catchUpMissedNotifications(){
  if(!currentUser || catchUpBusy) return;
  const lastSeen = getAppNotifyLastSeen();
  if(!lastSeen){ bumpAppNotifyLastSeen(); return; } // first time this device has ever run this — don't flood with old history
  catchUpBusy = true;
  try{
    if(userRole === 'owner'){
      const [advs, att, corr, claims, handovers, distClaims] = await Promise.all([
        supabase.from('advance_requests').select('*').eq('owner_id',currentUser.id).gt('requested_at',lastSeen).order('requested_at',{ascending:true}),
        supabase.from('attendance').select('*').eq('owner_id',currentUser.id).or(`check_in.gt.${lastSeen},check_out.gt.${lastSeen}`).order('work_date',{ascending:true}),
        supabase.from('attendance_corrections').select('*').eq('owner_id',currentUser.id).gt('requested_at',lastSeen).order('requested_at',{ascending:true}),
        supabase.from('staff_commission_claims').select('*').eq('owner_id',currentUser.id).gt('submitted_at',lastSeen).order('submitted_at',{ascending:true}),
        supabase.from('driver_cod_handovers').select('*').eq('owner_id',currentUser.id).gt('created_at',lastSeen).order('created_at',{ascending:true}),
        supabase.from('distributor_commission_claims').select('*').eq('owner_id',currentUser.id).gt('submitted_at',lastSeen).order('submitted_at',{ascending:true})
      ]);
      (advs.data||[]).forEach(r=> showAppNotification(...nbAdvanceRequested(r)));
      (att.data||[]).forEach(r=>{
        if(r.check_in && r.check_in>lastSeen) showAppNotification(...nbCheckedIn(r));
        if(r.check_out && r.check_out>lastSeen) showAppNotification(...nbCheckedOut(r));
      });
      (corr.data||[]).forEach(r=> showAppNotification(...nbCorrectionRequested(r)));
      (claims.data||[]).forEach(r=> showAppNotification(...nbNewSaleToVerify(r)));
      (handovers.data||[]).forEach(r=> showAppNotification(...nbCodHandover(r)));
      (distClaims.data||[]).forEach(r=> showAppNotification(...nbDistSaleToVerify(r)));
    } else if(userRole === 'staff'){
      const queries = [
        supabase.from('advance_requests').select('*').eq('staff_id',currentUser.id).not('decided_at','is',null).gt('decided_at',lastSeen).order('decided_at',{ascending:true}),
        supabase.from('staff_tasks').select('*').eq('staff_id',currentUser.id).gt('created_at',lastSeen).order('created_at',{ascending:true})
      ];
      if(businessId) queries.push(supabase.from('staff_announcements').select('*').eq('owner_id',businessId).gt('created_at',lastSeen).order('created_at',{ascending:true}));
      const [advs, tasks, notices] = await Promise.all(queries);
      (advs.data||[]).forEach(r=> showAppNotification(...nbAdvanceDecided(r)));
      (tasks.data||[]).forEach(r=> showAppNotification(...nbNewTask(r)));
      if(notices) (notices.data||[]).forEach(r=> showAppNotification(...nbNewNotice(r)));
      // NOTE: attendance-correction decisions AND staff commission-claim
      // decisions aren't caught up here — neither table has a confirmed
      // decided-at timestamp column to filter on, and a bad filter would
      // abort the whole Promise.all above. Live-only for now (see the
      // matching UPDATE handler in startAppNotifyRealtime).
    } else if(userRole === 'distributor'){
      // Same gap as staff commission decisions above: distributor_commission_claims
      // only reliably has verified_at set on approval, not on rejection, so a
      // single "decided since lastSeen" filter can't cover both outcomes.
      // Live-only for now (see the UPDATE handler in startAppNotifyRealtime).
    } else if(userRole === 'driver'){
      // orders has no confirmed "assigned_at" timestamp column to filter a
      // "assigned since lastSeen" catch-up query on, same limitation as
      // above. Live-only for now (see the INSERT/UPDATE handlers in
      // startAppNotifyRealtime and the pre-existing startDriverDeliveriesRealtime).
    }
  }catch(e){ console.warn('Notification catch-up failed:', e); }
  finally{ catchUpBusy = false; bumpAppNotifyLastSeen(); }
}

// Reconnect + catch up whenever the device comes back online, or the tab/PWA
// is brought back to the foreground after being backgrounded — both are
// cases where the websocket may have silently died without onclose firing.
window.addEventListener('online', () => { if(currentUser) { ensureFreshSession(); startAppNotifyRealtime(); } });
document.addEventListener('visibilitychange', () => {
  if(document.visibilityState === 'visible' && currentUser){
    // ROOT-CAUSE FIX for the recurring "JWT expired" errors (pickup location save,
    // live driver map, etc.): those all happened because the tab sat backgrounded
    // long enough for the access token to expire while supabase-js's own refresh
    // timer was frozen by the browser and never fired. The moment the app is
    // foregrounded again — someone unlocking their phone and tapping back in —
    // is exactly when that stale token is about to be used for the first time.
    // Refreshing it here, proactively, before any button tap can hit it, is what
    // actually stops the whole class of error instead of catching it after the
    // fact in each individual save/load function.
    ensureFreshSession();
    if(!appNotifyChannel) startAppNotifyRealtime();
    else catchUpMissedNotifications();
  }
});

async function verifyCommissionClaim(id,status){
  if(userRole!=='owner') { alert('Only the owner can verify a commission claim.'); return; }
  if(!id || !['approved','rejected'].includes(status)) { alert('Invalid commission action.'); return; }
  const note=status==='approved'?'Approved after owner verification':'Rejected by owner';
  if(!confirm(status==='approved'?'Verify this sale and add 12% commission?':'Reject this commission claim?')) return;
  const btn=document.querySelector(`button[onclick="verifyCommissionClaim('${id}','${status}')"]`);
  if(btn){ btn.disabled=true; btn.dataset.originalText=btn.textContent; btn.textContent=status==='approved'?'Verifying…':'Rejecting…'; }
  if(!(await ensureFreshSession()))return;try{
    const {data,error}=await supabase.rpc('verify_staff_commission_claim',{p_claim_id:id,p_status:status,p_owner_note:note});
    if(error) throw error;
    // Immediately reflect the authoritative RPC result in the UI.
    if(data){
      window.staffCommissionClaims=(window.staffCommissionClaims||[]).map(c=>String(c.id)===String(id)?data:c);
      renderCommissionClaims();
    }
    await refreshCommissionRealtime();
    updateStatus(status==='approved'?'✅ Approved · 12% commission added · LIVE SYNC':'❌ Rejected · LIVE SYNC');
  }catch(e){
    console.error('Commission verification failed:',e);
    alert('❌ Approve / Reject failed:\n'+(e?.message||String(e)));
    try{ await loadCommissionClaims(); }catch(_e){}
  }finally{
    const b=document.querySelector(`button[onclick="verifyCommissionClaim('${id}','${status}')"]`);
    if(b){b.disabled=false;b.textContent=b.dataset.originalText || (status==='approved'?'Approve':'Reject');}
  }
}
// Explicitly expose on window so inline onclick="verifyCommissionClaim(...)" handlers
// can never fail to find this function, regardless of load order or bundling.
window.verifyCommissionClaim = verifyCommissionClaim;

async function loadMyStaffOwnerData(){
  if(!currentUser||userRole!=='owner')return;
  // renderOwnerAdvanceRequests() (called inside loadOwnerAdvanceRequests) already
  // fills BOTH the Profile tab table (#advOwnerBody) and the MY STAFF tab table
  // (#ownerStaffAdvanceBody) directly from Supabase, and updates the pending badge.
  try{await loadOwnerAdvanceRequests();}catch(e){console.error('MY STAFF advance load:',e);}
  try{await loadOwnerAttendanceToday();}catch(e){console.error('MY STAFF attendance load:',e);}
  try{await loadOwnerPendingCorrections();}catch(e){console.error('MY STAFF corrections load:',e);}
}

// ==================== OWNER: LIVE STAFF ATTENDANCE (today) ====================
let ownerAttendanceToday = [];
let ownerAttendanceTickTimer = null;

function stopOwnerAttendanceTicker() {
  if (ownerAttendanceTickTimer) { clearInterval(ownerAttendanceTickTimer); ownerAttendanceTickTimer = null; }
}

async function loadOwnerAttendanceToday() {
  if (!currentUser || userRole !== 'owner') return;
  try {
    const { data, error } = await withTimeout(
      supabase.from('attendance').select('*').eq('owner_id', currentUser.id).eq('work_date', todayStr()),
      12000, "Loading today's attendance"
    );
    if (error) throw error;
    ownerAttendanceToday = data || [];
    renderOwnerAttendanceToday();
  } catch (e) {
    console.error('Load owner attendance today error:', e);
    const tbody = $('ownerAttendanceTodayBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;opacity:.5;padding:14px;">Couldn\'t load today\'s attendance — tap Refresh to try again.</td></tr>';
  }
}

function renderOwnerAttendanceToday() {
  const tbody = $('ownerAttendanceTodayBody');
  if (!tbody) return;
  stopOwnerAttendanceTicker();
  const list = staffListCache || [];
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;opacity:.5;padding:14px;">No staff added yet.</td></tr>';
    if ($('ownerStaffWorkingNow')) $('ownerStaffWorkingNow').textContent = '0';
    return;
  }
  let workingNow = 0;
  tbody.innerHTML = list.map(st => {
    const row = ownerAttendanceToday.find(a => String(a.staff_id) === String(st.id));
    const name = escapeHtmlSafe(st.display_name || '(no name)');
    if (!row || !row.check_in) {
      return `<tr><td><strong>${name}</strong></td><td><span class="badge badge-warn">Not started</span></td><td>-</td><td>-</td><td>-</td></tr>`;
    }
    const inT = new Date(row.check_in).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (!row.check_out) {
      workingNow++;
      const soFar = formatDuration(Date.now() - new Date(row.check_in).getTime());
      return `<tr><td><strong>${name}</strong></td><td><span class="badge badge-good">🟢 Working</span></td><td>${inT}</td><td>-</td><td>${soFar}</td></tr>`;
    }
    const outT = new Date(row.check_out).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const hrs = formatDuration(new Date(row.check_out) - new Date(row.check_in));
    return `<tr><td><strong>${name}</strong></td><td><span class="badge badge-shipped">✅ Done</span></td><td>${inT}</td><td>${outT}</td><td>${hrs}</td></tr>`;
  }).join('');
  if ($('ownerStaffWorkingNow')) $('ownerStaffWorkingNow').textContent = String(workingNow);
  if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } });
  // Keep "hours so far" ticking for anyone still checked in, without refetching from the network.
  if (ownerAttendanceToday.some(a => a.check_in && !a.check_out)) {
    ownerAttendanceTickTimer = setInterval(renderOwnerAttendanceToday, 30000);
  }
}

// ==================== OWNER: ATTENDANCE CORRECTION APPROVALS ====================
// Staff can only *request* a change to a logged ON/OFF time (requestAttendanceCorrection,
// above) — the owner is the only one who can actually approve it, via
// decide_attendance_correction() which checks auth.uid() = owner_id server-side.
let ownerPendingCorrections = [];

async function loadOwnerPendingCorrections() {
  if (!currentUser || userRole !== 'owner') return;
  const tbody = $('ownerCorrectionsBody');
  try {
    const { data, error } = await withTimeout(
      supabase.from('attendance_corrections').select('*').eq('owner_id', currentUser.id).eq('status', 'pending').order('requested_at', { ascending: false }),
      12000, 'Loading correction requests'
    );
    if (error) throw error;
    ownerPendingCorrections = data || [];
    renderOwnerPendingCorrections();
  } catch (e) {
    console.error('Load owner corrections error:', e);
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;opacity:.5;padding:14px;">Couldn\'t load correction requests — tap Refresh to try again.</td></tr>';
  }
}

function renderOwnerPendingCorrections() {
  const tbody = $('ownerCorrectionsBody');
  if (!tbody) return;
  if (!ownerPendingCorrections.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;opacity:.5;padding:14px;">No pending requests.</td></tr>';
    return;
  }
  tbody.innerHTML = ownerPendingCorrections.map(c => {
    const name = escapeHtmlSafe(c.staff_name || '(unknown)');
    const fieldLabel = c.field === 'check_in' ? 'ON time' : 'OFF time';
    const reqTime = new Date(c.requested_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const reason = escapeHtmlSafe(c.reason || '-');
    return `<tr><td><strong>${name}</strong></td><td>${c.work_date}</td><td>${fieldLabel}</td><td>${reqTime}</td><td>${reason}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-sm btn-primary" data-action="decideAttendanceCorrection" data-id="${c.id}" data-args='[true]'><i class="business-icon icon-inline" data-lucide="check"></i> Approve</button>
        <button class="btn btn-sm btn-danger" data-action="decideAttendanceCorrection" data-id="${c.id}" data-args='[false]'><i class="business-icon icon-inline" data-lucide="x"></i> Reject</button>
      </td></tr>`;
  }).join('');
  if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } });
}

async function decideAttendanceCorrection(id, approve) {
  if (!(await ensureFreshSession())) return;
  try {
    const { error } = await withTimeout(
      supabase.rpc('decide_attendance_correction', { p_id: id, p_approve: approve }),
      12000, 'Updating request'
    );
    if (error) throw error;
    updateStatus(approve ? '✅ Correction approved' : '🚫 Correction rejected');
    await loadOwnerPendingCorrections();
    await loadOwnerAttendanceToday();
  } catch (e) {
    console.error('Decide correction error:', e);
    alert('❌ Could not update request: ' + e.message);
  }
}

async function refreshMyStaffPage(){if(!currentUser||userRole!=='owner')return;await loadStaffList();await populateStaffReferralSelectors();await loadMyStaffData(false);await loadCommissionClaims();renderOwnerStaffPerformance();renderOwnerStaffManagement();renderOwnerStaffUploads();await loadMyStaffOwnerData();}

function refreshStaffHome(){
  if(!currentUser)return;const name=(userProfile&&userProfile.display_name)||currentUser.email?.split('@')[0]||'Staff Member';if($('staffHomeName'))$('staffHomeName').textContent=name;
  const now=new Date(),y=now.getFullYear(),m=now.getMonth(),monthOrders=(orders||[]).filter(o=>o.createdBy===currentUser.id&&new Date(o.createdAt||o.date||0).getFullYear()===y&&new Date(o.createdAt||o.date||0).getMonth()===m&&o.status!=='cancelled');
  const sales=monthOrders.reduce((s,o)=>s+(Number(o.total)||0),0);if($('staffHomeOrders'))$('staffHomeOrders').textContent=monthOrders.length;if($('staffHomeCommission'))$('staffHomeCommission').textContent=fmt(getCommissionForStaffMonth(currentUser.id,now.toISOString().slice(0,7)));const tasks=getStaffLocalTasks();if($('staffHomeTasks'))$('staffHomeTasks').textContent=tasks.filter(x=>!taskDone(x)).length;
  let hours=0;try{const raw=JSON.parse(localStorage.getItem('mydrybea_attendance_cache')||'[]');hours=raw.filter(x=>x.staffId===currentUser.id&&x.hours).reduce((s,x)=>s+Number(x.hours||0),0);}catch(e){}if($('staffHomeHours'))$('staffHomeHours').textContent=hours.toFixed(1)+'h';renderStaffTasks();renderStaffAnnouncements();refreshMyCommission();hideSkeletons('staff-home');
}

// ==================== TABS ====================
// Design-only touch interaction: gold ribbon sweep on app icon buttons.
document.querySelectorAll('[data-ribbon="true"]').forEach(btn => {
  const ribbon = document.createElement('span');
  ribbon.className = 'gold-ribbon';
  btn.appendChild(ribbon);
  btn.addEventListener('pointerdown', () => {
    btn.classList.remove('ribbon-play');
    void btn.offsetWidth;
    btn.classList.add('ribbon-play');
  });
});

const OWNER_ONLY_TABS = ['dashboard', 'my-staff', 'delivery', 'calculator', 'production', 'history', 'data', 'monthly-summary', 'income', 'analytics', 'sales'];
const STAFF_ONLY_TABS = ['staff-home', 'daily-pay', 'work-update', 'attendance', 'advance', 'my-commission', 'my-tasks', 'announcements'];
const DRIVER_ONLY_TABS = ['driver-home','my-deliveries','my-earnings','my-reviews'];
const DISTRIBUTOR_ONLY_TABS = ['distributor-home','my-income','commission-summary'];

let staffWorkspaceLoadSeq = 0;
async function refreshStaffWorkspaceData(tabId){
  if(!currentUser || userRole!=='staff') return;
  const seq=++staffWorkspaceLoadSeq;
  try{
    if(['staff-home','orders','my-commission','my-tasks','announcements'].includes(tabId)){
      await loadCommissionClaims();
      await Promise.all([userRole==='owner'?loadCustomersFromCloud():Promise.resolve(),loadOrdersFromCloud(),cloudLoadStaffTasks(),cloudLoadNotices(),cloudLoadReferralUploads(),cloudLoadPerformance(new Date().toISOString().slice(0,7)),cloudLoadCommission(),loadProductsFromCloud()]);
    }
    if(seq!==staffWorkspaceLoadSeq) return;
    renderStaffTasks(); renderStaffAnnouncements(); refreshMyCommission(); refreshStaffHome();
  }catch(e){
    console.error('Staff workspace refresh error:',e);
    setMyStaffStatus('⚠️ Some cloud data could not be refreshed');
  }
}

function safeStaffQuickAction(tabId){
  const allowed=['staff-home','orders','my-salary','expenses','daily-pay','work-update','attendance','advance','my-commission','my-tasks','announcements','profile'];
  if(userRole!=='staff'){ if(typeof activateAppTab==='function') return activateAppTab(tabId); return; }
  if(!allowed.includes(tabId)){ alert('This staff action is not available.'); return; }
  const target=document.getElementById(tabId);
  if(!target){ alert('This page is not available in this build.'); return; }
  activateAppTab(tabId);
}

function activateAppTab(tabId){
  if (userRole === 'staff' && !['staff-home', 'orders', 'my-salary', 'expenses', 'daily-pay', 'work-update', 'attendance', 'advance', 'my-commission', 'my-tasks', 'announcements', 'profile', 'products'].includes(tabId)) {
    alert('🔒 Staff access: use your staff workspace and assigned business sections.');
    return;
  }
  if (userRole === 'driver' && !DRIVER_ALLOWED_TABS.includes(tabId)) {
    alert('🔒 Driver access: use your Home, My Deliveries, My Earnings and Profile pages.');
    return;
  }
  if (userRole === 'distributor' && !DISTRIBUTOR_ALLOWED_TABS.includes(tabId)) {
    alert('🔒 Distributor access: use your Home, My Income, Commission Summary, Orders, Expenses, Products and Profile pages.');
    return;
  }
  if (OWNER_ONLY_TABS.includes(tabId) && userRole === 'staff') {
    alert('🔒 This section is only available to the business owner.');
    return;
  }
  if (STAFF_ONLY_TABS.includes(tabId) && userRole === 'owner') {
    alert('🔒 This section is only available to staff accounts.');
    return;
  }
  if (DRIVER_ONLY_TABS.includes(tabId) && userRole !== 'driver') {
    alert('🔒 This section is only available to driver accounts.');
    return;
  }
  if (DISTRIBUTOR_ONLY_TABS.includes(tabId) && userRole !== 'distributor') {
    alert('🔒 This section is only available to product distributor accounts.');
    return;
  }
  const panel = document.getElementById(tabId);
  if (!panel) return;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  const nav = document.querySelector('.tab-btn[data-tab="' + tabId + '"]');
  if (nav) nav.classList.add('active');
  document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
  panel.style.display = 'block';
  panel.style.animation = 'none'; panel.offsetHeight; panel.style.animation = 'fadeIn 0.3s ease';
  if (tabId === 'staff-home') showSkeletons('staff-home');
  if(userRole==='staff') refreshStaffWorkspaceData(tabId);
  if (tabId === 'dashboard') { calcDashboard(); calcBulk(); }
  if (tabId === 'income') {
    calcDashboard();
    calcRealIncome();
    Promise.all([loadFishBillsFromCloud(), loadProductionBatchesFromCloud()]).then(() => {
      renderFishBills(); // also refreshes calcRealIncome() with real purchase data
      renderReadymadeBills(); // live Ready-Made Umbalakada card on the Income tab
      renderProductionBatches(); // also refreshes calcRealIncome() with real output data
    });
    loadDailyProductionLog().then(() => renderIncomeDailyDustSummary());
  }
  if (tabId === 'calculator') {
    // Daily Costing & Trends sub-tab reads dailyProductionLogCache — load it
    // in case the user opens Costing before ever visiting Production/Income.
    loadDailyProductionLog().then(() => renderCostingGrindOutputChart());
    // Umbalakada → Order Costing sub-tab needs Orders (for the link picker)
    // and its own saved entries.
    loadOrdersFromCloud().then(() => populateCostingEntryOrderPicker());
    loadCostingEntriesFromCloud().then(renderCostingEntries);
    // Ready-Made Umbalakada Purchase sub-tab needs the same bills the
    // Production tab uses, in case Costing is opened first.
    loadFishBillsFromCloud().then(() => renderReadymadeBills());
  }
  if (tabId === 'monthly-summary') { updateMonthlySummary(); }
  if (tabId === 'analytics') { renderAnalytics(); }
  if (tabId === 'history') renderHistory();
  if (tabId === 'orders') { loadCommissionClaims().finally(() => { renderOrders(); renderCustomers(); updateOrderStats(); }); if (userRole === 'owner') { loadStaffList(); } }
  if (tabId === 'delivery') {
    loadOrdersFromCloud().then(() => { renderDelivery(); updateOrderStats(); });
    loadStaffList();
    initOwnerDriverMap();
    initDeliveryHeatmap();
    loadDriverLocations();
    startDriverLocationPolling();
    renderDelPayPreview();
  }
  if (tabId !== 'delivery' && driverLocationPollTimer) { clearInterval(driverLocationPollTimer); driverLocationPollTimer = null; }
  if (tabId === 'driver-home') { showSkeletons('driver-home'); loadMyDeliveries().then(() => { renderMyEarnings(); renderDriverHome(); }); loadDriverHandovers(); }
  if (tabId === 'my-deliveries') { loadMyDeliveries(); updateDriverNotifyPermUI(); }
  if (tabId === 'my-earnings') { loadMyDeliveries().then(() => renderMyEarnings()); loadDriverHandovers(); }
  if (tabId === 'my-reviews') { loadMyDeliveries().then(() => renderMyReviews()); }
  if (tabId === 'my-staff') { refreshMyStaffPage(); loadMyStaffOwnerData(); }
  if (tabId === 'expenses') { renderExpenses(); renderRecurringExpenses(); }
  if (tabId === 'products') {
    loadProductsFromCloud().then(renderProducts);
    renderProductCosting();
  }
  if (tabId === 'production') {
    calcProduction();
    Promise.all([loadFishBillsFromCloud(), loadFishPaymentsFromCloud()]).then(() => {
      renderFishBills();
      renderReadymadeBills();
      renderSellerLedger();
    });
    loadDailyProductionLog().then(() => { renderDailyProductionLog(); updateIngredientVarianceAlert(lastProdIngredientsCostPerKg); });
    loadDailyPurchaseLog().then(() => syncUmbalakadaGroundFromPurchaseLog());
    loadProductionBatchesFromCloud().then(renderProductionBatches);
  }
  if (tabId === 'distributor-home') { showSkeletons('distributor-home'); loadDistributorCommissionClaims().then(renderDistributorHome); }
  if (tabId === 'my-income') { loadDistributorCommissionClaims().then(renderProductAgentPage); }
  if (tabId === 'commission-summary') { loadDistributorCommissionClaims().then(renderDistCommissionSummary); }
  if (tabId === 'sales') { loadSalesFromCloud().then(renderSales); if (userRole === 'owner') { loadStaffList().then(() => initDistributorActivityPanel()); } }
  if (tabId === 'my-salary') {
    if (userRole === 'owner') {
      loadStaffList();
      updateStatus('👑 Owner salary control opened — select a staff member below.');
      setTimeout(() => {
        const target = document.getElementById('salaryStaffSelect');
        if (target) target.scrollIntoView({behavior:'smooth', block:'center'});
        const panel = document.getElementById('salaryPanel');
        if (panel) panel.style.display = '';
      }, 80);
    } else {
      loadMySalary();
      initMySmartSalaryMonth();
    }
  }
  if (tabId === 'daily-pay') { loadMySalary().then(renderDailyPay); }
  if (tabId === 'work-update') { updateWorkUpdateStats(); loadWorkUpdateHistory(); $('wuNoteText').value = ''; }
  if (tabId === 'attendance') { loadTodayAttendance(); loadAttendanceLog(); loadMyPendingCorrections(); }
  else if (typeof stopAttendanceTicker === 'function') { stopAttendanceTicker(); }
  if (tabId !== 'my-staff' && typeof stopOwnerAttendanceTicker === 'function') { stopOwnerAttendanceTicker(); }
  if (tabId === 'advance') loadMyAdvanceRequests();
   if (tabId === 'staff-home') refreshStaffHome();
   if (tabId === 'my-commission') refreshMyCommission();
   if (tabId === 'my-tasks') renderStaffTasks();
   if (tabId === 'announcements') renderStaffAnnouncements();
  if (tabId === 'profile') {
    updateAuthUI();
    if (userRole === 'owner') {
      loadStaffList();
      loadOwnerAdvanceRequests();
      if ($('ownerWhatsapp') && userProfile) $('ownerWhatsapp').value = userProfile.whatsapp_number || '';
      if ($('driverWhatsapp') && userProfile) $('driverWhatsapp').value = userProfile.whatsapp_number || '';
    }
  }
}

document.querySelectorAll('[data-home-tab],[data-open-tab]').forEach(btn => {
  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    const target = btn.dataset.homeTab || btn.dataset.openTab;
    if (target) activateAppTab(target);
  });
});
// Safety net for quick-action buttons added/re-rendered after boot.
document.addEventListener('click', (ev) => {
  const btn = ev.target.closest && ev.target.closest('[data-home-tab],[data-open-tab]');
  if (!btn || btn.dataset.quickBound === '1') return;
  ev.preventDefault();
  const target = btn.dataset.homeTab || btn.dataset.openTab;
  if (target) activateAppTab(target);
});

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', (ev) => { ev.preventDefault(); activateAppTab(btn.dataset.tab); });
});

// ==================== PUBLIC DELIVERY RATING PAGE ====================
// Reached via the "rate your delivery" WhatsApp link (?rate=<orderId>&rt=<token>).
// The customer never logs in — the token proves which delivery is theirs, and
// the actual write happens through the submit_delivery_rating() Postgres
// function (SECURITY DEFINER) so the public anon key can't touch anything else.
function initPublicRatingPage(orderId, token) {
  // Hide the entire app shell and show only the rating card.
  Array.from(document.body.children).forEach(el => {
    if (el.id !== 'publicRatingScreen') el.style.display = 'none';
  });
  const screen = document.getElementById('publicRatingScreen');
  if (!screen) return;
  screen.style.display = 'flex';

  let selected = 0;
  const stars = Array.from(screen.querySelectorAll('.rating-star'));
  const submitBtn = document.getElementById('ratingSubmitBtn');
  const feedbackEl = document.getElementById('ratingFeedback');
  const cardEl = screen.querySelector('.rating-card');

  stars.forEach(star => {
    star.addEventListener('click', () => {
      selected = Number(star.dataset.val);
      stars.forEach(s => { s.textContent = Number(s.dataset.val) <= selected ? '★' : '☆'; });
    });
  });

  if (submitBtn) {
    submitBtn.addEventListener('click', async () => {
      if (!selected) { alert('Please tap a star to rate your delivery.'); return; }
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting…';
      try {
        const { data, error } = await supabase.rpc('submit_delivery_rating', {
          p_order_id: orderId,
          p_token: token,
          p_rating: selected,
          p_feedback: (feedbackEl && feedbackEl.value.trim()) || ''
        });
        if (error) throw error;
        if (cardEl) {
          cardEl.innerHTML = data
            ? '<div style="font-size:40px;">🙏</div><h2 style="margin:10px 0 4px;">Thank you!</h2><p style="opacity:.7;margin:0;">Your feedback helps us improve delivery.</p>'
            : '<div style="font-size:40px;">✅</div><h2 style="margin:10px 0 4px;">Already rated</h2><p style="opacity:.7;margin:0;">This delivery has already been rated — thank you!</p>';
        }
      } catch (e) {
        console.error('Submit rating error:', e);
        alert('Could not submit your rating: ' + e.message);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Rating';
      }
    });
  }
}

// ==================== INIT ====================
document.addEventListener('DOMContentLoaded', async () => {
  // ---- PUBLIC RATING LINK: bypasses login entirely ----
  const __ratingParams = new URLSearchParams(window.location.search);
  const __rateOrderId = __ratingParams.get('rate');
  const __rateToken = __ratingParams.get('rt');
  if (__rateOrderId && __rateToken) {
    initPublicRatingPage(__rateOrderId, __rateToken);
    return;
  }

  // ---- AUTHORITATIVE SUPABASE AUTH GATE ----
  const { data: { session } } = await supabase.auth.getSession();
  const email = session && session.user && session.user.email ? session.user.email.toLowerCase() : null;
  if (!session) {
    window.location.replace('login.html');
    return;
  }
  currentUser = session.user;
  await loadUserProfile();
  loadState();
  loadHistory();
  loadOrders();
  loadCustomers();
  loadSnapshots();

  // ---- SETUP UI ----
  $('printDate').textContent = 'Date: ' + new Date().toLocaleDateString();
  $('year').textContent = new Date().getFullYear();

  syncUI();
  calcAll();
  calcProduction();
  renderHistory();
  renderOrders();
  renderCustomers();
  renderDelivery();
  updateOrderStats();
  updateCustomerSelect();
  updateAuthUI();
  saveAll();
  updateStatus('✅ Ready');

  // Re-apply role visibility after the initial UI render.
  applyRoleUI();

  // ---- LOAD CUSTOMERS/ORDERS/EXPENSES/PRODUCTS + RECURRING RULES + APP DATA ----
  // (source of truth — same data across every device/browser)
  // PERFORMANCE: these five reads are all independent of one another (none of
  // them needs another one's result), so they're fired together instead of
  // one-after-another. On a fast desktop connection the difference is barely
  // noticeable, but on a higher-latency mobile connection each sequential
  // round trip used to add its own full delay on top of the last one — five
  // of them back-to-back is what made login feel slow specifically on
  // mobile. Running them in parallel means the whole batch only takes as
  // long as the SLOWEST single call, not the sum of all of them. Each of
  // these functions already catches its own errors internally, so
  // Promise.all here is safe — one failing table read won't abort the rest.
  const __appDataPromise = (async () => {
    try {
      const { data, error } = await supabase
        .from('app_data')
        .select('data')
        .eq('user_id', currentUser.id)
        .order('updated_at', { ascending: false })
        .limit(1);
      if (error) throw error;
      return data;
    } catch (e) {
      console.error('Cloud load error:', e);
      updateStatus('⚠️ Cloud load failed — using local');
      return null;
    }
  })();

  await Promise.all([
    userRole==='owner' ? loadCustomersFromCloud() : Promise.resolve(),
    loadOrdersFromCloud(),
    loadExpensesFromCloud(),
    loadProductsFromCloud(),
    loadRecurringExpenses()
  ]);
  renderOrders();
  renderCustomers();
  renderDelivery();
  updateOrderStats();
  updateCustomerSelect();
  renderExpenses();
  updateMonthlySummary();

  // ---- RECURRING DAILY EXPENSES: auto-add today's due ones ----
  // Must START after loadExpensesFromCloud() above (it appends straight
  // into the local `expenses` array) — but it doesn't need to FINISH
  // before the rest of login does. Most logins have nothing due at all
  // (single early-return), and on the rare day something is due it
  // re-renders its own panels the moment it's done, so there's no reason
  // to make the user wait on it before the app is usable.
  generateDueRecurringExpenses();

  // ---- APPLY THE APP_DATA RESULT FETCHED IN PARALLEL ABOVE ----
  // app_data holds: state (pricing/production settings), history, snapshots.
  // customers/orders are NOT read from here — they come from their own tables above.
  try {
    const data = await __appDataPromise;
    if (data && data.length > 0 && data[0].data && data[0].data.state) {
      const payload = data[0].data;
      takeSnapshot();
      Object.assign(state, payload.state);
      history = payload.history || [];
      syncUI();
      calcAll();
      calcProduction();
      renderHistory();
      saveAll();
      updateStatus('☁️ Cloud data loaded');
    } else if (data !== null) {
      // First time user — save initial state to cloud
      await cloudSaveSilent();
      updateStatus('☁️ Initial cloud save');
    }
  } catch (e) {
    console.error('Cloud load apply error:', e);
  }

  appInitialized = true;

  // ---- AUTH STATE CHANGE LISTENER ----
  supabase.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_OUT' || !session) {
      currentUser = null;
      window.location.replace('login.html');
    } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
      currentUser = session.user;
      await loadUserProfile();
      updateAuthUI();
      if (appInitialized) {
        await cloudLoad();
      }
    }
  });
});

// ==================== EXPOSE ====================
window.toggleTheme = toggleTheme;
window.setMode = setMode;
window.toggleCustomMix = toggleCustomMix;
window.syncCustomMix = syncCustomMix;
window.toggleAcc = toggleAcc;
window.lockApp = lockApp;
window.closeModal = closeModal;
window.openQR = openQR;
window.closeQR = closeQR;
window.exportCSV = exportCSV;
window.exportDashCSV = exportDashCSV;
window.exportHistoryCSV = exportHistoryCSV;
window.backupJSON = backupJSON;
window.restoreJSON = restoreJSON;
window.resetAll = resetAll;
window.resetDash = resetDash;
window.calcAll = calcAll;
window.calcScenario = calcScenario;
window.calcBulk = calcBulk;
window.calcDashboard = calcDashboard;
window.calcProduction = calcProduction;
window.updateMonthlySummary = updateMonthlySummary;
window.saveOrder = saveOrder;
window.deleteHistoryEntry = deleteHistoryEntry;
window.clearHistory = clearHistory;
window.openNewOrder = openNewOrder;
window.openNewCustomer = openNewCustomer;
window.saveCustomer = saveCustomer;
window.createOrder = createOrder;
window.deleteCustomer = deleteCustomer;
window.deleteOrder = deleteOrder;
window.cycleStatus = cycleStatus;
window.openNewExpense = openNewExpense;
window.saveExpense = saveExpense;
window.deleteExpense = deleteExpense;
window.exportExpensesCSV = exportExpensesCSV;
window.toggleRecurringExpense = toggleRecurringExpense;
window.deleteRecurringExpense = deleteRecurringExpense;
window.viewInvoice = viewInvoice;
window.printInvoicePDF = printInvoicePDF;
window.shareInvoiceWhatsApp = shareInvoiceWhatsApp;
window.closeThisModal = closeThisModal;
window.onDataChange = onDataChange;
window.cloudSave = cloudSave;
window.cloudLoad = cloudLoad;
window.openAuthModal = openAuthModal;
window.toggleAuthMode = toggleAuthMode;
window.authAction = authAction;
window.logout = logout;
window.activateAppTab = activateAppTab;
window.safeStaffQuickAction = safeStaffQuickAction;
window.refreshStaffHome = refreshStaffHome;
window.refreshMyCommission = refreshMyCommission;
window.addStaffTask = addStaffTask;
window.toggleStaffTask = toggleStaffTask;
window.deleteStaffTask = deleteStaffTask;
window.renderStaffTasks = renderStaffTasks;
window.renderStaffAnnouncements = renderStaffAnnouncements;
window.addStaffMember = addStaffMember;
window.removeStaffMember = removeStaffMember;
window.setSalaryMode = setSalaryMode;
window.onSalaryStaffChange = onSalaryStaffChange;
window.saveSalarySettings = saveSalarySettings;
window.saveDailySalary = saveDailySalary;
window.addSalaryEntry = addSalaryEntry;
window.deleteSalaryEntry = deleteSalaryEntry;
window.takeSnapshot = takeSnapshot;
window.restoreFromSnapshot = restoreFromSnapshot;
window.saveMyStaffData = saveMyStaffData;
window.loadMyStaffData = loadMyStaffData;
window.exportMyStaffData = exportMyStaffData;
window.importMyStaffData = importMyStaffData;
window.loadMyStaffOwnerData = loadMyStaffOwnerData;
window.refreshMyStaffPage = refreshMyStaffPage;
window.loadOwnerAdvanceRequests = loadOwnerAdvanceRequests;
window.startAdvanceRealtime = startAdvanceRealtime;
window.stopAdvanceRealtime = stopAdvanceRealtime;
// These are called from inline onclick="..." attributes in the HTML (and from
// dynamically-generated row buttons), which run in global scope — the whole
// app script is wrapped in an IIFE, so every function called that way MUST
// be explicitly exposed here or the button click throws "is not defined".
window.submitAdvanceRequest = submitAdvanceRequest;
window.notifyOwnerWhatsApp = notifyOwnerWhatsApp;
window.loadMyAdvanceRequests = loadMyAdvanceRequests;
window.saveOwnerWhatsapp = saveOwnerWhatsapp;
window.decideAdvance = decideAdvance;
window.renderOwnerAdvanceRequests = renderOwnerAdvanceRequests;
// Same "IIFE scope" issue found and fixed across the rest of the app —
// these were also called from onclick="..." attributes but never exposed,
// so they threw the exact same silent ReferenceError as the advance button.
window.startDay = startDay;
window.endDay = endDay;
window.requestAttendanceCorrection = requestAttendanceCorrection;
window.loadMyPendingCorrections = loadMyPendingCorrections;
window.loadOwnerPendingCorrections = loadOwnerPendingCorrections;
window.decideAttendanceCorrection = decideAttendanceCorrection;
window.printMySmartPayslip = printMySmartPayslip;
window.printSmartPayslip = printSmartPayslip;
window.refreshSmartSalary = refreshSmartSalary;
window.saveWorkNote = saveWorkNote;
window.addEstimatedOTToPayroll = addEstimatedOTToPayroll;
window.ownerAssignStaffTask = ownerAssignStaffTask;
window.ownerPublishNotice = ownerPublishNotice;
window.ownerToggleTask = ownerToggleTask;
window.ownerDeleteTask = ownerDeleteTask;
window.ownerDeleteNotice = ownerDeleteNotice;
window.editOwnerStaffPerformance = editOwnerStaffPerformance;
window.toggleNotifySound = toggleNotifySound;
window.startAppNotifyRealtime = startAppNotifyRealtime;
window.stopAppNotifyRealtime = stopAppNotifyRealtime;
window.showAppNotification = showAppNotification;
// FIX: these were declared but never exposed on window, so every onclick/onchange
// attribute calling them (order form size/qty/total, customer select, notification
// bell, owner attendance refresh, smart salary month picker) silently failed with
// "is not defined" and did nothing when tapped.
window.selectOrderSize = selectOrderSize;
window.selectOrderProduct = selectOrderProduct;
window.renderOrderProductPicker = renderOrderProductPicker;
window.stepOrderQty = stepOrderQty;
window.updateOrderTotal = updateOrderTotal;
window.onOrderCustomerChange = onOrderCustomerChange;
window.openNotifyCenter = openNotifyCenter;
window.openAppNotifyDetail = openAppNotifyDetail;
window.refreshMySmartSalary = refreshMySmartSalary;
window.loadOwnerAttendanceToday = loadOwnerAttendanceToday;
window.openNewSale = openNewSale;
window.saveSale = saveSale;
window.renderSales = renderSales;
window.clearSalesFilter = clearSalesFilter;
window.setSalesFilterToday = setSalesFilterToday;
window.exportSalesCSV = exportSalesCSV;
window.loadStaffList = loadStaffList;
window.togglePaymentMethodFields = togglePaymentMethodFields;
window.recalcSaleModal = recalcSaleModal;
window.editSale = editSale;
window.deleteSale = deleteSale;
window.markSalePaid = markSalePaid;
window.updateChequeStatus = updateChequeStatus;
// FIX: Products catalog buttons (Add Product, edit, delete, image preview,
// save) are also called from onclick/onchange attributes in the HTML but
// were never exposed — same IIFE scope issue as above.
window.openNewProduct = openNewProduct;
window.openEditProduct = openEditProduct;
window.deleteProduct = deleteProduct;
window.previewProductImage = previewProductImage;
window.saveProduct = saveProduct;
// FIX: Daily Fish Purchase Bills + Seller Ledger panel buttons (New Fish
// Bill, add/remove item row, save/view/delete/print bill, seller payment,
// seller history) are also called from onclick attributes — same IIFE
// scope issue as above, never exposed until now.
window.openNewFishBill = openNewFishBill;
window.addFishBillItemRow = addFishBillItemRow;
window.removeFishBillItemRow = removeFishBillItemRow;
window.recalcFishBillTotal = recalcFishBillTotal;
window.saveFishBill = saveFishBill;
window.viewFishBill = viewFishBill;
window.deleteFishBill = deleteFishBill;
window.printFishBill = printFishBill;
window.openSellerPayment = openSellerPayment;
window.saveSellerPayment = saveSellerPayment;
window.openSellerHistory = openSellerHistory;
// FIX: found via a full onclick/onchange scan against window exposures —
// two more spots with the same bug: the Daily Costing panel's "Add Daily
// Cost" / "Save Cost" buttons, and the New Order screen's distributor
// dropdown (onchange), all silently dead until now.
window.openNewCosting = openNewCosting;
window.saveCosting = saveCosting;
window.onOrderDistributorChange = onOrderDistributorChange;

// FIX: same missing-exposure bug found a 5th time via a fresh full
// onclick/onchange/oninput scan — this time on the Production tab's Quick
// Profit Calculator (fish type dropdown, raw price input, Advanced Settings
// toggle) and the Fish Seller phone-autofill field. All were defined but
// never attached to window, so clicking/changing them silently threw
// "is not defined" and did nothing.
window.onQcFishTypeChange = onQcFishTypeChange;
window.onQcRawPriceChange = onQcRawPriceChange;
window.toggleProdAdvanced = toggleProdAdvanced;
window.fillSellerNameFromPhone = fillSellerNameFromPhone;
window.onSaleProductPick = onSaleProductPick;

// ==================== PERMANENT SAFETY NET (this bug has now hit ====================
// production 5 separate times: a function used in onclick/onchange/oninput or
// data-action gets defined but never exposed via window.funcName, so the whole
// app.js IIFE swallows it and the button/dropdown just silently does nothing
// until a real user hits it and reports it. This scans the live DOM once,
// right after the app finishes loading, and loudly logs anything still
// broken — so it shows up in testing/QA immediately instead of in a user's
// console screenshot weeks later. It changes nothing about app behavior,
// it only reports. Safe to leave running permanently.
window.addEventListener('load', function () {
  setTimeout(function checkHandlerExposures() {
    const attrRe = /^([a-zA-Z_][a-zA-Z0-9_]*)\(/;
    const missing = new Set();
    document.querySelectorAll('[onclick],[onchange],[oninput],[onsubmit],[data-action]').forEach((el) => {
      const names = [];
      ['onclick', 'onchange', 'oninput', 'onsubmit'].forEach((attr) => {
        const v = el.getAttribute(attr);
        const m = v && v.match(attrRe);
        if (m) names.push(m[1]);
      });
      if (el.dataset.action) names.push(el.dataset.action);
      names.forEach((name) => {
        if (typeof window[name] !== 'function') missing.add(name);
      });
    });
    if (missing.size) {
      console.error(
        '[MY DRYBEA] ' + missing.size + ' handler(s) referenced in the DOM are NOT exposed on window ' +
        '(they will silently do nothing when clicked): ' + [...missing].join(', ') +
        '\nFix: add window.<name> = <name>; near the bottom of app.js for each.'
      );
    } else {
      console.log('[MY DRYBEA] Handler exposure check: all good, ' + document.querySelectorAll('[onclick],[onchange],[oninput],[onsubmit],[data-action]').length + ' handlers checked.');
    }
  }, 500);
});

})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('Service Worker registered!'))
      .catch(err => console.log('Service Worker error:', err));
  });
}

/* ---- script id="my-drybea-sync-controller" ---- */
(function(){
  const el = document.getElementById('syncIndicator');
  const state = el?.querySelector('.sync-state');
  const time = el?.querySelector('.sync-time');
  const refresh = document.getElementById('syncRefresh');
  if(!el || !state || !time) return;

  const now = () => new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'});
  const setSync = (kind, title, detail) => {
    el.classList.remove('syncing','connected','delayed','offline');
    el.classList.add(kind);
    state.textContent = title;
    time.textContent = detail || ('Last checked · ' + now());
    el.title = title + (detail ? ' · ' + detail : '');
  };

  window.setDrybeaSyncStatus = setSync;
  window.markDrybeaSyncing = () => setSync('syncing','Syncing…','Connecting to cloud');
  window.markDrybeaSyncSuccess = () => setSync('connected','Cloud connected','Last synced · ' + now());
  window.markDrybeaSyncDelayed = (msg) => setSync('delayed','Sync delayed',msg || ('Local data active · ' + now()));
  window.markDrybeaSyncOffline = () => setSync('offline','Offline mode','Local data active · ' + now());

  if(refresh){
    refresh.addEventListener('click', async () => {
      refresh.classList.add('spinning');
      window.markDrybeaSyncing();
      try{
        if(typeof window.cloudLoad === 'function'){
          await window.cloudLoad();
          window.markDrybeaSyncSuccess();
        }else{
          window.markDrybeaSyncDelayed('Cloud loader unavailable');
        }
      }catch(e){
        window.markDrybeaSyncDelayed('Local data active · ' + now());
      }finally{
        refresh.classList.remove('spinning');
      }
    });
  }

  // If the app's existing cloudLoad is declared globally, wrap it after parsing.
  // No Supabase parameters or query code are modified.
  const wrapCloudLoad = () => {
    if(typeof window.cloudLoad !== 'function' || window.cloudLoad.__drybeaWrapped) return;
    const original = window.cloudLoad;
    const wrapped = async function(){
      window.markDrybeaSyncing();
      try{
        const result = await original.apply(this, arguments);
        window.markDrybeaSyncSuccess();
        return result;
      }catch(err){
        window.markDrybeaSyncDelayed('Local data active · ' + now());
        throw err;
      }
    };
    wrapped.__drybeaWrapped = true;
    window.cloudLoad = wrapped;
  };

  // Delay gives the original page script time to define cloudLoad.
  setTimeout(wrapCloudLoad, 0);
  setTimeout(wrapCloudLoad, 250);
  setTimeout(wrapCloudLoad, 1000);

  window.addEventListener('online', () => {
    window.markDrybeaSyncing();
    setTimeout(wrapCloudLoad, 0);
  });
  window.addEventListener('offline', () => window.markDrybeaSyncOffline());
})();

/* ================================================================
   BOTTOM NAV — PROFESSIONAL 5-BUTTON REDESIGN, NO "MORE" BUTTON
   ------------------------------------------------------------------
   Every role now gets exactly 5 real nav tabs (see OWNER_NAV_TABS /
   STAFF_NAV_TABS / DRIVER_NAV_TABS / DISTRIBUTOR_NAV_TABS above,
   applied inside applyRoleUI()) — there is no overflow sheet and
   nothing else to route into one. This script's only remaining job
   is to tag every currently role-visible .tab-btn with .nav-primary
   so the CSS in index.html lays those 5 out evenly along the bar,
   and to keep that tagging in sync whenever the role or active tab
   changes — without editing applyRoleUI()/activateAppTab() bodies.
   ================================================================ */
(function(){
  function refreshBottomNav(){
    var navRoot = document.querySelector('nav.app-nav');
    if (!navRoot) return;
    var allTabBtns = Array.prototype.slice.call(navRoot.querySelectorAll('.tab-btn'));
    allTabBtns.forEach(function(btn){
      // Inline style is what applyRoleUI() itself sets, so it reflects true
      // role-visibility regardless of viewport width or existing classes.
      //
      // FIX: only tag a button as nav-primary once applyRoleUI() has
      // EXPLICITLY shown it (style.display === 'flex'). Before the user's
      // role is known (profile still loading from Supabase), no button has
      // display set yet — btn.style.display is '' (empty string), not
      // 'none'. The old check (`!== 'none'` counts as visible) treated that
      // unresolved state as "show it", so on first paint / slow networks
      // ALL ~24 tabs across every role got tagged nav-primary at once,
      // producing the squeezed, single-letter bottom-nav flash. Requiring
      // an explicit 'flex' means untouched buttons stay hidden (matching
      // the CSS default `.tab-btn{display:none}`) until the real role
      // resolves and applyRoleUI() sets 'flex' on just that role's tabs.
      if (btn.style.display === 'flex') { btn.classList.add('nav-primary'); }
      else { btn.classList.remove('nav-primary'); }
    });
    if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } });
  }
  window.refreshBottomNav = refreshBottomNav;

  // Wrap applyRoleUI / activateAppTab once both are defined (they're plain
  // function declarations above, hoisted to this same script's top-level
  // scope, so no window.* prefix is required to read or reassign them).
  function wrapWhenReady(){
    if (typeof applyRoleUI === 'function' && !applyRoleUI.__drybeaNavWrapped) {
      var origApplyRoleUI = applyRoleUI;
      var wrappedApplyRoleUI = function(){
        var r = origApplyRoleUI.apply(this, arguments);
        refreshBottomNav();
        return r;
      };
      wrappedApplyRoleUI.__drybeaNavWrapped = true;
      applyRoleUI = wrappedApplyRoleUI;
      window.applyRoleUI = wrappedApplyRoleUI;
    }
    if (typeof activateAppTab === 'function' && !activateAppTab.__drybeaNavWrapped) {
      var origActivateAppTab = activateAppTab;
      var wrappedActivateAppTab = function(tabId){
        var r = origActivateAppTab.apply(this, arguments);
        refreshBottomNav();
        return r;
      };
      wrappedActivateAppTab.__drybeaNavWrapped = true;
      activateAppTab = wrappedActivateAppTab;
      window.activateAppTab = wrappedActivateAppTab;
    }
  }

  // Call the wrap immediately (synchronously), right here, not just on a
  // timer. applyRoleUI and activateAppTab are plain `function` declarations
  // defined earlier in this same file, so they already exist by the time
  // this line runs — wrapping them now, before any async login/auth code
  // gets a chance to run, guarantees the very first real call to either
  // one (even from a fast/cached mobile session that resolves almost
  // instantly) goes through the wrapped version and refreshes the bottom
  // nav. The timers below are just extra safety nets, not the primary path.
  try { wrapWhenReady(); } catch (e) { console.error('Bottom nav wrap error:', e); }

  document.addEventListener('DOMContentLoaded', function(){
    try {
      wrapWhenReady();
      refreshBottomNav();
    } catch (e) { console.error('Bottom nav init error:', e); }
    setTimeout(function(){ try { refreshBottomNav(); } catch(e){ console.error('Bottom nav refresh error:', e); } }, 300);
  });
  setTimeout(function(){ try { wrapWhenReady(); } catch(e){ console.error('Bottom nav wrap error:', e); } }, 0);
  setTimeout(function(){ try { wrapWhenReady(); } catch(e){ console.error('Bottom nav wrap error:', e); } }, 500);
  setTimeout(function(){ try { refreshBottomNav(); } catch(e){ console.error('Bottom nav refresh error:', e); } }, 800);
  window.addEventListener('load', function(){ try { refreshBottomNav(); } catch(e){ console.error('Bottom nav refresh error:', e); } });

  window.addEventListener('resize', function(){ try { refreshBottomNav(); } catch(e){ console.error('Bottom nav resize error:', e); } });
})();
