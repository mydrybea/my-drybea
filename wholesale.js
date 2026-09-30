/* DRYBEA Wholesale Catalogue — lives in Products → Tools.
 * Loaded (defer) AFTER app.js, so it can use app.js globals:
 * supabase, businessId, userRole, currentUser, products, DEFAULT_OWNER_WHATSAPP.
 * Prices are ALWAYS computed from tiers (never stored on cart lines) and the
 * server (wholesale_place_order RPC) recalculates them again on submit. */
(function () {
  'use strict';

  /* ------------------------------------------------------------ config */
  const CURRENCY = { code: 'LKR', symbol: 'Rs.', locale: 'en-US' }; // swap here for future currencies
  const fmt = n => CURRENCY.symbol + Math.round(Number(n) || 0).toLocaleString(CURRENCY.locale);
  const num = n => (Number(n) || 0).toLocaleString(CURRENCY.locale);
  const CACHE_KEY = 'ws_catalogue_v1', CACHE_TTL = 5 * 60 * 1000, CART_KEY = 'ws_cart_v1';
  const STATUSES = ['NEW', 'PROCESSING', 'READY', 'DISPATCHED', 'DELIVERED', 'CANCELLED'];
  const CUSTOMER_TYPES = ['Retail Shop', 'Supermarket', 'Restaurant', 'Hotel', 'Café', 'Distributor', 'Reseller', 'Other'];
  const CATS = [['ALL', 'ALL'], ['50g', '50g'], ['100g', '100g'], ['500g', '500g'], ['1kg', '1kg'], ['L-SIZE', 'L-SIZE'], ['BULK', '10kg+ BULK']];
  const LOW_STOCK = 10;

  /* -------------------------------------------------------------- i18n */
  // Add a language by filling I18N.si / I18N.ta — missing keys fall back to English.
  const I18N = {
    en: {
      'catalogue.brand': 'DRYBEA PREMIUM FOODS', 'catalogue.title': 'WHOLESALE CATALOGUE',
      'catalogue.collection': 'MALDIVE FISH COLLECTION', 'catalogue.types': 'TUNA • LINNA',
      'catalogue.tagline': 'Easy Shopping for Healthy Life', 'catalogue.search': 'Search tuna, linna, 100g, bulk…',
      'catalogue.empty': 'No products match your search.', 'catalogue.share': 'Share', 'catalogue.contact': 'Contact',
      'catalogue.back_products': 'Products', 'catalogue.my_orders': 'My Orders', 'catalogue.admin': 'Admin',
      'filter.fish': 'Fish', 'filter.type': 'Order type', 'filter.all': 'All', 'filter.wholesale': 'Wholesale',
      'filter.bulk': 'Bulk Business', 'filter.favourites': 'Favourites',
      'product.from': 'From', 'product.bulk_note': 'Bulk quantity discounts available', 'product.add_to_cart': 'ADD TO CART',
      'product.order_now': 'ORDER NOW', 'product.whatsapp': 'WhatsApp', 'product.quantity': 'Quantity',
      'product.unit_price': 'Unit price', 'product.total': 'Total', 'product.tiers': 'QUANTITY PRICE',
      'product.min_qty': 'Minimum order', 'product.per_unit': '/ unit', 'product.per_kg': '/ kg', 'product.added': 'Added to cart',
      'product.image_soon': 'Photo coming soon', 'product.current': 'Current',
      'stock.in': 'IN STOCK', 'stock.low': 'LOW STOCK', 'stock.out': 'OUT OF STOCK', 'stock.quote': 'BUSINESS QUOTE',
      'stock.unavailable': 'CURRENTLY UNAVAILABLE', 'stock.only': 'Only {n} available',
      'business.quote': 'SPECIAL BUSINESS QUOTE', 'business.request_quote': 'REQUEST BUSINESS QUOTE',
      'business.request_bulk': 'REQUEST BULK ORDER', 'business.bulk_title': '10kg+ BUSINESS ORDERS',
      'business.bulk_note': 'Fixed business price per kg — no quantity tiers.', 'business.below_min': 'Minimum order is {n}',
      'cart.title': 'YOUR CART', 'cart.empty': 'Your cart is empty.', 'cart.total': 'Cart total', 'cart.button': 'CART',
      'cart.remove': 'Remove', 'cart.proceed': 'PROCEED TO ORDER', 'cart.continue': 'CONTINUE SHOPPING',
      'cart.tier_hint': 'Add {n} more to get {p} / unit', 'cart.price_changed': 'Price updated for this quantity',
      'cart.quote_block': 'Remove or reduce quotation lines before ordering.', 'cart.subtotal': 'Subtotal',
      'order.details': 'CUSTOMER DETAILS', 'order.name': 'Name', 'order.business': 'Business Name', 'order.phone': 'Phone Number',
      'order.whatsapp': 'WhatsApp Number', 'order.address': 'Delivery Address', 'order.city': 'City', 'order.province': 'Province',
      'order.note': 'Special Order Note', 'order.type': 'Customer Type', 'order.summary': 'ORDER SUMMARY',
      'order.total_qty': 'Total quantity', 'order.total_value': 'Total order value', 'order.confirm': 'CONFIRM WHOLESALE ORDER',
      'order.whatsapp_btn': 'ORDER VIA WHATSAPP', 'order.received': 'ORDER RECEIVED', 'order.pending': 'PENDING CONFIRMATION',
      'order.number': 'Order Number', 'order.status': 'Order Status', 'order.view': 'VIEW ORDER', 'order.reorder': 'REORDER',
      'order.reorder_note': 'Items loaded at TODAY\'s prices.', 'order.none': 'No previous orders yet.',
      'order.missing_backend': 'Ordering backend is not installed yet (run wholesale-setup.sql). You can still order via WhatsApp.',
      'share.title': 'SHARE CATALOGUE', 'share.copy': 'Copy Link', 'share.copied': 'Link copied', 'share.qr': 'QR Code',
      'share.qr_caption': 'SCAN TO VIEW WHOLESALE CATALOGUE',
      'admin.orders': 'WHOLESALE ORDERS', 'admin.prices': 'PRICE MANAGEMENT', 'admin.analytics': 'ANALYTICS',
      'common.close': 'Close', 'common.save': 'Save', 'common.cancel': 'Cancel', 'common.back': 'Back'
    },
    si: {}, ta: {}
  };
  let lang = (function () { try { return localStorage.getItem('ws_lang') || 'en'; } catch (e) { return 'en'; } })();
  const t = (k, v) => {
    let s = (I18N[lang] && I18N[lang][k]) || I18N.en[k] || k;
    if (v) Object.keys(v).forEach(x => { s = s.replace('{' + x + '}', v[x]); });
    return s;
  };

  /* -------------------------------------------------- default catalogue */
  // Used until the owner saves prices in Supabase (then the DB wins).
  const T = a => a.map(([min, max, price]) => ({ min, max, price }));
  const mk = (fish, pack, cat, o) => Object.assign({
    id: fish.toLowerCase() + '-' + pack.toLowerCase().replace(/[^a-z0-9]+/g, ''), name: fish + ' Maldive Fish', fish, pack, cat,
    kind: 'wholesale', unit: 'unit', min: 1, quoteFrom: null, fixed: null, image: '', linked: '', backorder: false, active: true, sort: 0, lists: {}
  }, o);
  const DEFAULTS = [
    mk('Tuna', '50g', '50g', { min: 500, quoteFrom: 2001, tiers: T([[500, 999, 130], [1000, 1499, 127], [1500, 2000, 126]]) }),
    mk('Linna', '50g', '50g', { min: 500, quoteFrom: 2001, tiers: T([[500, 999, 130], [1000, 1499, 127], [1500, 2000, 126]]) }),
    mk('Tuna', '100g', '100g', { tiers: T([[1, 299, 280], [300, 499, 275], [500, 999, 272], [1000, 1499, 270], [1500, null, 266]]) }),
    mk('Linna', '100g', '100g', { tiers: T([[1, 299, 240], [300, 499, 235], [500, 999, 234], [1000, 1499, 233], [1500, null, 228]]) }),
    mk('Tuna', '500g', '500g', { quoteFrom: 501, tiers: T([[1, 99, 1400], [100, 199, 1372], [200, 299, 1365], [300, 500, 1358]]) }),
    mk('Linna', '500g', '500g', { quoteFrom: 501, tiers: T([[1, 99, 1200], [100, 199, 1176], [200, 299, 1170], [300, 500, 1164]]) }),
    mk('Tuna', '1kg', '1kg', { quoteFrom: 301, tiers: T([[1, 49, 2750], [50, 99, 2695], [100, 199, 2681], [200, 300, 2668]]) }),
    mk('Linna', '1kg', '1kg', { quoteFrom: 301, tiers: T([[1, 49, 2350], [50, 99, 2303], [100, 199, 2291], [200, 300, 2280]]) }),
    mk('Tuna', '1kg L-size', 'L-SIZE', { id: 'tuna-l1kg', name: 'Tuna Maldive Fish L-Size', quoteFrom: 301, tiers: T([[1, 49, 2450], [50, 99, 2425], [100, 199, 2400], [200, 300, 2375]]) }),
    mk('Linna', '1kg L-size', 'L-SIZE', { id: 'linna-l1kg', name: 'Linna Maldive Fish L-Size', quoteFrom: 301, tiers: T([[1, 49, 1850], [50, 99, 1825], [100, 199, 1800], [200, 300, 1775]]) }),
    mk('Tuna', '10kg+', 'BULK', { id: 'tuna-bulk', name: 'Tuna Maldive Fish — Bulk', kind: 'bulk', unit: 'kg', min: 10, fixed: 2250, tiers: [] }),
    mk('Linna', '10kg+', 'BULK', { id: 'linna-bulk', name: 'Linna Maldive Fish — Bulk', kind: 'bulk', unit: 'kg', min: 10, fixed: 1725, tiers: [] })
  ].map((p, i) => { p.sort = i; return p; });

  /* ------------------------------------------------------- pricing engine */
  // list = 'standard' today. Customer-specific lists (business / distributor /
  // contract) are supported by p.lists[list] but stay OFF unless admin sets one.
  function tiersFor(p, list) { return (list && p.lists && p.lists[list]) || p.tiers || []; }
  function priceFor(p, qty, list) {
    qty = Math.floor(Number(qty)) || 0;
    if (qty < p.min) return { status: 'below_min', min: p.min };
    if (p.kind === 'bulk') return { status: 'bulk', unit: p.fixed, total: p.fixed * qty };
    if (p.quoteFrom && qty >= p.quoteFrom) return { status: 'quote' };
    const tier = tiersFor(p, list).find(x => qty >= x.min && (x.max == null || qty <= x.max));
    if (!tier) return { status: 'quote' }; // gap in tiers: never invent a price
    return { status: 'ok', unit: tier.price, total: tier.price * qty, tier };
  }
  function nextTierHint(p, qty) {
    if (p.kind === 'bulk') return null;
    const cur = priceFor(p, qty);
    if (cur.status !== 'ok') return null;
    const nx = tiersFor(p).find(x => x.min > qty && x.price < cur.unit);
    return nx ? { n: nx.min - qty, price: nx.price } : null;
  }
  function basePrice(p) { return p.kind === 'bulk' ? p.fixed : (tiersFor(p)[0] || {}).price || 0; }

  /* ------------------------------------------------------------- state */
  const S = {
    appProducts: [], bid: null, products: [], loaded: false, dbReady: false, view: 'catalogue', detailId: null, order: null, orders: [],
    q: '', cat: 'ALL', fish: 'ALL', otype: 'ALL', favOnly: false, cart: [], favs: [],
    adminTab: 'orders', adminOrders: [], events: [], modal: null, toast: '', busy: false, backendMissing: false, ownerWa: ''
  };
  const $ = id => document.getElementById(id);
  const root = () => $('wsRoot');
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const G = name => { try { return (0, eval)(name); } catch (e) { return undefined; } }; // reads app.js top-level let/const
  const BID = () => S.bid || G('businessId');
  const isGuest = () => !G('currentUser');
  // Own query for the app's Products (name / photo / stock). Not read from app.js globals:
  // the name `products` also resolves to the <section id="products"> element on this page.
  const appProducts = () => S.appProducts;
  async function loadAppProducts() {
    if (isGuest()) return;
    try {
      const { data, error } = await G('supabase').from('products').select('id,name,image_url,stock_qty').eq('user_id', BID()).eq('active', true);
      if (!error && Array.isArray(data)) S.appProducts = data.map(r => ({ id: r.id, name: r.name || '', imageUrl: r.image_url || '', stockQty: Number(r.stock_qty) || 0 }));
    } catch (e) { /* photos/stock link are optional */ }
  }
  const uid = () => (G('currentUser') || {}).id || 'guest';
  const isOwner = () => G('userRole') === 'owner';
  const byId = id => S.products.find(p => p.id === id);
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } };

  /* ------------------------------------------------------------ data */
  function fromDb(rows, tiers) {
    return rows.map(r => {
      const lists = {}; let std = [];
      tiers.filter(x => x.product_id === r.id).sort((a, b) => a.min_quantity - b.min_quantity).forEach(x => {
        const row = { min: x.min_quantity, max: x.max_quantity, price: Number(x.unit_price) };
        if (x.price_list === 'standard') std.push(row); else (lists[x.price_list] = lists[x.price_list] || []).push(row);
      });
      return { id: r.id, name: r.name, fish: r.fish_type, pack: r.pack_size, cat: r.category, kind: r.kind, unit: r.unit, min: r.min_qty,
        quoteFrom: r.quote_from, fixed: r.fixed_price == null ? null : Number(r.fixed_price), image: r.image_url || '', linked: r.linked_product_id || '',
        backorder: !!r.allow_backorder, active: !!r.active, sort: r.sort_order || 0, tiers: std, lists };
    }).sort((a, b) => a.sort - b.sort);
  }
  async function loadCatalogue(force) {
    const bid = BID();
    const cached = lsGet(CACHE_KEY, null);
    if (!force && bid && cached && cached.bid === bid && Date.now() - cached.at < CACHE_TTL) {
      S.products = cached.products; S.dbReady = cached.dbReady; S.loaded = true; render(); refreshInBackground(); return;
    }
    await fetchCatalogue(bid);
    S.loaded = true; render();
  }
  function refreshInBackground() { fetchCatalogue(BID()).then(render).catch(() => {}); }
  async function fetchCatalogue(bid) {
    let list = null, dbReady = false;
    try {
      const sb = G('supabase');
      let q = sb.from('wholesale_products').select('*'); if (bid) q = q.eq('user_id', bid);
      const [a, b] = await Promise.all([q, sb.from('wholesale_tiers').select('*')]);
      if (!a.error && !b.error) {
        dbReady = true;
        if (a.data.length) { list = fromDb(a.data, b.data || []); if (!bid) S.bid = a.data[0].user_id; }
      }
    } catch (e) { /* tables not installed yet — defaults */ }
    S.dbReady = dbReady;
    S.products = list || JSON.parse(JSON.stringify(DEFAULTS));
    lsSet(CACHE_KEY, { bid, at: Date.now(), products: S.products, dbReady });
  }
  async function loadOwnerWa() {
    if (isGuest()) { try { const { data } = await G('supabase').rpc('wholesale_public_contact'); S.ownerWa = String(data || '').replace(/\D/g, ''); } catch (e) { /* fallback number */ } return; }
    try {
      const { data } = await G('supabase').from('profiles').select('whatsapp_number').eq('id', BID()).maybeSingle();
      S.ownerWa = String((data && data.whatsapp_number) || '').replace(/\D/g, '');
    } catch (e) { /* fall back to constant */ }
  }
  const waNumber = () => S.ownerWa || String(G('DEFAULT_OWNER_WHATSAPP') || '').replace(/\D/g, '');
  const waLink = text => 'https://wa.me/' + waNumber() + '?text=' + encodeURIComponent(text);

  /* -------------------------------------------------------- inventory */
  function stockInfo(p) {
    if (p.kind === 'bulk') return { key: 'quote', cls: 'quote', label: t('stock.quote'), max: Infinity, blocked: false };
    const linked = p.linked && appProducts().find(x => String(x.id) === String(p.linked));
    if (!linked) return { key: 'in', cls: 'in', label: t('stock.in'), max: Infinity, blocked: false };
    const q = Number(linked.stockQty) || 0;
    if (q <= 0) return { key: 'out', cls: 'out', label: t('stock.out'), max: p.backorder ? Infinity : 0, blocked: !p.backorder };
    if (q <= LOW_STOCK) return { key: 'low', cls: 'low', label: t('stock.low'), max: p.backorder ? Infinity : q, blocked: false };
    return { key: 'in', cls: 'in', label: t('stock.in'), max: p.backorder ? Infinity : q, blocked: false };
  }
  // Finds the app Product (Products tab) whose name looks like this catalogue item,
  // e.g. "Tuna Maldive Fish 100g" -> tuna + 100g. L-size must match L-size.
  function matchAppProduct(p) {
    const list = appProducts().filter(x => x && x.imageUrl);
    const fish = p.fish.toLowerCase(), isL = /l-?\s?size/i.test(p.pack + ' ' + p.name);
    const bulk = p.kind === 'bulk';
    const size = bulk ? '1kg' : ((p.pack.toLowerCase().match(/\d+\s?(kg|g)/) || [''])[0].replace(/\s/g, ''));
    if (!size) return null;
    const re = new RegExp('(^|[^0-9])' + size);
    let best = null, bs = 0;
    list.forEach(x => {
      const n = String(x.name).toLowerCase(), nn = n.replace(/\s/g, '');
      if (!n.includes(fish) || !re.test(nn)) return;
      const xL = /l-?\s?size|large/.test(n);
      if (bulk ? xL : xL !== isL) return;
      const sc = 1 + (/maldive/.test(n) ? 1 : 0);
      if (sc > bs) { bs = sc; best = x; }
    });
    return best;
  }
  function productImage(p) {
    if (p.image) return p.image;
    const l = p.linked && appProducts().find(x => String(x.id) === String(p.linked));
    if (l && l.imageUrl) return l.imageUrl;
    const m = matchAppProduct(p);
    return (m && m.imageUrl) || '';
  }
  /* ------------------------------------------------------------- cart */
  const saveCart = () => lsSet(CART_KEY, S.cart); // ids + quantities only — never prices
  function addToCart(id, qty) {
    const p = byId(id); if (!p || !p.active) return;
    const st = stockInfo(p); if (st.blocked) return toast(t('stock.unavailable'));
    const pr = priceFor(p, qty);
    if (pr.status === 'below_min') return toast(t('business.below_min', { n: p.min + (p.unit === 'kg' ? 'kg' : '') }));
    if (pr.status === 'quote') return openQuote(id, qty);
    let q = Math.floor(qty);
    const line = S.cart.find(x => x.id === id);
    const total = (line ? line.qty : 0) + q;
    if (total > st.max) { q = Math.max(0, st.max - (line ? line.qty : 0)); toast(t('stock.only', { n: st.max })); if (!q) return; }
    if (line) line.qty += q; else S.cart.push({ id, qty: q });
    saveCart(); track('add_to_cart', id, q, priceFor(p, q).total);
    toast(t('product.added')); updateCartBadge();
  }
  const cartCount = () => S.cart.reduce((s, x) => s + 1, 0);
  const cartLines = () => S.cart.map(l => { const p = byId(l.id); return p ? { l, p, pr: priceFor(p, l.qty), st: stockInfo(p) } : null; }).filter(Boolean);
  function cartTotals() {
    let total = 0, qty = 0, blocked = false;
    cartLines().forEach(x => { if (x.pr.status === 'ok') { total += x.pr.total; qty += x.l.qty; } else blocked = true; if (x.st.blocked) blocked = true; });
    return { total, qty, blocked };
  }

  /* -------------------------------------------------------- analytics */
  let evQueue = [], evTimer = null, evOk = true;
  function track(event, product_id, qty, value, meta) {
    if (!evOk) return;
    evQueue.push({ user_id: BID(), actor: uid() === 'guest' ? null : uid(), event, product_id: product_id || null, qty: qty || null, value: value || null, meta: meta || null });
    clearTimeout(evTimer); evTimer = setTimeout(flushEvents, 4000);
  }
  async function flushEvents() {
    if (!evQueue.length || !evOk) return;
    const batch = evQueue.splice(0, evQueue.length);
    try { const { error } = await G('supabase').from('wholesale_events').insert(batch); if (error) evOk = false; } catch (e) { evOk = false; }
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushEvents(); });

  /* ---------------------------------------------------------- helpers */
  function toast(msg) {
    S.toast = msg; const el = $('wsToast');
    if (el) { el.textContent = msg; el.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('show'), 1800); }
  }
  function shareUrl() { try { return new URL('wholesale.html', location.href).href; } catch (e) { return location.href; } }
  function icon(n) { return '<i data-lucide="' + n + '" aria-hidden="true"></i>'; }
  function stepper(id, val, min) {
    return '<div class="ws-step"><button type="button" data-act="dec" data-t="' + id + '" aria-label="-">−</button>' +
      '<input type="number" inputmode="numeric" min="' + min + '" value="' + val + '" data-qty="' + id + '" aria-label="' + t('product.quantity') + '">' +
      '<button type="button" data-act="inc" data-t="' + id + '" aria-label="+">+</button></div>';
  }
  const unitLbl = p => p.unit === 'kg' ? t('product.per_kg') : t('product.per_unit');
  const qtyLbl = (p, q) => num(q) + (p.unit === 'kg' ? ' kg' : '');
  const statusBadge = s => '<span class="ws-badge s-' + esc(String(s).toLowerCase()) + '">' + esc(s) + '</span>';

  /* ------------------------------------------------------------ views */
  function filtered() {
    const q = S.q.trim().toLowerCase();
    return S.products.filter(p => {
      if (!p.active) return false;
      if (S.cat !== 'ALL' && p.cat !== S.cat) return false;
      if (S.fish !== 'ALL' && p.fish !== S.fish) return false;
      if (S.otype === 'wholesale' && p.kind === 'bulk') return false;
      if (S.otype === 'bulk' && p.kind !== 'bulk') return false;
      if (S.favOnly && !S.favs.includes(p.id)) return false;
      if (q) {
        const hay = (p.name + ' ' + p.fish + ' ' + p.pack + ' ' + p.cat + ' ' + (p.kind === 'bulk' ? 'bulk 10kg' : '') + ' maldive fish').toLowerCase();
        return q.split(/\s+/).every(w => hay.includes(w));
      }
      return true;
    });
  }
  function imgHtml(p, big) {
    const src = productImage(p);
    return src ? '<img loading="lazy" decoding="async" src="' + esc(src) + '" alt="' + esc(p.name + ' ' + p.pack) + '" onerror="this.replaceWith(Object.assign(document.createElement(\'div\'),{className:\'ws-noimg\',textContent:\'' + esc(p.pack) + '\'}))">' :
      '<div class="ws-noimg"><b>' + esc(p.pack) + '</b><small>' + t('product.image_soon') + '</small></div>';
  }
  function cardHtml(p) {
    const st = stockInfo(p), bulk = p.kind === 'bulk', fav = S.favs.includes(p.id);
    const start = Math.max(p.min, 1);
    const from = bulk ? fmt(p.fixed) + ' ' + unitLbl(p) : t('product.from') + ' ' + fmt(basePrice(p));
    const tiered = !bulk && tiersFor(p).length > 1;
    return '<article class="ws-card" data-card="' + p.id + '">' +
      '<button class="ws-fav' + (fav ? ' on' : '') + '" data-act="fav" data-t="' + p.id + '" aria-label="Favourite">' + (fav ? '★' : '☆') + '</button>' +
      '<div class="ws-img" data-act="open" data-t="' + p.id + '">' + imgHtml(p) + '</div>' +
      '<div class="ws-cbody"><div class="ws-chips"><span class="ws-fish f-' + esc(p.fish.toLowerCase()) + '">' + esc(p.fish) + '</span><span class="ws-pack">' + esc(p.pack) + '</span>' +
      '<span class="ws-stock ' + st.cls + '">' + st.label + '</span></div>' +
      '<h3 data-act="open" data-t="' + p.id + '">' + esc(p.name) + '</h3>' +
      '<div class="ws-price">' + from + '</div>' +
      (tiered ? '<div class="ws-note">' + t('product.bulk_note') + '</div>' : '') +
      (bulk ? '<div class="ws-note">' + t('business.bulk_note') + '</div>' : '') +
      (p.min > 1 ? '<div class="ws-note">' + t('product.min_qty') + ': ' + qtyLbl(p, p.min) + '</div>' : '') +
      (bulk ? '<button class="ws-btn gold" data-act="quote" data-t="' + p.id + '">' + t('business.request_bulk') + '</button>' :
        '<div class="ws-live" data-live="' + p.id + '"></div>' +
        '<div class="ws-buy">' + stepper(p.id, start, p.min) + '<button class="ws-btn" data-act="add" data-t="' + p.id + '"' + (st.blocked ? ' disabled' : '') + '>' +
        (st.blocked ? t('stock.unavailable') : t('product.add_to_cart')) + '</button></div>') +
      '</div></article>';
  }
  function liveHtml(p, qty) {
    const pr = priceFor(p, qty);
    if (pr.status === 'quote') return '<div class="ws-quote">' + t('business.quote') + '</div><button class="ws-btn gold" data-act="quote" data-t="' + p.id + '" data-q="' + qty + '">' + t('business.request_quote') + '</button>';
    if (pr.status === 'below_min') return '<div class="ws-warn">' + t('business.below_min', { n: qtyLbl(p, p.min) }) + '</div>';
    return '<div class="ws-calc"><span>' + num(qty) + ' × ' + fmt(pr.unit) + '</span><b>' + fmt(pr.total) + '</b></div>';
  }
  function catalogueView() {
    const list = filtered();
    const chips = (arr, cur, key) => arr.map(([v, l]) => '<button class="ws-chip' + (cur === v ? ' on' : '') + '" data-act="' + key + '" data-t="' + esc(v) + '">' + esc(l) + '</button>').join('');
    return '<div class="ws-tools">' +
      '<div class="ws-search">' + icon('search') + '<input id="wsSearch" type="search" value="' + esc(S.q) + '" placeholder="' + t('catalogue.search') + '" autocomplete="off"></div>' +
      '<div class="ws-chiprow">' + chips(CATS, S.cat, 'cat') + '</div>' +
      '<div class="ws-filters"><div><small>' + t('filter.fish') + '</small>' + chips([['ALL', t('filter.all')], ['Tuna', 'Tuna'], ['Linna', 'Linna']], S.fish, 'fish') + '</div>' +
      '<div><small>' + t('filter.type') + '</small>' + chips([['ALL', t('filter.all')], ['wholesale', t('filter.wholesale')], ['bulk', t('filter.bulk')]], S.otype, 'otype') +
      '<button class="ws-chip' + (S.favOnly ? ' on' : '') + '" data-act="favonly">★ ' + t('filter.favourites') + '</button></div></div></div>' +
      (list.length ? '<div class="ws-grid" id="wsGrid">' + list.map(cardHtml).join('') + '</div>' : '<div class="ws-empty">' + t('catalogue.empty') + '</div>');
  }
  function detailView() {
    const p = byId(S.detailId); if (!p) return catalogueView();
    const st = stockInfo(p), start = Math.max(p.min, 1);
    const tiers = tiersFor(p), bulk = p.kind === 'bulk';
    const rows = bulk ? '<tr class="cur"><td>10kg+</td><td>' + fmt(p.fixed) + ' ' + unitLbl(p) + '</td></tr>' :
      tiers.map(x => '<tr data-tmin="' + x.min + '" data-tmax="' + (x.max == null ? '' : x.max) + '"><td>' + num(x.min) + (x.max == null ? '+' : '–' + num(x.max)) + '</td><td>' + fmt(x.price) + ' ' + unitLbl(p) + '</td></tr>').join('') +
      (p.quoteFrom ? '<tr class="q" data-tmin="' + p.quoteFrom + '" data-tmax=""><td>' + num(p.quoteFrom) + '+</td><td>' + t('business.quote') + '</td></tr>' : '');
    return '<button class="ws-back" data-act="home">‹ ' + t('common.back') + '</button>' +
      '<div class="ws-detail"><div class="ws-dimg">' + imgHtml(p, true) + '</div><div class="ws-dinfo">' +
      '<div class="ws-chips"><span class="ws-fish f-' + esc(p.fish.toLowerCase()) + '">' + esc(p.fish) + '</span><span class="ws-pack">' + esc(p.pack) + '</span><span class="ws-stock ' + st.cls + '">' + st.label + '</span></div>' +
      '<h2>' + esc(p.name) + '</h2><div class="ws-sub">' + esc(p.pack) + '</div>' +
      '<div class="ws-h">' + (bulk ? t('business.bulk_title') : t('product.tiers')) + '</div>' +
      '<table class="ws-tiers" id="wsTiers"><tbody>' + rows + '</tbody></table>' +
      (bulk ? '<div class="ws-note">' + t('business.bulk_note') + '</div><label class="ws-lbl">' + t('product.quantity') + ' (kg)</label>' + stepper(p.id, Math.max(p.min, 10), p.min) + '<div class="ws-live big" data-live="' + p.id + '"></div>' +
        '<button class="ws-btn gold lg" data-act="quote" data-t="' + p.id + '">' + t('business.request_bulk') + '</button>' :
        '<label class="ws-lbl">' + t('product.quantity') + (p.min > 1 ? ' · ' + t('product.min_qty') + ' ' + qtyLbl(p, p.min) : '') + '</label>' + stepper(p.id, start, p.min) +
        '<div class="ws-quick">' + [10, 100, 500].map(n => '<button data-act="plus" data-t="' + p.id + '" data-n="' + n + '">+' + n + '</button>').join('') + '</div>' +
        '<div class="ws-live big" data-live="' + p.id + '"></div>' +
        '<div class="ws-actions"><button class="ws-btn lg" data-act="add" data-t="' + p.id + '"' + (st.blocked ? ' disabled' : '') + '>' + (st.blocked ? t('stock.unavailable') : t('product.add_to_cart')) + '</button>' +
        '<button class="ws-btn dark lg" data-act="ordernow" data-t="' + p.id + '"' + (st.blocked ? ' disabled' : '') + '>' + t('product.order_now') + '</button></div>') +
      '<button class="ws-btn ghost" data-act="pwa" data-t="' + p.id + '">' + icon('message-circle') + ' ' + t('product.whatsapp') + '</button>' +
      '</div></div>';
  }
  function detailLive(p, qty) {
    const pr = priceFor(p, qty);
    if (pr.status === 'bulk') return '<div class="ws-calc"><span>' + num(qty) + ' kg × ' + fmt(p.fixed) + '</span><b>' + fmt(pr.total) + '</b></div><small>' + t('business.quote') + ' — indicative</small>';
    if (pr.status === 'ok') return '<div class="ws-unit">' + t('product.unit_price') + ' <b>' + fmt(pr.unit) + '</b> ' + unitLbl(p) + '</div><div class="ws-calc"><span>' + num(qty) + ' × ' + fmt(pr.unit) + '</span></div><div class="ws-total">' + t('product.total') + '<b>' + fmt(pr.total) + '</b></div>';
    return liveHtml(p, qty);
  }
  function cartView() {
    const lines = cartLines(), tot = cartTotals();
    if (!lines.length) return '<div class="ws-empty">' + icon('shopping-cart') + '<p>' + t('cart.empty') + '</p><button class="ws-btn" data-act="home">' + t('cart.continue') + '</button></div>';
    return '<h2 class="ws-title">' + t('cart.title') + '</h2><div class="ws-lines">' + lines.map(({ l, p, pr, st }) => {
      const hint = nextTierHint(p, l.qty);
      return '<div class="ws-line"><div class="ws-lh"><div><b>' + esc(p.name) + '</b><small>' + esc(p.pack) + '</small></div><button class="ws-x" data-act="rm" data-t="' + p.id + '">' + t('cart.remove') + '</button></div>' +
        '<div class="ws-lr">' + stepper(p.id, l.qty, p.min) + '<div class="ws-lp">' +
        (pr.status === 'ok' ? '<span>' + fmt(pr.unit) + ' ' + unitLbl(p) + '</span><b>' + fmt(pr.total) + '</b>' : '<span class="ws-quote">' + t('business.quote') + '</span>') + '</div></div>' +
        (hint ? '<div class="ws-hint">' + t('cart.tier_hint', { n: num(hint.n), p: fmt(hint.price) }) + '</div>' : '') +
        (pr.status === 'quote' ? '<button class="ws-btn gold" data-act="quote" data-t="' + p.id + '" data-q="' + l.qty + '">' + t('business.request_quote') + '</button>' : '') +
        (st.blocked ? '<div class="ws-warn">' + t('stock.unavailable') + '</div>' : '') + '</div>';
    }).join('') + '</div>' +
      '<div class="ws-sum"><div><span>' + t('order.total_qty') + '</span><b>' + num(tot.qty) + '</b></div><div class="big"><span>' + t('cart.total') + '</span><b>' + fmt(tot.total) + '</b></div></div>' +
      (tot.blocked ? '<div class="ws-warn">' + t('cart.quote_block') + '</div>' : '') +
      '<div class="ws-actions"><button class="ws-btn lg" data-act="checkout"' + (tot.blocked ? ' disabled' : '') + '>' + t('cart.proceed') + '</button>' +
      '<button class="ws-btn ghost" data-act="home">' + t('cart.continue') + '</button></div>';
  }
  function summaryHtml() {
    const lines = cartLines().filter(x => x.pr.status === 'ok'), tot = cartTotals();
    return '<div class="ws-h">' + t('order.summary') + '</div><div class="ws-table"><table><thead><tr><th>Product</th><th class="r">Qty</th><th class="r">Unit</th><th class="r">Subtotal</th></tr></thead><tbody>' +
      lines.map(({ l, p, pr }) => '<tr><td>' + esc(p.name) + ' <small>' + esc(p.pack) + '</small></td><td class="r">' + num(l.qty) + '</td><td class="r">' + fmt(pr.unit) + '</td><td class="r">' + fmt(pr.total) + '</td></tr>').join('') +
      '</tbody></table></div><div class="ws-sum"><div><span>' + t('order.total_qty') + '</span><b>' + num(tot.qty) + '</b></div><div class="big"><span>' + t('order.total_value') + '</span><b>' + fmt(tot.total) + '</b></div></div>';
  }
  function checkoutView() {
    const c = lsGet('ws_cust_' + uid(), {});
    const f = (id, label, type, extra) => '<div class="ws-field"><label for="wsf_' + id + '">' + t(label) + (extra === 'req' ? ' *' : '') + '</label>' +
      (type === 'textarea' ? '<textarea id="wsf_' + id + '" rows="2">' + esc(c[id] || '') + '</textarea>' : '<input id="wsf_' + id + '" type="' + type + '" value="' + esc(c[id] || '') + '">') + '</div>';
    return '<button class="ws-back" data-act="cart">‹ ' + t('cart.title') + '</button><h2 class="ws-title">' + t('order.details') + '</h2>' +
      '<div class="ws-form">' + f('name', 'order.name', 'text', 'req') + f('business', 'order.business', 'text') + f('phone', 'order.phone', 'tel', 'req') + f('whatsapp', 'order.whatsapp', 'tel') +
      f('address', 'order.address', 'textarea', 'req') + f('city', 'order.city', 'text', 'req') + f('province', 'order.province', 'text') +
      '<div class="ws-field"><label for="wsf_type">' + t('order.type') + '</label><select id="wsf_type">' + CUSTOMER_TYPES.map(x => '<option' + (c.type === x ? ' selected' : '') + '>' + x + '</option>').join('') + '</select></div>' +
      f('note', 'order.note', 'textarea') + '</div>' + summaryHtml() +
      (S.backendMissing ? '<div class="ws-warn">' + t('order.missing_backend') + '</div>' : '') +
      '<div class="ws-actions"><button class="ws-btn lg" data-act="submit"' + (S.busy ? ' disabled' : '') + '>' + t('order.confirm') + '</button>' +
      '<button class="ws-btn ghost" data-act="waorder">' + icon('message-circle') + ' ' + t('order.whatsapp_btn') + '</button></div>';
  }
  function readForm() {
    const g = id => ($('wsf_' + id) || {}).value || '';
    return { name: g('name').trim(), business: g('business').trim(), phone: g('phone').trim(), whatsapp: g('whatsapp').trim(), address: g('address').trim(),
      city: g('city').trim(), province: g('province').trim(), type: g('type'), note: g('note').trim() };
  }
  function validForm(c) {
    if (!c.name || !c.phone || !c.address || !c.city) { toast('Please fill name, phone, address and city'); return false; }
    return true;
  }
  function confirmView() {
    const o = S.order; if (!o) return catalogueView();
    return '<div class="ws-done">' + icon('circle-check') + '<h2>' + t('order.received') + '</h2><div class="ws-badge s-new">' + t('order.pending') + '</div></div>' +
      '<div class="ws-kv"><div><span>' + t('order.number') + '</span><b>' + esc(o.order_id) + '</b></div><div><span>' + t('order.name') + '</span><b>' + esc(o.customer) + '</b></div>' +
      '<div><span>' + t('cart.total') + '</span><b>' + fmt(o.total) + '</b></div><div><span>' + t('order.status') + '</span><b>' + esc(o.status) + '</b></div></div>' +
      '<div class="ws-table"><table><tbody>' + o.items.map(i => '<tr><td>' + esc(i.name) + ' <small>' + esc(i.pack_size) + '</small></td><td class="r">' + num(i.qty) + ' × ' + fmt(i.unit_price) + '</td><td class="r">' + fmt(i.subtotal) + '</td></tr>').join('') + '</tbody></table></div>' +
      '<div class="ws-actions">' + (isGuest() ? '' : '<button class="ws-btn" data-act="myorders">' + t('order.view') + '</button>') + '<button class="ws-btn gold" data-act="contact">' + t('catalogue.contact') + '</button><button class="ws-btn ghost" data-act="home">' + t('cart.continue') + '</button></div>';
  }
  function ordersView() {
    return '<button class="ws-back" data-act="home">‹ ' + t('common.back') + '</button><h2 class="ws-title">' + t('catalogue.my_orders') + '</h2>' +
      (S.orders.length ? S.orders.map((o, i) => '<div class="ws-ord"><div class="ws-lh"><div><b>' + esc(o.id) + '</b><small>' + new Date(o.created_at).toLocaleString() + '</small></div>' + statusBadge(o.order_status) + '</div>' +
        '<div class="ws-ordi">' + o.items.map(x => esc(x.name) + ' ' + esc(x.pack_size) + ' × ' + num(x.qty)).join('<br>') + '</div>' +
        '<div class="ws-lh"><b>' + fmt(o.total) + '</b><button class="ws-btn sm" data-act="reorder" data-t="' + i + '">' + t('order.reorder') + '</button></div></div>').join('') +
        '<div class="ws-note">' + t('order.reorder_note') + '</div>' : '<div class="ws-empty">' + t('order.none') + '</div>');
  }

  /* ----------------------------------------------------------- admin */
  function adminView() {
    const tabs = [['orders', 'admin.orders'], ['prices', 'admin.prices'], ['analytics', 'admin.analytics']];
    return '<button class="ws-back" data-act="home">‹ ' + t('common.back') + '</button><div class="ws-chiprow">' +
      tabs.map(([k, l]) => '<button class="ws-chip' + (S.adminTab === k ? ' on' : '') + '" data-act="atab" data-t="' + k + '">' + t(l) + '</button>').join('') + '</div>' +
      (!S.dbReady ? '<div class="ws-warn">Database tables not installed — run wholesale-setup.sql in Supabase to save prices, orders and analytics.</div>' : '') +
      (S.adminTab === 'orders' ? adminOrders() : S.adminTab === 'prices' ? adminPrices() : adminAnalytics());
  }
  function adminOrders() {
    if (!S.adminOrders.length) return '<div class="ws-empty">' + t('order.none') + '</div>';
    return '<div class="ws-table"><table><thead><tr><th>Order #</th><th>Customer</th><th>Business</th><th class="r">Items</th><th class="r">Qty</th><th class="r">Total</th><th>Status</th><th>Date</th></tr></thead><tbody>' +
      S.adminOrders.map((o, i) => '<tr class="clk" data-act="aorder" data-t="' + i + '"><td><b>' + esc(o.id) + '</b></td><td>' + esc(o.customer_name) + '</td><td>' + esc(o.business_name || '—') + '</td><td class="r">' + o.items.length +
        '</td><td class="r">' + num(o.total_qty) + '</td><td class="r">' + fmt(o.total) + '</td><td>' + statusBadge(o.order_status) + '</td><td>' + new Date(o.created_at).toLocaleDateString() + '</td></tr>').join('') + '</tbody></table></div>';
  }
  function adminPrices() {
    return '<div class="ws-actions"><button class="ws-btn sm" data-act="pedit" data-t="">+ New product</button>' +
      (S.dbReady ? '<button class="ws-btn sm ghost" data-act="seed">Save default prices to database</button><button class="ws-btn sm ghost" data-act="automatch">Auto-match photos from Products</button>' : '') + '</div>' +
      '<div class="ws-table"><table><thead><tr><th>Product</th><th>Pack</th><th class="r">Base</th><th class="r">Tiers</th><th>Stock link</th><th>Active</th><th></th></tr></thead><tbody>' +
      S.products.map(p => '<tr><td><b>' + esc(p.name) + '</b></td><td>' + esc(p.pack) + '</td><td class="r">' + fmt(basePrice(p)) + '</td><td class="r">' + (p.kind === 'bulk' ? 'fixed' : tiersFor(p).length) + '</td><td>' +
        (p.linked ? '✓' : '—') + '</td><td>' + (p.active ? 'Yes' : 'No') + '</td><td><button class="ws-btn sm ghost" data-act="pedit" data-t="' + p.id + '">Edit</button></td></tr>').join('') + '</tbody></table></div>';
  }
  function adminAnalytics() {
    const ev = S.events, ords = S.adminOrders;
    const cnt = n => ev.filter(e => e.event === n).length;
    const top = (name, key) => { const m = {}; ev.filter(e => e.event === name && e.product_id).forEach(e => { m[e.product_id] = (m[e.product_id] || 0) + (key ? e.qty || 0 : 1); }); const k = Object.keys(m).sort((a, b) => m[b] - m[a])[0]; return k ? ((byId(k) || {}).name || k) + ' ' + ((byId(k) || {}).pack || '') + ' (' + num(m[k]) + ')' : '—'; };
    const live = ords.filter(o => o.order_status !== 'CANCELLED');
    const val = live.reduce((s, o) => s + Number(o.total), 0), qty = live.reduce((s, o) => s + o.total_qty, 0);
    const types = {}; live.forEach(o => { types[o.customer_type || 'Other'] = (types[o.customer_type || 'Other'] || 0) + 1; });
    const card = (l, v) => '<div class="ws-stat"><span>' + l + '</span><b>' + v + '</b></div>';
    return '<div class="ws-note">Last 30 days · events since tracking began</div><div class="ws-stats">' +
      card('Catalogue views', num(cnt('catalogue_view'))) + card('Product views', num(cnt('product_view'))) + card('Add-to-cart', num(cnt('add_to_cart'))) +
      card('Checkout starts', num(cnt('checkout_start'))) + card('Quote requests', num(cnt('quote_request'))) + card('Orders', num(live.length)) +
      card('Order value', fmt(val)) + card('Quantity purchased', num(qty)) + card('Most viewed', esc(top('product_view'))) + card('Most ordered', esc(mostOrdered(live))) +
      card('Customer types', Object.keys(types).map(k => esc(k) + ' ' + types[k]).join(' · ') || '—') + card('Wholesale vs bulk', num(live.length) + ' wholesale · ' + num(cnt('quote_request')) + ' bulk/quote') + '</div>';
  }
  function mostOrdered(ords) {
    const m = {}; ords.forEach(o => o.items.forEach(i => { const k = i.name + ' ' + i.pack_size; m[k] = (m[k] || 0) + i.qty; }));
    const k = Object.keys(m).sort((a, b) => m[b] - m[a])[0]; return k ? k + ' (' + num(m[k]) + ')' : '—';
  }
  async function loadAdmin() {
    if (!isOwner()) return;
    const sb = G('supabase'), bid = BID();
    try {
      const [o, e] = await Promise.all([
        sb.from('wholesale_orders').select('*').eq('user_id', bid).order('created_at', { ascending: false }).limit(200),
        sb.from('wholesale_events').select('event,product_id,qty,value,created_at').eq('user_id', bid).gte('created_at', new Date(Date.now() - 30 * 864e5).toISOString()).limit(5000)
      ]);
      S.adminOrders = o.data || []; S.events = e.data || []; if (!o.error) S.dbReady = true;
    } catch (x) { /* not installed */ }
    render();
  }

  /* ----------------------------------------------------------- modals */
  function modal(html) { S.modal = html; renderModal(); }
  function closeModal() { S.modal = null; renderModal(); }
  function renderModal() {
    let m = $('wsModal'); if (!m) return;
    m.innerHTML = S.modal ? '<div class="ws-mback" data-act="mclose"></div><div class="ws-msheet">' + S.modal + '</div>' : '';
    m.classList.toggle('open', !!S.modal); refreshIcons();
  }
  function openQuote(id, qty) {
    const p = byId(id); if (!p) return;
    const c = lsGet('ws_cust_' + uid(), {});
    track('quote_request', id, qty || null, null, { stage: 'open' });
    modal('<h3>' + (p.kind === 'bulk' ? t('business.request_bulk') : t('business.request_quote')) + '</h3><p class="ws-sub">' + esc(p.name) + ' · ' + esc(p.pack) + '</p>' +
      '<div class="ws-field"><label>' + t('product.quantity') + (p.unit === 'kg' ? ' (kg)' : '') + '</label><input id="wsq_qty" type="number" min="1" value="' + (qty || (p.kind === 'bulk' ? 10 : p.quoteFrom || 1)) + '"></div>' +
      '<div class="ws-field"><label>' + t('order.name') + '</label><input id="wsq_name" value="' + esc(c.name || '') + '"></div>' +
      '<div class="ws-field"><label>' + t('order.business') + '</label><input id="wsq_biz" value="' + esc(c.business || '') + '"></div>' +
      '<div class="ws-field"><label>' + t('order.phone') + '</label><input id="wsq_phone" type="tel" value="' + esc(c.phone || '') + '"></div>' +
      '<div class="ws-actions"><button class="ws-btn" data-act="sendquote" data-t="' + id + '">' + icon('message-circle') + ' ' + t('order.whatsapp_btn') + '</button><button class="ws-btn ghost" data-act="mclose">' + t('common.cancel') + '</button></div>');
  }
  function openShare() {
    const url = shareUrl();
    modal('<h3>' + t('share.title') + '</h3><div class="ws-share">' +
      '<a class="ws-btn" target="_blank" rel="noopener" href="https://wa.me/?text=' + encodeURIComponent('DRYBEA Wholesale Catalogue: ' + url) + '">WhatsApp</a>' +
      '<a class="ws-btn dark" target="_blank" rel="noopener" href="https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent(url) + '">Facebook</a>' +
      '<button class="ws-btn gold" data-act="copy">' + t('share.copy') + '</button></div>' +
      '<div class="ws-url">' + esc(url) + '</div><div class="ws-qrbox"><div id="wsQr"></div><b>' + t('share.qr_caption') + '</b></div>' +
            '<div class="ws-actions"><button class="ws-btn ghost" data-act="mclose">' + t('common.close') + '</button></div>');
    loadQr().then(() => { const el = $('wsQr'); if (el && window.QRCode) { el.innerHTML = ''; new QRCode(el, { text: url, width: 176, height: 176, correctLevel: QRCode.CorrectLevel.M }); } else if (el) el.textContent = 'QR unavailable offline'; });
  }
  let qrPromise = null;
  function loadQr() {
    if (window.QRCode) return Promise.resolve();
    if (!qrPromise) qrPromise = new Promise(res => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'; s.onload = res; s.onerror = res; document.head.appendChild(s); });
    return qrPromise;
  }
  function openProductEditor(id, draft) {
    const p = draft || (id ? JSON.parse(JSON.stringify(byId(id))) : mk('', '', '50g', { id: '', name: '', tiers: [{ min: 1, max: null, price: 0 }], sort: S.products.length }));
    S.editing = p;
    const inv = appProducts();
    const tr = (x, i) => '<div class="ws-trow"><input type="number" data-tf="min" data-i="' + i + '" value="' + x.min + '" placeholder="min"><input type="number" data-tf="max" data-i="' + i + '" value="' + (x.max == null ? '' : x.max) + '" placeholder="max (blank=∞)"><input type="number" data-tf="price" data-i="' + i + '" value="' + x.price + '" placeholder="Rs."><button data-act="trm" data-t="' + i + '">✕</button></div>';
    const withImg = inv.filter(x => x.imageUrl);
    const imgBlock = q => '<div class="ws-field"><label>Product photo (packaging is never altered — only resized)</label><div class="ws-imgpick">' +
      '<img id="wsImgPrev" alt="" ' + (q.image ? 'src="' + esc(q.image) + '"' : 'style="visibility:hidden"') + '><div class="ws-imgctl">' +
      '<label class="ws-btn sm">' + icon('upload') + ' Upload photo<input id="wsImgFile" type="file" accept="image/*" hidden></label>' +
      '<select id="wsImgPick"><option value="">Use photo from Products tab…</option>' + withImg.map(x => '<option value="' + esc(x.imageUrl) + '">' + esc(x.name) + '</option>').join('') + '</select>' +
      '<input data-pf="image" type="text" placeholder="…or paste image URL" value="' + esc(q.image || '') + '"></div></div></div>';
    const f = (k, label, val, type) => '<div class="ws-field"><label>' + label + '</label><input data-pf="' + k + '" type="' + (type || 'text') + '" value="' + esc(val == null ? '' : val) + '"></div>';
    modal('<h3>' + (id ? 'Edit product' : 'New product') + '</h3>' + f('name', 'Product name', p.name) + '<div class="ws-two">' + f('fish', 'Fish type', p.fish) + f('pack', 'Pack size', p.pack) + '</div>' +
      '<div class="ws-two">' + f('cat', 'Filter category (50g/100g/500g/1kg/L-SIZE/BULK)', p.cat) + f('min', 'Minimum quantity', p.min, 'number') + '</div>' +
      '<div class="ws-two">' + f('quoteFrom', 'Special business quote from qty (blank = never)', p.quoteFrom, 'number') + f('fixed', 'Fixed price per kg (bulk only)', p.fixed, 'number') + '</div>' +
      imgBlock(p) +
      '<div class="ws-field"><label>Kind</label><select data-pf="kind"><option value="wholesale"' + (p.kind === 'wholesale' ? ' selected' : '') + '>Wholesale (tiers)</option><option value="bulk"' + (p.kind === 'bulk' ? ' selected' : '') + '>Bulk business (fixed / kg)</option></select></div>' +
      '<div class="ws-field"><label>Inventory link</label><select data-pf="linked"><option value="">— none (untracked) —</option>' + inv.map(x => '<option value="' + esc(x.id) + '"' + (String(p.linked) === String(x.id) ? ' selected' : '') + '>' + esc(x.name) + ' (stock ' + (x.stockQty || 0) + ')</option>').join('') + '</select></div>' +
      '<label class="ws-check"><input type="checkbox" data-pf="backorder"' + (p.backorder ? ' checked' : '') + '> Allow backorder when out of stock</label>' +
      '<label class="ws-check"><input type="checkbox" data-pf="active"' + (p.active ? ' checked' : '') + '> Active (visible in catalogue)</label>' +
      '<div class="ws-h">Quantity tiers (standard price list)</div><div id="wsTrows">' + p.tiers.map(tr).join('') + '</div><button class="ws-btn sm ghost" data-act="tadd">+ Add tier</button>' +
      '<div class="ws-actions"><button class="ws-btn" data-act="psave">' + t('common.save') + '</button><button class="ws-btn ghost" data-act="mclose">' + t('common.cancel') + '</button></div>');
  }
  function setEditorImage(url) {
    const inp = document.querySelector('#wsModal [data-pf="image"]'); if (inp) inp.value = url || '';
    const pv = $('wsImgPrev'); if (pv) { if (url) { pv.src = url; pv.style.visibility = 'visible'; } else pv.style.visibility = 'hidden'; }
  }
  function compressImage(file, max) {
    return new Promise((res, rej) => {
      const img = new Image(), u = URL.createObjectURL(file);
      img.onload = () => {
        const r = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement('canvas');
        c.width = Math.round(img.width * r); c.height = Math.round(img.height * r);
        const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height);
        c.toBlob(b => { URL.revokeObjectURL(u); b ? res(b) : rej(new Error('Could not process image')); }, 'image/jpeg', 0.85);
      };
      img.onerror = () => rej(new Error('Not a valid image')); img.src = u;
    });
  }
  async function uploadImage(file) {
    if (!file) return;
    toast('Uploading photo…');
    try {
      const blob = await compressImage(file, 900);
      const path = BID() + '/ws-' + Date.now() + '.jpg';
      const sb = G('supabase');
      const up = await sb.storage.from('product-images').upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
      if (up.error) throw up.error;
      setEditorImage(sb.storage.from('product-images').getPublicUrl(path).data.publicUrl);
      toast('Photo uploaded — press Save');
    } catch (e) { toast('Upload failed: ' + (e.message || e)); }
  }
  async function autoMatchPhotos() {
    if (!S.dbReady) return toast('Run wholesale-setup.sql first');
    let n = 0; const sb = G('supabase');
    for (const p of S.products) {
      if (p.image) continue;
      const m = matchAppProduct(p); if (!m) continue;
      const r = await sb.from('wholesale_products').update({ image_url: m.imageUrl }).eq('id', p.id);
      if (!r.error) { p.image = m.imageUrl; n++; }
    }
    lsSet(CACHE_KEY, { bid: BID(), at: Date.now(), products: S.products, dbReady: S.dbReady });
    render(); toast(n ? n + ' photos matched from Products' : 'No matching product photos found — upload manually');
  }
  function collectEditor() {
    const p = S.editing;
    document.querySelectorAll('#wsModal [data-pf]').forEach(el => {
      const k = el.dataset.pf; let v = el.type === 'checkbox' ? el.checked : el.value;
      if (['min', 'quoteFrom', 'fixed'].includes(k)) v = v === '' ? null : Number(v);
      p[k] = v;
    });
    p.min = p.min || 1;
    document.querySelectorAll('#wsModal .ws-trow').forEach((row, i) => {
      const g = f => row.querySelector('[data-tf="' + f + '"]').value;
      p.tiers[i] = { min: Number(g('min')), max: g('max') === '' ? null : Number(g('max')), price: Number(g('price')) };
    });
    return p;
  }
  async function saveProduct() {
    const p = collectEditor();
    if (!p.name || !p.pack) return toast('Name and pack size are required');
    if (p.kind === 'wholesale') {
      const ts = p.tiers.slice().sort((a, b) => a.min - b.min);
      if (!ts.length || ts.some(x => !(x.price >= 0) || !(x.min >= 1))) return toast('Fix tier values');
      for (let i = 1; i < ts.length; i++) if (ts[i - 1].max == null || ts[i].min <= ts[i - 1].max) return toast('Tiers overlap');
      p.tiers = ts;
    } else if (!(p.fixed > 0)) return toast('Enter the fixed price per kg');
    if (!p.id) p.id = (p.fish + '-' + p.pack).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36).slice(-3);
    if (!S.dbReady) return toast('Run wholesale-setup.sql first — prices can\'t be saved yet');
    const sb = G('supabase'), bid = BID();
    try {
      const row = { id: p.id, user_id: bid, name: p.name, fish_type: p.fish, pack_size: p.pack, category: p.cat, kind: p.kind, unit: p.kind === 'bulk' ? 'kg' : 'unit',
        min_qty: p.min, quote_from: p.kind === 'bulk' ? null : p.quoteFrom, fixed_price: p.kind === 'bulk' ? p.fixed : null, image_url: p.image || null,
        linked_product_id: p.linked || null, allow_backorder: p.backorder, active: p.active, sort_order: p.sort || 0 };
      let r = await sb.from('wholesale_products').upsert(row); if (r.error) throw r.error;
      r = await sb.from('wholesale_tiers').delete().eq('product_id', p.id).eq('price_list', 'standard'); if (r.error) throw r.error;
      if (p.kind === 'wholesale') { r = await sb.from('wholesale_tiers').insert(p.tiers.map(x => ({ product_id: p.id, price_list: 'standard', min_quantity: x.min, max_quantity: x.max, unit_price: x.price }))); if (r.error) throw r.error; }
      closeModal(); await fetchCatalogue(bid); render(); toast('Saved — new orders use these prices');
    } catch (e) { toast('Save failed: ' + (e.message || e)); }
  }
  async function seedDefaults() {
    if (!confirm('Save the built-in default prices into the database? Existing products with the same id are overwritten.')) return;
    S.editing = null;
    for (const d of DEFAULTS) { S.editing = JSON.parse(JSON.stringify(d)); const sb = G('supabase'), bid = BID(), p = S.editing;
      const r = await sb.from('wholesale_products').upsert({ id: p.id, user_id: bid, name: p.name, fish_type: p.fish, pack_size: p.pack, category: p.cat, kind: p.kind, unit: p.unit, min_qty: p.min, quote_from: p.quoteFrom, fixed_price: p.fixed, active: true, sort_order: p.sort });
      if (r.error) return toast('Seed failed: ' + r.error.message);
      await sb.from('wholesale_tiers').delete().eq('product_id', p.id).eq('price_list', 'standard');
      if (p.tiers.length) await sb.from('wholesale_tiers').insert(p.tiers.map(x => ({ product_id: p.id, price_list: 'standard', min_quantity: x.min, max_quantity: x.max, unit_price: x.price })));
    }
    await fetchCatalogue(BID()); render(); toast('Default prices saved');
  }

  /* ------------------------------------------------------- order flow */
  function waOrderText(c) {
    const lines = cartLines().filter(x => x.pr.status === 'ok'), tot = cartTotals();
    return 'DRYBEA WHOLESALE ORDER\n\nCustomer: ' + (c.name || '') + '\nBusiness: ' + (c.business || '') + '\nPhone: ' + (c.phone || '') + '\n\nProducts:\n\n' +
      lines.map(({ l, p, pr }) => p.name + ' ' + p.pack + ' × ' + num(l.qty) + '\nUnit Price: ' + fmt(pr.unit) + '\nSubtotal: ' + fmt(pr.total)).join('\n\n') + '\n\nTotal:\n' + fmt(tot.total);
  }
  async function submitOrder() {
    const c = readForm(); if (!validForm(c)) return;
    lsSet('ws_cust_' + uid(), c);
    const tot = cartTotals(); if (tot.blocked || !S.cart.length) return;
    S.busy = true; const btn = document.querySelector('[data-act="submit"]'); if (btn) btn.disabled = true;
    try {
      // Only ids + quantities are sent. The server prices everything itself.
      const { data, error } = await G('supabase').rpc('wholesale_place_order', {
        p_business: BID(), p_customer: c, p_items: S.cart.map(x => ({ product_id: x.id, qty: x.qty }))
      });
      if (error) {
        const msg = String(error.message || '').toLowerCase();
        if (error.code === 'PGRST202' || msg.includes('could not find the function')) { S.backendMissing = true; S.busy = false; render(); return; }
        throw error;
      }
      S.order = Object.assign({}, data, { customer: c.name });
      track('order', null, data.total_qty, data.total, { type: c.type });
      S.cart = []; saveCart(); S.view = 'confirm';
      if (typeof G('loadOrdersFromCloud') === 'function') { try { G('loadOrdersFromCloud')(); } catch (e) { /* refresh is optional */ } }
    } catch (e) { toast(e.message || 'Order failed'); }
    S.busy = false; render();
  }
  async function loadMyOrders() {
    try {
      const { data } = await G('supabase').from('wholesale_orders').select('*').eq('created_by', uid()).order('created_at', { ascending: false }).limit(30);
      S.orders = data || [];
    } catch (e) { S.orders = []; }
    render();
  }
  function reorder(i) {
    const o = S.orders[i]; if (!o) return;
    S.cart = []; // old prices are ignored: only product id + qty are reused
    o.items.forEach(it => { const p = byId(it.product_id); if (p && p.active && priceFor(p, it.qty).status !== 'below_min') S.cart.push({ id: p.id, qty: Math.floor(it.qty) }); });
    saveCart(); S.view = 'cart'; render(); toast(t('order.reorder_note'));
  }

  /* ---------------------------------------------------------- render */
  function refreshIcons() { try { if (window.lucide) lucide.createIcons(); } catch (e) { /* icons optional */ } }
  function headerHtml() {
    return '<header class="ws-hero"><div class="ws-hero-top"><span class="ws-brand">' + t('catalogue.brand') + '</span>' +
      '<div class="ws-hero-btns"><button data-act="share">' + icon('share-2') + '<span>' + t('catalogue.share') + '</span></button>' +
      '<button data-act="contact">' + icon('phone') + '<span>' + t('catalogue.contact') + '</span></button>' +
      (isGuest() ? '' : '<button data-act="myorders">' + icon('clipboard-list') + '<span>' + t('catalogue.my_orders') + '</span></button>') +
      (isOwner() ? '<button data-act="admin">' + icon('settings-2') + '<span>' + t('catalogue.admin') + '</span></button>' : '') + '</div></div>' +
      '<h1>' + t('catalogue.title') + '</h1><div class="ws-hero-sub">' + t('catalogue.collection') + ' · ' + t('catalogue.types') + '</div>' +
      '<p class="ws-tag">“' + t('catalogue.tagline') + '”</p></header>';
  }
  function render() {
    const r = root(); if (!r || !S.loaded) return;
    const focusSearch = document.activeElement && document.activeElement.id === 'wsSearch';
    const pos = focusSearch ? document.activeElement.selectionStart : 0;
    const v = S.view;
    const body = v === 'detail' ? detailView() : v === 'cart' ? cartView() : v === 'checkout' ? checkoutView() : v === 'confirm' ? confirmView() : v === 'orders' ? ordersView() : v === 'admin' ? adminView() : catalogueView();
    r.innerHTML = headerHtml() + '<main class="ws-main">' + body + '</main><div id="wsModal" class="ws-modal' + (S.modal ? ' open' : '') + '"></div>' +
      '<button class="ws-float" id="wsFloat" data-act="cart"' + (v === 'confirm' ? ' style="display:none"' : '') + '>' + icon('shopping-cart') + ' ' + t('cart.button') + ' (<span id="wsCount">' + cartCount() + '</span>)</button><div class="ws-toast" id="wsToast"></div>';
    if (S.modal) renderModal();
    document.querySelectorAll('[data-live]').forEach(el => { const p = byId(el.dataset.live), inp = r.querySelector('[data-qty="' + el.dataset.live + '"]'); if (p && inp) el.innerHTML = v === 'detail' ? detailLive(p, inp.value) : liveHtml(p, inp.value); });
    if (v === 'detail') highlightTier();
    refreshIcons();
    if (focusSearch) { const s = $('wsSearch'); if (s) { s.focus(); try { s.setSelectionRange(pos, pos); } catch (e) { /* type=search */ } } }
  }
  function highlightTier() {
    const p = byId(S.detailId), inp = root().querySelector('[data-qty]'); if (!p || !inp) return;
    const q = Number(inp.value) || 0;
    root().querySelectorAll('#wsTiers tr[data-tmin]').forEach(tr => {
      const mn = Number(tr.dataset.tmin), mx = tr.dataset.tmax === '' ? Infinity : Number(tr.dataset.tmax);
      tr.classList.toggle('cur', q >= mn && q <= mx);
    });
  }
  function updateCartBadge() { const c = $('wsCount'); if (c) c.textContent = cartCount(); }
  function go(view) { S.view = view; render(); const r = root(); if (r) r.scrollIntoView({ block: 'start' }); if (view === 'checkout') track('checkout_start', null, cartTotals().qty, cartTotals().total); }

  /* ---------------------------------------------------------- events */
  function qtyInput(id) { return root().querySelector('[data-qty="' + id + '"]'); }
  function setQty(id, v) {
    const p = byId(id), inp = qtyInput(id); if (!p || !inp) return;
    v = Math.max(p.min, Math.floor(Number(v)) || p.min); inp.value = v; onQtyChange(id);
  }
  function onQtyChange(id) {
    const p = byId(id), inp = qtyInput(id); if (!p || !inp) return;
    if (S.view === 'cart') {
      const line = S.cart.find(x => x.id === id), before = line ? priceFor(p, line.qty) : null;
      const q = Math.max(1, Math.floor(Number(inp.value)) || 1);
      if (line) line.qty = q; saveCart();
      const after = priceFor(p, q); if (before && after.status === 'ok' && before.status === 'ok' && before.unit !== after.unit) toast(t('cart.price_changed'));
      const y = window.scrollY; render(); window.scrollTo(0, y); return;
    }
    const live = root().querySelector('[data-live="' + id + '"]');
    if (live) live.innerHTML = S.view === 'detail' ? detailLive(p, inp.value) : liveHtml(p, inp.value);
    if (S.view === 'detail') highlightTier();
  }
  function onClick(e) {
    const el = e.target.closest('[data-act]'); if (!el) return;
    const a = el.dataset.act, id = el.dataset.t;
    switch (a) {
      case 'cat': S.cat = id; return render();
      case 'fish': S.fish = id; return render();
      case 'otype': S.otype = id; return render();
      case 'favonly': S.favOnly = !S.favOnly; return render();
      case 'fav': S.favs = S.favs.includes(id) ? S.favs.filter(x => x !== id) : S.favs.concat(id); lsSet('ws_fav_' + uid(), S.favs); return render();
      case 'open': S.detailId = id; track('product_view', id); return go('detail');
      case 'home': return go('catalogue');
      case 'cart': return go('cart');
      case 'checkout': return go('checkout');
      case 'dec': case 'inc': { const p = byId(id), inp = qtyInput(id); const step = p.unit === 'kg' ? 1 : 1; return setQty(id, (Number(inp.value) || p.min) + (a === 'inc' ? step : -step)); }
      case 'plus': { const inp = qtyInput(id); return setQty(id, (Number(inp.value) || 0) + Number(el.dataset.n)); }
      case 'add': { const inp = qtyInput(id); return addToCart(id, Number(inp.value)); }
      case 'ordernow': { const inp = qtyInput(id); addToCart(id, Number(inp.value)); if (S.cart.some(x => x.id === id)) go('checkout'); return; }
      case 'rm': S.cart = S.cart.filter(x => x.id !== id); saveCart(); return render();
      case 'quote': return openQuote(id, Number(el.dataset.q) || (qtyInput(id) && Number(qtyInput(id).value)) || 0);
      case 'sendquote': {
        const p = byId(id), g = k => ($('wsq_' + k) || {}).value || '', q = Number(g('qty'));
        if (!q || !g('name') || !g('phone')) return toast('Enter quantity, name and phone');
        lsSet('ws_cust_' + uid(), Object.assign(lsGet('ws_cust_' + uid(), {}), { name: g('name'), business: g('biz'), phone: g('phone') }));
        track('quote_request', id, q, null, { stage: 'sent', kind: p.kind });
        window.open(waLink((p.kind === 'bulk' ? 'DRYBEA BULK ORDER REQUEST' : 'DRYBEA BUSINESS QUOTE REQUEST') + '\n\nProduct: ' + p.name + ' ' + p.pack + '\nQuantity: ' + num(q) + (p.unit === 'kg' ? ' kg' : ' units') + '\n\nCustomer: ' + g('name') + '\nBusiness: ' + g('biz') + '\nPhone: ' + g('phone')), '_blank');
        return closeModal();
      }
      case 'submit': return submitOrder();
      case 'waorder': { const c = readForm(); if (!validForm(c)) return; lsSet('ws_cust_' + uid(), c); return void window.open(waLink(waOrderText(c)), '_blank'); }
      case 'pwa': { const p = byId(id); return void window.open(waLink('Hello DRYBEA, I am interested in ' + p.name + ' ' + p.pack + '.'), '_blank'); }
      case 'contact': return void window.open(waLink('Hello DRYBEA, I have a question about the wholesale catalogue.'), '_blank');
      case 'share': return openShare();
      case 'copy': return void (navigator.clipboard ? navigator.clipboard.writeText(shareUrl()).then(() => toast(t('share.copied'))) : toast(shareUrl()));
      case 'mclose': return closeModal();
      case 'myorders': S.view = 'orders'; render(); return loadMyOrders();
      case 'reorder': return reorder(Number(id));
      case 'admin': S.view = 'admin'; render(); return loadAdmin();
      case 'atab': S.adminTab = id; return render();
      case 'aorder': { const o = S.adminOrders[Number(id)]; S.viewOrder = o;
        return modal('<h3>' + esc(o.id) + '</h3><div class="ws-kv"><div><span>Customer</span><b>' + esc(o.customer_name) + '</b></div><div><span>Business</span><b>' + esc(o.business_name || '—') + '</b></div><div><span>Phone</span><b>' + esc(o.phone) + '</b></div><div><span>WhatsApp</span><b>' + esc(o.whatsapp || '—') + '</b></div><div><span>Address</span><b>' + esc([o.delivery_address, o.city, o.province].filter(Boolean).join(', ')) + '</b></div><div><span>Type</span><b>' + esc(o.customer_type || '—') + '</b></div></div>' +
          (o.note ? '<div class="ws-note">Note: ' + esc(o.note) + '</div>' : '') +
          '<div class="ws-table"><table><tbody>' + o.items.map(i => '<tr><td>' + esc(i.name) + ' <small>' + esc(i.pack_size) + '</small></td><td class="r">' + num(i.qty) + ' × ' + fmt(i.unit_price) + '</td><td class="r">' + fmt(i.subtotal) + '</td></tr>').join('') + '</tbody></table></div>' +
          '<div class="ws-sum"><div class="big"><span>' + t('cart.total') + '</span><b>' + fmt(o.total) + '</b></div></div>' +
          '<div class="ws-field"><label>Status</label><select id="wsStatusSel">' + STATUSES.map(s => '<option' + (o.order_status === s ? ' selected' : '') + '>' + s + '</option>').join('') + '</select></div>' +
          '<div class="ws-actions"><button class="ws-btn" data-act="setstatus" data-t="' + Number(id) + '">' + t('common.save') + '</button><button class="ws-btn ghost" data-act="mclose">' + t('common.close') + '</button></div>'); }
      case 'setstatus': { const o = S.adminOrders[Number(id)], v = $('wsStatusSel').value;
        return void G('supabase').from('wholesale_orders').update({ order_status: v }).eq('id', o.id).then(r => { if (r.error) return toast(r.error.message); o.order_status = v; closeModal(); render(); }); }
      case 'pedit': return openProductEditor(id || null);
      case 'tadd': { const d = collectEditor(); d.tiers.push({ min: 1, max: null, price: 0 }); return openProductEditor(null, d); }
      case 'trm': { const d = collectEditor(); d.tiers.splice(Number(id), 1); return openProductEditor(null, d); }
      case 'psave': return saveProduct();
      case 'seed': return seedDefaults();
      case 'automatch': return autoMatchPhotos();
    }
  }
  function onInput(e) {
    const el = e.target;
    if (el.id === 'wsSearch') { S.q = el.value; const g = $('wsGrid'); const list = filtered(); const main = root().querySelector('.ws-main'); const old = g ? g.outerHTML : root().querySelector('.ws-empty'); const html = list.length ? '<div class="ws-grid" id="wsGrid">' + list.map(cardHtml).join('') + '</div>' : '<div class="ws-empty">' + t('catalogue.empty') + '</div>'; if (old && (g || root().querySelector('.ws-empty'))) { (g || root().querySelector('.ws-empty')).outerHTML = html; } list.forEach(p => { const lv = root().querySelector('[data-live="' + p.id + '"]'), q = qtyInput(p.id); if (lv && q) lv.innerHTML = liveHtml(p, q.value); }); refreshIcons(); return; }
    if (el.dataset && el.dataset.qty) onQtyChange(el.dataset.qty);
  }
  function onChangeQty(e) { const el = e.target; if (el.id === 'wsImgFile') return void uploadImage(el.files[0]); if (el.id === 'wsImgPick') return setEditorImage(el.value); if (el.dataset && el.dataset.qty && S.view === 'cart') onQtyChange(el.dataset.qty); }

  /* ------------------------------------------------------------ mount */
  let mounted = false;
  async function mount() {
    const r = root(); if (!r) return;
    if (!mounted) {
      mounted = true;
      S.cart = lsGet(CART_KEY, []); S.favs = lsGet('ws_fav_' + uid(), []);
      r.addEventListener('click', onClick); r.addEventListener('input', onInput); r.addEventListener('change', onChangeQty);
      r.innerHTML = '<div class="ws-loading">Loading catalogue…</div>';
      loadOwnerWa();
      await loadAppProducts();
      await loadCatalogue(false);
      // drop cart lines for products that no longer exist
      S.cart = S.cart.filter(x => byId(x.id)); saveCart(); render();
      track('catalogue_view');
    } else { render(); refreshInBackground(); loadAppProducts().then(render); track('catalogue_view'); }
  }

  /* ------------------------------------------------ Products sub-tabs */
  window.switchProductsSub = function (which) {
    const list = $('productsListPane'), tools = $('productsToolsPane');
    if (!list || !tools) return;
    list.style.display = which === 'tools' ? 'none' : '';
    tools.style.display = which === 'tools' ? '' : 'none';
    document.querySelectorAll('#productsSubTabs [data-psub]').forEach(b => b.classList.toggle('is-active', b.dataset.psub === which));
    try { history.replaceState(null, '', which === 'tools' ? '#wholesale' : location.pathname + location.search); } catch (e) { /* ignore */ }
    if (which === 'tools') mount();
    refreshIcons();
  };
  window.WS = { matchAppProduct, priceFor, DEFAULTS, mount, state: S }; // exposed for testing / future tools

  // Shared-link support: …/index.html#wholesale opens Products → Tools once signed in.
  function deepLink() {
    if (location.hash !== '#wholesale') return;
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      if (G('currentUser') && BID() && typeof G('activateAppTab') === 'function') {
        clearInterval(iv); G('activateAppTab')('products'); window.switchProductsSub('tools');
      } else if (tries > 60) clearInterval(iv);
    }, 500);
  }
  deepLink();
})();
