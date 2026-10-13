'use strict';

/* ---------- 儲存 ---------- */

const STORE_KEY = 'rentVsBuy.v1';
const CONCERNS = ['學區', '通勤時間', '不想被迫搬家', '可養寵物', '空間大小'];
const ROOM_LABEL = { 1: '一房', 2: '兩房', 3: '三房', 4: '四房以上' };
const CLOSING_REQUEST = '請幫我從居住自主權、空間需求變化、打算住多久這三個角度，分析買房跟租房哪個比較適合我們，並提出我還沒考慮到的問題。';

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function newScenario(name) {
  return {
    id: uid(),
    name,
    price: '', ping: '', downPct: 20, years: '30', grace: 0, buyFee: '',
    rate: null, // null = 用自動帶入的值
    county: '新北市', district: '板橋區', rooms: '3',
    rent: null, rentFee: '',
    msg: null, // null = 自動產生；字串 = 使用者改過的文字
  };
}

function defaultLife() {
  return {
    stayYears: '', members: '', growth: 'no', growthCount: '',
    kids: [], pets: [],
    wfh: 'no', study: 'no',
    roomsNow: null, roomsFuture: null, // null = 用建議值
    concerns: [], concernOther: '',
  };
}

function defaultStore() {
  const s = newScenario('試算 1');
  return { current: s.id, scenarios: [s], life: defaultLife() };
}

function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultStore();
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.scenarios) || !data.scenarios.length) return defaultStore();
    data.scenarios = data.scenarios.map((s) => Object.assign(newScenario(s.name || '試算'), s));
    data.life = Object.assign(defaultLife(), data.life || {});
    if (!data.scenarios.some((s) => s.id === data.current)) data.current = data.scenarios[0].id;
    return data;
  } catch (e) {
    return defaultStore();
  }
}

function saveStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch (e) {
    /* 私密瀏覽或空間不足時照常運作，只是不會記住 */
  }
}

let store = loadStore();
let rentData = null;
let rateData = null;

const $ = (id) => document.getElementById(id);
const cur = () => store.scenarios.find((s) => s.id === store.current);

/* ---------- 格式 ---------- */

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
const fmtYuan = (n) => Math.round(n).toLocaleString('zh-TW') + ' 元';
const fmtWan = (yuan) => (yuan / 1e4).toLocaleString('zh-TW', { maximumFractionDigits: 1 }) + ' 萬元';
const fmtMonth = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return `${y} 年 ${m} 月`;
};
const fmtWindow = (w) => {
  const [y1, m1] = w.from.split('-').map(Number);
  const [y2, m2] = w.to.split('-').map(Number);
  return y1 === y2 ? `${y1} 年 ${m1}～${m2} 月` : `${y1} 年 ${m1} 月～${y2} 年 ${m2} 月`;
};

/* ---------- 自動帶入 ---------- */

function autoRate() {
  return rateData ? rateData.rate : null;
}

function rentStat(s) {
  if (!rentData) return null;
  const d = rentData.counties[s.county] && rentData.counties[s.county][s.district];
  return (d && d[s.rooms]) || null;
}

function effectiveRate(s) {
  return s.rate !== null ? s.rate : autoRate();
}

function effectiveRent(s) {
  if (s.rent !== null) return s.rent;
  const st = rentStat(s);
  return st ? st.median : null;
}

/* ---------- 計算 ---------- */

function calc(s) {
  const price = num(s.price);
  if (!price || price <= 0) return null;
  const total = price * 1e4;
  const pct = Math.min(Math.max(num(s.downPct) || 0, 0), 100);
  const down = total * pct / 100;
  const loan = total - down;
  const ratePct = effectiveRate(s);
  const r = (ratePct || 0) / 100 / 12;
  const n = parseInt(s.years, 10) * 12;
  const g = Math.min(Math.max(parseInt(s.grace, 10) || 0, 0) * 12, n - 12);

  const remaining = n - g;
  let pay;
  if (loan <= 0) pay = 0;
  else if (r === 0) pay = loan / remaining;
  else pay = loan * r * Math.pow(1 + r, remaining) / (Math.pow(1 + r, remaining) - 1);
  const gracePay = loan * r;
  const firstInterest = loan * r;
  const firstPrincipal = pay - firstInterest;

  const buyFee = num(s.buyFee) || 0;
  const rent = effectiveRent(s);
  const rentFee = num(s.rentFee) || 0;
  const buyTotal = pay + buyFee;
  const rentTotal = rent !== null ? rent + rentFee : null;

  return {
    total, pct, down, loan, ratePct, years: n / 12, graceYears: g / 12,
    pay, gracePay, firstInterest, firstPrincipal,
    buyFee, buyTotal, graceTotal: gracePay + buyFee,
    rent, rentFee, rentTotal,
    diff: rentTotal !== null ? buyTotal - rentTotal : null,
    unitPrice: num(s.ping) ? price / num(s.ping) : null,
  };
}

/* ---------- 房數建議 ---------- */

function suggestRooms(life) {
  const kids = life.kids || [];
  const kidsNow = kids.filter((k) => num(k.age) !== null && num(k.ownRoomAge) !== null && num(k.age) >= num(k.ownRoomAge)).length;
  const growth = life.growth === 'yes' ? Math.max(parseInt(life.growthCount, 10) || 1, 1) : 0;
  const study = life.wfh === 'yes' && life.study === 'yes' ? 1 : 0;
  const parts = (k, extra) => {
    const out = ['主臥 1'];
    if (k) out.push(`小孩 ${k}`);
    if (extra) out.push(`新成員 ${extra}`);
    if (study) out.push('書房 1');
    return out.join('＋');
  };
  return {
    now: 1 + kidsNow + study,
    future: 1 + kids.length + growth + study,
    nowHint: '建議：' + parts(kidsNow, 0),
    futureHint: '建議：' + parts(kids.length, growth),
  };
}

/* ---------- 畫面：試算組合 ---------- */

function renderScenarioSelect() {
  const sel = $('scenario');
  sel.innerHTML = '';
  for (const s of store.scenarios) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.name;
    sel.appendChild(o);
  }
  sel.value = store.current;
  $('scenario-delete').disabled = store.scenarios.length <= 1;
}

/* ---------- 畫面：表單 ---------- */

function fillSelect(sel, values, selected) {
  sel.innerHTML = '';
  for (const v of values) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v;
    sel.appendChild(o);
  }
  if (values.includes(selected)) sel.value = selected;
}

function renderLocation() {
  const s = cur();
  const counties = rentData ? Object.keys(rentData.counties) : [];
  if (!counties.length) {
    fillSelect($('county'), [s.county], s.county);
    fillSelect($('district'), [s.district], s.district);
    return;
  }
  if (!counties.includes(s.county)) s.county = counties.includes('新北市') ? '新北市' : counties[0];
  fillSelect($('county'), counties, s.county);
  const districts = Object.keys(rentData.counties[s.county]);
  if (!districts.includes(s.district)) s.district = districts[0];
  fillSelect($('district'), districts, s.district);
}

function renderForm() {
  const s = cur();
  renderLocation();
  for (const el of document.querySelectorAll('[data-key]')) {
    el.value = s[el.dataset.key] ?? '';
  }
  $('downPct').value = s.downPct ?? '';
  syncDownAmt();
  renderAuto();
}

function syncDownAmt() {
  const s = cur();
  const price = num(s.price);
  const pct = num(s.downPct);
  $('downAmt').value = price !== null && pct !== null ? +(price * pct / 100).toFixed(1) : '';
}

function renderAuto() {
  const s = cur();
  const rateEl = $('rate');
  if (document.activeElement !== rateEl) {
    const v = effectiveRate(s);
    rateEl.value = v ?? '';
  }
  if (s.rate !== null) {
    setBadge('rate', '自訂', true);
    $('rate-src').textContent = rateData ? `自動值為 ${rateData.rate}%` : '';
  } else if (rateData) {
    setBadge('rate', '自動', false);
    $('rate-src').textContent = `央行・${fmtMonth(rateData.month)}・五大銀行新承做購屋貸款平均`;
  } else {
    setBadge('rate', '', false);
    $('rate-src').textContent = '無法載入利率資料，請手動填入';
  }
  $('rate-reset').hidden = s.rate === null || !rateData;

  const rentEl = $('rent');
  const st = rentStat(s);
  if (document.activeElement !== rentEl) {
    const v = effectiveRent(s);
    rentEl.value = v ?? '';
  }
  const warn = $('rent-warn');
  warn.hidden = true;
  const label = `${s.district}${ROOM_LABEL[s.rooms]}`;
  if (s.rent !== null) {
    setBadge('rent', '自訂', true);
    $('rent-src').textContent = st ? `自動值為 ${st.median.toLocaleString('zh-TW')} 元` : '';
  } else if (!rentData) {
    setBadge('rent', '', false);
    $('rent-src').textContent = '無法載入租金資料，請手動填入';
  } else if (!st) {
    setBadge('rent', '', false);
    $('rent-src').textContent = '';
    warn.textContent = `實價登錄近 6 個月沒有${label}的整戶出租資料，請手動填入月租金。`;
    warn.hidden = false;
  } else {
    setBadge('rent', '自動', false);
    $('rent-src').textContent =
      `實價登錄・${fmtWindow(rentData.window)}・${label}・${st.n} 筆・中位數（平均 ${st.mean.toLocaleString('zh-TW')} 元）`;
    if (st.n < 5) {
      warn.textContent = `只有 ${st.n} 筆資料，行情可能不準，建議手動填入你看到的租金。`;
      warn.hidden = false;
    }
  }
  $('rent-reset').hidden = s.rent === null || !st;
}

function setBadge(prefix, text, custom) {
  const b = $(prefix + '-badge');
  b.textContent = text;
  b.classList.toggle('custom', custom);
}

/* ---------- 畫面：結果 ---------- */

function renderResult() {
  const s = cur();
  const c = calc(s);
  $('result-empty').hidden = !!c;
  $('result').hidden = !c;
  $('unit-price').textContent = c && c.unitPrice ? `單價約 ${c.unitPrice.toLocaleString('zh-TW', { maximumFractionDigits: 1 })} 萬元／坪` : '';
  if (!c) return;

  $('r-down').textContent = fmtWan(c.down);
  $('r-loan').textContent = fmtWan(c.loan);
  const hasGrace = c.graceYears > 0;
  $('r-grace-wrap').hidden = !hasGrace;
  $('r-grace').textContent = fmtYuan(c.gracePay);
  $('r-pay-label').textContent = hasGrace ? `寬限期後月付（第 ${c.graceYears + 1} 年起）` : '房貸月付';
  $('r-pay').textContent = fmtYuan(c.pay);

  $('r-buy-total').textContent = fmtYuan(c.buyTotal);
  $('r-buy-detail').textContent =
    `月付 ${fmtYuan(c.pay)}＋管理費 ${fmtYuan(c.buyFee)}` + (hasGrace ? `；寬限期內 ${fmtYuan(c.graceTotal)}` : '');
  if (c.rentTotal !== null) {
    $('r-rent-total').textContent = fmtYuan(c.rentTotal);
    $('r-rent-detail').textContent = `租金 ${fmtYuan(c.rent)}＋管理費 ${fmtYuan(c.rentFee)}`;
  } else {
    $('r-rent-total').textContent = '—';
    $('r-rent-detail').textContent = '請填入月租金';
  }
  $('r-diff').textContent = diffText(c, hasGrace);

  $('r-split-title').textContent = hasGrace ? '寬限期後第一個月的本金與利息' : '第一個月的本金與利息';
  const p = Math.max(c.firstPrincipal, 0);
  const i = Math.max(c.firstInterest, 0);
  const pPct = p + i > 0 ? (p / (p + i)) * 100 : 0;
  $('r-bar-p').style.width = pPct + '%';
  $('r-bar-i').style.width = 100 - pPct + '%';
  $('r-bar').setAttribute('aria-label', `本金占 ${Math.round(pPct)}%，利息占 ${Math.round(100 - pPct)}%`);
  $('r-principal').textContent = `${fmtYuan(p)}（${Math.round(pPct)}%）`;
  $('r-interest').textContent = `${fmtYuan(i)}（${Math.round(100 - pPct)}%）`;
}

function diffText(c, hasGrace) {
  if (c.diff === null) return '';
  const word = c.diff >= 0 ? '多' : '少';
  let t = `買房每月比租房${word} ${fmtYuan(Math.abs(c.diff))}`;
  if (hasGrace) {
    const g = c.graceTotal - c.rentTotal;
    t += `（寬限期內${g >= 0 ? '多' : '少'} ${fmtYuan(Math.abs(g))}）`;
  }
  return t;
}

/* ---------- 生活情境 ---------- */

function renderLife() {
  const life = store.life;
  for (const el of document.querySelectorAll('[data-life]')) {
    el.value = life[el.dataset.life] ?? '';
  }
  renderList('kids', life.kids, kidRow);
  renderList('pets', life.pets, petRow);
  renderConcerns();
  renderLifeDerived();
}

function renderLifeDerived() {
  const life = store.life;
  $('growth-count-wrap').hidden = life.growth !== 'yes';
  $('study-wrap').hidden = life.wfh !== 'yes';
  const sug = suggestRooms(life);
  for (const [id, key, val, hint] of [
    ['roomsNow', 'roomsNow', sug.now, sug.nowHint],
    ['roomsFuture', 'roomsFuture', sug.future, sug.futureHint],
  ]) {
    const el = $(id);
    if (document.activeElement !== el) el.value = life[key] ?? val;
    $(id + '-hint').textContent = life[key] !== null ? `自訂（${hint}）` : hint;
  }
}

function renderList(containerId, items, rowFn) {
  const box = $(containerId);
  box.innerHTML = '';
  items.forEach((item, i) => box.appendChild(rowFn(item, i)));
}

function miniField(label, value, attrs, onInput) {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const span = document.createElement('span');
  span.textContent = label;
  const input = document.createElement('input');
  Object.assign(input, attrs);
  input.value = value ?? '';
  input.addEventListener('input', () => onInput(input.value));
  wrap.append(span, input);
  return wrap;
}

function removeButton(onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ghost danger';
  b.textContent = '移除';
  b.addEventListener('click', onClick);
  return b;
}

function kidRow(kid, i) {
  const row = document.createElement('div');
  row.className = 'row-item';
  row.append(
    miniField(`第 ${i + 1} 位・現在幾歲`, kid.age, { type: 'number', inputMode: 'numeric', min: 0, step: 1 }, (v) => {
      kid.age = v; lifeChanged(false);
    }),
    miniField('幾歲需要自己的房間', kid.ownRoomAge, { type: 'number', inputMode: 'numeric', min: 0, step: 1 }, (v) => {
      kid.ownRoomAge = v; lifeChanged(false);
    }),
    removeButton(() => { store.life.kids.splice(i, 1); lifeChanged(true); }),
  );
  return row;
}

function petRow(pet, i) {
  const row = document.createElement('div');
  row.className = 'row-item';
  row.append(
    miniField('種類', pet.kind, { type: 'text', placeholder: '例如：貓' }, (v) => { pet.kind = v; lifeChanged(false); }),
    miniField('數量', pet.count, { type: 'number', inputMode: 'numeric', min: 1, step: 1 }, (v) => { pet.count = v; lifeChanged(false); }),
    removeButton(() => { store.life.pets.splice(i, 1); lifeChanged(true); }),
  );
  return row;
}

function renderConcerns() {
  const box = $('concerns');
  box.innerHTML = '';
  for (const c of CONCERNS) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = store.life.concerns.includes(c);
    cb.addEventListener('change', () => {
      const set = new Set(store.life.concerns);
      cb.checked ? set.add(c) : set.delete(c);
      store.life.concerns = CONCERNS.filter((x) => set.has(x));
      lifeChanged(false);
    });
    label.append(cb, document.createTextNode(c));
    box.appendChild(label);
  }
}

function lifeChanged(rerenderLists) {
  if (rerenderLists) {
    renderList('kids', store.life.kids, kidRow);
    renderList('pets', store.life.pets, petRow);
  }
  renderLifeDerived();
  renderMessage();
  saveStore();
}

/* ---------- 給 AI 的訊息 ---------- */

function buildMessage() {
  const s = cur();
  const c = calc(s);
  const life = store.life;
  const lines = ['我們家在考慮買房還是繼續租房，以下是我用試算工具整理的資料。', ''];

  lines.push(`【財務試算：${s.name}】（估算值，實際以銀行核貸為準）`);
  if (c) {
    let priceLine = `- 房屋總價：${fmtWan(c.total)}`;
    if (c.unitPrice) priceLine += `（${num(s.ping)} 坪，單價約 ${c.unitPrice.toLocaleString('zh-TW', { maximumFractionDigits: 1 })} 萬元／坪）`;
    lines.push(priceLine);
    lines.push(`- 自備款：${fmtWan(c.down)}（${+c.pct.toFixed(1)}%）`);
    lines.push(`- 貸款：${fmtWan(c.loan)}，利率 ${c.ratePct ?? '未填'}%，${c.years} 年，寬限期 ${c.graceYears} 年`);
    if (c.graceYears > 0) {
      lines.push(`- 房貸月付：寬限期內 ${fmtYuan(c.gracePay)}，之後 ${fmtYuan(c.pay)}`);
    } else {
      lines.push(`- 房貸月付：${fmtYuan(c.pay)}`);
    }
    lines.push(`- 第一個還本月：本金 ${fmtYuan(Math.max(c.firstPrincipal, 0))}、利息 ${fmtYuan(c.firstInterest)}`);
    lines.push(`- 買房每月總支出：${fmtYuan(c.buyTotal)}（含管理費 ${fmtYuan(c.buyFee)}）`);
  } else {
    lines.push('- 房屋總價：尚未填寫');
  }
  const rent = effectiveRent(s);
  if (rent !== null) {
    let src = '';
    const st = rentStat(s);
    if (s.rent === null && st) src = `，實價登錄 ${fmtWindow(rentData.window)} 中位數，${st.n} 筆`;
    lines.push(`- 租房：${s.county}${s.district}${ROOM_LABEL[s.rooms]}，月租金 ${fmtYuan(rent)}${src}`);
    lines.push(`- 租房每月總支出：${fmtYuan(rent + (num(s.rentFee) || 0))}（含管理費 ${fmtYuan(num(s.rentFee) || 0)}）`);
  }
  if (c && c.diff !== null) lines.push(`- 每月差額：${diffText(c, c.graceYears > 0)}`);

  const lifeLines = [];
  if (num(life.stayYears) !== null) lifeLines.push(`- 打算住：${num(life.stayYears)} 年`);
  if (num(life.members) !== null || life.growth === 'yes') {
    let t = '- 家庭成員：';
    t += num(life.members) !== null ? `目前 ${num(life.members)} 人` : '目前人數未填';
    t += life.growth === 'yes' ? `，預計增加 ${parseInt(life.growthCount, 10) || 1} 人` : '，沒有預計增加';
    lifeLines.push(t);
  }
  const kids = life.kids.filter((k) => num(k.age) !== null);
  if (kids.length) {
    const parts = kids.map((k, i) => {
      let t = `第 ${i + 1} 位 ${num(k.age)} 歲`;
      const own = num(k.ownRoomAge);
      if (own !== null) {
        const wait = own - num(k.age);
        t += wait > 0 ? `（預計 ${own} 歲、也就是 ${wait} 年後需要自己的房間）` : `（${own} 歲起需要自己的房間，現在已需要）`;
      }
      return t;
    });
    lifeLines.push(`- 小孩：${parts.join('；')}`);
  }
  const pets = life.pets.filter((p) => (p.kind || '').trim());
  if (pets.length) lifeLines.push(`- 寵物：${pets.map((p) => `${p.kind.trim()} ${parseInt(p.count, 10) || 1} 隻`).join('、')}`);
  if (life.wfh === 'yes') lifeLines.push(`- 在家工作：是，${life.study === 'yes' ? '需要' : '不需要'}獨立書房`);
  else lifeLines.push('- 在家工作：否');
  const sug = suggestRooms(life);
  const roomsNow = life.roomsNow ?? sug.now;
  const roomsFuture = life.roomsFuture ?? sug.future;
  lifeLines.push(`- 需要房數：現在 ${roomsNow} 房，未來 ${roomsFuture} 房`);
  const concerns = [...life.concerns];
  if ((life.concernOther || '').trim()) concerns.push(life.concernOther.trim());
  if (concerns.length) lifeLines.push(`- 在意的事：${concerns.join('、')}`);

  lines.push('', '【生活情境】', ...lifeLines, '', CLOSING_REQUEST);
  return lines.join('\n');
}

function renderMessage() {
  const s = cur();
  const ta = $('message');
  const edited = s.msg !== null;
  if (!edited) ta.value = buildMessage();
  else if (document.activeElement !== ta) ta.value = s.msg;
  $('msg-edited').hidden = !edited;
}

async function copyMessage() {
  const text = $('message').value;
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch (e) {
    const ta = $('message');
    ta.focus();
    ta.select();
    try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
  }
  const toast = $('copied');
  toast.textContent = ok ? '已複製' : '複製失敗，請長按文字手動複製';
  toast.hidden = false;
  clearTimeout(copyMessage.t);
  copyMessage.t = setTimeout(() => { toast.hidden = true; }, 2000);
}

/* ---------- 事件 ---------- */

function scenarioChanged() {
  renderAuto();
  renderResult();
  renderMessage();
  saveStore();
}

function bindEvents() {
  for (const el of document.querySelectorAll('[data-key]')) {
    el.addEventListener('input', () => {
      const s = cur();
      s[el.dataset.key] = el.value;
      if (el.dataset.key === 'price') syncDownAmt();
      if (el.dataset.key === 'county') {
        renderLocation();
        s.district = $('district').value;
      }
      scenarioChanged();
    });
  }

  $('downPct').addEventListener('input', () => {
    cur().downPct = $('downPct').value;
    syncDownAmt();
    scenarioChanged();
  });
  $('downAmt').addEventListener('input', () => {
    const s = cur();
    const price = num(s.price);
    const amt = num($('downAmt').value);
    if (price && amt !== null) {
      s.downPct = +(amt / price * 100).toFixed(2);
      $('downPct').value = s.downPct;
    }
    scenarioChanged();
  });

  $('rate').addEventListener('input', () => {
    const v = num($('rate').value);
    cur().rate = v;
    scenarioChanged();
  });
  $('rate-reset').addEventListener('click', () => {
    cur().rate = null;
    $('rate').value = autoRate() ?? '';
    scenarioChanged();
  });
  $('rent').addEventListener('input', () => {
    cur().rent = num($('rent').value);
    scenarioChanged();
  });
  $('rent-reset').addEventListener('click', () => {
    cur().rent = null;
    $('rent').value = effectiveRent(cur()) ?? '';
    scenarioChanged();
  });
  // 離開欄位時，把空白的自訂值當成「恢復自動值」
  for (const id of ['rate', 'rent']) {
    $(id).addEventListener('blur', () => { renderAuto(); });
  }

  for (const el of document.querySelectorAll('[data-life]')) {
    el.addEventListener('input', () => {
      store.life[el.dataset.life] = el.value;
      lifeChanged(false);
    });
  }
  for (const id of ['roomsNow', 'roomsFuture']) {
    $(id).addEventListener('input', () => {
      store.life[id] = num($(id).value);
      lifeChanged(false);
    });
  }
  $('kid-add').addEventListener('click', () => {
    store.life.kids.push({ age: '', ownRoomAge: '' });
    lifeChanged(true);
  });
  $('pet-add').addEventListener('click', () => {
    store.life.pets.push({ kind: '', count: 1 });
    lifeChanged(true);
  });

  $('message').addEventListener('input', () => {
    cur().msg = $('message').value;
    $('msg-edited').hidden = false;
    saveStore();
  });
  $('regen').addEventListener('click', () => {
    cur().msg = null;
    renderMessage();
    saveStore();
  });
  $('copy').addEventListener('click', copyMessage);

  $('scenario').addEventListener('change', () => {
    store.current = $('scenario').value;
    renderAll();
    saveStore();
  });
  $('scenario-new').addEventListener('click', () => {
    const name = prompt('新試算的名稱（例如：浮洲 A2 三房）', `試算 ${store.scenarios.length + 1}`);
    if (name === null || !name.trim()) return;
    const s = newScenario(name.trim());
    store.scenarios.push(s);
    store.current = s.id;
    renderAll();
    saveStore();
  });
  $('scenario-rename').addEventListener('click', () => {
    const s = cur();
    const name = prompt('試算名稱', s.name);
    if (name === null || !name.trim()) return;
    s.name = name.trim();
    renderScenarioSelect();
    renderMessage();
    saveStore();
  });
  $('scenario-delete').addEventListener('click', () => {
    if (store.scenarios.length <= 1) return;
    const s = cur();
    if (!confirm(`刪除「${s.name}」？`)) return;
    store.scenarios = store.scenarios.filter((x) => x.id !== s.id);
    store.current = store.scenarios[0].id;
    renderAll();
    saveStore();
  });

  $('clear').addEventListener('click', () => {
    if (!confirm('清除這支手機上所有的試算與生活情境資料？')) return;
    try { localStorage.removeItem(STORE_KEY); } catch (e) { /* 忽略 */ }
    store = defaultStore();
    renderAll();
  });
}

function renderAll() {
  renderScenarioSelect();
  renderForm();
  renderResult();
  renderLife();
  renderMessage();
}

/* ---------- 啟動 ---------- */

async function loadJSON(url) {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function init() {
  bindEvents();
  renderAll();
  [rentData, rateData] = await Promise.all([loadJSON('data/rent.json'), loadJSON('data/rate.json')]);
  renderAll();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
