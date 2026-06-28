// ===== THEME =====
const THEME_CYCLE = ['auto', 'dark', 'light'];
const LS_THEME = 'grocery_theme';

function _applyTheme(theme) {
  const html = document.documentElement;
  if (theme === 'auto') html.removeAttribute('data-theme');
  else html.setAttribute('data-theme', theme);
  localStorage.setItem(LS_THEME, theme);
  document.querySelectorAll('input[name="pf-theme"]').forEach(r => { r.checked = r.value === theme; });
}

function initTheme() {
  _applyTheme(localStorage.getItem(LS_THEME) || 'auto');
}

async function doLogout() {
  await fetch('/logout', { method: 'POST' }).catch(() => {});
  window.location.href = '/login';
}

initTheme();

// ===== TOAST SYSTEM =====
function showToast(message, opts = {}) {
  const { type = 'success', duration = 2500, undoFn = null, actionFn = null, actionLabel = null } = opts;
  const hasAction     = undoFn || actionFn;
  const toastType     = hasAction ? 'undo' : type;
  const toastDuration = hasAction ? (opts.duration || 6000) : duration;
  const stack = document.getElementById('toastStack');
  if (!stack) return;
  const toast = document.createElement('div');
  toast.className = `toast ${toastType}`;
  const btnLabel = undoFn ? 'Undo' : (actionLabel || 'OK');
  toast.innerHTML = `<span class="toast-msg">${message}</span>` +
    (hasAction ? `<button class="toast-undo">${btnLabel}</button>` : '');
  if (hasAction) {
    toast.querySelector('.toast-undo').addEventListener('click', () => {
      (undoFn || actionFn)();
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
let athleteItems = [];
let _approvedAthleteItems = new Set();
let _skippedNonDinnerItems = new Set();
let _nonDinnerIngredients = {};
let _nonDinnerExpanded    = new Set();
let swappingIndex = -1;
let recipes = [];
let pantry = [];
let prefs = {};
const pendingRatings = {};
let _pendingGeneratedRecipe = null;
let calendarEvents = null;
let calendarWeek = (() => {
  const day = new Date().getDay(); // 0=Sun, 5=Fri, 6=Sat
  return (day === 0 || day >= 5) ? 'next' : 'current';
})();
let weekBreakfasts = [];
let weekLunches    = [];
let weekDessert    = '';
let weekSnacks     = [];
let weekHoliday    = null; // null or {type: 'Thanksgiving dinner', guests: 12}
const _pickerOpen  = { breakfast: false, lunch: false, dessert: false, snacks: false };
let _dashData      = { days: [], calendarEvents: null, expiringPantry: [], breakfasts: [], lunches: [], dessert: '' };
let _dashMealSheetDay = null;
let _prefsDirty    = false;
let servingSize = 4;
let _cartView = 'meal';          // 'meal' | 'category'
let _cartData = null;            // { groups, mealOrder, total, url } — kept for view toggle
let _cartFilter = '';            // current search query
let _cartDeselected = new Set(); // keys of deselected items ("source-origIdx")
let _prefsTrap = null;           // focus trap cleanup fns
let _recipesTrap = null;
let _pantryTrap = null;

const normName = n => n.toLowerCase().replace(/\d+(\.\d+)?(\s*(oz|lb|ct|pk|g|ml|qt|pt|gal))?\b/gi, '').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();

// Strips quantities, units, AND common food adjectives — used only for overlap comparison, never for display
const INGREDIENT_STOP_WORDS = new Set([
  'yellow','green','red','white','black','brown','purple','orange','pink','dark','light',
  'fresh','frozen','dried','canned','cooked','raw','steamed','steamable','pickled','roasted',
  'diced','chopped','sliced','minced','grated','shredded','crushed','peeled','julienned',
  'large','small','medium','extra','whole','halved','quartered','thin','thick','bite','sized',
  'boneless','skinless','lean','ground','organic','baby','mini','wild','farm',
  'hot','mild','sweet','spicy','smoked','grilled','baked','sauteed','stir','fried',
  'low','sodium','fat','free','reduced','plain','original','style','unsalted','salted',
]);

function normIngredient(name) {
  return name.toLowerCase()
    .replace(/\d+(\.\d+)?(\s*(oz|lb|ct|pk|g|ml|qt|pt|gal|cup|cups|tbsp|tsp|clove|cloves|can|cans|pound|pounds|ounce|ounces))?\b/gi, '')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !INGREDIENT_STOP_WORDS.has(w))
    .join(' ')
    .trim();
}

// ===== INGREDIENT REVIEW STATE =====
let _reviewItems = [];      // [{ key, mealSrc, name, amount, unit, status, combinedInto }]
let _reviewView = 'recipe'; // 'recipe' | 'category'

const BREAKFAST_OPTIONS = ['Scrambled eggs & toast', 'Cereal & milk', 'Pancakes', 'Oatmeal', 'Yogurt & granola', 'Bagels & cream cheese'];
const LUNCH_OPTIONS     = ['Sandwiches', 'Leftovers', 'Grilled cheese', 'Soup', 'Salads', 'Mac & cheese'];
const DESSERT_OPTIONS   = ['Ice cream', 'Cookies', 'Brownies', 'Fruit salad', 'Cheesecake', 'Pudding', 'Pie'];
const SNACK_OPTIONS     = ['Trail mix', 'Chips & salsa', 'Crackers & cheese', 'Popcorn', 'Granola bars', 'Veggies & hummus', 'Fruit'];
const HOLIDAY_OPTIONS   = ['Thanksgiving dinner', 'Christmas dinner', 'Easter brunch', 'Fourth of July cookout', 'Halloween party', 'Birthday party', 'Game day spread', 'Dinner Party', 'Visiting Family & Friends', 'Vacation / Trip'];

function toTitleCase(s) {
  return (s || '').replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

// ===== HOUSEHOLD CATEGORIES =====
const HH_CATEGORIES = {
  produce:   ['apple','banana','orange','grape','strawberr','blueberr','mango','pineapple','avocado','tomato','lettuce','spinach','kale','broccoli','carrot','celery','cucumber','onion','garlic','pepper','potato','zucchini','corn','pear','peach','plum','lemon','lime','melon','berry','berries','salad','mushroom','herb','cilantro','parsley','basil'],
  dairy:     ['milk','butter','cheese','yogurt','cream','egg','eggs','creamer','sour cream','half and half','cottage','kefir','whipped'],
  meat:      ['chicken','beef','pork','salmon','fish','shrimp','turkey','steak','sausage','bacon','ham','tuna','ground','tilapia','lamb','crab','lobster'],
  bakery:    ['bread','bagel','muffin','tortilla','roll','bun','pita','naan','croissant','pretzel','biscuit','sourdough','english muffin'],
  pantry:    ['rice','pasta','flour','sugar','salt','oil','vinegar','sauce','salsa','broth','stock','can','bean','lentil','oat','cereal','granola','crackers','chips','peanut butter','jelly','honey','syrup','ketchup','mustard','mayo','spice','seasoning','ramen','noodle','soup mix'],
  frozen:    ['frozen','ice cream','pizza','fries','nuggets','waffle','edamame'],
  drinks:    ['water','juice','soda','coffee','tea','lemonade','gatorade','wine','beer','sparkling','diet coke','coke','pepsi','sprite','dr pepper','kombucha','drink','creamer'],
  snacks:    ['snack','nut','almond','cashew','walnut','popcorn','cookie','brownie','bar','candy','chocolate','gummy','trail mix'],
  medicine:     ['medicine','vitamin','supplement','ibuprofen','tylenol','aspirin','advil','motrin','benadryl','nyquil','dayquil','pepto','tums','melatonin','zinc','probiotic','antacid','allergy','bandaid','band-aid','cough','remedy','pill','tablet','capsule','prescription'],
  personal_care:['shampoo','conditioner','toothpaste','toothbrush','deodorant','razor','lotion','floss','body wash','face wash','moisturizer','sunscreen','tampon','feminine','mascara','lip balm','cologne','perfume','cotton ball','q-tip'],
  cleaning:     ['detergent','bleach','sponge','laundry','dryer sheet','disinfect','lysol','dish soap','cleaner','sanitizer','wipe','scrub','toilet cleaner','floor cleaner','glass cleaner'],
  household:    ['paper towel','toilet paper','tissue','napkin','trash bag','ziploc','foil','wrap','soap','dish','dryer'],
  baby:         ['diaper','formula','baby','pacifier'],
  pet:          ['dog food','cat food','pet','kibble','litter'],
};
const HH_CATEGORY_ORDER  = ['produce','dairy','meat','bakery','pantry','frozen','drinks','snacks','medicine','personal_care','cleaning','household','baby','pet','other'];
const HH_CATEGORY_LABELS = {
  produce:'Produce', dairy:'Dairy & Eggs', meat:'Meat & Seafood',
  bakery:'Bakery & Bread', pantry:'Pantry', frozen:'Frozen',
  drinks:'Drinks', snacks:'Snacks',
  medicine:'Medicine', personal_care:'Personal Care', cleaning:'Cleaning Supplies', household:'Household',
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
  if (typeof item === 'string') return { name: item, category: _hhCategory(item), brand: '', cadenceDays: 0, lastOrderedOn: '' };
  return {
    name:          item.name     || '',
    category:      item.category || _hhCategory(item.name || ''),
    brand:         item.brand    || '',
    cadenceDays:   parseInt(item.cadenceDays)  || 0,
    lastOrderedOn: item.lastOrderedOn || '',
  };
}

function _hhCadenceBadge(item) {
  if (!item.cadenceDays || !item.lastOrderedOn) return '';
  const today   = new Date(); today.setHours(0, 0, 0, 0);
  const last    = new Date(item.lastOrderedOn + 'T00:00:00');
  const elapsed = Math.round((today - last) / 86400000);
  const overdue = elapsed - item.cadenceDays;
  if (overdue < 0) return '';
  const label   = overdue === 0 ? 'due today' : `overdue ${overdue}d`;
  return `<span class="hh-cadence-badge">${label}</span>`;
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


const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const DAY_ABBR = { Monday:'Mon', Tuesday:'Tue', Wednesday:'Wed', Thursday:'Thu', Friday:'Fri', Saturday:'Sat', Sunday:'Sun' };

// ===== NAVIGATION =====
function goToStep(n, fromHistory = false) {
  [0,1,2,3,4,5,6].forEach(i => {
    const step = document.getElementById('step'+i);
    if (step) step.style.display = i===n ? 'block' : 'none';
    const hero = document.getElementById('heroStep'+i);
    if (hero) {
      if (i < n)      hero.className = 'hero-step-card done';
      else if (i===n) hero.className = 'hero-step-card active';
      else            hero.className = 'hero-step-card todo';
    }
  });
  document.getElementById('mainApp')?.classList.toggle('step0-active', n === 1);
  currentStep = n;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (!fromHistory) history.pushState({ step: n, overlay: null }, '');
  document.querySelectorAll('#step' + n + ' .card').forEach((c, i) => {
    c.classList.remove('animate-in');
    void c.offsetWidth;
    c.style.animationDelay = (i * 40) + 'ms';
    c.classList.add('animate-in');
  });
}

// ===== HISTORY API (browser back button) =====
window.addEventListener('popstate', e => {
  const state = e.state || { step: 0, overlay: null };

  // Close any open overlay without touching history (we're already mid-popstate)
  const prefsOpen    = document.getElementById('prefsPage')?.style.display     !== 'none';
  const recipesOpen  = document.getElementById('recipesPage')?.style.display    !== 'none';
  const pantryOpen   = document.getElementById('pantryPanel')?.style.display    !== 'none';
  const staplesOpen  = document.getElementById('staplesPage')?.style.display    !== 'none';
  const trainingOpen = document.getElementById('trainingPage')?.style.display   !== 'none';
  const holidayOpen  = document.getElementById('holidayPage')?.style.display    !== 'none';
  const historyOpen  = document.getElementById('historyPage')?.style.display    !== 'none';
  if (holidayOpen)  closeHolidayPlanner(true);
  if (prefsOpen)    closePrefsPage(true);
  if (recipesOpen)  closeRecipesPage(true);
  if (pantryOpen)   closePantryPage(true);
  if (staplesOpen)  closeStaplesPage(true);
  if (trainingOpen) closeTrainingPage(true);
  if (historyOpen)  closeHistoryPage(true);

  // Re-open overlay from state (e.g. user pressed forward)
  if      (state.overlay === 'prefs')    openPrefsPage(true);
  else if (state.overlay === 'recipes')  openRecipesPage(true);
  else if (state.overlay === 'pantry')   openPantryPage(true);
  else if (state.overlay === 'staples')  openStaplesPage(true);
  else if (state.overlay === 'training') openTrainingPage(true);
  else if (state.overlay === 'holiday')  openHolidayPlanner(true);
  else if (state.overlay === 'history')  openHistoryPage(true);

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
  if (!normalItems.length) { grid.innerHTML = '<span class="hh-loading">no household items — add some in preferences</span>'; return; }

  const groups = {};
  normalItems.forEach(item => {
    const cat = item.category || _hhCategory(item.name);
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(item);
  });

  let html = '';
  for (const cat of HH_CATEGORY_ORDER) {
    if (!groups[cat]) continue;
    const itemsHtml = groups[cat].map(item => {
      const { name } = item;
      const checked  = householdChecked.has(name);
      const esc      = name.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      const display  = _hhDisplayName(name);
      const badge    = _hhCadenceBadge(item);
      return `<div class="hh-item-row">
        <label class="hh-item">
          <input type="checkbox" ${checked ? 'checked' : ''} onchange="toggleHousehold('${esc}', this.checked)">
          <span class="hh-item-name">${display}</span>
          ${badge}
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
    const validNames = new Set(householdItems.map(i => i.name));
    for (const name of householdChecked) {
      if (!validNames.has(name)) householdChecked.delete(name);
    }
    localStorage.setItem(LS_HOUSEHOLD_KEY, JSON.stringify([...householdChecked]));
    renderHousehold();
  } catch(e) {
    document.getElementById('hhGrid').innerHTML = '<span class="hh-loading">server not running</span>';
  }
}

// ===== FREQUENT STAPLES =====

// ===== STAPLES STATE =====
let staples = [];  // [{id, name, qty, unit, notes}] — loaded from /staples
const LS_STAPLES_SKIP = 'grocery_staples_skip';
let staplesSkipped = new Set(JSON.parse(localStorage.getItem(LS_STAPLES_SKIP) || '[]'));
let staplesOneTime = [];  // [{name, qty}] for this week only, cleared on reset
let _extrasQueueLoaded = false;
let _staplesTrap = null;
let _trainingTrap = null;


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

// ===== SCHEDULE =====
const SCHEDULE_DAYS = [
  { key: 'Sunday',    short: 'Sun', default: 'open'   },
  { key: 'Monday',    short: 'Mon', default: 'normal' },
  { key: 'Tuesday',   short: 'Tue', default: 'normal' },
  { key: 'Wednesday', short: 'Wed', default: 'normal' },
  { key: 'Thursday',  short: 'Thu', default: 'normal' },
  { key: 'Friday',    short: 'Fri', default: 'quick'  },
  { key: 'Saturday',  short: 'Sat', default: 'open'   },
];
const COMPLEXITY_CYCLE = ['normal', 'quick', 'open', 'leftovers', 'out'];
const COMPLEXITY_LABEL = { normal: 'Normal', quick: 'Quick', open: 'Open', leftovers: 'Leftovers', out: 'Out' };
const COMPLEXITY_DESC  = {
  quick:     'QUICK — 30 min or less (frozen, heat-and-eat, or simple assembly)',
  normal:    'NORMAL — standard weeknight (30–60 min)',
  open:      'OPEN — plenty of time (elaborate recipes welcome: lasagna, slow cooker, etc.)',
  leftovers: "LEFTOVERS — using what's in the fridge, no new ingredients needed",
  out:       'OUT — eating out or away from home, no dinner needed',
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
        <button class="complexity-btn ${complexity}" onclick="cycleComplexity('${d.key}')" aria-label="${d.key} dinner complexity: ${COMPLEXITY_LABEL[complexity]}. Click to change.">${COMPLEXITY_LABEL[complexity]}</button>
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
    const resp = await fetch(`/calendar/week?week=${calendarWeek}`);
    if (resp.ok) {
      calendarEvents = await resp.json();
      applyCalendarComplexity();
    }
  } catch(e) {}
}

async function setCalendarWeek(week) {
  calendarWeek = week;
  renderCalBanner({ connected: true, setup: true });
  await loadCalendarEvents();
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
      <div class="cal-week-toggle">
        <button class="cal-week-btn${calendarWeek === 'current' ? ' active' : ''}" onclick="setCalendarWeek('current')">This week</button>
        <button class="cal-week-btn${calendarWeek === 'next' ? ' active' : ''}" onclick="setCalendarWeek('next')">Next week</button>
      </div>
      <button class="cal-disconnect-btn" onclick="disconnectCalendar()">disconnect</button>
    </div>`;
  } else {
    el.innerHTML = `<div class="cal-empty-card">
      <div class="cal-empty-icon">📅</div>
      <div class="cal-empty-body">
        <div class="cal-empty-title">Connect Google Calendar</div>
        <div class="cal-empty-desc">Sync your week's events so the meal planner can match dinner complexity to your schedule.</div>
      </div>
      <a class="btn primary" href="/calendar/auth" target="_blank" rel="noopener" onclick="window._calAuthWin=window.open('/calendar/auth','_calauth','width=520,height=640');return false;">Connect →</a>
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
  if (!meals.length) return;
  // Patch the live meal plan to reflect the complexity change immediately
  const cx = schedule[day].complexity;
  meals = meals.filter(m => m.day !== day);
  if (cx === 'out') {
    meals.push({ day, meal: 'Out', isOut: true, isNew: false });
  } else if (cx === 'leftovers') {
    meals.push({ day, meal: 'Leftovers', isLeftovers: true, isNew: false });
  } else {
    const existing = meals.find(m => m.day === day);
    const entry = existing || { day, meal: '', isNew: false };
    if (cx === 'quick') entry.easyMode = true;
    else entry.easyMode = false;
    if (!existing) meals.push(entry);
  }
  const _ord = SCHEDULE_DAYS.map(d => d.key);
  meals.sort((a, b) => _ord.indexOf(a.day) - _ord.indexOf(b.day));
  renderMeals();
}

function buildSchedulePrompt() {
  return SCHEDULE_DAYS
    .filter(d => !['out', 'leftovers'].includes(schedule[d.key].complexity))
    .map(d => `- ${d.key}: ${COMPLEXITY_DESC[schedule[d.key].complexity]}`)
    .join('\n');
}

// ===== WEEK AT A GLANCE DASHBOARD =====

function _greetingForHour(h) {
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function _expiryLabel(daysLeft) {
  if (daysLeft < 0)  return 'expired';
  if (daysLeft === 0) return 'today';
  if (daysLeft === 1) return 'tomorrow';
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const d = new Date(); d.setDate(d.getDate() + daysLeft);
  return days[d.getDay()];
}

async function loadDashboard() {
  // Populate greeting
  const now = new Date();
  const h = now.getHours();
  const dayNames  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dayName   = dayNames[now.getDay()];
  const dateStr   = `${monthNames[now.getMonth()]} ${now.getDate()}`;

  const timeEl = document.getElementById('dashTimeOfDay');
  const dayEl  = document.getElementById('dashDayName');
  const restEl = document.getElementById('dashDateRest');
  if (timeEl) timeEl.textContent = _greetingForHour(h);
  if (dayEl)  dayEl.textContent  = dayName;
  if (restEl) restEl.textContent = `, ${dateStr}`;

  // Fetch aggregated data
  let data = { days: [], calendarEvents: null, expiringPantry: [], breakfasts: [], lunches: [], dessert: '' };
  try {
    const r = await fetch('/week-glance');
    if (r.ok) data = await r.json();
  } catch(e) {}
  _dashData = data;

  const todayIso = now.toISOString().split('T')[0];
  const todayDay = dayName;

  // Find today's entry
  const todayEntry = data.days.find(d => d.day === todayDay) || data.days.find(d => d.date === todayIso);

  // Render tonight hero card
  const mealEl  = document.getElementById('dashTonightMeal');
  const labelEl = document.getElementById('dashTonightLabel');
  const tagEl   = document.getElementById('dashTonightDateTag');
  const metaEl  = document.getElementById('dashTonightMeta');
  const evtEl   = document.getElementById('dashTonightEvents');

  const tonightName = (todayEntry?.meal && !todayEntry.isOut) ? todayEntry.meal : null;
  if (mealEl) {
    if (tonightName) {
      mealEl.innerHTML   = '';
      mealEl.className   = 'dash-tonight-meal';
      const nameSpan = document.createElement('span');
      nameSpan.textContent = tonightName;
      nameSpan.className   = 'dash-meal-clickable';
      nameSpan.onclick     = () => openDashMealRecipe(tonightName);
      const changeBtn = document.createElement('button');
      changeBtn.className = 'dash-tonight-change';
      changeBtn.textContent = '✎ change';
      changeBtn.onclick = () => openDashMealSheet(todayEntry.day || todayDay);
      mealEl.appendChild(nameSpan);
      mealEl.appendChild(changeBtn);
    } else if (todayEntry?.isOut) {
      mealEl.innerHTML = 'Night out';
      mealEl.className = 'dash-tonight-meal';
      if (todayEntry?.day) {
        const changeBtn = document.createElement('button');
        changeBtn.className = 'dash-tonight-change';
        changeBtn.textContent = '✎ change';
        changeBtn.onclick = () => openDashMealSheet(todayEntry.day);
        mealEl.appendChild(changeBtn);
      }
    } else {
      mealEl.innerHTML = '';
      mealEl.className = 'dash-tonight-meal no-plan';
      const noplanSpan = document.createElement('span');
      noplanSpan.textContent = 'No dinner planned yet';
      mealEl.appendChild(noplanSpan);
      if (todayDay) {
        const changeBtn = document.createElement('button');
        changeBtn.className = 'dash-tonight-change';
        changeBtn.style.opacity = '1';
        changeBtn.textContent = '+ add';
        changeBtn.onclick = () => openDashMealSheet(todayDay);
        mealEl.appendChild(changeBtn);
      }
    }
  }

  if (labelEl) labelEl.textContent = h >= 17 ? 'Tonight' : 'Dinner tonight';
  if (tagEl && todayEntry?.date) {
    const d = new Date(todayEntry.date + 'T12:00:00');
    tagEl.textContent = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }

  // Breakfast / lunch / dessert — always visible, editable on click
  if (metaEl) {
    metaEl.innerHTML = '';
    metaEl.style.display = 'flex';
    _renderDashMeta(metaEl, data);
  }

  // Tonight's calendar events
  const todayEvents = data.calendarEvents ? (data.calendarEvents[todayDay] || []) : [];
  if (evtEl) {
    evtEl.innerHTML = todayEvents.length
      ? todayEvents.map(e =>
          `<span class="dash-cal-pill">
            <span class="dash-cal-pill-time">${e.time}</span>${e.title}
          </span>`
        ).join('')
      : '';
    evtEl.style.display = todayEvents.length ? 'flex' : 'none';
  }

  // Render week grid — dinners are clickable
  const gridEl = document.getElementById('dashWeekGrid');
  if (gridEl && data.days.length) {
    gridEl.innerHTML = data.days.map(d => {
      const isToday   = d.day === todayDay;
      const isPast    = d.date && d.date < todayIso;
      const events    = data.calendarEvents ? (data.calendarEvents[d.day] || []) : [];
      const hasRecipe = d.meal && !d.isOut && !d.isLeftovers;
      const dayClass  = ['dash-day-col',
        isToday ? 'today' : isPast ? 'past' : '',
        d.isOut ? 'out' : (d.isLeftovers ? 'leftovers' : (!d.meal ? 'empty' : '')),
        hasRecipe ? 'has-recipe' : '',
      ].filter(Boolean).join(' ');

      const eventsHtml = events.slice(0, 2).map(e =>
        `<div class="dash-day-event-dot">${e.title}</div>`
      ).join('');

      const escapedDay  = d.day.replace(/'/g, "\\'");
      const mealLabel   = d.isOut ? 'Out' : (d.isLeftovers ? 'Leftovers' : (d.meal || (d.date ? '—' : '')));
      const dinnerHtml  = `<span class="dash-day-dinner">${mealLabel}</span>`;

      return `<div class="${dayClass}" onclick="openDashMealSheet('${escapedDay}')" title="Edit ${d.day} dinner">
        <span class="dash-day-abbr">${d.dayAbbr}</span>
        <span class="dash-day-num">${d.dayNum ?? ''}</span>
        ${dinnerHtml}
        ${eventsHtml ? `<div class="dash-day-events">${eventsHtml}</div>` : ''}
      </div>`;
    }).join('');
  }

  // Expiring pantry — filtered server-side to exclude items already in planned recipes
  const pantrySection = document.getElementById('dashPantrySection');
  const chipsEl = document.getElementById('dashPantryChips');
  if (pantrySection && chipsEl && data.expiringPantry?.length) {
    chipsEl.innerHTML = data.expiringPantry.map(item => {
      const chipClass = (item.daysLeft <= 1 ? 'dash-pantry-chip urgent'
                       : item.daysLeft <= 3 ? 'dash-pantry-chip soon'
                       : 'dash-pantry-chip') + ' clickable';
      const label   = _expiryLabel(item.daysLeft);
      const amt     = item.amount ? ` · ${item.amount}${item.unit ? ' ' + item.unit : ''}` : '';
      const escaped = item.name.replace(/'/g, "\\'");
      return `<span class="${chipClass}" onclick="openPantryIdeas('${escaped}', ${item.daysLeft})" title="Get ideas for ${item.name}">` +
        `${item.name}${amt} <span class="dash-chip-exp">exp ${label}</span></span>`;
    }).join('');
    pantrySection.style.display = 'block';
  } else if (pantrySection) {
    pantrySection.style.display = 'none';
  }

  // CTA hint
  const hintEl = document.getElementById('dashCtaHint');
  const nextSunday = new Date(now);
  nextSunday.setDate(now.getDate() + (7 - now.getDay()) % 7 || 7);
  const nextSundayStr = nextSunday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (hintEl) hintEl.textContent = `next planning session · ${nextSundayStr}`;
}

function openDashMealRecipe(name) {
  if (!name || name === 'Out') return;
  const modalEl = document.getElementById('recipeModal');
  if (!modalEl) return;
  const nameEl = document.getElementById('recipeModalName');
  const bodyEl = document.getElementById('recipeModalBody');
  if (!nameEl || !bodyEl) return;
  const cleanName = name.replace(' [NEW]', '').trim();
  nameEl.textContent = cleanName;
  const _norm = s => s.toLowerCase().replace(/[^a-z0-9 ]/g,'').replace(/\s+/g,' ').trim();
  const _nn = _norm(cleanName);
  let r = recipes.find(r => _norm(r.name) === _nn);
  if (!r) r = recipes.find(r => { const rn = _norm(r.name); return rn.includes(_nn) || _nn.includes(rn); });
  if (r) {
    openRecipeModal(r);
  } else {
    bodyEl.innerHTML = `
      <div class="recipe-modal-not-found" style="margin-bottom:12px">Not in your recipe book yet.</div>
      <div class="actions" style="justify-content:flex-start">
        <button class="btn" onclick="document.getElementById('recipeModal').style.display='none';toggleRecipesPanel()">open recipe book →</button>
      </div>`;
    modalEl.style.display = 'flex';
  }
}

// ===== DASHBOARD PANTRY IDEAS =====
async function openPantryIdeas(itemName, expiresIn) {
  document.getElementById('dashPantrySheetItem').textContent = itemName;
  document.getElementById('dashPantrySheetBody').innerHTML =
    '<div class="dash-pantry-ideas-loading">Getting ideas…</div>';
  document.getElementById('dashPantrySheet').style.display = 'flex';

  const plannedMeals = (_dashData.days || [])
    .map(d => d.meal).filter(m => m && m !== 'Out');

  const r = await fetch('/dashboard/pantry-ideas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item: itemName, plannedMeals, expiresIn }),
  }).catch(() => null);

  const bodyEl = document.getElementById('dashPantrySheetBody');
  if (!bodyEl) return;

  if (!r || !r.ok) {
    bodyEl.innerHTML = '<div class="dash-pantry-ideas-loading">Could not load ideas.</div>';
    return;
  }

  const data = await r.json();
  const lines = (data.ideas || '').trim().split('\n').filter(l => l.trim());
  // Build a map of prior ratings keyed on exact idea text
  const priorRatings = {};
  (data.feedback || []).forEach(f => { priorRatings[f.idea] = f.rating; });

  bodyEl.innerHTML = lines.map(line => {
    const text     = line.replace(/^\d+[.)]\s*/, '').trim();
    const prior    = priorRatings[text] || 0;
    const safeItem = itemName.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const safeText = text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    return `<div class="dash-pantry-idea">
      <span class="dash-idea-text">${text}</span>
      <div class="dash-idea-votes">
        <button class="dash-idea-vote up${prior === 1 ? ' active' : ''}"
                data-item="${safeItem}" data-idea="${safeText}"
                onclick="ratePantryIdea(this,1)" title="Good idea">👍</button>
        <button class="dash-idea-vote down${prior === -1 ? ' active' : ''}"
                data-item="${safeItem}" data-idea="${safeText}"
                onclick="ratePantryIdea(this,-1)" title="Not for us">👎</button>
      </div>
    </div>`;
  }).join('');
}

async function ratePantryIdea(btn, rating) {
  const item    = btn.dataset.item;
  const idea    = btn.dataset.idea;
  const ideaEl  = btn.closest('.dash-pantry-idea');
  const isActive = btn.classList.contains('active');
  const send    = isActive ? 0 : rating;

  ideaEl.querySelectorAll('.dash-idea-vote').forEach(b => b.classList.remove('active'));
  if (!isActive) btn.classList.add('active');

  await fetch('/dashboard/pantry-feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item, idea, rating: send }),
  }).catch(() => null);
}

// ===== DASHBOARD META EDIT (breakfast / lunch) =====
function _renderDashMeta(metaEl, data) {
  const _empty = `<span class="dash-meta-empty">not set</span>`;
  const bfVal  = data.breakfasts?.length ? data.breakfasts.join(', ') : null;
  const lnVal  = data.lunches?.length    ? data.lunches.join(', ')    : null;

  function makeItem(label, value, field) {
    const item = document.createElement('div');
    item.className = 'dash-meta-item';
    item.title = `Edit ${label.toLowerCase()}`;
    item.innerHTML = `<span class="dash-meta-type">${label}</span>` +
      `<span class="dash-meta-value">${value || _empty}</span>` +
      `<span class="dash-meta-edit-hint">edit</span>`;
    item.onclick = () => _startMetaEdit(item, label, value || '', field);
    return item;
  }

  metaEl.appendChild(makeItem('Breakfast', bfVal, 'defaultBreakfasts'));
  metaEl.appendChild(makeItem('Lunch', lnVal, 'defaultLunches'));
  if (data.dessert) {
    metaEl.appendChild(makeItem('Dessert', data.dessert, 'defaultDessert'));
  }
}

function _startMetaEdit(itemEl, label, currentValue, field) {
  const inp = document.createElement('input');
  inp.type      = 'text';
  inp.className = 'dash-meta-input';
  inp.value     = currentValue;
  inp.placeholder = label === 'Dessert' ? 'e.g. Brownies' : 'e.g. Oatmeal, Eggs & toast';
  inp.title = 'Separate options with a comma · Enter to save · Esc to cancel';

  itemEl.innerHTML = `<span class="dash-meta-type">${label}</span>`;
  itemEl.appendChild(inp);
  itemEl.onclick = null;

  let done = false;

  function cancel() {
    if (done) return;
    done = true;
    const metaEl = document.getElementById('dashTonightMeta');
    if (metaEl) { metaEl.innerHTML = ''; _renderDashMeta(metaEl, _dashData); }
  }

  async function save() {
    if (done) return;
    done = true;
    const raw = inp.value.trim();
    const isArray = field !== 'defaultDessert';
    const payload = { [field]: isArray ? raw.split(',').map(s => s.trim()).filter(Boolean) : raw };
    const r = await fetch('/dashboard/meta', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => null);
    if (!r || !r.ok) {
      showToast('Could not save', { type: 'error' });
      const metaEl = document.getElementById('dashTonightMeta');
      if (metaEl) { metaEl.innerHTML = ''; _renderDashMeta(metaEl, _dashData); }
      return;
    }
    if (isArray) {
      if (field === 'defaultBreakfasts') _dashData.breakfasts = payload[field];
      else                               _dashData.lunches    = payload[field];
    } else {
      _dashData.dessert = raw;
    }
    const metaEl = document.getElementById('dashTonightMeta');
    if (metaEl) { metaEl.innerHTML = ''; _renderDashMeta(metaEl, _dashData); }
  }

  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); save(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  inp.addEventListener('blur', save);
  setTimeout(() => inp.focus(), 0);
}

// ===== DASHBOARD MEAL EDITOR SHEET =====
function _closeDashSheet(e, id) {
  if (e && e.target.id !== id) return;
  document.getElementById(id).style.display = 'none';
}

function openDashMealSheet(day) {
  _dashMealSheetDay = day;
  const entry = _dashData.days.find(d => d.day === day) || {};
  const currentMeal = entry.meal || '';

  document.getElementById('dashMealSheetDay').textContent = day;
  const inp = document.getElementById('dashMealSheetInput');
  const isOut = currentMeal === 'Out';
  const isLeftovers = currentMeal === 'Leftovers';
  inp.value = (isOut || isLeftovers) ? '' : currentMeal;

  // Quick action buttons
  const quickEl = document.getElementById('dashMealSheetQuick');
  quickEl.innerHTML = `
    <button class="dash-sheet-action${isOut ? ' out-active' : ''}" onclick="_dashToggleNightOut()">
      ${isOut ? '🏠 back home' : '🌙 night out'}
    </button>
    <button class="dash-sheet-action${isLeftovers ? ' leftovers-active' : ''}" onclick="_dashToggleLeftovers()">
      ${isLeftovers ? '&#8617; cancel' : '&#127374; leftovers'}
    </button>
    ${currentMeal && !isOut && !isLeftovers ? `
      <button class="dash-sheet-action" onclick="openDashMealRecipe('${currentMeal.replace(/'/g, "\\'")}');document.getElementById('dashMealSheet').style.display='none'">
        &#128214; view recipe
      </button>` : ''}
  `;

  // Pantry suggestion chips
  const pantryRow = document.getElementById('dashSheetPantryRow');
  const pantryChips = document.getElementById('dashSheetPantryChips');
  if (_dashData.expiringPantry?.length) {
    pantryChips.innerHTML = _dashData.expiringPantry.slice(0, 5).map(item => {
      const escaped = item.name.replace(/'/g, "\\'");
      return `<span class="dash-pantry-chip" onclick="_dashSuggestMealsFromIngredient('${escaped}')">${item.name}</span>`;
    }).join('');
    pantryRow.style.display = 'block';
  } else {
    pantryRow.style.display = 'none';
  }

  renderDashMealSearch();
  document.getElementById('dashMealSheet').style.display = 'flex';
  setTimeout(() => inp.focus(), 60);
}

function _dashToggleNightOut() {
  const inp = document.getElementById('dashMealSheetInput');
  const isNowOut = inp.value.trim() !== 'Out';
  inp.value = isNowOut ? 'Out' : '';
  const btns = document.getElementById('dashMealSheetQuick').querySelectorAll('.dash-sheet-action');
  btns[0].classList.toggle('out-active', isNowOut);
  btns[0].textContent = isNowOut ? '\u{1F3E0} back home' : '\u{1F319} night out';
  if (isNowOut && btns[1]) { btns[1].classList.remove('leftovers-active'); btns[1].innerHTML = '&#127374; leftovers'; }
  renderDashMealSearch();
}

function _dashToggleLeftovers() {
  const inp = document.getElementById('dashMealSheetInput');
  const isNowLeftovers = inp.value.trim() !== 'Leftovers';
  inp.value = isNowLeftovers ? 'Leftovers' : '';
  const btns = document.getElementById('dashMealSheetQuick').querySelectorAll('.dash-sheet-action');
  btns[1].classList.toggle('leftovers-active', isNowLeftovers);
  btns[1].innerHTML = isNowLeftovers ? '&#8617; cancel' : '&#127374; leftovers';
  if (isNowLeftovers && btns[0]) { btns[0].classList.remove('out-active'); btns[0].textContent = '\u{1F319} night out'; }
  renderDashMealSearch();
}

function _dashRecipeResultHtml(r) {
  const escaped = r.name.replace(/'/g, "\\'");
  const stars   = r.rating ? '★'.repeat(r.rating) : '';
  return `<div class="dash-sheet-result" onclick="_dashPickRecipe('${escaped}')">
    <span>${r.name}</span>
    ${stars ? `<span class="dash-sheet-result-meta">${stars}</span>` : ''}
  </div>`;
}

function renderDashMealSearch() {
  const q = (document.getElementById('dashMealSheetInput')?.value || '').trim().toLowerCase();
  const resultsEl = document.getElementById('dashMealSheetResults');
  if (!resultsEl) return;
  if (!q || q === 'out' || q === 'leftovers') { resultsEl.innerHTML = ''; return; }
  const matches = recipes.filter(r => r.name.toLowerCase().includes(q)).slice(0, 7);
  resultsEl.innerHTML = matches.map(_dashRecipeResultHtml).join('');
}

function _dashPickRecipe(name) {
  document.getElementById('dashMealSheetInput').value = name;
  document.getElementById('dashMealSheetResults').innerHTML = '';
}

function _dashSuggestMealsFromIngredient(itemName) {
  const q = itemName.toLowerCase();
  const matches = recipes.filter(r =>
    (r.ingredients || []).some(ing => {
      const text = typeof ing === 'string' ? ing : (ing.name || '');
      return text.toLowerCase().includes(q);
    })
  ).slice(0, 8);
  const resultsEl = document.getElementById('dashMealSheetResults');
  if (!resultsEl) return;
  const safeItem = itemName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (!matches.length) {
    resultsEl.innerHTML = `<div class="dash-sheet-result" style="color:var(--text3);font-style:italic;pointer-events:none">No recipes found using ${safeItem}</div>`;
    return;
  }
  resultsEl.innerHTML =
    `<div class="dash-sheet-result" style="color:var(--text3);font-size:10px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.06em;pointer-events:none;padding-bottom:2px">Recipes using ${safeItem}</div>` +
    matches.map(_dashRecipeResultHtml).join('');
}

function dashMealKeydown(e) {
  if (e.key === 'Enter') { e.preventDefault(); saveDashMeal(); }
  if (e.key === 'Escape') document.getElementById('dashMealSheet').style.display = 'none';
}

async function saveDashMeal() {
  const meal = (document.getElementById('dashMealSheetInput')?.value || '').trim();
  const day  = _dashMealSheetDay;
  if (!day) return;
  const originalEntry = _dashData.days.find(d => d.day === day) || {};
  const originalMeal  = originalEntry.meal || '';
  document.getElementById('dashMealSheet').style.display = 'none';
  const r = await fetch('/dashboard/meal', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ day, meal }),
  });
  if (r.ok) {
    const wasReal = originalMeal && originalMeal !== 'Out' && originalMeal !== 'Leftovers' && originalMeal !== meal;
    if (wasReal) {
      prefs.nextWeekQueue = [...new Set([...(prefs.nextWeekQueue || []), originalMeal])];
      fetch('/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(prefs) }).catch(() => {});
      showToast(`${originalMeal} queued for next week`, { type: 'info' });
    } else {
      showToast(`${day} updated`, { type: 'success' });
    }
    loadDashboard();
  } else {
    showToast('Could not save', { type: 'error' });
  }
  _dashMealSheetDay = null;
}

function showDashboard() {
  const dash = document.getElementById('dashboardView');
  const main = document.getElementById('mainApp');
  if (dash) dash.style.display = 'block';
  if (main) main.style.display = 'none';
  loadDashboard();
}

function startPlanning() {
  const dash = document.getElementById('dashboardView');
  const main = document.getElementById('mainApp');
  if (dash) dash.style.display = 'none';
  if (main) main.style.display = 'block';
  const startStep = prefs.lastWeekMeals?.length ? 0 : 1;
  history.replaceState({ step: startStep, overlay: null }, '');
  goToStep(startStep, true);
  renderSchedule();
}

function resetApp() {
  meals = [];
  athleteItems = [];
  swappingIndex = -1;
  staplesOneTime = [];
  _extrasQueueLoaded = false;
  ['loadingBar','mealPlanCard','approveBtn','regenerateBtn',
   'tr-itemsCard',
   'cartCard','budgetBar','cartUrlBox','cartLoadingBar',
   'cartError','serverNotice','doneBtn','ratingPanel'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  const buildBtn = document.getElementById('buildCartBtn');
  if (buildBtn) buildBtn.style.display = 'none';
  document.getElementById('swapRow').className = 'swap-input-row';
  showDashboard();
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
  const prefsOpen    = document.getElementById('prefsPage').style.display     !== 'none';
  const recipesOpen  = document.getElementById('recipesPage').style.display    !== 'none';
  const pantryOpen   = document.getElementById('pantryPanel').style.display    !== 'none';
  const staplesOpen  = document.getElementById('staplesPage').style.display    !== 'none';
  const trainingOpen = document.getElementById('trainingPage')?.style.display  !== 'none';
  const historyOpen  = document.getElementById('historyPage')?.style.display   !== 'none';
  document.getElementById('navPrefs').classList.toggle('active', prefsOpen);
  document.getElementById('navRecipes').classList.toggle('active', recipesOpen);
  document.getElementById('navPantry').classList.toggle('active', pantryOpen);
  document.getElementById('navStaples').classList.toggle('active', staplesOpen);
  document.getElementById('navTraining')?.classList.toggle('active', trainingOpen || !!prefs.athleteTraining?.enabled);
  document.getElementById('navHistory')?.classList.toggle('active', historyOpen);
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

async function rebuildAllRecipes() {
  const count = recipes.length;
  if (!count) { showToast('No recipes to rebuild'); return; }
  if (!window.confirm(`Rebuild all ${count} recipe${count !== 1 ? 's' : ''} with updated US units? This overwrites existing ingredients.`)) return;
  const btn = document.getElementById('recipesBackfillBtn');
  const orig = btn ? btn.textContent : 'rebuild all';
  if (btn) { btn.textContent = 'rebuilding...'; btn.disabled = true; }
  try {
    const res = await fetch('/recipes/backfill', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({force: true})
    });
    const data = await res.json();
    await loadRecipes();
    renderRecipesPanel();
    showToast(`Rebuilt ${data.filled} recipe${data.filled !== 1 ? 's' : ''} with updated units`);
  } catch (e) {
    showToast('Rebuild failed — check the server console');
  } finally {
    if (btn) { btn.textContent = orig; btn.disabled = false; }
  }
}

async function regenerateRecipe(id) {
  const btn = document.getElementById(`regen-btn-${id}`);
  if (btn) { btn.textContent = 'regenerating...'; btn.disabled = true; }
  try {
    const res = await fetch(`/recipes/${id}/regenerate`, {method: 'POST'});
    if (!res.ok) throw new Error(res.status);
    const updated = await res.json();
    const recipe = recipes.find(r => r.id === id);
    if (recipe) {
      recipe.ingredients = updated.ingredients;
      recipe.steps = updated.steps;
    }
    editRecipeInline(id);
  } catch (e) {
    showToast('Regenerate failed — check the server console');
    if (btn) { btn.textContent = '↺ regen'; btn.disabled = false; }
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
    ? `<img class="recipe-thumb" src="${r.photo}" alt="${r.name}" onclick="triggerPhotoUpload('${r.id}')" title="change photo">`
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
        <button class="btn-icon" onclick="triggerPhotoUpload('${r.id}')" aria-label="${r.photo ? 'Change photo for ' + r.name : 'Add photo for ' + r.name}">${r.photo ? '📷' : '+ photo'}</button>
        <button class="btn-icon" id="rd-btn-${r.id}" onclick="toggleRecipeDetail('${r.id}')" aria-label="View details for ${r.name}">view ▾</button>
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
      <button class="btn" id="regen-btn-${id}" onclick="regenerateRecipe('${id}')">↺ regen</button>
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

function openRecipeUrlImport() {
  const list = document.getElementById('recipesList');
  if (document.getElementById('url-import-form')) return;
  const form = document.createElement('div');
  form.className = 'recipe-card';
  form.id = 'url-import-form';
  form.innerHTML = `<div class="url-import-inner">
    <div class="url-import-hint">paste a recipe URL (AllRecipes, NYT Cooking, any food blog)</div>
    <div class="url-import-row">
      <input class="recipes-search" id="urlImportInput" placeholder="https://..."
             style="flex:1;margin-bottom:0" onkeydown="if(event.key==='Enter')submitRecipeUrl()">
      <button class="btn primary" onclick="submitRecipeUrl()">import</button>
      <button class="btn" onclick="document.getElementById('url-import-form').remove()">cancel</button>
    </div>
    <span id="urlImportStatus" class="url-import-status"></span>
  </div>`;
  list.prepend(form);
  document.getElementById('urlImportInput').focus();
}

async function submitRecipeUrl() {
  const url = (document.getElementById('urlImportInput')?.value || '').trim();
  if (!url) return;
  const status = document.getElementById('urlImportStatus');
  if (status) status.textContent = 'fetching recipe…';
  try {
    const resp = await fetch('/recipes/url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error || 'Import failed');
    document.getElementById('url-import-form')?.remove();
    await loadRecipes();
    renderRecipesPanel();
    showToast(`"${data.recipe.name}" imported`, { type: 'success' });
    openRecipeModal(data.recipe.id);
  } catch(e) {
    if (status) status.textContent = `Error: ${e.message}`;
  }
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

// ===== STAPLES PANEL =====

async function loadStaples() {
  try {
    const r = await fetch('/staples');
    const d = await r.json();
    staples = d.items || [];
  } catch(e) { staples = []; }
}

function openStaplesPage(fromHistory = false) {
  if (!fromHistory) history.pushState({ step: currentStep, overlay: 'staples' }, '');
  document.getElementById('staplesPage').style.display = 'flex';
  _syncPanelOpen();
  renderStaplesPanel();
  _staplesTrap = _trapFocus(document.getElementById('staplesPage'));
}

function closeStaplesPage(fromHistory = false) {
  if (!fromHistory) history.replaceState({ step: currentStep, overlay: null }, '');
  document.getElementById('staplesPage').style.display = 'none';
  _syncPanelOpen();
  _staplesTrap?.(); _staplesTrap = null;
}

function toggleStaplesPanel() {
  const page = document.getElementById('staplesPage');
  if (page.style.display !== 'none') { closeStaplesPage(); } else { openStaplesPage(); }
}

function openTrainingPage(fromHistory = false) {
  if (!fromHistory) history.pushState({ step: currentStep, overlay: 'training' }, '');
  document.getElementById('trainingPage').style.display = 'flex';
  _syncPanelOpen();
  renderTrainingPanel();
  _trainingTrap = _trapFocus(document.getElementById('trainingPage'));
}

function closeTrainingPage(fromHistory = false) {
  if (!fromHistory) history.replaceState({ step: currentStep, overlay: null }, '');
  document.getElementById('trainingPage').style.display = 'none';
  _syncPanelOpen();
  _trainingTrap?.(); _trainingTrap = null;
}

function toggleTrainingPanel() {
  const page = document.getElementById('trainingPage');
  if (page.style.display !== 'none') closeTrainingPage();
  else openTrainingPage();
}

function toggleTrainingEnabled() {
  const enabled = document.getElementById('tr-enabled')?.checked;
  const fields = document.getElementById('tr-fields');
  if (fields) fields.style.display = enabled ? 'block' : 'none';
}

function renderTrainingPanel() {
  const at = prefs.athleteTraining || {};
  const enabled = document.getElementById('tr-enabled');
  if (enabled) enabled.checked = !!at.enabled;
  const raceName = document.getElementById('tr-raceName');
  if (raceName) raceName.value = at.raceName || '';
  const raceDate = document.getElementById('tr-raceDate');
  if (raceDate) raceDate.value = at.raceDate || '';
  const phase = document.getElementById('tr-trainingPhase');
  if (phase) phase.value = at.phase || 'Base Building';
  const longRunDay = document.getElementById('tr-longRunDay');
  if (longRunDay) longRunDay.value = at.longRunDay || 'Saturday';
  const longRunMi = document.getElementById('tr-longRunMi');
  if (longRunMi) longRunMi.value = at.weeklyLongRunMi || '';
  const appetite = document.getElementById('tr-appetiteSensitive');
  if (appetite) appetite.checked = !!at.appetiteSensitive;
  const runDaySet = new Set(at.runDays || []);
  document.querySelectorAll('.tr-runDay').forEach(cb => { cb.checked = runDaySet.has(cb.value); });
  toggleTrainingEnabled();
  const itemsCard = document.getElementById('tr-itemsCard');
  if (itemsCard) {
    if (athleteItems.length > 0) {
      itemsCard.style.display = 'block';
      _renderAthleteList();
    } else {
      itemsCard.style.display = 'none';
    }
  }
}

async function saveTrainingPrefs() {
  prefs.athleteTraining = {
    enabled:          document.getElementById('tr-enabled').checked,
    raceName:         document.getElementById('tr-raceName').value.trim(),
    raceDate:         document.getElementById('tr-raceDate').value.trim(),
    phase:            document.getElementById('tr-trainingPhase').value,
    longRunDay:       document.getElementById('tr-longRunDay').value,
    weeklyLongRunMi:  parseFloat(document.getElementById('tr-longRunMi').value) || null,
    runDays:          [...document.querySelectorAll('.tr-runDay:checked')].map(cb => cb.value),
    appetiteSensitive: document.getElementById('tr-appetiteSensitive').checked,
  };
  const btn = document.querySelector('#trainingPage .prefs-page-header .btn.primary');
  if (btn) { btn.disabled = true; btn.textContent = 'saving…'; }
  try {
    await fetch('/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(prefs) });
    showToast('Training settings saved');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'save →'; }
  }
  _syncPanelOpen();
}

function renderStaplesPanel() {
  const el = document.getElementById('staplesPanelList');
  if (!el) return;
  if (!staples.length) {
    el.innerHTML = '<div class="hh-loading">no staples yet — click + add to get started</div>';
    return;
  }
  el.innerHTML = staples.map((s, idx) => {
    const esc      = s.id.replace(/'/g, '&#39;');
    const cachedDot = s.itemId
      ? `<span class="staple-cached-dot" title="Walmart product cached: ${(s.productName||'').replace(/"/g,'&quot;')}">●</span>`
      : '';
    return `<div class="staple-panel-row" id="spr-${s.id}">
      <div class="staple-panel-main">
        <div style="display:flex;align-items:center;gap:4px">
          <input class="staple-panel-name" value="${(s.name||'').replace(/"/g,'&quot;')}" placeholder="name"
            onblur="patchStaple('${esc}','name',this.value)" onkeydown="if(event.key==='Enter')this.blur()" />
          ${cachedDot}
        </div>
        ${s.notes ? `<div class="staple-notes-sub">${s.notes.replace(/</g,'&lt;')}</div>` : ''}
        <div class="staple-panel-meta">
          <input class="staple-panel-qty" type="number" min="1" value="${s.qty || 1}"
            onblur="patchStaple('${esc}','qty',+this.value)" onkeydown="if(event.key==='Enter')this.blur()" />
          <input class="staple-panel-unit" value="${(s.unit||'').replace(/"/g,'&quot;')}" placeholder="unit (gallon, bunch…)"
            onblur="patchStaple('${esc}','unit',this.value)" onkeydown="if(event.key==='Enter')this.blur()" />
        </div>
        <input class="staple-panel-notes" value="${(s.notes||'').replace(/"/g,'&quot;')}" placeholder="add brand notes…"
          onblur="patchStaple('${esc}','notes',this.value)" onkeydown="if(event.key==='Enter')this.blur()" />
      </div>
      <div class="staple-panel-actions">
        <button class="staple-reorder-btn" onclick="moveStaple('${esc}',-1)" ${idx===0?'disabled':''} title="move up" aria-label="Move ${s.name} up">↑</button>
        <button class="staple-reorder-btn" onclick="moveStaple('${esc}',1)" ${idx===staples.length-1?'disabled':''} title="move down" aria-label="Move ${s.name} down">↓</button>
        <button class="hh-item-delete" onclick="deleteStaplePanel('${esc}')" title="remove" aria-label="Remove ${s.name}">×</button>
      </div>
    </div>`;
  }).join('');
}

function addStapleFromPanel() {
  const list = document.getElementById('staplesPanelList');
  if (document.getElementById('staple-add-form')) return;
  const form = document.createElement('div');
  form.className = 'staple-panel-row';
  form.id = 'staple-add-form';
  form.innerHTML = `
    <div class="staple-panel-main">
      <input class="staple-panel-name" id="saf-name" placeholder="name (e.g. Whole milk)"
        onkeydown="if(event.key==='Enter')_submitNewStaple();if(event.key==='Escape')document.getElementById('staple-add-form').remove()" />
      <div class="staple-panel-meta">
        <input class="staple-panel-qty" type="number" min="1" value="1" id="saf-qty"
          onkeydown="if(event.key==='Enter')_submitNewStaple();if(event.key==='Escape')document.getElementById('staple-add-form').remove()" />
        <input class="staple-panel-unit" id="saf-unit" placeholder="unit (gallon, bunch…)"
          onkeydown="if(event.key==='Enter')_submitNewStaple();if(event.key==='Escape')document.getElementById('staple-add-form').remove()" />
      </div>
      <input class="staple-panel-notes" id="saf-notes" placeholder="brand notes (optional)"
        onkeydown="if(event.key==='Enter')_submitNewStaple();if(event.key==='Escape')document.getElementById('staple-add-form').remove()" />
    </div>
    <div class="staple-panel-actions">
      <button class="btn primary" style="height:30px;padding:0 14px;font-size:12px" onclick="_submitNewStaple()">add</button>
      <button class="btn" style="height:30px;padding:0 10px;font-size:12px" onclick="document.getElementById('staple-add-form').remove()">cancel</button>
    </div>`;
  list.prepend(form);
  document.getElementById('saf-name').focus();
}

async function _submitNewStaple() {
  const name  = (document.getElementById('saf-name')?.value  || '').trim();
  if (!name) return;
  const qty   = parseInt(document.getElementById('saf-qty')?.value)   || 1;
  const unit  = (document.getElementById('saf-unit')?.value  || '').trim();
  const notes = (document.getElementById('saf-notes')?.value || '').trim();
  document.getElementById('staple-add-form')?.remove();
  try {
    const r = await fetch('/staples', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({name, qty, unit, notes}),
    });
    const item = await r.json();
    staples.push(item);
    renderStaplesPanel();
    renderStaplesStep();
  } catch(e) { showToast('Could not add staple', {type:'error'}); }
}

async function patchStaple(id, field, value) {
  try {
    await fetch(`/staples/${id}`, {
      method: 'PATCH',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({[field]: value}),
    });
    const s = staples.find(x => x.id === id);
    if (s) s[field] = value;
    renderStaplesStep();
  } catch(e) {}
}

async function deleteStaplePanel(id) {
  const item = staples.find(s => s.id === id);
  if (!item) return;
  staples = staples.filter(s => s.id !== id);
  renderStaplesPanel();
  renderStaplesStep();
  try {
    await fetch(`/staples/${id}`, {method: 'DELETE'});
  } catch(e) {}
  showToast(`${item.name} removed`, {
    undoFn: async () => {
      try {
        const r = await fetch('/staples', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({name: item.name, qty: item.qty, unit: item.unit, notes: item.notes}),
        });
        const newItem = await r.json();
        staples.push(newItem);
        renderStaplesPanel();
        renderStaplesStep();
      } catch(e) {}
    },
  });
}

async function moveStaple(id, dir) {
  const idx = staples.findIndex(s => s.id === id);
  if (idx < 0) return;
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= staples.length) return;
  [staples[idx], staples[newIdx]] = [staples[newIdx], staples[idx]];
  renderStaplesPanel();
  try {
    await fetch('/staples/reorder', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ids: staples.map(s => s.id)}),
    });
  } catch(e) {}
}

// ===== STAPLES STEP (Step 4) =====

async function loadExtrasQueue() {
  if (_extrasQueueLoaded) return;
  _extrasQueueLoaded = true;
  try {
    const res = await fetch('/extras-queue');
    const data = await res.json();
    const newItems = (data.items || []).filter(name =>
      !staplesOneTime.some(o => o.name.toLowerCase() === name.toLowerCase())
    );
    if (newItems.length) {
      newItems.forEach(name => staplesOneTime.push({ name, qty: 1 }));
      _renderOneTimeList();
      const badge = document.createElement('div');
      badge.textContent = `${newItems.length} item${newItems.length > 1 ? 's' : ''} added from your phone`;
      badge.style.cssText = 'background:var(--accent,#4caf50);color:#fff;padding:8px 14px;border-radius:8px;font-size:13px;margin-bottom:12px';
      badge.id = 'extrasQueueBadge';
      document.getElementById('staplesOneTimeList')?.before(badge);
      setTimeout(() => badge.remove(), 5000);
    } else if (!data.exists && !document.getElementById('icloudSetupHint')) {
      const hint = document.createElement('p');
      hint.id = 'icloudSetupHint';
      hint.className = 'review-hint';
      hint.style.cssText = 'margin-top:8px;font-size:11px;color:var(--text3)';
      hint.innerHTML = `📱 <strong>iPhone extras:</strong> create <code>${data.path}</code> — type items one per line and they'll appear here.`;
      const anchor = document.querySelector('#step4 .card') || document.getElementById('staplesOneTimeList');
      anchor?.after(hint);
    }
  } catch (_) {}
}

function renderStaplesStep() {
  const el = document.getElementById('staplesStepList');
  if (!el) return;
  if (!staples.length) {
    el.innerHTML = '<div class="hh-loading">no staples configured — <button class="btn-link" onclick="toggleStaplesPanel()">open staples panel</button> to add some</div>';
    return;
  }
  // Clean up skipped IDs that no longer exist
  const validIds = new Set(staples.map(s => s.id));
  for (const id of staplesSkipped) { if (!validIds.has(id)) staplesSkipped.delete(id); }
  localStorage.setItem(LS_STAPLES_SKIP, JSON.stringify([...staplesSkipped]));

  el.innerHTML = staples.map(s => {
    const checked = !staplesSkipped.has(s.id);
    const esc = s.id.replace(/'/g, '&#39;');
    const meta = [s.qty, s.unit].filter(Boolean).join(' ');
    return `<div class="hh-item-row staple-step-row">
      <label class="hh-item" style="flex:1">
        <input type="checkbox" ${checked?'checked':''} onchange="toggleStapleSkip('${esc}',this.checked)">
        <span class="hh-item-name">${s.name}</span>
        ${meta ? `<span class="staple-step-meta">${meta}</span>` : ''}
      </label>
      <input class="staple-step-qty" type="number" min="1" value="${s.qty || 1}" title="qty for this week"
        onchange="updateStapleQtyLocal('${esc}',+this.value)" style="${checked?'':'opacity:0.35;pointer-events:none'}" />
    </div>`;
  }).join('');
  _renderOneTimeList();
  loadExtrasQueue();
}

function _renderOneTimeList() {
  const el = document.getElementById('staplesOneTimeList');
  if (!el) return;
  el.innerHTML = staplesOneTime.map((o, i) =>
    `<div class="hh-item-row">
      <span class="hh-item-name" style="flex:1">${o.name}${o.qty > 1 ? ` ×${o.qty}` : ''}</span>
      <button class="hh-item-delete" style="opacity:1" onclick="removeOneTimeStaple(${i})">×</button>
    </div>`
  ).join('');
}

function toggleStapleSkip(id, checked) {
  if (checked) staplesSkipped.delete(id);
  else         staplesSkipped.add(id);
  localStorage.setItem(LS_STAPLES_SKIP, JSON.stringify([...staplesSkipped]));
  renderStaplesStep();
}

function updateStapleQtyLocal(id, qty) {
  const s = staples.find(x => x.id === id);
  if (s) s.qty = qty;
}

function addOneTimeStaple() {
  const input = document.getElementById('staplesOneTimeInput');
  const val = (input?.value || '').trim();
  if (!val) return;
  staplesOneTime.push({name: val, qty: 1});
  if (input) input.value = '';
  _renderOneTimeList();
}

function removeOneTimeStaple(idx) {
  staplesOneTime.splice(idx, 1);
  _renderOneTimeList();
}

function proceedToReview() {
  goToStep(5);
  startIngredientReview();
}

function navigateToStaples() {
  goToStep(4);
  renderStaplesStep();
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
  const name      = toTitleCase((document.getElementById('pa-name')?.value || '').trim());
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
    lines.push('SUGGESTED: plan at least 1 dinner this week that uses one of the above items.');
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
  renderRecapRating();
  _loadAndRenderSpendHistory();
}

async function _loadAndRenderSpendHistory() {
  const row = document.getElementById('spendHistoryRow');
  if (!row) return;
  try {
    const resp = await fetch('/spend-history');
    if (!resp.ok) return;
    const history = await resp.json();
    if (!history.length) { row.style.display = 'none'; return; }
    const recent = history.slice(-6);
    const budgetTarget = prefs.household?.budgetTarget || 175;
    const budgetMax    = prefs.household?.budgetMax    || 225;
    const items = recent.map(w => {
      const d     = new Date(w.date + 'T12:00:00');
      const label = d.toLocaleDateString('en-US', {month: 'short', day: 'numeric'});
      const color = w.total <= budgetTarget ? 'var(--success, #4caf50)'
                  : w.total <= budgetMax    ? 'var(--warn, #ff9800)'
                  : 'var(--danger, #e53935)';
      return `<span class="spend-chip" style="color:${color}" title="${w.mealCount} meals">${label}: $${w.total.toFixed(0)}</span>`;
    }).join('<span class="spend-sep">·</span>');
    row.innerHTML = `<span class="spend-label">spend history</span>${items}<button class="btn-link" onclick="openHistoryPage()" style="margin-left:auto;font-size:11px;white-space:nowrap">view all →</button>`;
    row.style.display = 'flex';
  } catch(e) { row.style.display = 'none'; }
}

function toggleRecapSection(name) {
  const body = document.getElementById(`recapBody-${name}`);
  const chev = document.getElementById(`recapChev-${name}`);
  if (!body) return;
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  if (chev) chev.textContent = open ? '›' : '▾';
  if (!open && name === 'pantry') renderRecapPantry();
  if (!open && name === 'rating') renderRecapRating();
}

function renderRecapRating() {
  const list = document.getElementById('recapRatingList');
  if (!list) return;
  const lastMeals = prefs.lastWeekMeals || [];
  if (!lastMeals.length) { list.innerHTML = '<div class="hh-loading">no meals from last week</div>'; return; }
  lastMeals.forEach(m => { if (!(m.meal in pendingRatings)) pendingRatings[m.meal] = 0; });
  const blocked = new Set(prefs.neverSuggest || []);
  list.innerHTML = lastMeals.map(m => {
    const pid    = 'rate-' + m.meal.replace(/[^a-z0-9]/gi, '-');
    const rating = pendingRatings[m.meal] || 0;
    const nsHtml = blocked.has(m.meal)
      ? `<button class="btn never-suggest-btn" disabled>✓ blocked</button>`
      : '';
    return `<div class="rating-row">
      <span class="rating-meal-name">${m.meal}</span>
      <div class="star-picker" id="${pid}" data-rating="${rating}">${starPickerHtml(pid, rating, 'setRatingStar')}</div>
      ${nsHtml}
    </div>`;
  }).join('');
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

async function handleOrderPdf(input) {
  const file = input.files[0];
  if (!file) return;
  const status  = document.getElementById('orderCsvStatus');
  const preview = document.getElementById('orderCsvPreview');
  status.textContent = 'reading PDF...';
  preview.style.display = 'none';
  try {
    const buf   = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary  = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const b64   = btoa(binary);
    status.textContent = 'parsing...';
    const resp = await fetch('/feedback/order-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdf: b64 }),
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
    const today = new Date();
    html += `<div class="recap-preview-label">add to pantry</div>
    <div class="recap-pantry-preview">
      ${items.map((item, i) => {
        const days = item.shelfDays || 14;
        const exp  = new Date(today); exp.setDate(today.getDate() + days);
        const expStr = exp.toISOString().split('T')[0];
        const amtStr = item.amount ? ` — ${item.amount}${item.unit ? ' ' + item.unit : ''}` : '';
        return `<div class="recap-preview-item">
          <label style="display:flex;align-items:center;gap:8px;flex:1;cursor:pointer">
            <input type="checkbox" id="rpi-${i}" checked>
            <span>${item.name}${amtStr}</span>
          </label>
          <input class="recap-pantry-amt" type="date" id="rpi-exp-${i}" value="${expStr}" title="expiry date" style="width:130px" onclick="event.stopPropagation()">
        </div>`;
      }).join('')}
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
  try {
    await fetch('/pantry/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: toAdd.map(item => {
        const origIdx = _orderCsvData.pantryItems.indexOf(item);
        const expEl   = document.getElementById(`rpi-exp-${origIdx}`);
        return { name: toTitleCase(item.name), amount: item.amount || '', unit: item.unit || '', expiresOn: expEl?.value || '' };
      }) }),
    });
    await loadPantry();
  } catch(e) {}
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
  goToStep(1);
}

// ===== BREAKFAST / LUNCH / DESSERT PICKS =====
function renderStep0Extras() {
  weekBreakfasts = prefs.defaultBreakfasts?.length ? [...prefs.defaultBreakfasts] : [];
  weekLunches    = prefs.defaultLunches?.length    ? [...prefs.defaultLunches]    : [];
  weekDessert    = prefs.defaultDessert            || '';
  weekSnacks     = prefs.defaultSnacks?.length ? [...prefs.defaultSnacks] : [];
  weekHoliday    = null;
  _pickerOpen.breakfast = !weekBreakfasts.length;
  _pickerOpen.lunch     = !weekLunches.length;
  _pickerOpen.dessert   = false;
  _pickerOpen.snacks    = false;
  renderMealPicks('breakfast');
  renderMealPicks('lunch');
  renderDessertPick();
  renderSnackPick();
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
    return `<button class="meal-pick-chip${sel ? ' selected' : ''}" onclick="toggleMealPick('${type}','${esc}')" aria-pressed="${sel ? 'true' : 'false'}">${opt}</button>`;
  }).join('');

  const customChips = selections
    .filter(s => !options.includes(s))
    .map(s => {
      const esc = s.replace(/'/g, '&#39;');
      return `<button class="meal-pick-chip selected" onclick="toggleMealPick('${type}','${esc}')" aria-pressed="true">${s} ×</button>`;
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
  if (input) input.value = '';
  _showPickerConfirm(type, val);
}

function renderDessertPick() {
  const el = document.getElementById('dessertSection');
  if (!el) return;

  if (!_pickerOpen.dessert) {
    if (weekDessert) {
      el.innerHTML = `<div class="meal-pick-banner">
        <span>🍩 ${weekDessert}</span>
        <button class="btn-link" onclick="_pickerOpen.dessert=true;renderDessertPick()">change →</button>
      </div>`;
    } else {
      el.innerHTML = `<div class="meal-pick-banner">
        <span style="opacity:0.6">no dessert this week</span>
        <button class="btn-link" onclick="_pickerOpen.dessert=true;renderDessertPick()">add one →</button>
      </div>`;
    }
    return;
  }

  const chips = DESSERT_OPTIONS.map(opt => {
    const sel = weekDessert === opt;
    const esc = opt.replace(/'/g, '&#39;');
    return `<button class="meal-pick-chip${sel ? ' selected' : ''}" onclick="setDessert('${esc}')">${opt}</button>`;
  }).join('');

  const customChip = weekDessert && !DESSERT_OPTIONS.includes(weekDessert)
    ? `<button class="meal-pick-chip selected" onclick="setDessert('')">${weekDessert} ×</button>`
    : '';

  el.innerHTML = `
    <div class="meal-pick-grid">${chips}${customChip}</div>
    <div class="meal-pick-custom">
      <input type="text" id="dessertCustom" placeholder="+ something else..." onkeydown="if(event.key==='Enter')addCustomDessert()" />
      <button class="btn" style="padding:5px 12px;font-size:12px;height:30px" onclick="addCustomDessert()">add</button>
    </div>
    ${weekDessert ? '<div style="text-align:right;margin-top:4px"><button class="btn-link" onclick="setDessert(\'\')">skip dessert</button></div>' : ''}`;
}

function setDessert(name) {
  weekDessert = name;
  _pickerOpen.dessert = false;
  renderDessertPick();
}

function addCustomDessert() {
  const input = document.getElementById('dessertCustom');
  const val   = (input?.value || '').trim();
  if (!val) return;
  if (input) input.value = '';
  _showPickerConfirm('dessert', val);
}

function renderSnackPick() {
  const el = document.getElementById('snacksSection');
  if (!el) return;

  if (!_pickerOpen.snacks && weekSnacks.length) {
    el.innerHTML = `<div class="meal-pick-banner">
      <span>🍿 ${weekSnacks.join(', ')}</span>
      <button class="btn-link" onclick="_pickerOpen.snacks=true;renderSnackPick()">change →</button>
    </div>`;
    return;
  }

  if (!_pickerOpen.snacks) {
    el.innerHTML = `<div class="meal-pick-banner">
      <span style="opacity:0.6">no snacks this week</span>
      <button class="btn-link" onclick="_pickerOpen.snacks=true;renderSnackPick()">add some →</button>
    </div>`;
    return;
  }

  const chips = SNACK_OPTIONS.map(opt => {
    const sel = weekSnacks.includes(opt);
    const esc = opt.replace(/'/g, '&#39;');
    return `<button class="meal-pick-chip${sel ? ' selected' : ''}" onclick="toggleSnack('${esc}')">${opt}</button>`;
  }).join('');

  const customChips = weekSnacks.filter(s => !SNACK_OPTIONS.includes(s)).map(s => {
    const esc = s.replace(/'/g, '&#39;');
    return `<button class="meal-pick-chip selected" onclick="toggleSnack('${esc}')">${s} ×</button>`;
  }).join('');

  const hint = weekSnacks.length >= 3 ? '<span class="meal-pick-hint">max 3 selected</span>' : '';

  el.innerHTML = `
    <div class="meal-pick-grid">${chips}${customChips}</div>
    ${hint}
    <div class="meal-pick-custom">
      <input type="text" id="snacksCustom" placeholder="+ something else..." onkeydown="if(event.key==='Enter')addCustomSnack()" />
      <button class="btn" style="padding:5px 12px;font-size:12px;height:30px" onclick="addCustomSnack()">add</button>
    </div>`;
}

function toggleSnack(option) {
  const idx = weekSnacks.indexOf(option);
  if (idx >= 0) weekSnacks.splice(idx, 1);
  else if (weekSnacks.length < 3) weekSnacks.push(option);
  renderSnackPick();
}

function addCustomSnack() {
  const input = document.getElementById('snacksCustom');
  const val   = (input?.value || '').trim();
  if (!val) return;
  if (input) input.value = '';
  _showPickerConfirm('snack', val);
}

// ===== PICKER CONFIRM MODAL =====

function _commitPickerItem(type, name) {
  if (type === 'breakfast' || type === 'lunch') {
    const arr = type === 'breakfast' ? weekBreakfasts : weekLunches;
    if (!arr.includes(name) && arr.length < 3) arr.push(name);
    renderMealPicks(type);
  } else if (type === 'dessert') {
    setDessert(name);
  } else if (type === 'snack') {
    if (!weekSnacks.includes(name) && weekSnacks.length < 3) weekSnacks.push(name);
    renderSnackPick();
  }
}

function _resolvePickerConfirm(type, rawName, resolvedName) {
  document.getElementById('pickerConfirmBackdrop').style.display = 'none';
  // When user picked a clarifying option (not "add as raw"), combine: "Frozen pre-made smoothie"
  const finalName = resolvedName !== rawName
    ? `${resolvedName} ${rawName.toLowerCase()}`
    : rawName;
  _commitPickerItem(type, finalName);
}

async function _showPickerConfirm(type, rawName) {
  const backdrop = document.getElementById('pickerConfirmBackdrop');
  const title    = document.getElementById('pickerConfirmTitle');
  const body     = document.getElementById('pickerConfirmBody');
  title.textContent = rawName;
  body.innerHTML = '<span class="hh-loading">thinking...</span>';
  backdrop.style.display = 'flex';

  try {
    const resp = await fetch('/picker-clarify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, name: rawName }),
    });
    const data = await resp.json();

    if (!data.question || !data.options?.length) {
      backdrop.style.display = 'none';
      _commitPickerItem(type, rawName);
      return;
    }

    const escRaw = rawName.replace(/'/g, '&#39;');
    const chipsHtml = data.options.map(opt => {
      const escOpt = opt.replace(/'/g, '&#39;');
      return `<button class="meal-pick-chip" onclick="_resolvePickerConfirm('${type}','${escRaw}','${escOpt}')">${opt}</button>`;
    }).join('');

    body.innerHTML = `
      <p class="picker-confirm-q">${data.question}</p>
      <div class="meal-pick-grid" style="margin-top:10px">${chipsHtml}</div>
      <div style="text-align:right;margin-top:12px">
        <button class="btn-link" onclick="_resolvePickerConfirm('${type}','${escRaw}','${escRaw}')">add as &ldquo;${rawName}&rdquo; →</button>
      </div>`;
  } catch(e) {
    backdrop.style.display = 'none';
    _commitPickerItem(type, rawName);
  }
}

// ===== HOLIDAY PLANNER =====

function openHolidayPlanner(fromHistory = false) {
  if (!fromHistory) history.pushState({ step: currentStep, overlay: 'holiday' }, '');
  const page = document.getElementById('holidayPage');
  if (!page) return;
  page.style.display = 'flex';
  _renderHolidayPlanner();
}

function closeHolidayPlanner(fromHistory = false) {
  if (!fromHistory) history.replaceState({ step: currentStep, overlay: null }, '');
  document.getElementById('holidayPage').style.display = 'none';
}

function _renderHolidayPlanner() {
  const curType = weekHoliday?.type || '';
  const curGuests = weekHoliday?.guests || (parseInt(prefs.household?.adults || 2) + parseInt(prefs.household?.kids || 0) + 4);
  const picker = document.getElementById('hpTypePicker');
  if (picker) {
    picker.innerHTML = HOLIDAY_OPTIONS.map(opt => {
      const esc = opt.replace(/'/g, '&#39;');
      return `<button class="meal-pick-chip${curType === opt ? ' selected' : ''}" data-opt="${esc}" onclick="selectHpType('${esc}')">${opt}</button>`;
    }).join('');
  }
  const gEl = document.getElementById('hpGuests');
  if (gEl) gEl.value = curGuests;
  const mode = curType === 'Vacation / Trip' ? 'vacation' : curType === 'Visiting Family & Friends' ? 'hosting' : 'event';
  _syncHpMode(mode);
  const btn = document.getElementById('hpGenerateBtn');
  if (btn) {
    if (mode === 'hosting') { btn.textContent = 'plan visit meals →'; btn.onclick = generateHostingPlan; }
    else { btn.textContent = 'generate menu →'; btn.onclick = generateHolidayMenu; }
  }
  if (mode === 'vacation' && weekHoliday) {
    const ttEl = document.getElementById('hpTripType');
    if (ttEl) ttEl.value = weekHoliday.tripType || 'Road trip';
    _updateKitchenToggleVisibility(weekHoliday.tripType || 'Road trip');
    const hkEl = document.getElementById('hpHasKitchen');
    if (hkEl) hkEl.checked = !!weekHoliday.hasKitchen;
    const vacDaySet = new Set(weekHoliday.vacDays || []);
    document.querySelectorAll('.hp-vac-day').forEach(cb => { cb.checked = vacDaySet.has(cb.value); });
    if (weekHoliday.plan) {
      _renderTravelPlanEdit(weekHoliday.plan);
      document.getElementById('hpTravelCard').style.display = 'block';
      document.getElementById('hpNotesCard').style.display = 'block';
    } else if (weekHoliday.items?.length) {
      const tc = document.getElementById('hpTravelCard');
      if (tc) {
        tc.style.display = 'block';
        const body = document.getElementById('hpTravelBody');
        if (body) body.innerHTML = `<div class="travel-day-section-legacy"><textarea class="prefs-notes-area travel-meal-ta" data-day="legacy" data-meal="Items" rows="8">${weekHoliday.items.join('\n')}</textarea></div>`;
      }
      document.getElementById('hpNotesCard').style.display = 'block';
    }
  } else if (mode === 'hosting' && weekHoliday?.nights) {
    _renderHostingEdit(weekHoliday.nights);
    const vd = document.getElementById('hpVisitDays');
    if (vd) vd.value = weekHoliday.visitDays || weekHoliday.nights.length || 3;
    document.getElementById('hpMenuCard').style.display = 'block';
    document.getElementById('hpNotesCard').style.display = 'block';
  } else if (mode === 'event' && weekHoliday?.menu) {
    _renderHolidayMenuEdit(weekHoliday.menu);
    document.getElementById('hpNotesCard').style.display = 'block';
  }
  const nEl = document.getElementById('hpNotes');
  if (nEl) nEl.value = weekHoliday?.notes || '';
  const tEl = document.getElementById('hpTimeline');
  if (tEl) tEl.value = weekHoliday?.timeline || '';
}

function selectHpType(type) {
  document.querySelectorAll('#hpTypePicker .meal-pick-chip').forEach(c => c.classList.toggle('selected', c.dataset.opt === type));
  const mode = type === 'Vacation / Trip' ? 'vacation' : type === 'Visiting Family & Friends' ? 'hosting' : 'event';
  _syncHpMode(mode);
  const btn = document.getElementById('hpGenerateBtn');
  if (btn) {
    if (mode === 'hosting') { btn.textContent = 'plan visit meals →'; btn.onclick = generateHostingPlan; }
    else { btn.textContent = 'generate menu →'; btn.onclick = generateHolidayMenu; }
  }
}

function _syncHpMode(mode) {
  const gr   = document.getElementById('hpGuestsRow');
  const vc   = document.getElementById('hpVacationControls');
  const hc   = document.getElementById('hpHostingControls');
  const mc   = document.getElementById('hpMenuCard');
  const tc   = document.getElementById('hpTravelCard');
  const nc   = document.getElementById('hpNotesCard');
  const tr   = document.getElementById('hpTimelineRow');
  if (gr) gr.style.display  = mode === 'vacation' ? 'none' : 'flex';
  if (vc) vc.style.display  = mode === 'vacation' ? 'block' : 'none';
  if (hc) hc.style.display  = mode === 'hosting'  ? 'block' : 'none';
  if (mc) mc.style.display  = 'none';
  if (tc) tc.style.display  = 'none';
  if (nc) nc.style.display  = 'none';
  if (tr) tr.style.display  = mode === 'event' ? '' : 'none';
}

function _updateKitchenToggleVisibility(tripType) {
  const row = document.getElementById('hpKitchenRow');
  if (!row) return;
  const noKitchenTypes = ['Flight', 'Hotel stay'];
  row.style.display = noKitchenTypes.includes(tripType) ? 'none' : '';
  if (tripType === 'Cabin / Rental') {
    const cb = document.getElementById('hpHasKitchen');
    if (cb) cb.checked = true;
  }
}

async function generateHolidayMenu() {
  const selected = document.querySelector('#hpTypePicker .meal-pick-chip.selected');
  if (!selected) { showToast('Pick an event type first'); return; }
  const type = selected.dataset.opt;
  const guests = parseInt(document.getElementById('hpGuests')?.value) || 8;
  const btn = document.getElementById('hpGenerateBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'generating...'; }
  const menuCard = document.getElementById('hpMenuCard');
  const menuBody = document.getElementById('hpMenuBody');
  if (menuCard) menuCard.style.display = 'block';
  if (menuBody) menuBody.innerHTML = '<span class="hh-loading">Asking Claude for menu ideas...</span>';
  try {
    const resp = await fetch('/claude-prompt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: `Plan a ${type} menu for ${guests} people. Return ONLY valid JSON with no extra text:\n{"appetizers":["...","..."],"mains":["..."],"sides":["...","...","...","..."],"desserts":["...","..."]}\nUse 2-3 appetizers, 1-2 mains, 4-6 sides, 1-2 desserts. Specific dish names only.` }),
    });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error);
    const menu = JSON.parse((data.content || '').replace(/```json|```/g, '').trim());
    _renderHolidayMenuEdit(menu);
    const nc = document.getElementById('hpNotesCard'); if (nc) nc.style.display = 'block';
  } catch(e) {
    if (menuBody) menuBody.innerHTML = '<div class="recap-hint" style="color:var(--urgent-red-text)">Could not generate menu — try again.</div>';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'generate menu →'; }
  }
}

async function generateVacationPlan() {
  const tripType   = document.getElementById('hpTripType')?.value || 'Road trip';
  const hasKitchen = document.getElementById('hpHasKitchen')?.checked || false;
  const vacDays    = [...document.querySelectorAll('.hp-vac-day:checked')].map(cb => cb.value);
  const n          = vacDays.length || 3;
  const people     = servingSize || 4;
  const btn = document.getElementById('hpVacGenBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'planning...'; }
  const tc   = document.getElementById('hpTravelCard');
  const body = document.getElementById('hpTravelBody');
  if (tc) tc.style.display = 'block';
  if (body) body.innerHTML = '<span class="hh-loading">Planning your trip food…</span>';
  const destNote = hasKitchen
    ? `They have kitchen access at the destination — plan easy meals to cook there.`
    : 'No kitchen access — they will eat out or use a hotel for destination meals.';
  const destMealsExample = hasKitchen
    ? '[{"type":"Breakfast","items":["Instant oatmeal packets","Granola bars"],"eatOut":false},{"type":"Dinner","items":["Rotisserie chicken","Pre-made salad kit"],"eatOut":false}]'
    : '[]';
  const prompt = `Plan food for a family of ${people} on a ${n}-day ${tripType.toLowerCase()}.
${destNote}

Return ONLY valid JSON, no markdown:
{
  "travelDays": [
    {
      "label": "Travel day",
      "meals": [
        {"type": "Breakfast", "items": ["Overnight oats","Bananas"], "eatOut": false},
        {"type": "Snacks & Lunch", "items": ["Trail mix","String cheese","Apples","Crackers"], "eatOut": false},
        {"type": "Dinner", "items": [], "eatOut": true}
      ]
    }
  ],
  "destinationDays": {
    "label": "Days at destination",
    "eatOut": ${!hasKitchen},
    "meals": ${destMealsExample}
  }
}

Rules:
- Road trip: hearty breakfast before departure, snacks for driving hours, variety for kids
- Flight: no liquids >3oz, compact and TSA-friendly, nothing that needs refrigeration
- Cabin/Rental with kitchen: simple 1-pan dinners, assume minimal cookware
- Hotel stay: breakfast items only, travel snacks
- All items must be real buyable Walmart grocery products with normal consumer packaging
- Scale quantities for ${people} people`;
  try {
    const resp = await fetch('/claude-prompt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error);
    const plan = JSON.parse((data.content || '').replace(/```json|```/g, '').trim());
    _renderTravelPlanEdit(plan);
    document.getElementById('hpNotesCard').style.display = 'block';
  } catch(e) {
    if (body) body.innerHTML = '<div class="recap-hint" style="color:var(--urgent-red-text)">Could not generate — try again or add items manually.</div>';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'plan this trip →'; }
  }
}

function _renderTravelPlanEdit(plan) {
  const body = document.getElementById('hpTravelBody');
  if (!body) return;
  const renderMeals = meals => meals.map(meal => {
    if (meal.eatOut) {
      return `<div class="travel-meal-row">
        <span class="travel-meal-label">${meal.type}</span>
        <span class="travel-eat-out-note">Eating out — no items needed</span>
      </div>`;
    }
    const val  = (meal.items || []).join('\n');
    const rows = Math.max(2, (meal.items || []).length + 1);
    return `<div class="travel-meal-row">
      <span class="travel-meal-label">${meal.type}</span>
      <textarea class="prefs-notes-area travel-meal-ta" data-meal="${meal.type}" rows="${rows}" placeholder="one item per line…">${val}</textarea>
    </div>`;
  }).join('');
  const sections = [];
  for (const day of (plan.travelDays || [])) {
    sections.push(`<details class="travel-day-section" open>
      <summary>${day.label || 'Travel day'}</summary>
      ${renderMeals(day.meals || [])}
    </details>`);
  }
  const dest = plan.destinationDays;
  if (dest) {
    if (dest.eatOut) {
      sections.push(`<details class="travel-day-section" open>
        <summary>${dest.label || 'Destination days'}</summary>
        <span class="travel-eat-out-note">Eating out — no items needed</span>
      </details>`);
    } else {
      sections.push(`<details class="travel-day-section" open>
        <summary>${dest.label || 'Destination days'}</summary>
        ${renderMeals(dest.meals || [])}
      </details>`);
    }
  }
  body.innerHTML = sections.join('');
}

async function generateHostingPlan() {
  const guests = parseInt(document.getElementById('hpGuests')?.value) || 6;
  const nights = parseInt(document.getElementById('hpVisitDays')?.value) || 3;
  const total  = guests + (servingSize || 4);
  const btn = document.getElementById('hpGenerateBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'planning...'; }
  const menuCard = document.getElementById('hpMenuCard');
  const menuBody = document.getElementById('hpMenuBody');
  if (menuCard) menuCard.style.display = 'block';
  if (menuBody) menuBody.innerHTML = '<span class="hh-loading">Planning visit meals…</span>';
  const prefsText = buildPreferencesPrompt();
  const prompt = `Generate a dinner plan for ${total} people for ${nights} nights.
A family is hosting out-of-town visitors. Match their preferences where possible.
${prefsText ? `Family preferences:\n${prefsText}\n` : ''}
Return ONLY valid JSON array, no markdown:
[
  {"night": 1, "dinner": "Sheet Pan Lemon Herb Chicken", "sides": ["Roasted vegetables","Dinner rolls"]},
  {"night": 2, "dinner": "Taco Bar", "sides": ["Spanish rice","Black beans","All toppings"]},
  {"night": 3, "dinner": "Spaghetti & Meatballs", "sides": ["Caesar salad","Garlic bread"]}
]
Rules: crowd-pleasing, make-ahead-friendly, practical grocery-store ingredients, vary proteins each night, feeds ${total} people.`;
  try {
    const resp = await fetch('/claude-prompt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error);
    const nightsData = JSON.parse((data.content || '').replace(/```json|```/g, '').trim());
    _renderHostingEdit(nightsData);
    document.getElementById('hpNotesCard').style.display = 'block';
  } catch(e) {
    if (menuBody) menuBody.innerHTML = '<div class="recap-hint" style="color:var(--urgent-red-text)">Could not generate — try again.</div>';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'plan visit meals →'; }
  }
}

function _renderHostingEdit(nights) {
  const menuCard = document.getElementById('hpMenuCard');
  const menuBody = document.getElementById('hpMenuBody');
  if (!menuCard || !menuBody) return;
  menuCard.style.display = 'block';
  menuBody.innerHTML = nights.map((n, i) => {
    const idx   = n.night || (i + 1);
    const sides = Array.isArray(n.sides) ? n.sides.join('\n') : (n.sides || '');
    const rows  = Math.max(2, (Array.isArray(n.sides) ? n.sides.length : 1) + 1);
    return `<div class="hosting-night-block">
      <span class="prefs-sublabel">Night ${idx}</span>
      <input class="staple-panel-name hosting-dinner-input" value="${(n.dinner||'').replace(/"/g,'&quot;')}" placeholder="dinner name" data-night="${idx}">
      <textarea class="prefs-notes-area hosting-sides-ta" rows="${rows}" data-night="${idx}" placeholder="sides, one per line…">${sides}</textarea>
    </div>`;
  }).join('');
}

function _renderHolidayMenuEdit(menu) {
  const menuCard = document.getElementById('hpMenuCard');
  const menuBody = document.getElementById('hpMenuBody');
  if (!menuCard || !menuBody) return;
  menuCard.style.display = 'block';
  const sections = [
    { key: 'appetizers', label: 'Appetizers' },
    { key: 'mains',      label: 'Mains' },
    { key: 'sides',      label: 'Sides' },
    { key: 'desserts',   label: 'Desserts' },
  ];
  menuBody.innerHTML = sections.map(s => {
    const items = (menu[s.key] || []);
    const rows  = Math.max(2, items.length + 1);
    return `<div class="holiday-menu-section">
      <span class="prefs-sublabel">${s.label}</span>
      <textarea class="prefs-notes-area" id="hpMenu-${s.key}" rows="${rows}" placeholder="one dish per line...">${items.join('\n')}</textarea>
    </div>`;
  }).join('');
}

function saveHolidayPlan() {
  const selected = document.querySelector('#hpTypePicker .meal-pick-chip.selected');
  const type = selected?.dataset.opt || weekHoliday?.type || '';
  if (!type) { showToast('Pick an event type first'); return; }
  const notes = document.getElementById('hpNotes')?.value.trim() || '';

  if (type === 'Vacation / Trip') {
    const tripType   = document.getElementById('hpTripType')?.value || 'Road trip';
    const hasKitchen = document.getElementById('hpHasKitchen')?.checked || false;
    const vacDays    = [...document.querySelectorAll('.hp-vac-day:checked')].map(cb => cb.value);
    // Read plan back from rendered travel-day sections
    let plan = null;
    const travelBody = document.getElementById('hpTravelBody');
    if (travelBody) {
      const travelDays = [];
      let destinationDays = null;
      travelBody.querySelectorAll('.travel-day-section').forEach((sec, secIdx) => {
        const label = sec.querySelector('summary')?.textContent?.trim() || `Section ${secIdx + 1}`;
        const mealRows = [];
        sec.querySelectorAll('.travel-meal-ta').forEach(ta => {
          const items = ta.value.split('\n').map(s => s.trim()).filter(Boolean);
          mealRows.push({ type: ta.dataset.meal || 'Items', items, eatOut: false });
        });
        const hasEatOutNote = sec.querySelector('.travel-eat-out-note');
        if (secIdx === 0) {
          travelDays.push({ label, meals: mealRows });
        } else {
          destinationDays = hasEatOutNote && !mealRows.length
            ? { label, eatOut: true, meals: [] }
            : { label, eatOut: false, meals: mealRows };
        }
      });
      // Legacy flat textarea (backward compat path)
      travelBody.querySelectorAll('.travel-day-section-legacy .travel-meal-ta').forEach(ta => {
        if (!plan) {
          const items = ta.value.split('\n').map(s => s.trim()).filter(Boolean);
          plan = { travelDays: [{ label: 'Travel days', meals: [{ type: 'Items', items, eatOut: false }] }], destinationDays: { label: 'Destination', eatOut: true, meals: [] } };
        }
      });
      if (!plan && travelDays.length) {
        plan = { travelDays, destinationDays: destinationDays || { label: 'Destination', eatOut: true, meals: [] } };
      }
    }
    // Flatten all items for cart compat
    const items = [];
    if (plan) {
      (plan.travelDays || []).forEach(d => (d.meals || []).forEach(m => items.push(...(m.items || []))));
      const dest = plan.destinationDays;
      if (dest && !dest.eatOut) (dest.meals || []).forEach(m => items.push(...(m.items || [])));
    }
    weekHoliday = { type, tripType, hasKitchen, vacDays, plan, items, notes };
    vacDays.forEach(day => { if (schedule[day]) schedule[day].complexity = 'out'; });
    if (meals.length) {
      vacDays.forEach(day => {
        meals = meals.filter(m => m.day !== day);
        meals.push({ day, meal: 'Out', isOut: true, isNew: false });
      });
      const _ord = SCHEDULE_DAYS.map(d => d.key);
      meals.sort((a, b) => _ord.indexOf(a.day) - _ord.indexOf(b.day));
      renderMeals();
    }
    renderSchedule();

  } else if (type === 'Visiting Family & Friends') {
    const guests    = parseInt(document.getElementById('hpGuests')?.value) || 6;
    const visitDays = parseInt(document.getElementById('hpVisitDays')?.value) || 3;
    const nights = [];
    document.querySelectorAll('.hosting-night-block').forEach((block, i) => {
      const dinner  = block.querySelector('.hosting-dinner-input')?.value.trim() || '';
      const sidesTA = block.querySelector('.hosting-sides-ta');
      const sides   = sidesTA ? sidesTA.value.split('\n').map(s => s.trim()).filter(Boolean) : [];
      nights.push({ night: i + 1, dinner, sides });
    });
    weekHoliday = { type, guests, visitDays, nights, notes };

  } else {
    const guests   = parseInt(document.getElementById('hpGuests')?.value) || 8;
    const timeline = document.getElementById('hpTimeline')?.value.trim() || '';
    let menu = null;
    const menuCard = document.getElementById('hpMenuCard');
    if (menuCard?.style.display !== 'none') {
      menu = {};
      ['appetizers','mains','sides','desserts'].forEach(k => {
        const ta = document.getElementById(`hpMenu-${k}`);
        menu[k] = ta ? ta.value.split('\n').map(s => s.trim()).filter(Boolean) : [];
      });
    }
    weekHoliday = { type, guests, menu, notes, timeline };
  }

  closeHolidayPlanner();
  document.getElementById('navHoliday')?.classList.add('active');
  const card = document.getElementById('holidayCard');
  if (card) { card.style.display = 'block'; card.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  renderHolidaySection();
  const isVacation = type === 'Vacation / Trip';
  const isHosting  = type === 'Visiting Family & Friends';
  showToast(isVacation ? 'Trip plan saved — away days marked out' : isHosting ? 'Visit plan saved' : 'Occasion plan saved');
}

function renderHolidaySection() {
  const el = document.getElementById('holidaySection');
  if (!el || !weekHoliday?.type) { if (el) el.innerHTML = ''; return; }
  const actions = `<div>
    <button class="btn-link" onclick="openHolidayPlanner()">edit →</button>
    <button class="btn-link" style="margin-left:8px;opacity:0.6" onclick="clearHolidayPlan()">remove</button>
  </div>`;

  if (weekHoliday.type === 'Vacation / Trip') {
    const n         = (weekHoliday.vacDays || []).length;
    const itemCount = (weekHoliday.items || []).length;
    el.innerHTML = `<div class="meal-pick-banner" style="flex-direction:column;align-items:flex-start;gap:4px">
      <div style="display:flex;width:100%;justify-content:space-between;align-items:center">
        <span>✈ ${weekHoliday.tripType || 'Trip'} · ${n} day${n !== 1 ? 's' : ''} away${itemCount ? ` · ${itemCount} items packed` : ''}</span>
        ${actions}
      </div>
    </div>`;
    return;
  }

  if (weekHoliday.type === 'Visiting Family & Friends') {
    const nights  = weekHoliday.nights || [];
    const total   = (weekHoliday.guests || 0) + (servingSize || 4);
    const preview = nights.slice(0, 3).map(n => n.dinner).filter(Boolean).join(' · ');
    el.innerHTML = `<div class="meal-pick-banner" style="flex-direction:column;align-items:flex-start;gap:4px">
      <div style="display:flex;width:100%;justify-content:space-between;align-items:center">
        <span>👨‍👩‍👧‍👦 Hosting ${total} people · ${weekHoliday.visitDays || nights.length} nights</span>
        ${actions}
      </div>
      ${preview ? `<span style="font-size:11px;opacity:0.65">${preview}${nights.length > 3 ? '…' : ''}</span>` : ''}
    </div>`;
    return;
  }

  const allDishes = weekHoliday.menu ? Object.values(weekHoliday.menu).flat() : [];
  const preview   = allDishes.slice(0, 5).join(' · ') + (allDishes.length > 5 ? '…' : '');
  el.innerHTML = `<div class="meal-pick-banner" style="flex-direction:column;align-items:flex-start;gap:4px">
    <div style="display:flex;width:100%;justify-content:space-between;align-items:center">
      <span>🎄 ${weekHoliday.type} · ${weekHoliday.guests} guests</span>
      ${actions}
    </div>
    ${preview ? `<span style="font-size:11px;opacity:0.65">${preview}</span>` : ''}
  </div>`;
}

function clearHolidayPlan() {
  weekHoliday = null;
  document.getElementById('navHoliday')?.classList.remove('active');
  const card = document.getElementById('holidayCard');
  if (card) card.style.display = 'none';
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
  const leftoversBtn = !q
    ? `<button class="swap-leftovers-btn" onclick="pickSwapLeftovers()">&#127374; Leftovers night</button>`
    : '';
  const queuedSection = !q && prefs.nextWeekQueue?.length
    ? `<div class="swap-picker-label">from last week:</div>` +
      prefs.nextWeekQueue.map(name => {
        const esc = name.replace(/'/g, '&#39;');
        return `<div class="swap-recipe-item queued-meal" onclick="pickSwapQueued('${esc}')">
          <span class="swap-recipe-stars">↩</span>
          <span class="swap-recipe-name">${name}</span>
        </div>`;
      }).join('')
    : '';
  if (!filtered.length) { picker.innerHTML = leftoversBtn + queuedSection; return; }
  picker.innerHTML = leftoversBtn + queuedSection + `<div class="swap-picker-label">from your recipe book:</div>` +
    filtered.map(r => {
      const esc = r.name.replace(/'/g, '&#39;');
      return `<div class="swap-recipe-item" onclick="pickSwapRecipe('${esc}')">
        <span class="swap-recipe-stars">${starsHtml(r.rating)}</span>
        <span class="swap-recipe-name">${r.name}</span>
      </div>`;
    }).join('');
}

function pickSwapQueued(name) {
  meals[swappingIndex].meal = name;
  meals[swappingIndex].isNew = false;
  meals[swappingIndex].isOut = false;
  meals[swappingIndex].isLeftovers = false;
  prefs.nextWeekQueue = (prefs.nextWeekQueue || []).filter(n => n !== name);
  fetch('/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(prefs) }).catch(() => {});
  cancelSwap();
}

function pickSwapRecipe(name) {
  meals[swappingIndex].meal = name;
  meals[swappingIndex].isNew = false;
  meals[swappingIndex].isOut = false;
  meals[swappingIndex].isLeftovers = false;
  cancelSwap();
}

function pickSwapLeftovers() {
  if (swappingIndex < 0) return;
  meals[swappingIndex].meal = 'Leftovers';
  meals[swappingIndex].isLeftovers = true;
  meals[swappingIndex].isNew = false;
  meals[swappingIndex].isOut = false;
  cancelSwap();
}


function setRatingStar(rating, pickerId) {
  const el = document.getElementById(pickerId);
  if (!el) return;
  el.dataset.rating = rating;
  el.innerHTML = starPickerHtml(pickerId, rating, 'setRatingStar');
  const allNames = [
    ...meals.map(m => m.meal.replace(' [NEW]', '')),
    ...(prefs.lastWeekMeals || []).map(m => m.meal),
  ];
  const mealName = allNames.find(name => 'rate-' + name.replace(/[^a-z0-9]/gi, '-') === pickerId) || '';
  if (mealName) pendingRatings[mealName] = rating;

  // Show "never suggest" option when 1 star is chosen
  const row = el.closest('.rating-row');
  if (!row || !mealName) return;
  let nsBtn = row.querySelector('.never-suggest-btn');
  const alreadyBlocked = (prefs.neverSuggest || []).includes(mealName);
  if (rating === 1 && !alreadyBlocked) {
    if (!nsBtn) {
      nsBtn = document.createElement('button');
      nsBtn.className = 'btn never-suggest-btn';
      nsBtn.onclick = () => addNeverSuggest(mealName);
      row.appendChild(nsBtn);
    }
    nsBtn.textContent = 'never suggest →';
    nsBtn.disabled = false;
  } else if (nsBtn && !alreadyBlocked) {
    nsBtn.remove();
  }
}

async function addNeverSuggest(mealName) {
  if (!prefs.neverSuggest) prefs.neverSuggest = [];
  if (prefs.neverSuggest.includes(mealName)) return;
  prefs.neverSuggest.push(mealName);
  try {
    await fetch('/prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prefs),
    });
  } catch(e) {}
  showToast(`"${mealName}" won't be suggested again`);
  const pid = 'rate-' + mealName.replace(/[^a-z0-9]/gi, '-');
  const btn = document.getElementById(pid)?.closest('.rating-row')?.querySelector('.never-suggest-btn');
  if (btn) { btn.textContent = '✓ blocked'; btn.disabled = true; }
}

async function _finalizeWeek() {
  if (!meals.length) return;
  const mealNames = meals.map(m => m.meal.replace(' [NEW]', '').trim());
  const today     = new Date().toISOString().split('T')[0];

  // Rolling 4-week meal history
  prefs.doNotRepeat = mealNames;
  if (!Array.isArray(prefs.mealHistory)) prefs.mealHistory = [];
  prefs.mealHistory.push({ week: today, meals: mealNames });
  if (prefs.mealHistory.length > 4) prefs.mealHistory = prefs.mealHistory.slice(-4);

  // Stamp lastOrderedOn on checked household items with a cadence
  if (householdChecked.size > 0) {
    (prefs.householdItems || []).forEach(item => {
      if (typeof item === 'object' && item.cadenceDays && householdChecked.has(item.name)) {
        item.lastOrderedOn = today;
      }
    });
  }

  // Schedule next session reminder
  prefs.nextSessionDue = _nextSunday();

  try {
    await fetch('/prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prefs),
    });
  } catch(e) {}

  // Save weekday dinner schedule for email reminders (Mon–Fri only)
  const fullDates = getUpcomingWeekFullDates();
  const weekdays  = new Set(['Monday','Tuesday','Wednesday','Thursday','Friday']);
  const schedule  = meals
    .filter(m => !m.isOut && !m.isLeftovers && weekdays.has(m.day))
    .map(m => ({
      date:     fullDates[m.day] || '',
      day:      m.day,
      meal:     m.meal.replace(' [NEW]', '').trim(),
      reminded: false,
    }));
  if (schedule.length) {
    fetch('/save-meal-schedule', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ schedule }),
    }).catch(() => {});
  }

  // Save weekly spend (fire and forget)
  const totalNum = parseFloat((_cartData?.total || '').replace('$', '')) || 0;
  if (totalNum > 0) {
    fetch('/spend-history', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({date: today, total: totalNum, mealCount: meals.filter(m => !m.isOut && !m.isLeftovers).length}),
    }).catch(() => {});
  }
}

function _nextSunday() {
  const d   = new Date();
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? 7 : 7 - day));
  return d.toISOString().split('T')[0];
}

async function saveRatings() {
  const today = new Date().toISOString().split('T')[0];
  const ratings = Object.entries(pendingRatings).filter(([, r]) => r > 0).map(([name, rating]) => ({ name, rating, lastPlanned: today }));
  try {
    await fetch('/recipes/batch-rate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ratings }),
    });
    await loadRecipes();
  } catch(e) {}
  await _finalizeWeek();
  // Collapse the recap rating section
  const ratingBody = document.getElementById('recapBody-rating');
  if (ratingBody) { ratingBody.style.display = 'none'; const chev = document.getElementById('recapChev-rating'); if (chev) chev.textContent = '›'; }
  showToast('Ratings saved to recipe book');
}

// ===== SERVING SIZE =====
const LS_SERVING_SIZE = 'grocery_serving_size';

function initServingSize() {
  const stored = parseInt(localStorage.getItem(LS_SERVING_SIZE));
  if (stored >= 1 && stored <= 12) {
    servingSize = stored;
  } else {
    const adults = parseInt(prefs.household?.adults) || 2;
    const kids   = parseInt(prefs.household?.kids)   || 0;
    servingSize  = Math.min(12, Math.max(1, adults + kids)) || 4;
  }
  const val = document.getElementById('servingSizeVal');
  if (val) val.textContent = servingSize;
  _updateStepperButtons();
}

function updateServingSize(v) {
  servingSize = Math.max(1, Math.min(12, parseInt(v) || 1));
  localStorage.setItem(LS_SERVING_SIZE, servingSize);
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
  goToStep(2);
  document.getElementById('loadingBar').style.display = 'flex';
  startMicrocopy(MEAL_PLAN_MSGS, 'loadingMsg');
  document.getElementById('mealPlanCard').style.display = 'none';
  document.getElementById('approveBtn').style.display = 'none';
  const regenBtn = document.getElementById('regenerateBtn');
  if (regenBtn) regenBtn.style.display = 'none';

  // Save breakfast/lunch defaults and clear carry-over queue
  prefs.defaultBreakfasts = [...weekBreakfasts];
  prefs.defaultLunches    = [...weekLunches];
  prefs.nextWeekQueue     = [];
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

  const outDays      = SCHEDULE_DAYS.filter(d => schedule[d.key].complexity === 'out').map(d => d.key);
  const leftoverDays = SCHEDULE_DAYS.filter(d => schedule[d.key].complexity === 'leftovers').map(d => d.key);
  const planDays     = SCHEDULE_DAYS.filter(d => !['out', 'leftovers'].includes(schedule[d.key].complexity)).map(d => d.key);
  const dinnerCount  = planDays.length;

  const newMealInstruction = includeNew
    ? `IMPORTANT: Exactly 2 of the planned meals must be completely new recipes this family has NOT cooked before.
       Choose these based on their taste profile (kid-friendly, protein-forward, comfort food) but pick
       dishes not mentioned anywhere in their history or favorites lists.
       Mark these new meals with [NEW] at the end of the meal name so they stand out.
       The remaining meals should come from their recipe book or favorites list, rotating in variety.`
    : `All planned meals should come from the recipe book or favorites list, rotating for variety.`;

  const skipNotes = [
    ...outDays.map(d => `${d} (eating out)`),
    ...leftoverDays.map(d => `${d} (leftovers — no meal needed)`),
  ];
  const outNote = skipNotes.length ? `\nSkip these days entirely: ${skipNotes.join(', ')}\n` : '';

  const quickRecipes = recipes.filter(r => (r.tags||[]).some(t => /quick|easy|fast/i.test(t))).map(r => r.name);
  const quickRule = quickRecipes.length
    ? `- For QUICK nights you MUST choose from these quick-tagged recipes in the book: ${quickRecipes.join(', ')}. Only deviate if none fit the week's variety rules.`
    : '- For QUICK nights choose meals that take 30 minutes or less (frozen, heat-and-eat, simple assembly).';

  const prompt = `You are a weekly meal planner for a family household in Montana.
Based on the preferences below, generate exactly ${dinnerCount} dinners — one for each of: ${planDays.join(', ')}.
This week they are cooking for ${servingSize} people.
${buildRecipeRepoPrompt()}${pantrySection}${lastWeekSection}
PREFERENCES:
${prefsText}

SCHEDULE (match meal complexity to each day's availability):
${buildSchedulePrompt()}
${outNote}
${newMealInstruction}

Rules:
- Match each meal's cook time and effort to the schedule above — OPEN days can have elaborate recipes
${quickRule}
- Prioritize meals from the Recipe Book when available, especially those with high ratings
- Never repeat a meal from the "Do NOT repeat" list
- Vary proteins: no same protein two days in a row
- Never suggest two meals that share the same base dish format in the same week (e.g., two pasta dishes, two taco variations, two soups, two stir-fries, two burgers)
- Keep meals practical and kid-friendly

Return ONLY a JSON array of exactly ${dinnerCount} objects (one per planned day), no other text, no markdown:
[{"day":"Monday","meal":"Meal Name","isNew":false},{"day":"Tuesday","meal":"Meal Name [NEW]","isNew":true},...]

Set isNew:true only for the brand new recipes.`;

  athleteItems = [];
  try {
    // Fire athlete items generation in parallel; failure silently falls back to []
    const athletePromise = prefs.athleteTraining?.enabled
      ? generateAthleteItems().catch(() => [])
      : Promise.resolve([]);

    const resp = await fetch('/claude-prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error || 'Server error');
    const text = data.content.trim().replace(/```json|```/g,'').trim();
    meals = JSON.parse(text);
    // Force Out entries for skipped days regardless of what Claude returned
    outDays.forEach(day => {
      meals = meals.filter(m => m.day !== day);
      meals.push({ day, meal: 'Out', isOut: true, isNew: false });
    });
    // Force Leftovers entries — Claude excludes them from the plan, so we re-inject
    leftoverDays.forEach(day => {
      meals = meals.filter(m => m.day !== day);
      meals.push({ day, meal: 'Leftovers', isLeftovers: true, isNew: false });
    });
    const _dayOrder = SCHEDULE_DAYS.map(d => d.key);
    meals.sort((a, b) => _dayOrder.indexOf(a.day) - _dayOrder.indexOf(b.day));
    // Defensive fill: ensure every planned day has a meal (Claude occasionally drops one)
    planDays.forEach(day => {
      if (!meals.some(m => m.day === day)) meals.push({ day, meal: '—', isNew: false });
    });
    meals.sort((a, b) => _dayOrder.indexOf(a.day) - _dayOrder.indexOf(b.day));
    // Auto easy-mode for quick nights
    meals.forEach(m => { if (schedule[m.day]?.complexity === 'quick') m.easyMode = true; });
    athleteItems = await athletePromise;
    if (athleteItems.length) {
      renderAthleteItems(athleteItems);
      showToast('Athlete items ready — open training panel');
      document.getElementById('navTraining')?.classList.add('active');
    }
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
  const sun = new Date(today); sun.setDate(today.getDate() - today.getDay());
  const result = {};
  ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].forEach((d,i) => {
    const dt = new Date(sun); dt.setDate(sun.getDate()+i);
    result[d] = dt.getDate();
  });
  return result;
}

function getUpcomingWeekFullDates() {
  const today = new Date(); today.setHours(0,0,0,0);
  const sun = new Date(today); sun.setDate(today.getDate() - today.getDay());
  const result = {};
  ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].forEach((d,i) => {
    const dt = new Date(sun); dt.setDate(sun.getDate()+i);
    result[d] = dt.toISOString().split('T')[0];
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
  const _normMN = s => s.toLowerCase().replace(/[^a-z0-9 ]/g,'').replace(/\s+/g,' ').trim();
  grid.innerHTML = meals.map((m,i) => {
    const dom = dates[m.day] || '';
    const dow = DAY_ABBR[m.day] || m.day.slice(0,3);
    if (m.isOut) {
      return `
      <div class="meal-card out-night" id="meal${i}">
        <div class="day-badge">
          <span class="dow">${dow}</span>
          <span class="dom">${dom}</span>
        </div>
        <div class="meal-info">
          <div class="meal-name">Eating out</div>
          <div class="meal-tags"></div>
        </div>
        <span class="cx cx-out">Out</span>
        <button class="btn-swap" onclick="startSwap(${i})" aria-label="Change ${dow}">change →</button>
      </div>`;
    }
    if (m.isLeftovers) {
      return `
      <div class="meal-card leftovers-night" id="meal${i}">
        <div class="day-badge">
          <span class="dow">${dow}</span>
          <span class="dom">${dom}</span>
        </div>
        <div class="meal-info">
          <div class="meal-name">Leftovers</div>
          <div class="meal-tags"></div>
        </div>
        <span class="cx cx-leftovers">Leftovers</span>
        <button class="btn-swap" onclick="startSwap(${i})" aria-label="Change ${dow}">change →</button>
      </div>`;
    }
    if (!m.meal) {
      return `
      <div class="meal-card" id="meal${i}">
        <div class="day-badge">
          <span class="dow">${dow}</span>
          <span class="dom">${dom}</span>
        </div>
        <div class="meal-info">
          <div class="meal-name" style="color:var(--text3)">no meal selected</div>
        </div>
        <button class="btn-swap" onclick="startSwap(${i})" aria-label="Pick meal for ${dow}">change →</button>
      </div>`;
    }
    const isSwapping = swappingIndex === i;
    const tags = lookupTags(m.meal);
    const tagsHtml = tags.map(t => `<span class="tag">${t}</span>`).join('');
    const cx = schedule[m.day]?.complexity || 'normal';
    const cxLabel = COMPLEXITY_LABEL[cx] || 'Normal';
    const mealName = m.meal.replace(' [NEW]','');
    const matchedRecipe = mealName ? (recipes.find(rec => _normMN(rec.name) === _normMN(mealName)) || recipes.find(rec => { const rn=_normMN(rec.name),mn=_normMN(mealName); return mn && (rn.includes(mn)||mn.includes(rn)); })) : null;
    const mealPhoto = matchedRecipe?.photo ? `<img class="meal-card-photo" src="${matchedRecipe.photo}" alt="${mealName}">` : '';
    const easyLabel = m.easyLoading ? '...' : (m.easyMode ? '✓ easy' : 'use easy');
    const easyTitle = m.easyMode ? 'Using a store-bought version — click to switch back to homemade' : 'Switch to a store-bought or frozen version';
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
        <button class="btn-swap ${isSwapping ? 'active' : ''}" onclick="startSwap(${i})" aria-label="Change ${mealName}">change →</button>
      </div>`;
  }).join('');
  renderAthleteItems(athleteItems);
}

function renderAthleteItems(items) {
  if (!items || !items.length) return;
  _approvedAthleteItems = new Set(items.map((_, i) => i));
  const itemsCard = document.getElementById('tr-itemsCard');
  if (itemsCard) itemsCard.style.display = 'block';
  _renderAthleteList();
}

function _renderAthleteList() {
  const list = document.getElementById('tr-itemsList');
  const count = document.getElementById('tr-itemsCount');
  if (!list) return;
  list.innerHTML = athleteItems.map((item, i) => {
    const { label, tag } = _classifyAthleteItem(item);
    const checked = _approvedAthleteItems.has(i);
    return `<label class="athlete-item-row${checked ? '' : ' athlete-item-skipped'}">
      <input type="checkbox" ${checked ? 'checked' : ''} onchange="toggleAthleteItem(${i})">
      <span class="athlete-item-tag">${tag}</span>
      <span>${label}</span>
    </label>`;
  }).join('');
  if (count) count.textContent = `${_approvedAthleteItems.size} of ${athleteItems.length} items in your cart`;
}

function toggleAthleteItem(idx) {
  if (_approvedAthleteItems.has(idx)) _approvedAthleteItems.delete(idx);
  else _approvedAthleteItems.add(idx);
  _renderAthleteList();
}

function _classifyAthleteItem(item) {
  const lower = item.toLowerCase();
  let tag = 'snack';
  if (/oat|bagel|bread|banana|toast|rice cake/i.test(lower)) tag = 'pre-run';
  else if (/yogurt|chocolate milk|protein|cottage|recovery|gel|chew|gu|clif|rxbar|core power/i.test(lower)) tag = 'recovery';
  else if (/electrolyte|nuun|gatorade|powerade|liquid i\.?v|drink mix|drink powder|hydration/i.test(lower)) tag = 'hydration';
  return { label: item, tag };
}

async function generateAthleteItems() {
  const at = prefs.athleteTraining || {};
  const runDays = (at.runDays || []).filter(d => d !== at.longRunDay);
  const appetite = at.appetiteSensitive
    ? 'Note: timing-sensitive appetite — pre-run options must be small (100-200 cal) and very easy to digest.'
    : '';
  const prompt = `You are a sports dietitian planning a weekly personal grocery list for a marathon runner.

Athlete context:
- Training for ${at.raceName || 'a marathon'}${at.raceDate ? ' (' + at.raceDate + ')' : ''}
- Phase: ${at.phase || 'Base Building'}
- This week's long run: ${at.weeklyLongRunMi || '?'} miles on ${at.longRunDay || 'Saturday'}
- Other run days: ${runDays.join(', ') || 'weekdays'}
- Training at altitude (4,500 ft) — higher caloric and hydration needs
${appetite}

Generate a personal athlete grocery list covering:
1. Pre-run items for ${runDays.join('/')} (quick, light, easy to digest 30 min before a 30-min run)
2. Pre-long-run items for ${at.longRunDay || 'Saturday'} (${at.weeklyLongRunMi || '?'} mi — more substantial, eaten 1-2 hrs before)
3. Post-run recovery items for all run days (protein + carbs within 30 min after)
4. Training snacks for the week (energy-dense, grab-and-go, easy to eat even with low appetite)

Rules:
- Only suggest items readily available at Walmart
- Be specific (e.g. "Quaker quick oats" not just "oats", "Chobani Greek yogurt" not just "yogurt")
- No duplicates with likely family grocery items (pasta, milk, bread are already covered)
- Aim for 10-14 items total

Return ONLY a JSON array of grocery item name strings, no other text:
["item 1", "item 2", ...]`;

  const resp = await fetch('/claude-prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  const data = await resp.json();
  if (!resp.ok || data.error) throw new Error(data.error || 'Server error');
  const text = data.content.trim().replace(/```json|```/g, '').trim();
  return JSON.parse(text);
}

async function toggleEasyMode(i, checked) {
  if (checked) {
    if (!meals[i].originalMeal) meals[i].originalMeal = meals[i].meal;
    meals[i].easyLoading = true;
    renderMeals();
    try {
      const resp = await fetch('/claude-prompt', {
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
    meals[swappingIndex].isOut = false;
    meals[swappingIndex].isLeftovers = false;
  }
  cancelSwap();
}

function cancelSwap() {
  swappingIndex = -1;
  document.getElementById('swapRow').className = 'swap-input-row';
  document.getElementById('swapRecipePicker').innerHTML = '';
  renderMeals();
}

// ===== INGREDIENT REVIEW =====

function setReviewView(view) {
  _reviewView = view;
  document.getElementById('reviewViewRecipe').classList.toggle('active', view === 'recipe');
  document.getElementById('reviewViewCategory').classList.toggle('active', view === 'category');
  _renderReviewList();
}

function toggleReviewItem(key) {
  const item = _reviewItems.find(i => i.key === key);
  if (!item) return;
  item.status = (item.status === 'include') ? 'removed' : 'include';
  _renderReviewList();
}

function markReviewPantry(key) {
  const item = _reviewItems.find(i => i.key === key);
  if (!item) return;
  item.status = (item.status === 'pantry') ? 'include' : 'pantry';
  _renderReviewList();
}

function combineReviewItems(keepKey, removeKey) {
  const keep   = _reviewItems.find(i => i.key === keepKey);
  const remove = _reviewItems.find(i => i.key === removeKey);
  if (!keep || !remove) return;
  const sum = (parseFloat(keep.amount) || 1) + (parseFloat(remove.amount) || 1);
  keep.amount = String(Number.isInteger(sum) ? sum : sum.toFixed(1));
  remove.combinedInto = keepKey;
  remove.status = 'removed';
  _renderReviewList();
}

function openReviewRecipe(mealName) {
  const recipe = recipes.find(r => r.name.toLowerCase() === mealName.toLowerCase());
  if (recipe) openRecipeModal(recipe);
  else showToast(`No saved recipe for "${mealName}"`, { type: 'error' });
}

function _renderReviewList() {
  const list = document.getElementById('reviewList');
  if (!list) return;

  const activeCount  = _reviewItems.filter(i => i.status === 'include' && !i.combinedInto).length;
  const pantryCount  = _reviewItems.filter(i => i.status === 'pantry').length;
  const summaryEl    = document.getElementById('reviewSummary');
  if (summaryEl) summaryEl.textContent = `${activeCount} items to order${pantryCount ? ` · ${pantryCount} already in pantry` : ''}`;

  const safeKey = k => k.replace(/'/g, "\\'");

  // Build cross-meal overlap map using normIngredient — only flag items that appear in 2+ different meals
  const overlapMap = {}; // norm → [{key, mealSrc, name}]
  _reviewItems.filter(i => !i.combinedInto && i.status !== 'removed').forEach(item => {
    const norm = normIngredient(item.name);
    if (norm.length < 3) return;
    if (!overlapMap[norm]) overlapMap[norm] = [];
    overlapMap[norm].push(item);
  });
  // Only keep norms where items come from more than one distinct meal
  const crossMealNorms = new Set(
    Object.keys(overlapMap).filter(n => {
      const meals = new Set(overlapMap[n].map(i => i.mealSrc));
      return meals.size > 1;
    })
  );
  // Map key → which other meals it overlaps with (for recipe view badges)
  const itemOverlapMeals = {};
  crossMealNorms.forEach(norm => {
    const items = overlapMap[norm];
    items.forEach(item => {
      const others = [...new Set(items.filter(i => i.mealSrc !== item.mealSrc).map(i => i.mealSrc))];
      itemOverlapMeals[item.key] = { norm, others, firstKey: items[0].key };
    });
  });

  if (_reviewView === 'recipe') {
    const byMeal = {};
    _reviewItems.forEach(item => { (byMeal[item.mealSrc] = byMeal[item.mealSrc] || []).push(item); });

    list.innerHTML = Object.entries(byMeal).map(([mealName, items]) => {
      const recipe = recipes.find(r => r.name.toLowerCase() === mealName.toLowerCase());
      const fromBook = !!(recipe?.ingredients?.length);
      return `<div class="review-group">
        <button class="review-group-header" onclick="openReviewRecipe('${mealName.replace(/'/g,"\\'")}')">
          <span class="review-group-name">${mealName}</span>
          <span class="review-src-badge${fromBook ? '' : ' generated'}">${fromBook ? 'recipe book' : 'ai generated'}</span>
          <span class="review-recipe-link">view recipe →</span>
        </button>
        <div class="review-group-items">
          ${items.map(item => {
            const isRemoved  = item.status === 'removed' || !!item.combinedInto;
            const isInPantry = item.status === 'pantry';
            const overlap    = itemOverlapMeals[item.key];
            const isFirst    = overlap && overlap.firstKey === item.key;
            const isLater    = overlap && !isFirst;
            const keepKey    = isLater ? overlap.firstKey : null;
            const cls = isRemoved ? ' review-item--removed' : isInPantry ? ' review-item--pantry' : overlap ? ' review-item--dupe' : '';
            const qty = [item.amount, item.unit].filter(Boolean).join(' ');
            const overlapBadge = isFirst
              ? ` <span class="review-dupe-badge">↕ also in ${overlap.others.join(', ')}</span>`
              : isLater
                ? ` <span class="review-dupe-badge secondary">↕ also in ${overlap.others.join(', ')}</span>`
                : '';
            return `<div class="review-item${cls}">
              <input type="checkbox" class="review-item-check" ${(isRemoved || isInPantry) ? '' : 'checked'} onchange="toggleReviewItem('${safeKey(item.key)}')">
              <span class="review-item-name">${item.name}${item.combinedInto ? ' <span class="review-combined-label">combined ↑</span>' : ''}${overlapBadge}</span>
              ${qty ? `<span class="review-item-qty">${qty}</span>` : ''}
              <button class="review-pantry-btn${isInPantry ? ' active' : ''}" onclick="markReviewPantry('${safeKey(item.key)}')">${isInPantry ? '✓ in pantry' : 'in pantry'}</button>
              ${isLater && !isRemoved ? `<button class="review-combine-btn" onclick="combineReviewItems('${safeKey(keepKey)}','${safeKey(item.key)}')">combine ↑</button>` : ''}
            </div>`;
          }).join('')}
        </div>
      </div>`;
    }).join('');

  } else {
    // Category view — flatten active items, group by category, detect duplicates
    const active = _reviewItems.filter(i => !i.combinedInto);
    const catGroups = {};
    active.forEach(item => { const c = _hhCategory(item.name); (catGroups[c] = catGroups[c] || []).push(item); });

    // Use normIngredient (adjective-aware) for dupe detection in category view
    const normGroups = {};
    active.forEach(item => {
      const norm = normIngredient(item.name);
      if (norm.length >= 3) (normGroups[norm] = normGroups[norm] || []).push(item);
    });
    const dupeNorms = new Set(Object.keys(normGroups).filter(n => normGroups[n].length > 1));

    list.innerHTML = HH_CATEGORY_ORDER.filter(c => catGroups[c]).map(cat => {
      const items = catGroups[cat];
      return `<div class="review-group">
        <div class="review-cat-header">${HH_CATEGORY_LABELS[cat] || cat}</div>
        ${items.map(item => {
          const norm       = normIngredient(item.name);
          const isDupe     = dupeNorms.has(norm);
          const dupeGroup  = isDupe ? normGroups[norm] : [];
          const isFirst    = isDupe && dupeGroup[0]?.key === item.key;
          const isLater    = isDupe && !isFirst;
          const keepKey    = isLater ? dupeGroup[0].key : null;
          const isRemoved  = item.status === 'removed';
          const isInPantry = item.status === 'pantry';
          const cls = isRemoved ? ' review-item--removed' : isInPantry ? ' review-item--pantry' : isDupe ? ' review-item--dupe' : '';
          const qty = [item.amount, item.unit].filter(Boolean).join(' ');
          return `<div class="review-item${cls}">
            <input type="checkbox" class="review-item-check" ${(isRemoved || isInPantry) ? '' : 'checked'} onchange="toggleReviewItem('${safeKey(item.key)}')">
            <span class="review-item-name">${item.name} <span class="review-meal-tag">${item.mealSrc}</span>${isFirst ? ' <span class="review-dupe-badge">↕ overlap</span>' : ''}</span>
            ${qty ? `<span class="review-item-qty">${qty}</span>` : ''}
            <button class="review-pantry-btn${isInPantry ? ' active' : ''}" onclick="markReviewPantry('${safeKey(item.key)}')">${isInPantry ? '✓ in pantry' : 'in pantry'}</button>
            ${isLater && !isRemoved ? `<button class="review-combine-btn" onclick="combineReviewItems('${safeKey(keepKey)}','${safeKey(item.key)}')">combine ↑</button>` : ''}
          </div>`;
        }).join('')}
      </div>`;
    }).join('');
  }
}

async function startIngredientReview() {
  _skippedNonDinnerItems = new Set();
  _nonDinnerExpanded    = new Set();
  _nonDinnerIngredients = {};
  document.getElementById('reviewLoadingBar').style.display = 'flex';
  document.getElementById('reviewCard').style.display    = 'none';
  document.getElementById('reviewError').style.display   = 'none';
  document.getElementById('buildCartFromReviewBtn').style.display = 'none';

  const mealData  = meals.filter(m => !m.isOut && !m.isLeftovers).map(m => ({
    name:     m.meal.replace(' [NEW]', '').trim(),
    easyMode: !!m.easyMode,
  }));
  const mealNames = mealData.map(m => m.name);

  // Use ingredients from local recipes[] for any meal already in the book (catches mid-session adds)
  const _normIR = s => s.toLowerCase().replace(/[^a-z0-9 ]/g,'').trim();
  const cachedIng = {}, toFetch = [];
  mealData.forEach(m => {
    const rec = recipes.find(r => _normIR(r.name) === _normIR(m.name));
    if (rec && rec.ingredients?.length) cachedIng[m.name] = rec.ingredients;
    else toFetch.push(m);
  });

  try {
    let fetchedIng = {};
    if (toFetch.length) {
      const resp = await fetch('/generate-ingredients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meals: toFetch, servings: servingSize }),
      });
      if (resp.status === 404 || !(resp.headers.get('content-type') || '').includes('json')) {
        throw new Error('Server needs to be restarted — open Terminal and run: python server.py');
      }
      const data = await resp.json();
      if (!resp.ok || data.error) throw new Error(data.error || 'Failed to load ingredients');
      fetchedIng = data.ingredients || {};
    }

    const allIng = { ...cachedIng, ...fetchedIng };
    _reviewItems = [];
    mealNames.forEach(mealName => {
      const ings = allIng[mealName] || [];
      ings.forEach((ing, idx) => {
        _reviewItems.push({
          key:          `${mealName}-${idx}`,
          mealSrc:      mealName,
          name:         typeof ing === 'string' ? ing : (ing.name || ''),
          amount:       typeof ing === 'string' ? '' : String(ing.amount || ''),
          unit:         typeof ing === 'string' ? '' : (ing.unit || ''),
          status:       'include',
          combinedInto: null,
        });
      });
    });

    // Auto-mark items already in the pantry
    if (pantry.length) {
      const pantryNorms = pantry.map(p => normName(p.name)).filter(n => n.length >= 3);
      _reviewItems.forEach(item => {
        const ingNorm = normName(item.name);
        if (ingNorm.length >= 3) {
          const hit = pantryNorms.some(pn =>
            ingNorm === pn ||
            (ingNorm.length > 4 && ingNorm.includes(pn)) ||
            (pn.length > 4 && pn.includes(ingNorm))
          );
          if (hit) item.status = 'pantry';
        }
      });
    }

    _reviewView = 'recipe';
    document.getElementById('reviewViewRecipe').classList.add('active');
    document.getElementById('reviewViewCategory').classList.remove('active');
    document.getElementById('reviewLoadingBar').style.display  = 'none';
    document.getElementById('reviewCard').style.display        = 'block';
    document.getElementById('buildCartFromReviewBtn').style.display = 'inline-flex';
    _renderReviewList();
    _renderNonDinnerItems();

  } catch(e) {
    document.getElementById('reviewLoadingBar').style.display = 'none';
    const errBox = document.getElementById('reviewError');
    errBox.style.display  = 'block';
    errBox.textContent    = `Failed to load ingredients: ${e.message}`;
  }
}

async function buildCartFromReview() {
  const precomputed = {};
  _reviewItems.forEach(item => {
    if (item.status === 'include' && !item.combinedInto) {
      (precomputed[item.mealSrc] = precomputed[item.mealSrc] || []).push({
        name: item.name, amount: item.amount, unit: item.unit,
      });
    }
  });
  goToStep(6);
  startCartBuild(precomputed);
}

function _renderNonDinnerItems() {
  const all = [
    ...weekBreakfasts.map(n => ({ label: n, cat: 'breakfast' })),
    ...weekLunches.map(n => ({ label: n, cat: 'lunch' })),
    ...weekSnacks.map(n => ({ label: n, cat: 'snack' })),
    ...(weekDessert ? [{ label: weekDessert, cat: 'dessert' }] : []),
  ];
  const section = document.getElementById('nonDinnerReviewSection');
  const list    = document.getElementById('nonDinnerReviewList');
  if (!section || !list || !all.length) { if (section) section.style.display = 'none'; return; }
  section.style.display = 'block';
  list.innerHTML = all.map(({ label, cat }) => {
    const skipped  = _skippedNonDinnerItems.has(label);
    const expanded = _nonDinnerExpanded.has(label);
    const cached   = _nonDinnerIngredients[label];
    const esc = label.replace(/'/g, '&#39;');
    const ingSection = expanded ? _renderNonDinnerIngredients(label, cached) : '';
    return `<div class="review-item${skipped ? ' review-item-skipped' : ''}">
      <span class="review-item-cat">${cat}</span>
      <span class="review-item-name">${label}</span>
      <button class="btn-pantry-toggle nd-ing-btn" onclick="toggleNonDinnerIngredients('${esc}')" title="View ingredients">${expanded ? '▾' : '▸'}</button>
      <button class="btn-pantry-toggle${skipped ? '' : ' active'}" onclick="toggleNonDinnerItem('${esc}')">
        ${skipped ? 'add back' : 'skip'}
      </button>
    </div>${ingSection}`;
  }).join('');
}

function _renderNonDinnerIngredients(label, items) {
  const id = label.replace(/[^a-zA-Z0-9]/g, '_');
  if (!items) {
    return `<div class="nd-ing-section" id="ndIng-${id}"><span class="nd-ing-loading">loading…</span></div>`;
  }
  const pantryNorms = pantry.map(p => normName(p.name)).filter(n => n.length >= 3);
  const chips = items.map(ing => {
    const norm = normName(ing);
    const inPantry = norm.length >= 3 && pantryNorms.some(pn =>
      norm === pn || (norm.length > 4 && norm.includes(pn)) || (pn.length > 4 && pn.includes(norm)));
    const escIng = ing.replace(/&/g,'&amp;').replace(/</g,'&lt;');
    return `<span class="nd-ing-chip${inPantry ? ' in-pantry' : ''}">${escIng}${inPantry ? ' ✓' : ''}</span>`;
  }).join('');
  return `<div class="nd-ing-section" id="ndIng-${id}">${chips}</div>`;
}

async function toggleNonDinnerIngredients(label) {
  if (_nonDinnerExpanded.has(label)) {
    _nonDinnerExpanded.delete(label);
    _renderNonDinnerItems();
    return;
  }
  _nonDinnerExpanded.add(label);
  _renderNonDinnerItems();
  if (!_nonDinnerIngredients[label]) {
    try {
      const resp = await fetch('/claude-prompt', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: `List 4-8 grocery items needed to make "${label}" for a family of 4. Be specific (e.g. "whole milk" not "milk", "large eggs" not "eggs"). Return ONLY a JSON array of strings, no markdown: ["item1","item2",...]`
        }),
      });
      const data = await resp.json();
      const parsed = JSON.parse((data.content || '[]').replace(/```json|```/g, '').trim());
      _nonDinnerIngredients[label] = Array.isArray(parsed) ? parsed : [];
    } catch(e) {
      _nonDinnerIngredients[label] = [];
    }
    _renderNonDinnerItems();
  }
}

function toggleNonDinnerItem(label) {
  if (_skippedNonDinnerItems.has(label)) _skippedNonDinnerItems.delete(label);
  else _skippedNonDinnerItems.add(label);
  _renderNonDinnerItems();
}

function exportShoppingList() {
  if (!_reviewItems.length) { showToast('No ingredients to export yet', {type: 'error'}); return; }
  const today = new Date().toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric'});
  const byMeal = {};
  _reviewItems
    .filter(i => i.status === 'include' && !i.combinedInto)
    .forEach(i => { (byMeal[i.mealSrc] = byMeal[i.mealSrc] || []).push(i); });

  const lines = [`SHOPPING LIST — week of ${today}`, ''];
  Object.entries(byMeal).forEach(([meal, items]) => {
    lines.push(meal);
    items.forEach(i => {
      const qty = [i.amount, i.unit].filter(Boolean).join(' ');
      lines.push(`  • ${qty ? qty + ' ' : ''}${i.name}`);
    });
    lines.push('');
  });

  // Append confirmed staples
  const activeStaples = staples.filter(s => !staplesSkipped.has(s.id));
  if (activeStaples.length || staplesOneTime.length) {
    lines.push('Weekly Staples');
    activeStaples.forEach(s => {
      const meta = [s.qty > 1 ? s.qty : '', s.unit].filter(Boolean).join(' ');
      lines.push(`  • ${meta ? meta + ' ' : ''}${s.name}`);
    });
    staplesOneTime.forEach(o => lines.push(`  • ${o.qty > 1 ? o.qty + ' ' : ''}${o.name}`));
  }

  const blob = new Blob([lines.join('\n')], {type: 'text/plain'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `shopping-list-${new Date().toISOString().split('T')[0]}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function copyShoppingList() {
  if (!_reviewItems.length) { showToast('No ingredients to copy yet', {type: 'error'}); return; }
  const today = new Date().toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric'});
  const byMeal = {};
  _reviewItems
    .filter(i => i.status === 'include' && !i.combinedInto)
    .forEach(i => { (byMeal[i.mealSrc] = byMeal[i.mealSrc] || []).push(i); });

  const lines = [`Shopping list — week of ${today}`, ''];
  Object.entries(byMeal).forEach(([meal, items]) => {
    lines.push(meal);
    items.forEach(i => {
      const qty = [i.amount, i.unit].filter(Boolean).join(' ');
      lines.push(`  • ${qty ? qty + ' ' : ''}${i.name}`);
    });
    lines.push('');
  });

  const activeStaples = staples.filter(s => !staplesSkipped.has(s.id));
  if (activeStaples.length || staplesOneTime.length) {
    lines.push('Weekly Staples');
    activeStaples.forEach(s => {
      const meta = [s.qty > 1 ? s.qty : '', s.unit].filter(Boolean).join(' ');
      lines.push(`  • ${meta ? meta + ' ' : ''}${s.name}`);
    });
    staplesOneTime.forEach(o => lines.push(`  • ${o.qty > 1 ? o.qty + ' ' : ''}${o.name}`));
  }

  navigator.clipboard.writeText(lines.join('\n'))
    .then(() => showToast('List copied to clipboard'))
    .catch(() => showToast('Copy failed — try export instead', {type: 'error'}));
}

// ===== PREP GUIDE =====
let _prepGuideSections = [];

async function generatePrepGuide() {
  const btn  = document.getElementById('prepGuideGenBtn');
  const body = document.getElementById('prepGuideBody');
  if (btn) { btn.disabled = true; btn.textContent = 'generating...'; }

  const mealData = meals.filter(m => !m.isOut && !m.isLeftovers).map(m => ({
    day:        m.day,
    meal:       m.meal.replace(' [NEW]', '').trim(),
    complexity: schedule[m.day]?.complexity || 'normal',
    isOut:      false,
  }));

  try {
    const resp = await fetch('/generate-prep-list', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ meals: mealData, pantry }),
    });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error || 'Failed');
    _prepGuideSections = data.sections || [];
    _renderPrepGuide();
  } catch(e) {
    if (body) body.innerHTML = `<p class="recap-hint" style="color:var(--error)">Couldn't generate guide — check Terminal.</p>`;
    if (btn)  { btn.disabled = false; btn.textContent = 'try again'; }
  }
}

function _renderPrepGuide() {
  const body = document.getElementById('prepGuideBody');
  if (!body || !_prepGuideSections.length) return;

  const sectionsHtml = _prepGuideSections.map(sec => `
    <div style="margin-bottom:14px">
      <div class="card-label" style="margin-bottom:6px;font-size:11px">${sec.title}</div>
      <ul style="margin:0;padding-left:18px">
        ${(sec.tasks || []).map(t => `<li class="recap-hint" style="margin-bottom:4px">${t}</li>`).join('')}
      </ul>
    </div>`).join('');

  body.innerHTML = sectionsHtml + `
    <div style="display:flex;gap:8px;margin-top:14px">
      <button class="btn primary" onclick="emailPrepGuide()">email me this →</button>
      <button class="btn" onclick="copyPrepGuide()">copy</button>
    </div>`;
}

async function emailPrepGuide() {
  const btn = document.querySelector('#prepGuideBody .btn.primary');
  if (btn) { btn.disabled = true; btn.textContent = 'sending...'; }
  try {
    const resp = await fetch('/email-prep-guide', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sections: _prepGuideSections }),
    });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error);
    showToast('Prep guide sent to your inbox');
    if (btn) { btn.disabled = false; btn.textContent = '✓ sent'; }
  } catch(e) {
    showToast(e.message.includes('GMAIL_APP_PASSWORD') ? 'Add GMAIL_APP_PASSWORD to .env to enable email' : 'Email failed — check Terminal', {type:'error'});
    if (btn) { btn.disabled = false; btn.textContent = 'email me this →'; }
  }
}

function copyPrepGuide() {
  if (!_prepGuideSections.length) return;
  const lines = ['Sunday Prep Guide', ''];
  _prepGuideSections.forEach(sec => {
    lines.push(sec.title);
    (sec.tasks || []).forEach(t => lines.push(`  • ${t}`));
    lines.push('');
  });
  navigator.clipboard.writeText(lines.join('\n'))
    .then(() => showToast('Prep guide copied'))
    .catch(() => showToast('Copy failed', {type:'error'}));
}

// ===== CART =====
async function approveMealPlan() {
  document.getElementById('buildCartBtn').style.display = 'none';
  document.getElementById('cartLoadingBar').style.display = 'none';
  document.getElementById('cartCard').style.display = 'none';
  document.getElementById('cartError').style.display = 'none';
  document.getElementById('serverNotice').style.display = 'none';
  document.getElementById('doneBtn').style.display = 'none';
  // Save this week's meals so next Sunday's recap can show them
  prefs.lastWeekMeals = meals.map(m => ({
    day: m.day,
    meal: m.meal.replace(' [NEW]', '').trim(),
    easyMode: !!m.easyMode,
  }));
  try {
    await fetch('/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(prefs) });
  } catch(e) {}

  goToStep(3); // → Household step
}

function navigateAndBuildCart() {
  navigateToStaples();
}

async function startCartBuild(precomputedIngredients = null) {
  document.getElementById('buildCartBtn').style.display = 'none';
  document.getElementById('cartLoadingBar').style.display = 'flex';
  document.getElementById('cartCard').style.display = 'none';
  // Reset prep guide
  _prepGuideSections = [];
  const pgCard = document.getElementById('prepGuideCard');
  if (pgCard) {
    pgCard.style.display = 'none';
    const pgBody = document.getElementById('prepGuideBody');
    if (pgBody) pgBody.innerHTML = `<p class="review-hint" style="margin-bottom:12px">Get a personalized checklist of what to prep tonight so weeknight dinners go smoothly.</p><button class="btn primary" id="prepGuideGenBtn" onclick="generatePrepGuide()">generate prep guide →</button>`;
  }
  document.getElementById('cartError').style.display = 'none';
  document.getElementById('serverNotice').style.display = 'none';
  document.getElementById('doneBtn').style.display = 'none';
  const ssb = document.getElementById('swapSuggestBox'); if (ssb) ssb.style.display = 'none';
  const nfb = document.getElementById('notFoundBox');    if (nfb) nfb.style.display = 'none';
  const spb = document.getElementById('spikeBox');       if (spb) spb.style.display = 'none';
  startMicrocopy(CART_BUILD_MSGS, 'cartLoadingMsg', 4000);

  const mealNames = meals.filter(m => !m.isOut && !m.isLeftovers).map(m => m.meal.replace(' [NEW]','').trim());

  try {
    const controller = new AbortController();
    const _timeout = setTimeout(() => controller.abort(), 90000);
    const confirmedStaples = staples
      .filter(s => !staplesSkipped.has(s.id))
      .map(s => ({
        id: s.id, name: s.name, qty: s.qty, unit: s.unit,
        ...(s.itemId ? {itemId: s.itemId, productName: s.productName, lastPrice: s.lastPrice} : {}),
      }))
      .concat(staplesOneTime.map(o => ({name: o.name, qty: o.qty || 1, unit: ''})));
    const body = { meals: mealNames, breakfasts: weekBreakfasts.filter(n => !_skippedNonDinnerItems.has(n)), lunches: weekLunches.filter(n => !_skippedNonDinnerItems.has(n)), dessert: _skippedNonDinnerItems.has(weekDessert) ? '' : weekDessert, snacks: weekSnacks.filter(n => !_skippedNonDinnerItems.has(n)), holiday: weekHoliday, household: [...householdChecked], weeklyStaples: confirmedStaples, servings: servingSize, zip: prefs.household?.zip || '59047', trainingItems: athleteItems.filter((_, i) => _approvedAthleteItems.has(i)) };
    if (precomputedIngredients) body.ingredients = precomputedIngredients;
    const resp = await fetch('/build-cart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    }).finally(() => clearTimeout(_timeout));

    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error || 'Unknown server error');

    stopMicrocopy();
    setTimeout(() => {
      document.getElementById('cartLoadingBar').style.display = 'none';
      renderCart(data.groups || {}, data.mealOrder || [], data.total, data.cartUrl, data.notFound || []);
      _cacheResolvedStaples(data.resolvedStaples);
    }, 500);

  } catch(e) {
    stopMicrocopy();
    document.getElementById('cartLoadingBar').style.display = 'none';
    document.getElementById('buildCartBtn').style.display = 'inline-flex';
    if (e instanceof TypeError) {
      document.getElementById('serverNotice').style.display = 'block';
    } else {
      const errBox = document.getElementById('cartError');
      errBox.style.display = 'block';
      errBox.textContent = `Cart build error:\n${e.message}\n\nCheck your Terminal for the full error log.`;
    }
  }
}

async function _cacheResolvedStaples(resolved) {
  if (!resolved?.length) return;
  for (const r of resolved) {
    const s = staples.find(x => x.id === r.stapleId);
    if (!s) continue;
    s.itemId      = r.itemId;
    s.productName = r.productName;
    s.lastPrice   = r.lastPrice;
    try {
      await fetch(`/staples/${r.stapleId}`, {
        method: 'PATCH',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({itemId: r.itemId, productName: r.productName, lastPrice: r.lastPrice}),
      });
    } catch(e) {}
  }
  renderStaplesPanel();
}

async function clearStapleCache() {
  const cached = staples.filter(s => s.itemId);
  if (!cached.length) { showToast('No cached products to clear', {type: 'error'}); return; }
  for (const s of cached) {
    s.itemId      = null;
    s.productName = null;
    s.lastPrice   = null;
    try {
      await fetch(`/staples/${s.id}`, {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({itemId: null, productName: null, lastPrice: null}),
      });
    } catch(e) {}
  }
  renderStaplesPanel();
  showToast(`Cleared Walmart cache for ${cached.length} staple${cached.length !== 1 ? 's' : ''}`);
}

function setCartView(view) {
  _cartView = view;
  document.getElementById('cartViewMeal').classList.toggle('active', view === 'meal');
  document.getElementById('cartViewCategory').classList.toggle('active', view === 'category');
  if (_cartData) _renderCartList(_cartData.groups, _cartData.mealOrder);
}

function filterCart(query) {
  _cartFilter = query.toLowerCase().trim();
  if (_cartData) _renderCartList(_cartData.groups, _cartData.mealOrder);
}

function _renderCartList(groups, mealOrder) {
  const list = document.getElementById('cartList');
  const q = _cartFilter;
  const _match = name => !q || name.toLowerCase().includes(q);
  if (_cartView === 'category') {
    // Flatten all items with source/idx, group by grocery category
    const allItems = [];
    mealOrder.forEach(src => (groups[src] || []).forEach((i, idx) => allItems.push({ ...i, _src: src, _idx: idx })));
    const catGroups = {};
    allItems.filter(i => _match(i.name)).forEach(item => {
      const cat = _hhCategory(item.name);
      (catGroups[cat] = catGroups[cat] || []).push(item);
    });
    list.innerHTML = HH_CATEGORY_ORDER.filter(cat => catGroups[cat]).map(cat => {
      const items = catGroups[cat];
      const groupTotal = items.reduce((sum, i) => _cartDeselected.has(`${i._src}-${i._idx}`) ? sum : sum + parseFloat(i.price.replace('$', '')), 0);
      return `<div class="cart-group">
        <div class="cart-group-header">
          <span class="cart-group-label">${HH_CATEGORY_LABELS[cat] || cat}</span>
          <span class="cart-group-subtotal">$${groupTotal.toFixed(2)}</span>
        </div>
        ${items.map(item => {
          const key = `${item._src}-${item._idx}`;
          const desel = _cartDeselected.has(key);
          const esc = item.name.replace(/'/g, '&#39;');
          return `<div class="cart-item${desel ? ' deselected' : ''}" data-swap-key="${key}">
            <input type="checkbox" class="cart-item-check" ${desel ? '' : 'checked'} onchange="toggleCartItem('${key}')" aria-label="${esc}">
            <span class="cart-item-name">${item.name}</span>
            <span class="cart-item-right">
              <span class="cart-item-price">${item.price}</span>
              <button class="cart-item-swap" title="find alternative" aria-label="Find alternative for ${esc}" onclick="swapCartItem('${item._src}',${item._idx},'${esc}')">↕</button>
            </span>
          </div>`;
        }).join('')}
      </div>`;
    }).join('');
  } else {
    const sourcesPresent = mealOrder.filter(src => groups[src]?.some(i => _match(i.name)));
    list.innerHTML = sourcesPresent.map(source => {
      const items = (groups[source] || []).filter(i => _match(i.name));
      const isSpecial = ['staples', 'household', 'Breakfasts', 'Lunches', 'dessert', 'Snacks', 'holiday', '_found'].includes(source);
      const label = source === 'staples' ? 'Staples' : source === 'household' ? 'Household' : source === 'dessert' ? 'Dessert' : source === 'holiday' ? '🎄 Holiday Meal' : source === '_found' ? 'Manually Added' : source;
      const groupTotal = items.reduce((sum, i) => { const k=`${source}-${(groups[source]||[]).indexOf(i)}`; return _cartDeselected.has(k) ? sum : sum + parseFloat(i.price.replace('$','')); }, 0);
      return `<div class="cart-group">
        <div class="cart-group-header">
          <span class="cart-group-label${isSpecial ? ' special' : ''}">${label}</span>
          <span class="cart-group-subtotal">$${groupTotal.toFixed(2)}</span>
        </div>
        ${items.map((item) => {
          const origIdx = (groups[source] || []).indexOf(item);
          const key = `${source}-${origIdx}`;
          const desel = _cartDeselected.has(key);
          const esc = item.name.replace(/'/g, '&#39;');
          return `<div class="cart-item${desel ? ' deselected' : ''}" data-swap-key="${key}">
            <input type="checkbox" class="cart-item-check" ${desel ? '' : 'checked'} onchange="toggleCartItem('${key}')" aria-label="${esc}">
            <span class="cart-item-name">${item.name}</span>
            <span class="cart-item-right">
              <span class="cart-item-price">${item.price}</span>
              <button class="cart-item-swap" title="find alternative" aria-label="Find alternative for ${esc}" onclick="swapCartItem('${source}',${origIdx},'${esc}')">↕</button>
            </span>
          </div>`;
        }).join('')}
      </div>`;
    }).join('');
  }
}

function toggleCartItem(key) {
  const wasDeselected = _cartDeselected.has(key);
  if (wasDeselected) {
    _cartDeselected.delete(key);
  } else {
    _cartDeselected.add(key);
    // Offer pantry add when the user unchecks an item (they may already have it)
    const lastDash = key.lastIndexOf('-');
    const src      = key.slice(0, lastDash);
    const idx      = parseInt(key.slice(lastDash + 1));
    const item     = _cartData?.groups[src]?.[idx];
    if (item?.name) _offerAddToPantry(item.name);
  }
  _renderCartList(_cartData.groups, _cartData.mealOrder);
  _updateCartTotal();
}

async function _offerAddToPantry(productName) {
  // Truncate long Walmart product names to a readable label
  const label = productName.replace(/,?\s*\d+(\.\d+)?\s*(oz|lb|ct|pk|fl oz|gallon|gal|count)\b.*/i, '').trim() || productName;
  showToast(`Already have ${label}?`, {
    actionLabel: 'Add to pantry',
    actionFn: async () => {
      const today = new Date().toISOString().split('T')[0];
      try {
        await fetch('/pantry', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({name: label, addedOn: today}),
        });
        await loadPantry();
        showToast(`${label} added to pantry`);
      } catch(e) {
        showToast('Could not add to pantry', {type: 'error'});
      }
    },
  });
}

function _updateCartTotal() {
  let total = 0;
  _cartData.mealOrder.forEach(src => {
    (_cartData.groups[src] || []).forEach((item, origIdx) => {
      if (!_cartDeselected.has(`${src}-${origIdx}`)) {
        total += parseFloat(item.price.replace('$', '')) || 0;
      }
    });
  });
  document.getElementById('cartTotal').textContent = `$${total.toFixed(2)}`;
  _updateBudgetBar(total);
}

function _updateBudgetBar(totalNum) {
  const budgetBar = document.getElementById('budgetBar');
  if (!budgetBar) return;
  const target    = prefs.household?.budgetTarget;
  const budgetMax = prefs.household?.budgetMax;
  if (!target) { budgetBar.style.display = 'none'; return; }
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
  budgetBar.innerHTML = msg + (cls === 'budget-over' ? ` <button class="btn-link" style="margin-left:10px;font-size:11px" onclick="suggestCheaperSwaps()">suggest cheaper swaps →</button>` : '');
  budgetBar.style.display = 'block';
}

function checkPriceSpikes(groups) {
  const lastPrices    = prefs.lastStaplePrices || {};
  const currentPrices = {};
  const spikes        = [];
  const stapleGroups  = ['staples', 'household', 'Snacks', 'dessert'];
  stapleGroups.forEach(src => {
    (groups[src] || []).forEach(item => {
      const price = parseFloat(item.price.replace('$', ''));
      currentPrices[item.name] = price;
      const last = lastPrices[item.name];
      if (last && price > last * 1.10) {
        const pct = Math.round((price / last - 1) * 100);
        spikes.push(`${item.name}: $${last.toFixed(2)} → ${item.price} (+${pct}%)`);
      }
    });
  });
  prefs.lastStaplePrices = { ...lastPrices, ...currentPrices };
  fetch('/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(prefs) }).catch(() => {});
  return spikes;
}




function _renderNotFoundBox() {
  const notFoundBox = document.getElementById('notFoundBox');
  if (!notFoundBox) return;
  if (!_cartData.notFound?.length) { notFoundBox.style.display = 'none'; return; }
  notFoundBox.style.display = 'block';
  notFoundBox.innerHTML = `<strong>⚠ Couldn't find at your Walmart — try a different search:</strong>` +
    _cartData.notFound.map((item, idx) => `
      <div class="not-found-row" id="nf-row-${idx}">
        <span class="not-found-name">${item}</span>
        <input class="not-found-input" id="nf-input-${idx}" value="${item.replace(/"/g, '&quot;')}" placeholder="try a different name...">
        <button class="btn not-found-btn" onclick="retryNotFound(${idx})">search →</button>
      </div>`).join('');
}

async function retryNotFound(idx) {
  const input = document.getElementById(`nf-input-${idx}`);
  if (!input) return;
  const btn = input.nextElementSibling;
  const query = input.value.trim();
  if (!query) return;
  btn.textContent = '…';
  btn.disabled = true;
  try {
    const resp = await fetch('/swap-item', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const product = await resp.json();
    if (!resp.ok || product.error) { btn.textContent = 'not found'; btn.disabled = false; return; }
    if (!_cartData.groups._found) {
      _cartData.groups._found = [];
      _cartData.mealOrder.push('_found');
    }
    _cartData.groups._found.push({ name: product.name, price: product.price, itemId: product.itemId, qty: 1 });
    _cartData.notFound.splice(idx, 1);
    _renderCartList(_cartData.groups, _cartData.mealOrder);
    _updateCartTotal();
    _renderNotFoundBox();
    showToast(`Added ${product.name}`);
  } catch(e) { btn.textContent = 'error'; btn.disabled = false; }
}

function renderCart(groups, mealOrder, total, url, notFound, skipSanity = false) {
  _cartData = { groups, mealOrder, total, url, notFound: notFound ? [...notFound] : [] };
  _cartView = 'meal';
  _cartFilter = '';
  _cartDeselected = new Set();
  const searchEl = document.getElementById('cartSearch');
  if (searchEl) searchEl.value = '';
  document.getElementById('cartViewMeal').classList.add('active');
  document.getElementById('cartViewCategory').classList.remove('active');
  document.getElementById('cartCard').style.display = 'block';
  document.getElementById('doneBtn').style.display = 'inline-flex';
  document.getElementById('buildCartBtn').style.display = 'none';

  _renderCartList(groups, mealOrder);

  document.getElementById('cartTotal').textContent = total;
  _updateBudgetBar(parseFloat(total.replace('$', '')) || 0);

  // Not-found items — interactive retry rows
  _renderNotFoundBox();

  // Price spike detection
  const spikes = checkPriceSpikes(groups);
  const spikeBox = document.getElementById('spikeBox');
  if (spikeBox) {
    if (spikes.length) {
      spikeBox.style.display = 'block';
      spikeBox.innerHTML = `<strong>Price spikes vs. last week:</strong><br>${spikes.map(s => `• ${s}`).join('<br>')}`;
    } else {
      spikeBox.style.display = 'none';
    }
  }

  document.getElementById('openCartBtn').onclick = () => window.open(buildFilteredCartUrl(), '_blank', 'noopener,noreferrer');
  if (url) document.getElementById('cartUrlBox').style.display = 'flex';

  // Show prep guide card
  const pgCard = document.getElementById('prepGuideCard');
  if (pgCard) pgCard.style.display = 'block';
}

function buildFilteredCartUrl() {
  if (!_cartData?.url) return '#';
  const parts = [];
  _cartData.mealOrder.forEach(src => {
    (_cartData.groups[src] || []).forEach((item, origIdx) => {
      if (!_cartDeselected.has(`${src}-${origIdx}`) && item.itemId) {
        parts.push(`${item.itemId}|${item.qty || 1}`);
      }
    });
  });
  if (!parts.length) return _cartData.url;
  const base = 'https://affil.walmart.com/cart/addToCart?items=' + parts.join(',');
  const publisherId = _cartData.url.match(/affiliateId=([^&]+)/)?.[1];
  return publisherId ? base + '&affiliateId=' + publisherId : base;
}

function confirmOrder() {
  const btn = document.getElementById('doneBtn');
  btn.textContent = '✓ order placed';
  btn.disabled = true;
  btn.className = 'btn mustard';
  _finalizeWeek(); // fire and forget — saves doNotRepeat; rating happens next week in recap
}

async function suggestCheaperSwaps() {
  const swapBox = document.getElementById('swapSuggestBox');
  if (!swapBox) return;
  swapBox.style.display = 'block';
  swapBox.innerHTML = '<span class="hh-loading">Asking Claude for ideas...</span>';
  const allItems = [];
  (_cartData?.mealOrder || []).forEach(src => (_cartData?.groups[src] || []).forEach(i => allItems.push(i)));
  const target    = prefs.household?.budgetTarget || 175;
  const budgetMax = prefs.household?.budgetMax || 225;
  const itemList  = allItems.map(i => `${i.name} — ${i.price}`).join('\n');
  try {
    const resp = await fetch('/claude-prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: `Budget target: $${target} (max $${budgetMax}). Current cart:\n${itemList}\n\nSuggest 3-5 specific, practical swaps to reduce the total by 10-15%. Focus on the most expensive items. Be concise — one line per swap like "• Swap [expensive item] for [cheaper alternative] — save ~$X".` }),
    });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error);
    const text  = (data.content || '').trim();
    swapBox.innerHTML = text.split('\n').filter(Boolean).map(l => `<div class="recap-hint" style="margin-bottom:4px">${l}</div>`).join('');
  } catch(e) {
    swapBox.innerHTML = '<div class="recap-hint">Could not load suggestions — check your Terminal.</div>';
  }
}

async function swapCartItem(source, itemIdx, origName) {
  const inputId = `swap-input-${source}-${itemIdx}`;
  const existing = document.getElementById(inputId);
  if (existing) { existing.focus(); return; }

  const itemEl = document.querySelector(`[data-swap-key="${source}-${itemIdx}"]`);
  if (!itemEl) return;

  const input = document.createElement('input');
  input.className = 'schedule-note';
  input.id = inputId;
  input.value = origName;
  input.style.cssText = 'width:100%;margin-top:4px;font-size:12px';
  input.placeholder = 'enter alternative product...';

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:6px;margin-top:4px';
  const goBtn = document.createElement('button');
  goBtn.className = 'btn';
  goBtn.style.cssText = 'padding:3px 10px;font-size:11px;height:26px';
  goBtn.textContent = 'find →';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn';
  cancelBtn.style.cssText = 'padding:3px 10px;font-size:11px;height:26px';
  cancelBtn.textContent = 'cancel';
  row.append(input, goBtn, cancelBtn);
  itemEl.after(row);
  input.focus();
  input.select();
  input.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const doSwap = async () => {
    const query = input.value.trim();
    if (!query) return;
    goBtn.textContent = '…';
    goBtn.disabled = true;
    try {
      const resp = await fetch('/swap-item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const product = await resp.json();
      if (!resp.ok || product.error) { goBtn.textContent = 'not found'; goBtn.disabled = false; return; }
      _cartData.groups[source][itemIdx] = { name: product.name, price: product.price, itemId: product.itemId, qty: _cartData.groups[source][itemIdx]?.qty || 1 };
      row.remove();
      _renderCartList(_cartData.groups, _cartData.mealOrder);
      _updateCartTotal();
    } catch(e) {
      goBtn.textContent = 'error'; goBtn.disabled = false;
    }
  };

  goBtn.onclick     = doSwap;
  cancelBtn.onclick = () => row.remove();
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doSwap(); if (e.key === 'Escape') row.remove(); });
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
  if (prefs.athleteTraining?.enabled) {
    const at = prefs.athleteTraining;
    const prevDayMap = { Monday:'Sunday', Tuesday:'Monday', Wednesday:'Tuesday', Thursday:'Wednesday', Friday:'Thursday', Saturday:'Friday', Sunday:'Saturday' };
    const carbNightDay = prevDayMap[at.longRunDay || 'Saturday'];
    const runDays = at.runDays || [];
    lines.push(`\nATHLETE TRAINING: One adult is training for ${at.raceName || 'a marathon'}${at.raceDate ? ' (' + at.raceDate + ')' : ''}. Phase: ${at.phase || 'Base Building'}. Long run is ${at.longRunDay || 'Saturday'} (${at.weeklyLongRunMi || '?'} mi this week). Run days: ${runDays.join(', ') || 'Mon/Wed/Fri/Sat'}.`);
    lines.push(`\nDINNER NUDGES FOR TRAINING (adjust the family dinner — everyone eats these):`);
    lines.push(`- ${carbNightDay} dinner: carb-heavy (pasta, rice dishes, pizza) to fuel the long run`);
    lines.push(`- ${at.longRunDay || 'Saturday'} dinner: protein-focused recovery meal (chicken, salmon, beef)`);
    if (runDays.includes('Monday')) lines.push(`- Monday dinner: include good protein for post-tempo recovery`);
  } else if (prefs.nutritionFocus) {
    lines.push(`NUTRITION FOCUS: ${prefs.nutritionFocus}`);
  }
  if (prefs.dietaryNotes?.length) {
    lines.push('\nDIETARY NOTES:');
    prefs.dietaryNotes.forEach(n => lines.push(`- ${n}`));
  }
  if (staples.length) {
    lines.push('\nWEEKLY STAPLES (include every order):');
    staples.forEach(s => {
      const meta = [s.qty > 1 ? s.qty : '', s.unit].filter(Boolean).join(' ');
      lines.push(`- ${s.name}${meta ? ' (' + meta + ')' : ''}`);
    });
  }
  if (prefs.brandRules?.length) {
    lines.push('\nBRAND RULES (always use these brands):');
    prefs.brandRules.forEach(r => lines.push(`- ${r.item}: ${r.brand}`));
  }

  // 4-week history takes priority over single-week doNotRepeat
  if (prefs.mealHistory?.length) {
    const recentMeals = [...new Set(prefs.mealHistory.flatMap(w => w.meals || []))];
    if (recentMeals.length) lines.push(`\nDO NOT REPEAT (last ${prefs.mealHistory.length} weeks): ${recentMeals.join(', ')}`);
  } else if (prefs.doNotRepeat?.length) {
    lines.push(`\nDO NOT INCLUDE this week: ${prefs.doNotRepeat.join(', ')}`);
  }

  if (prefs.neverSuggest?.length) lines.push(`\nNEVER SUGGEST (user blocked permanently): ${prefs.neverSuggest.join(', ')}`);
  if (prefs.notes) lines.push(`\nNOTES: ${prefs.notes}`);
  return lines.join('\n');
}


// ===== PREFERENCES PAGE =====
function openPrefsPage(fromHistory = false) {
  _prefsDirty = false;
  if (!fromHistory) history.pushState({ step: currentStep, overlay: 'prefs' }, '');
  const page = document.getElementById('prefsPage');
  page.style.display = 'flex';
  page.addEventListener('input', _markPrefsDirty);
  _syncPanelOpen();
  renderPrefsPage();
  _prefsTrap = _trapFocus(page);
}

function _markPrefsDirty() { _prefsDirty = true; }

function closePrefsPage(fromHistory = false) {
  if (_prefsDirty && !fromHistory) {
    if (!confirm('You have unsaved changes. Close without saving?')) return;
  }
  if (!fromHistory) history.replaceState({ step: currentStep, overlay: null }, '');
  const page = document.getElementById('prefsPage');
  page.removeEventListener('input', _markPrefsDirty);
  page.style.display = 'none';
  _prefsDirty = false;
  _syncPanelOpen();
  _prefsTrap?.(); _prefsTrap = null;
}

function switchPrefsTab(tab) {
  ['appearance', 'household', 'food', 'history', 'account'].forEach(t => {
    document.getElementById(`prefTab-${t}`)?.classList.toggle('active', t === tab);
    const el = document.getElementById(`prefContent-${t}`);
    if (el) el.style.display = t === tab ? '' : 'none';
  });
  if (tab === 'account') _populateAccountTab();
}

async function _populateAccountTab() {
  const el = document.getElementById('acct-username');
  if (!el || el.value) return;
  try {
    const r = await fetch('/me');
    const d = await r.json();
    el.value = d.username || '';
  } catch (_) {}
}

async function changePassword() {
  const current = document.getElementById('acct-current-pw').value;
  const newPw   = document.getElementById('acct-new-pw').value;
  const confirm = document.getElementById('acct-confirm-pw').value;
  const msg     = document.getElementById('acct-pw-msg');

  msg.style.color = 'var(--text3)';
  msg.textContent = '';

  if (!current || !newPw || !confirm) {
    msg.style.color = 'var(--urgent-red-text)';
    msg.textContent = 'All three fields are required.';
    return;
  }
  if (newPw !== confirm) {
    msg.style.color = 'var(--urgent-red-text)';
    msg.textContent = 'New passwords don\'t match.';
    return;
  }
  if (newPw.length < 6) {
    msg.style.color = 'var(--urgent-red-text)';
    msg.textContent = 'New password must be at least 6 characters.';
    return;
  }

  msg.textContent = 'Saving…';
  try {
    const r = await fetch('/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: current, newPassword: newPw }),
    });
    const d = await r.json();
    if (r.ok) {
      msg.style.color = 'var(--approval)';
      msg.textContent = 'Password updated.';
      document.getElementById('acct-current-pw').value = '';
      document.getElementById('acct-new-pw').value     = '';
      document.getElementById('acct-confirm-pw').value = '';
    } else {
      msg.style.color = 'var(--urgent-red-text)';
      msg.textContent = d.error || 'Update failed.';
    }
  } catch (_) {
    msg.style.color = 'var(--urgent-red-text)';
    msg.textContent = 'Network error.';
  }
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
  prefs.brandRules      = readBrandRules();
  prefs.householdItems  = readHhItemsPrefs();
  prefs.storeOk         = '';
  prefs.notes           = document.getElementById('pf-notes').value.trim();
  prefs.nutritionFocus  = document.getElementById('pf-nutritionFocus').value;
  prefs.timezone        = document.getElementById('pf-timezone').value.trim() || 'America/Denver';
  prefs.emails          = document.getElementById('pf-emails').value.split(',').map(e => e.trim()).filter(Boolean);

  try {
    await fetch('/prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prefs),
    });
  } catch(e) {}

  householdItems = (prefs.householdItems || []).map(_normalizeHhItem);
  renderHousehold();
  _prefsDirty = false;
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
  document.getElementById('pf-emails').value        = (prefs.emails || []).join(', ');
  if (prefs.storeOk && !(prefs.notes || '').includes('Store brand OK')) {
    prefs.notes = `Store brand OK for: ${prefs.storeOk}\n\n${prefs.notes || ''}`.trim();
    prefs.storeOk = '';
  }
  document.getElementById('pf-notes').value          = prefs.notes || '';
  document.getElementById('pf-nutritionFocus').value = prefs.nutritionFocus || '';

  const _curTheme = localStorage.getItem(LS_THEME) || 'auto';
  document.querySelectorAll('input[name="pf-theme"]').forEach(r => { r.checked = r.value === _curTheme; });

  renderPrefsList('pf-dietList', prefs.dietaryNotes || []);
  renderBrandList(prefs.brandRules || []);
  renderHhItemsPrefs((prefs.householdItems || []).map(_normalizeHhItem));
  renderMealHistoryCard();
  switchPrefsTab('appearance');

  const btn = document.getElementById('prefsSaveBtn');
  if (btn) { btn.textContent = 'save →'; btn.disabled = false; }
}

function renderMealHistoryCard() {
  const el = document.getElementById('mealHistoryCard');
  if (!el) return;

  const history     = prefs.mealHistory || [];
  const neverSuggest = prefs.neverSuggest || [];
  const doNotRepeat  = prefs.doNotRepeat  || [];

  let html = '';

  // Rotation history (mealHistory + doNotRepeat)
  const historyWeeks = history.length;
  const recentMeals  = [...new Set([...history.flatMap(w => w.meals || []), ...doNotRepeat])];
  html += `<div class="meal-history-row">
    <div>
      <div class="meal-history-label">rotation history</div>
      <div class="meal-history-detail">${historyWeeks ? `${historyWeeks} week${historyWeeks !== 1 ? 's' : ''} stored` : 'none stored'}${recentMeals.length ? ` — ${recentMeals.join(', ')}` : ''}</div>
    </div>
    <button class="btn" onclick="clearMealHistory()" ${!recentMeals.length ? 'disabled' : ''}>clear</button>
  </div>`;

  // Never-suggest list
  html += `<div class="meal-history-row" style="margin-top:10px;align-items:flex-start">
    <div style="flex:1;min-width:0">
      <div class="meal-history-label">permanently blocked meals</div>
      ${neverSuggest.length
        ? `<div class="never-suggest-list">${neverSuggest.map((name, i) =>
            `<span class="never-suggest-chip">${name}<button class="never-suggest-remove" onclick="removeNeverSuggest(${i})" title="unblock">×</button></span>`
          ).join('')}</div>`
        : '<div class="meal-history-detail">none blocked</div>'
      }
    </div>
    ${neverSuggest.length ? `<button class="btn" onclick="clearNeverSuggest()" style="flex-shrink:0">clear all</button>` : ''}
  </div>`;

  el.innerHTML = html;
}

async function clearMealHistory() {
  prefs.mealHistory  = [];
  prefs.doNotRepeat  = [];
  try {
    await fetch('/prefs', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(prefs),
    });
  } catch(e) {}
  renderMealHistoryCard();
  showToast('Rotation history cleared — all meals are fair game again');
}

async function removeNeverSuggest(idx) {
  if (!prefs.neverSuggest?.[idx]) return;
  const name = prefs.neverSuggest[idx];
  prefs.neverSuggest.splice(idx, 1);
  try {
    await fetch('/prefs', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(prefs),
    });
  } catch(e) {}
  renderMealHistoryCard();
  showToast(`"${name}" unblocked`);
}

async function clearNeverSuggest() {
  prefs.neverSuggest = [];
  try {
    await fetch('/prefs', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(prefs),
    });
  } catch(e) {}
  renderMealHistoryCard();
  showToast('All blocked meals unblocked');
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
  const map = { diet:'pf-dietList', frequent:'pf-frequentList' };
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

function hhItemPrefHtml(name = '', category = '', brand = '', cadenceDays = 0, lastOrderedOn = '') {
  const nameEsc  = (name  || '').replace(/"/g, '&quot;');
  const brandEsc = (brand || '').replace(/"/g, '&quot;');
  const cat  = category || _hhCategory(name);
  const opts = HH_CATEGORY_ORDER.map(c =>
    `<option value="${c}"${c === cat ? ' selected' : ''}>${HH_CATEGORY_LABELS[c]}</option>`
  ).join('');
  return `<div class="prefs-hh-row" data-last-ordered-on="${lastOrderedOn}">
    <input class="prefs-hh-name" type="text" value="${nameEsc}" placeholder="item name" />
    <select class="prefs-hh-cat">${opts}</select>
    <input class="prefs-hh-brand" type="text" value="${brandEsc}" placeholder="brand (opt.)" />
    <input class="prefs-hh-cadence" type="number" min="0" value="${cadenceDays || ''}" placeholder="days" title="reorder every N days (leave blank for no reminder)" />
    <button class="prefs-remove-btn" onclick="this.parentElement.remove()" title="remove">×</button>
  </div>`;
}

function renderHhItemsPrefs(items) {
  const el = document.getElementById('pf-hhItemsList');
  if (!el) return;
  el.innerHTML = items.map(i => hhItemPrefHtml(i.name, i.category, i.brand, i.cadenceDays, i.lastOrderedOn)).join('');
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
      name:          row.querySelector('.prefs-hh-name').value.trim(),
      category:      row.querySelector('.prefs-hh-cat').value,
      brand:         row.querySelector('.prefs-hh-brand').value.trim(),
      cadenceDays:   parseInt(row.querySelector('.prefs-hh-cadence').value) || 0,
      lastOrderedOn: row.dataset.lastOrderedOn || '',
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
function openRecipeModal(r) {
  document.getElementById('recipeModalName').textContent = r.name;
  const body = document.getElementById('recipeModalBody');
  const tags = (r.tags||[]).map(t => `<span class="recipe-tag">${t}</span>`).join('');
  body.innerHTML = `
    ${r.photo ? `<img class="recipe-modal-hero" src="${r.photo}" alt="${r.name}">` : ''}
    <div class="recipe-modal-meta">
      <div style="display:flex;align-items:center;gap:10px">
        ${starsHtml(r.rating)}
        ${r.timesPlanned ? `<span class="recipe-times">${r.timesPlanned}× planned</span>` : ''}
      </div>
      ${tags ? `<div class="recipe-tags" style="margin-top:5px">${tags}</div>` : ''}
      ${r.notes ? `<div class="recipe-notes">${r.notes}</div>` : ''}
    </div>
    ${recipeDetailHtml(r)}`;
  document.getElementById('recipeModal').style.display = 'flex';
}

async function openMealRecipe(i) {
  const mealObj = meals[i];
  if (!mealObj) return;
  const name = mealObj.meal.replace(' [NEW]', '').trim();
  const _normN = s => s.toLowerCase().replace(/[^a-z0-9 ]/g,'').replace(/\s+/g,' ').trim();
  const _nn = _normN(name);
  let r = recipes.find(r => _normN(r.name) === _nn);
  if (!r) r = recipes.find(r => { const rn=_normN(r.name); return rn.includes(_nn)||_nn.includes(rn); });

  document.getElementById('recipeModal').style.display = 'flex';

  if (r) {
    openRecipeModal(r);
    return;
  }

  // Not in recipe book — generate it
  _pendingGeneratedRecipe = null;
  const body = document.getElementById('recipeModalBody');
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
  document.getElementById('recipeModal').style.display = 'none';
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
    showToast(`Pantry import: ${result.imported} added, ${result.updated} updated`);
  } catch(e) {
    if (btn) btn.textContent = '✗ import failed';
    showToast('Import failed — check file format', { type: 'error' });
  }
  input.value = '';
  if (btn) setTimeout(() => { btn.textContent = 'import CSV'; btn.disabled = false; }, 3000);
}

let _orderParsedItems = [];

function openOrderUpload() {
  const card = document.getElementById('orderUploadCard');
  if (card) { card.style.display = 'block'; card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
}

function closeOrderUpload() {
  const card = document.getElementById('orderUploadCard');
  if (card) card.style.display = 'none';
  _orderParsedItems = [];
  const s  = document.getElementById('orderResultsSection'); if (s)  s.style.display = 'none';
  const st = document.getElementById('orderParseStatus');    if (st) st.textContent = '';
  const ti = document.getElementById('orderCsvInput');       if (ti) ti.value = '';
  const pi = document.getElementById('orderPdfInput');       if (pi) pi.value = '';
}

function switchOrderTab(tab) {
  document.getElementById('orderCsvSection').style.display = tab === 'csv' ? '' : 'none';
  document.getElementById('orderPdfSection').style.display = tab === 'pdf' ? '' : 'none';
  document.querySelectorAll('.order-tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(tab === 'csv' ? 'orderTabCsv' : 'orderTabPdf')?.classList.add('active');
}

async function parseWalmartOrder() {
  const status    = document.getElementById('orderParseStatus');
  const pdfHidden = document.getElementById('orderPdfSection')?.style.display === 'none';
  const activeTab = pdfHidden ? 'csv' : 'pdf';
  let body;
  if (activeTab === 'csv') {
    const csv = document.getElementById('orderCsvInput')?.value.trim();
    if (!csv) { if (status) status.textContent = 'Paste your CSV first'; return; }
    body = { csv };
  } else {
    const file = document.getElementById('orderPdfInput')?.files[0];
    if (!file) { if (status) status.textContent = 'Choose a PDF first'; return; }
    const pdf = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = e => res(e.target.result.split(',')[1]);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
    body = { pdf };
  }
  if (status) status.textContent = 'Parsing…';
  try {
    const endpoint = activeTab === 'csv' ? '/feedback/order-csv' : '/feedback/order-pdf';
    const resp = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error || 'Parse failed');
    _orderParsedItems = data.pantryItems || [];
    if (status) status.textContent = `Found ${_orderParsedItems.length} items`;
    _renderOrderResults();
  } catch(e) {
    if (status) status.textContent = `Error: ${e.message}`;
  }
}

function _renderOrderResults() {
  const section = document.getElementById('orderResultsSection');
  const list    = document.getElementById('orderItemsList');
  if (!section || !list) return;
  section.style.display = _orderParsedItems.length ? 'block' : 'none';
  list.innerHTML = _orderParsedItems.map((item, i) => {
    const esc = (item.name || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return `<div class="order-result-row">
      <input type="checkbox" id="orderItem${i}" checked>
      <label for="orderItem${i}" style="flex:1;cursor:pointer">${esc}</label>
      <input class="schedule-note" style="width:52px" value="${item.amount || ''}" placeholder="qty"
             oninput="_orderParsedItems[${i}].amount=this.value">
      <input class="schedule-note" style="width:64px" value="${item.unit || ''}" placeholder="unit"
             oninput="_orderParsedItems[${i}].unit=this.value">
    </div>`;
  }).join('');
}

async function confirmOrderItems() {
  const items = _orderParsedItems
    .filter((_, i) => document.getElementById(`orderItem${i}`)?.checked)
    .map(item => ({ name: item.name, amount: item.amount || '', unit: item.unit || '' }));
  if (!items.length) { showToast('No items selected'); return; }
  try {
    const resp = await fetch('/pantry/batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }),
    });
    if (!resp.ok) throw new Error('Failed to add items');
    await loadPantry();
    renderPantryPanel();
    closeOrderUpload();
    showToast(`${items.length} item${items.length !== 1 ? 's' : ''} added to pantry`, { duration: 6000 });
  } catch(e) {
    showToast(`Error: ${e.message}`, { type: 'error' });
  }
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
    showToast(`Recipes import: ${result.imported} added, ${result.updated} updated`);
  } catch(e) {
    if (btn) btn.textContent = '✗ import failed';
    showToast('Import failed — check file format', { type: 'error' });
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

// ===== SPEND HISTORY DASHBOARD =====
let _historyTrap = null;

function openHistoryPage(fromHistory = false) {
  if (!fromHistory) history.pushState({ step: currentStep, overlay: 'history' }, '');
  document.getElementById('historyPage').style.display = 'flex';
  _syncPanelOpen();
  renderHistoryDashboard();
  _historyTrap = _trapFocus(document.getElementById('historyPage'));
}

function closeHistoryPage(fromHistory = false) {
  if (!fromHistory) history.replaceState({ step: currentStep, overlay: null }, '');
  document.getElementById('historyPage').style.display = 'none';
  _syncPanelOpen();
  _historyTrap?.(); _historyTrap = null;
}

async function deleteHistoryWeek(date) {
  if (!confirm(`Delete spend history for week of ${date}?`)) return;
  await fetch('/spend-history', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date }),
  }).catch(() => null);
  showToast('Week removed', { duration: 4000 });
  renderHistoryDashboard();
}

async function renderHistoryDashboard() {
  const el = document.getElementById('historyDashboard');
  if (!el) return;
  el.innerHTML = '<span class="hh-loading">loading...</span>';
  try {
    const resp = await fetch('/spend-history');
    if (!resp.ok) throw new Error('no data');
    const history = await resp.json();
    if (!history.length) {
      el.innerHTML = '<div class="hh-loading">no spend history yet — complete a weekly session to start tracking</div>';
      return;
    }

    const budgetTarget = prefs.household?.budgetTarget || 175;
    const budgetMax    = prefs.household?.budgetMax    || 225;
    const recent       = history.slice(-16);
    const totals       = recent.map(w => w.total);
    const avg          = totals.reduce((a, b) => a + b, 0) / totals.length;
    const underTarget  = recent.filter(w => w.total <= budgetTarget).length;
    const overTarget   = recent.filter(w => w.total > budgetTarget && w.total <= budgetMax).length;
    const overMax      = recent.filter(w => w.total > budgetMax).length;
    const chartMax     = Math.max(...totals, budgetMax) * 1.15;

    const bars = recent.slice(-12).map(w => {
      const d     = new Date(w.date + 'T12:00:00');
      const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const pct   = Math.round((w.total / chartMax) * 100);
      const tPct  = Math.round((budgetTarget / chartMax) * 100);
      const mPct  = Math.round((budgetMax    / chartMax) * 100);
      const color = w.total <= budgetTarget ? 'var(--approval)' : w.total <= budgetMax ? 'var(--accent)' : 'var(--urgent-red-text)';
      return `<div class="spend-bar-row">
        <span class="spend-bar-label">${label}</span>
        <div class="spend-bar-track">
          <div class="spend-bar-fill" style="width:${Math.min(pct,100)}%;background:${color}"></div>
          <div class="spend-bar-ref-line spend-bar-target-line" style="left:${tPct}%" title="target $${budgetTarget}"></div>
          <div class="spend-bar-ref-line spend-bar-max-line"    style="left:${mPct}%" title="max $${budgetMax}"></div>
        </div>
        <span class="spend-bar-val" style="color:${color}">$${w.total.toFixed(0)}</span>
        <button class="spend-bar-delete" onclick="deleteHistoryWeek('${w.date}')" title="Delete week of ${label}" aria-label="Delete week of ${label}">×</button>
      </div>`;
    }).join('');

    const mealHistoryHtml = (prefs.mealHistory || []).slice(-4).reverse().map(w => {
      const d     = new Date(w.week + 'T12:00:00');
      const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      return `<div class="spend-meal-week">
        <span class="spend-meal-week-label">${label}</span>
        <span class="spend-meal-list">${(w.meals || []).join(' · ')}</span>
      </div>`;
    }).join('') || '<div class="hh-loading">no meal history yet</div>';

    el.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <div class="card-label">summary · last ${recent.length} weeks</div>
        <div class="spend-stats-row">
          <div class="spend-stat"><span class="spend-stat-val">$${avg.toFixed(0)}</span><span class="spend-stat-label">avg / week</span></div>
          <div class="spend-stat"><span class="spend-stat-val" style="color:var(--approval)">${underTarget}</span><span class="spend-stat-label">under target</span></div>
          <div class="spend-stat"><span class="spend-stat-val" style="color:var(--accent)">${overTarget}</span><span class="spend-stat-label">over target</span></div>
          <div class="spend-stat"><span class="spend-stat-val" style="color:var(--urgent-red-text)">${overMax}</span><span class="spend-stat-label">over max</span></div>
        </div>
        <div class="spend-budget-ref">target $${budgetTarget} · max $${budgetMax}</div>
      </div>
      <div class="card" style="margin-bottom:14px">
        <div class="card-label">weekly spend</div>
        <div class="spend-bar-legend">
          <span class="spend-bar-legend-item"><span class="spend-bar-legend-dot" style="background:var(--approval)"></span>under $${budgetTarget}</span>
          <span class="spend-bar-legend-item"><span class="spend-bar-legend-dot" style="background:var(--accent)"></span>over target</span>
          <span class="spend-bar-legend-item"><span class="spend-bar-legend-dot" style="background:var(--urgent-red-text)"></span>over max</span>
        </div>
        <div class="spend-bars">${bars}</div>
      </div>
      <div class="card">
        <div class="card-label">recent meal plans</div>
        <div class="spend-meal-history">${mealHistoryHtml}</div>
      </div>`;
  } catch(e) {
    el.innerHTML = '<div class="hh-loading">could not load history — make sure the server is running</div>';
  }
}

// ===== INIT =====
// Show dashboard as the landing page; planning flow stays hidden until "Start planning" is clicked.
showDashboard();
// Prime the planning flow in the background so it's ready when the user starts
goToStep(0, true);
renderSchedule();
loadPrefs().then(async () => {
  renderStep0Extras(); initServingSize(); renderRecapCard(); checkOnboarding();
  // One-time migration: move frequentStaples strings into unified staples.json
  if (prefs.frequentStaples?.length) {
    for (const name of prefs.frequentStaples) {
      try { await fetch('/staples', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name }) }); } catch(e) {}
    }
    prefs.frequentStaples = [];
    try { await fetch('/prefs', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(prefs) }); } catch(e) {}
    staples = await fetch('/staples').then(r => r.json()).then(d => d.items || []).catch(() => []);
    renderStaplesStep();
    renderStaplesPanel();
  }
});
loadHouseholdItems();
loadRecipes();
loadPantry().then(() => renderPantryToggle());
loadStaples().then(() => renderStaplesStep());
loadCalendarStatus();

(async () => {
  try {
    const r = await fetch('/api/mode');
    if (r.ok) {
      const { mode } = await r.json();
      if (mode === 'demo') {
        document.title = '[DEMO] Grocery Agent';
        const badge = document.createElement('span');
        badge.id = 'demoBadge';
        badge.textContent = 'DEMO';
        badge.style.cssText = 'background:var(--primary);color:#fff;font-family:var(--mono);font-size:10px;font-weight:700;letter-spacing:.1em;padding:3px 10px;border-radius:var(--r-pill);margin-right:8px;pointer-events:none;';
        const actions = document.querySelector('.top-nav-actions');
        if (actions) actions.prepend(badge);
      }
    }
  } catch(e) {}
})();

window.addEventListener('message', async (e) => {
  if (e.data === 'calendar_connected') {
    await loadCalendarStatus();
    renderSchedule();
  }
});

// ===== FEEDBACK =====
function openFeedbackModal() {
  document.getElementById('feedbackModal').style.display = 'flex';
  setTimeout(() => document.getElementById('feedbackText').focus(), 60);
}

function closeFeedbackModal() {
  document.getElementById('feedbackModal').style.display = 'none';
  document.getElementById('feedbackText').value = '';
}

function _closeFeedbackModal(e) {
  if (e.target.id === 'feedbackModal') closeFeedbackModal();
}

async function submitFeedback() {
  const message = (document.getElementById('feedbackText')?.value || '').trim();
  if (!message) return;
  const type = document.querySelector('input[name="feedbackType"]:checked')?.value || 'other';
  try {
    await fetch('/feedback', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ type, message })
    });
    closeFeedbackModal();
    showToast('feedback sent — thank you!', { type: 'success' });
  } catch(e) {
    showToast('could not send feedback', { type: 'error' });
  }
}
