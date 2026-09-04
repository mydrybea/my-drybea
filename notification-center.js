/* ============================================================
   NOTIFICATION CENTER — v2 render logic
   Wherever your app currently builds a notification item
   (the code that fills .nc-item / .nc-list with the raw
   "*Order ID:* ... *Total:* ..." text), swap the markup it
   produces for the output of renderNotification() below.
   The raw text format itself does NOT need to change — this
   just reformats it before it hits the DOM.
   ============================================================ */

// Pulls every "*Label:* value" pair out of the raw message text.
function parseFields(raw) {
  const fields = {};
  const re = /\*([A-Za-z ]+):\*\s*([^*]+?)(?=\s*\*[A-Za-z ]+:\*|_|$)/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    fields[m[1].trim().toLowerCase()] = m[2].trim();
  }
  const noteMatch = raw.match(/_([^_]+)_/); // the "_Thank you..._" closing line
  if (noteMatch) fields.footer = noteMatch[1].trim();
  return fields;
}

function statusClass(status) {
  status = (status || '').toLowerCase();
  if (status.includes('pend')) return 'pending';
  if (status.includes('cancel')) return 'cancelled';
  return 'confirmed';
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[s]));
}

function renderOrderCard(n) {
  const f = parseFields(n.raw);
  const status = f.status || 'PENDING';
  return `
    <div class="nc-card type-order ${n.unread ? 'unread' : ''}" data-id="${n.id || ''}">
      <div class="nc-card-top">
        <div class="nc-icon">📦</div>
        <div class="nc-card-head">
          <div class="nc-card-head-text">
            <div class="nc-title">New order — ${escapeHtml(f['order id'] || '')}</div>
            <div class="nc-sub">${escapeHtml(f.customer || 'Customer')} · ${escapeHtml(f.phone || '')}</div>
          </div>
          <span class="nc-status ${statusClass(status)}">${escapeHtml(status)}</span>
        </div>
      </div>
      <div class="nc-order-body">
        <div class="nc-order-item">
          <div>
            <div class="name">${escapeHtml(f.item || '')}</div>
            <div class="qty">Qty ${escapeHtml(f.quantity || '-')} × ${escapeHtml(f['unit price'] || '')}</div>
          </div>
          <div class="price">${escapeHtml(f.total || '')}</div>
        </div>
        <div class="nc-meta-grid">
          <div class="nc-meta"><div class="k">Ordered via</div><div class="v">${escapeHtml(f.address || '-')}</div></div>
          <div class="nc-meta"><div class="k">Payment</div><div class="v">${escapeHtml(f.notes || '-')}</div></div>
        </div>
        <div class="nc-total-row">
          <span class="label">Order total</span>
          <span class="amount">${escapeHtml(f.total || '')}</span>
        </div>
        ${f.footer ? `<div class="nc-note">🙏 ${escapeHtml(f.footer)}</div>` : ''}
      </div>
    </div>`;
}

function renderInfoCard(n) {
  return `
    <div class="nc-card type-info ${n.unread ? 'unread' : ''}" data-id="${n.id || ''}">
      <div class="nc-card-top">
        <div class="nc-icon">📣</div>
        <div class="nc-card-head">
          <div class="nc-card-head-text">
            <div class="nc-title">${escapeHtml(n.title || 'Update')}</div>
            <div class="nc-msg">${escapeHtml(n.message || '')}</div>
          </div>
          <span class="nc-time">${escapeHtml(n.time || '')}</span>
        </div>
      </div>
    </div>`;
}

// Call this per notification instead of dumping n.raw straight into innerHTML.
// n = { type: 'order' | 'info', unread: bool, time: '17:42', raw / title+message, id }
function renderNotification(n) {
  const isOrder = n.type === 'order' || (n.raw && /\*order id:\*/i.test(n.raw));
  return isOrder ? renderOrderCard(n) : renderInfoCard(n);
}

// Example: replacing your existing list-fill loop
// document.getElementById('ncBody').innerHTML =
//   notifications.map(renderNotification).join('');
