// ===== TOAST SYSTEM =====
function showToast(message, opts = {}) {
  const { type = 'success', duration = 2500, undoFn = null } = opts;
  const toastType     = undoFn ? 'undo' : type;
  const toastDuration = undoFn ? 4000 : duration;
  const stack = document.getElementById('toastStack');
  if (!stack) return;
  const toast = document.createElement('div');
  toast.className = `toast ${toastType}`;
  toast.innerHTML = `<span class="toast-msg">${message}</span>` +
    (undoFn ? `<button class="toast-undo">Undo</button>` : '');
  if (undoFn) {
    toast.querySelector('.toast-undo').addEventListener('click', () => {
      undoFn();
      _dismissToast(toast);
    });
  }
  stack.appendChild(toast);
  const timer = setTimeout(() => _dismissToast(toast), toastDuration);
  toast._timer = timer;
  return toast;
}

function _dismissToast(toast) {
  if (!toast.parentNode) return;
  clearTimeout(toast._timer);
  toast.classList.add('removing');
  setTimeout(() => toast.remove(), 200);
}

// ===== FOCUS TRAP =====
function _trapFocus(el) {
  const sel = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
  function handler(e) {
    if (e.key !== 'Tab') return;
    const nodes = [...el.querySelectorAll(sel)].filter(n => n.offsetParent !== null);
    if (!nodes.length) return;
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey) { if (document.activeElement === first) { e.preventDefault(); last.focus(); } }
    else            { if (document.activeElement === last)  { e.preventDefault(); first.focus(); } }
  }
  el.addEventListener('keydown', handler);
  const first = [...el.querySelectorAll(sel)].find(n => n.offsetParent !== null);
  first?.focus();
  return () => el.removeEventListener('keydown', handler);
}

// ===== STATE =====
let currentStep = 0;
let meals = [];
let swappingIndex = -1;
let recipes = [];
let pantry = [];
let prefs = {};
const pendingRatings = {};
let _pendingGeneratedRecipe = null;
let calendarEvents = null;
let weekBreakfasts = [];
let weekLunches    = [];
const _pickerOpen  = { breakfast: false, lunch: false };
let servingSize = 4;
let _cartView = 'meal';          // 'meal' | 'category'
let _cartData = null;            // { groups, mealOrder, total, url } — kept for view toggle
let _prefsTrap = null;           // focus trap cleanup fns
let _recipesTrap = null;
let _pantryTrap = null;

const BREAKFAST_OPTIONS = ['Scrambled eggs & toast', 'Cereal & milk', 'Pancakes', 'Oatmeal', 'Yogurt & granola', 'Bagels & cream cheese'];
const LUNCH_OPTIONS     = ['Sandwiches', 'Leftovers', 'Grilled cheese', 'Soup', 'Salads', 'Mac & cheese'];

// ===== HOUSEHOLD CATEGORIES =====
let hhExtras = []; // {name, save} — one-off items added on step 2

const HH_CATEGORIES = {
  produce:   ['apple','banana','orange','grape','strawberr','blueberr','mango','pineapple','avocado','tomato','lettuce','spinach','kale','broccoli','carrot','celery','cucumber','onion','garlic','pepper','potato','zucchini','corn','pear','peach','plum','lemon','lime','melon','berry','berries','salad','mushroom','herb','cilantro','parsley','basil'],
  dairy:     ['milk','butter','cheese','yogurt','cream','egg','eggs','creamer','sour cream','half and half','cottage','kefir','whipped'],
  meat:      ['chicken','beef','pork','salmon','fish','shrimp','turkey','steak','sausage','bacon','ham','tuna','ground','tilapia','lamb','crab','lobster'],
  bakery:    ['bread','bagel','muffin','tortilla','roll','bun','pita','naan','croissant','pretzel','biscuit','sourdough','english muffin'],
  pantry:    ['rice','pasta','flour','sugar','salt','oil','vinegar','sauce','salsa','broth','stock','can','bean','lentil','oat','cereal','granola','crackers','chips','peanut butter','jelly','honey','syrup','ketchup','mustard','mayo','spice','seasoning','ramen','noodle','soup mix'],
  frozen:    ['frozen','ice cream','pizza','fries','nuggets','waffle','edamame'],
  drinks:    ['water','juice','soda','coffee','tea','lemonade','gatorade','wine','beer','sparkling','diet coke','coke','pepsi','sprite','dr pepper','kombucha','drink','creamer'],
  snacks:    ['snack','nut','almond','cashew','walnut','popcorn','cookie','brownie','bar','candy','chocolate','gummy','trail mix'],
  household: ['paper towel','toilet paper','tissue','napkin','trash bag','ziploc','foil','wrap','detergent','soap','shampoo','conditioner','toothpaste','toothbrush','deodorant','razor','cleaner','sponge','dish','laundry','dryer','bleach','wipe','sanitizer','lotion','floss'],
  baby:      ['diaper','formula','baby','pacifier'],
  pet:       ['dog food','cat food','pet','kibble','litter'],
};
const HH_CATEGORY_ORDER  = ['produce','dairy','meat','bakery','pantry','frozen','drinks','snacks','household','baby','pet','other'];
const HH_CATEGORY_LABELS = {
  produce:'Produce', dairy:'Dairy & Eggs', meat:'Meat & Seafood',
  bakery:'Bakery & Bread', pantry:'Pantry', frozen:'Frozen',
  drinks:'Drinks', snacks:'Snacks', household:'Household',
  baby:'Baby', pet:'Pet', other:'Other',
};

function _hhCategory(name) {
  const lower = (name || '').toLowerCase();
  for (const [cat, keywords] of Object.entries(HH_CATEGORIES)) {
    if (keywords.some(kw => lower.includes(kw))) return cat;
  }
  return 'other';
}

function _normalizeHhItem(item) {
  if (typeof item === 'string') return { name: item, category: _hhCategory(item), brand: '' };
  return { name: item.name || '', category: item.category || _hhCategory(item.name || ''), brand: item.brand || '' };
}

// ===== CART LOADER =====
const MEAL_PLAN_MSGS = [
  'Thinking up something delicious...',
  'Checking what you had last week...',
  'Balancing your week...',
  'Finding something new to try...',
  'Matching meals to your schedule...',
  'Making sure the kids will eat it...',
  'Almost ready...',
];
const CART_BUILD_MSGS = [
  'Adding eggs to the cart...',
  'Checking prices at your store...',
  'Matching products to your meals...',
  'Finding the best deals...',
  'Looking up your weekly staples...',
  'Comparing product options...',
  'Double-checking quantities...',
  'Almost done building your cart...',
];

let _microcopyTimer = null;
let _cartProgressTimer = null;

function startMicrocopy(msgs, elId, intervalMs = 3400) {
  stopMicrocopy();
  let i = 0;
  const el = document.getElementById(elId);
  if (el) el.textContent = msgs[0];
  _microcopyTimer = setInterval(() => {
    i = (i + 1) % msgs.length;
    const el2 = document.getElementById(elId);
    if (!el2) return;
    el2.style.opacity = '0';
    setTimeout(() => { const el3 = document.getElementById(elId); if (el3) { el3.textContent = msgs[i]; el3.style.opacity = '1'; } }, 250);
  }, intervalMs);
}

function stopMicrocopy() {
  if (_microcopyTimer) { clearInterval(_microcopyTimer); _microcopyTimer = null; }
}

function startCartProgress(durationSecs = 54) {
  stopCartProgress();
  let progress = 0;
  const maxProgress = 0.9;
  const tickMs = 250;
  const increment = maxProgress / ((durationSecs * 1000) / tickMs);
  _cartProgressTimer = setInterval(() => {
    progress = Math.min(progress + increment, maxProgress);
    _setCartProgress(progress);
    if (progress >= maxProgress) stopCartProgress();
  }, tickMs);
}

function stopCartProgress() {
  if (_cartProgressTimer) { clearInterval(_cartProgressTimer); _cartProgressTimer = null; }
}

function finishCartProgress() {
  stopCartProgress();
  _setCartProgress(1.0, true);
}

function resetCartProgress() {
  stopCartProgress();
  const fill = document.getElementById('cartBuildProgress');
  const cart = document.getElementById('cartBuildCart');
  if (fill) { fill.style.transition = 'none'; fill.style.width = '0'; }
  if (cart) { cart.style.transition = 'none'; cart.style.left = '0'; }
}

function _setCartProgress(p, fast = false) {
  const fill = document.getElementById('cartBuildProgress');
  const cart = document.getElementById('cartBuildCart');
  const trackEl = fill?.parentElement;
  if (!fill || !cart || !trackEl) return;
  const trackW = trackEl.offsetWidth;
  const pxLeft = p * trackW;
  if (fast) {
    fill.style.transition = 'width 0.4s ease';
    cart.style.transition = 'left 0.4s ease';
  }
  fill.style.width = (p * trackW) + 'px';
  cart.style.left = pxLeft + 'px';
}

const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const DAY_ABBR = { Monday:'Mon', Tuesday:'Tue', Wednesday:'Wed', Thursday:'Thu', Friday:'Fri', Saturday:'Sat', Sunday:'Sun' };

// ===== NAVIGATION =====
function goToStep(n, fromHistory = false) {
  [0,1,2,3].forEach(i => {
    const step = document.getElementById('step'+i);
    if (step) step.style.display = i===n ? 'block' : 'none';
    const hero = document.getElementById('heroStep'+i);
    if (hero) {
      if (i < n)      hero.className = 'hero-step-card done';
      else if (i===n) hero.className = 'hero-step-card active';
      else            hero.className = 'hero-step-card todo';
    }
  });
  document.getElementById('mainApp')?.classList.toggle('step0-active', n === 0);
  currentStep = n;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (!fromHistory) history.pushState({ step: n, overlay: null }, '');
}

// ===== HISTORY API (browser back button) =====
window.addEventListener('popstate', e => {
  const state = e.state || { step: 0, overlay: null };

  // Close any open overlay without touching history (we're already mid-popstate)
  const prefsOpen   = document.getElementById('prefsPage')?.style.display   !== 'none';
  const recipesOpen = document.getElementById('recipesPage')?.style.display  !== 'none';
  const pantryOpen  = document.getElementById('pantryPanel')?.style.display  !== 'none';
  if (prefsOpen)   closePrefsPage(true);
  if (recipesOpen) closeRecipesPage(true);
  if (pantryOpen)  closePantryPage(true);

  // Re-open overlay from state (e.g. user pressed forward)
  if      (state.overlay === 'prefs')   openPrefsPage(true);
  else if (state.overlay === 'recipes') openRecipesPage(true);
  else if (state.overlay === 'pantry')  openPantryPage(true);

  // Navigate to the correct step
  if (typeof state.step === 'number' && state.step !== currentStep) {
    goToStep(state.step, true);
  }
});

// ===== HOUSEHOLD ITEMS =====
const LS_HOUSEHOLD_KEY = 'grocery_household_checked';
let householdItems = [];
let householdChecked = new Set(JSON.parse(localStorage.getItem(LS_HOUSEHOLD_KEY) || '[]'));

function _hhDisplayName(name) {
  return name.replace(/,\s*$/, '').replace(/\s+[\d(].*$/, '').trim() || name;
}

function renderHousehold() {
  const grid = document.getElementById('hhGrid');
  const normalItems = (householdItems || []).map(_normalizeHhItem);
  if (!normalItems.length) { grid.innerHTML = '<span class="hh-loading">no household items found in preferences.md</span>'; return; }

  const groups = {};
  normalItems.forEach(item => {
    const cat = item.category || _hhCategory(item.name);
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(item.name);
  });

  let html = '';
  for (const cat of HH_CATEGORY_ORDER) {
    if (!groups[cat]) continue;
    const itemsHtml = groups[cat].map(name => {
      const checked = householdChecked.has(name);
      const esc = name.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      const display = _hhDisplayName(name);
      return `<div class="hh-item-row">
        <label class="hh-item">
          <input type="checkbox" ${checked ? 'checked' : ''} onchange="toggleHousehold('${esc}', this.checked)">
          <span class="hh-item-name">${display}</span>
        </label>
        <button class="hh-item-delete" onclick="removeHouseholdItem('${esc}')" aria-label="Remove ${display}">×</button>
      </div>`;
    }).join('');
    html += `<div class="hh-category">
      <div class="hh-category-label">${HH_CATEGORY_LABELS[cat]}</div>
      <div class="hh-category-items">${itemsHtml}</div>
    </div>`;
  }

  grid.innerHTML = html;
  updateHhCount();
}

async function removeHouseholdItem(name) {
  const displayName = _hhDisplayName(name);
  const _hhName = i => (typeof i === 'string' ? i : i.name);
  const removedIdx  = (prefs.householdItems || []).findIndex(i => _hhName(i) === name);
  const removedItem = removedIdx >= 0 ? prefs.householdItems[removedIdx] : null;

  prefs.householdItems = (prefs.householdItems || []).filter(i => _hhName(i) !== name);
  householdItems       = householdItems.filter(i => _hhName(i) !== name);
  householdChecked.delete(name);
  localStorage.setItem(LS_HOUSEHOLD_KEY, JSON.stringify([...householdChecked]));
  renderHousehold();

  const timer = setTimeout(async () => {
    try {
      await fetch('/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(prefs) });
    } catch(e) {}
  }, 4000);

  showToast(`${displayName} removed`, {
    undoFn: () => {
      clearTimeout(timer);
      if (removedIdx >= 0 && removedItem != null) prefs.householdItems.splice(removedIdx, 0, removedItem);
      else prefs.householdItems.push({ name, category: _hhCategory(name), brand: '' });
      householdItems = [...(prefs.householdItems || [])];
      renderHousehold();
    },
  });
}

function toggleHousehold(name, checked) {
  checked ? householdChecked.add(name) : householdChecked.delete(name);
  localStorage.setItem(LS_HOUSEHOLD_KEY, JSON.stringify([...householdChecked]));
  updateHhCount();
}

function updateHhCount() {
  const selected = householdChecked.size;
  const total = householdItems.length;
  document.getElementById('hhCount').textContent = `${selected} of ${total} selected`;
}

async function loadHouseholdItems() {
  try {
    const resp = await fetch('/household-items');
    const data = await resp.json();
    householdItems = (data.items || []).map(_normalizeHhItem);
    renderHousehold();
  } catch(e) {
    document.getElementById('hhGrid').innerHTML = '<span class="hh-loading">server not running</span>';
  }
}

function showHhAddRow() {
  document.getElementById('hhAddRow').style.display = 'flex';
  document.getElementById('hhAddBtn').style.display = 'none';
  document.getElementById('hhNewName').value = '';
  document.getElementById('hhNewName').focus();
}

function cancelHhAdd() {
  document.getElementById('hhAddRow').style.display = 'none';
  document.getElementById('hhAddBtn').style.display = 'inline-flex';
}

function handleHhAddKey(e) {
  if (e.key === 'Enter') submitNewHouseholdItem();
  if (e.key === 'Escape') cancelHhAdd();
}

async function submitNewHouseholdItem() {
  const name = document.getElementById('hhNewName').value.trim();
  if (!name) return;
  if (!prefs.householdItems) prefs.householdItems = [];
  const exists = prefs.householdItems.some(i => (typeof i === 'string' ? i : i.name) === name);
  if (!exists) {
    prefs.householdItems.push({ name, category: _hhCategory(name), brand: '' });
    try {
      await fetch('/prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prefs),
      });
    } catch(e) {}
  }
  householdChecked.add(name);
  localStorage.setItem(LS_HOUSEHOLD_KEY, JSON.stringify([...householdChecked]));
  await loadHouseholdItems();
  cancelHhAdd();
}

// ===== ANYTHING ELSE? =====
function renderHhExtras() {
  const list = document.getElementById('hhExtrasList');
  if (!list) return;
  list.innerHTML = hhExtras.length
    ? hhExtras.map((extra, i) => `
      <div class="hh-extra-row">
        <span class="hh-extra-name">${extra.name}</span>
        <label class="hh-extra-save">
          <input type="checkbox" ${extra.save ? 'checked' : ''} onchange="toggleHhExtraSave(${i}, this.checked)">
          <span>save to my list</span>
        </label>
        <button class="hh-item-delete" onclick="removeHhExtra(${i})" title="remove" style="opacity:1">×</button>
      </div>`).join('')
    : '';
}

function addHhExtra() {
  const input = document.getElementById('hhExtraInput');
  const name = (input.value || '').trim();
  if (!name) return;
  hhExtras.push({ name, save: false });
  input.value = '';
  renderHhExtras();
}

function handleHhExtraKey(e) {
  if (e.key === 'Enter') addHhExtra();
}

function toggleHhExtraSave(i, checked) {
  if (hhExtras[i]) hhExtras[i].save = checked;
}

function removeHhExtra(i) {
  hhExtras.splice(i, 1);
  renderHhExtras();
}

// ===== SCHEDULE =====
const SCHEDULE_DAYS = [
  { key: 'Monday',    short: 'Mon', default: 'normal' },
  { key: 'Tuesday',   short: 'Tue', default: 'normal' },
  { key: 'Wednesday', short: 'Wed', default: 'normal' },
  { key: 'Thursday',  short: 'Thu', default: 'normal' },
  { key: 'Friday',    short: 'Fri', default: 'quick'  },
  { key: 'Saturday',  short: 'Sat', default: 'open'   },
  { key: 'Sunday',    short: 'Sun', default: 'open'   },
];
const COMPLEXITY_CYCLE = ['normal', 'quick', 'open'];
const COMPLEXITY_LABEL = { normal: 'Normal', quick: 'Quick', open: 'Open' };
const COMPLEXITY_DESC  = {
  quick:  'QUICK — 30 min or less (frozen, heat-and-eat, or simple assembly)',
  normal: 'NORMAL — standard weeknight (30–60 min)',
  open:   'OPEN — plenty of time (elaborate recipes welcome: lasagna, slow cooker, etc.)',
};

let schedule = {};
SCHEDULE_DAYS.forEach(d => { schedule[d.key] = { complexity: d.default }; });

function renderSchedule() {
  document.getElementById('scheduleGrid').innerHTML = SCHEDULE_DAYS.map(d => {
    const { complexity } = schedule[d.key];
    const events = calendarEvents ? (calendarEvents[d.key] || []) : [];
    const eventsHtml = events.length
      ? `<div class="cal-events">${events.map(e =>
          `<div class="cal-event"><span class="cal-event-time">${e.time}</span>${e.title}</div>`
        ).join('')}</div>`
      : '';
    return `
      <div class="schedule-col">
        <div class="schedule-day">${d.short}</div>
        <button class="complexity-btn ${complexity}" onclick="cycleComplexity('${d.key}')">${COMPLEXITY_LABEL[complexity]}</button>
        ${eventsHtml}
      </div>`;
  }).join('');
}

// ===== GOOGLE CALENDAR =====
async function loadCalendarStatus() {
  try {
    const resp = await fetch('/calendar/status');
    const data = await resp.json();
    if (data.connected) await loadCalendarEvents();
    renderCalBanner(data);
  } catch(e) {
    renderCalBanner({ connected: false, setup: false });
  }
}

async function loadCalendarEvents() {
  try {
    const resp = await fetch('/calendar/week');
    if (resp.ok) {
      calendarEvents = await resp.json();
      applyCalendarComplexity();
    }
  } catch(e) {}
}

function applyCalendarComplexity() {
  if (!calendarEvents) return;
  const weekends = new Set(['Saturday', 'Sunday']);
  SCHEDULE_DAYS.forEach(d => {
    const events = calendarEvents[d.key] || [];
    schedule[d.key].complexity = events.length   ? 'quick'
      : weekends.has(d.key)                      ? 'open'
      : 'normal';
  });
  renderSchedule();
}

function renderCalBanner(status) {
  const el = document.getElementById('calSection');
  if (!el) return;
  if (!status.setup) { el.innerHTML = ''; return; }
  if (status.connected) {
    el.innerHTML = `<div class="cal-connected-bar">
      <span class="cal-status-dot active"></span>
      <span class="cal-status-text">Google Calendar connected</span>
      <button class="cal-disconnect-btn" onclick="disconnectCalendar()">disconnect</button>
    </div>`;
  } else {
    el.innerHTML = `<div class="cal-empty-card">
      <div class="cal-empty-icon">📅</div>
      <div class="cal-empty-body">
        <div class="cal-empty-title">Connect Google Calendar</div>
        <div class="cal-empty-desc">Sync your week's events so the meal planner can match dinner complexity to your schedule.</div>
      </div>
      <a class="btn primary" href="/calendar/auth">Connect →</a>
    </div>`;
  }
}

async function disconnectCalendar() {
  await fetch('/calendar/disconnect', { method: 'POST' });
  calendarEvents = null;
  SCHEDULE_DAYS.forEach(d => { schedule[d.key].complexity = d.default; });
  renderSchedule();
  renderCalBanner({ connected: false, setup: true });
}

function cycleComplexity(day) {
  const idx = COMPLEXITY_CYCLE.indexOf(schedule[day].complexity);
  schedule[day].complexity = COMPLEXITY_CYCLE[(idx + 1) % COMPLEXITY_CYCLE.length];
  renderSchedule();
}

function buildSchedulePrompt() {
  return SCHEDULE_DAYS.map(d => {
    return `- ${d.key}: ${COMPLEXITY_DESC[schedule[d.key].complexity]}`;
  }).join('\n');
}

function resetApp() {
  meals = [];
  swappingIndex = -1;
  ['loadingBar','mealPlanCard','approveBtn','regenerateBtn',
   'cartCard','budgetBar','cartUrlBox','cartLoadingBar',
   'cartError','serverNotice','doneBtn','ratingPanel'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  const buildBtn = document.getElementById('buildCartBtn');
  if (buildBtn) buildBtn.style.display = 'none';
  document.getElementById('swapRow').className = 'swap-input-row';
  goToStep(0);
}

// ===== RECIPE REPOSITORY =====
async function loadRecipes() {
  try {
    const resp = await fetch('/recipes');
    recipes = await resp.json();
  } catch(e) {}
}

async function saveRecipe(data) {
  const resp = await fetch('/recipes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const r = await resp.json();
  await loadRecipes();
  return r;
}

async function patchRecipe(id, data) {
  await fetch(`/recipes/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  await loadRecipes();
}

async function removeRecipe(id) {
  const removed = recipes.find(r => r.id === id);
  if (!removed) return;

  // Optimistic remove
  recipes = recipes.filter(r => r.id !== id);
  renderRecipesPanel();

  const timer = setTimeout(async () => {
    try { await fetch(`/recipes/${id}`, { method: 'DELETE' }); } catch(e) {}
  }, 4000);

  showToast(`${removed.name} removed from recipe book`, {
    undoFn: () => {
      clearTimeout(timer);
      recipes.push(removed);
      renderRecipesPanel();
    },
  });
}

function starsHtml(rating, size = 'display') {
  const stars = Array.from({length: 5}, (_, i) =>
    `<span class="star-${size} ${i < rating ? 'filled' : ''}">${i < rating ? '★' : '☆'}</span>`
  ).join('');
  return `<span class="star-row">${stars}</span>`;
}

function starPickerHtml(pickerId, currentRating, onClickFn) {
  return Array.from({length: 5}, (_, i) =>
    `<span class="star-pick ${i < currentRating ? 'filled' : ''}" onclick="${onClickFn}(${i+1},'${pickerId}')">${i < currentRating ? '★' : '☆'}</span>`
  ).join('');
}

function setStar(rating, pickerId) {
  const el = document.getElementById(pickerId);
  if (!el) return;
  el.dataset.rating = rating;
  el.innerHTML = starPickerHtml(pickerId, rating, 'setStar');
}

// Recipe page (full-screen)
function _syncPanelOpen() {
  const prefsOpen   = document.getElementById('prefsPage').style.display   !== 'none';
  const recipesOpen = document.getElementById('recipesPage').style.display  !== 'none';
  const pantryOpen  = document.getElementById('pantryPanel').style.display  !== 'none';
  document.getElementById('navPrefs').classList.toggle('active', prefsOpen);
  document.getElementById('navRecipes').classList.toggle('active', recipesOpen);
  document.getElementById('navPantry').classList.toggle('active', pantryOpen);
}

function openRecipesPage(fromHistory = false) {
  if (!fromHistory) history.pushState({ step: currentStep, overlay: 'recipes' }, '');
  document.getElementById('recipesPage').style.display = 'flex';
  _syncPanelOpen();
  document.getElementById('recipesSearch').value = '';
  renderRecipesPanel();
  _recipesTrap = _trapFocus(document.getElementById('recipesPage'));
}

function closeRecipesPage(fromHistory = false) {
  if (!fromHistory) history.replaceState({ step: currentStep, overlay: null }, '');
  document.getElementById('recipesPage').style.display = 'none';
  _syncPanelOpen();
  _recipesTrap?.(); _recipesTrap = null;
}

function toggleRecipesPanel() {
  const page = document.getElementById('recipesPage');
  if (page.style.display !== 'none') { closeRecipesPage(); } else { openRecipesPage(); }
}

async function backfillRecipes() {
  const btn = document.getElementById('recipesBackfillBtn');
  if (btn) { btn.textContent = 'filling...'; btn.disabled = true; }
  try {
    const res = await fetch('/recipes/backfill', { method: 'POST' });
    const data = await res.json();
    await loadRecipes();
    renderRecipesPanel();
    if (btn) { btn.textContent = `filled ${data.filled}`; setTimeout(() => { btn.textContent = 'fill missing'; btn.disabled = false; }, 3000); }
  } catch (e) {
    if (btn) { btn.textContent = 'error'; setTimeout(() => { btn.textContent = 'fill missing'; btn.disabled = false; }, 3000); }
  }
}

function renderRecipesPanel() {
  const query = (document.getElementById('recipesSearch')?.value || '').toLowerCase();
  let filtered = query
    ? recipes.filter(r => r.name.toLowerCase().includes(query) || (r.notes||'').toLowerCase().includes(query))
    : [...recipes];
  filtered.sort((a, b) => (b.rating - a.rating) || (b.timesPlanned - a.timesPlanned));

  document.getElementById('recipesList').innerHTML = filtered.length
    ? filtered.map(r => recipeCardHtml(r)).join('')
    : '<div class="hh-loading">no recipes yet — add one or confirm an order to start building your recipe book</div>';
}

function recipeCardHtml(r) {
  const tags = (r.tags||[]).map(t => `<span class="recipe-tag">${t}</span>`).join('');
  const thumb = r.photo
    ? `<img class="recipe-thumb" src="${r.photo}" alt="" onclick="triggerPhotoUpload('${r.id}')" title="change photo">`
    : '';
  return `<div class="recipe-card" id="rc-${r.id}">
    <div class="recipe-card-main">
      <div class="recipe-card-left">
        ${thumb}
        <div style="flex:1;min-width:0">
          <div class="recipe-name">${r.name}</div>
          <div class="recipe-meta">
            ${starsHtml(r.rating)}
            ${r.timesPlanned ? `<span class="recipe-times">${r.timesPlanned}× planned</span>` : ''}
          </div>
          ${tags ? `<div class="recipe-tags">${tags}</div>` : ''}
          ${r.notes ? `<div class="recipe-notes">${r.notes}</div>` : ''}
        </div>
      </div>
      <div class="recipe-actions">
        <button class="btn-icon" onclick="triggerPhotoUpload('${r.id}')">${r.photo ? '📷' : '+ photo'}</button>
        <button class="btn-icon" id="rd-btn-${r.id}" onclick="toggleRecipeDetail('${r.id}')">view ▾</button>
        <button class="btn-icon" onclick="editRecipeInline('${r.id}')">edit</button>
        <button class="btn-icon danger" onclick="removeRecipe('${r.id}')" aria-label="Remove ${r.name} from recipe book">×</button>
      </div>
    </div>
    <div class="recipe-detail" id="rd-${r.id}" style="display:none">
      ${recipeDetailHtml(r)}
    </div>
  </div>`;
}

function recipeDetailHtml(r) {
  const ingredients = r.ingredients || [];
  const steps = r.steps || [];
  if (!ingredients.length && !steps.length) {
    return `<div class="recipe-detail-empty">No ingredients or steps yet — click edit to add them.</div>`;
  }
  let html = '<div class="recipe-detail-inner">';
  if (ingredients.length) {
    html += `<div class="recipe-detail-section">
      <div class="recipe-detail-label">ingredients</div>
      <ul class="recipe-ingredient-list">${ingredients.map(i => `<li>${i}</li>`).join('')}</ul>
    </div>`;
  }
  if (steps.length) {
    html += `<div class="recipe-detail-section">
      <div class="recipe-detail-label">steps</div>
      <ol class="recipe-step-list">${steps.map(s => `<li>${s}</li>`).join('')}</ol>
    </div>`;
  }
  html += '</div>';
  return html;
}

function toggleRecipeDetail(id) {
  const detail = document.getElementById(`rd-${id}`);
  const btn    = document.getElementById(`rd-btn-${id}`);
  if (!detail) return;
  const isOpen = detail.style.display !== 'none';
  detail.style.display = isOpen ? 'none' : 'block';
  if (btn) btn.textContent = isOpen ? 'view ▾' : 'hide ▴';
}

function editRecipeInline(id) {
  const r = recipes.find(r => r.id === id);
  if (!r) return;
  const card = document.getElementById(`rc-${id}`);
  const pickerId = `ep-${id}`;
  const ingredients = (r.ingredients || []);
  const steps = (r.steps || []);
  card.innerHTML = `<div class="recipe-edit-form">
    <input class="recipe-edit-name" id="en-${id}" value="${r.name.replace(/"/g,'&quot;')}" />
    <div class="star-picker" id="${pickerId}" data-rating="${r.rating||0}">${starPickerHtml(pickerId, r.rating||0, 'setStar')}</div>
    <input class="schedule-note" id="eno-${id}" placeholder="notes..." value="${(r.notes||'').replace(/"/g,'&quot;')}" />
    <div class="recipe-tag-picker">
      ${['quick','weekend','kid-friendly','comfort-food','dessert'].map(t =>
        `<label class="tag-option"><input type="checkbox" ${(r.tags||[]).includes(t)?'checked':''} value="${t}" data-edit="${id}"> ${t}</label>`
      ).join('')}
    </div>
    <div class="recipe-detail-label" style="margin-top:6px">ingredients</div>
    <div class="prefs-list" id="re-ing-${id}">${ingredients.map(v => prefItemHtml(v)).join('')}</div>
    <button class="btn prefs-add-btn" onclick="addRecipeListItem('re-ing-${id}')">+ add ingredient</button>
    <div class="recipe-detail-label" style="margin-top:6px">steps</div>
    <div class="prefs-list" id="re-steps-${id}">${steps.map(v => prefItemHtml(v)).join('')}</div>
    <button class="btn prefs-add-btn" onclick="addRecipeListItem('re-steps-${id}')">+ add step</button>
    <div class="recipe-edit-actions">
      <button class="btn" onclick="renderRecipesPanel()">cancel</button>
      <button class="btn primary" onclick="commitRecipeEdit('${id}')">save</button>
    </div>
  </div>`;
}

async function commitRecipeEdit(id) {
  const name  = document.getElementById(`en-${id}`).value.trim();
  const notes = document.getElementById(`eno-${id}`).value.trim();
  const picker = document.getElementById(`ep-${id}`);
  const rating = parseInt(picker?.dataset.rating || 0);
  const tags = [...document.querySelectorAll(`input[data-edit="${id}"]:checked`)].map(el => el.value);
  const ingredients = [...document.querySelectorAll(`#re-ing-${id} .prefs-list-input`)].map(el => el.value.trim()).filter(Boolean);
  const steps = [...document.querySelectorAll(`#re-steps-${id} .prefs-list-input`)].map(el => el.value.trim()).filter(Boolean);
  await patchRecipe(id, { name, notes, rating, tags, ingredients, steps });
  renderRecipesPanel();
}

function addRecipeManual() {
  const list = document.getElementById('recipesList');
  if (document.getElementById('add-form')) return;
  const pickerId = 'new-star-picker';
  const form = document.createElement('div');
  form.className = 'recipe-card';
  form.id = 'add-form';
  form.innerHTML = `<div class="recipe-edit-form">
    <input class="recipe-edit-name" id="new-name" placeholder="Recipe name..." />
    <div class="star-picker" id="${pickerId}" data-rating="0">${starPickerHtml(pickerId, 0, 'setStar')}</div>
    <input class="schedule-note" id="new-notes" placeholder="notes..." />
    <div class="recipe-tag-picker">
      ${['quick','weekend','kid-friendly','comfort-food','dessert'].map(t =>
        `<label class="tag-option"><input type="checkbox" value="${t}" class="new-tag"> ${t}</label>`
      ).join('')}
    </div>
    <div class="recipe-detail-label" style="margin-top:6px">ingredients</div>
    <div class="prefs-list" id="new-ing"></div>
    <button class="btn prefs-add-btn" onclick="addRecipeListItem('new-ing')">+ add ingredient</button>
    <div class="recipe-detail-label" style="margin-top:6px">steps</div>
    <div class="prefs-list" id="new-steps"></div>
    <button class="btn prefs-add-btn" onclick="addRecipeListItem('new-steps')">+ add step</button>
    <div class="recipe-edit-actions">
      <button class="btn" onclick="document.getElementById('add-form').remove()">cancel</button>
      <button class="btn primary" onclick="submitNewRecipe()">add recipe</button>
    </div>
  </div>`;
  list.prepend(form);
  document.getElementById('new-name').focus();
}

async function submitNewRecipe() {
  const name   = (document.getElementById('new-name')?.value || '').trim();
  if (!name) return;
  const notes  = document.getElementById('new-notes')?.value.trim() || '';
  const rating = parseInt(document.getElementById('new-star-picker')?.dataset.rating || 0);
  const tags   = [...document.querySelectorAll('.new-tag:checked')].map(el => el.value);
  const ingredients = [...document.querySelectorAll('#new-ing .prefs-list-input')].map(el => el.value.trim()).filter(Boolean);
  const steps       = [...document.querySelectorAll('#new-steps .prefs-list-input')].map(el => el.value.trim()).filter(Boolean);
  await saveRecipe({ name, rating, notes, tags, timesPlanned: 0, lastPlanned: '', ingredients, steps });
  renderRecipesPanel();
}

function buildRecipeRepoPrompt() {
  const top = [...recipes]
    .filter(r => r.rating >= 3)
    .sort((a, b) => (b.rating - a.rating) || (b.timesPlanned - a.timesPlanned))
    .slice(0, 15);
  if (!top.length) return '';
  const lines = top.map(r =>
    `- ${r.name} (${'★'.repeat(r.rating||0)}${r.timesPlanned ? ', '+r.timesPlanned+'× made' : ''}${r.notes ? ' — '+r.notes : ''})`
  );
  return `\nRECIPE BOOK (prioritize these when planning — sorted by rating):\n${lines.join('\n')}\n`;
}

// ===== PANTRY =====
async function loadPantry() {
  try {
    const resp = await fetch('/pantry');
    pantry = await resp.json();
  } catch(e) {}
}

async function savePantryItem(data) {
  const resp = await fetch('/pantry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const item = await resp.json();
  await loadPantry();
  return item;
}

async function patchPantryItem(id, data) {
  await fetch(`/pantry/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  await loadPantry();
}

async function removePantryItem(id) {
  const removed = pantry.find(p => p.id === id);
  if (!removed) return;

  // Optimistic remove
  pantry = pantry.filter(p => p.id !== id);
  renderPantryPanel();

  const timer = setTimeout(async () => {
    try { await fetch(`/pantry/${id}`, { method: 'DELETE' }); } catch(e) {}
  }, 4000);

  showToast(`${removed.name} removed`, {
    undoFn: () => {
      clearTimeout(timer);
      pantry.push(removed);
      pantry.sort((a, b) => a.name.localeCompare(b.name));
      renderPantryPanel();
    },
  });
}

function pantryExpiryStatus(expiresOn) {
  if (!expiresOn) return 'none';
  const today = new Date(); today.setHours(0,0,0,0);
  const exp   = new Date(expiresOn + 'T00:00:00');
  const days  = Math.round((exp - today) / 86400000);
  if (days < 0)  return 'expired';
  if (days <= 3) return 'soon';
  if (days <= 7) return 'week';
  return 'ok';
}

function pantryExpiryLabel(expiresOn) {
  if (!expiresOn) return '';
  const today = new Date(); today.setHours(0,0,0,0);
  const exp   = new Date(expiresOn + 'T00:00:00');
  const days  = Math.round((exp - today) / 86400000);
  if (days < 0)  return `expired ${Math.abs(days)}d ago`;
  if (days === 0) return 'expires today';
  if (days === 1) return 'expires tomorrow';
  return `expires in ${days}d`;
}

function openPantryPage(fromHistory = false) {
  if (!fromHistory) history.pushState({ step: currentStep, overlay: 'pantry' }, '');
  document.getElementById('pantryPanel').style.display = 'flex';
  _syncPanelOpen();
  document.getElementById('pantrySearch').value = '';
  renderPantryPanel();
  _pantryTrap = _trapFocus(document.getElementById('pantryPanel'));
}

function closePantryPage(fromHistory = false) {
  if (!fromHistory) history.replaceState({ step: currentStep, overlay: null }, '');
  document.getElementById('pantryPanel').style.display = 'none';
  _syncPanelOpen();
  _pantryTrap?.(); _pantryTrap = null;
}

function togglePantryPanel() {
  const page = document.getElementById('pantryPanel');
  if (page.style.display !== 'none') { closePantryPage(); } else { openPantryPage(); }
}

function renderPantryPanel() {
  const query = (document.getElementById('pantrySearch')?.value || '').toLowerCase();
  let filtered = query
    ? pantry.filter(i => i.name.toLowerCase().includes(query))
    : [...pantry];

  // Sort: expired first, then expiring soon, then by name
  const order = { expired: 0, soon: 1, week: 2, ok: 3, none: 4 };
  filtered.sort((a, b) => {
    const diff = order[pantryExpiryStatus(a.expiresOn)] - order[pantryExpiryStatus(b.expiresOn)];
    return diff !== 0 ? diff : a.name.localeCompare(b.name);
  });

  document.getElementById('pantryList').innerHTML = filtered.length
    ? filtered.map(i => pantryItemHtml(i)).join('')
    : '<div class="hh-loading" style="padding:12px 20px">pantry is empty — add items you have at home</div>';
}

function pantryItemHtml(item) {
  const status = pantryExpiryStatus(item.expiresOn);
  const label  = pantryExpiryLabel(item.expiresOn);
  const amtStr = [item.amount, item.unit].filter(Boolean).join(' ');
  return `<div class="pantry-item ${status}" id="pi-${item.id}">
    <div class="pantry-item-main">
      <div>
        <span class="pantry-name">${item.name}</span>
        ${amtStr ? `<span class="pantry-amt">${amtStr}</span>` : ''}
      </div>
      <div class="pantry-right">
        ${label ? `<span class="pantry-expiry ${status}">${label}</span>` : ''}
        <div class="recipe-actions">
          <button class="btn-icon" onclick="editPantryItem('${item.id}')">edit</button>
          <button class="btn-icon danger" onclick="removePantryItem('${item.id}')" aria-label="Remove ${item.name}">×</button>
        </div>
      </div>
    </div>
  </div>`;
}

function editPantryItem(id) {
  const item = pantry.find(i => i.id === id);
  if (!item) return;
  const el = document.getElementById(`pi-${id}`);
  el.innerHTML = `<div class="pantry-edit-form">
    <input class="recipe-edit-name" id="pe-name-${id}" value="${item.name.replace(/"/g,'&quot;')}" placeholder="item name" />
    <div class="pantry-edit-row">
      <input class="schedule-note" id="pe-amt-${id}"  value="${item.amount||''}"     placeholder="amount (e.g. 2)" style="width:80px" />
      <input class="schedule-note" id="pe-unit-${id}" value="${item.unit||''}"       placeholder="unit (e.g. lbs)" style="width:90px" />
      <input class="schedule-note" id="pe-exp-${id}"  value="${item.expiresOn||''}"  type="date" />
    </div>
    <div class="recipe-edit-actions">
      <button class="btn" onclick="renderPantryPanel()">cancel</button>
      <button class="btn primary" onclick="commitPantryEdit('${id}')">save</button>
    </div>
  </div>`;
}

async function commitPantryEdit(id) {
  const name      = document.getElementById(`pe-name-${id}`).value.trim();
  const amount    = document.getElementById(`pe-amt-${id}`).value.trim();
  const unit      = document.getElementById(`pe-unit-${id}`).value.trim();
  const expiresOn = document.getElementById(`pe-exp-${id}`).value;
  await patchPantryItem(id, { name, amount, unit, expiresOn });
  renderPantryPanel();
}

function addPantryItem() {
  const list = document.getElementById('pantryList');
  if (document.getElementById('pantry-add-form')) return;
  const form = document.createElement('div');
  form.className = 'pantry-item';
  form.id = 'pantry-add-form';
  form.innerHTML = `<div class="pantry-edit-form">
    <input class="recipe-edit-name" id="pa-name" placeholder="item name..." />
    <div class="pantry-edit-row">
      <input class="schedule-note" id="pa-amt"  placeholder="amount" style="width:80px" />
      <input class="schedule-note" id="pa-unit" placeholder="unit"   style="width:90px" />
      <input class="schedule-note" id="pa-exp"  type="date" />
    </div>
    <div class="recipe-edit-actions">
      <button class="btn" onclick="document.getElementById('pantry-add-form').remove()">cancel</button>
      <button class="btn primary" onclick="submitNewPantryItem()">add</button>
    </div>
  </div>`;
  list.prepend(form);
  document.getElementById('pa-name').focus();
}

async function submitNewPantryItem() {
  const name      = (document.getElementById('pa-name')?.value || '').trim();
  if (!name) return;
  const amount    = document.getElementById('pa-amt')?.value.trim()  || '';
  const unit      = document.getElementById('pa-unit')?.value.trim() || '';
  const expiresOn = document.getElementById('pa-exp')?.value         || '';
  const today     = new Date().toISOString().split('T')[0];
  await savePantryItem({ name, amount, unit, expiresOn, addedOn: today });
  renderPantryPanel();
}

function buildPantryPrompt() {
  if (!pantry.length) return '';
  const today = new Date(); today.setHours(0,0,0,0);

  const expiringSoon = pantry.filter(i => {
    const s = pantryExpiryStatus(i.expiresOn);
    return s === 'expired' || s === 'soon' || s === 'week';
  });
  const onHand = pantry.filter(i => !['expired','soon','week'].includes(pantryExpiryStatus(i.expiresOn)));

  let lines = [];
  if (expiringSoon.length) {
    lines.push('PANTRY — USE THESE UP FIRST (expiring soon or expired):');
    expiringSoon.forEach(i => {
      const amt = [i.amount, i.unit].filter(Boolean).join(' ');
      lines.push(`  - ${i.name}${amt ? ' ('+amt+')' : ''} — ${pantryExpiryLabel(i.expiresOn)}`);
    });
  }
  if (onHand.length) {
    lines.push('PANTRY — already stocked (avoid buying duplicates):');
    onHand.forEach(i => {
      const amt = [i.amount, i.unit].filter(Boolean).join(' ');
      lines.push(`  - ${i.name}${amt ? ' ('+amt+')' : ''}`);
    });
  }
  return lines.length ? '\n' + lines.join('\n') + '\n' : '';
}

// ===== WEEKLY RECAP =====
let _orderCsvData = null;

function renderRecapCard() {
  const card = document.getElementById('recapCard');
  if (!card) return;
  if (!prefs.lastWeekMeals?.length) { card.style.display = 'none'; return; }
  // Always start expanded
  const collapsed = document.getElementById('recapCollapsed');
  const full      = document.getElementById('recapFull');
  if (collapsed) collapsed.style.display = 'none';
  if (full)      full.style.display = 'block';
  card.style.display = 'block';
  renderRecapMeals();
}

function toggleRecapSection(name) {
  const body = document.getElementById(`recapBody-${name}`);
  const chev = document.getElementById(`recapChev-${name}`);
  if (!body) return;
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  if (chev) chev.textContent = open ? '›' : '▾';
  if (!open && name === 'pantry') renderRecapPantry();
}

async function handleOrderCsv(input) {
  const file = input.files[0];
  if (!file) return;
  const status  = document.getElementById('orderCsvStatus');
  const preview = document.getElementById('orderCsvPreview');
  status.textContent = 'parsing...';
  preview.style.display = 'none';
  try {
    const text = await file.text();
    const resp = await fetch('/feedback/order-csv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csv: text }),
    });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error);
    _orderCsvData = data;
    status.textContent = `found ${data.pantryItems?.length || 0} items`;
    renderOrderCsvPreview(data);
  } catch(e) {
    status.textContent = 'error — try again';
  }
  input.value = '';
}

function renderOrderCsvPreview(data) {
  const preview = document.getElementById('orderCsvPreview');
  preview.style.display = 'block';
  const items  = data.pantryItems || [];
  const brands = data.brandSuggestions || [];
  let html = '';
  if (items.length) {
    html += `<div class="recap-preview-label">add to pantry</div>
    <div class="recap-pantry-preview">
      ${items.map((item, i) => `<label class="recap-preview-item">
        <input type="checkbox" id="rpi-${i}" checked>
        <span>${item.name}${item.amount ? ' — ' + item.amount + (item.unit ? ' ' + item.unit : '') : ''}</span>
      </label>`).join('')}
    </div>
    <button class="btn primary" onclick="applyOrderCsvItems()" style="margin-top:8px">add checked items →</button>`;
  }
  if (brands.length) {
    html += `<div class="recap-preview-label" style="margin-top:12px">brand notes</div>
    ${brands.map(b => `<div class="recap-hint" style="margin-bottom:4px">• ${b}</div>`).join('')}`;
  }
  if (!items.length && !brands.length) {
    html = '<div class="hh-loading">no grocery items found in CSV</div>';
  }
  preview.innerHTML = html;
}

async function applyOrderCsvItems() {
  if (!_orderCsvData?.pantryItems?.length) return;
  const toAdd = _orderCsvData.pantryItems.filter((_, i) => document.getElementById(`rpi-${i}`)?.checked);
  for (const item of toAdd) {
    try { await savePantryItem({ name: item.name, amount: item.amount || '', unit: item.unit || '' }); } catch(e) {}
  }
  document.getElementById('orderCsvPreview').innerHTML =
    `<div class="hh-loading" style="padding:4px 0">✓ ${toAdd.length} item${toAdd.length !== 1 ? 's' : ''} added to pantry</div>`;
  document.getElementById('orderCsvStatus').textContent = '';
  _orderCsvData = null;
  if (document.getElementById('recapBody-pantry')?.style.display !== 'none') renderRecapPantry();
}

function renderRecapMeals() {
  const list = document.getElementById('recapMealList');
  if (!list) return;
  const lastMeals = prefs.lastWeekMeals || [];
  if (!lastMeals.length) { list.innerHTML = '<div class="hh-loading">no meals from last week</div>'; return; }
  list.innerHTML = lastMeals.map((m, i) => `
    <div class="recap-meal-row">
      <label class="recap-meal-check">
        <input type="checkbox" id="rcm-${i}" checked onchange="toggleRecapMealSub(${i})">
        <span>${m.meal}${m.easyMode ? ' <span class="easy-badge">⚡ easy</span>' : ''}</span>
      </label>
      <input class="schedule-note recap-sub-input" id="rcs-${i}" placeholder="had instead..." style="display:none" />
    </div>`).join('');
}

function toggleRecapMealSub(i) {
  const cb  = document.getElementById(`rcm-${i}`);
  const inp = document.getElementById(`rcs-${i}`);
  if (inp) inp.style.display = cb?.checked ? 'none' : 'inline-block';
}

async function saveRecapMeals() {
  const lastMeals = prefs.lastWeekMeals || [];
  prefs.lastWeekFeedback = lastMeals.map((m, i) => ({
    meal: m.meal,
    ate:  document.getElementById(`rcm-${i}`)?.checked ?? true,
    sub:  document.getElementById(`rcs-${i}`)?.value.trim() || '',
  }));
  try {
    await fetch('/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(prefs) });
  } catch(e) {}
  collapseRecap();
  showToast('Recap saved — Claude will use this for next week\'s plan');
}

function collapseRecap() {
  const collapsed = document.getElementById('recapCollapsed');
  const full      = document.getElementById('recapFull');
  if (collapsed) collapsed.style.display = 'flex';
  if (full)      full.style.display = 'none';
}

function expandRecap() {
  const collapsed = document.getElementById('recapCollapsed');
  const full      = document.getElementById('recapFull');
  if (collapsed) collapsed.style.display = 'none';
  if (full)      full.style.display = 'block';
}

function renderRecapPantry() {
  const list = document.getElementById('recapPantryList');
  if (!list) return;
  const expOrder = { expired: 0, soon: 1, week: 2, ok: 3, none: 4 };
  const sorted = [...pantry].sort((a, b) => {
    const d = expOrder[pantryExpiryStatus(a.expiresOn)] - expOrder[pantryExpiryStatus(b.expiresOn)];
    return d !== 0 ? d : a.name.localeCompare(b.name);
  });
  list.innerHTML = sorted.length
    ? sorted.map(item => recapPantryItemHtml(item)).join('')
    : '<div class="hh-loading">pantry is empty</div>';
}

function recapPantryItemHtml(item) {
  const status = pantryExpiryStatus(item.expiresOn);
  const label  = pantryExpiryLabel(item.expiresOn);
  const amt    = [item.amount, item.unit].filter(Boolean).join(' ');
  const escId  = item.id.replace(/'/g, '&#39;');
  return `<div class="recap-pantry-item pantry-exp-${status}" id="rcp-${item.id}">
    <span class="recap-pantry-name">${item.name}</span>
    <input class="recap-pantry-amt" value="${amt}" placeholder="amount"
      onblur="recapSavePantryAmt('${escId}', this.value)"
      onkeydown="if(event.key==='Enter')this.blur()" />
    ${label ? `<span class="pantry-expiry ${status}">${label}</span>` : ''}
    <button class="hh-item-delete" style="opacity:1" title="remove" onclick="recapRemovePantry('${escId}')">×</button>
  </div>`;
}

async function recapSavePantryAmt(id, val) {
  const parts  = val.trim().split(/\s+/);
  const amount = parts[0] || '';
  const unit   = parts.slice(1).join(' ') || '';
  await patchPantryItem(id, { amount, unit });
  renderRecapPantry();
}

async function recapRemovePantry(id) {
  const removed = pantry.find(p => p.id === id);
  if (!removed) return;

  pantry = pantry.filter(p => p.id !== id);
  renderRecapPantry();

  const timer = setTimeout(async () => {
    try { await fetch(`/pantry/${id}`, { method: 'DELETE' }); } catch(e) {}
  }, 4000);

  showToast(`${removed.name} removed`, {
    undoFn: () => {
      clearTimeout(timer);
      pantry.push(removed);
      renderRecapPantry();
    },
  });
}

async function dismissRecap() {
  prefs.lastWeekMeals    = [];
  prefs.lastWeekFeedback = [];
  try {
    await fetch('/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(prefs) });
  } catch(e) {}
  document.getElementById('recapCard').style.display = 'none';
}

// ===== BREAKFAST / LUNCH PICKS =====
function renderStep0Extras() {
  weekBreakfasts = prefs.defaultBreakfasts?.length ? [...prefs.defaultBreakfasts] : [];
  weekLunches    = prefs.defaultLunches?.length    ? [...prefs.defaultLunches]    : [];
  _pickerOpen.breakfast = !weekBreakfasts.length;
  _pickerOpen.lunch     = !weekLunches.length;
  renderMealPicks('breakfast');
  renderMealPicks('lunch');
}

function renderMealPicks(type) {
  const el = document.getElementById(type === 'breakfast' ? 'breakfastSection' : 'lunchSection');
  if (!el) return;
  const selections = type === 'breakfast' ? weekBreakfasts : weekLunches;
  const options    = type === 'breakfast' ? BREAKFAST_OPTIONS : LUNCH_OPTIONS;
  const emoji      = type === 'breakfast' ? '🍳' : '🥪';
  const noun       = type === 'breakfast' ? 'breakfast' : 'lunch';

  if (!_pickerOpen[type] && selections.length) {
    const names = selections.join(', ');
    el.innerHTML = `<div class="meal-pick-banner">
      <span>${emoji} Keeping last week's ${noun}s — <strong>${names}</strong></span>
      <button class="btn-link" onclick="_pickerOpen['${type}']=true;renderMealPicks('${type}')">change →</button>
    </div>`;
    return;
  }

  const chips = options.map(opt => {
    const sel = selections.includes(opt);
    const esc = opt.replace(/'/g, '&#39;');
    return `<button class="meal-pick-chip${sel ? ' selected' : ''}" onclick="toggleMealPick('${type}','${esc}')">${opt}</button>`;
  }).join('');

  const customChips = selections
    .filter(s => !options.includes(s))
    .map(s => {
      const esc = s.replace(/'/g, '&#39;');
      return `<button class="meal-pick-chip selected" onclick="toggleMealPick('${type}','${esc}')">${s} ×</button>`;
    })
    .join('');

  const hint = selections.length >= 3 ? '<span class="meal-pick-hint">max 3 selected</span>' : '';

  el.innerHTML = `
    <div class="meal-pick-grid">${chips}${customChips}</div>
    ${hint}
    <div class="meal-pick-custom">
      <input type="text" id="${type}Custom" placeholder="+ add your own..." onkeydown="if(event.key==='Enter')addCustomMealPick('${type}')" />
      <button class="btn" style="padding:5px 12px;font-size:12px;height:30px" onclick="addCustomMealPick('${type}')">add</button>
    </div>`;
}

function toggleMealPick(type, option) {
  const arr = type === 'breakfast' ? weekBreakfasts : weekLunches;
  const idx = arr.indexOf(option);
  if (idx >= 0) arr.splice(idx, 1);
  else if (arr.length < 3) arr.push(option);
  renderMealPicks(type);
}

function addCustomMealPick(type) {
  const input = document.getElementById(`${type}Custom`);
  const val   = (input?.value || '').trim();
  if (!val) return;
  const arr = type === 'breakfast' ? weekBreakfasts : weekLunches;
  if (!arr.includes(val) && arr.length < 3) arr.push(val);
  if (input) input.value = '';
  renderMealPicks(type);
}

function renderPantryToggle() {
  const row = document.getElementById('pantryToggleRow');
  if (row) row.style.display = pantry.length ? 'flex' : 'none';
}

// Swap picker with recipe integration
function renderSwapPicker(query) {
  const picker = document.getElementById('swapRecipePicker');
  if (!picker) return;
  const q = (query || '').toLowerCase();
  const filtered = recipes
    .filter(r => !q || r.name.toLowerCase().includes(q))
    .sort((a, b) => (b.rating - a.rating) || (b.timesPlanned - a.timesPlanned))
    .slice(0, 5);
  if (!filtered.length) { picker.innerHTML = ''; return; }
  picker.innerHTML = `<div class="swap-picker-label">from your recipe book:</div>` +
    filtered.map(r => {
      const esc = r.name.replace(/'/g, '&#39;');
      return `<div class="swap-recipe-item" onclick="pickSwapRecipe('${esc}')">
        <span class="swap-recipe-stars">${starsHtml(r.rating)}</span>
        <span class="swap-recipe-name">${r.name}</span>
      </div>`;
    }).join('');
}

function pickSwapRecipe(name) {
  meals[swappingIndex].meal = name;
  meals[swappingIndex].isNew = false;
  cancelSwap();
}

// Post-order rating panel
function showRatingPanel() {
  const panel = document.getElementById('ratingPanel');
  const list  = document.getElementById('ratingList');
  panel.style.display = 'block';
  meals.forEach(m => { pendingRatings[m.meal.replace(' [NEW]','')] = 0; });
  list.innerHTML = meals.map(m => {
    const name = m.meal.replace(' [NEW]','');
    const pid  = 'rate-' + name.replace(/[^a-z0-9]/gi,'-');
    return `<div class="rating-row">
      <span class="rating-meal-name">${name}</span>
      <div class="star-picker" id="${pid}" data-rating="0">${starPickerHtml(pid, 0, 'setRatingStar')}</div>
    </div>`;
  }).join('');
}

function setRatingStar(rating, pickerId) {
  const el = document.getElementById(pickerId);
  if (!el) return;
  el.dataset.rating = rating;
  el.innerHTML = starPickerHtml(pickerId, rating, 'setRatingStar');
  const mealName = meals.find(m => {
    const pid = 'rate-' + m.meal.replace(' [NEW]','').replace(/[^a-z0-9]/gi,'-');
    return pid === pickerId;
  })?.meal.replace(' [NEW]','') || '';
  if (mealName) pendingRatings[mealName] = rating;
}

async function _finalizeWeek() {
  if (!meals.length) return;
  prefs.doNotRepeat = meals.map(m => m.meal.replace(' [NEW]', '').trim());
  try {
    await fetch('/prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prefs),
    });
  } catch(e) {}
}

async function saveRatings() {
  const today = new Date().toISOString().split('T')[0];
  for (const [name, rating] of Object.entries(pendingRatings)) {
    await saveRecipe({ name, rating, tags: [], notes: '', timesPlanned: 1, lastPlanned: today });
  }
  await _finalizeWeek();
  document.getElementById('ratingPanel').style.display = 'none';
}

function skipRating() {
  document.getElementById('ratingPanel').style.display = 'none';
  _finalizeWeek(); // fire and forget
}

// ===== SERVING SIZE =====
function initServingSize() {
  const adults = parseInt(prefs.household?.adults) || 2;
  const kids   = parseInt(prefs.household?.kids)   || 0;
  servingSize  = Math.min(12, Math.max(1, adults + kids)) || 4;
  const val = document.getElementById('servingSizeVal');
  if (val) val.textContent = servingSize;
  _updateStepperButtons();
}

function updateServingSize(v) {
  servingSize = Math.max(1, Math.min(12, parseInt(v) || 1));
  const val = document.getElementById('servingSizeVal');
  if (val) val.textContent = servingSize;
  _updateStepperButtons();
}

function _updateStepperButtons() {
  const minus = document.querySelector('.stepper-btn[aria-label="Fewer servings"]');
  const plus  = document.querySelector('.stepper-btn[aria-label="More servings"]');
  if (minus) minus.disabled = servingSize <= 1;
  if (plus)  plus.disabled  = servingSize >= 12;
}

// ===== MEAL PLAN =====
async function runMealPlan() {
  goToStep(1);
  document.getElementById('loadingBar').style.display = 'flex';
  startMicrocopy(MEAL_PLAN_MSGS, 'loadingMsg');
  document.getElementById('mealPlanCard').style.display = 'none';
  document.getElementById('approveBtn').style.display = 'none';
  const regenBtn = document.getElementById('regenerateBtn');
  if (regenBtn) regenBtn.style.display = 'none';

  // Save breakfast/lunch defaults for next week
  prefs.defaultBreakfasts = [...weekBreakfasts];
  prefs.defaultLunches    = [...weekLunches];
  try {
    await fetch('/prefs', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(prefs) });
  } catch(e) {}

  const prefsText = buildPreferencesPrompt();
  const includeNew = document.getElementById('includeNew').checked;
  const usePantry  = document.getElementById('usePantry')?.checked ?? true;
  const pantrySection = usePantry ? buildPantryPrompt() : '';

  const lastWeekSection = prefs.lastWeekFeedback?.length
    ? `\nLAST WEEK FEEDBACK (use to inform this week's plan):\n${prefs.lastWeekFeedback.map(f =>
        f.ate
          ? `- Made and ate: ${f.meal}`
          : f.sub
            ? `- Skipped ${f.meal}, had "${f.sub}" instead`
            : `- Skipped: ${f.meal}`
      ).join('\n')}\n`
    : '';

  const newMealInstruction = includeNew
    ? `IMPORTANT: Exactly 2 of the 7 meals must be completely new recipes this family has NOT cooked before.
       Choose these based on their taste profile (kid-friendly, protein-forward, comfort food) but pick
       dishes not mentioned anywhere in their history or favorites lists.
       Mark these new meals with [NEW] at the end of the meal name so they stand out.
       The other 5 meals should come from their recipe book or favorites list, rotating in variety.`
    : `All 7 meals should come from the recipe book or favorites list, rotating for variety.`;

  const prompt = `You are a weekly meal planner for a family household in Montana.
Based on the preferences below, generate exactly 7 dinners for the week — one per day Monday through Sunday.
This week they are cooking for ${servingSize} people.
${buildRecipeRepoPrompt()}${pantrySection}${lastWeekSection}
PREFERENCES:
${prefsText}

SCHEDULE (match meal complexity to each day's availability):
${buildSchedulePrompt()}

${newMealInstruction}

Rules:
- Match each meal's cook time and effort to the schedule above — QUICK days need ≤30 min meals, OPEN days can have elaborate recipes
- Prioritize meals from the Recipe Book when available, especially those with high ratings
- Never repeat a meal from the "Do NOT repeat" list
- Vary proteins: no same protein two days in a row
- Keep meals practical and kid-friendly
- Assign one meal per day of the week

Return ONLY a JSON array of exactly 7 objects, no other text, no markdown:
[{"day":"Monday","meal":"Meal Name","isNew":false},{"day":"Tuesday","meal":"Meal Name [NEW]","isNew":true},...]

Set isNew:true only for the brand new recipes.`;

  try {
    const resp = await fetch('/generate-meal-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error || 'Server error');
    const text = data.content.trim().replace(/```json|```/g,'').trim();
    meals = JSON.parse(text);
  } catch(e) {
    meals = [
      {day:'Monday',    meal:"Pasta with Rao's Sauce",         isNew:false},
      {day:'Tuesday',   meal:'Korean Beef Bulgogi Rice Bowl [NEW]', isNew:true},
      {day:'Wednesday', meal:'Meatball Subs',                   isNew:false},
      {day:'Thursday',  meal:'Chicken Pot Pie',                 isNew:false},
      {day:'Friday',    meal:'Stuffed Crust Pizza',             isNew:false},
      {day:'Saturday',  meal:'Smash Burgers with Fries [NEW]',  isNew:true},
      {day:'Sunday',    meal:'Slow Cooker Beef Stew',           isNew:false},
    ];
    stopMicrocopy();
    document.getElementById('loadingMsg').textContent = 'Using demo meals (add Anthropic API key for live generation)';
    setTimeout(() => { document.getElementById('loadingBar').style.display = 'none'; }, 2500);
    renderMeals();
    return;
  }

  stopMicrocopy();
  document.getElementById('loadingBar').style.display = 'none';
  renderMeals();
}

function getUpcomingWeekDates() {
  const today = new Date(); today.setHours(0,0,0,0);
  const dow = today.getDay();
  const toMon = dow === 0 ? 1 : dow === 1 ? 0 : 8 - dow;
  const mon = new Date(today); mon.setDate(today.getDate() + toMon);
  const result = {};
  ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].forEach((d,i) => {
    const dt = new Date(mon); dt.setDate(mon.getDate()+i);
    result[d] = dt.getDate();
  });
  return result;
}

function lookupTags(mealName) {
  const name = mealName.replace(' [NEW]','').trim().toLowerCase();
  const r = recipes.find(r => r.name.toLowerCase() === name);
  return r?.tags || [];
}

function renderMeals() {
  document.getElementById('mealPlanCard').style.display = 'block';
  document.getElementById('approveBtn').style.display = 'inline-flex';
  const regenBtn = document.getElementById('regenerateBtn');
  if (regenBtn) regenBtn.style.display = 'inline-flex';
  const dates = getUpcomingWeekDates();
  const grid = document.getElementById('mealGrid');
  grid.innerHTML = meals.map((m,i) => {
    const isSwapping = swappingIndex === i;
    const tags = lookupTags(m.meal);
    const tagsHtml = tags.map(t => `<span class="tag">${t}</span>`).join('');
    const cx = schedule[m.day]?.complexity || 'normal';
    const cxLabel = COMPLEXITY_LABEL[cx] || 'Normal';
    const dom = dates[m.day] || '';
    const dow = DAY_ABBR[m.day] || m.day.slice(0,3);
    const mealName = m.meal.replace(' [NEW]','');
    const matchedRecipe = recipes.find(rec => rec.name.toLowerCase() === mealName.toLowerCase());
    const mealPhoto = matchedRecipe?.photo ? `<img class="meal-card-photo" src="${matchedRecipe.photo}" alt="">` : '';
    const easyLabel = m.easyLoading ? '...' : (m.easyMode ? 'easy mode' : 'easy');
    const easyTitle = m.easyMode ? 'Using a store-bought version — toggle off for homemade' : 'Switch to a store-bought or frozen version';
    return `
      <div class="meal-card ${m.isNew ? 'new-meal' : ''} ${isSwapping ? 'swapping' : ''} ${m.easyMode ? 'easy-meal' : ''}" id="meal${i}">
        <div class="day-badge">
          <span class="dow">${dow}</span>
          <span class="dom">${dom}</span>
        </div>
        <div class="meal-info">
          <div class="meal-name meal-name-link" onclick="openMealRecipe(${i})">${mealName}</div>
          <div class="meal-tags">
            ${m.isNew ? '<span class="new-badge">✦ new</span>' : ''}
            ${m.easyMode ? '<span class="easy-badge">⚡ easy</span>' : ''}
            ${tagsHtml}
          </div>
        </div>
        ${mealPhoto}
        <span class="cx cx-${cx}">${cxLabel}</span>
        <label class="easy-toggle${m.easyMode ? ' active' : ''}" title="${easyTitle}">
          <input type="checkbox" ${m.easyMode ? 'checked' : ''} ${m.easyLoading ? 'disabled' : ''} onchange="toggleEasyMode(${i}, this.checked)">
          <span>${easyLabel}</span>
        </label>
        <button class="btn-swap ${isSwapping ? 'active' : ''}" onclick="startSwap(${i})" aria-label="Swap ${mealName}">↺ swap</button>
      </div>`;
  }).join('');
}

async function toggleEasyMode(i, checked) {
  if (checked) {
    if (!meals[i].originalMeal) meals[i].originalMeal = meals[i].meal;
    meals[i].easyLoading = true;
    renderMeals();
    try {
      const resp = await fetch('/generate-meal-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: `Give a store-bought or frozen version of exactly this dish: "${meals[i].originalMeal}". Keep the same meal — just make it the easy ready-made version (e.g. "Stuffed Crust Pizza" → "Frozen Stuffed Crust Pizza", "Chicken Tacos" → "Rotisserie Chicken Tacos", "Lasagna" → "Frozen Lasagna"). Return ONLY the new meal name (2–6 words), no quotes, no explanation.` })
      });
      const data = await resp.json();
      if (!resp.ok || data.error) throw new Error(data.error);
      meals[i].meal = data.content.trim().replace(/^["'.]|["'.]$/g, '');
      meals[i].easyMode = true;
    } catch(e) {
      meals[i].meal = meals[i].originalMeal;
      meals[i].easyMode = false;
    }
    meals[i].easyLoading = false;
  } else {
    if (meals[i].originalMeal) meals[i].meal = meals[i].originalMeal;
    meals[i].easyMode = false;
    meals[i].easyLoading = false;
  }
  renderMeals();
}

function startSwap(i) {
  swappingIndex = i;
  renderMeals();
  document.getElementById('swapRow').className = 'swap-input-row visible';
  document.getElementById('swapInput').value = '';
  document.getElementById('swapInput').placeholder = 'or type a different meal...';
  renderSwapPicker('');
  const genBtn = document.getElementById('swapGenBtn');
  if (genBtn) genBtn.style.display = meals[i]?.isNew ? 'inline-flex' : 'none';
  document.getElementById('swapInput').focus();
}

async function generateNewMealIdea() {
  if (swappingIndex < 0) return;
  const btn = document.getElementById('swapGenBtn');
  if (btn) { btn.textContent = 'thinking...'; btn.disabled = true; }
  const m = meals[swappingIndex];
  const exclude = meals.map(x => x.meal.replace(' [NEW]', '').trim());
  try {
    const resp = await fetch('/generate-single-meal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ day: m.day, complexity: schedule[m.day]?.complexity || 'normal', exclude }),
    });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error);
    document.getElementById('swapInput').value = data.meal;
    renderSwapPicker(data.meal);
  } catch(e) {}
  if (btn) { btn.textContent = '✦ new idea'; btn.disabled = false; }
}

function applySwap() {
  const val = document.getElementById('swapInput').value.trim();
  if (val && swappingIndex >= 0) {
    meals[swappingIndex].meal = val;
    meals[swappingIndex].isNew = false;
  }
  cancelSwap();
}

function cancelSwap() {
  swappingIndex = -1;
  document.getElementById('swapRow').className = 'swap-input-row';
  document.getElementById('swapRecipePicker').innerHTML = '';
  renderMeals();
}

// ===== CART =====
async function approveMealPlan() {
  document.getElementById('buildCartBtn').style.display = 'none';
  document.getElementById('cartLoadingBar').style.display = 'none';
  resetCartProgress();
  document.getElementById('cartCard').style.display = 'none';
  document.getElementById('cartError').style.display = 'none';
  document.getElementById('serverNotice').style.display = 'none';
  document.getElementById('doneBtn').style.display = 'none';
  document.getElementById('ratingPanel').style.display = 'none';
  // Save this week's meals so next Sunday's recap can show them
  prefs.lastWeekMeals = meals.map(m => ({
    day: m.day,
    meal: m.meal.replace(' [NEW]', '').trim(),
    easyMode: !!m.easyMode,
  }));
  try {
    await fetch('/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(prefs) });
  } catch(e) {}

  hhExtras = [];
  renderHhExtras();
  goToStep(2); // → Household step
}

async function navigateAndBuildCart() {
  // Save any extras the user flagged "save to my list"
  const toSave = hhExtras.filter(e => e.save).map(e => e.name);
  if (toSave.length) {
    if (!prefs.householdItems) prefs.householdItems = [];
    toSave.forEach(n => {
      const exists = prefs.householdItems.some(i => (typeof i === 'string' ? i : i.name) === n);
      if (!exists) prefs.householdItems.push({ name: n, category: _hhCategory(n), brand: '' });
    });
    try {
      await fetch('/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(prefs) });
    } catch(e) {}
  }
  goToStep(3);
  startCartBuild();
}

async function startCartBuild() {
  document.getElementById('buildCartBtn').style.display = 'none';
  document.getElementById('cartLoadingBar').style.display = 'flex';
  document.getElementById('cartCard').style.display = 'none';
  document.getElementById('cartError').style.display = 'none';
  document.getElementById('serverNotice').style.display = 'none';
  document.getElementById('doneBtn').style.display = 'none';
  document.getElementById('ratingPanel').style.display = 'none';
  resetCartProgress();
  startMicrocopy(CART_BUILD_MSGS, 'cartLoadingMsg', 4000);

  const mealNames = meals.map(m => m.meal.replace(' [NEW]','').trim());

  try {
    const ping = await fetch('/ping');
    if (!ping.ok) throw new Error('Server not responding');
  } catch(e) {
    stopMicrocopy();
    document.getElementById('cartLoadingBar').style.display = 'none';
    document.getElementById('serverNotice').style.display = 'block';
    document.getElementById('buildCartBtn').style.display = 'inline-flex';
    return;
  }

  startCartProgress(72);

  try {
    const resp = await fetch('/build-cart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meals: mealNames, breakfasts: weekBreakfasts, lunches: weekLunches, household: [...householdChecked, ...hhExtras.map(e => e.name)], servings: servingSize, zip: prefs.household?.zip || '59047' })
    });

    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error || 'Unknown server error');

    stopMicrocopy();
    finishCartProgress();
    setTimeout(() => {
      document.getElementById('cartLoadingBar').style.display = 'none';
      renderCart(data.groups || {}, data.mealOrder || [], data.total, data.cartUrl);
    }, 500);

  } catch(e) {
    stopMicrocopy();
    stopCartProgress();
    document.getElementById('cartLoadingBar').style.display = 'none';
    document.getElementById('buildCartBtn').style.display = 'inline-flex';
    const errBox = document.getElementById('cartError');
    errBox.style.display = 'block';
    errBox.textContent = `Cart build error:\n${e.message}\n\nCheck your Terminal for the full error log.`;
  }
}

function setCartView(view) {
  _cartView = view;
  document.getElementById('cartViewMeal').classList.toggle('active', view === 'meal');
  document.getElementById('cartViewCategory').classList.toggle('active', view === 'category');
  if (_cartData) _renderCartList(_cartData.groups, _cartData.mealOrder);
}

function _renderCartList(groups, mealOrder) {
  const list = document.getElementById('cartList');
  if (_cartView === 'category') {
    // Flatten all items, group by grocery category
    const allItems = [];
    mealOrder.forEach(src => (groups[src] || []).forEach(i => allItems.push(i)));
    const catGroups = {};
    allItems.forEach(item => {
      const cat = _hhCategory(item.name);
      if (!catGroups[cat]) catGroups[cat] = [];
      catGroups[cat].push(item);
    });
    list.innerHTML = HH_CATEGORY_ORDER.filter(cat => catGroups[cat]).map(cat => {
      const items = catGroups[cat];
      const groupTotal = items.reduce((sum, i) => sum + parseFloat(i.price.replace('$', '')), 0);
      return `<div class="cart-group">
        <div class="cart-group-header">
          <span class="cart-group-label">${HH_CATEGORY_LABELS[cat] || cat}</span>
          <span class="cart-group-subtotal">$${groupTotal.toFixed(2)}</span>
        </div>
        ${items.map(item => `
          <div class="cart-item">
            <span class="cart-item-name">${item.name}</span>
            <span class="cart-item-price">${item.price}</span>
          </div>`).join('')}
      </div>`;
    }).join('');
  } else {
    const sourcesPresent = mealOrder.filter(src => groups[src]?.length);
    list.innerHTML = sourcesPresent.map(source => {
      const items = groups[source];
      const isSpecial = ['staples', 'household', 'Breakfasts', 'Lunches'].includes(source);
      const label = source === 'staples' ? 'Weekly Staples' : source === 'household' ? 'Household' : source;
      const groupTotal = items.reduce((sum, i) => sum + parseFloat(i.price.replace('$', '')), 0);
      return `<div class="cart-group">
        <div class="cart-group-header">
          <span class="cart-group-label${isSpecial ? ' special' : ''}">${label}</span>
          <span class="cart-group-subtotal">$${groupTotal.toFixed(2)}</span>
        </div>
        ${items.map(item => `
          <div class="cart-item">
            <span class="cart-item-name">${item.name}</span>
            <span class="cart-item-price">${item.price}</span>
          </div>`).join('')}
      </div>`;
    }).join('');
  }
}

function renderCart(groups, mealOrder, total, url) {
  _cartData = { groups, mealOrder, total, url };
  _cartView = 'meal';
  document.getElementById('cartViewMeal').classList.add('active');
  document.getElementById('cartViewCategory').classList.remove('active');
  document.getElementById('cartCard').style.display = 'block';
  document.getElementById('doneBtn').style.display = 'inline-flex';
  document.getElementById('buildCartBtn').style.display = 'none';

  _renderCartList(groups, mealOrder);

  document.getElementById('cartTotal').textContent = total;

  // Budget indicator
  const budgetBar = document.getElementById('budgetBar');
  if (budgetBar) {
    const totalNum  = parseFloat(total.replace('$', '')) || 0;
    const target    = prefs.household?.budgetTarget;
    const budgetMax = prefs.household?.budgetMax;
    if (target) {
      let cls, msg;
      if (totalNum <= target) {
        cls = 'budget-ok';
        msg = `✓ within budget — $${(target - totalNum).toFixed(0)} under $${target} target`;
      } else if (budgetMax && totalNum <= budgetMax) {
        cls = 'budget-warn';
        msg = `↑ $${(totalNum - target).toFixed(0)} over $${target} target — $${(budgetMax - totalNum).toFixed(0)} left before $${budgetMax} max`;
      } else {
        cls = 'budget-over';
        const ref = budgetMax || target;
        msg = `⚠ $${(totalNum - ref).toFixed(0)} over $${ref} ${budgetMax ? 'max' : 'target'} budget`;
      }
      budgetBar.className = `budget-bar ${cls}`;
      budgetBar.textContent = msg;
      budgetBar.style.display = 'block';
    } else {
      budgetBar.style.display = 'none';
    }
  }

  if (url) {
    document.getElementById('cartUrlBox').style.display = 'flex';
    document.getElementById('openCartBtn').onclick = () => window.open(url, '_blank');
  }
}

function confirmOrder() {
  const btn = document.getElementById('doneBtn');
  btn.textContent = '✓ order placed';
  btn.disabled = true;
  btn.className = 'btn mustard';
  showRatingPanel();
}

// ===== PREFERENCES =====
async function loadPrefs() {
  try {
    const resp = await fetch('/prefs');
    prefs = await resp.json();
  } catch(e) { prefs = {}; }
  if (!prefs.timezone) {
    prefs.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Denver';
  }
}

function buildPreferencesPrompt() {
  const h = prefs.household || {};
  const lines = [];
  lines.push(`HOUSEHOLD: Family of ${h.adults || 2} adults + ${h.kids || 0} kids (${h.kidsAges || ''}), zip ${h.zip || '59047'}`);
  lines.push(`BUDGET: Target ~$${h.budgetTarget || 175}, flex to $${h.budgetMax || 225}`);
  if (prefs.dietaryNotes?.length) {
    lines.push('\nDIETARY NOTES:');
    prefs.dietaryNotes.forEach(n => lines.push(`- ${n}`));
  }
  if (prefs.weeklyStaples?.length) {
    lines.push('\nWEEKLY STAPLES (include every order):');
    prefs.weeklyStaples.forEach(s => lines.push(`- ${s}`));
  }
  if (prefs.brandRules?.length) {
    lines.push('\nBRAND RULES (always use these brands):');
    prefs.brandRules.forEach(r => lines.push(`- ${r.item}: ${r.brand}`));
  }
  if (prefs.storeOk) lines.push(`\nSTORE BRAND / GREAT VALUE OK: ${prefs.storeOk}`);
  if (prefs.doNotRepeat?.length) lines.push(`\nDO NOT INCLUDE this week: ${prefs.doNotRepeat.join(', ')}`);
  if (prefs.notes) lines.push(`\nNOTES: ${prefs.notes}`);
  return lines.join('\n');
}

function renderPrefsSummary() {
  const el = document.getElementById('prefsSummary');
  if (!el) return;
  const h = prefs.household || {};
  const kids = h.kids > 0 ? `, ${h.kids} kid${h.kids !== 1 ? 's' : ''}` : '';
  const skipping = prefs.doNotRepeat?.length ? prefs.doNotRepeat.join(', ') : null;
  el.innerHTML = `
    <div class="prefs-summary-grid">
      <div class="prefs-chip"><span class="prefs-chip-label">household</span><span class="prefs-chip-val">${h.adults || 2} adults${kids} · ${h.zip || '59047'}</span></div>
      <div class="prefs-chip"><span class="prefs-chip-label">budget</span><span class="prefs-chip-val">~$${h.budgetTarget || 175} / week</span></div>
      <div class="prefs-chip"><span class="prefs-chip-label">weekly staples</span><span class="prefs-chip-val">${(prefs.weeklyStaples||[]).length} items</span></div>
      <div class="prefs-chip"><span class="prefs-chip-label">brand rules</span><span class="prefs-chip-val">${(prefs.brandRules||[]).length} rules</span></div>
      ${skipping ? `<div class="prefs-chip prefs-chip-skip"><span class="prefs-chip-label">skipping</span><span class="prefs-chip-val">${skipping}</span></div>` : ''}
    </div>`;
}

// ===== PREFERENCES PAGE =====
function openPrefsPage(fromHistory = false) {
  if (!fromHistory) history.pushState({ step: currentStep, overlay: 'prefs' }, '');
  document.getElementById('prefsPage').style.display = 'flex';
  _syncPanelOpen();
  renderPrefsPage();
  _prefsTrap = _trapFocus(document.getElementById('prefsPage'));
}

function closePrefsPage(fromHistory = false) {
  if (!fromHistory) history.replaceState({ step: currentStep, overlay: null }, '');
  document.getElementById('prefsPage').style.display = 'none';
  _syncPanelOpen();
  _prefsTrap?.(); _prefsTrap = null;
}

function switchPrefsTab(tab) {
  ['household', 'mealplan', 'staples', 'brands'].forEach(t => {
    document.getElementById(`prefTab-${t}`).classList.toggle('active', t === tab);
    document.getElementById(`prefContent-${t}`).style.display = t === tab ? '' : 'none';
  });
}

async function savePrefsPage() {
  const btn = document.getElementById('prefsSaveBtn');
  if (btn) { btn.textContent = 'Saving…'; btn.disabled = true; }

  prefs.household = {
    adults:       parseInt(document.getElementById('pf-adults').value) || 2,
    kids:         parseInt(document.getElementById('pf-kids').value) || 0,
    kidsAges:     document.getElementById('pf-kidsAges').value.trim(),
    zip:          document.getElementById('pf-zip').value.trim(),
    budgetTarget: parseInt(document.getElementById('pf-budgetTarget').value) || 175,
    budgetMax:    parseInt(document.getElementById('pf-budgetMax').value) || 225,
  };
  prefs.dietaryNotes    = readPrefsList('pf-dietList');
  prefs.weeklyStaples   = readPrefsList('pf-weeklyList');
  prefs.frequentStaples = readPrefsList('pf-frequentList');
  prefs.brandRules      = readBrandRules();
  prefs.householdItems  = readHhItemsPrefs();
  prefs.storeOk         = document.getElementById('pf-storeOk').value.trim();
  prefs.notes           = document.getElementById('pf-notes').value.trim();
  prefs.timezone        = document.getElementById('pf-timezone').value.trim() || 'America/Denver';

  try {
    await fetch('/prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prefs),
    });
  } catch(e) {}

  renderPrefsSummary();
  closePrefsPage();
  showToast('Preferences saved');
}

function readPrefsList(containerId) {
  return [...document.querySelectorAll(`#${containerId} .prefs-list-input`)]
    .map(el => el.value.trim()).filter(Boolean);
}

function readBrandRules() {
  return [...document.querySelectorAll('#pf-brandList .prefs-brand-row')]
    .map(row => ({
      item:  row.querySelector('.prefs-brand-item').value.trim(),
      brand: row.querySelector('.prefs-brand-value').value.trim(),
    }))
    .filter(r => r.item && r.brand);
}

function renderPrefsPage() {
  const h = prefs.household || {};
  document.getElementById('pf-adults').value       = h.adults ?? 2;
  document.getElementById('pf-kids').value         = h.kids ?? 0;
  document.getElementById('pf-kidsAges').value     = h.kidsAges || '';
  document.getElementById('pf-zip').value          = h.zip || '59047';
  document.getElementById('pf-budgetTarget').value = h.budgetTarget ?? 175;
  document.getElementById('pf-budgetMax').value    = h.budgetMax ?? 225;
  document.getElementById('pf-timezone').value     = prefs.timezone || '';
  document.getElementById('pf-notes').value        = prefs.notes || '';
  document.getElementById('pf-storeOk').value      = prefs.storeOk || '';

  renderPrefsList('pf-dietList',     prefs.dietaryNotes    || []);
  renderPrefsList('pf-weeklyList',   prefs.weeklyStaples   || []);
  renderPrefsList('pf-frequentList', prefs.frequentStaples || []);
  renderBrandList(prefs.brandRules   || []);
  renderHhItemsPrefs((prefs.householdItems || []).map(_normalizeHhItem));

  const btn = document.getElementById('prefsSaveBtn');
  if (btn) { btn.textContent = 'save →'; btn.disabled = false; }
}

function renderPrefsList(containerId, items) {
  document.getElementById(containerId).innerHTML = items.map(v => prefItemHtml(v)).join('');
}

function prefItemHtml(value = '') {
  const esc = value.replace(/"/g, '&quot;');
  return `<div class="prefs-list-item">
    <input class="prefs-list-input" type="text" value="${esc}" />
    <button class="prefs-remove-btn" onclick="this.parentElement.remove()" title="remove">×</button>
  </div>`;
}

function addRecipeListItem(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.insertAdjacentHTML('beforeend', prefItemHtml(''));
  el.querySelector('.prefs-list-item:last-child .prefs-list-input').focus();
}

function addPrefItem(key) {
  const map = { diet:'pf-dietList', weekly:'pf-weeklyList', frequent:'pf-frequentList' };
  const el = document.getElementById(map[key]);
  if (!el) return;
  el.insertAdjacentHTML('beforeend', prefItemHtml(''));
  el.querySelector('.prefs-list-item:last-child .prefs-list-input').focus();
}

function renderBrandList(rules) {
  document.getElementById('pf-brandList').innerHTML = rules.map(r => brandRuleHtml(r.item, r.brand)).join('');
}

function brandRuleHtml(item = '', brand = '') {
  return `<div class="prefs-brand-row">
    <input class="prefs-brand-item" type="text" placeholder="item" value="${item.replace(/"/g,'&quot;')}" />
    <span class="prefs-brand-arrow">→</span>
    <input class="prefs-brand-value" type="text" placeholder="brand or description" value="${brand.replace(/"/g,'&quot;')}" />
    <button class="prefs-remove-btn" onclick="this.parentElement.remove()" title="remove">×</button>
  </div>`;
}

function addBrandRule() {
  document.getElementById('pf-brandList').insertAdjacentHTML('beforeend', brandRuleHtml('', ''));
  document.querySelector('#pf-brandList .prefs-brand-row:last-child .prefs-brand-item').focus();
}

function hhItemPrefHtml(name = '', category = '', brand = '') {
  const nameEsc  = (name  || '').replace(/"/g, '&quot;');
  const brandEsc = (brand || '').replace(/"/g, '&quot;');
  const cat = category || _hhCategory(name);
  const opts = HH_CATEGORY_ORDER.map(c =>
    `<option value="${c}"${c === cat ? ' selected' : ''}>${HH_CATEGORY_LABELS[c]}</option>`
  ).join('');
  return `<div class="prefs-hh-row">
    <input class="prefs-hh-name" type="text" value="${nameEsc}" placeholder="item name" />
    <select class="prefs-hh-cat">${opts}</select>
    <input class="prefs-hh-brand" type="text" value="${brandEsc}" placeholder="brand (opt.)" />
    <button class="prefs-remove-btn" onclick="this.parentElement.remove()" title="remove">×</button>
  </div>`;
}

function renderHhItemsPrefs(items) {
  const el = document.getElementById('pf-hhItemsList');
  if (!el) return;
  el.innerHTML = items.map(i => hhItemPrefHtml(i.name, i.category, i.brand)).join('');
}

function addHhItemPref() {
  const el = document.getElementById('pf-hhItemsList');
  if (!el) return;
  el.insertAdjacentHTML('beforeend', hhItemPrefHtml('', 'other', ''));
  el.querySelector('.prefs-hh-row:last-child .prefs-hh-name').focus();
}

function readHhItemsPrefs() {
  return [...document.querySelectorAll('#pf-hhItemsList .prefs-hh-row')]
    .map(row => ({
      name:     row.querySelector('.prefs-hh-name').value.trim(),
      category: row.querySelector('.prefs-hh-cat').value,
      brand:    row.querySelector('.prefs-hh-brand').value.trim(),
    }))
    .filter(i => i.name);
}

// ===== RECIPE PHOTOS =====
let _photoUploadTarget = null;

function triggerPhotoUpload(recipeId) {
  _photoUploadTarget = recipeId;
  const input = document.getElementById('photoUploadInput');
  input.value = '';
  input.click();
}

async function handlePhotoUpload(input) {
  const file = input.files[0];
  if (!file || !_photoUploadTarget) return;
  const fd = new FormData();
  fd.append('recipe_id', _photoUploadTarget);
  fd.append('file', file);
  try {
    const resp = await fetch('/recipes/photo', { method: 'POST', body: fd });
    const data = await resp.json();
    if (data.url) {
      await loadRecipes();
      renderRecipesPanel();
      renderMeals();
    }
  } catch(e) {}
}

// ===== RECIPE MODAL =====
async function openMealRecipe(i) {
  const mealObj = meals[i];
  if (!mealObj) return;
  const name = mealObj.meal.replace(' [NEW]', '').trim();
  const r = recipes.find(r => r.name.toLowerCase() === name.toLowerCase());

  document.getElementById('recipeModalName').textContent = name;
  const body = document.getElementById('recipeModalBody');
  document.getElementById('recipeModal').style.display = 'flex';

  if (r) {
    const tags = (r.tags||[]).map(t => `<span class="recipe-tag">${t}</span>`).join('');
    body.innerHTML = `
      ${r.photo ? `<img class="recipe-modal-hero" src="${r.photo}" alt="">` : ''}
      <div class="recipe-modal-meta">
        <div style="display:flex;align-items:center;gap:10px">
          ${starsHtml(r.rating)}
          ${r.timesPlanned ? `<span class="recipe-times">${r.timesPlanned}× planned</span>` : ''}
        </div>
        ${tags ? `<div class="recipe-tags" style="margin-top:5px">${tags}</div>` : ''}
        ${r.notes ? `<div class="recipe-notes">${r.notes}</div>` : ''}
      </div>
      ${recipeDetailHtml(r)}`;
    return;
  }

  // Not in recipe book — generate it
  _pendingGeneratedRecipe = null;
  body.innerHTML = `<div class="recipe-modal-generating"><div class="dot"></div><span>Generating recipe...</span></div>`;

  try {
    const resp = await fetch('/generate-recipe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meal: name, easyMode: !!mealObj.easyMode }),
    });
    if (!resp.ok) throw new Error('Server error');
    const generated = await resp.json();
    if (generated.error) throw new Error(generated.error);

    _pendingGeneratedRecipe = { name, ingredients: generated.ingredients || [], steps: generated.steps || [] };

    body.innerHTML = `
      <div class="recipe-modal-ai-note">✦ AI-generated — review before saving</div>
      ${recipeDetailHtml(_pendingGeneratedRecipe)}
      <div class="actions" style="margin-top:14px;justify-content:flex-start">
        <button class="btn mustard" id="saveGenBtn" onclick="saveGeneratedRecipe()">save to recipe book →</button>
      </div>`;
  } catch(e) {
    body.innerHTML = `
      <div class="recipe-modal-not-found">Couldn't generate recipe — make sure the server is running.</div>
      <div class="actions" style="margin-top:10px;justify-content:flex-start">
        <button class="btn" onclick="document.getElementById('recipeModal').style.display='none'; toggleRecipesPanel()">open recipe book →</button>
      </div>`;
  }
}

async function saveGeneratedRecipe() {
  if (!_pendingGeneratedRecipe) return;
  const btn = document.getElementById('saveGenBtn');
  if (btn) { btn.textContent = 'Saving…'; btn.disabled = true; }
  await saveRecipe({
    name:         _pendingGeneratedRecipe.name,
    rating:       0,
    tags:         [],
    notes:        '',
    timesPlanned: 0,
    lastPlanned:  '',
    ingredients:  _pendingGeneratedRecipe.ingredients,
    steps:        _pendingGeneratedRecipe.steps,
  });
  _pendingGeneratedRecipe = null;
  if (btn) { btn.textContent = '✓ saved to recipe book'; btn.disabled = true; }
}

function closeRecipeModal(e) {
  if (e.target === e.currentTarget) document.getElementById('recipeModal').style.display = 'none';
}

// ===== CSV IMPORT =====
async function handlePantryImport(input) {
  const file = input.files[0];
  if (!file) return;
  const btn = document.getElementById('pantryImportBtn');
  if (btn) { btn.textContent = 'importing...'; btn.disabled = true; }
  const fd = new FormData();
  fd.append('file', file);
  try {
    const resp = await fetch('/pantry/import', { method: 'POST', body: fd });
    const result = await resp.json();
    if (!resp.ok || result.error) throw new Error(result.error);
    await loadPantry();
    renderPantryPanel();
    if (btn) btn.textContent = `✓ ${result.imported} added, ${result.updated} updated`;
  } catch(e) {
    if (btn) btn.textContent = '✗ import failed';
  }
  input.value = '';
  if (btn) setTimeout(() => { btn.textContent = 'import CSV'; btn.disabled = false; }, 3000);
}

async function handleRecipesImport(input) {
  const file = input.files[0];
  if (!file) return;
  const btn = document.getElementById('recipesImportBtn');
  if (btn) { btn.textContent = 'importing...'; btn.disabled = true; }
  const fd = new FormData();
  fd.append('file', file);
  try {
    const resp = await fetch('/recipes/import', { method: 'POST', body: fd });
    const result = await resp.json();
    if (!resp.ok || result.error) throw new Error(result.error);
    await loadRecipes();
    renderRecipesPanel();
    if (btn) btn.textContent = `✓ ${result.imported} added, ${result.updated} updated`;
  } catch(e) {
    if (btn) btn.textContent = '✗ import failed';
  }
  input.value = '';
  if (btn) setTimeout(() => { btn.textContent = 'import CSV'; btn.disabled = false; }, 3000);
}

// ===== ONBOARDING WIZARD =====
let wizardStep = 0;
const WIZARD_STEPS = ['household', 'budget', 'dietary', 'staples'];

function checkOnboarding() {
  const h = prefs.household || {};
  if (!h.adults && !h.zip) showWizard();
}

function showWizard() {
  wizardStep = 0;
  renderWizardStep();
  document.getElementById('wizardBackdrop').style.display = 'flex';
}

function closeWizardBackdrop(e) {
  if (e.target === e.currentTarget) {
    document.getElementById('wizardBackdrop').style.display = 'none';
  }
}

function renderWizardStep() {
  const titles = ['Your household', 'Budget', 'Dietary notes', 'Weekly staples'];
  document.getElementById('wizardTitle').textContent = titles[wizardStep];
  document.getElementById('wizardProgress').innerHTML = WIZARD_STEPS.map((_, i) =>
    `<span class="wizard-dot ${i < wizardStep ? 'done' : i === wizardStep ? 'active' : ''}"></span>`
  ).join('');

  const h = prefs.household || {};
  const isLast = wizardStep === WIZARD_STEPS.length - 1;
  const body = document.getElementById('wizardBody');

  if (wizardStep === 0) {
    body.innerHTML = `<div class="wizard-field-group">
      <div class="prefs-household-grid">
        <div class="prefs-field"><label>adults</label><input type="number" id="wz-adults" min="1" max="10" value="${h.adults || 2}" /></div>
        <div class="prefs-field"><label>kids</label><input type="number" id="wz-kids" min="0" max="10" value="${h.kids || 0}" /></div>
        <div class="prefs-field prefs-field-wide"><label>kids ages</label><input type="text" id="wz-kidsAges" placeholder="e.g. ages ~10 and toddler" value="${h.kidsAges || ''}" /></div>
        <div class="prefs-field"><label>zip code</label><input type="text" id="wz-zip" placeholder="59047" value="${h.zip || ''}" /></div>
      </div>
    </div>`;
  } else if (wizardStep === 1) {
    body.innerHTML = `<div class="wizard-field-group">
      <div class="prefs-field" style="max-width:260px"><label>weekly budget target ($)</label><input type="number" id="wz-budgetTarget" value="${h.budgetTarget || 175}" /></div>
      <div class="prefs-field" style="max-width:260px;margin-top:14px"><label>maximum budget ($)</label><input type="number" id="wz-budgetMax" value="${h.budgetMax || 225}" /></div>
    </div>`;
  } else if (wizardStep === 2) {
    const notes = prefs.dietaryNotes || [];
    body.innerHTML = `<div class="wizard-field-group">
      <p class="wizard-hint">Any dietary restrictions, preferences, or things to avoid?</p>
      <div id="wz-dietList" class="prefs-list">${notes.map(v => prefItemHtml(v)).join('')}</div>
      <button class="btn prefs-add-btn" onclick="addWizardListItem('wz-dietList')">+ add note</button>
    </div>`;
  } else if (wizardStep === 3) {
    const staples = prefs.weeklyStaples || [];
    body.innerHTML = `<div class="wizard-field-group">
      <p class="wizard-hint">Items you order every week — milk, bananas, paper towels, etc.</p>
      <div id="wz-stapleList" class="prefs-list">${staples.map(v => prefItemHtml(v)).join('')}</div>
      <button class="btn prefs-add-btn" onclick="addWizardListItem('wz-stapleList')">+ add staple</button>
    </div>`;
  }

  document.getElementById('wizardFooter').innerHTML = `
    ${wizardStep > 0
      ? '<button class="btn" onclick="wizardBack()">← back</button>'
      : '<div></div>'}
    ${isLast
      ? '<button class="btn primary" onclick="wizardFinish()">Done →</button>'
      : '<button class="btn primary" onclick="wizardNext()">Next →</button>'}`;
}

function addWizardListItem(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.insertAdjacentHTML('beforeend', prefItemHtml(''));
  el.querySelector('.prefs-list-item:last-child .prefs-list-input').focus();
}

function wizardCollectStep() {
  if (!prefs.household) prefs.household = {};
  if (wizardStep === 0) {
    prefs.household.adults   = parseInt(document.getElementById('wz-adults')?.value) || 2;
    prefs.household.kids     = parseInt(document.getElementById('wz-kids')?.value) || 0;
    prefs.household.kidsAges = document.getElementById('wz-kidsAges')?.value.trim() || '';
    prefs.household.zip      = document.getElementById('wz-zip')?.value.trim() || '59047';
  } else if (wizardStep === 1) {
    prefs.household.budgetTarget = parseInt(document.getElementById('wz-budgetTarget')?.value) || 175;
    prefs.household.budgetMax    = parseInt(document.getElementById('wz-budgetMax')?.value) || 225;
  } else if (wizardStep === 2) {
    prefs.dietaryNotes = [...document.querySelectorAll('#wz-dietList .prefs-list-input')]
      .map(el => el.value.trim()).filter(Boolean);
  } else if (wizardStep === 3) {
    prefs.weeklyStaples = [...document.querySelectorAll('#wz-stapleList .prefs-list-input')]
      .map(el => el.value.trim()).filter(Boolean);
  }
}

function wizardNext() {
  wizardCollectStep();
  wizardStep++;
  renderWizardStep();
}

function wizardBack() {
  wizardCollectStep();
  wizardStep--;
  renderWizardStep();
}

async function wizardFinish() {
  wizardCollectStep();
  const btn = document.querySelector('#wizardFooter .btn.primary');
  if (btn) { btn.textContent = 'Saving…'; btn.disabled = true; }
  try {
    await fetch('/prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prefs),
    });
  } catch(e) {}
  document.getElementById('wizardBackdrop').style.display = 'none';
  loadHouseholdItems();
}

// ===== INIT =====
history.replaceState({ step: 0, overlay: null }, '');
goToStep(0, true); // true = don't push another history entry on top of the replaceState above
renderSchedule();
loadPrefs().then(() => { renderStep0Extras(); initServingSize(); renderRecapCard(); checkOnboarding(); });
loadHouseholdItems();
loadRecipes();
loadPantry().then(() => renderPantryToggle());
loadCalendarStatus();
