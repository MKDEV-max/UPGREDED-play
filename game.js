/* =========================================================
   UPGREDED — game.js
   CS2 skin upgrader. Virtual Coins only. Vanilla JS.
   Loop: SKINS → INVENTORY → CURRENT SKIN → TARGET SKIN → CHANCE
         → UPGRADE → STATIC WHEEL + SPINNING ARROW → WIN / FAIL → REPEAT
   ========================================================= */
'use strict';

// =========================================================
// STATE
// =========================================================
const SAVE_KEY = 'upgreded_save_v2';
const TAU = Math.PI * 2;
const MIN_CHANCE = 0.01;
const MAX_CHANCE = 0.95;
const COINS_PER_CLICK = 1;                 // always exactly 1 — no multipliers, no upgrades
const XP_REWARDS = { upgrade: 15, upgradeWin: 40, newSkin: 10, firstDiscovery: 25 };
const POINTER_SPIN_MS = 2700;              // arrow animation length
const POINTER_TURNS = 5;                    // full turns before stopping
const SUCCESS_CENTER = -Math.PI / 2;        // SUCCESS sector is always centred at the top of the wheel
const PAGE_SIZE = 48;
const FONT = '"Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif';
const TARGET_BUCKETS = [
  { id: 'all',  label: 'ALL',    min: 1,  max: Infinity },
  { id: 'x2',   label: 'x1–2',   min: 1,  max: 2 },
  { id: 'x5',   label: 'x2–5',   min: 2,  max: 5 },
  { id: 'x10',  label: 'x5–10',  min: 5,  max: 10 },
  { id: 'x50',  label: 'x10–50', min: 10, max: 50 },
  { id: 'x100', label: 'x50+',   min: 50, max: Infinity }
];
const INV_SORTS = [['expensive', 'PRICE ↓'], ['cheapest', 'PRICE ↑'], ['rarity', 'RARITY'], ['newest', 'NEWEST']];

const SKIN_BY_ID = {};
SKINS.forEach(s => { SKIN_BY_ID[s.id] = s; });
const SKINS_BY_VALUE = SKINS.slice().sort((a, b) => a.value - b.value);

function createDefaultState() {
  return {
    version: 3,
    coins: ECONOMY.startingCoins,
    inventory: [],            // [{ uid, id, obtainedAt }]
    nextUid: 1,
    selection: { sourceUid: null, targetId: null },
    level: 1,
    xp: 0,
    missions: { date: '', list: [] },
    dailyReward: { day: 0, lastClaim: '' },
    freeDrop: { lastClaim: 0 },
    statistics: {
      totalClicks: 0, totalUpgrades: 0, successfulUpgrades: 0, failedUpgrades: 0,
      coinsEarned: 0, skinsBought: 0, skinsSold: 0, freeDrops: 0, bestStreak: 0,
      highestUpgrade: null     // { fromId, toId, value, chance }
    },
    winStreak: 0,
    highestSkin: null,        // item id of the most valuable skin ever owned
    collections: { discovered: [], completed: [] },   // discovered = base skin ids
    sound: true,
    firstRun: true
  };
}

let state = createDefaultState();

// Transient UI state (not saved)
const ui = {
  tab: 'upgrade',
  invQuery: '', invType: 'all', invWeapon: 'all', invRarity: 'all', invCondition: 'all', invSort: 'expensive', invLimit: 96,
  shopTier: 'cheap', shopType: 'all', shopQuery: '', shopLimit: PAGE_SIZE,
  sourceQuery: '',
  targetBucket: 'all', targetType: 'all', targetQuery: '', targetLimit: PAGE_SIZE,
  spinning: false,
  lastResult: null,
  lastRewardUid: null,
  newUids: new Set(),
  saveTimer: null
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// =========================================================
// HELPERS
// =========================================================
function fmt(n) { return Math.floor(n).toLocaleString('en-US'); }
// Coin price for HTML: "1,500 Coins"
function coinsHTML(v, cls = '') { return `<span class="price ${cls}"><i class="coin"></i>${fmt(v)}<small> Coins</small></span>`; }
// Coin price for plain text (banners)
function coinsText(v) { return `${fmt(v)} Coins`; }
function fmtPercent(p) { return (p * 100).toFixed(1) + '%'; }
function pad2(n) { return String(n).padStart(2, '0'); }
function dateStr(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function todayStr() { return dateStr(new Date()); }
function yesterdayStr() { const d = new Date(); d.setDate(d.getDate() - 1); return dateStr(d); }
function msToMidnight() { const n = new Date(); const m = new Date(n); m.setHours(24, 0, 0, 0); return m - n; }
function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 3600) + 'h ' + pad2(Math.floor(s % 3600 / 60)) + 'm ' + pad2(s % 60) + 's';
}
function escapeHTML(str) { return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function rarityColor(skin) {
  if (skin.type === 'knife' || skin.type === 'gloves') return '#e4ae39';
  return (RARITIES[skin.rarity] || {}).color || '#888';
}
function rarityRank(skin) {
  const base = (RARITIES[skin.rarity] || {}).rank || 0;
  return (skin.type === 'knife' || skin.type === 'gloves') ? base + 3 : base;
}
function rarityLabel(skin) { return skin.type === 'knife' ? '★ ' + skin.rarity : skin.rarity; }
function randomPick(list) { return list[Math.floor(Math.random() * list.length)]; }
function skinsInRange(min, max) { return SKINS.filter(s => s.value >= min && s.value <= max); }
function matchesQuery(skin, q) { return !q || skin.fullName.toLowerCase().includes(q); }
function typeChips(action, active) {
  return [['all', 'ALL']].concat(SKIN_TYPES.map(t => [t.id, t.label]))
    .map(([v, l]) => `<button class="chip chip-sm ${active === v ? 'active' : ''}" data-action="${action}" data-value="${v}">${l}</button>`).join('');
}
function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function seededRandom(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ---- Skin image: local file → official Steam image of the same skin → placeholder ----
const missingLocal = new Set();
const missingAll = new Set();
function skinImgError(img) {
  const local = img.dataset.local;
  const fallback = img.dataset.fallback;
  if (fallback) {
    missingLocal.add(local);
    img.dataset.fallback = '';
    img.src = fallback;
    return;
  }
  missingAll.add(local);
  if (img.parentNode) img.parentNode.classList.add('noimg');
  img.remove();
}
window.skinImgError = skinImgError;

function skinImageHTML(skin, extraClass = '') {
  const placeholder = `<div class="ph"><span class="ph-w">${escapeHTML(skin.weapon)}</span><span class="ph-n">${escapeHTML(skin.name)}</span></div>`;
  if (missingAll.has(skin.image)) {
    return `<div class="skin-img noimg ${extraClass}" style="--rc:${rarityColor(skin)}">${placeholder}</div>`;
  }
  const useRemote = missingLocal.has(skin.image) && skin.imageUrl;
  const src = useRemote ? skin.imageUrl : skin.image;
  const fallback = useRemote ? '' : skin.imageUrl;
  return `<div class="skin-img ${extraClass}" style="--rc:${rarityColor(skin)}">
    <img src="${src}" data-local="${skin.image}" data-fallback="${fallback}" alt="${escapeHTML(skin.fullName)}" loading="lazy" draggable="false" referrerpolicy="no-referrer" onerror="skinImgError(this)">
    ${placeholder}
  </div>`;
}

// =========================================================
// INITIALIZATION
// =========================================================
function init() {
  loadGame();
  FX.init();
  bindEvents();

  if (state.firstRun) giveStarterInventory();
  ensureMissions();
  checkDailyRewardStreak();

  updateSoundButton();
  switchTab('upgrade');
  updateHUD();
  setInterval(gameTick, 1000);
  saveGame();
}

function giveStarterInventory() {
  const starter = STARTER_INVENTORY.filter(id => SKIN_BY_ID[id]);
  starter.forEach(id => addSkin(id));
  state.firstRun = false;
  saveGame();
  const skins = starter.map(id => SKIN_BY_ID[id]);
  openModal(`
    <div class="result-title" style="color:var(--gold)">WELCOME TO UPGREDED</div>
    <p class="modal-text">You received <b>${skins.length} real CS2 skins</b> and ${coinsHTML(ECONOMY.startingCoins)}.<br>
    Pick your current skin, choose a more expensive target, check the chance and press UPGRADE.</p>
    <div class="modal-skins">${skins.map(s => `<div>${skinImageHTML(s)}<div class="small" style="font-weight:800;margin-top:4px">${escapeHTML(s.fullName)}</div><div class="small muted">${s.condition}</div></div>`).join('')}</div>
    <button class="btn btn-gold btn-block" data-action="close-modal">START UPGRADING</button>`);
}

// Countdowns and day rollover. No passive coin income.
function gameTick() {
  if (state.missions.date !== todayStr()) {
    ensureMissions();
    checkDailyRewardStreak();
    if (ui.tab === 'rewards') renderRewards();
  }
  const cd = fmtDuration(msToMidnight());
  const a = $('#drCountdown'); if (a) a.textContent = cd;
  const b = $('#msCountdown'); if (b) b.textContent = cd;
  const fd = $('#fdCountdown');
  if (fd) {
    if (freeDropReady()) renderFreeDrop();
    else fd.textContent = fmtDuration(freeDropMsLeft());
  }
}

function addCoins(amount) {
  state.coins += amount;
  state.statistics.coinsEarned += amount;
}

function spendCoins(amount) {
  if (state.coins < amount) {
    Sound.error();
    toast('Not enough Coins — use CLICK TO EARN or Rewards', 'bad');
    const pill = $('#coinsPill');
    pill.classList.remove('bump'); void pill.offsetWidth; pill.classList.add('bump');
    return false;
  }
  state.coins -= amount;
  return true;
}

// =========================================================
// CLICKER — 1 click = exactly 1 Coin, always
// =========================================================
function handleClick(e, btn) {
  addCoins(COINS_PER_CLICK);
  state.statistics.totalClicks++;

  btn.animate(
    [{ transform: 'scale(1)' }, { transform: 'scale(0.94)' }, { transform: 'scale(1.04)' }, { transform: 'scale(1)' }],
    { duration: 220, easing: 'ease-out' }
  );
  const r = btn.getBoundingClientRect();
  const x = e && e.clientX ? e.clientX : r.left + r.width / 2;
  const y = e && e.clientY ? e.clientY : r.top + r.height / 2;
  FX.text(x, y - 18, `+${COINS_PER_CLICK} Coin`, '#ffd24d');
  FX.burst(x, y, { count: 6, colors: ['#ffd24d', '#ffb020', '#fff2b0'], speed: 4, size: 2.5, gravity: 0.2, life: 0.5 });
  Sound.click();

  updateHUD();
  scheduleSave();
}

// =========================================================
// INVENTORY
// =========================================================
function getInvItem(uid) { return state.inventory.find(i => i.uid === uid) || null; }

// Adds a skin item. Returns { item, firstTime }. XP and collection checks are done by callers.
function addSkin(id) {
  const skin = SKIN_BY_ID[id];
  if (!skin) return null;
  const item = { uid: state.nextUid++, id, obtainedAt: Date.now() };
  state.inventory.push(item);
  ui.newUids.add(item.uid);
  const firstTime = !state.collections.discovered.includes(skin.skinId);
  if (firstTime) state.collections.discovered.push(skin.skinId);
  if (!state.highestSkin || !SKIN_BY_ID[state.highestSkin] || skin.value > SKIN_BY_ID[state.highestSkin].value) state.highestSkin = id;
  return { item, firstTime };
}

function grantSkinXP(firstTime) {
  addXP(XP_REWARDS.newSkin + (firstTime ? XP_REWARDS.firstDiscovery : 0));
}

function removeSkin(uid) {
  const idx = state.inventory.findIndex(i => i.uid === uid);
  if (idx >= 0) state.inventory.splice(idx, 1);
}

function inventoryValue() {
  return state.inventory.reduce((sum, i) => sum + SKIN_BY_ID[i.id].value, 0);
}

function sellPrice(skin) { return Math.max(1, Math.floor(skin.value * ECONOMY.sellRate)); }

function sellSkin(uid) {
  const item = getInvItem(uid);
  if (!item) return;
  const skin = SKIN_BY_ID[item.id];
  const coins = sellPrice(skin);
  removeSkin(uid);
  if (state.selection.sourceUid === uid) state.selection.sourceUid = null;
  addCoins(coins);
  state.statistics.skinsSold++;
  trackMission('sells', 1);
  Sound.coin();
  toast(`Sold ${escapeHTML(skin.fullName)} for ${coinsHTML(coins)}`, 'good');
  updateHUD();
  renderInventory();
  saveGame();
}

function sortedInventory(items, sort) {
  return items.slice().sort((a, b) => {
    const sa = SKIN_BY_ID[a.id], sb = SKIN_BY_ID[b.id];
    if (sort === 'cheapest') return sa.value - sb.value;
    if (sort === 'rarity') return rarityRank(sb) - rarityRank(sa) || sb.value - sa.value;
    if (sort === 'newest') return b.obtainedAt - a.obtainedAt || b.uid - a.uid;
    return sb.value - sa.value;
  });
}

function filteredInventory() {
  const q = ui.invQuery.trim().toLowerCase();
  return sortedInventory(state.inventory.filter(i => {
    const s = SKIN_BY_ID[i.id];
    return (ui.invType === 'all' || s.type === ui.invType)
      && (ui.invWeapon === 'all' || s.weapon === ui.invWeapon)
      && (ui.invRarity === 'all' || s.rarity === ui.invRarity)
      && (ui.invCondition === 'all' || s.condition === ui.invCondition)
      && matchesQuery(s, q);
  }), ui.invSort);
}

function renderInventory() {
  const el = $('#screen-inventory');
  const owned = state.inventory.map(i => SKIN_BY_ID[i.id]);
  const weapons = [...new Set(owned.filter(s => ui.invType === 'all' || s.type === ui.invType).map(s => s.weapon))].sort();
  if (ui.invWeapon !== 'all' && !weapons.includes(ui.invWeapon)) ui.invWeapon = 'all';
  const rarities = Object.keys(RARITIES).filter(r => owned.some(s => s.rarity === r));
  const conditions = Object.values(CONDITIONS);
  const option = (v, label, cur) => `<option value="${escapeHTML(v)}" ${v === cur ? 'selected' : ''}>${escapeHTML(label)}</option>`;

  el.innerHTML = `
    <div class="screen-head">
      <h2>INVENTORY</h2>
      <div class="inv-summary"><span>Items: <b>${state.inventory.length}</b></span><span>Value: ${coinsHTML(inventoryValue())}</span></div>
    </div>
    <div class="glass filters">
      <input class="search" type="search" placeholder="Search your skins" value="${escapeHTML(ui.invQuery)}" data-input="inv-search" autocomplete="off">
      <div class="chips">${typeChips('inv-type', ui.invType)}</div>
      <div class="filter-row">
        <select class="select" data-change="inv-weapon" aria-label="Weapon">${option('all', 'All weapons', ui.invWeapon)}${weapons.map(w => option(w, w, ui.invWeapon)).join('')}</select>
        <select class="select" data-change="inv-rarity" aria-label="Rarity">${option('all', 'All rarities', ui.invRarity)}${rarities.map(r => option(r, r, ui.invRarity)).join('')}</select>
        <select class="select" data-change="inv-condition" aria-label="Condition">${option('all', 'All conditions', ui.invCondition)}${conditions.map(c => option(c, c, ui.invCondition)).join('')}</select>
      </div>
      <div class="toolbar">
        <span class="sort-label">SORT</span>
        <div class="chips">${INV_SORTS.map(([v, l]) => `<button class="chip ${ui.invSort === v ? 'active' : ''}" data-action="inv-sort" data-value="${v}">${l}</button>`).join('')}</div>
      </div>
    </div>
    <div id="invGrid"></div>`;
  renderInventoryGrid();
}

function renderInventoryGrid() {
  const grid = $('#invGrid');
  if (!grid) return;
  const items = filteredInventory();
  const shown = items.slice(0, ui.invLimit);
  grid.innerHTML = shown.length ? `
    <div class="skin-grid">${shown.map(inventoryCardHTML).join('')}</div>
    ${items.length > shown.length ? `<button class="btn btn-ghost btn-block more-btn" data-action="inv-more">SHOW MORE (${items.length - shown.length})</button>` : ''}` : `
    <div class="glass empty"><div class="big">🎒</div>${state.inventory.length ? 'No skins match these filters.' : 'Your inventory is empty.<br>Open a Free Drop, claim your Daily Reward or buy a skin in the Shop.'}
    <div style="margin-top:14px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap"><button class="btn btn-gold" data-action="nav" data-value="rewards">🎁 REWARDS</button><button class="btn btn-ghost" data-action="nav" data-value="shop">🛒 SHOP</button></div></div>`;
  ui.newUids.clear();
}

function skinMetaHTML(s) {
  return `<div class="sc-meta"><span class="cond-tag">${s.condition}</span><span class="rarity-tag">${rarityLabel(s)}</span></div>`;
}

function inventoryCardHTML(item) {
  const s = SKIN_BY_ID[item.id];
  const selected = item.uid === state.selection.sourceUid;
  return `<div class="skin-card selectable ${selected ? 'selected' : ''}" style="--rc:${rarityColor(s)}" data-action="inv-select" data-value="${item.uid}">
    ${ui.newUids.has(item.uid) ? '<span class="new-dot">NEW</span>' : ''}
    ${selected ? '<span class="sel-dot">CURRENT</span>' : ''}
    ${skinImageHTML(s)}
    <div class="sc-name">${escapeHTML(s.fullName)}</div>
    ${skinMetaHTML(s)}
    <div class="sc-value">${coinsHTML(s.value)}</div>
    <div class="sc-actions">
      <button class="btn btn-gold" data-action="inv-upgrade" data-value="${item.uid}">UPGRADE</button>
      <button class="btn btn-ghost btn-sell" data-action="inv-sell" data-value="${item.uid}">SELL<small><i class="coin"></i>${fmt(sellPrice(s))}</small></button>
    </div>
  </div>`;
}

// =========================================================
// SHOP
// =========================================================
function shopPrice(skin) { return skin.value; }

function buySkin(id) {
  const skin = SKIN_BY_ID[id];
  if (!skin) return;
  if (skin.value >= SHOP_TIERS[SHOP_TIERS.length - 1].max) return;
  if (!spendCoins(shopPrice(skin))) return;
  const { firstTime } = addSkin(id);
  state.statistics.skinsBought++;
  trackMission('buys', 1);
  grantSkinXP(firstTime);
  checkCollections();
  Sound.purchase();
  toast(`✅ ${escapeHTML(skin.fullName)} (${skin.condition}) added to Inventory`, 'good');
  const btn = document.querySelector(`[data-action="shop-buy"][data-value="${id}"]`);
  if (btn) {
    const r = btn.getBoundingClientRect();
    FX.burst(r.left + r.width / 2, r.top, { count: 16, colors: [rarityColor(skin), '#ffffff', '#ffd24d'], speed: 6, size: 3, life: 0.8 });
  }
  updateHUD();
  saveGame();
}

function shopItems() {
  const tier = SHOP_TIERS.find(t => t.id === ui.shopTier) || SHOP_TIERS[0];
  const q = ui.shopQuery.trim().toLowerCase();
  const maxPrice = SHOP_TIERS[SHOP_TIERS.length - 1].max;
  // a search looks through every price tier
  const inPriceRange = s => q ? s.value < maxPrice : (s.value >= tier.min && s.value < tier.max);
  return SKINS_BY_VALUE.filter(s => inPriceRange(s) && (ui.shopType === 'all' || s.type === ui.shopType) && matchesQuery(s, q));
}

function renderShop() {
  $('#screen-shop').innerHTML = `
    <div class="screen-head"><h2>SHOP</h2><div class="hud-pill coins-pill"><i class="coin"></i><span class="num" id="shopCoins">${fmt(state.coins)}</span><span class="lbl">Coins</span></div></div>
    <div class="glass filters">
      <input class="search" type="search" placeholder="Search skins, e.g. AK-47 Redline" value="${escapeHTML(ui.shopQuery)}" data-input="shop-search" autocomplete="off">
      <div class="chips">${SHOP_TIERS.map(t => `<button class="chip ${t.id === ui.shopTier ? 'active' : ''}" data-action="shop-tier" data-value="${t.id}">${t.label}</button>`).join('')}</div>
      <div class="chips">${typeChips('shop-type', ui.shopType)}</div>
      <p class="shop-note">Real CS2 skins at real market value in Coins. Skins from ${coinsHTML(SHOP_TIERS[SHOP_TIERS.length - 1].max)} can only be won in the Upgrader.</p>
    </div>
    <div id="shopGrid"></div>`;
  renderShopGrid();
}

function renderShopGrid() {
  const items = shopItems();
  const shown = items.slice(0, ui.shopLimit);
  $('#shopGrid').innerHTML = shown.length ? `
    <div class="result-count">${fmt(items.length)} skins${ui.shopQuery.trim() ? ' · searching all price tiers' : ''}</div>
    <div class="skin-grid">${shown.map(s => {
      const price = shopPrice(s);
      return `<div class="skin-card" style="--rc:${rarityColor(s)}">
        ${skinImageHTML(s)}
        <div class="sc-name">${escapeHTML(s.fullName)}</div>
        ${skinMetaHTML(s)}
        <div class="sc-actions one">
          <button class="btn btn-gold btn-buy ${state.coins < price ? 'cant' : ''}" data-action="shop-buy" data-value="${s.id}" data-cost="${price}">BUY <i class="coin"></i>${fmt(price)}</button>
        </div>
      </div>`;
    }).join('')}</div>
    ${items.length > shown.length ? `<button class="btn btn-ghost btn-block more-btn" data-action="shop-more">SHOW MORE (${fmt(items.length - shown.length)})</button>` : ''}`
    : `<div class="glass empty"><div class="big">🔍</div>No skins found.</div>`;
}

// =========================================================
// UPGRADER
// =========================================================
function getSourceSkin() {
  const item = getInvItem(state.selection.sourceUid);
  return item ? SKIN_BY_ID[item.id] : null;
}
function getTargetSkin() { return SKIN_BY_ID[state.selection.targetId] || null; }

function validateUpgradeSelection() {
  if (state.selection.sourceUid !== null && !getInvItem(state.selection.sourceUid)) state.selection.sourceUid = null;
  if (state.selection.targetId !== null && !SKIN_BY_ID[state.selection.targetId]) state.selection.targetId = null;
  const src = getSourceSkin(), tgt = getTargetSkin();
  if (src && tgt && tgt.value <= src.value) state.selection.targetId = null;
}

function slotHTML(kind, label, skin, hint) {
  return `<div class="slot slot-${kind} ${skin ? 'filled' : ''}" data-action="scroll-to" data-value="${kind === 'current' ? 'sourcePicker' : 'targetPicker'}">
    <div class="slot-label">${label}</div>
    ${skin ? `
      ${skinImageHTML(skin)}
      <div class="slot-info">
        <div class="slot-name">${escapeHTML(skin.fullName)}</div>
        <div class="slot-meta">${skin.condition} · <span class="rarity-tag" style="--rc:${rarityColor(skin)}">${rarityLabel(skin)}</span></div>
        <div class="slot-value">${coinsHTML(skin.value)}</div>
      </div>`
      : `<div class="slot-empty"><span class="plus">＋</span><span>${hint}</span></div>`}
  </div>`;
}

function targetCandidates(src) {
  if (!src) return [];
  const bucket = TARGET_BUCKETS.find(b => b.id === ui.targetBucket) || TARGET_BUCKETS[0];
  const q = ui.targetQuery.trim().toLowerCase();
  return SKINS_BY_VALUE.filter(s => {
    if (s.value <= src.value) return false;
    const m = s.value / src.value;
    return m > bucket.min && m <= bucket.max
      && (ui.targetType === 'all' || s.type === ui.targetType)
      && matchesQuery(s, q);
  });
}

function currentChance() {
  const src = getSourceSkin(), tgt = getTargetSkin();
  return src && tgt ? calculateChance(src, tgt) : null;
}

function renderUpgrader() {
  validateUpgradeSelection();
  const el = $('#screen-upgrade');
  const src = getSourceSkin(), tgt = getTargetSkin();
  const chance = currentChance();   // the ONE value used for the UI text and the wheel sector

  el.classList.toggle('spinning', ui.spinning);
  el.innerHTML = `
    <section class="upgrade-zone">
      <div class="zone-head">
        <h2>UPGRADE</h2>
        <div class="streak-pill ${state.winStreak > 0 ? 'hot' : ''}">🔥 WIN STREAK <b>${state.winStreak}</b></div>
      </div>
      <div class="stage">
        ${slotHTML('current', 'CURRENT SKIN', src, 'Choose a skin from your inventory')}
        <div class="stage-chance">
          <div class="cl">UPGRADE CHANCE</div>
          <div class="chance-val" id="chanceVal">${chance !== null ? fmtPercent(chance) : '—'}</div>
          <div class="chance-sub">${chance !== null ? `${coinsHTML(src.value)} → ${coinsHTML(tgt.value)} · x${(tgt.value / src.value).toFixed(2)}` : 'Select current and target skins'}</div>
        </div>
        <div class="wheel-wrap" id="wheelWrap">
          <canvas id="wheelCanvas" aria-label="Upgrade wheel"></canvas>
          <div class="pointer" id="pointer" aria-hidden="true">
            <svg viewBox="0 0 100 100"><defs><linearGradient id="pg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#ffd24d"/></linearGradient></defs>
              <polygon points="50,3 56,17 52.2,17 52.2,36 47.8,36 47.8,17 44,17" fill="url(#pg)" stroke="#1c1203" stroke-width="0.8" stroke-linejoin="round"/></svg>
          </div>
          <div class="hub"><b id="hubChance">${chance !== null ? fmtPercent(chance) : '—'}</b><small id="hubLabel">CHANCE</small></div>
        </div>
        ${slotHTML('target', 'TARGET SKIN', tgt, src ? 'Choose a more expensive skin' : 'Pick your current skin first')}
      </div>
      <button class="btn-upgrade" id="upgradeBtn" data-action="upgrade" ${chance !== null && !ui.spinning ? '' : 'disabled'}>UPGRADE</button>
      <div class="clicker-mini">
        <div class="cm-coins"><span class="cm-label">COINS</span><span class="cm-value num" id="clickerCoins">${fmt(state.coins)}</span></div>
        <button class="cm-btn" data-clicker aria-label="Click to earn 1 Coin">CLICK TO EARN <small>+1 Coin</small></button>
      </div>
    </section>

    <div class="pickers">
      <div class="glass picker" id="sourcePicker">
        <div class="picker-head"><h3>YOUR INVENTORY</h3><span class="muted small">${state.inventory.length} skins · ${coinsHTML(inventoryValue())}</span></div>
        <input class="search" type="search" placeholder="Search your skins" value="${escapeHTML(ui.sourceQuery)}" data-input="source-search" autocomplete="off">
        <div id="sourceGrid"></div>
      </div>
      <div class="glass picker" id="targetPicker">
        <div class="picker-head"><h3>TARGET SKINS</h3><span class="muted small">must cost more than current</span></div>
        ${src ? `
          <input class="search" type="search" placeholder="Search target, e.g. AWP Asiimov" value="${escapeHTML(ui.targetQuery)}" data-input="target-search" autocomplete="off">
          <div class="chips">${TARGET_BUCKETS.map(b => `<button class="chip chip-sm ${b.id === ui.targetBucket ? 'active' : ''}" data-action="target-bucket" data-value="${b.id}">${b.label}</button>`).join('')}</div>
          <div class="chips">${typeChips('target-type', ui.targetType)}</div>
          <div id="targetGrid"></div>`
        : `<div class="empty">Select your current skin first — targets must be more expensive.</div>`}
      </div>
    </div>`;

  renderSourceGrid();
  if (src) renderTargetGrid();
  Wheel.attach($('#wheelCanvas'), $('#wheelWrap'), $('#pointer'));
  if (!ui.spinning) Wheel.setChance(chance);
}

function pickCardHTML(s, action, value, selected, extra = '') {
  return `<button class="pick-card ${selected ? 'selected' : ''}" style="--rc:${rarityColor(s)}" data-action="${action}" data-value="${value}">
    ${extra}${skinImageHTML(s)}<span class="pc-name">${escapeHTML(s.fullName)}</span><span class="pc-cond">${s.condition}</span><span class="pc-val">${coinsHTML(s.value)}</span></button>`;
}

function renderSourceGrid() {
  const grid = $('#sourceGrid');
  if (!grid) return;
  const q = ui.sourceQuery.trim().toLowerCase();
  const items = sortedInventory(state.inventory, 'expensive').filter(i => matchesQuery(SKIN_BY_ID[i.id], q));
  grid.innerHTML = items.length
    ? `<div class="pick-grid">${items.map(i => pickCardHTML(SKIN_BY_ID[i.id], 'pick-source', i.uid, i.uid === state.selection.sourceUid)).join('')}</div>`
    : `<div class="empty">${state.inventory.length ? 'No skins found.' : 'No skins yet.'} <button class="btn btn-gold" data-action="nav" data-value="rewards" style="margin-left:8px">🎁 GET A FREE SKIN</button></div>`;
}

function renderTargetGrid() {
  const grid = $('#targetGrid');
  const src = getSourceSkin();
  if (!grid || !src) return;
  const targets = targetCandidates(src);
  const shown = targets.slice(0, ui.targetLimit);
  grid.innerHTML = shown.length ? `
    <div class="result-count">${fmt(targets.length)} possible targets</div>
    <div class="pick-grid">${shown.map(s => pickCardHTML(s, 'pick-target', s.id, s.id === state.selection.targetId,
      `<span class="pc-chance">${fmtPercent(calculateChance(src, s))}</span>`)).join('')}</div>
    ${targets.length > shown.length ? `<button class="btn btn-ghost btn-block more-btn" data-action="target-more">SHOW MORE (${fmt(targets.length - shown.length)})</button>` : ''}`
    : `<div class="empty">No targets match these filters.</div>`;
}

function startUpgrade() {
  if (ui.spinning) return;
  const srcItem = getInvItem(state.selection.sourceUid);
  const current = srcItem ? SKIN_BY_ID[srcItem.id] : null;
  const target = getTargetSkin();
  if (!current || !target) { toast('Select your current skin and a target first', 'bad'); return; }
  if (target.value <= current.value) { toast('Target must be more expensive', 'bad'); return; }

  // 1. chance (same clamped value that the UI and the wheel show)
  const clampedChance = calculateChance(current, target);
  // 2. ONE RNG roll — the only thing that decides the outcome
  const success = Math.random() < clampedChance;
  // 3. final pointer angle inside the matching sector
  const targetAngle = getSafeAngleInsideResultSector(success, clampedChance);

  const result = { success, chance: clampedChance, fromUid: srcItem.uid, fromId: current.id, toId: target.id, newUid: null, firstTime: false };
  // Inventory is resolved and saved before the animation, so reloading mid-spin cannot dodge a loss.
  resolveUpgradeInventory(result);
  saveGame();

  // 4. lock UI
  ui.spinning = true;
  ui.lastResult = result;
  $('#screen-upgrade').classList.add('spinning');
  $('#upgradeBtn').disabled = true;
  Wheel.setChance(clampedChance);
  Wheel.setGlow(null);

  // 5. the arrow only visualises the predetermined result
  Sound.spinStart();
  animatePointer(targetAngle, () => finishUpgrade(result));
}

function resolveUpgradeInventory(result) {
  const st = state.statistics;
  removeSkin(result.fromUid);
  st.totalUpgrades++;
  if (result.success) {
    const added = addSkin(result.toId);
    result.newUid = added.item.uid;
    result.firstTime = added.firstTime;
    st.successfulUpgrades++;
    state.winStreak++;
    st.bestStreak = Math.max(st.bestStreak, state.winStreak);
    const tv = SKIN_BY_ID[result.toId].value;
    if (!st.highestUpgrade || tv > st.highestUpgrade.value) {
      st.highestUpgrade = { fromId: result.fromId, toId: result.toId, value: tv, chance: result.chance };
    }
  } else {
    st.failedUpgrades++;
    state.winStreak = 0;
  }
}

function finishUpgrade(result) {
  ui.spinning = false;
  addXP(XP_REWARDS.upgrade);
  trackMission('upgrades', 1);
  if (result.success) {
    addXP(XP_REWARDS.upgradeWin);
    grantSkinXP(result.firstTime);
    trackMission('wins', 1);
    if (result.chance <= 0.25) trackMission('risky', 1);
    if (SKIN_BY_ID[result.toId].value >= 5000) trackMission('bigwin', 1);
    setMissionProgress('streak', state.winStreak);
    checkCollections();
    onUpgradeSuccess(result);
  } else {
    onUpgradeFail(result);
  }
  updateHUD();
  saveGame();
}

// =========================================================
// CHANCE CALCULATION
// =========================================================
function calculateChance(currentSkin, targetSkin) {
  if (!currentSkin || !targetSkin || targetSkin.value <= 0) return 0;
  const chance = currentSkin.value / targetSkin.value;
  return Math.max(MIN_CHANCE, Math.min(MAX_CHANCE, chance));
}

// =========================================================
// WHEEL — static circle with exactly two sectors. Only the arrow rotates.
// =========================================================
// SUCCESS = one continuous arc of exactly `chance * 360°`, centred at the top.
// FAIL    = the remaining continuous arc.
function getWheelSectors(chance) {
  const half = chance * Math.PI;
  return {
    success: { start: SUCCESS_CENTER - half, end: SUCCESS_CENTER + half },
    fail:    { start: SUCCESS_CENTER + half, end: SUCCESS_CENTER - half + TAU }
  };
}

// Safe angle strictly inside the result sector (never on a border).
function getSafeAngleInsideResultSector(success, chance) {
  const sector = getWheelSectors(chance)[success ? 'success' : 'fail'];
  const span = sector.end - sector.start;
  const margin = Math.min(span * 0.2, 0.12);
  return sector.start + margin + Math.random() * (span - 2 * margin);
}
const calculateTargetAngle = getSafeAngleInsideResultSector;

// Which sector a canvas angle points into
function sectorAtAngle(angle, chance) {
  const s = getWheelSectors(chance).success;
  let a = angle;
  while (a < s.start) a += TAU;
  while (a >= s.start + TAU) a -= TAU;
  return a <= s.end ? 'success' : 'fail';
}

const Wheel = {
  canvas: null, ctx: null, wrap: null, pointer: null, size: 0, dpr: 1,
  chance: null, glow: null,
  pointerAngle: -Math.PI / 2,   // direction the arrow points to (canvas angle), starts at the top

  attach(canvas, wrap, pointer) {
    this.canvas = canvas; this.wrap = wrap; this.pointer = pointer;
    this.ctx = canvas.getContext('2d');
    this.applyPointer();
    this.resize();
    if (this.glow) wrap.classList.add(this.glow);
  },
  resize() {
    if (!this.canvas || !this.canvas.isConnected) return;
    const css = this.canvas.clientWidth || 320;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.size = css;
    this.canvas.width = Math.round(css * this.dpr);
    this.canvas.height = Math.round(css * this.dpr);
    this.draw();
  },
  setChance(chance) { this.chance = chance; this.updateHub(); this.draw(); },
  setGlow(kind) {
    this.glow = kind;
    if (this.wrap) { this.wrap.classList.remove('win', 'lose'); if (kind) this.wrap.classList.add(kind); }
    this.updateHub();
    this.draw();
  },
  // Only the arrow element is rotated. The arrow is drawn pointing up (-90°).
  applyPointer() {
    if (this.pointer) this.pointer.style.transform = `rotate(${(this.pointerAngle + Math.PI / 2) * 180 / Math.PI}deg)`;
  },
  updateHub() {
    const v = $('#hubChance'), l = $('#hubLabel');
    if (!v || !l) return;
    if (this.glow === 'win') { v.textContent = 'SUCCESS'; l.textContent = 'NEW SKIN'; }
    else if (this.glow === 'lose') { v.textContent = 'FAIL'; l.textContent = 'SKIN LOST'; }
    else { v.textContent = this.chance !== null ? fmtPercent(this.chance) : '—'; l.textContent = 'CHANCE'; }
    v.parentNode.className = 'hub' + (this.glow ? ' ' + this.glow : '');
  },

  draw() {
    const ctx = this.ctx; if (!ctx || !this.size) return;
    const size = this.size, c = size / 2, R = c - 10, inner = R * 0.6;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    // frame
    const ringColor = this.glow === 'win' ? '#22e58b' : this.glow === 'lose' ? '#ff3b5c' : '#ffb020';
    ctx.save();
    ctx.beginPath(); ctx.arc(c, c, R + 5, 0, TAU);
    ctx.strokeStyle = ringColor; ctx.lineWidth = 3; ctx.shadowColor = ringColor; ctx.shadowBlur = 22; ctx.stroke();
    ctx.restore();
    ctx.beginPath(); ctx.arc(c, c, R + 1, 0, TAU); ctx.fillStyle = '#0b0d18'; ctx.fill();

    const ring = (a0, a1, fill) => {
      ctx.beginPath(); ctx.arc(c, c, R, a0, a1); ctx.arc(c, c, inner, a1, a0, true); ctx.closePath();
      ctx.fillStyle = fill; ctx.fill();
    };

    if (this.chance === null || this.chance === undefined) {
      ring(0, TAU, '#1a1d33');
    } else {
      const { success, fail } = getWheelSectors(this.chance);
      const winGrad = ctx.createRadialGradient(c, c, inner, c, c, R);
      winGrad.addColorStop(0, '#0d8f52'); winGrad.addColorStop(1, '#34f7a0');
      const failGrad = ctx.createRadialGradient(c, c, inner, c, c, R);
      failGrad.addColorStop(0, '#5a0d1d'); failGrad.addColorStop(1, '#d42546');
      ring(fail.start, fail.end, failGrad);
      ring(success.start, success.end, winGrad);

      // borders between the two sectors
      ctx.strokeStyle = '#07080f'; ctx.lineWidth = 3;
      for (const a of [success.start, success.end]) {
        ctx.beginPath(); ctx.moveTo(c + Math.cos(a) * inner, c + Math.sin(a) * inner); ctx.lineTo(c + Math.cos(a) * R, c + Math.sin(a) * R); ctx.stroke();
      }
      // labels in the middle of each sector
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `900 ${Math.max(10, Math.round(size * 0.04))}px ${FONT}`;
      const labelR = (R + inner) / 2;
      const label = (sector, text, color, minSpan) => {
        if (sector.end - sector.start < minSpan) return;
        const mid = (sector.start + sector.end) / 2;
        ctx.save();
        ctx.translate(c + Math.cos(mid) * labelR, c + Math.sin(mid) * labelR);
        ctx.rotate(mid + Math.PI / 2 + (Math.sin(mid) > 0 ? Math.PI : 0));
        ctx.fillStyle = color; ctx.fillText(text, 0, 0);
        ctx.restore();
      };
      label(success, 'SUCCESS', 'rgba(2,38,20,0.9)', 0.55);
      label(fail, 'FAIL', 'rgba(255,225,230,0.85)', 0.3);
    }
    // ticks
    ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.lineWidth = 1.5;
    for (let i = 0; i < 100; i++) {
      const a = i / 100 * TAU, len = i % 10 === 0 ? 9 : 4;
      ctx.beginPath(); ctx.moveTo(c + Math.cos(a) * (R - len), c + Math.sin(a) * (R - len)); ctx.lineTo(c + Math.cos(a) * R, c + Math.sin(a) * R); ctx.stroke();
    }
  }
};

function easeSpin(t) {
  // short acceleration ramp, then a long smooth deceleration
  const r = Math.min(1, t / 0.08);
  const ramp = r * r * (3 - 2 * r);
  return (1 - Math.pow(1 - t, 3.6)) * ramp;
}

// Rotates ONLY the arrow to `targetAngle` (+ POINTER_TURNS full turns). Fully deterministic: no RNG here.
function animatePointer(targetAngle, onDone) {
  const startAngle = Wheel.pointerAngle;
  let finalAngle = targetAngle;
  finalAngle += Math.ceil((startAngle + POINTER_TURNS * TAU - finalAngle) / TAU) * TAU;

  const duration = POINTER_SPIN_MS;
  const t0 = performance.now();
  const tickStep = TAU / 24;
  let lastTick = Math.floor(startAngle / tickStep);

  function frame(now) {
    const t = Math.min(1, (now - t0) / duration);
    Wheel.pointerAngle = startAngle + (finalAngle - startAngle) * easeSpin(t);
    Wheel.applyPointer();
    const tick = Math.floor(Wheel.pointerAngle / tickStep);
    if (tick !== lastTick) { lastTick = tick; Sound.tick(); }
    if (t < 1) { requestAnimationFrame(frame); return; }
    Wheel.pointerAngle = ((finalAngle % TAU) + TAU) % TAU;
    Wheel.applyPointer();
    Sound.stop();
    Wheel.setGlow(sectorAtAngle(Wheel.pointerAngle, Wheel.chance) === 'success' ? 'win' : 'lose');
    onDone();
  }
  requestAnimationFrame(frame);
}

function wheelCenterOnScreen() {
  const c = $('#wheelCanvas');
  if (c && c.isConnected && ui.tab === 'upgrade') {
    const r = c.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  return { x: innerWidth / 2, y: innerHeight / 2 };
}

function flashScreen(kind) {
  const f = $('#flash');
  f.className = 'flash'; void f.offsetWidth; f.className = 'flash ' + kind;
}

function resultSkinHTML(skin, cls = '') {
  return `<div class="result-skin ${cls}">${skinImageHTML(skin)}
    <div class="rs-name">${escapeHTML(skin.fullName)}</div>
    <div class="rs-cond">${skin.condition}</div>
    <div class="rs-val">${coinsHTML(skin.value)}</div></div>`;
}

// =========================================================
// SUCCESS
// =========================================================
function onUpgradeSuccess(result) {
  const from = SKIN_BY_ID[result.fromId], to = SKIN_BY_ID[result.toId];
  const p = wheelCenterOnScreen();
  flashScreen('win');
  Sound.success();
  FX.burst(p.x, p.y, { count: 60, colors: ['#3cf5a0', '#22e58b', '#ffffff', '#ffe066'], speed: 9, size: 4, gravity: 0.12, life: 1.2 });
  FX.confetti(140);

  setTimeout(() => {
    openModal(`
      <div class="result-win">
        <div class="result-title">UPGRADE SUCCESS</div>
        <div class="result-label">CURRENT SKIN</div>
        ${resultSkinHTML(from, 'small')}
        <div class="result-arrow">↓</div>
        <div class="result-label win">NEW SKIN</div>
        ${resultSkinHTML(to)}
        <div class="profit">PROFIT<b>+${fmt(to.value - from.value)} Coins</b></div>
        <div class="result-actions one"><button class="btn btn-green" data-action="continue-win">CONTINUE</button></div>
      </div>`, { onClose: continueAfterWin });
  }, 650);
}

// The new skin becomes the current skin, ready for the next upgrade
function continueAfterWin() {
  const r = ui.lastResult;
  state.selection.sourceUid = r && r.newUid ? r.newUid : null;
  state.selection.targetId = null;
  ui.targetLimit = PAGE_SIZE;
  Wheel.setGlow(null);
  saveGame();
  if (ui.tab === 'upgrade') renderUpgrader();
}

// =========================================================
// FAIL
// =========================================================
function onUpgradeFail(result) {
  const from = SKIN_BY_ID[result.fromId];
  flashScreen('lose');
  Sound.fail();
  const app = $('#app');
  app.classList.remove('shake'); void app.offsetWidth; app.classList.add('shake');
  const p = wheelCenterOnScreen();
  FX.burst(p.x, p.y, { count: 40, colors: ['#ff3b5c', '#ff8a1f', '#3a0a14'], speed: 7, size: 4, gravity: 0.25, life: 0.9 });

  setTimeout(() => {
    openModal(`
      <div class="result-lose">
        <div class="result-title">UPGRADE FAILED</div>
        ${resultSkinHTML(from)}
        <div class="lost-tag">LOST</div>
        <div class="result-actions one"><button class="btn btn-red" data-action="continue-fail">CONTINUE</button></div>
      </div>`, { onClose: continueAfterFail });
  }, 700);
}

function continueAfterFail() {
  state.selection.sourceUid = null;
  Wheel.setGlow(null);
  saveGame();
  if (ui.tab === 'upgrade') renderUpgrader();
}

// =========================================================
// XP / LEVEL
// =========================================================
function xpForLevel(level) { return Math.round(100 * Math.pow(level, 1.5)); }

function addXP(amount) {
  state.xp += amount;
  let leveled = false;
  while (state.xp >= xpForLevel(state.level)) {
    state.xp -= xpForLevel(state.level);
    state.level++;
    leveled = true;
    onLevelUp();
  }
  if (leveled) saveGame();
}

function onLevelUp() {
  const reward = state.level * ECONOMY.levelUpCoinsPerLevel;
  addCoins(reward);
  Sound.levelUp();
  FX.confetti(90);
  Banner.show('LEVEL UP!', `Level ${state.level} · +${coinsText(reward)}`, 'levelup');
  updateHUD();
}

function renderXPCard() {
  const need = xpForLevel(state.level);
  $('#xpCard').innerHTML = `
    <div class="xp-top"><span class="xp-level">LEVEL ${state.level}</span><span class="xp-text num">${fmt(state.xp)} / ${fmt(need)} XP</span></div>
    <div class="bar"><i style="width:${(state.xp / need * 100).toFixed(1)}%"></i></div>
    <div class="xp-hint">Earn XP for upgrades, wins and new skins. Every level up gives Coins.</div>`;
}

// =========================================================
// MISSIONS
// =========================================================
function generateMissions(date) {
  const rnd = seededRandom(hashString('upgreded-' + date));
  const pool = MISSION_POOL.slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const picked = [], types = new Set();
  for (const m of pool) {
    if (types.has(m.type)) continue;
    types.add(m.type); picked.push({ ...m, progress: 0, done: false, claimed: false });
    if (picked.length === 3) break;
  }
  return picked;
}

function ensureMissions() {
  const today = todayStr();
  const validTypes = new Set(MISSION_POOL.map(m => m.type));
  if (state.missions.date !== today || !state.missions.list.length || state.missions.list.some(m => !validTypes.has(m.type))) {
    state.missions = { date: today, list: generateMissions(today) };
  }
}

function completeMissionIfDone(m) {
  if (!m.done && m.progress >= m.target) {
    m.done = true;
    toast(`📋 Mission complete: ${m.text} — claim it in Rewards!`, 'good', 3500);
    Sound.coin();
    saveGame();
  }
}

function trackMission(type, amount) {
  ensureMissions();
  for (const m of state.missions.list) {
    if (m.type !== type || m.done) continue;
    m.progress = Math.min(m.target, m.progress + amount);
    completeMissionIfDone(m);
  }
  if (ui.tab === 'rewards') renderMissions();
}

// For "reach X" missions (e.g. win streak)
function setMissionProgress(type, value) {
  ensureMissions();
  for (const m of state.missions.list) {
    if (m.type !== type || m.done) continue;
    m.progress = Math.min(m.target, Math.max(m.progress, value));
    completeMissionIfDone(m);
  }
}

function claimMission(index) {
  const m = state.missions.list[index];
  if (!m || !m.done || m.claimed) return;
  m.claimed = true;
  addCoins(m.coins);
  addXP(m.xp);
  Sound.purchase();
  toast(`Reward: ${coinsHTML(m.coins)} · ✨ ${m.xp} XP`, 'good');
  renderRewards();
  updateHUD();
  saveGame();
}

function renderMissions() {
  ensureMissions();
  $('#missionsCard').innerHTML = `
    <div class="card-head"><h3>📋 DAILY MISSIONS</h3><span class="muted small">Resets in <span id="msCountdown">${fmtDuration(msToMidnight())}</span></span></div>
    ${state.missions.list.map((m, i) => `
      <div class="mission ${m.done ? 'done' : ''}">
        <div class="m-top"><span>${m.text}</span><span class="mp num">${fmt(m.progress)} / ${fmt(m.target)}</span></div>
        <div class="bar ${m.done ? 'green' : ''}"><i style="width:${(m.progress / m.target * 100).toFixed(1)}%"></i></div>
        <div class="m-bottom">
          <span class="reward">${coinsHTML(m.coins)} · ✨ ${m.xp} XP</span>
          ${m.claimed ? '<span class="claimed-tag">✓ CLAIMED</span>' : m.done ? `<button class="btn btn-green" data-action="claim-mission" data-value="${i}">CLAIM</button>` : ''}
        </div>
      </div>`).join('')}`;
}

// =========================================================
// DAILY REWARD
// =========================================================
function checkDailyRewardStreak() {
  const dr = state.dailyReward;
  if (dr.lastClaim && dr.lastClaim !== todayStr() && dr.lastClaim !== yesterdayStr()) dr.day = 0; // missed a day
}
function canClaimDaily() { return state.dailyReward.lastClaim !== todayStr(); }

function showSkinRewardModal(title, skin, text) {
  openModal(`
    <div class="result-title" style="color:var(--gold)">${title}</div>
    ${resultSkinHTML(skin)}
    <p class="modal-text">${text}</p>
    <div class="result-actions">
      <button class="btn btn-ghost" data-action="close-modal">OK</button>
      <button class="btn btn-gold" data-action="upgrade-uid" data-value="${ui.lastRewardUid}">UPGRADE IT</button>
    </div>`);
}

function claimDailyReward() {
  if (!canClaimDaily()) return;
  const dr = state.dailyReward;
  const reward = DAILY_REWARDS[dr.day];
  const dayNum = dr.day + 1;
  dr.lastClaim = todayStr();
  dr.day = (dr.day + 1) % DAILY_REWARDS.length;

  if (reward.skin) {
    const skin = randomPick(skinsInRange(reward.minValue, reward.maxValue));
    const { item, firstTime } = addSkin(skin.id);
    ui.lastRewardUid = item.uid;
    grantSkinXP(firstTime);
    checkCollections();
    Sound.success();
    FX.confetti(120);
    showSkinRewardModal(`🎁 DAY ${dayNum} REWARD`, skin, 'A rare skin was added to your inventory!');
  } else {
    addCoins(reward.coins);
    Sound.coin();
    const btn = $('[data-action="claim-daily"]');
    if (btn) { const r = btn.getBoundingClientRect(); FX.burst(r.left + r.width / 2, r.top, { count: 30, colors: ['#ffd24d', '#ffb020', '#fff'], speed: 7, size: 4, life: 1 }); }
    toast(`🎁 Day ${dayNum}: +${coinsHTML(reward.coins)}`, 'good');
  }
  renderRewards();
  updateHUD();
  saveGame();
}

function renderDailyReward() {
  const dr = state.dailyReward;
  const ready = canClaimDaily();
  const claimedCount = (!ready && dr.day === 0) ? 7 : dr.day;
  $('#dailyRewardCard').innerHTML = `
    <div class="card-head"><h3>🎁 DAILY REWARD</h3><span class="muted small">Day ${Math.min(claimedCount + (ready ? 1 : 0), 7)} / 7</span></div>
    <div class="daily-grid">${DAILY_REWARDS.map((r, i) => {
      const cls = i < claimedCount ? 'claimed' : (i === dr.day && ready ? 'current ready' : '');
      return `<div class="day-tile ${cls} ${r.skin ? 'big' : ''}">
        <span class="dn">DAY ${i + 1}</span><span class="di">${i < claimedCount ? '✓' : r.skin ? '🎲' : '<i class="coin"></i>'}</span>
        <span class="dv">${r.skin ? 'SKIN' : fmt(r.coins)}</span></div>`;
    }).join('')}</div>
    ${ready ? `<button class="btn btn-gold btn-block" data-action="claim-daily">CLAIM DAY ${dr.day + 1}</button>`
      : `<div class="muted small" style="text-align:center;font-weight:700">Next reward in <span id="drCountdown">${fmtDuration(msToMidnight())}</span> · miss a day and the streak restarts</div>`}`;
}

// =========================================================
// FREE DROP
// =========================================================
function isBroke() { return state.inventory.length === 0 && state.coins < ECONOMY.freeDrop.brokeCoins; }
function freeDropMsLeft() {
  return Math.max(0, state.freeDrop.lastClaim + ECONOMY.freeDrop.cooldownHours * 3600000 - Date.now());
}
function freeDropReady() { return isBroke() || freeDropMsLeft() === 0; }

function claimFreeDrop() {
  if (!freeDropReady()) return;
  const cfg = ECONOMY.freeDrop;
  const skin = randomPick(skinsInRange(cfg.minValue, cfg.maxValue));
  const { item, firstTime } = addSkin(skin.id);
  ui.lastRewardUid = item.uid;
  state.freeDrop.lastClaim = Date.now();
  state.statistics.freeDrops++;
  grantSkinXP(firstTime);
  checkCollections();
  Sound.success();
  FX.confetti(70);
  showSkinRewardModal('🎁 FREE DROP', skin, `Next free drop in ${ECONOMY.freeDrop.cooldownHours} hours.`);
  renderRewards();
  updateHUD();
  saveGame();
}

function renderFreeDrop() {
  const ready = freeDropReady();
  $('#freeDropCard').innerHTML = `
    <div class="card-head"><h3>🎁 FREE DROP</h3><span class="muted small">Every ${ECONOMY.freeDrop.cooldownHours}h</span></div>
    <p class="muted small" style="font-weight:700;margin-bottom:10px">A random real CS2 skin worth ${fmt(ECONOMY.freeDrop.minValue)}–${fmt(ECONOMY.freeDrop.maxValue)} Coins.</p>
    ${ready ? `<button class="btn btn-green btn-block" data-action="free-drop">OPEN FREE DROP</button>`
      : `<button class="btn btn-ghost btn-block" disabled>Next drop in <span id="fdCountdown">${fmtDuration(freeDropMsLeft())}</span></button>`}`;
}

function renderRewards() {
  renderFreeDrop();
  renderDailyReward();
  renderMissions();
  renderXPCard();
}

// =========================================================
// COLLECTIONS
// =========================================================
function collectionProgress(col) {
  return col.skins.filter(id => state.collections.discovered.includes(id)).length;
}

// cheapest available condition of a base skin (for collection previews)
function representativeItem(skinId) {
  return SKINS_BY_VALUE.find(s => s.skinId === skinId) || null;
}

function checkCollections() {
  for (const col of COLLECTIONS) {
    if (state.collections.completed.includes(col.id)) continue;
    if (collectionProgress(col) >= col.skins.length) {
      state.collections.completed.push(col.id);
      addCoins(col.reward.coins);
      addXP(col.reward.xp);
      Sound.levelUp();
      FX.confetti(120);
      Banner.show('COLLECTION COMPLETE!', `${col.icon} ${col.name} · Badge: ${col.badge} · +${coinsText(col.reward.coins)}`, 'collection');
      saveGame();
    }
  }
}

function renderCollectionsHTML() {
  return COLLECTIONS.map(col => {
    const done = state.collections.completed.includes(col.id);
    const prog = collectionProgress(col);
    return `<div class="coll ${done ? 'complete' : ''}">
      <div class="coll-top"><span>${col.icon} ${col.name}</span><span class="cc num">${done ? '✓ ' : ''}${prog} / ${col.skins.length}</span></div>
      <div class="bar ${done ? 'green' : ''}"><i style="width:${prog / col.skins.length * 100}%"></i></div>
      <div class="coll-items">${col.skins.map(id => {
        const s = representativeItem(id);
        return s ? `<div title="${escapeHTML(s.fullName)}">${skinImageHTML(s, state.collections.discovered.includes(id) ? '' : 'missing')}</div>` : '';
      }).join('')}</div>
      <div class="coll-reward">Any condition counts · Reward: ${coinsHTML(col.reward.coins)} · ✨ ${fmt(col.reward.xp)} XP · 🏅 ${col.badge}</div>
    </div>`;
  }).join('');
}

// =========================================================
// PROFILE
// =========================================================
function renderProfile() {
  const st = state.statistics;
  const need = xpForLevel(state.level);
  const best = state.highestSkin ? SKIN_BY_ID[state.highestSkin] : null;
  const hu = st.highestUpgrade && SKIN_BY_ID[st.highestUpgrade.toId] ? st.highestUpgrade : null;
  const badges = COLLECTIONS.filter(c => state.collections.completed.includes(c.id));
  const winRate = st.totalUpgrades ? (st.successfulUpgrades / st.totalUpgrades * 100).toFixed(1) + '%' : '—';
  const stats = [
    ['Total Clicks', fmt(st.totalClicks)], ['Total Upgrades', fmt(st.totalUpgrades)],
    ['Successful', fmt(st.successfulUpgrades)], ['Failed', fmt(st.failedUpgrades)],
    ['Win Rate', winRate], ['Win Streak', `${state.winStreak} <span class="muted small">(best ${st.bestStreak})</span>`],
    ['Inventory Value', `${fmt(inventoryValue())} <span class="muted small">Coins</span>`],
    ['Collections', `${state.collections.completed.length} / ${COLLECTIONS.length}`],
    ['Coins Earned', fmt(st.coinsEarned)], ['Skins Bought', fmt(st.skinsBought)],
    ['Free Drops', fmt(st.freeDrops)], ['Skins Discovered', `${state.collections.discovered.length} / ${SKIN_CATALOG.length + CUSTOM_SKINS.length}`]
  ];

  $('#screen-profile').innerHTML = `
    <div class="screen-head"><h2>PROFILE</h2></div>
    <div class="glass profile-head">
      <div class="avatar">${state.level}</div>
      <div class="ph-info">
        <div class="ph-level">LEVEL ${state.level}</div>
        <div class="bar"><i style="width:${(state.xp / need * 100).toFixed(1)}%"></i></div>
        <div class="muted small" style="margin-top:6px;font-weight:700">${fmt(state.xp)} / ${fmt(need)} XP</div>
        ${badges.length ? `<div class="badges">${badges.map(b => `<span class="badge">${b.icon} ${b.badge}</span>`).join('')}</div>` : ''}
      </div>
    </div>
    <div class="stats-grid">${stats.map(([l, v]) => `<div class="stat"><div class="sl">${l}</div><div class="sv num">${v}</div></div>`).join('')}</div>
    <div class="glass">
      <div class="card-head"><h3>🏆 RECORDS</h3></div>
      <div class="best-row">
        <div>
          <div class="sort-label" style="margin-bottom:8px">BEST SKIN</div>
          ${best ? `<div class="skin-card" style="--rc:${rarityColor(best)}">${skinImageHTML(best)}<div class="sc-name">${escapeHTML(best.fullName)}</div>${skinMetaHTML(best)}<div class="sc-value">${coinsHTML(best.value)}</div></div>` : '<div class="muted">—</div>'}
        </div>
        <div>
          <div class="sort-label" style="margin-bottom:8px">HIGHEST UPGRADE</div>
          ${hu ? `<div class="skin-card" style="--rc:${rarityColor(SKIN_BY_ID[hu.toId])}">${skinImageHTML(SKIN_BY_ID[hu.toId])}<div class="sc-name">${escapeHTML(SKIN_BY_ID[hu.toId].fullName)}</div><div class="sc-meta">from ${escapeHTML(SKIN_BY_ID[hu.fromId] ? SKIN_BY_ID[hu.fromId].fullName : '—')} · ${fmtPercent(hu.chance)}</div><div class="sc-value">${coinsHTML(hu.value)}</div></div>` : '<div class="muted">No wins yet</div>'}
        </div>
      </div>
    </div>
    <div class="glass">
      <div class="card-head"><h3>📚 COLLECTIONS</h3><span class="muted small">${state.collections.completed.length} / ${COLLECTIONS.length} complete</span></div>
      ${renderCollectionsHTML()}
    </div>
    <div class="danger-zone"><button class="btn btn-ghost" data-action="reset-save">↺ RESET PROGRESS</button></div>`;
}

// =========================================================
// AUDIO
// =========================================================
const Sound = {
  ctx: null, master: null,
  ensure() {
    if (!state.sound) return null;
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.55;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  },
  tone(freq, dur, { type = 'sine', vol = 0.2, slide = null, delay = 0, attack = 0.005 } = {}) {
    const ctx = this.ensure(); if (!ctx) return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.03);
  },
  noise(dur, vol, cutoff = 800) {
    const ctx = this.ensure(); if (!ctx) return;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    // deterministic xorshift noise: sound effects never touch Math.random
    let x = 2463534242;
    for (let i = 0; i < len; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; d[i] = ((x >>> 0) / 4294967296 * 2 - 1) * (1 - i / len); }
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cutoff;
    const g = ctx.createGain(); g.gain.value = vol;
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start();
  },
  click() { this.tone(620 + Math.random() * 60, 0.06, { type: 'triangle', vol: 0.12, slide: 1000 }); },
  coin() { this.tone(988, 0.08, { type: 'square', vol: 0.05 }); this.tone(1319, 0.2, { type: 'square', vol: 0.05, delay: 0.07 }); },
  tick() { this.tone(1500, 0.025, { type: 'square', vol: 0.035 }); },
  spinStart() { this.tone(180, 0.5, { type: 'sawtooth', vol: 0.05, slide: 900 }); },
  stop() { this.tone(240, 0.12, { type: 'square', vol: 0.08, slide: 120 }); this.noise(0.08, 0.15, 1200); },
  success() {
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.28, { type: 'triangle', vol: 0.16, delay: i * 0.08 }));
    this.tone(1568, 0.6, { type: 'sine', vol: 0.1, delay: 0.34 });
  },
  fail() { this.tone(330, 0.55, { type: 'sawtooth', vol: 0.12, slide: 60 }); this.noise(0.4, 0.35, 500); },
  levelUp() { [392, 523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(f, 0.3, { type: 'triangle', vol: 0.13, delay: i * 0.07 })); },
  purchase() { [660, 880, 1320].forEach((f, i) => this.tone(f, 0.12, { type: 'square', vol: 0.05, delay: i * 0.06 })); },
  error() { this.tone(160, 0.14, { type: 'square', vol: 0.06 }); }
};

function toggleSound() {
  state.sound = !state.sound;
  updateSoundButton();
  if (state.sound) Sound.coin();
  saveGame();
}
function updateSoundButton() { $('#soundBtn').textContent = state.sound ? '🔊' : '🔇'; }

// =========================================================
// SAVE / LOAD
// =========================================================
function saveGame() {
  clearTimeout(ui.saveTimer); ui.saveTimer = null;
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); } catch (e) { /* storage full / disabled */ }
}
// Debounced save for rapid clicks and selections
function scheduleSave() {
  if (ui.saveTimer) return;
  ui.saveTimer = setTimeout(saveGame, 300);
}

function mergeDefaults(def, saved) {
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) return saved === undefined ? def : saved;
  const out = {};
  for (const k of Object.keys(def)) {
    const d = def[k], s = saved[k];
    if (s === undefined) out[k] = d;
    else if (d && typeof d === 'object' && !Array.isArray(d)) out[k] = mergeDefaults(d, s);
    else out[k] = s;
  }
  return out;
}

function loadGame() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    state = mergeDefaults(createDefaultState(), JSON.parse(raw));
    state.inventory = state.inventory.filter(i => SKIN_BY_ID[i.id]);
    if (state.highestSkin && !SKIN_BY_ID[state.highestSkin]) state.highestSkin = null;
    state.nextUid = Math.max(state.nextUid, ...state.inventory.map(i => i.uid + 1), 1);
    validateUpgradeSelection();
    return true;
  } catch (e) {
    console.warn('UPGREDED: save could not be loaded, starting fresh.', e);
    state = createDefaultState();
    return false;
  }
}

function resetGame() {
  try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
  state = createDefaultState();
  Wheel.glow = null;
  Wheel.pointerAngle = -Math.PI / 2;
  switchTab('upgrade');
  giveStarterInventory();
  ensureMissions();
  updateHUD();
}

// =========================================================
// UI
// =========================================================
function updateHUD() {
  $('#hudCoins').textContent = fmt(state.coins);
  $('#hudLevel').textContent = state.level;
  const cc = $('#clickerCoins'); if (cc) cc.textContent = fmt(state.coins);
  const sc = $('#shopCoins'); if (sc) sc.textContent = fmt(state.coins);
  $$('[data-cost]').forEach(b => b.classList.toggle('cant', state.coins < +b.dataset.cost));
}

// ---- Modal ----
let modalOnClose = null;
function openModal(html, { onClose = null } = {}) {
  $('#modalBox').innerHTML = html;
  $('#modal').classList.add('open');
  modalOnClose = onClose;
}
function closeModal(runCallback = true) {
  $('#modal').classList.remove('open');
  const cb = modalOnClose; modalOnClose = null;
  if (runCallback && cb) cb();
}

// ---- Toasts (internal, trusted HTML only) ----
function toast(html, kind = '', ms = 2200) {
  const box = $('#toasts');
  while (box.children.length >= 4) box.firstChild.remove();
  const t = document.createElement('div');
  t.className = 'toast ' + kind; t.innerHTML = html;
  box.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}

// ---- Banner queue (level up / collection complete) ----
const Banner = {
  queue: [], busy: false,
  show(title, sub, kind) { this.queue.push({ title, sub, kind }); if (!this.busy) this.next(); },
  next() {
    const el = $('#banner');
    const b = this.queue.shift();
    if (!b) { this.busy = false; return; }
    this.busy = true;
    el.innerHTML = `<div class="bt">${b.title}</div><div class="bs">${b.sub}</div>`;
    el.className = 'banner ' + b.kind;
    void el.offsetWidth;
    el.classList.add('show');
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => this.next(), 380); }, 2000);
  }
};

// ---- Particles (single canvas, capped pool) ----
const FX = {
  canvas: null, ctx: null, list: [], max: 400, running: false, dpr: 1, w: 0, h: 0, last: 0,
  init() {
    this.canvas = $('#fx');
    this.ctx = this.canvas.getContext('2d');
    this.resize();
  },
  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = innerWidth; this.h = innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  },
  add(p) {
    if (this.list.length >= this.max) this.list.shift();
    p.age = 0;
    this.list.push(p);
    if (!this.running) {
      this.running = true;
      this.last = performance.now();
      requestAnimationFrame(t => this.loop(t));
    }
  },
  burst(x, y, o = {}) {
    const colors = o.colors || ['#fff'];
    for (let i = 0; i < (o.count || 12); i++) {
      const a = Math.random() * TAU, sp = (o.speed || 4) * (0.35 + Math.random() * 0.8);
      this.add({ kind: 'dot', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1.5, g: o.gravity ?? 0.15,
        life: (o.life || 0.8) * (0.7 + Math.random() * 0.5), size: (o.size || 3) * (0.6 + Math.random() * 0.8),
        color: colors[Math.floor(Math.random() * colors.length)] });
    }
  },
  confetti(n = 100) {
    const colors = ['#ffd24d', '#3cf5a0', '#ff5f6d', '#8b5cf6', '#4bc0ff', '#ffffff'];
    for (let i = 0; i < n; i++) {
      this.add({ kind: 'rect', x: Math.random() * this.w, y: -20 - Math.random() * this.h * 0.4,
        vx: (Math.random() - 0.5) * 3, vy: 2 + Math.random() * 3, g: 0.05, drag: 0.99,
        life: 2.4 + Math.random() * 1.2, size: 5 + Math.random() * 6,
        rot: Math.random() * TAU, vr: (Math.random() - 0.5) * 0.3,
        color: colors[Math.floor(Math.random() * colors.length)] });
    }
  },
  text(x, y, str, color = '#ffd24d') {
    this.add({ kind: 'text', x, y, vx: (Math.random() - 0.5) * 0.6, vy: -1.8, g: 0, drag: 0.97, life: 0.8, str, color, size: 18 });
  },
  loop(t) {
    const ctx = this.ctx;
    const dt = Math.min(0.05, (t - this.last) / 1000); this.last = t;
    const f = dt * 60;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.age += dt;
      if (p.age >= p.life || p.y > this.h + 40) { this.list.splice(i, 1); continue; }
      p.vy += p.g * f;
      if (p.drag) { p.vx *= Math.pow(p.drag, f); p.vy *= Math.pow(p.drag, f); }
      p.x += p.vx * f; p.y += p.vy * f;
      const k = 1 - p.age / p.life;
      ctx.globalAlpha = Math.min(1, k * 1.6);
      ctx.fillStyle = p.color;
      if (p.kind === 'dot') {
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (0.4 + k * 0.6), 0, TAU); ctx.fill();
      } else if (p.kind === 'rect') {
        p.rot += p.vr * f;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.restore();
      } else {
        ctx.font = `900 ${p.size}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.strokeText(p.str, p.x, p.y);
        ctx.fillText(p.str, p.x, p.y);
      }
    }
    ctx.globalAlpha = 1;
    if (this.list.length) requestAnimationFrame(tt => this.loop(tt));
    else { this.running = false; ctx.clearRect(0, 0, this.w, this.h); }
  }
};

// =========================================================
// NAVIGATION
// =========================================================
const RENDERERS = { upgrade: renderUpgrader, inventory: renderInventory, shop: renderShop, rewards: renderRewards, profile: renderProfile };

function switchTab(tab) {
  if (!RENDERERS[tab]) return;
  ui.tab = tab;
  $$('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + tab));
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.value === tab));
  RENDERERS[tab]();
  window.scrollTo(0, 0);
}

function selectSource(uid) {
  if (ui.spinning) return;
  state.selection.sourceUid = uid;
  ui.targetLimit = PAGE_SIZE;
  Wheel.setGlow(null);
  validateUpgradeSelection();
  scheduleSave();
}

function openUpgraderWith(uid) {
  selectSource(uid);
  switchTab('upgrade');
}

// Two-tap confirmation for destructive buttons
function armOrConfirm(el) {
  if (el.dataset.armed === '1') return true;
  el.dataset.armed = '1';
  const original = el.innerHTML;
  el.textContent = 'CONFIRM?';
  el.classList.add('btn-red');
  setTimeout(() => {
    if (el.isConnected) { el.dataset.armed = ''; el.innerHTML = original; el.classList.remove('btn-red'); }
  }, 2200);
  return false;
}

function bindEvents() {
  // Clicker: pointerdown for instant response; keyboard activation arrives as click with detail === 0
  document.addEventListener('pointerdown', e => {
    const btn = e.target.closest('[data-clicker]');
    if (!btn || e.button > 0) return;
    e.preventDefault();
    handleClick(e, btn);
  });

  // Global delegated click actions
  document.addEventListener('click', e => {
    const clicker = e.target.closest('[data-clicker]');
    if (clicker) { if (e.detail === 0) handleClick(null, clicker); return; }
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const v = el.dataset.value;
    switch (el.dataset.action) {
      case 'nav': closeModal(false); switchTab(v); break;
      case 'toggle-sound': toggleSound(); break;
      case 'claim-daily': claimDailyReward(); break;
      case 'claim-mission': claimMission(+v); break;
      case 'free-drop': claimFreeDrop(); break;
      case 'upgrade-uid': closeModal(false); openUpgraderWith(+v); break;
      case 'inv-type': ui.invType = v; ui.invLimit = 96; renderInventory(); break;
      case 'inv-sort': ui.invSort = v; renderInventory(); break;
      case 'inv-more': ui.invLimit += 96; renderInventoryGrid(); break;
      case 'inv-select': selectSource(+v); Sound.click(); renderInventoryGrid(); break;
      case 'inv-upgrade': openUpgraderWith(+v); break;
      case 'inv-sell': if (armOrConfirm(el)) sellSkin(+v); break;
      case 'shop-tier': ui.shopTier = v; ui.shopLimit = PAGE_SIZE; renderShop(); break;
      case 'shop-type': ui.shopType = v; ui.shopLimit = PAGE_SIZE; renderShop(); break;
      case 'shop-more': ui.shopLimit += PAGE_SIZE; renderShopGrid(); break;
      case 'shop-buy': buySkin(v); break;
      case 'pick-source':
        if (ui.spinning) break;
        selectSource(+v); Sound.click(); renderUpgrader(); break;
      case 'pick-target':
        if (ui.spinning) break;
        state.selection.targetId = v; Wheel.setGlow(null); Sound.click(); scheduleSave(); renderUpgrader();
        $('.upgrade-zone').scrollIntoView({ behavior: 'smooth', block: 'start' });
        break;
      case 'target-bucket': ui.targetBucket = v; ui.targetLimit = PAGE_SIZE; renderUpgrader(); break;
      case 'target-type': ui.targetType = v; ui.targetLimit = PAGE_SIZE; renderUpgrader(); break;
      case 'target-more': ui.targetLimit += PAGE_SIZE; renderTargetGrid(); break;
      case 'scroll-to': { const t = document.getElementById(v); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); break; }
      case 'upgrade': startUpgrade(); break;
      case 'continue-win': closeModal(false); continueAfterWin(); break;
      case 'continue-fail': closeModal(false); continueAfterFail(); break;
      case 'close-modal': closeModal(); break;
      case 'reset-save': if (armOrConfirm(el)) resetGame(); break;
    }
  });

  // Selects
  document.addEventListener('change', e => {
    const el = e.target.closest('[data-change]');
    if (!el) return;
    const key = { 'inv-weapon': 'invWeapon', 'inv-rarity': 'invRarity', 'inv-condition': 'invCondition' }[el.dataset.change];
    if (key) { ui[key] = el.value; ui.invLimit = 96; renderInventory(); }
  });

  // Search inputs: only the result grid is re-rendered, so focus is kept
  let searchTimer = null;
  document.addEventListener('input', e => {
    const el = e.target.closest('[data-input]');
    if (!el) return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const kind = el.dataset.input;
      if (kind === 'shop-search') { ui.shopQuery = el.value; ui.shopLimit = PAGE_SIZE; renderShopGrid(); }
      if (kind === 'target-search') { ui.targetQuery = el.value; ui.targetLimit = PAGE_SIZE; renderTargetGrid(); }
      if (kind === 'source-search') { ui.sourceQuery = el.value; renderSourceGrid(); }
      if (kind === 'inv-search') { ui.invQuery = el.value; ui.invLimit = 96; renderInventoryGrid(); }
    }, 150);
  });

  // Close modal by tapping the backdrop
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

  // Unlock audio on first interaction (mobile autoplay policies)
  document.addEventListener('pointerdown', () => Sound.ensure(), { once: true });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { FX.resize(); Wheel.resize(); }, 120);
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveGame(); });
  window.addEventListener('beforeunload', saveGame);
}

init();
