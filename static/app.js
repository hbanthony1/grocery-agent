// ===== STATE =====
let currentStep = 0;
let meals = [];
let swappingIndex = -1;
let recipes = [];
const pendingRatings = {};

const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

// ===== NAVIGATION =====
function goToStep(n) {
  [0,1,2].forEach(i => {
    document.getElementById('step'+i).style.display = i===n ? 'block' : 'none';
    const tab = document.getElementById('tab'+i);
    tab.className = 'step' + (i===n ? ' active' : i<n ? ' done' : '');
  });
  currentStep = n;
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
SCHEDULE_DAYS.forEach(d => { schedule[d.key] = { complexity: d.default, note: '' }; });

function renderSchedule() {
  document.getElementById('scheduleGrid').innerHTML = SCHEDULE_DAYS.map(d => {
    const { complexity, note } = schedule[d.key];
    return `
      <div class="schedule-row">
        <span class="schedule-day">${d.short}</span>
        <button class="complexity-btn ${complexity}" onclick="cycleComplexity('${d.key}')">${COMPLEXITY_LABEL[complexity]}</button>
        <input class="schedule-note" type="text" placeholder="notes (optional)" value="${note.replace(/"/g, '&quot;')}"
               oninput="schedule['${d.key}'].note = this.value" />
      </div>`;
  }).join('');
}

function cycleComplexity(day) {
  const idx = COMPLEXITY_CYCLE.indexOf(schedule[day].complexity);
  schedule[day].complexity = COMPLEXITY_CYCLE[(idx + 1) % COMPLEXITY_CYCLE.length];
  renderSchedule();
}

function buildSchedulePrompt() {
  return SCHEDULE_DAYS.map(d => {
    const { complexity, note } = schedule[d.key];
    return `- ${d.key}: ${COMPLEXITY_DESC[complexity]}${note ? ' — ' + note : ''}`;
  }).join('\n');
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
function toggleRecipesPanel() {
  const panel = document.getElementById('recipesPanel');
  const visible = panel.style.display !== 'none';
  panel.style.display = visible ? 'none' : 'block';
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
        <button class="btn-icon" onclick="editRecipeInline('${r.id}')">edit</button>
        <button class="btn-icon danger" onclick="removeRecipe('${r.id}')">×</button>
      </div>
    </div>
  </div>`;
}

function editRecipeInline(id) {
  const r = recipes.find(r => r.id === id);
  if (!r) return;
  const card = document.getElementById(`rc-${id}`);
  const pickerId = `ep-${id}`;
  card.innerHTML = `<div class="recipe-edit-form">
    <input class="recipe-edit-name" id="en-${id}" value="${r.name.replace(/"/g,'&quot;')}" />
    <div class="star-picker" id="${pickerId}" data-rating="${r.rating||0}">${starPickerHtml(pickerId, r.rating||0, 'setStar')}</div>
    <input class="schedule-note" id="eno-${id}" placeholder="notes..." value="${(r.notes||'').replace(/"/g,'&quot;')}" />
    <div class="recipe-tag-picker">
      ${['quick','weekend','kid-friendly','comfort-food'].map(t =>
        `<label class="tag-option"><input type="checkbox" ${(r.tags||[]).includes(t)?'checked':''} value="${t}" data-edit="${id}"> ${t}</label>`
      ).join('')}
    </div>
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
  await patchRecipe(id, { name, notes, rating, tags });
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
  await saveRecipe({ name, rating, notes, tags, timesPlanned: 0, lastPlanned: '' });
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

async function saveRatings() {
  const today = new Date().toISOString().split('T')[0];
  for (const [name, rating] of Object.entries(pendingRatings)) {
    await saveRecipe({ name, rating, tags: [], notes: '', timesPlanned: 1, lastPlanned: today });
  }
  skipRating();
}

function skipRating() {
  document.getElementById('ratingPanel').style.display = 'none';
}

// ===== MEAL PLAN =====
async function runMealPlan() {
  goToStep(1);
  document.getElementById('loadingBar').style.display = 'flex';
  document.getElementById('loadingMsg').textContent = 'Generating your meal plan...';
  document.getElementById('mealPlanCard').style.display = 'none';
  document.getElementById('approveBtn').style.display = 'none';

  const prefs = document.getElementById('prefsText').value;
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
${buildRecipeRepoPrompt()}
PREFERENCES:
${prefs}

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
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.content[0].text.trim().replace(/```json|```/g,'').trim();
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

function renderMeals() {
  document.getElementById('mealPlanCard').style.display = 'block';
  document.getElementById('approveBtn').style.display = 'inline-block';
  const grid = document.getElementById('mealGrid');
  grid.innerHTML = meals.map((m,i) => `
    <div class="meal-item ${m.isNew ? 'new-meal' : ''} ${swappingIndex===i ? 'swapping' : ''}" id="meal${i}">
      <div>
        <div class="meal-day">${m.day}</div>
        <div class="meal-name">${m.meal.replace(' [NEW]','')}</div>
        ${m.isNew ? '<span class="new-badge">✦ new recipe</span>' : ''}
      </div>
      <div class="meal-action">
        <button class="swap-btn ${swappingIndex===i?'active':''}" onclick="startSwap(${i})">↺</button>
      </div>
    </div>`).join('');
}

function startSwap(i) {
  swappingIndex = i;
  renderMeals();
  document.getElementById('swapRow').className = 'swap-input-row visible';
  document.getElementById('swapInput').value = '';
  document.getElementById('swapInput').placeholder = `or type a different meal...`;
  renderSwapPicker('');
  document.getElementById('swapInput').focus();
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
  goToStep(2);
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
    return;
  }

  try {
    document.getElementById('cartLoadingMsg').textContent = 'Building Walmart cart (this takes ~30 seconds)...';
    const resp = await fetch('/build-cart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meals: mealNames, household: [...householdChecked], zip: '59047' })
    });

    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error || 'Unknown server error');

    document.getElementById('cartLoadingBar').style.display = 'none';
    renderCart(data.items, data.total, data.cartUrl);

  } catch(e) {
    document.getElementById('cartLoadingBar').style.display = 'none';
    const errBox = document.getElementById('cartError');
    errBox.style.display = 'block';
    errBox.textContent = `Cart build error:\n${e.message}\n\nCheck your Terminal for the full error log.`;
  }
}

function renderCart(items, total, url) {
  document.getElementById('cartCard').style.display = 'block';
  document.getElementById('doneBtn').style.display = 'inline-block';

  const list = document.getElementById('cartList');
  list.innerHTML = items.map(item => `
    <div class="cart-item">
      <span class="cart-item-name">${item.name}</span>
      <span class="cart-item-price">${item.price}</span>
    </div>`).join('');

  document.getElementById('cartTotal').textContent = total;

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
  btn.className = 'btn';
  showRatingPanel();
}

// ===== PREFERENCES =====
async function loadPreferences() {
  try {
    const resp = await fetch('/preferences');
    const data = await resp.json();
    if (data.content) document.getElementById('prefsText').value = data.content;
  } catch(e) {}
}

// ===== INIT =====
goToStep(0);
renderSchedule();
loadPreferences();
loadHouseholdItems();
loadRecipes();
