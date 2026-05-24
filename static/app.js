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

const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const DAY_ABBR = { Monday:'Mon', Tuesday:'Tue', Wednesday:'Wed', Thursday:'Thu', Friday:'Fri', Saturday:'Sat', Sunday:'Sun' };

// ===== NAVIGATION =====
function goToStep(n) {
  [0,1,2].forEach(i => {
    const step = document.getElementById('step'+i);
    if (step) step.style.display = i===n ? 'block' : 'none';
    const hero = document.getElementById('heroStep'+i);
    if (hero) {
      if (i < n)      hero.className = 'hero-step-card done';
      else if (i===n) hero.className = 'hero-step-card active';
      else            hero.className = 'hero-step-card todo';
    }
  });
  currentStep = n;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ===== HOUSEHOLD ITEMS =====
const LS_HOUSEHOLD_KEY = 'grocery_household_checked';
let householdItems = [];
let householdChecked = new Set(JSON.parse(localStorage.getItem(LS_HOUSEHOLD_KEY) || '[]'));

function renderHousehold() {
  const grid = document.getElementById('hhGrid');
  if (!householdItems.length) { grid.innerHTML = '<span class="hh-loading">no household items found in preferences.md</span>'; return; }
  grid.innerHTML = householdItems.map(name => {
    const checked = householdChecked.has(name);
    const esc = name.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    return `<label class="hh-item">
      <input type="checkbox" ${checked ? 'checked' : ''} onchange="toggleHousehold('${esc}', this.checked)">
      <span class="hh-item-name">${name}</span>
    </label>`;
  }).join('');
  updateHhCount();
}

function toggleHousehold(name, checked) {
  checked ? householdChecked.add(name) : householdChecked.delete(name);
  localStorage.setItem(LS_HOUSEHOLD_KEY, JSON.stringify([...householdChecked]));
  updateHhCount();
}

function updateHhCount() {
  const n = householdChecked.size;
  document.getElementById('hhCount').textContent = n === 0 ? '0 selected' : `${n} selected`;
}

async function loadHouseholdItems() {
  try {
    const resp = await fetch('/household-items');
    const data = await resp.json();
    householdItems = data.items || [];
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
  if (!prefs.householdItems.includes(name)) {
    prefs.householdItems.push(name);
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
  if (buildBtn) buildBtn.style.display = 'inline-flex';
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
  await fetch(`/recipes/${id}`, { method: 'DELETE' });
  await loadRecipes();
  renderRecipesPanel();
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

// Recipe panel
function _syncPanelOpen() {
  const prefsOpen   = document.getElementById('prefsEditor').style.display  !== 'none';
  const recipesOpen = document.getElementById('recipesPanel').style.display !== 'none';
  const pantryOpen  = document.getElementById('pantryPanel').style.display  !== 'none';
  document.getElementById('navPrefs').classList.toggle('active', prefsOpen);
  document.getElementById('navRecipes').classList.toggle('active', recipesOpen);
  document.getElementById('navPantry').classList.toggle('active', pantryOpen);
}

function toggleRecipesPanel() {
  const panel = document.getElementById('recipesPanel');
  const visible = panel.style.display !== 'none';
  panel.style.display = visible ? 'none' : 'block';
  _syncPanelOpen();
  if (!visible) { document.getElementById('recipesSearch').value = ''; renderRecipesPanel(); }
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
  return `<div class="recipe-card" id="rc-${r.id}">
    <div class="recipe-card-main">
      <div>
        <div class="recipe-name">${r.name}</div>
        <div class="recipe-meta">
          ${starsHtml(r.rating)}
          ${r.timesPlanned ? `<span class="recipe-times">${r.timesPlanned}× planned</span>` : ''}
        </div>
        ${tags ? `<div class="recipe-tags">${tags}</div>` : ''}
        ${r.notes ? `<div class="recipe-notes">${r.notes}</div>` : ''}
      </div>
      <div class="recipe-actions">
        <button class="btn-icon" id="rd-btn-${r.id}" onclick="toggleRecipeDetail('${r.id}')">view ▾</button>
        <button class="btn-icon" onclick="editRecipeInline('${r.id}')">edit</button>
        <button class="btn-icon danger" onclick="removeRecipe('${r.id}')">×</button>
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
      ${['quick','weekend','kid-friendly','comfort-food'].map(t =>
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
      ${['quick','weekend','kid-friendly','comfort-food'].map(t =>
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
  await fetch(`/pantry/${id}`, { method: 'DELETE' });
  await loadPantry();
  renderPantryPanel();
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

function togglePantryPanel() {
  const panel = document.getElementById('pantryPanel');
  const visible = panel.style.display !== 'none';
  panel.style.display = visible ? 'none' : 'flex';
  _syncPanelOpen();
  if (!visible) { document.getElementById('pantrySearch').value = ''; renderPantryPanel(); }
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
          <button class="btn-icon danger" onclick="removePantryItem('${item.id}')">×</button>
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
    filtered.map(r => `
      <div class="swap-recipe-item" onclick="pickSwapRecipe(${JSON.stringify(r.name)})">
        <span class="swap-recipe-stars">${starsHtml(r.rating)}</span>
        <span class="swap-recipe-name">${r.name}</span>
      </div>`).join('');
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

// ===== MEAL PLAN =====
async function runMealPlan() {
  goToStep(1);
  document.getElementById('loadingBar').style.display = 'flex';
  document.getElementById('loadingMsg').textContent = 'Generating your meal plan...';
  document.getElementById('mealPlanCard').style.display = 'none';
  document.getElementById('approveBtn').style.display = 'none';
  const regenBtn = document.getElementById('regenerateBtn');
  if (regenBtn) regenBtn.style.display = 'none';

  const prefsText = buildPreferencesPrompt();
  const includeNew = document.getElementById('includeNew').checked;

  const newMealInstruction = includeNew
    ? `IMPORTANT: Exactly 2 of the 7 meals must be completely new recipes this family has NOT cooked before.
       Choose these based on their taste profile (kid-friendly, protein-forward, comfort food) but pick
       dishes not mentioned anywhere in their history or favorites lists.
       Mark these new meals with [NEW] at the end of the meal name so they stand out.
       The other 5 meals should come from their recipe book or favorites list, rotating in variety.`
    : `All 7 meals should come from the recipe book or favorites list, rotating for variety.`;

  const prompt = `You are a weekly meal planner for a family household in Montana.
Based on the preferences below, generate exactly 7 dinners for the week — one per day Monday through Sunday.
${buildRecipeRepoPrompt()}${buildPantryPrompt()}
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
    document.getElementById('loadingMsg').textContent = 'Using demo meals (add Anthropic API key for live generation)';
    setTimeout(() => { document.getElementById('loadingBar').style.display = 'none'; }, 2500);
    renderMeals();
    return;
  }

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
    return `
      <div class="meal-card ${m.isNew ? 'new-meal' : ''} ${isSwapping ? 'swapping' : ''}" id="meal${i}">
        <div class="day-badge">
          <span class="dow">${dow}</span>
          <span class="dom">${dom}</span>
        </div>
        <div class="meal-info">
          <div class="meal-name meal-name-link" onclick="openMealRecipe(${i})">${mealName}</div>
          <div class="meal-tags">
            ${m.isNew ? '<span class="new-badge">✦ new</span>' : ''}
            ${tagsHtml}
          </div>
        </div>
        <span class="cx cx-${cx}">${cxLabel}</span>
        <button class="btn-swap ${isSwapping ? 'active' : ''}" onclick="startSwap(${i})">↺</button>
      </div>`;
  }).join('');
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
  document.getElementById('buildCartBtn').style.display = 'inline-flex';
  document.getElementById('cartLoadingBar').style.display = 'none';
  document.getElementById('cartCard').style.display = 'none';
  document.getElementById('cartError').style.display = 'none';
  document.getElementById('serverNotice').style.display = 'none';
  document.getElementById('doneBtn').style.display = 'none';
  document.getElementById('ratingPanel').style.display = 'none';
  goToStep(2);
}

async function startCartBuild() {
  document.getElementById('buildCartBtn').style.display = 'none';
  document.getElementById('cartLoadingBar').style.display = 'flex';
  document.getElementById('cartLoadingMsg').textContent = 'Connecting to local server...';
  document.getElementById('cartCard').style.display = 'none';
  document.getElementById('cartError').style.display = 'none';
  document.getElementById('serverNotice').style.display = 'none';
  document.getElementById('doneBtn').style.display = 'none';
  document.getElementById('ratingPanel').style.display = 'none';

  const mealNames = meals.map(m => m.meal.replace(' [NEW]','').trim());

  try {
    document.getElementById('cartLoadingMsg').textContent = 'Checking server connection...';
    const ping = await fetch('/ping');
    if (!ping.ok) throw new Error('Server not responding');
  } catch(e) {
    document.getElementById('cartLoadingBar').style.display = 'none';
    document.getElementById('serverNotice').style.display = 'block';
    document.getElementById('buildCartBtn').style.display = 'inline-flex';
    return;
  }

  try {
    document.getElementById('cartLoadingMsg').textContent = 'Building Walmart cart (this takes ~20 seconds)...';
    const resp = await fetch('/build-cart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meals: mealNames, household: [...householdChecked], zip: prefs.household?.zip || '59047' })
    });

    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error || 'Unknown server error');

    document.getElementById('cartLoadingBar').style.display = 'none';
    renderCart(data.groups || {}, data.mealOrder || [], data.total, data.cartUrl);

  } catch(e) {
    document.getElementById('cartLoadingBar').style.display = 'none';
    document.getElementById('buildCartBtn').style.display = 'inline-flex';
    const errBox = document.getElementById('cartError');
    errBox.style.display = 'block';
    errBox.textContent = `Cart build error:\n${e.message}\n\nCheck your Terminal for the full error log.`;
  }
}

function renderCart(groups, mealOrder, total, url) {
  document.getElementById('cartCard').style.display = 'block';
  document.getElementById('doneBtn').style.display = 'inline-flex';
  document.getElementById('buildCartBtn').style.display = 'none';

  const list = document.getElementById('cartList');
  const sourcesPresent = mealOrder.filter(src => groups[src]?.length);

  list.innerHTML = sourcesPresent.map(source => {
    const items = groups[source];
    const isSpecial = source === 'staples' || source === 'household';
    const label = source === 'staples' ? 'Weekly Staples'
                : source === 'household' ? 'Household'
                : source;
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
    document.getElementById('cartUrlText').textContent = url;
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

// ===== PREFERENCES EDITOR =====
function togglePrefsPanel() {
  const panel = document.getElementById('prefsEditor');
  const visible = panel.style.display !== 'none';
  panel.style.display = visible ? 'none' : 'flex';
  _syncPanelOpen();
  if (!visible) renderPrefsEditor();
}

function openPrefsEditor() { togglePrefsPanel(); }

function closePrefsEditor() {
  document.getElementById('prefsEditor').style.display = 'none';
  _syncPanelOpen();
}

async function saveAndClosePrefsEditor() {
  const btn = document.querySelector('#prefsEditor .btn.mustard');
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
  prefs.doNotRepeat     = readPrefsList('pf-doNotRepeatList');
  prefs.householdItems  = readPrefsList('pf-hhList');
  prefs.brandRules      = readBrandRules();
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
  loadHouseholdItems();
  closePrefsEditor();
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

function renderPrefsEditor() {
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

  renderPrefsList('pf-dietList',        prefs.dietaryNotes    || []);
  renderPrefsList('pf-weeklyList',      prefs.weeklyStaples   || []);
  renderPrefsList('pf-frequentList',    prefs.frequentStaples || []);
  renderPrefsList('pf-doNotRepeatList', prefs.doNotRepeat     || []);
  renderPrefsList('pf-hhList',          prefs.householdItems  || []);
  renderBrandList(prefs.brandRules      || []);

  // Reset save button state
  document.querySelectorAll('#prefsEditor .btn.mustard').forEach(b => {
    b.textContent = 'Save →'; b.disabled = false;
  });
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
  const map = { diet:'pf-dietList', weekly:'pf-weeklyList', frequent:'pf-frequentList', doNotRepeat:'pf-doNotRepeatList', householdItems:'pf-hhList' };
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
      body: JSON.stringify({ meal: name }),
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
goToStep(0);
renderSchedule();
loadPrefs().then(() => checkOnboarding());
loadHouseholdItems();
loadRecipes();
loadPantry();
loadCalendarStatus();
