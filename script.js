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

  // Your real current last serial — the first new entry will build on this.
  SERIAL_BASELINE: 1948,

  // Running-total starting points — set these to your real current figures.
  // The first new entry builds on them, exactly like SERIAL_BASELINE does.
  TOTAL_DEVICES_READY_BASELINE: 0,   // assembled devices on hand, not yet packed
  TOTAL_DEVICES_PACKED_BASELINE: 0,  // packed devices on hand, not yet dispatched
  TOTAL_CASES_IN_STOCK_BASELINE: 0,  // printed cases currently in stock

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
  // casesPrinted is the new column name; fall back to the old "casesInStock".
  const casesPrinted = Number(row.casesPrinted != null ? row.casesPrinted : row.casesInStock) || 0;
  return {
    id: row.id || `row-${row.serial}-${dateRaw}`,
    serial: Number(row.serial) || 0,
    // A date cell may arrive as a full ISO datetime — keep just the day.
    date: dateRaw.length >= 10 ? dateRaw.slice(0, 10) : dateRaw,
    devicesReady: Number(row.devicesReady) || 0,
    totalDevicesReady: Number(row.totalDevicesReady) || 0,
    devicesPacked: Number(row.devicesPacked) || 0,
    totalDevicesPacked: Number(row.totalDevicesPacked) || 0,
    casesPrinted: casesPrinted,
    totalCasesInStock: Number(row.totalCasesInStock) || 0,
    devicesDispatched: Number(row.devicesDispatched) || 0,
    createdAt: row.createdAt ? String(row.createdAt) : new Date().toISOString(),
  };
}

/**
 * Returns true when a date string ('YYYY-MM-DD') falls on a non-working day:
 *   • every Sunday
 *   • the 2nd Saturday of the month
 *   • the 4th Saturday of the month
 * Parsing with 'T00:00:00' forces local time, avoiding a midnight-UTC shift
 * that can move the date backwards by one day on some phones.
 */
function isOffDay(dateStr) {
  const d   = new Date(dateStr + 'T00:00:00');
  const day = d.getDay();          // 0 = Sunday, 6 = Saturday
  if (day === 0) return true;      // every Sunday
  if (day === 6) {
    // Math.ceil(date / 7) → 1 for days 1–7, 2 for 8–14, 3 for 15–21, etc.
    const week = Math.ceil(d.getDate() / 7);
    return week === 2 || week === 4; // 2nd or 4th Saturday
  }
  return false;
}

/**
 * Last serial number from entries dated strictly BEFORE targetDate.
 * Used when a backdated date is selected, so the serial calculator shows the
 * correct baseline for that day rather than the current last serial.
 */
function getStateAsOfDate(targetDate) {
  const prior = productionData
    .filter((e) => e.date <= targetDate) // on or before the target date
    .sort((a, b) =>
      b.date.localeCompare(a.date)
      || (new Date(b.createdAt) - new Date(a.createdAt))
      || b.serial - a.serial
    );
  if (prior.length) {
    const p = prior[0];
    return {
      serial: p.serial,
      totalDevicesReady: p.totalDevicesReady,
      totalDevicesPacked: p.totalDevicesPacked,
      totalCasesInStock: p.totalCasesInStock,
    };
  }
  return {
    serial: CONFIG.SERIAL_BASELINE,
    totalDevicesReady: CONFIG.TOTAL_DEVICES_READY_BASELINE,
    totalDevicesPacked: CONFIG.TOTAL_DEVICES_PACKED_BASELINE,
    totalCasesInStock: CONFIG.TOTAL_CASES_IN_STOCK_BASELINE,
  };
}

/* ============================================================================
   DATA LAYER  — the only functions that talk to a backend.

   WHY fetchWithRetry?
   Google Apps Script Web Apps run on Google's servers and go "cold" after
   sitting idle (no requests for ~10–15 minutes). The first call after an idle
   period can take 5–10 s while Google spins the server back up — longer than
   the browser's default and enough to cause a spurious error even with a
   perfectly good internet connection.

   fetchWithRetry silently retries up to `retries` times with a pause between
   each attempt. Most cold-start failures resolve on the second try, so the
   user never sees the error at all.
============================================================================ */

/**
 * Fetch with automatic retries and a per-attempt timeout.
 *
 * @param {string} url      URL to request
 * @param {object} options  Standard fetch() options
 * @param {number} retries  Maximum number of attempts (default 3)
 * @param {number} delay    Milliseconds to wait between attempts (default 1800)
 * @param {number} timeout  Milliseconds before a single attempt is aborted (default 14000)
 */
async function fetchWithRetry(url, options = {}, retries = 3, delay = 1800, timeout = 14000) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    // AbortController lets us cancel a hanging request after `timeout` ms.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      return res;           // success — hand back the Response immediately
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) {
        // Wait before the next attempt. The pause also gives a cold-starting
        // Apps Script server a moment to finish warming up.
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;            // every attempt failed — caller decides what to do
}

/**
 * Load all production entries.
 * LIVE: GET the Apps Script Web App and return the parsed rows.
 * DEMO: read from localStorage (seed sample data on first run).
 */
async function loadProductionData() {
  if (backendEnabled()) {
    // Cache-buster keeps the browser from serving a stale copy.
    const url = CONFIG.APPS_SCRIPT_URL + '?t=' + Date.now();
    const res = await fetchWithRetry(url, { method: 'GET' });
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
 * After a save times out, reload the Sheet and verify the entry is there.
 * Returns true if found, false if not.
 * (Timeouts often hide successful saves — this confirms reality.)
 */
async function verifySaveSucceeded(entry) {
  try {
    // Give the server a moment to settle after the timeout.
    await new Promise((r) => setTimeout(r, 2000));
    // Reload from the Sheet.
    await loadProductionData();
    // Check if this entry (by serial, date, and devicesReady) now exists.
    return productionData.some(
      (e) =>
        e.serial === entry.serial &&
        e.date === entry.date &&
        e.devicesReady === entry.devicesReady
    );
  } catch (_) {
    // If we can't even load to verify, assume worst-case: the save failed.
    return false;
  }
}

/**
 * Persist a single new production entry.
 * LIVE: POST it to Apps Script (which appends a Sheet row).
 * DEMO: append to the local array + localStorage.
 */
async function saveProduction(entry) {
  if (backendEnabled()) {
    const res = await fetchWithRetry(CONFIG.APPS_SCRIPT_URL, {
      method: 'POST',
      // text/plain keeps this a "simple" request, so the browser skips the CORS
      // pre-flight that Apps Script can't answer. The body is still JSON.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(entry),
    }, 2, 1800, 20000); // max 2 attempts, 1.8s delay, 20s per-attempt timeout (saves can be slow)
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

/** The chronologically latest entry (by date, then createdAt), or null. */
function latestEntry() {
  if (!productionData.length) return null;
  return productionData.slice().sort((a, b) =>
    b.date.localeCompare(a.date)
    || (new Date(b.createdAt) - new Date(a.createdAt))
    || b.serial - a.serial
  )[0];
}

/** Latest device serial, or the baseline if there are no entries yet. */
function getCurrentLastSerial() {
  const e = latestEntry();
  return e ? e.serial : CONFIG.SERIAL_BASELINE;
}

/** Latest running total of assembled-but-not-dispatched devices. */
function getLatestTotalDevicesReady() {
  const e = latestEntry();
  return e ? e.totalDevicesReady : CONFIG.TOTAL_DEVICES_READY_BASELINE;
}

/** Latest running total of packed-but-not-dispatched devices. */
function getLatestTotalDevicesPacked() {
  const e = latestEntry();
  return e ? e.totalDevicesPacked : CONFIG.TOTAL_DEVICES_PACKED_BASELINE;
}

/** Latest running total of printed cases in stock. */
function getLatestTotalCasesInStock() {
  const e = latestEntry();
  return e ? e.totalCasesInStock : CONFIG.TOTAL_CASES_IN_STOCK_BASELINE;
}

/** New last serial = current last serial + devices produced. */
function calculateNextSerialNumber(currentSerial, devicesReady) {
  return currentSerial + devicesReady;
}

/* ============================================================================
   RENDERING
============================================================================ */

/** Set all four card values at once (used for loading / error placeholders). */
function setCards(text) {
  els.cardLastSerial.textContent = text;
  els.cardTotalDevicesReady.textContent = text;
  els.cardTotalDevicesPacked.textContent = text;
  els.cardTotalCasesStock.textContent = text;
}

/** Update the four summary cards from current state. */
function updateDashboard() {
  els.cardLastSerial.textContent = getCurrentLastSerial();
  els.cardTotalDevicesReady.textContent = getLatestTotalDevicesReady();
  els.cardTotalDevicesPacked.textContent = getLatestTotalDevicesPacked();
  els.cardTotalCasesStock.textContent = getLatestTotalCasesInStock();
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
  // Off days (2nd/4th Saturday, every Sunday) get a gray highlight.
  els.historyBody.innerHTML = rows
    .map((e) => {
      const off = isOffDay(e.date);
      return `
      <tr${off ? ' class="row-offday"' : ''}>
        <td class="cell-serial">${e.serial}</td>
        <td class="cell-muted">${formatDate(e.date)}${off ? ' <span class="offday-badge">Off</span>' : ''}</td>
        <td class="ta-right cell-num">${e.devicesReady}</td>
        <td class="ta-right cell-num cell-strong">${e.totalDevicesReady}</td>
        <td class="ta-right cell-num">${e.devicesPacked}</td>
        <td class="ta-right cell-num cell-strong">${e.totalDevicesPacked}</td>
        <td class="ta-right cell-num">${e.devicesDispatched}</td>
        <td class="ta-right cell-num">${e.casesPrinted}</td>
        <td class="ta-right cell-num cell-strong">${e.totalCasesInStock}</td>
      </tr>`;
    })
    .join('');

  // Empty state — different message for "no data yet" vs "no search matches".
  const empty = rows.length === 0;
  els.historyEmpty.hidden = !empty;
  if (empty) {
    const noData = productionData.length === 0;
    els.emptyTitle.textContent = noData ? 'No entries in your Sheet yet' : 'No matching entries';
    els.emptyText.textContent = noData
      ? 'Use the form on the left to log today\'s production — it will save directly to your Google Sheet.'
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
  // Use the selected date so backdated entries show the right baselines.
  const selectedDate = (els.dateInput && els.dateInput.value) ? els.dateInput.value : todayISO();
  const base = getStateAsOfDate(selectedDate);

  // Clamp typed values to >= 0; treat blank/invalid as 0 for the live preview.
  const devRaw = toInt(els.devicesInput.value);
  const packRaw = toInt(els.packedInput.value);
  const dispRaw = toInt(els.dispatchedInput.value);
  const prRaw = toInt(els.casesInput.value);
  const devices = Number.isNaN(devRaw) ? 0 : Math.max(0, devRaw);
  const packed = Number.isNaN(packRaw) ? 0 : Math.max(0, packRaw);
  const dispatched = Number.isNaN(dispRaw) ? 0 : Math.max(0, dispRaw);
  const printed = Number.isNaN(prRaw) ? 0 : Math.max(0, prRaw);

  // --- Serial box (hero) ---
  els.currentSerial.textContent = base.serial;
  const nextSerial = calculateNextSerialNumber(base.serial, devices);
  setSerialText(els.newSerial, nextSerial);
  if (devices > 0) {
    els.serialBox.classList.add('is-active');
    els.newSerial.classList.remove('serial-box__value--muted');
    els.serialDelta.textContent = `+${devices}`;
  } else {
    els.serialBox.classList.remove('is-active');
    els.newSerial.classList.add('serial-box__value--muted');
    els.serialDelta.textContent = '';
  }

  // --- Running totals preview ---
  // ready:  + assembled  − packed
  // packed: + packed     − dispatched
  // stock:  + printed
  const newTotalReady = base.totalDevicesReady + devices - packed;
  const newTotalPacked = base.totalDevicesPacked + packed - dispatched;
  const newTotalStock = base.totalCasesInStock + printed;
  if (els.previewTotalReady) els.previewTotalReady.textContent = newTotalReady;
  if (els.previewTotalPacked) els.previewTotalPacked.textContent = newTotalPacked;
  if (els.previewTotalStock) els.previewTotalStock.textContent = newTotalStock;
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
  const packed = toInt(els.packedInput.value);
  const dispatched = toInt(els.dispatchedInput.value);
  const printed = toInt(els.casesInput.value);

  const entryDate = els.dateInput.value || todayISO();
  const base = getStateAsOfDate(entryDate);
  const safeDevices = !Number.isNaN(devices) && devices > 0 ? devices : 0;
  const safePacked = !Number.isNaN(packed) && packed > 0 ? packed : 0;

  // Devices ready today — whole number, 0 or more (0 = no assembly that day).
  if (els.devicesInput.value.trim() === '') {
    ok = setFieldError('devices', "Enter today's completed devices (0 or more).");
  } else if (Number.isNaN(devices)) {
    ok = setFieldError('devices', 'Use a whole number for devices ready.');
  } else if (devices < 0) {
    ok = setFieldError('devices', 'Devices ready cannot be negative.');
  } else {
    clearFieldError('devices');
  }

  // Devices packed today — can't pack more loose devices than are available
  // (ready on that date + today's newly assembled).
  const availableToPack = base.totalDevicesReady + safeDevices;
  if (els.packedInput.value.trim() === '') {
    ok = setFieldError('packed', 'Enter devices packed today (0 if none).') && ok;
  } else if (Number.isNaN(packed)) {
    ok = setFieldError('packed', 'Use a whole number for devices packed.') && ok;
  } else if (packed < 0) {
    ok = setFieldError('packed', 'Devices packed cannot be negative.') && ok;
  } else if (packed > availableToPack) {
    ok = setFieldError('packed', `Only ${availableToPack} ready to pack.`) && ok;
  } else {
    clearFieldError('packed');
  }

  // Devices dispatched today — can't dispatch more than are packed
  // (packed on that date + today's newly packed).
  const availableToDispatch = base.totalDevicesPacked + safePacked;
  if (els.dispatchedInput.value.trim() === '') {
    ok = setFieldError('dispatched', 'Enter devices dispatched today (0 if none).') && ok;
  } else if (Number.isNaN(dispatched)) {
    ok = setFieldError('dispatched', 'Use a whole number for devices dispatched.') && ok;
  } else if (dispatched < 0) {
    ok = setFieldError('dispatched', 'Devices dispatched cannot be negative.') && ok;
  } else if (dispatched > availableToDispatch) {
    ok = setFieldError('dispatched', `Only ${availableToDispatch} packed to dispatch.`) && ok;
  } else {
    clearFieldError('dispatched');
  }

  // Cases printed today — whole number, 0 or more.
  if (els.casesInput.value.trim() === '') {
    ok = setFieldError('cases', 'Enter cases printed today (0 or more).') && ok;
  } else if (Number.isNaN(printed)) {
    ok = setFieldError('cases', 'Use a whole number for cases printed.') && ok;
  } else if (printed < 0) {
    ok = setFieldError('cases', 'Cases printed cannot be negative.') && ok;
  } else {
    clearFieldError('cases');
  }

  return ok;
}

// Map each field key to its [fieldEl, errorEl] pair.
function fieldPair(name) {
  if (name === 'devices') return [els.devicesField, els.devicesError];
  if (name === 'packed') return [els.packedField, els.packedError];
  if (name === 'dispatched') return [els.dispatchedField, els.dispatchedError];
  return [els.casesField, els.casesError];
}
function setFieldError(name, message) {
  const [field, error] = fieldPair(name);
  field.classList.add('invalid');
  error.textContent = message;
  return false; // returns falsy so callers can chain `&& ok`
}
function clearFieldError(name) {
  const [field, error] = fieldPair(name);
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
  els.cardTotalDevicesReady = document.getElementById('cardTotalDevicesReady');
  els.cardTotalDevicesPacked = document.getElementById('cardTotalDevicesPacked');
  els.cardTotalCasesStock = document.getElementById('cardTotalCasesStock');

  els.form = document.getElementById('productionForm');
  els.dateInput = document.getElementById('dateInput');
  els.devicesInput = document.getElementById('devicesInput');
  els.packedInput = document.getElementById('packedInput');
  els.dispatchedInput = document.getElementById('dispatchedInput');
  els.casesInput = document.getElementById('casesInput');
  els.devicesField = document.getElementById('devicesField');
  els.packedField = document.getElementById('packedField');
  els.dispatchedField = document.getElementById('dispatchedField');
  els.casesField = document.getElementById('casesField');
  els.devicesError = document.getElementById('devicesError');
  els.packedError = document.getElementById('packedError');
  els.dispatchedError = document.getElementById('dispatchedError');
  els.casesError = document.getElementById('casesError');
  els.previewTotalReady = document.getElementById('previewTotalReady');
  els.previewTotalPacked = document.getElementById('previewTotalPacked');
  els.previewTotalStock = document.getElementById('previewTotalStock');
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
  els.modeBadge = document.getElementById('modeBadge');
  els.modeDot   = document.getElementById('modeDot');
  els.modeLabel = document.getElementById('modeLabel');

  // Header + form date default to today (editable)
  els.headerDate.textContent = formatDate(todayISO());
  els.dateInput.value = todayISO();

  // Events
  // When the date changes, recalculate the serial baseline immediately so
  // the engineer sees the correct "current serial" for that date.
  els.dateInput.addEventListener('change', () => updateSerialPreview());
  els.devicesInput.addEventListener('input', () => {
    clearFieldError('devices');
    updateSerialPreview();
  });
  els.packedInput.addEventListener('input', () => {
    clearFieldError('packed');
    updateSerialPreview();
  });
  els.dispatchedInput.addEventListener('input', () => {
    clearFieldError('dispatched');
    updateSerialPreview();
  });
  els.casesInput.addEventListener('input', () => {
    clearFieldError('cases');
    updateSerialPreview();
  });
  els.searchInput.addEventListener('input', (e) => renderHistoryTable(e.target.value));
  els.form.addEventListener('submit', handleSubmit);
  els.retryBtn.addEventListener('click', refresh);

  // Load + first paint
  await refresh();
}

/** Load data and (re)paint everything. Handles loading + error states. */
async function refresh() {
  // Show mode badge immediately so the engineer always knows the data source.
  const live = backendEnabled();
  if (els.modeLabel) {
    els.modeLabel.textContent = live ? 'Live' : 'Demo';
    els.modeBadge.className   = 'mode-badge ' + (live ? 'mode-badge--live' : 'mode-badge--demo');
  }

  if (live) {
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
  const packed = toInt(els.packedInput.value);
  const dispatched = toInt(els.dispatchedInput.value);
  const printed = toInt(els.casesInput.value);
  const entryDate = els.dateInput.value || todayISO();

  // Date-aware baseline so backdated entries carry the correct running figures.
  const base = getStateAsOfDate(entryDate);
  const newSerial = calculateNextSerialNumber(base.serial, devices);
  const newTotalReady = base.totalDevicesReady + devices - packed;      // ready loses packed
  const newTotalPacked = base.totalDevicesPacked + packed - dispatched; // packed gains, dispatch drains
  const newTotalStock = base.totalCasesInStock + printed;

  const entry = {
    id: `e-${Date.now()}`,
    serial: newSerial,
    date: entryDate,
    devicesReady: devices,
    totalDevicesReady: newTotalReady,
    devicesPacked: packed,
    totalDevicesPacked: newTotalPacked,
    casesPrinted: printed,
    totalCasesInStock: newTotalStock,
    devicesDispatched: dispatched,
    createdAt: new Date().toISOString(),
  };

  setSaving(true);
  try {
    await saveProduction(entry);
  } catch (err) {
    console.error(err);
    // Save timed out. But Google may have successfully written it anyway.
    // Verify by reloading the Sheet and checking if the entry is there.
    const verified = await verifySaveSucceeded(entry);
    setSaving(false);

    if (verified) {
      // The entry IS in the Sheet — the timeout was just a slow response.
      // Refresh the UI and treat it as success.
      showToast('success', 'Saved (with delay)', 'Google was slow, but your entry is in the Sheet.');
      updateDashboard();
      renderHistoryTable(els.searchInput.value);
      highlightNewestRow();
      els.devicesInput.value = '';
      els.dispatchedInput.value = '';
      els.packedInput.value = '';
      els.casesInput.value = '';
      els.dateInput.value = todayISO();
      updateSerialPreview();
      els.devicesInput.focus();
    } else {
      // Entry is NOT in the Sheet — the save genuinely failed.
      showToast('error', "Couldn't save", "Your entry wasn't saved. Check your connection and try again.");
    }
    return; // either way, stop here
  }
  setSaving(false);

  // Refresh UI
  updateDashboard();
  renderHistoryTable(els.searchInput.value);
  highlightNewestRow();

  // Reset typed fields; keep date on today; recompute preview
  els.devicesInput.value = '';
  els.dispatchedInput.value = '';
  els.packedInput.value = '';
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
