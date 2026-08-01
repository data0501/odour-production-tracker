/* =============================================================================
   Odour Device Production Tracker — application logic
   Predictive Edge Pvt. Ltd.

   Architecture
   ------------
   All data access lives in two functions, loadProductionData() and
   saveProduction(). They are the ONLY code that talks to a backend, so the
   source can change without touching the UI.

     • Demo mode  (default): data is read/written in the browser, with sample
                              history seeded on first run.
     • Live mode:            paste your Apps Script Web App URL into CONFIG below
                              — that single change switches the whole app to your
                              Google Sheet. See SETUP.md and Code.gs.

   Both functions are async, so every call site already `await`s them; nothing
   else changes when you go live.
   ========================================================================== */

'use strict';

/* ----------------------------------------------------------------------------
   CONFIG
---------------------------------------------------------------------------- */
const CONFIG = {
  // ▶ TO GO LIVE: paste your deployed Apps Script Web App URL between the quotes.
  //   That is the only change needed. Leave it blank to stay in local demo mode.
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbx5tnjq-aHfULd8J-MP4ZERMuLhoRyT0TJ0HmrsrWry4oQaGorsXUhY5tI-G20tF_SU/exec',

  // Used only when there is no data yet: the serial the very first entry builds
  // on. If you already have production history, either pre-fill the Sheet with
  // your real rows, or set this to your current last serial number.
  SERIAL_BASELINE: 1948,

  STORAGE_KEY: 'pe_odour_production_v1', // local persistence key (demo mode only)
};

/** True once an Apps Script URL is configured (i.e. live mode). */
function backendEnabled() {
  return CONFIG.APPS_SCRIPT_URL.trim().length > 0;
}

/* ----------------------------------------------------------------------------
   STATE
---------------------------------------------------------------------------- */
// Each entry: { id, serial, date: 'YYYY-MM-DD', devicesReady, casesInStock, createdAt }
let productionData = [];

/* Cached DOM references (populated in init) */
const els = {};

/* Inline icons for the toast (swapped by type) */
const ICON_CHECK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>';
const ICON_ALERT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5"/><path d="M12 16.5h.01"/><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>';

/* ============================================================================
   SMALL UTILITIES
============================================================================ */

/** Today's date as 'YYYY-MM-DD' in LOCAL time (no timezone drift). */
function todayISO() {
  return toISO(new Date());
}

/** Convert a Date to 'YYYY-MM-DD' in local time. */
function toISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Format an ISO date ('YYYY-MM-DD') for display as 'DD-MM-YYYY'. */
function formatDate(iso) {
  if (!iso || iso.indexOf('-') === -1) return iso || '';
  const [y, m, d] = iso.split('-');
  return `${d}-${m}-${y}`;
}

/** Parse a value to an integer; returns NaN when blank / invalid. */
function toInt(value) {
  if (value === null || value === undefined || String(value).trim() === '') return NaN;
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
}

/** Sort helper — newest entry first (by createdAt, serial as tie-breaker). */
function byNewest(a, b) {
  const t = new Date(b.createdAt) - new Date(a.createdAt);
  return t !== 0 ? t : b.serial - a.serial;
}

/** Coerce a row coming back from the Sheet into the shape/types the UI expects. */
function normalizeEntry(row) {
  const dateRaw = row.date != null ? String(row.date) : '';
  return {
    id: row.id || `row-${row.serial}-${dateRaw}`,
    serial: Number(row.serial) || 0,
    // A date cell may arrive as a full ISO datetime — keep just the day.
    date: dateRaw.length >= 10 ? dateRaw.slice(0, 10) : dateRaw,
    devicesReady: Number(row.devicesReady) || 0,
    casesInStock: Number(row.casesInStock) || 0,
    createdAt: row.createdAt ? String(row.createdAt) : new Date().toISOString(),
  };
}

/* ============================================================================
   DATA LAYER  — the only functions that talk to a backend.
============================================================================ */

/**
 * Load all production entries.
 * LIVE: GET the Apps Script Web App and return the parsed rows.
 * DEMO: read from localStorage (seed sample data on first run).
 */
async function loadProductionData() {
  if (backendEnabled()) {
    // Cache-buster keeps the browser from serving a stale copy.
    const url = CONFIG.APPS_SCRIPT_URL + '?t=' + Date.now();
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) throw new Error('Load failed with status ' + res.status);

    let rows;
    try {
      rows = await res.json();
    } catch (_) {
      // Usually means the deployment access isn't set to "Anyone" and Google
      // returned a sign-in page instead of JSON.
      throw new Error('Unexpected response — check the Web App access is set to "Anyone".');
    }

    productionData = Array.isArray(rows) ? rows.map(normalizeEntry) : [];
    return productionData;
  }

  // ---- DEMO (local) ----
  const stored = readLocal();
  productionData = stored.length ? stored : seedData();
  if (!stored.length) writeLocal(productionData); // persist the seed once
  return productionData;
}

/**
 * Persist a single new production entry.
 * LIVE: POST it to Apps Script (which appends a Sheet row).
 * DEMO: append to the local array + localStorage.
 */
async function saveProduction(entry) {
  if (backendEnabled()) {
    const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
      method: 'POST',
      // text/plain keeps this a "simple" request, so the browser skips the CORS
      // pre-flight that Apps Script can't answer. The body is still JSON.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(entry),
    });
    if (!res.ok) throw new Error('Save failed with status ' + res.status);

    productionData.push(entry); // optimistic: the row is now in the Sheet
    return entry;
  }

  // ---- DEMO (local) ----
  productionData.push(entry);
  writeLocal(productionData);
  return entry;
}

/* --- local persistence helpers (demo only; safe if storage is unavailable) --- */
function readLocal() {
  try {
    const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (_) {
    return []; // private mode / storage disabled -> fall back to in-memory
  }
}
function writeLocal(data) {
  try {
    localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(data));
  } catch (_) {
    /* ignore: in-memory state still works for this session */
  }
}

/* ============================================================================
   BUSINESS LOGIC
============================================================================ */

/** The serial number of the most recent unit, or the baseline if none exist. */
function getCurrentLastSerial() {
  if (!productionData.length) return CONFIG.SERIAL_BASELINE;
  return productionData.slice().sort(byNewest)[0].serial;
}

/** New last serial = current last serial + devices produced. */
function calculateNextSerialNumber(currentSerial, devicesReady) {
  return currentSerial + devicesReady;
}

/** Total devices completed today (sums any entries dated today). */
function getTodaysDevices() {
  const today = todayISO();
  return productionData
    .filter((e) => e.date === today)
    .reduce((sum, e) => sum + e.devicesReady, 0);
}

/** Latest known "cases in stock" level (a snapshot, not a running total). */
function getLatestCasesInStock() {
  if (!productionData.length) return 0;
  return productionData.slice().sort(byNewest)[0].casesInStock;
}

/* ============================================================================
   RENDERING
============================================================================ */

/** Set all four card values at once (used for loading / error placeholders). */
function setCards(text) {
  els.cardLastSerial.textContent = text;
  els.cardTodayDevices.textContent = text;
  els.cardCasesStock.textContent = text;
  els.cardTotalEntries.textContent = text;
}

/** Update the four summary cards from current state. */
function updateDashboard() {
  els.cardLastSerial.textContent = getCurrentLastSerial();
  els.cardTodayDevices.textContent = getTodaysDevices();
  els.cardCasesStock.textContent = getLatestCasesInStock();
  els.cardTotalEntries.textContent = productionData.length;
}

/** Toggle the history region between table / loading / error. */
function showTableStatus(state) {
  els.historyTable.hidden = state === 'loading' || state === 'error';
  els.historyLoading.hidden = state !== 'loading';
  els.historyError.hidden = state !== 'error';
  if (state !== 'none') els.historyEmpty.hidden = true;
}

/**
 * Render the history table, optionally filtered by a search term.
 * Matches against the displayed date (DD-MM-YYYY) or the serial number.
 */
function renderHistoryTable(filterText = '') {
  const query = filterText.trim().toLowerCase();
  const rows = productionData
    .slice()
    .sort(byNewest)
    .filter((e) => {
      if (!query) return true;
      const dateStr = formatDate(e.date).toLowerCase();
      const serialStr = String(e.serial);
      return dateStr.includes(query) || serialStr.includes(query);
    });

  // Build all rows in one pass, then swap in — avoids layout thrash.
  els.historyBody.innerHTML = rows
    .map(
      (e) => `
      <tr>
        <td class="cell-serial">${e.serial}</td>
        <td class="cell-muted">${formatDate(e.date)}</td>
        <td class="ta-right cell-num">${e.devicesReady}</td>
        <td class="ta-right cell-num">${e.casesInStock}</td>
      </tr>`
    )
    .join('');

  // Empty state — different message for "no data yet" vs "no search matches".
  const empty = rows.length === 0;
  els.historyEmpty.hidden = !empty;
  if (empty) {
    const noData = productionData.length === 0;
    els.emptyTitle.textContent = noData ? 'No production logged yet' : 'No matching entries';
    els.emptyText.textContent = noData
      ? "Save today's numbers to get started."
      : 'Try a different date or serial number.';
  }

  els.resultCount.textContent = query
    ? `${rows.length} match${rows.length === 1 ? '' : 'es'}`
    : `${productionData.length} total`;
}

/**
 * Live-update the serial calculation inside the form as the engineer types.
 * Current serial stays put; the new serial reflects "current + devices".
 */
function updateSerialPreview() {
  const current = getCurrentLastSerial();
  const devices = toInt(els.devicesInput.value);

  els.currentSerial.textContent = current;

  if (!Number.isNaN(devices) && devices > 0) {
    const next = calculateNextSerialNumber(current, devices);
    setSerialText(els.newSerial, next);
    els.serialBox.classList.add('is-active');
    els.newSerial.classList.remove('serial-box__value--muted');
    els.serialDelta.textContent = `+${devices}`;
  } else {
    setSerialText(els.newSerial, current);
    els.serialBox.classList.remove('is-active');
    els.newSerial.classList.add('serial-box__value--muted');
    els.serialDelta.textContent = '';
  }
}

/** Update a serial value and pulse it briefly when it actually changes. */
function setSerialText(node, value) {
  const str = String(value);
  if (node.textContent === str) return;
  node.textContent = str;
  node.classList.remove('pulse');
  void node.offsetWidth; // reflow so the animation can retrigger
  node.classList.add('pulse');
}

/* ============================================================================
   VALIDATION
============================================================================ */

/**
 * Validate the two typed fields. Shows friendly, specific messages and returns
 * a boolean. Empty submissions are blocked.
 */
function validateForm() {
  let ok = true;

  const devices = toInt(els.devicesInput.value);
  const cases = toInt(els.casesInput.value);

  // Devices ready — must be a whole number of 1 or more.
  if (els.devicesInput.value.trim() === '') {
    ok = setFieldError('devices', "Enter today's completed devices (1 or more).");
  } else if (Number.isNaN(devices)) {
    ok = setFieldError('devices', 'Use a whole number for devices ready.');
  } else if (devices < 1) {
    ok = setFieldError('devices', 'Devices ready must be at least 1.');
  } else {
    clearFieldError('devices');
  }

  // Cases in stock — must be a whole number of 0 or more.
  if (els.casesInput.value.trim() === '') {
    ok = setFieldError('cases', 'Enter the empty cases now in stock (0 or more).') && ok;
  } else if (Number.isNaN(cases)) {
    ok = setFieldError('cases', 'Use a whole number for cases in stock.') && ok;
  } else if (cases < 0) {
    ok = setFieldError('cases', "Cases in stock can't be negative.") && ok;
  } else {
    clearFieldError('cases');
  }

  return ok;
}

function setFieldError(name, message) {
  const field = name === 'devices' ? els.devicesField : els.casesField;
  const error = name === 'devices' ? els.devicesError : els.casesError;
  field.classList.add('invalid');
  error.textContent = message;
  return false; // returns falsy so callers can chain `&& ok`
}
function clearFieldError(name) {
  const field = name === 'devices' ? els.devicesField : els.casesField;
  const error = name === 'devices' ? els.devicesError : els.casesError;
  field.classList.remove('invalid');
  error.textContent = '';
}

/* ============================================================================
   FEEDBACK
============================================================================ */

let toastTimer = null;
/** Show a toast. type is 'success' or 'error'. */
function showToast(type, title, text) {
  const isError = type === 'error';
  els.toast.classList.toggle('toast--error', isError);
  els.toastIcon.innerHTML = isError ? ICON_ALERT : ICON_CHECK;
  els.toastTitle.textContent = title;
  els.toastText.textContent = text;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), isError ? 4200 : 3200);
}

/** Toggle the Save button between idle and saving. */
function setSaving(on) {
  els.saveBtn.disabled = on;
  els.btnLabel.textContent = on ? 'Saving…' : 'Save production';
}

/* ============================================================================
   SEED DATA  (demo only) — realistic history so the dashboard looks live.
   Serials are continuous; dates are generated relative to today.
============================================================================ */
function seedData() {
  const today = new Date();
  const daysAgo = [12, 11, 9, 8, 6, 4, 1, 0];
  const devices = [30, 26, 34, 22, 31, 29, 28, 35];
  const cases = [24, 18, 27, 15, 21, 16, 22, 19];

  let serial = CONFIG.SERIAL_BASELINE; // 1600 before the first batch
  const entries = [];

  for (let i = 0; i < daysAgo.length; i++) {
    serial += devices[i]; // continuous serial numbering
    const d = new Date(today);
    d.setDate(today.getDate() - daysAgo[i]);
    entries.push({
      id: `seed-${i}`,
      serial,
      date: toISO(d),
      devicesReady: devices[i],
      casesInStock: cases[i],
      createdAt: new Date(d.getTime() + i * 1000).toISOString(), // deterministic order
    });
  }
  return entries; // ends at serial 1835 for "today" — matches the spec example
}

/* ============================================================================
   INIT / WIRING
============================================================================ */
async function init() {
  // Cache DOM
  els.headerDate = document.getElementById('headerDate');
  els.cardLastSerial = document.getElementById('cardLastSerial');
  els.cardTodayDevices = document.getElementById('cardTodayDevices');
  els.cardCasesStock = document.getElementById('cardCasesStock');
  els.cardTotalEntries = document.getElementById('cardTotalEntries');

  els.form = document.getElementById('productionForm');
  els.dateInput = document.getElementById('dateInput');
  els.devicesInput = document.getElementById('devicesInput');
  els.casesInput = document.getElementById('casesInput');
  els.devicesField = document.getElementById('devicesField');
  els.casesField = document.getElementById('casesField');
  els.devicesError = document.getElementById('devicesError');
  els.casesError = document.getElementById('casesError');
  els.saveBtn = document.getElementById('saveBtn');
  els.btnLabel = document.getElementById('btnLabel');

  els.serialBox = document.querySelector('.serial-box');
  els.currentSerial = document.getElementById('currentSerial');
  els.newSerial = document.getElementById('newSerial');
  els.serialDelta = document.getElementById('serialDelta');

  els.searchInput = document.getElementById('searchInput');
  els.historyTable = document.getElementById('historyTable');
  els.historyBody = document.getElementById('historyBody');
  els.historyEmpty = document.getElementById('historyEmpty');
  els.historyLoading = document.getElementById('historyLoading');
  els.historyError = document.getElementById('historyError');
  els.emptyTitle = document.getElementById('emptyTitle');
  els.emptyText = document.getElementById('emptyText');
  els.resultCount = document.getElementById('resultCount');
  els.retryBtn = document.getElementById('retryBtn');

  els.toast = document.getElementById('appToast');
  els.toastIcon = document.getElementById('toastIcon');
  els.toastTitle = document.getElementById('toastTitle');
  els.toastText = document.getElementById('toastText');

  // Header + form date default to today (editable)
  els.headerDate.textContent = formatDate(todayISO());
  els.dateInput.value = todayISO();

  // Events
  els.devicesInput.addEventListener('input', () => {
    clearFieldError('devices');
    updateSerialPreview();
  });
  els.casesInput.addEventListener('input', () => clearFieldError('cases'));
  els.searchInput.addEventListener('input', (e) => renderHistoryTable(e.target.value));
  els.form.addEventListener('submit', handleSubmit);
  els.retryBtn.addEventListener('click', refresh);

  // Load + first paint
  await refresh();
}

/** Load data and (re)paint everything. Handles loading + error states. */
async function refresh() {
  if (backendEnabled()) {
    setCards('…');
    showTableStatus('loading');
  }

  try {
    await loadProductionData();
  } catch (err) {
    console.error(err);
    setCards('—');
    showTableStatus('error');
    return;
  }

  showTableStatus('none');
  updateDashboard();
  renderHistoryTable(els.searchInput.value || '');
  updateSerialPreview();
}

/** Handle the "Save production" action. */
async function handleSubmit(event) {
  event.preventDefault();
  if (!validateForm()) return;

  const devices = toInt(els.devicesInput.value);
  const cases = toInt(els.casesInput.value);
  const current = getCurrentLastSerial();
  const newSerial = calculateNextSerialNumber(current, devices);

  const entry = {
    id: `e-${Date.now()}`,
    serial: newSerial,
    date: els.dateInput.value || todayISO(),
    devicesReady: devices,
    casesInStock: cases,
    createdAt: new Date().toISOString(),
  };

  setSaving(true);
  try {
    await saveProduction(entry);
  } catch (err) {
    console.error(err);
    setSaving(false);
    showToast('error', "Couldn't save", "Your entry wasn't saved. Check the connection and try again.");
    return; // keep the form values so the engineer can retry
  }
  setSaving(false);

  // Refresh UI
  updateDashboard();
  renderHistoryTable(els.searchInput.value);
  highlightNewestRow();

  // Reset typed fields; keep date on today; recompute preview
  els.devicesInput.value = '';
  els.casesInput.value = '';
  els.dateInput.value = todayISO();
  updateSerialPreview();
  els.devicesInput.focus();

  showToast('success', 'Production updated', `New last serial is ${newSerial}.`);
}

/** Briefly flash the top row after a successful save (if it's visible). */
function highlightNewestRow() {
  if (els.searchInput.value.trim() !== '') return; // may be filtered out
  const firstRow = els.historyBody.querySelector('tr');
  if (!firstRow) return;
  firstRow.classList.add('row-new');
  setTimeout(() => firstRow.classList.remove('row-new'), 1600);
}

/* Start once the DOM is ready */
document.addEventListener('DOMContentLoaded', init);

/* -----------------------------------------------------------------------------
   Backend reference: the Apps Script (Code.gs) and step-by-step setup live in
   the companion files Code.gs and SETUP.md.
----------------------------------------------------------------------------- */