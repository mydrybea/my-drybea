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
let currentUser = null;
let userProfile = null;
let userRole = 'owner';   // 'owner' | 'staff' | 'driver'
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

    userRole = userProfile.role === 'staff' ? 'staff' : (userProfile.role === 'driver' ? 'driver' : 'owner');
    businessId = (userRole === 'staff' || userRole === 'driver') ? userProfile.owner_id : currentUser.id;
  } catch (e) {
    console.error('Load profile error:', e);
    // Fail safe: treat as an independent owner of their own data.
    userRole = 'owner';
    businessId = currentUser.id;
  }
  applyRoleUI();
  if (userRole === 'driver') {
    await loadMyDeliveries();
    startDriverDeliveriesRealtime();
  } else {
    await loadMyStaffData(false);
    startAppNotifyRealtime();
  }
}

const STAFF_ALLOWED_TABS = ['staff-home','orders','my-salary','profile','expenses'];
const DRIVER_ALLOWED_TABS = ['my-deliveries','profile'];

function applyRoleUI() {
  const isStaff = userRole === 'staff';
  const isDriver = userRole === 'driver';
  const isRestricted = isStaff || isDriver; // anyone who isn't the owner

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

  // Every nav tab button: lock down to exactly the tabs each role may see.
  document.querySelectorAll('.tab-btn').forEach(el => {
    const tab = el.getAttribute('data-tab');
    if (isStaff) {
      el.style.display = STAFF_ALLOWED_TABS.includes(tab) ? 'flex' : 'none';
    } else if (isDriver) {
      el.style.display = DRIVER_ALLOWED_TABS.includes(tab) ? 'flex' : 'none';
    }
  });

  const navEl = document.querySelector('.app-nav');
  if (navEl) {
    navEl.classList.toggle('staff-nav', isStaff);
    navEl.classList.toggle('driver-nav', isDriver);
  }

  const roleBadge = $('roleBadge');
  if (roleBadge) {
    const icon = isDriver ? 'truck' : (isStaff ? 'user-round' : 'crown');
    const label = isDriver ? 'Driver' : (isStaff ? 'Staff' : 'Owner');
    roleBadge.innerHTML = `<i class="business-icon icon-inline" data-lucide="${icon}" aria-hidden="true"></i> ${label}`;
  }
  if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } });

  const ownerSalaryTab = document.querySelector('[data-tab="staff-salary"]');
  if (ownerSalaryTab) ownerSalaryTab.style.display = isRestricted ? 'none' : '';

  const ownerSalaryEditor = $('salaryPanel');
  if (ownerSalaryEditor && isRestricted) ownerSalaryEditor.style.display = 'none';

  // Staff lands on the dedicated operations home; drivers land on their delivery list.
  if (typeof activateAppTab === 'function') {
    if (isStaff) activateAppTab('staff-home');
    else if (isDriver) activateAppTab('my-deliveries');
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
    return `
    <tr>
      <td>${s.display_name || '(no name)'} ${isDrv ? '<span style="background:#eef;color:#334;padding:2px 7px;border-radius:6px;font-size:11px;font-weight:700;">🚚 Driver</span>' : ''}</td>
      <td style="font-size:11px;word-break:break-all;">${s.id}</td>
      <td data-owner-only><button class="btn btn-sm btn-danger" aria-label="Remove" onclick="removeStaffMember('${s.id}')"><i class="business-icon" data-lucide="trash-2" aria-hidden="true"></i></button></td>
    </tr>
  `;
  }).join('');
  // Only actual staff (not drivers) go into salary/commission pickers.
  populateSalaryStaffSelect(list.filter(s => s.role !== 'driver'));
  populateDriverSelects(list.filter(s => s.role === 'driver'));
  if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } });
}

let driverListCache = [];
function populateDriverSelects(drivers) {
  driverListCache = drivers || [];
  renderDelivery();
}

async function addStaffMember() {
  if (userRole !== 'owner') { alert('Only the business owner can add staff.'); return; }
  const uid = $('staffUid').value.trim();
  const name = $('staffName').value.trim();
  const roleSelect = $('staffRoleSelect');
  const role = (roleSelect && roleSelect.value === 'driver') ? 'driver' : 'staff';
  if (!uid) { alert("Enter the team member's Supabase User ID."); return; }
  if (uid === currentUser.id) { alert('That is your own account.'); return; }

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
  try {
    const { error } = await supabase.from('profiles').delete().eq('id', uid).eq('owner_id', currentUser.id);
    if (error) throw error;
    await loadStaffList();
  } catch (e) {
    console.error('Remove staff error:', e);
    alert('❌ Could not remove staff: ' + e.message);
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

async function deleteSalaryEntry(id) {
  if (!confirm('Delete this salary entry?')) return;
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
        <td><button class="btn btn-sm btn-danger" onclick="deleteSalaryEntry('${s.id}')">🗑️</button></td>
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
  const btn = document.querySelector('button[onclick="submitAdvanceRequest()"]');
  if (btn) { btn.disabled = true; btn.dataset.originalText = btn.textContent; btn.textContent = 'Sending…'; }
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
  try {
    const { error } = await supabase.from('profiles').update({ whatsapp_number: num || null }).eq('id', currentUser.id);
    if (error) throw error;
    updateStatus('✅ WhatsApp number saved');
  } catch (e) {
    console.error('Save owner whatsapp error:', e);
    alert('❌ Could not save number: ' + e.message);
  }
}

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
          <button class="btn btn-sm btn-primary" onclick="decideAdvance('${r.id}','approved')">✅</button>
          <button class="btn btn-sm btn-danger" onclick="decideAdvance('${r.id}','rejected')">❌</button>
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
  dashQty: {50:1000, 100:500, 500:50, 1000:50},
  dashSp: {50:170, 100:350, 500:1750, 1000:3500},
  overhead: {...DEFAULT_FIXED},
  production: {
    rawLinna: 180, rawBalaya: 250, rawKawalam: 60,
    yieldLinna: 6, yieldBalaya: 6, yieldKawalam: 7,
    dailyRawKg: 500, workDays: 22,
    prodTransport: 110000, prodFirewood: 30000,
    prodWorkers: 220000, prodOther: 220000,
    finLinna: 1750, finBalaya: 2200, finKawalam: 1000
  }
};
let history = [];
let orders = [];
let customers = [];
let snapshots = [];
let lastSaveTime = null;
let saveTimer = null;
let appInitialized = false;

// ==================== HELPERS ====================
const $ = id => document.getElementById(id);
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

function calculatePack(sizeKey, linnaPrice, balayaPrice, premiumPrice, mixPct, mode, targetProfit, customSp) {
  const p = PACKS[sizeKey];
  const linnaUsableG = p.fish * mixPct.linna;
  const balayaUsableG = p.fish * mixPct.balaya;
  const premiumUsableG = p.fish * mixPct.kawalam;
  const linnaRawG = linnaUsableG / LINNA_USABLE;
  const balayaRawG = balayaUsableG / BALAYA_USABLE;
  const premiumRawG = premiumUsableG / PREMIUM_USABLE;
  const linnaCost = (linnaRawG/1000) * linnaPrice;
  const balayaCost = (balayaRawG/1000) * balayaPrice;
  const premiumCost = (premiumRawG/1000) * premiumPrice;
  const rawFishCost = linnaCost + balayaCost + premiumCost;
  const baseCost = rawFishCost + p.grind + p.pack;
  let sp;
  if (mode === 'profit') sp = (baseCost + targetProfit) / (1 - PACKING_LABOUR_PCT);
  else if (mode === 'sp') sp = customSp;
  else sp = p.mrp;
  const packingLabour = sp * PACKING_LABOUR_PCT;
  const totalCost = baseCost + packingLabour;
  const profit = sp - totalCost;
  const margin = sp > 0 ? (profit/sp)*100 : 0;
  return { p, linnaRawG, balayaRawG, premiumRawG, linnaCost, balayaCost, premiumCost, rawFishCost, baseCost, sp, packingLabour, totalCost, profit, margin };
}

function getFixedCost() {
  return Object.values(state.overhead).reduce((a,b)=>a+b,0);
}

function getAllocatedOverheadPerPack() {
  let totalPacks = 0;
  Object.keys(PACKS).forEach(key => { totalPacks += state.dashQty[key] || 0; });
  const fixed = getFixedCost();
  return totalPacks > 0 ? fixed / totalPacks : 0;
}

// ==================== CHARTS ====================
let costChart = null, sensChart = null, prodChart = null;

function getChartColors() {
  const isDark = state.theme === 'dark';
  return {
    text: isDark ? '#d1fae5' : '#065f46',
    grid: isDark ? 'rgba(16,185,129,0.1)' : 'rgba(5,150,105,0.1)',
    border: isDark ? 'rgba(16,185,129,0.2)' : 'rgba(5,150,105,0.15)'
  };
}

// ==================== CALCULATIONS ====================
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

  const rows = [
    [`Linna fish (${fmt2(r.linnaRawG)}g raw)`, r.linnaCost],
    [`Balaya fish (${fmt2(r.balayaRawG)}g raw)`, r.balayaCost],
    [`Premium Mix (${fmt2(r.premiumRawG)}g raw)`, r.premiumCost],
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
  calcSensitivity();
  calcDashboard();
  renderDynamicPricing();
}

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

  const rows = Object.keys(PACKS).map(k => {
    const p = PACKS[k];
    let r;
    try {
      r = calculatePack(k, state.linnaPrice, state.balayaPrice, state.kawalamPrice, mix, 'mrp', 0, 0);
    } catch (e) { return null; }
    const currentCost = r.totalCost;
    const currentMargin = p.mrp > 0 ? ((p.mrp - currentCost) / p.mrp) * 100 : 0;
    // Solve sp such that: sp = baseCost + sp*PACKING_LABOUR_PCT + sp*(targetMargin/100)
    const denom = 1 - PACKING_LABOUR_PCT - (targetMargin / 100);
    const suggestedSp = denom > 0 ? r.baseCost / denom : null;
    const diff = suggestedSp !== null ? suggestedSp - p.mrp : null;
    return { label: p.label, mrp: p.mrp, cost: currentCost, margin: currentMargin, suggestedSp, diff };
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
      <td class="num">${fmt(row.mrp)}</td>
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
  const mixA = $('scA').value.split('/').map(Number);
  const mixB = $('scB').value.split('/').map(Number);
  const spA = Number($('scASp').value) || 0;
  const spB = Number($('scBSp').value) || 0;
  const rA = calculatePack(sizeKey, state.linnaPrice, state.balayaPrice, state.kawalamPrice, {linna:mixA[0]/100,balaya:mixA[1]/100,kawalam:mixA[2]/100}, 'sp', 0, spA);
  const rB = calculatePack(sizeKey, state.linnaPrice, state.balayaPrice, state.kawalamPrice, {linna:mixB[0]/100,balaya:mixB[1]/100,kawalam:mixB[2]/100}, 'sp', 0, spB);
  const metrics = [
    ['Fish Cost', rA.rawFishCost, rB.rawFishCost, 'cost'],
    ['Total Cost', rA.totalCost, rB.totalCost, 'cost'],
    ['Profit', rA.profit, rB.profit, 'profit'],
    ['Margin %', rA.margin, rB.margin, 'profit']
  ];
  $('scenarioBody').innerHTML = metrics.map(m => {
    const best = m[3]==='cost' ? (m[1]<m[2]?'A':m[1]>m[2]?'B':'Tie') : (m[1]>m[2]?'A':m[1]<m[2]?'B':'Tie');
    return `<tr><td>${m[0]}</td><td class="num">${m[0].includes('%')?fmt2(m[1])+'%':fmt(m[1])}</td><td class="num">${m[0].includes('%')?fmt2(m[2])+'%':fmt(m[2])}</td><td class="num"><span class="badge badge-good">${best}</span></td></tr>`;
  }).join('');
}

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

function calcSensitivity() {
  const sizeKey = $('sensSize').value;
  const mix = getMixPct();
  const sp = state.dashSp[sizeKey] || PACKS[sizeKey].mrp;
  let html = '';
  const labels = [], profits = [];
  for (let price = 1400; price <= 2100; price += 50) {
    const r = calculatePack(sizeKey, price, state.balayaPrice, state.kawalamPrice, mix, 'sp', 0, sp);
    html += `<tr><td>Rs.${price}</td><td>${fmt(r.rawFishCost)}</td><td class="num">${fmt(r.totalCost)}</td><td class="num"><span class="badge ${r.profit>=0?'badge-good':'badge-bad'}">${fmt(r.profit)}</span></td><td class="num">${fmt2(r.margin)}%</td></tr>`;
    labels.push('Rs.'+price);
    profits.push(Math.round(r.profit));
  }
  $('sensBody').innerHTML = html;
  const colors = getChartColors();
  const ctx = $('sensChart').getContext('2d');
  const chartData = {labels, datasets:[{label:'Profit', data:profits, borderColor:'#10b981', fill:true, backgroundColor:'rgba(16,185,129,0.08)', tension:0.4, pointBackgroundColor:'#10b981', pointRadius:3, pointHoverRadius:6, borderWidth:2}]};
  if (sensChart) { sensChart.data = chartData; sensChart.update(); }
  else {
    sensChart = new Chart(ctx, {
      type:'line',
      data: chartData,
      options:{
        responsive:true,
        maintainAspectRatio:false,
        plugins:{legend:{display:false}},
        scales:{
          y:{beginAtZero:true, grid:{color:colors.grid}, ticks:{color:colors.text, font:{size:10}}},
          x:{grid:{color:colors.grid}, ticks:{color:colors.text, font:{size:10}}}
        }
      }
    });
  }
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
function calcProduction() {
  const rawLinna = Number($('rawLinna').value) || 0;
  const rawBalaya = Number($('rawBalaya').value) || 0;
  const rawPremium = Number($('rawKawalam').value) || 0;
  const yLinna = Number($('yieldLinna').value) || 1;
  const yBalaya = Number($('yieldBalaya').value) || 1;
  const yPremium = Number($('yieldKawalam').value) || 1;
  const dailyRaw = Number($('dailyRawKg').value) || 0;
  const days = Number($('workDays').value) || 1;
  const fixedCost = (Number($('prodTransport').value)||0) + (Number($('prodFirewood').value)||0) + (Number($('prodWorkers').value)||0) + (Number($('prodOther').value)||0);
  const finLinna = Number($('finLinna').value) || 0;
  const finBalaya = Number($('finBalaya').value) || 0;
  const finPremium = Number($('finKawalam').value) || 0;

  const monthlyRawKg = dailyRaw * days;
  $('prodMonthlyRaw').textContent = monthlyRawKg.toFixed(0) + ' kg';

  const avgYield = (yLinna + yBalaya + yPremium) / 3;
  const monthlyFinished = monthlyRawKg / avgYield;
  $('prodMonthlyFinished').textContent = monthlyFinished.toFixed(1) + ' kg';

  const fixedPerKg = monthlyFinished > 0 ? fixedCost / monthlyFinished : 0;
  $('prodFixedPerKg').textContent = fmt(fixedPerKg);

  const fishTypes = [
    { name:'Linna', rawPrice:rawLinna, yield:yLinna, finPrice:finLinna },
    { name:'Balaya', rawPrice:rawBalaya, yield:yBalaya, finPrice:finBalaya },
    { name:'Premium Mix', rawPrice:rawPremium, yield:yPremium, finPrice:finPremium }
  ];

  let totalCostSum = 0;
  let html = '';
  const labels = [], costs = [], prices = [], profitsData = [];

  fishTypes.forEach(ft => {
    const rawCostPerKg = ft.rawPrice * ft.yield;
    const totalCostPerKg = rawCostPerKg + fixedPerKg;
    const profitPerKg = ft.finPrice - totalCostPerKg;
    const margin = ft.finPrice > 0 ? (profitPerKg/ft.finPrice)*100 : 0;
    const verdict = profitPerKg > 0 ? '<span class="badge badge-good">PROFIT</span>' : '<span class="badge badge-bad">LOSS</span>';

    totalCostSum += totalCostPerKg;
    labels.push(ft.name);
    costs.push(Math.round(rawCostPerKg));
    prices.push(Math.round(totalCostPerKg));
    profitsData.push(Math.round(profitPerKg));

    html += `<tr>
      <td><strong>${ft.name}</strong></td>
      <td>${fmt(rawCostPerKg)}</td>
      <td>${fmt(fixedPerKg)}</td>
      <td>${fmt(totalCostPerKg)}</td>
      <td>${fmt(ft.finPrice)}</td>
      <td class="num"><span class="badge ${profitPerKg>=0?'badge-good':'badge-bad'}">${fmt(profitPerKg)}</span></td>
      <td class="num">${fmt2(margin)}%</td>
      <td>${verdict}</td>
    </tr>`;
  });

  $('prodBody').innerHTML = html;

  const avgCostPerKg = totalCostSum / 3;
  $('prodAvgCost').textContent = fmt(avgCostPerKg);

  const avgFinPrice = (finLinna + finBalaya + finPremium) / 3;
  const avgProfitPerKg = avgFinPrice - avgCostPerKg;
  const breakEven = avgProfitPerKg > 0 ? fixedCost / avgProfitPerKg : Infinity;
  $('breakEvenKg').textContent = isFinite(breakEven) ? breakEven.toFixed(0) + ' kg' : 'N/A (not profitable)';

  const colors = getChartColors();
  const ctx = $('prodChart').getContext('2d');
  const chartData = {
    labels: labels,
    datasets: [
      { label:'Raw Cost/kg', data: costs, backgroundColor: 'rgba(56,189,248,0.8)', borderRadius: 6 },
      { label:'Total Cost/kg', data: prices, backgroundColor: 'rgba(16,185,129,0.8)', borderRadius: 6 },
      { label:'Profit/kg', data: profitsData, backgroundColor: 'rgba(167,139,250,0.8)', borderRadius: 6 }
    ]
  };
  if (prodChart) { prodChart.data = chartData; prodChart.update(); }
  else {
    prodChart = new Chart(ctx, {
      type:'bar',
      data: chartData,
      options: {
        responsive:true, maintainAspectRatio:false,
        plugins:{legend:{position:'bottom',labels:{boxWidth:10,font:{size:11,family:'Inter'},color:colors.text,padding:12,usePointStyle:true,pointStyle:'circle'}}},
        scales:{
          y:{beginAtZero:true,grid:{color:colors.grid},ticks:{color:colors.text,font:{size:10}}},
          x:{grid:{display:false},ticks:{color:colors.text,font:{size:10}}}
        },
        barPercentage: 0.7,
        categoryPercentage: 0.8
      }
    });
  }

  state.production = {
    rawLinna, rawBalaya, rawKawalam: rawPremium,
    yieldLinna: yLinna, yieldBalaya: yBalaya, yieldKawalam: yPremium,
    dailyRawKg: dailyRaw, workDays: days,
    prodTransport: Number($('prodTransport').value)||0,
    prodFirewood: Number($('prodFirewood').value)||0,
    prodWorkers: Number($('prodWorkers').value)||0,
    prodOther: Number($('prodOther').value)||0,
    finLinna, finBalaya, finKawalam: finPremium
  };
}

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
    assignedDriverId: o.assigned_driver_id || null
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
  $('expDate').value = new Date().toISOString().slice(0, 10);
  $('expCategory').value = 'Transport';
  $('expDescription').value = '';
  $('expAmount').value = 0;
  if ($('expRecurring')) $('expRecurring').checked = false;
  $('expenseModal').classList.add('active');
}

async function saveExpense() {
  const date = $('expDate').value || new Date().toISOString().slice(0, 10);
  const category = $('expCategory').value;
  const description = $('expDescription').value.trim();
  const amount = Number($('expAmount').value) || 0;
  const isRecurring = $('expRecurring') ? $('expRecurring').checked : false;

  if (!currentUser) { alert('Please login first.'); return; }
  if (amount <= 0) { alert('Enter an amount greater than 0!'); return; }

  const row = {
    expense_date: date,
    category,
    description,
    amount,
    created_by: currentUser.id
  };

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
        <td>${userRole === 'owner' ? `<button class="btn btn-sm btn-danger" onclick="deleteExpense('${e.id}')">🗑️</button>` : '<span style="opacity:.4;">—</span>'}</td>
      </tr>
    `).join('');
  }
  updateExpenseStats();
}

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

  for (const r of due) {
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
  }
  renderExpenses();
  renderRecurringExpenses();
  updateMonthlySummary();
  updateStatus('🔁 Daily recurring expenses added');
}

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
        <button class="btn btn-sm" onclick="toggleRecurringExpense('${r.id}', ${!r.active})">${r.active ? '⏸️ Pause' : '<i class="business-icon icon-inline" data-lucide="play" aria-hidden="true"></i> Resume'}</button>
        <button class="btn btn-sm btn-danger" onclick="deleteRecurringExpense('${r.id}')">🗑️</button>
      </td>
    </tr>
  `).join('');
}

async function toggleRecurringExpense(id, newActive) {
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
  const row = { id: Date.now().toString(), user_id: businessId, name, phone, address, referral_staff_id: referralStaffId, referral_staff_reference: referralStaffReference };
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
      <td><button class="btn btn-sm btn-danger" onclick="deleteCustomer('${c.id}')">🗑️</button></td>
    </tr>
  `).join('');
}

async function deleteCustomer(id) {
  if (!confirm('Delete this customer?')) return;
  if (!currentUser) { alert('Please login first.'); return; }
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
  if (customers.length === 0) {
    select.innerHTML = '<option value="">— Add customer first —</option>';
    return;
  }
  select.innerHTML = customers.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
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
  if(userRole==='staff'){
    if(staffBlock) staffBlock.style.display='';
    if(ownerBlock) ownerBlock.style.display='none';
    const ref=document.querySelector('[data-owner-order-referral]'); if(ref) ref.style.display='none';
    if($('staffOrderCustomerName')) $('staffOrderCustomerName').value='';
    if($('staffOrderCustomerPhone')) $('staffOrderCustomerPhone').value='';
  } else {
    if(staffBlock) staffBlock.style.display='none';
    if(ownerBlock) ownerBlock.style.display='';
    updateCustomerSelect();
    populateStaffReferralSelectors();
    const f=document.querySelector('[data-owner-order-referral]'); if(f) f.style.display='';
    const c=customers.find(x=>String(x.id)===String($('orderCustomer').value)); if($('orderReferralStaffSelect') && c?.referralStaffId) $('orderReferralStaffSelect').value=c.referralStaffId;
  }
  $('orderAddress').value = '';
  $('orderNotes').value = '';
  $('orderQty').value = 1;
  $('orderUnitPrice').value = 350;
  if ($('orderProduct')) $('orderProduct').value = '50';
  syncOrderSizeChips();
  updateOrderTotal();
  $('orderModal').classList.add('active');
  if(window.lucide) lucide.createIcons({attrs:{'stroke-width':1.9,'stroke-linecap':'round','stroke-linejoin':'round'}});
}

function openNewCustomer() {
  const ref = document.querySelector('[data-staff-referral-field]');
  if(ref) ref.style.display = userRole === 'staff' ? '' : 'none';
  if($('custReferralStaffName') && userRole === 'staff') $('custReferralStaffName').textContent = ((userProfile&&userProfile.display_name)||currentUser?.email||'Staff') + ' · ' + ((userProfile&&userProfile.staff_reference)||('STF-'+currentUser.id.slice(0,8).toUpperCase()));
  if(userRole==='owner'){ populateStaffReferralSelectors(); const f=document.querySelector('[data-owner-referral-field]'); if(f) f.style.display=''; }
  $('customerModal').classList.add('active');
}

async function createOrder() {
  const product = $('orderProduct').value;
  const qty = Number($('orderQty').value) || 0;
  const unitPrice = Number($('orderUnitPrice').value) || 0;
  const notes = $('orderNotes').value.trim();
  if (qty <= 0) { alert('Quantity must be at least 1!'); return; }
  if (unitPrice <= 0) { alert('Unit price required!'); return; }
  if (!currentUser) { alert('Please login first.'); return; }

  // STAFF MODE: no customer master list. The sale itself owns the customer snapshot.
  if (userRole === 'staff') {
    const customerName = $('staffOrderCustomerName')?.value.trim() || '';
    const customerPhone = $('staffOrderCustomerPhone')?.value.trim() || '';
    const address = $('orderAddress').value.trim();
    if (!customerName) { alert('Customer name is required.'); return; }
    if (!address) { alert('Delivery address is required.'); return; }

    try {
      // Server creates the immutable random SALE REF and the pending commission claim atomically.
      const { data, error } = await supabase.rpc('create_staff_sale_secure', {
        p_product_size_g: Number(product) || 0,
        p_qty: qty,
        p_unit_price: unitPrice,
        p_customer_name: customerName,
        p_customer_phone: customerPhone,
        p_customer_address: address,
        p_notes: notes
      });
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
  if (!customerId) { alert('Select a customer!'); return; }
  const customer = customers.find(c=>String(c.id)===String(customerId));
  let referralStaffId = customer?.referralStaffId || null;
  let referralStaffReference = customer?.referralStaffReference || null;
  if ($('orderReferralStaffSelect')?.value) {
    referralStaffId = $('orderReferralStaffSelect').value;
    referralStaffReference = (staffListCache||[]).find(s=>String(s.id)===String(referralStaffId))?.staff_reference || null;
  }
  const total = qty * unitPrice;
  const row = { id: generateOrderId(), user_id: businessId, customer_id: customerId, product_size_g: Number(product)||0, qty, unit_price:unitPrice, total, address, notes, status:'pending', created_by:currentUser.id, referral_staff_id:referralStaffId, referral_staff_reference:referralStaffReference, referral_status:referralStaffId?'pending_verification':'none' };
  try {
    const { data, error } = await supabase.from('orders').insert(row).select().single();
    if (error) throw error;
    if (referralStaffId) {
      const claim = { owner_id: businessId, staff_id:String(referralStaffId), staff_reference:referralStaffReference||'', order_id:String(data.id), customer_id:String(customerId), customer_name:customer?.name||'', customer_phone:customer?.phone||'', order_total:total, commission_rate:STAFF_COMMISSION_RATE, commission_amount:0, status:'pending', order_ref_no:data.order_ref_no||null, order_snapshot:{order_id:data.id,order_ref_no:data.order_ref_no||null,customer_id:customerId,customer_name:customer?.name||'',product_size_g:Number(product)||0,qty,unit_price:unitPrice,total,address,notes,created_by:currentUser.id,referral_staff_id:String(referralStaffId),referral_staff_reference:referralStaffReference} };
      const { error: ce } = await supabase.from('staff_commission_claims').insert(claim);
      if (ce) console.error('Owner referral claim create failed:',ce);
    }
  } catch (e) { console.error('Create order error:',e); alert('❌ Could not save order: '+e.message); return; }
  orders.unshift({id:row.id,customerId,product,qty,unitPrice,total,address,notes,status:'pending',createdBy:currentUser.id,createdAt:new Date().toISOString(),referralStaffId,referralStaffReference,referralStatus:referralStaffId?'pending_verification':'none',orderRefNo:row.order_ref_no||null});
  saveOrders(); renderOrders(); renderDelivery(); updateOrderStats(); closeModal('orderModal');
  $('orderQty').value=1; $('orderUnitPrice').value=350; $('orderAddress').value=''; $('orderNotes').value='';
  if ($('orderProduct')) $('orderProduct').value = '50';
  syncOrderSizeChips(); updateOrderTotal();
  updateStatus(referralStaffId ? '📨 Sale sent to owner for commission verification' : '✅ Order created');
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
      ? `<button class="btn btn-sm" onclick="viewInvoice(${index})"><i class="business-icon" data-lucide="receipt-text" aria-hidden="true"></i></button>
         <button class="btn btn-sm" onclick="cycleStatus(${index})"><i class="business-icon" data-lucide="refresh-cw" aria-hidden="true"></i></button>
         <button class="btn btn-sm btn-danger" onclick="deleteOrder(${index})"><i class="business-icon" data-lucide="trash-2" aria-hidden="true"></i></button>`
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
}

function getStatusBadge(status) {
  switch(status) {
    case 'pending': return '<span class="badge badge-pending">⏳ Pending</span>';
    case 'shipped': return '<span class="badge badge-shipped"><i class="business-icon icon-inline" data-lucide="truck" aria-hidden="true"></i> Shipped</span>';
    case 'delivered': return '<span class="badge badge-delivered"><i class="business-icon icon-inline" data-lucide="circle-check" aria-hidden="true"></i> Delivered</span>';
    case 'cancelled': return '<span class="badge badge-cancelled"><i class="business-icon icon-inline" data-lucide="circle-x" aria-hidden="true"></i> Cancelled</span>';
    default: return status;
  }
}

async function cycleStatus(index) {
  if (userRole !== 'owner') { alert('🔒 Only the business owner can change order status.'); return; }
  const cycle = ['pending', 'shipped', 'delivered', 'cancelled'];
  const order = orders[index];
  if (!currentUser) { alert('Please login first.'); return; }
  const newStatus = cycle[(cycle.indexOf(order.status) + 1) % cycle.length];
  try {
    const { error } = await supabase.from('orders').update({ status: newStatus }).eq('id', order.id).eq('user_id', businessId);
    if (error) throw error;
  } catch (e) {
    console.error('Update order status error:', e);
    alert('❌ Could not update order status: ' + e.message);
    return;
  }
  order.status = newStatus;
  saveOrders();
  renderOrders();
  renderDelivery();
  updateOrderStats();
  updateMonthlySummary();
  updateStatus('🔄 Order status updated');
}

async function deleteOrder(index) {
  if (userRole !== 'owner') { alert('🔒 Only the business owner can delete orders.'); return; }
  if (!confirm('Delete this order?')) return;
  if (!currentUser) { alert('Please login first.'); return; }
  const order = orders[index];
  try {
    const { error } = await supabase.from('orders').delete().eq('id', order.id).eq('user_id', businessId);
    if (error) throw error;
  } catch (e) {
    console.error('Delete order error:', e);
    alert('❌ Could not delete order: ' + e.message);
    return;
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
}

function renderDelivery() {
  const tbody = $('deliveryBody');
  if (!tbody) return;
  const activeOrders = orders.filter(o => o.status !== 'cancelled');
  if (activeOrders.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;opacity:0.5;padding:20px;">No active deliveries.</td></tr>';
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
    return `<tr>
      <td><strong>${order.id}</strong></td>
      <td>${getCustomerName(order.customerId)}</td>
      <td>${order.address || '-'}</td>
      <td>${getStatusBadge(order.status)}</td>
      <td data-owner-only>${driverCell}</td>
      <td><button class="btn btn-sm" onclick="cycleStatus(${realIndex})"><i class="business-icon icon-inline" data-lucide="refresh-cw" aria-hidden="true"></i> Update</button></td>
    </tr>`;
  }).join('');
}

async function assignDriver(orderId, driverId) {
  if (userRole !== 'owner') return;
  try {
    const { error } = await supabase.from('orders')
      .update({ assigned_driver_id: driverId || null })
      .eq('id', orderId).eq('user_id', businessId);
    if (error) throw error;
    const o = orders.find(x => String(x.id) === String(orderId));
    if (o) o.assignedDriverId = driverId || null;
    saveOrders();
    updateStatus(driverId ? '🚚 Driver assigned' : '🚚 Driver unassigned');
  } catch (e) {
    console.error('Assign driver error:', e);
    alert('❌ Could not assign driver: ' + e.message + '\n\nMake sure the "assigned_driver_id" column exists on the orders table in Supabase.');
  }
}
window.assignDriver = assignDriver;

// ==================== DRIVER: MY DELIVERIES ====================
let myDeliveries = [];

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

function renderMyDeliveries() {
  const tbody = $('myDeliveriesBody');
  if (!tbody) return;
  const active = myDeliveries.filter(o => o.status !== 'cancelled' && o.status !== 'delivered');
  const done = myDeliveries.filter(o => o.status === 'delivered');
  if (active.length === 0 && done.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;opacity:.5;padding:20px;">No deliveries assigned to you right now.</td></tr>';
    return;
  }
  const rows = active.concat(done.slice(0, 10)); // keep recent delivered visible, don't let history grow unbounded
  tbody.innerHTML = rows.map(o => {
    const addr = o.address || '';
    const mapsUrl = addr ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addr)}` : '';
    const nextBtn = o.status === 'pending'
      ? `<button class="btn btn-sm btn-primary" onclick="driverMarkStatus('${o.id}','shipped')"><i class="business-icon icon-inline" data-lucide="truck" aria-hidden="true"></i> Start Delivery</button>`
      : (o.status === 'shipped'
        ? `<button class="btn btn-sm btn-primary" onclick="driverMarkStatus('${o.id}','delivered')"><i class="business-icon icon-inline" data-lucide="circle-check" aria-hidden="true"></i> Mark Delivered</button>`
        : '');
    return `<tr>
      <td><strong>${o.order_ref_no || String(o.id).slice(0,8)}</strong></td>
      <td>${escapeHtmlSafe(o.customer_name_snapshot || o.customer_address_snapshot || '-')}</td>
      <td>${escapeHtmlSafe(addr || '-')}</td>
      <td>${getStatusBadge(o.status)}</td>
      <td>
        ${addr ? `<a href="${mapsUrl}" target="_blank" rel="noopener" class="btn btn-sm" style="margin-right:6px;"><i class="business-icon icon-inline" data-lucide="map-pin" aria-hidden="true"></i> Navigate</a>` : ''}
        ${nextBtn}
      </td>
    </tr>`;
  }).join('');
  if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } });
}

async function driverMarkStatus(orderId, newStatus) {
  if (userRole !== 'driver') return;
  try {
    const { error } = await supabase.from('orders')
      .update({ status: newStatus })
      .eq('id', orderId).eq('assigned_driver_id', currentUser.id);
    if (error) throw error;
    const o = myDeliveries.find(x => String(x.id) === String(orderId));
    if (o) o.status = newStatus;
    renderMyDeliveries();
    updateStatus(newStatus === 'delivered' ? '✅ Marked delivered' : '🚚 Delivery started');
  } catch (e) {
    console.error('Driver status update error:', e);
    alert('❌ Could not update delivery status: ' + e.message);
  }
}
window.driverMarkStatus = driverMarkStatus;

let driverDeliveriesChannel = null;
function startDriverDeliveriesRealtime() {
  if (!currentUser || userRole !== 'driver' || driverDeliveriesChannel) return;
  driverDeliveriesChannel = supabase
    .channel('driver-deliveries-' + currentUser.id)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'orders', filter: `assigned_driver_id=eq.${currentUser.id}`
    }, () => { loadMyDeliveries(); })
    .subscribe();
}

// ==================== LIVE DRIVER LOCATION TRACKING ====================
// Free stack: OpenStreetMap tiles + Leaflet.js (no API key), Supabase Realtime for live pins.

// ---- Owner side: live map of all sharing drivers ----
let ownerDriverMap = null;
let ownerDriverMarkers = {};
let ownerDriverLocationsChannel = null;

function initOwnerDriverMap() {
  if (ownerDriverMap || userRole !== 'owner') return;
  const el = document.getElementById('ownerDriverMap');
  if (!el || typeof L === 'undefined') return;
  ownerDriverMap = L.map(el).setView([7.8731, 80.7718], 8); // default: Sri Lanka
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(ownerDriverMap);
  setTimeout(() => ownerDriverMap && ownerDriverMap.invalidateSize(), 200);
  startOwnerDriverLocationsRealtime();
}

async function loadDriverLocations() {
  if (userRole !== 'owner' || !currentUser) return;
  try {
    const { data, error } = await supabase.from('driver_locations').select('*').eq('owner_id', currentUser.id);
    if (error) throw error;
    renderOwnerDriverMarkers(data || []);
  } catch (e) {
    console.error('Load driver locations error:', e);
  }
}

function renderOwnerDriverMarkers(rows) {
  if (!ownerDriverMap) return;
  const seen = new Set();
  (rows || []).forEach(r => {
    if (r.latitude == null || r.longitude == null) return;
    seen.add(String(r.driver_id));
    const driver = driverListCache.find(d => String(d.id) === String(r.driver_id));
    const label = (driver && driver.display_name) || 'Driver';
    const popupHtml = `${escapeHtmlSafe(label)}<br><small>Updated ${new Date(r.updated_at).toLocaleTimeString()}</small>`;
    if (ownerDriverMarkers[r.driver_id]) {
      ownerDriverMarkers[r.driver_id].setLatLng([r.latitude, r.longitude]).setPopupContent(popupHtml);
    } else {
      ownerDriverMarkers[r.driver_id] = L.marker([r.latitude, r.longitude]).addTo(ownerDriverMap).bindPopup(popupHtml);
    }
  });
  Object.keys(ownerDriverMarkers).forEach(id => {
    if (!seen.has(id)) { ownerDriverMap.removeLayer(ownerDriverMarkers[id]); delete ownerDriverMarkers[id]; }
  });
  const countEl = $('liveMapDriverCount');
  if (countEl) countEl.textContent = seen.size ? `(${seen.size} online)` : '(no drivers sharing right now)';
  const markers = Object.values(ownerDriverMarkers);
  if (markers.length) {
    const group = L.featureGroup(markers);
    try { ownerDriverMap.fitBounds(group.getBounds().pad(0.3), { maxZoom: 14 }); } catch (e) {}
  }
}

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

function toggleDriverLocationSharing() {
  if (userRole !== 'driver') return;
  if (driverLocationSharing) stopDriverLocationSharing();
  else startDriverLocationSharing();
}
window.toggleDriverLocationSharing = toggleDriverLocationSharing;

function startDriverLocationSharing() {
  if (!navigator.geolocation) { alert('Location is not supported on this device/browser.'); return; }
  driverLocationWatchId = navigator.geolocation.watchPosition(
    (pos) => { driverSendLocation(pos.coords.latitude, pos.coords.longitude); },
    (err) => {
      console.error('Geolocation error:', err);
      alert('⚠️ Could not get your location: ' + err.message);
      stopDriverLocationSharing();
    },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 }
  );
  driverLocationSharing = true;
  updateDriverLocationUI();
}

function stopDriverLocationSharing() {
  if (driverLocationWatchId != null) { navigator.geolocation.clearWatch(driverLocationWatchId); driverLocationWatchId = null; }
  driverLocationSharing = false;
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

async function driverSendLocation(lat, lng) {
  const now = Date.now();
  if (now - driverLocationLastSent < 8000) return; // throttle: ~once per 8s, saves battery & bandwidth
  driverLocationLastSent = now;
  try {
    const { error } = await supabase.from('driver_locations').upsert({
      driver_id: currentUser.id,
      owner_id: businessId,
      latitude: lat,
      longitude: lng,
      updated_at: new Date().toISOString()
    }, { onConflict: 'driver_id' });
    if (error) throw error;
  } catch (e) {
    console.error('Send location error:', e);
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
      <td><button class="btn btn-sm btn-danger" onclick="deleteHistoryEntry(${index})">🗑️</button></td>
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
    prodWorkers: 220000, prodOther: 220000,
    finLinna: 1750, finBalaya: 2200, finKawalam: 1000
  };
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
    await Promise.all([userRole==='owner'?loadCustomersFromCloud():Promise.resolve(), loadOrdersFromCloud(), loadExpensesFromCloud()]);
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
  stopAdvanceRealtime();
  stopAppNotifyRealtime();
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
  if (sensChart) { sensChart.destroy(); sensChart = null; }
  if (prodChart) { prodChart.destroy(); prodChart = null; }
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
  $('finLinna').value = state.production.finLinna;
  $('finBalaya').value = state.production.finBalaya;
  $('finKawalam').value = state.production.finKawalam;
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
}

// ==================== ANALYTICS ====================
let trendChart = null, orderStatusChart = null, productMixChart = null, expenseCatChart = null, profitBySizeChart = null;

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
  r.onload=async()=>{try{
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
  try{
    const {data,error}=await supabase.from('staff_tasks').insert({owner_id:owner,staff_id:currentUser.id,title,priority,status:'pending'}).select().single();
    if(error)throw error; cacheStaffData({tasks:[data,...(getMyStaffDataState().tasks||[])]}); $('staffTaskTitle').value='';
    renderStaffTasks();refreshStaffHome();updateStatus('✅ Task saved to Supabase');
  }catch(e){alert('❌ Task save failed: '+e.message);}
}

async function toggleStaffTask(id){
  try{
    const task=(getMyStaffDataState().tasks||[]).find(t=>t.id===id); if(!task)return;
    const next=taskDone(task)?'pending':'completed';
    const {data,error}=await supabase.from('staff_tasks').update({status:next,completed_at:next==='completed'?new Date().toISOString():null,updated_at:new Date().toISOString()}).eq('id',id).eq('staff_id',currentUser.id).select().single();
    if(error)throw error; cacheStaffData({tasks:(getMyStaffDataState().tasks||[]).map(x=>x.id===id?data:x)});renderStaffTasks();refreshStaffHome();
  }catch(e){alert('❌ Task update failed: '+e.message);}
}

async function deleteStaffTask(id){
  if(userRole==='staff'){ alert('Tasks are assigned and managed by the business owner. You can mark them Done/Reopen.'); return; }
  try{const {error}=await supabase.from('staff_tasks').delete().eq('id',id).eq('staff_id',currentUser.id);if(error)throw error;cacheStaffData({tasks:(getMyStaffDataState().tasks||[]).filter(x=>x.id!==id)});renderStaffTasks();refreshStaffHome();}
  catch(e){alert('❌ Task delete failed: '+e.message);}
}

function renderStaffTasks(){
  const list=getStaffLocalTasks(),el=$('staffTaskList');if(!el)return;
  const rows=list.length?list.map(x=>`<div class="task-row"><div class="task-main ${taskDone(x)?'task-done':''}"><strong>${escapeHtmlSafe(x.title)}</strong><small><span class="priority-pill ${x.priority==='high'?'high':'normal'}">${x.priority==='high'?'HIGH':'NORMAL'}</span> · ${new Date(x.created_at||Date.now()).toLocaleDateString()}</small></div><div style="display:flex;gap:6px;"><button class="btn btn-sm ${taskDone(x)?'':'btn-primary'}" onclick="toggleStaffTask('${x.id}')"><i class="business-icon" data-lucide="${taskDone(x)?'rotate-ccw':'check'}"></i><span>${taskDone(x)?'Reopen':'Done'}</span></button></div></div>`).join(''):'<div class="notice">No assigned tasks yet.</div>';
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
  try{const {data,error}=await supabase.from('staff_tasks').insert({owner_id:currentUser.id,staff_id:staffId,title,priority,status:'pending'}).select().single();if(error)throw error;cacheStaffData({tasks:[data,...(getMyStaffDataState().tasks||[])]});$('ownerTaskTitle').value='';renderOwnerStaffPerformance();renderOwnerStaffManagement();updateStatus('☁️ Task assigned to Supabase');}catch(e){alert('❌ Task assign failed: '+e.message);}
}

async function ownerPublishNotice(){
  if(!currentUser||userRole!=='owner')return;const title=($('ownerNoticeTitle')?.value||'').trim(),message=($('ownerNoticeBody')?.value||'').trim();if(!title||!message)return alert('Enter a notice title and message.');
  try{const {data,error}=await supabase.from('staff_announcements').insert({owner_id:currentUser.id,title,message,active:true}).select().single();if(error)throw error;cacheStaffData({notices:[data,...(getMyStaffDataState().notices||[])]});$('ownerNoticeTitle').value='';$('ownerNoticeBody').value='';renderOwnerStaffManagement();renderStaffAnnouncements();updateStatus('☁️ Notice published to Supabase');}catch(e){alert('❌ Notice publish failed: '+e.message);}
}
async function ownerToggleTask(id){if(userRole!=='owner')return;try{const task=(getMyStaffDataState().tasks||[]).find(x=>x.id===id);if(!task)return;const {data,error}=await supabase.from('staff_tasks').update({status:taskDone(task)?'pending':'completed',completed_at:taskDone(task)?null:new Date().toISOString(),updated_at:new Date().toISOString()}).eq('id',id).eq('owner_id',currentUser.id).select().single();if(error)throw error;cacheStaffData({tasks:(getMyStaffDataState().tasks||[]).map(x=>x.id===id?data:x)});renderOwnerStaffManagement();renderOwnerStaffPerformance();}catch(e){alert('❌ Task update failed: '+e.message);}}
async function ownerDeleteTask(id){if(userRole!=='owner'||!confirm('Delete this task?'))return;try{const {error}=await supabase.from('staff_tasks').delete().eq('id',id).eq('owner_id',currentUser.id);if(error)throw error;cacheStaffData({tasks:(getMyStaffDataState().tasks||[]).filter(x=>x.id!==id)});renderOwnerStaffManagement();renderOwnerStaffPerformance();}catch(e){alert('❌ Task delete failed: '+e.message);}}
async function ownerDeleteNotice(id){if(userRole!=='owner'||!confirm('Delete this notice?'))return;try{const {error}=await supabase.from('staff_announcements').delete().eq('id',id).eq('owner_id',currentUser.id);if(error)throw error;cacheStaffData({notices:(getMyStaffDataState().notices||[]).filter(x=>x.id!==id)});renderOwnerStaffManagement();renderStaffAnnouncements();}catch(e){alert('❌ Notice delete failed: '+e.message);}}

function renderOwnerStaffPerformance(){
  const list=staffListCache||[],month=new Date().toISOString().slice(0,7),perf=getOwnerPerformanceState();
  const claims=(window.staffCommissionClaims||[]).filter(c=>c.status==='approved' && String(c.submitted_at||c.verified_at||'').slice(0,7)===month);
  let totalSales=0,totalCommission=0;
  const rows=list.map(st=>{
    const eligible=claims.filter(c=>String(c.staff_id)===String(st.id));
    const sales=eligible.reduce((a,c)=>a+(Number(c.order_total)||0),0),commission=eligible.reduce((a,c)=>a+(Number(c.commission_amount)||0),0);totalSales+=sales;totalCommission+=commission;
    const open=(getMyStaffDataState().tasks||[]).filter(t=>String(t.staff_id)===String(st.id)&&!taskDone(t)).length,p=perf[st.id]||{};
    return `<tr><td><strong>${escapeHtmlSafe(st.display_name||'(no name)')}</strong><br><small>${escapeHtmlSafe(st.staff_reference||st.id||'')}</small></td><td><select id="staffStatus_${st.id}" class="staff-edit-input"><option value="active" ${(p.status||'active')==='active'?'selected':''}>Active</option><option value="paused" ${p.status==='paused'?'selected':''}>Paused</option></select></td><td>${eligible.length}</td><td>${fmt(sales)}</td><td><strong>12%</strong><br><small>Owner verified</small></td><td>${fmt(commission)}</td><td>${open}</td><td><input id="staffTarget_${st.id}" class="staff-edit-input" type="number" min="0" value="${Number(p.target)||0}" placeholder="Rs."></td><td><input id="staffNote_${st.id}" class="staff-edit-input" value="${escapeHtmlSafe(p.note||p.notes||'')}" placeholder="Owner note"></td><td><button class="btn btn-sm btn-primary" onclick="editOwnerStaffPerformance('${st.id}')"><i class="business-icon" data-lucide="save"></i></button></td></tr>`;
  }).join('')||'<tr><td colspan="10" style="text-align:center;opacity:.5;padding:18px;">No staff added yet.</td></tr>';
  if($('ownerStaffPerformanceBody'))$('ownerStaffPerformanceBody').innerHTML=rows;if($('ownerStaffCount'))$('ownerStaffCount').textContent=list.length;if($('ownerStaffSales'))$('ownerStaffSales').textContent=fmt(totalSales);if($('ownerStaffCommission'))$('ownerStaffCommission').textContent=fmt(totalCommission);if($('ownerCommissionTotal2'))$('ownerCommissionTotal2').textContent=fmt(totalCommission);
  if($('ownerCommissionBody'))$('ownerCommissionBody').innerHTML=list.map(st=>{const cs=claims.filter(c=>String(c.staff_id)===String(st.id));const sales=cs.reduce((a,c)=>a+(Number(c.order_total)||0),0),commission=cs.reduce((a,c)=>a+(Number(c.commission_amount)||0),0);return `<tr><td>${escapeHtmlSafe(st.display_name||'(no name)')}</td><td>${fmt(sales)}</td><td>${fmt(commission)}</td></tr>`;}).join('')||'<tr><td colspan="3" style="text-align:center;opacity:.5;padding:18px;">No owner-verified commission sales this month.</td></tr>';
  const sel=$('ownerTaskStaff');if(sel){const prev=sel.value;sel.innerHTML='<option value="">-- Select staff --</option>'+list.map(st=>`<option value="${st.id}">${escapeHtmlSafe(st.display_name||'(no name)')}</option>`).join('');if(list.some(x=>x.id===prev))sel.value=prev;}
  if(window.lucide)lucide.createIcons();
}
function renderOwnerStaffManagement(){
  const tasks=getMyStaffDataState().tasks||[],notices=getMyStaffDataState().notices||[];
  const taskEl=$('ownerStaffTaskManagement');if(taskEl)taskEl.innerHTML=tasks.length?tasks.map(t=>`<div class="notice-row"><div class="notice-main"><strong>${escapeHtmlSafe(t.title)}</strong><small>${escapeHtmlSafe((staffListCache||[]).find(s=>String(s.id)===String(t.staff_id))?.display_name||t.staff_id||'Staff')} · ${taskDone(t)?'Completed':'Open'}</small></div><div style="display:flex;gap:6px;"><button class="btn btn-xs" onclick="ownerToggleTask('${t.id}')">${taskDone(t)?'Reopen':'Done'}</button><button class="btn btn-xs btn-danger" onclick="ownerDeleteTask('${t.id}')">Delete</button></div></div>`).join(''):'<div class="notice">No assigned tasks.</div>';
  const noticeEl=$('ownerStaffNoticeManagement');if(noticeEl)noticeEl.innerHTML=notices.length?notices.map(n=>`<div class="notice-row"><div class="notice-main"><strong>${escapeHtmlSafe(n.title)}</strong><small>${escapeHtmlSafe(n.message||n.body||'')}</small></div><button class="btn btn-xs btn-danger" onclick="ownerDeleteNotice('${n.id}')">Delete</button></div>`).join(''):'<div class="notice">No notices published.</div>';
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
    renderOwnerStaffPerformance();
    renderOwnerStaffManagement();
    renderOrders();
    updateOrderStats();
    calcAll(); calcDashboard(); calcProduction(); updateMonthlySummary();
    refreshStaffHome(); refreshMyCommission();
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
      const [advs, att, corr, claims] = await Promise.all([
        supabase.from('advance_requests').select('*').eq('owner_id',currentUser.id).gt('requested_at',lastSeen).order('requested_at',{ascending:true}),
        supabase.from('attendance').select('*').eq('owner_id',currentUser.id).or(`check_in.gt.${lastSeen},check_out.gt.${lastSeen}`).order('work_date',{ascending:true}),
        supabase.from('attendance_corrections').select('*').eq('owner_id',currentUser.id).gt('requested_at',lastSeen).order('requested_at',{ascending:true}),
        supabase.from('staff_commission_claims').select('*').eq('owner_id',currentUser.id).gt('submitted_at',lastSeen).order('submitted_at',{ascending:true})
      ]);
      (advs.data||[]).forEach(r=> showAppNotification(...nbAdvanceRequested(r)));
      (att.data||[]).forEach(r=>{
        if(r.check_in && r.check_in>lastSeen) showAppNotification(...nbCheckedIn(r));
        if(r.check_out && r.check_out>lastSeen) showAppNotification(...nbCheckedOut(r));
      });
      (corr.data||[]).forEach(r=> showAppNotification(...nbCorrectionRequested(r)));
      (claims.data||[]).forEach(r=> showAppNotification(...nbNewSaleToVerify(r)));
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
      // NOTE: attendance-correction decisions aren't caught up here — the
      // decided_at column on that table isn't confirmed to exist, and a bad
      // filter would abort the whole Promise.all above. Live-only for now.
    }
  }catch(e){ console.warn('Notification catch-up failed:', e); }
  finally{ catchUpBusy = false; bumpAppNotifyLastSeen(); }
}

// Reconnect + catch up whenever the device comes back online, or the tab/PWA
// is brought back to the foreground after being backgrounded — both are
// cases where the websocket may have silently died without onclose firing.
window.addEventListener('online', () => { if(currentUser) startAppNotifyRealtime(); });
document.addEventListener('visibilitychange', () => {
  if(document.visibilityState === 'visible' && currentUser){
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
  try{
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
        <button class="btn btn-sm btn-primary" onclick="decideAttendanceCorrection('${c.id}', true)"><i class="business-icon icon-inline" data-lucide="check"></i> Approve</button>
        <button class="btn btn-sm btn-danger" onclick="decideAttendanceCorrection('${c.id}', false)"><i class="business-icon icon-inline" data-lucide="x"></i> Reject</button>
      </td></tr>`;
  }).join('');
  if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } });
}

async function decideAttendanceCorrection(id, approve) {
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
  let hours=0;try{const raw=JSON.parse(localStorage.getItem('mydrybea_attendance_cache')||'[]');hours=raw.filter(x=>x.staffId===currentUser.id&&x.hours).reduce((s,x)=>s+Number(x.hours||0),0);}catch(e){}if($('staffHomeHours'))$('staffHomeHours').textContent=hours.toFixed(1)+'h';renderStaffTasks();renderStaffAnnouncements();refreshMyCommission();
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

const OWNER_ONLY_TABS = ['dashboard', 'my-staff', 'calculator', 'production', 'history', 'data', 'monthly-summary', 'income', 'analytics'];
const STAFF_ONLY_TABS = ['staff-home', 'daily-pay', 'work-update', 'attendance', 'advance', 'my-commission', 'my-tasks', 'announcements'];
const DRIVER_ONLY_TABS = ['my-deliveries'];

let staffWorkspaceLoadSeq = 0;
async function refreshStaffWorkspaceData(tabId){
  if(!currentUser || userRole!=='staff') return;
  const seq=++staffWorkspaceLoadSeq;
  try{
    if(['staff-home','orders','my-commission','my-tasks','announcements'].includes(tabId)){
      await loadCommissionClaims();
      await Promise.all([userRole==='owner'?loadCustomersFromCloud():Promise.resolve(),loadOrdersFromCloud(),cloudLoadStaffTasks(),cloudLoadNotices(),cloudLoadReferralUploads(),cloudLoadPerformance(new Date().toISOString().slice(0,7)),cloudLoadCommission()]);
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
  if (userRole === 'staff' && !['staff-home', 'orders', 'my-salary', 'expenses', 'daily-pay', 'work-update', 'attendance', 'advance', 'my-commission', 'my-tasks', 'announcements', 'profile'].includes(tabId)) {
    alert('🔒 Staff access: use your staff workspace and assigned business sections.');
    return;
  }
  if (userRole === 'driver' && !DRIVER_ALLOWED_TABS.includes(tabId)) {
    alert('🔒 Driver access: use your delivery list and profile.');
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
  const panel = document.getElementById(tabId);
  if (!panel) return;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  const nav = document.querySelector('.tab-btn[data-tab="' + tabId + '"]');
  if (nav) nav.classList.add('active');
  document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
  panel.style.display = 'block';
  panel.style.animation = 'none'; panel.offsetHeight; panel.style.animation = 'fadeIn 0.3s ease';
  if(userRole==='staff') refreshStaffWorkspaceData(tabId);
  if (tabId === 'dashboard') { calcDashboard(); calcSensitivity(); calcBulk(); }
  if (tabId === 'income') { calcDashboard(); }
  if (tabId === 'monthly-summary') { updateMonthlySummary(); }
  if (tabId === 'analytics') { renderAnalytics(); }
  if (tabId === 'history') renderHistory();
  if (tabId === 'production') calcProduction();
  if (tabId === 'orders') { loadCommissionClaims().finally(() => { renderOrders(); renderCustomers(); renderDelivery(); updateOrderStats(); }); if (userRole === 'owner') { loadStaffList(); initOwnerDriverMap(); loadDriverLocations(); } }
  if (tabId === 'my-deliveries') { loadMyDeliveries(); }
  if (tabId === 'my-staff') { refreshMyStaffPage(); loadMyStaffOwnerData(); }
  if (tabId === 'expenses') { renderExpenses(); renderRecurringExpenses(); }
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

// ==================== INIT ====================
document.addEventListener('DOMContentLoaded', async () => {
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

  // ---- LOAD CUSTOMERS/ORDERS/EXPENSES FROM THEIR OWN SUPABASE TABLES ----
  // (source of truth — same data across every device/browser)
  await Promise.all([userRole==='owner'?loadCustomersFromCloud():Promise.resolve(), loadOrdersFromCloud(), loadExpensesFromCloud()]);
  renderOrders();
  renderCustomers();
  renderDelivery();
  updateOrderStats();
  updateCustomerSelect();
  renderExpenses();
  updateMonthlySummary();

  // ---- RECURRING DAILY EXPENSES: load rules, then auto-add today's due ones ----
  await loadRecurringExpenses();
  await generateDueRecurringExpenses();
  renderRecurringExpenses();

  // ---- LOAD CLOUD DATA (silent, no alert on empty) ----
  // app_data still holds: state (pricing/production settings), history, snapshots.
  // customers/orders are NOT read from here anymore — they come from their own tables above.
  try {
    const { data, error } = await supabase
      .from('app_data')
      .select('data')
      .eq('user_id', currentUser.id)
      .order('updated_at', { ascending: false })
      .limit(1);
    if (error) throw error;
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
    } else {
      // First time user — save initial state to cloud
      await cloudSaveSilent();
      updateStatus('☁️ Initial cloud save');
    }
  } catch (e) {
    console.error('Cloud load error:', e);
    updateStatus('⚠️ Cloud load failed — using local');
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
window.calcSensitivity = calcSensitivity;
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
window.stepOrderQty = stepOrderQty;
window.updateOrderTotal = updateOrderTotal;
window.onOrderCustomerChange = onOrderCustomerChange;
window.openNotifyCenter = openNotifyCenter;
window.openAppNotifyDetail = openAppNotifyDetail;
window.refreshMySmartSalary = refreshMySmartSalary;
window.loadOwnerAttendanceToday = loadOwnerAttendanceToday;

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
