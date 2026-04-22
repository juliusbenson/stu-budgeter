/** Legacy key name; stores budget items (not calendar "events"). */
const STORAGE_KEY = "stu-calendar-events-v1";

const MONTH_TARGETS_KEY = "stu-budget-month-targets-v1";

/** @typedef {{ id: string, startIso: string, description: string, amount: number }} BudgetItem */

const usdFormatter = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
});

const usdCompactFormatter = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

/** @param {unknown} n */
function normalizeAmount(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/** @param {number} amount signed dollars */
function formatSignedUsd(amount) {
  return usdFormatter.format(amount);
}

/** @param {number} amount */
function classForAmount(amount) {
  if (amount > 0) return "item-money positive";
  if (amount < 0) return "item-money negative";
  return "item-money zero";
}

/** @param {number} amount */
function cellNetClass(amount) {
  if (amount > 0) return "cell-net cell-net-positive";
  if (amount < 0) return "cell-net cell-net-negative";
  return "cell-net cell-net-zero";
}

/** @param {number} amount */
function summaryNetClass(amount) {
  if (amount > 0) return "month-summary-net month-summary-net-positive";
  if (amount < 0) return "month-summary-net month-summary-net-negative";
  return "month-summary-net month-summary-net-zero";
}

/** Shorter currency string for month grid cells. */
function formatNetForCell(amount) {
  if (Math.abs(amount) >= 1000) {
    return usdCompactFormatter.format(amount);
  }
  return usdFormatter.format(amount);
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function toLocalDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** @param {string} value from datetime-local (interpreted as local time) */
function parseDatetimeLocal(value) {
  if (!value) return null;
  const [datePart, timePart] = value.split("T");
  if (!datePart || !timePart) return null;
  const [y, mo, d] = datePart.split("-").map(Number);
  const [hh, mm] = timePart.split(":").map(Number);
  const dt = new Date(y, mo - 1, d, hh || 0, mm || 0, 0, 0);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function formatDatetimeLocal(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

function formatTime(d) {
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatSelectedDayHeading(d) {
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/** @param {'full' | 'short' | 'compact'} tier */
function formatViewMonth(d, tier) {
  if (tier === "compact") {
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    return `${String(m).padStart(2, "0")}/${String(y).slice(-2)}`;
  }
  if (tier === "short") {
    return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
  }
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function getMonthLabelTier() {
  if (window.matchMedia("(max-width: 380px)").matches) return "compact";
  if (window.matchMedia("(max-width: 520px)").matches) return "short";
  return "full";
}

/** Long month heading (e.g. side copy that always wants full locale string). */
function monthTitle(d) {
  return formatViewMonth(d, "full");
}

/** @param {BudgetItem} item */
function itemStartDate(item) {
  return new Date(item.startIso);
}

/** @param {BudgetItem} item @param {Date} day */
function itemBelongsToDay(item, day) {
  const start = itemStartDate(item);
  return toLocalDateKey(start) === toLocalDateKey(day);
}

function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * RFC 4180-style CSV parse into rows of raw string fields.
 * @param {string} text
 * @returns {string[][]}
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      if (text[i] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      continue;
    }
    if (c === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      i++;
      continue;
    }
    field += c;
    i++;
  }
  row.push(field);
  rows.push(row);
  while (rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last.length === 1 && last[0] === "") {
      rows.pop();
      continue;
    }
    if (last.every((cell) => cell === "")) {
      rows.pop();
      continue;
    }
    break;
  }
  return rows;
}

/** @param {string} s */
function escapeCsvField(s) {
  const str = String(s);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** @param {BudgetItem[]} list */
function itemsToCsv(list) {
  const lines = ["id,start_iso,description,amount"];
  for (const row of list) {
    const a = normalizeAmount(row.amount);
    lines.push(
      `${escapeCsvField(row.id)},${escapeCsvField(row.startIso)},${escapeCsvField(row.description)},${escapeCsvField(String(a))}`
    );
  }
  return lines.join("\r\n") + "\r\n";
}

/**
 * @param {string} text
 * @returns {BudgetItem[]}
 */
function parseBudgetItemsFromCsv(text) {
  const rows = parseCsv(text.replace(/^\uFEFF/, ""));
  if (rows.length === 0) throw new Error("CSV is empty.");
  const rawHeaders = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name) => {
    const idx = rawHeaders.indexOf(name);
    if (idx === -1) throw new Error(`Missing column: ${name}`);
    return idx;
  };
  const iId = col("id");
  const iIso = col("start_iso");
  const iDesc = col("description");
  const iAmt = col("amount");
  const nCols = rawHeaders.length;
  /** @type {BudgetItem[]} */
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    let cells = rows[r];
    if (cells.every((c) => c.trim() === "")) continue;
    if (cells.length < nCols) {
      cells = [...cells, ...Array(nCols - cells.length).fill("")];
    }
    const idCell = (cells[iId] ?? "").trim();
    const iso = (cells[iIso] ?? "").trim();
    const desc = cells[iDesc] ?? "";
    const amtStr = (cells[iAmt] ?? "").trim();
    if (!iso) throw new Error(`Missing start_iso on row ${r + 1}.`);
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`Invalid start_iso on row ${r + 1}.`);
    }
    const amt = Number(amtStr);
    if (!Number.isFinite(amt)) {
      throw new Error(`Invalid amount on row ${r + 1}.`);
    }
    out.push({
      id: idCell || newId(),
      startIso: iso,
      description: desc,
      amount: normalizeAmount(amt),
    });
  }
  return out;
}

/** @param {string} filename @param {string} content */
function downloadTextFile(filename, content) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportBudgetItemsCsv() {
  const d = new Date();
  const fn = `budget-items-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.csv`;
  downloadTextFile(fn, itemsToCsv(items));
}

function loadItems() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e) =>
          e &&
          typeof e.id === "string" &&
          typeof e.startIso === "string" &&
          typeof e.description === "string"
      )
      .map((e) => ({
        id: e.id,
        startIso: e.startIso,
        description: e.description,
        amount: normalizeAmount(e.amount),
      }));
  } catch {
    return [];
  }
}

/** @param {BudgetItem[]} items */
function saveItems(items) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

// --- DOM refs ---
const monthTitleEl = document.getElementById("month-title");
const gridEl = document.getElementById("calendar-grid");
const btnPrev = document.getElementById("btn-prev");
const btnNext = document.getElementById("btn-next");
const btnToday = document.getElementById("btn-today");
const btnMenu = document.getElementById("btn-menu");
const appMenu = document.getElementById("app-menu");
const menuWrap = document.querySelector(".menu-wrap");
const btnExportCsv = document.getElementById("btn-export-csv");
const btnImportCsv = document.getElementById("btn-import-csv");
const fileImportCsv = document.getElementById("file-import-csv");
const selectedDayLabel = document.getElementById("selected-day-label");
const btnMonthSummary = document.getElementById("btn-month-summary");
const monthSummaryBlock = document.getElementById("month-summary-block");
const monthSummaryNetEl = document.getElementById("month-summary-net");
const monthTargetInput = document.getElementById("month-target-savings");
const monthDailyTargetEl = document.getElementById("month-daily-target");
const itemListEl = document.getElementById("item-list");
const btnAdd = document.getElementById("btn-add");
const formEl = document.getElementById("item-form");
const formLegend = document.getElementById("form-legend");
const fieldWhen = document.getElementById("field-when");
const fieldDescription = document.getElementById("field-description");
const fieldAmountMagnitude = document.getElementById("field-amount-magnitude");
const dirIncome = document.getElementById("dir-income");
const dirExpenditure = document.getElementById("dir-expenditure");
const formErrorEl = document.getElementById("form-error");
const btnCancel = document.getElementById("btn-cancel");
const btnDelete = document.getElementById("btn-delete");

/** @type {Date} */
let viewMonth = startOfMonth(new Date());
/** @type {Date | null} */
let selectedDay = stripTime(new Date());
/** @type {BudgetItem[]} */
let items = loadItems();
/** @type {string | null} */
let editingId = null;

function stripTime(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * @param {Date} d
 * @param {{ clearSelection?: boolean }} [options]
 */
function setViewMonth(d, options = {}) {
  viewMonth = startOfMonth(d);
  if (options.clearSelection) {
    selectedDay = null;
    closeForm();
  }
  renderCalendar();
  renderSidePanel();
}

function setSelectedDay(d) {
  selectedDay = stripTime(d);
  if (
    selectedDay.getFullYear() !== viewMonth.getFullYear() ||
    selectedDay.getMonth() !== viewMonth.getMonth()
  ) {
    viewMonth = startOfMonth(selectedDay);
    renderCalendar();
  } else {
    renderCalendar();
  }
  renderSidePanel();
}

function clearDaySelection() {
  closeForm();
  selectedDay = null;
  renderCalendar();
  renderSidePanel();
}

function itemsOnCalendarDay(day) {
  const key = toLocalDateKey(day);
  return items.filter((e) => toLocalDateKey(itemStartDate(e)) === key);
}

function netCashflowOnDay(day) {
  return normalizeAmount(
    itemsOnCalendarDay(day).reduce((sum, e) => sum + e.amount, 0)
  );
}

/** @param {BudgetItem} item */
function itemInViewMonth(item) {
  const d = itemStartDate(item);
  return (
    d.getFullYear() === viewMonth.getFullYear() &&
    d.getMonth() === viewMonth.getMonth()
  );
}

function itemsInViewMonth() {
  return items.filter(itemInViewMonth);
}

function netCashflowForViewMonth() {
  return normalizeAmount(
    itemsInViewMonth().reduce((sum, e) => sum + e.amount, 0)
  );
}

function viewMonthStorageKey() {
  const y = viewMonth.getFullYear();
  const m = String(viewMonth.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function loadTargetsMap() {
  try {
    const raw = localStorage.getItem(MONTH_TARGETS_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw);
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

/** @param {string} key YYYY-MM */
function loadMonthTarget(key) {
  const v = loadTargetsMap()[key];
  return typeof v === "number" && Number.isFinite(v) ? normalizeAmount(v) : 0;
}

/** @param {string} key YYYY-MM */
function saveMonthTarget(key, amount) {
  const map = loadTargetsMap();
  map[key] = normalizeAmount(amount);
  localStorage.setItem(MONTH_TARGETS_KEY, JSON.stringify(map));
}

function isViewingCurrentMonth() {
  const t = stripTime(new Date());
  return (
    viewMonth.getFullYear() === t.getFullYear() &&
    viewMonth.getMonth() === t.getMonth()
  );
}

/** Days used to spread (net − target): inclusive today→month-end for current month, else full month length. */
function daysForDailyTargetDivisor() {
  const y = viewMonth.getFullYear();
  const m = viewMonth.getMonth();
  const dim = daysInMonth(y, m);
  if (!isViewingCurrentMonth()) return dim;
  const today = stripTime(new Date());
  let count = 0;
  for (let d = 1; d <= dim; d++) {
    const dd = new Date(y, m, d);
    if (toLocalDateKey(dd) >= toLocalDateKey(today)) count++;
  }
  return Math.max(1, count);
}

function syncMonthTargetInputFromStorage() {
  const key = viewMonthStorageKey();
  const v = loadMonthTarget(key);
  monthTargetInput.value = v === 0 ? "" : String(v);
}

function updateMonthDailyTarget() {
  const net = netCashflowForViewMonth();
  monthSummaryNetEl.className = summaryNetClass(net);
  monthSummaryNetEl.textContent = formatSignedUsd(net);
  const raw = monthTargetInput.value.trim();
  let target = 0;
  if (raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) target = normalizeAmount(n);
  }
  const divisor = daysForDailyTargetDivisor();
  const daily = normalizeAmount((net - target) / divisor);
  monthDailyTargetEl.textContent = `Daily target: ${formatSignedUsd(daily)}`;
}

function refreshMonthLabelsFromTier() {
  const tier = getMonthLabelTier();
  monthTitleEl.textContent = formatViewMonth(viewMonth, tier);
  if (selectedDay === null) {
    selectedDayLabel.textContent = `Month summary — ${formatViewMonth(
      viewMonth,
      tier
    )}`;
  }
}

function renderCalendar() {
  refreshMonthLabelsFromTier();
  gridEl.replaceChildren();

  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();
  const firstDow = new Date(year, month, 1).getDay();
  const dim = daysInMonth(year, month);
  const today = stripTime(new Date());

  for (let i = 0; i < firstDow; i++) {
    const pad = document.createElement("div");
    pad.className = "cell-empty";
    pad.setAttribute("aria-hidden", "true");
    gridEl.appendChild(pad);
  }

  for (let day = 1; day <= dim; day++) {
    const cellDate = new Date(year, month, day);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cell";
    btn.setAttribute("role", "gridcell");
    btn.dataset.dateKey = toLocalDateKey(cellDate);

    const daynum = document.createElement("span");
    daynum.className = "cell-daynum";
    daynum.textContent = String(day);
    btn.appendChild(daynum);

    const dayItems = itemsOnCalendarDay(cellDate);
    if (dayItems.length > 0) {
      const net = netCashflowOnDay(cellDate);
      const netEl = document.createElement("span");
      netEl.className = cellNetClass(net);
      netEl.textContent = formatNetForCell(net);
      netEl.title = `${dayItems.length} budget item(s); net ${formatSignedUsd(net)}`;
      btn.appendChild(netEl);
    }

    if (toLocalDateKey(cellDate) === toLocalDateKey(today)) {
      btn.classList.add("cell-today");
    }
    if (
      selectedDay !== null &&
      toLocalDateKey(cellDate) === toLocalDateKey(selectedDay)
    ) {
      btn.classList.add("cell-selected");
    }

    btn.addEventListener("click", () => {
      if (
        selectedDay !== null &&
        toLocalDateKey(cellDate) === toLocalDateKey(selectedDay)
      ) {
        clearDaySelection();
      } else {
        setSelectedDay(cellDate);
      }
    });

    gridEl.appendChild(btn);
  }
}

function itemsForSelectedDay() {
  if (selectedDay === null) return [];
  return items
    .filter((e) => itemBelongsToDay(e, selectedDay))
    .sort((a, b) => itemStartDate(a) - itemStartDate(b));
}

function renderSidePanel() {
  if (selectedDay === null) {
    btnMonthSummary.hidden = true;
    selectedDayLabel.textContent = `Month summary — ${formatViewMonth(
      viewMonth,
      getMonthLabelTier()
    )}`;
    monthSummaryBlock.hidden = false;
    itemListEl.hidden = true;
    itemListEl.replaceChildren();
    syncMonthTargetInputFromStorage();
    updateMonthDailyTarget();
  } else {
    btnMonthSummary.hidden = false;
    monthSummaryBlock.hidden = true;
    itemListEl.hidden = false;
    selectedDayLabel.textContent = formatSelectedDayHeading(selectedDay);
    itemListEl.replaceChildren();

    const dayItems = itemsForSelectedDay();
    if (dayItems.length === 0) {
      const emptyLi = document.createElement("li");
      emptyLi.className = "month-summary-li";
      const p = document.createElement("p");
      p.className = "empty-hint";
      p.textContent = "No budget items this day.";
      emptyLi.appendChild(p);
      itemListEl.appendChild(emptyLi);
    } else {
      for (const ev of dayItems) {
        const start = itemStartDate(ev);
        const li = document.createElement("li");
        const b = document.createElement("button");
        b.type = "button";
        b.className = "item-row";
        b.dataset.itemId = ev.id;

        const t = document.createElement("span");
        t.className = "item-time";
        t.textContent = formatTime(start);

        const money = document.createElement("span");
        money.className = classForAmount(ev.amount);
        money.textContent = formatSignedUsd(ev.amount);

        const desc = document.createElement("span");
        desc.className = "item-desc";
        desc.textContent = ev.description;

        b.appendChild(t);
        b.appendChild(money);
        b.appendChild(desc);
        b.addEventListener("click", () => openFormForEdit(ev.id));
        li.appendChild(b);
        itemListEl.appendChild(li);
      }
    }
  }

  if (!formEl.hidden) {
    // keep form open only when editing; new add uses explicit flow
  }
}

function closeForm() {
  formEl.hidden = true;
  editingId = null;
  formEl.reset();
  formLegend.textContent = "Budget item";
  formErrorEl.hidden = true;
  formErrorEl.textContent = "";
  btnDelete.hidden = true;
  btnAdd.disabled = false;
}

/** Default `When` for a new item: selected day, or 1st of viewed month if none selected. */
function defaultDatetimeForNewItem() {
  const now = new Date();
  if (selectedDay !== null) {
    return new Date(
      selectedDay.getFullYear(),
      selectedDay.getMonth(),
      selectedDay.getDate(),
      now.getHours(),
      now.getMinutes(),
      0,
      0
    );
  }
  return new Date(
    viewMonth.getFullYear(),
    viewMonth.getMonth(),
    1,
    now.getHours(),
    now.getMinutes(),
    0,
    0
  );
}

function directionSignFromUi() {
  return dirIncome.checked ? 1 : -1;
}

function setAmountFieldsFromSigned(amount) {
  const a = normalizeAmount(amount);
  dirExpenditure.checked = a <= 0;
  dirIncome.checked = a > 0;
  fieldAmountMagnitude.value = String(Math.abs(a));
}

function openFormNew() {
  editingId = null;
  formLegend.textContent = "New budget item";
  fieldWhen.value = formatDatetimeLocal(defaultDatetimeForNewItem());
  fieldDescription.value = "";
  setAmountFieldsFromSigned(0);
  formErrorEl.hidden = true;
  formErrorEl.textContent = "";
  btnDelete.hidden = true;
  formEl.hidden = false;
  btnAdd.disabled = true;
  fieldWhen.focus();
}

/** @param {string} id */
function openFormForEdit(id) {
  const ev = items.find((e) => e.id === id);
  if (!ev) return;
  editingId = id;
  formLegend.textContent = "Edit budget item";
  const start = itemStartDate(ev);
  fieldWhen.value = formatDatetimeLocal(start);
  fieldDescription.value = ev.description;
  setAmountFieldsFromSigned(ev.amount);
  formErrorEl.hidden = true;
  formErrorEl.textContent = "";
  btnDelete.hidden = false;
  formEl.hidden = false;
  btnAdd.disabled = true;
  fieldDescription.focus();
}

function commitItems(next) {
  items = next;
  saveItems(items);
  renderCalendar();
  renderSidePanel();
}

formEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const whenVal = fieldWhen.value;
  const desc = fieldDescription.value.trim();
  const when = parseDatetimeLocal(whenVal);
  if (!when || !desc) return;

  const rawMag = fieldAmountMagnitude.value.trim();
  let magnitude = 0;
  if (rawMag !== "") {
    magnitude = Number(rawMag);
    if (!Number.isFinite(magnitude) || magnitude < 0) {
      formErrorEl.textContent = "Enter a valid non-negative amount.";
      formErrorEl.hidden = false;
      return;
    }
  }
  formErrorEl.hidden = true;
  formErrorEl.textContent = "";
  const amount = normalizeAmount(directionSignFromUi() * magnitude);

  if (editingId) {
    items = items.map((ev) =>
      ev.id === editingId
        ? {
            ...ev,
            startIso: when.toISOString(),
            description: desc,
            amount,
          }
        : ev
    );
  } else {
    items = [
      ...items,
      {
        id: newId(),
        startIso: when.toISOString(),
        description: desc,
        amount,
      },
    ];
  }
  saveItems(items);
  setSelectedDay(stripTime(when));
  closeForm();
});

btnCancel.addEventListener("click", () => {
  closeForm();
});

btnDelete.addEventListener("click", () => {
  if (!editingId) return;
  commitItems(items.filter((e) => e.id !== editingId));
  closeForm();
});

btnAdd.addEventListener("click", () => {
  openFormNew();
});

btnPrev.addEventListener("click", () => {
  setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1), {
    clearSelection: true,
  });
});

btnNext.addEventListener("click", () => {
  setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1), {
    clearSelection: true,
  });
});

btnMonthSummary.addEventListener("click", () => {
  clearDaySelection();
});

btnToday.addEventListener("click", () => {
  const now = new Date();
  setSelectedDay(now);
});

function onMonthTargetInput() {
  const key = viewMonthStorageKey();
  const raw = monthTargetInput.value.trim();
  let amount = 0;
  if (raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) amount = normalizeAmount(n);
  }
  saveMonthTarget(key, amount);
  updateMonthDailyTarget();
}

monthTargetInput.addEventListener("input", onMonthTargetInput);
monthTargetInput.addEventListener("change", onMonthTargetInput);

function setAppMenuOpen(open) {
  appMenu.hidden = !open;
  btnMenu.setAttribute("aria-expanded", open ? "true" : "false");
}

function closeAppMenu() {
  setAppMenuOpen(false);
}

btnMenu.addEventListener("click", (e) => {
  e.stopPropagation();
  setAppMenuOpen(appMenu.hidden);
});

document.addEventListener("pointerdown", (e) => {
  if (appMenu.hidden) return;
  const t = /** @type {Node} */ (e.target);
  if (!menuWrap?.contains(t)) {
    closeAppMenu();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !appMenu.hidden) {
    closeAppMenu();
  }
});

btnExportCsv.addEventListener("click", () => {
  exportBudgetItemsCsv();
  closeAppMenu();
});

btnImportCsv.addEventListener("click", () => {
  closeAppMenu();
  fileImportCsv.click();
});

fileImportCsv.addEventListener("change", () => {
  const f = fileImportCsv.files?.[0];
  fileImportCsv.value = "";
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const text = String(reader.result ?? "");
      const parsed = parseBudgetItemsFromCsv(text);
      if (
        !confirm(
          "Replace all budget items with this file? This cannot be undone."
        )
      ) {
        return;
      }
      items = parsed;
      saveItems(items);
      renderCalendar();
      renderSidePanel();
      if (selectedDay === null) {
        syncMonthTargetInputFromStorage();
        updateMonthDailyTarget();
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };
  reader.onerror = () => {
    alert("Could not read the file.");
  };
  reader.readAsText(f, "UTF-8");
});

let monthLabelResizeTimer = 0;
function scheduleRefreshMonthLabels() {
  window.clearTimeout(monthLabelResizeTimer);
  monthLabelResizeTimer = window.setTimeout(() => {
    refreshMonthLabelsFromTier();
  }, 100);
}

let monthLabelMediaInited = false;
function initMonthLabelMediaListeners() {
  if (monthLabelMediaInited) return;
  monthLabelMediaInited = true;
  const mqCompact = window.matchMedia("(max-width: 380px)");
  const mqShort = window.matchMedia("(max-width: 520px)");
  const onMq = () => {
    refreshMonthLabelsFromTier();
  };
  mqCompact.addEventListener("change", onMq);
  mqShort.addEventListener("change", onMq);
  window.addEventListener("resize", scheduleRefreshMonthLabels);
}

initMonthLabelMediaListeners();

// Initial render
setSelectedDay(selectedDay);
closeForm();
