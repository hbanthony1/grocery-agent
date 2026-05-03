let currentStep = 0;
let meals = [];
let swappingIndex = -1;

const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

function goToStep(n) {
  [0,1,2].forEach(i => {
    document.getElementById('step'+i).style.display = i===n ? 'block' : 'none';
    const tab = document.getElementById('tab'+i);
    tab.className = 'step' + (i===n ? ' active' : i<n ? ' done' : '');
  });
  currentStep = n;
}

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
       The other 5 meals should come from their favorites list, rotating in variety.`
    : `All 7 meals should come from the family favorites list, rotating for variety.`;

  const prompt = `You are a weekly meal planner for a family household in Montana.
Based on the preferences below, generate exactly 7 dinners for the week — one per day Monday through Sunday.

PREFERENCES:
${prefs}

${newMealInstruction}

Rules:
- Never repeat a meal from the "Do NOT repeat" list
- Vary proteins: no same protein two days in a row
- Keep meals practical and kid-friendly
- Friday should be an easy/quick meal (pizza, hot dogs, or similar)
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
      {day:'Monday', meal:"Pasta with Rao's Sauce", isNew:false},
      {day:'Tuesday', meal:'Korean Beef Bulgogi Rice Bowl [NEW]', isNew:true},
      {day:'Wednesday', meal:'Meatball Subs', isNew:false},
      {day:'Thursday', meal:'Chicken Pot Pie', isNew:false},
      {day:'Friday', meal:'Stuffed Crust Pizza', isNew:false},
      {day:'Saturday', meal:'Smash Burgers with Fries [NEW]', isNew:true},
      {day:'Sunday', meal:'Slow Cooker Beef Stew', isNew:false},
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
  const row = document.getElementById('swapRow');
  row.className = 'swap-input-row visible';
  document.getElementById('swapInput').value = '';
  document.getElementById('swapInput').placeholder = `Replace "${meals[i].meal.replace(' [NEW]','')}" with...`;
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
  renderMeals();
}

async function approveMealPlan() {
  goToStep(2);
  document.getElementById('cartLoadingBar').style.display = 'flex';
  document.getElementById('cartLoadingMsg').textContent = 'Connecting to local server...';
  document.getElementById('cartCard').style.display = 'none';
  document.getElementById('cartError').style.display = 'none';
  document.getElementById('serverNotice').style.display = 'none';
  document.getElementById('doneBtn').style.display = 'none';

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
      body: JSON.stringify({ meals: mealNames, zip: '59047' })
    });

    const data = await resp.json();

    if (!resp.ok || data.error) {
      throw new Error(data.error || 'Unknown server error');
    }

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
}

async function loadPreferences() {
  try {
    const resp = await fetch('/preferences');
    const data = await resp.json();
    if (data.content) document.getElementById('prefsText').value = data.content;
  } catch(e) {
    // Server not running yet — textarea stays empty, user can paste manually
  }
}

goToStep(0);
loadPreferences();
