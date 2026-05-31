/**
 * tests/test_js_logic.js — Tests for pure JS logic from app.js
 *
 * Run:  node tests/test_js_logic.js
 *
 * Tests functions that have no browser dependencies by embedding the logic
 * directly — no DOM, no fetch, no external framework required.
 */

'use strict';

// ── Test harness ─────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const RESET = '\x1b[0m', GREEN = '\x1b[32m', RED = '\x1b[31m', BOLD = '\x1b[1m', DIM = '\x1b[2m';

function suite(name) {
  console.log(`\n${BOLD}${name}${RESET}`);
}

function test(name, fn) {
  try {
    fn();
    console.log(`  ${GREEN}✓${RESET} ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ${RED}✗${RESET} ${name}`);
    console.log(`    ${DIM}${e.message}${RESET}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function assertDeepEqual(a, b, msg) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg || `Expected ${sb}, got ${sa}`);
}

// ── Functions under test (embedded from app.js) ───────────────────────────────

// --- Calendar week default ---
function defaultCalendarWeek(dayOfWeek) {
  // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
  return (dayOfWeek === 0 || dayOfWeek >= 5) ? 'next' : 'current';
}

// --- Schedule complexity constants ---
const SCHEDULE_DAYS = [
  { key: 'Monday',    default: 'normal' },
  { key: 'Tuesday',   default: 'normal' },
  { key: 'Wednesday', default: 'normal' },
  { key: 'Thursday',  default: 'normal' },
  { key: 'Friday',    default: 'quick'  },
  { key: 'Saturday',  default: 'open'   },
  { key: 'Sunday',    default: 'open'   },
];

const COMPLEXITY_DESC = {
  quick:  'QUICK — 30 min or less (frozen, heat-and-eat, or simple assembly)',
  normal: 'NORMAL — standard weeknight (30–60 min)',
  open:   'OPEN — plenty of time (elaborate recipes welcome: lasagna, slow cooker, etc.)',
  out:    'OUT — eating out or away from home, no dinner needed',
};

const COMPLEXITY_CYCLE = ['normal', 'quick', 'open', 'out'];
const COMPLEXITY_LABEL = { normal: 'Normal', quick: 'Quick', open: 'Open', out: 'Out' };

function buildSchedulePrompt(schedule) {
  return SCHEDULE_DAYS
    .filter(d => schedule[d.key].complexity !== 'out')
    .map(d => `- ${d.key}: ${COMPLEXITY_DESC[schedule[d.key].complexity]}`)
    .join('\n');
}

function cycleComplexity(schedule, day) {
  const idx = COMPLEXITY_CYCLE.indexOf(schedule[day].complexity);
  schedule[day].complexity = COMPLEXITY_CYCLE[(idx + 1) % COMPLEXITY_CYCLE.length];
}

// --- Out day enforcement ---
function enforceOutDays(meals, outDays) {
  outDays.forEach(day => {
    meals = meals.filter(m => m.day !== day);
    meals.push({ day, meal: 'Out', isOut: true, isNew: false });
  });
  const dayOrder = SCHEDULE_DAYS.map(d => d.key);
  meals.sort((a, b) => dayOrder.indexOf(a.day) - dayOrder.indexOf(b.day));
  return meals;
}

// --- Cart total calculation ---
function calcCartTotal(groups, mealOrder, deselected) {
  let total = 0;
  mealOrder.forEach(src => {
    (groups[src] || []).forEach((item, origIdx) => {
      if (!deselected.has(`${src}-${origIdx}`)) {
        total += parseFloat(item.price.replace('$', '')) || 0;
      }
    });
  });
  return Math.round(total * 100) / 100;
}

function calcGroupSubtotal(items, source, allItems, deselected) {
  return items.reduce((sum, item) => {
    const origIdx = allItems.indexOf(item);
    const key = `${source}-${origIdx}`;
    return deselected.has(key) ? sum : sum + (parseFloat(item.price.replace('$', '')) || 0);
  }, 0);
}

// --- Cart item key consistency ---
function cartItemKey(source, origIdx) {
  return `${source}-${origIdx}`;
}


// ── Test suites ───────────────────────────────────────────────────────────────

suite('Calendar week default');

test('Sunday (0) → next week', () => {
  assertEqual(defaultCalendarWeek(0), 'next');
});
test('Monday (1) → current week', () => {
  assertEqual(defaultCalendarWeek(1), 'current');
});
test('Tuesday (2) → current week', () => {
  assertEqual(defaultCalendarWeek(2), 'current');
});
test('Wednesday (3) → current week', () => {
  assertEqual(defaultCalendarWeek(3), 'current');
});
test('Thursday (4) → current week', () => {
  assertEqual(defaultCalendarWeek(4), 'current');
});
test('Friday (5) → next week', () => {
  assertEqual(defaultCalendarWeek(5), 'next');
});
test('Saturday (6) → next week', () => {
  assertEqual(defaultCalendarWeek(6), 'next');
});


suite('Schedule prompt');

test('all normal days included', () => {
  const schedule = {};
  SCHEDULE_DAYS.forEach(d => { schedule[d.key] = { complexity: 'normal' }; });
  const prompt = buildSchedulePrompt(schedule);
  SCHEDULE_DAYS.forEach(d => {
    assert(prompt.includes(d.key), `Expected ${d.key} in prompt`);
  });
});

test('out days excluded from prompt', () => {
  const schedule = {};
  SCHEDULE_DAYS.forEach(d => { schedule[d.key] = { complexity: 'normal' }; });
  schedule['Friday'].complexity = 'out';
  schedule['Saturday'].complexity = 'out';
  const prompt = buildSchedulePrompt(schedule);
  assert(!prompt.includes('Friday'),  'Friday (out) should not appear in prompt');
  assert(!prompt.includes('Saturday'),'Saturday (out) should not appear in prompt');
  assert(prompt.includes('Monday'),   'Monday should still appear');
});

test('prompt empty when all days out', () => {
  const schedule = {};
  SCHEDULE_DAYS.forEach(d => { schedule[d.key] = { complexity: 'out' }; });
  assertEqual(buildSchedulePrompt(schedule), '');
});

test('complexity descriptions match expected values', () => {
  const schedule = { Monday: { complexity: 'quick' }, Tuesday: { complexity: 'open' },
    Wednesday: { complexity: 'normal' }, Thursday: { complexity: 'normal' },
    Friday: { complexity: 'quick' }, Saturday: { complexity: 'open' }, Sunday: { complexity: 'open' } };
  const prompt = buildSchedulePrompt(schedule);
  assert(prompt.includes('QUICK'), 'quick days should show QUICK description');
  assert(prompt.includes('OPEN'),  'open days should show OPEN description');
});


suite('Complexity cycle');

test('normal → quick → open → out → normal', () => {
  const schedule = { Monday: { complexity: 'normal' } };
  cycleComplexity(schedule, 'Monday');
  assertEqual(schedule.Monday.complexity, 'quick');
  cycleComplexity(schedule, 'Monday');
  assertEqual(schedule.Monday.complexity, 'open');
  cycleComplexity(schedule, 'Monday');
  assertEqual(schedule.Monday.complexity, 'out');
  cycleComplexity(schedule, 'Monday');
  assertEqual(schedule.Monday.complexity, 'normal');
});

test('out label is "Out"', () => {
  assertEqual(COMPLEXITY_LABEL['out'], 'Out');
});


suite('Out day enforcement');

test('claude meal on out day is replaced by Out entry', () => {
  const meals = [
    { day: 'Monday', meal: 'Tacos',   isNew: false },
    { day: 'Friday', meal: 'Lasagna', isNew: false }, // Friday is Out
    { day: 'Sunday', meal: 'Soup',    isNew: false },
  ];
  const result = enforceOutDays(meals, ['Friday']);
  const friday = result.find(m => m.day === 'Friday');
  assert(friday.isOut,        'Friday entry should have isOut=true');
  assertEqual(friday.meal, 'Out', 'Friday meal should be "Out"');
  assert(result.find(m => m.day === 'Monday'),  'Monday should still be present');
  assert(result.find(m => m.day === 'Sunday'),  'Sunday should still be present');
});

test('out day with no claude meal still gets Out entry', () => {
  const meals = [
    { day: 'Monday', meal: 'Tacos', isNew: false },
  ];
  const result = enforceOutDays(meals, ['Friday']);
  assert(result.find(m => m.day === 'Friday' && m.isOut), 'Friday Out entry should be inserted');
});

test('multiple out days all enforced', () => {
  const meals = [
    { day: 'Monday',    meal: 'Tacos',   isNew: false },
    { day: 'Wednesday', meal: 'Pasta',   isNew: false },
    { day: 'Friday',    meal: 'Pizza',   isNew: false },
    { day: 'Saturday',  meal: 'Burgers', isNew: false },
  ];
  const result = enforceOutDays(meals, ['Friday', 'Saturday']);
  const outDays = result.filter(m => m.isOut).map(m => m.day);
  assert(outDays.includes('Friday'),   'Friday should be out');
  assert(outDays.includes('Saturday'), 'Saturday should be out');
  assertEqual(outDays.length, 2, 'Should have exactly 2 out days');
});

test('result sorted in week order', () => {
  const meals = [
    { day: 'Sunday',  meal: 'Soup',  isNew: false },
    { day: 'Monday',  meal: 'Tacos', isNew: false },
    { day: 'Friday',  meal: 'Pizza', isNew: false },
  ];
  const result = enforceOutDays(meals, ['Wednesday']);
  const dayOrder = SCHEDULE_DAYS.map(d => d.key);
  for (let i = 1; i < result.length; i++) {
    assert(dayOrder.indexOf(result[i].day) > dayOrder.indexOf(result[i-1].day),
      `${result[i].day} should come after ${result[i-1].day}`);
  }
});

test('out entry does not appear as false positive in meal count', () => {
  const meals = [
    { day: 'Monday', meal: 'Tacos', isNew: false },
    { day: 'Tuesday', meal: 'Pasta', isNew: false },
  ];
  const result = enforceOutDays(meals, ['Wednesday']);
  const cookingMeals = result.filter(m => !m.isOut);
  assertEqual(cookingMeals.length, 2, 'Should still have 2 cooking meals');
});


suite('Cart total calculation');

const _mockGroups = {
  'Chicken Pot Pie': [
    { name: 'Perdue Chicken Thighs', price: '$6.98' },
    { name: 'Frozen Pie Crust',      price: '$3.48' },
    { name: 'Cream of Chicken Soup', price: '$1.98' },
  ],
  'Pasta with Meat Sauce': [
    { name: "Rao's Marinara",   price: '$8.98' },
    { name: 'Ground Beef 1lb', price: '$5.98' },
    { name: 'Penne Pasta',     price: '$1.48' },
  ],
  'staples': [
    { name: 'Whole Milk',  price: '$4.28' },
    { name: 'Bananas 3lb', price: '$1.78' },
  ],
};
const _mockOrder = ['Chicken Pot Pie', 'Pasta with Meat Sauce', 'staples'];

test('full total with nothing deselected', () => {
  const total = calcCartTotal(_mockGroups, _mockOrder, new Set());
  assertEqual(total, 34.94);
});

test('deselecting one item reduces total', () => {
  const desel = new Set(['Chicken Pot Pie-0']); // Perdue $6.98
  const total = calcCartTotal(_mockGroups, _mockOrder, desel);
  assertEqual(total, 27.96);
});

test('deselecting multiple items across groups', () => {
  const desel = new Set([
    'Chicken Pot Pie-0',      // $6.98
    'Pasta with Meat Sauce-0', // $8.98
  ]);
  const total = calcCartTotal(_mockGroups, _mockOrder, desel);
  assertEqual(total, 18.98);
});

test('deselecting all items gives zero', () => {
  const desel = new Set();
  _mockOrder.forEach(src => {
    (_mockGroups[src] || []).forEach((_, i) => desel.add(`${src}-${i}`));
  });
  assertEqual(calcCartTotal(_mockGroups, _mockOrder, desel), 0);
});


suite('Cart group subtotals');

test('group subtotal excludes deselected item', () => {
  const items = _mockGroups['Chicken Pot Pie'];
  const desel = new Set(['Chicken Pot Pie-0']); // Perdue $6.98
  const subtotal = Math.round(calcGroupSubtotal(items, 'Chicken Pot Pie', items, desel) * 100) / 100;
  assertEqual(subtotal, 5.46); // $3.48 + $1.98
});

test('group subtotal unchanged when no deselection', () => {
  const items = _mockGroups['staples'];
  const subtotal = Math.round(calcGroupSubtotal(items, 'staples', items, new Set()) * 100) / 100;
  assertEqual(subtotal, 6.06); // $4.28 + $1.78
});

test('group subtotal zero when all items deselected', () => {
  const items = _mockGroups['Chicken Pot Pie'];
  const desel = new Set(items.map((_, i) => `Chicken Pot Pie-${i}`));
  const subtotal = calcGroupSubtotal(items, 'Chicken Pot Pie', items, desel);
  assertEqual(subtotal, 0);
});


suite('Cart item key format');

test('key is "source-origIdx"', () => {
  assertEqual(cartItemKey('Chicken Pot Pie', 0), 'Chicken Pot Pie-0');
  assertEqual(cartItemKey('staples', 2),         'staples-2');
});

test('keys are consistent across views for same item', () => {
  // The same item should produce the same key in both meal and category views
  // Both use origIdx = index in groups[source]
  const source = 'Pasta with Meat Sauce';
  const items = _mockGroups[source];
  items.forEach((item, origIdx) => {
    const keyMealView     = cartItemKey(source, origIdx);
    const keyCategoryView = cartItemKey(item._src || source, item._idx !== undefined ? item._idx : origIdx);
    assertEqual(keyMealView, keyCategoryView, `Key mismatch for ${item.name}`);
  });
});


// ── Summary ───────────────────────────────────────────────────────────────────

console.log('');
const total = passed + failed;
if (failed === 0) {
  console.log(`${GREEN}${BOLD}✓ All ${total} tests passed${RESET}`);
} else {
  console.log(`${RED}${BOLD}✗ ${failed} of ${total} tests failed${RESET}`);
  process.exit(1);
}
