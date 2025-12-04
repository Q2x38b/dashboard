// ---------- Supabase config ----------
const SUPABASE_URL = "https://fpgnyccusdrgzolbinpt.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZwZ255Y2N1c2RyZ3pvbGJpbnB0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ4Njk1MzUsImV4cCI6MjA4MDQ0NTUzNX0.4u6a9jg3GAskuWLeGhYGQVi8VQUywyWmGGCJtzQ7008";

let supabaseClient = null;
let currentUser = null;

let dashboardState = null;
let isEditMode = false;
let saveTimeout = null;
let isSaving = false;
let pomodoroIntervalId = null;
let forcedOfflineMode = false;

// ---------- Utilities ----------
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function escapeHtml(str = "") {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0 = Sun
  const diff = (day + 6) % 7; // days since Monday
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function computeWeekKey(date = new Date()) {
  const monday = getMonday(date);
  return monday.toISOString().slice(0, 10); // YYYY-MM-DD
}

function formatWeekTitle(weekKey) {
  if (!weekKey) return "";
  const start = new Date(weekKey);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const opts = { month: "short", day: "numeric" };
  return `Week of ${start.toLocaleDateString(undefined, opts)} – ${end.toLocaleDateString(
    undefined,
    opts
  )}`;
}

function createWidgetId() {
  return "w-" + Math.random().toString(36).slice(2, 9);
}

function createDefaultState() {
  const currentWeekKey = computeWeekKey();
  return {
    currentWeekKey,
    todos: {
      [currentWeekKey]: [],
    },
    appDock: [
      {
        id: createWidgetId(),
        label: "Mail",
        url: "https://mail.google.com",
      },
      {
        id: createWidgetId(),
        label: "Calendar",
        url: "https://calendar.google.com",
      },
      {
        id: createWidgetId(),
        label: "ChatGPT",
        url: "https://chat.openai.com",
      },
    ],
    pomodoro: {
      focusMinutes: 25,
      breakMinutes: 5,
      mode: "focus", // "focus" | "break"
      remainingSeconds: 25 * 60,
      isRunning: false,
    },
    notes: "",
    widgets: [
      { id: createWidgetId(), type: "weeklyTodo" },
      { id: createWidgetId(), type: "appDock" },
      { id: createWidgetId(), type: "pomodoro" },
      { id: createWidgetId(), type: "notes" },
      { id: createWidgetId(), type: "stats" },
    ],
  };
}

// ---------- Offline helpers ----------
function setOfflineIndicator(visible) {
  const pill = document.getElementById("offline-pill");
  if (pill) {
    pill.classList.toggle("offline-pill--visible", !!visible);
  }
}

function showOfflineModeOption(message) {
  const offlineBtn = document.getElementById("auth-offline");
  const offlineHint = document.getElementById("auth-offline-hint");
  if (offlineBtn) {
    offlineBtn.style.display = "inline-flex";
  }
  if (offlineHint) {
    offlineHint.style.display = "block";
    if (message) {
      offlineHint.textContent = message;
    }
  }
}

function isSupabaseEmailFailure(error) {
  if (!error) return false;
  const status = typeof error.status === "number" ? error.status : Number(error.status);
  const code = (error.error_code || error.code || "").toString().toLowerCase();
  const message = (error.message || error.msg || "").toLowerCase();
  if (!Number.isNaN(status) && status >= 500) return true;
  if (code.includes("unexpected_failure")) return true;
  return (
    message.includes("error sending confirmation email") ||
    message.includes("failed to send confirmation email")
  );
}

function handleSupabaseEmailFailure(statusEl) {
  const msg =
    "Supabase email is unavailable. You can keep working offline and sync once it recovers.";
  if (statusEl) {
    statusEl.textContent = msg;
  }
  showOfflineModeOption(msg);
}

function enterOfflineMode(message) {
  if (forcedOfflineMode) return;
  forcedOfflineMode = true;
  setOfflineIndicator(true);
  supabaseClient = null;
  const backup = localStorage.getItem("dashboardStateBackup");
  dashboardState = backup ? JSON.parse(backup) : createDefaultState();
  currentUser = { id: "local-offline" };
  if (message) {
    const offlineHint = document.getElementById("auth-offline-hint");
    if (offlineHint) {
      offlineHint.textContent = message;
    }
  }
  updateAuthUI();
  renderDashboard();
}

function getFaviconUrl(url) {
  try {
    const u = new URL(url);
    return new URL("/favicon.ico", u.origin).href;
  } catch {
    return "https://www.google.com/s2/favicons?domain=" + encodeURIComponent(url);
  }
}

function queueSave() {
  // also mirror to localStorage as a backup
  localStorage.setItem("dashboardStateBackup", JSON.stringify(dashboardState));

  if (!supabaseClient || !currentUser) return;
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(saveDashboardState, 1200);
}

async function saveDashboardState() {
  if (!supabaseClient || !currentUser) return;
  if (isSaving) return;
  isSaving = true;

  try {
    await supabaseClient.from("dashboard_state").upsert(
      {
        user_id: currentUser.id,
        data: dashboardState,
      },
      {
        onConflict: "user_id",
      }
    );
  } catch (err) {
    console.error("Error saving dashboard state:", err);
  } finally {
    isSaving = false;
  }
}

async function loadDashboardState() {
  if (!supabaseClient || !currentUser) return;

  try {
    const { data, error } = await supabaseClient
      .from("dashboard_state")
      .select("data")
      .eq("user_id", currentUser.id)
      .maybeSingle();

    if (error && error.code !== "PGRST116") {
      console.error("Error loading dashboard state:", error);
    }

    if (data && data.data) {
      dashboardState = data.data;
    } else {
      // fallback: localStorage backup or brand new
      const backup = localStorage.getItem("dashboardStateBackup");
      if (backup) {
        dashboardState = JSON.parse(backup);
      } else {
        dashboardState = createDefaultState();
      }
      queueSave();
    }
  } catch (e) {
    console.error("loadDashboardState error:", e);
    const backup = localStorage.getItem("dashboardStateBackup");
    dashboardState = backup ? JSON.parse(backup) : createDefaultState();
  }
}

// ---------- Rendering ----------
function renderDashboard() {
  const grid = document.getElementById("dashboard-grid");
  if (!grid || !dashboardState) return;

  const weekKey = dashboardState.currentWeekKey || computeWeekKey();
  if (!dashboardState.todos[weekKey]) {
    dashboardState.todos[weekKey] = [];
  }

  grid.innerHTML = "";
  dashboardState.widgets.forEach((widget) => {
    const el = document.createElement("div");
    el.className = "widget-card";
    el.dataset.widgetId = widget.id;
    el.dataset.widgetType = widget.type;
    el.innerHTML = renderWidgetInner(widget);
    grid.appendChild(el);
  });

  updatePomodoroDisplay(); // sync timer display
}

function renderWidgetInner(widget) {
  const titleMap = {
    weeklyTodo: "Weekly To-Do",
    appDock: "App Dock",
    pomodoro: "Pomodoro",
    notes: "Notes",
    stats: "Weekly Stats",
  };
  const title = titleMap[widget.type] || "Widget";

  const editControls = isEditMode
    ? `
      <div class="widget-edit-controls">
        <button class="widget-reorder-btn widget-move-up" data-widget-id="${widget.id}" title="Move up">↑</button>
        <button class="widget-reorder-btn widget-move-down" data-widget-id="${widget.id}" title="Move down">↓</button>
        <button class="widget-remove-btn" data-widget-id="${widget.id}" title="Remove">✕</button>
      </div>
    `
    : "";

  let body = "";
  switch (widget.type) {
    case "weeklyTodo":
      body = renderWeeklyTodoBody();
      break;
    case "appDock":
      body = renderAppDockBody(widget);
      break;
    case "pomodoro":
      body = renderPomodoroBody();
      break;
    case "notes":
      body = renderNotesBody();
      break;
    case "stats":
      body = renderStatsBody();
      break;
    default:
      body = `<div class="widget-body"><p>Unknown widget type: ${widget.type}</p></div>`;
  }

  return `
    <div class="widget-inner">
      <div class="widget-header">
        <div class="widget-title">${title}</div>
        ${editControls}
      </div>
      ${body}
    </div>
  `;
}

// ---- Weekly To-Do ----
function renderWeeklyTodoBody() {
  const weekKey = dashboardState.currentWeekKey || computeWeekKey();
  const all = dashboardState.todos[weekKey] || [];

  const daysHtml = DAY_NAMES.map((name, idx) => {
    const items = all.filter((t) => t.day === idx);
    const itemsHtml = items
      .map(
        (item) => `
      <div class="todo-item" data-todo-id="${item.id}">
        <label class="todo-checkbox-label">
          <input type="checkbox" class="todo-checkbox" data-todo-id="${item.id}" ${item.done ? "checked" : ""} />
        </label>
        <input
          type="text"
          class="todo-text"
          data-todo-id="${item.id}"
          value="${escapeHtml(item.text || "")}"
          placeholder="Task..."
        />
        <button class="todo-delete-btn" data-todo-id="${item.id}" title="Delete">✕</button>
      </div>
    `
      )
      .join("");

    return `
      <div class="weekly-todo-day" data-day="${idx}">
        <div class="weekly-todo-day-name">${name}</div>
        <div class="weekly-todo-list">
          ${itemsHtml || `<div class="todo-empty">No tasks yet.</div>`}
        </div>
        <button class="todo-add-btn" data-day="${idx}">+ Add</button>
      </div>
    `;
  }).join("");

  return `
    <div class="widget-body weekly-todo" data-week-key="${weekKey}">
      <div class="weekly-todo-header">
        <button class="todo-week-nav todo-week-prev" title="Previous week">←</button>
        <div class="weekly-todo-title">${formatWeekTitle(weekKey)}</div>
        <button class="todo-week-nav todo-week-next" title="Next week">→</button>
      </div>
      <div class="weekly-todo-grid">
        ${daysHtml}
      </div>
    </div>
  `;
}

// ---- App Dock ----
function renderAppDockBody(widget) {
  const items = dashboardState.appDock || [];
  const iconsHtml =
    items
      .map((item) => {
        return `
      <div class="dock-item" data-dock-id="${item.id}">
        <div class="dock-icon-wrapper">
          <img class="dock-icon-img" src="${getFaviconUrl(item.url)}" alt="" loading="lazy" />
        </div>
        <div class="dock-label">${escapeHtml(item.label || item.url)}</div>
        ${
          isEditMode
            ? `<button class="dock-delete-btn" data-dock-id="${item.id}" title="Remove link">✕</button>`
            : ""
        }
      </div>
    `;
      })
      .join("") || `<div class="dock-empty">No shortcuts yet. Add one below.</div>`;

  return `
    <div class="widget-body dock-widget">
      <div class="dock-items">
        ${iconsHtml}
      </div>
      <form class="dock-add-form" data-widget-id="${widget.id}">
        <input type="text" class="dock-input-label" placeholder="Label (optional)" />
        <input type="url" class="dock-input-url" placeholder="https://example.com" />
        <button type="submit" class="dock-add-button">Add</button>
      </form>
    </div>
  `;
}

// ---- Pomodoro ----
function renderPomodoroBody() {
  const p = dashboardState.pomodoro || {
    focusMinutes: 25,
    breakMinutes: 5,
    mode: "focus",
    remainingSeconds: 25 * 60,
    isRunning: false,
  };

  return `
    <div class="widget-body pomodoro-widget">
      <div class="pomodoro-display">
        <div class="pomodoro-time" id="pomodoro-time">00:00</div>
        <div class="pomodoro-mode" id="pomodoro-mode">
          ${p.mode === "focus" ? "Focus" : "Break"}
        </div>
      </div>
      <div class="pomodoro-controls">
        <button class="pomodoro-btn" data-pomodoro-action="toggle">
          ${p.isRunning ? "Pause" : "Start"}
        </button>
        <button class="pomodoro-btn-secondary" data-pomodoro-action="reset">Reset</button>
        <button class="pomodoro-btn-secondary" data-pomodoro-action="switch">
          Switch to ${p.mode === "focus" ? "Break" : "Focus"}
        </button>
      </div>
      <div class="pomodoro-settings">
        <div class="pomodoro-setting-field">
          <label>Focus (min)</label>
          <input type="number" min="1" max="120" class="pomodoro-input" data-pomodoro-field="focusMinutes" value="${
            p.focusMinutes
          }" />
        </div>
        <div class="pomodoro-setting-field">
          <label>Break (min)</label>
          <input type="number" min="1" max="60" class="pomodoro-input" data-pomodoro-field="breakMinutes" value="${
            p.breakMinutes
          }" />
        </div>
      </div>
    </div>
  `;
}

function updatePomodoroDisplay() {
  const p = dashboardState?.pomodoro;
  if (!p) return;

  const timeEl = document.getElementById("pomodoro-time");
  const modeEl = document.getElementById("pomodoro-mode");
  if (!timeEl || !modeEl) return;

  const secs = Math.max(0, p.remainingSeconds || p.focusMinutes * 60);
  const m = String(Math.floor(secs / 60)).padStart(2, "0");
  const s = String(secs % 60).padStart(2, "0");
  timeEl.textContent = `${m}:${s}`;
  modeEl.textContent = p.mode === "focus" ? "Focus" : "Break";
}

// ---- Notes ----
function renderNotesBody() {
  const text = dashboardState.notes || "";
  return `
    <div class="widget-body notes-widget">
      <textarea class="notes-textarea" placeholder="Quick notes, ideas, scratchpad...">${escapeHtml(
        text
      )}</textarea>
    </div>
  `;
}

// ---- Stats ----
function computeStats() {
  const weekKey = dashboardState.currentWeekKey || computeWeekKey();
  const items = dashboardState.todos?.[weekKey] || [];
  const done = items.filter((t) => t.done).length;
  return {
    weekKey,
    total: items.length,
    done,
    percent: items.length ? Math.round((done / items.length) * 100) : 0,
  };
}

function renderStatsBody() {
  const s = computeStats();
  return `
    <div class="widget-body stats-widget">
      <div class="stats-row">
        <span class="stats-label">Week</span>
        <span class="stats-value">${formatWeekTitle(s.weekKey)}</span>
      </div>
      <div class="stats-row">
        <span class="stats-label">Tasks done</span>
        <span class="stats-value">${s.done} / ${s.total}</span>
      </div>
      <div class="stats-row">
        <span class="stats-label">Completion</span>
        <span class="stats-value">${s.percent}%</span>
      </div>
      <div class="stats-progress">
        <div class="stats-progress-bar" style="width:${s.percent}%;"></div>
      </div>
    </div>
  `;
}

// ---------- Event handlers ----------
function handleGridClick(e) {
  const grid = document.getElementById("dashboard-grid");
  if (!grid || !dashboardState) return;

  const target = e.target;

  // Week navigation
  if (target.classList.contains("todo-week-nav")) {
    const direction = target.classList.contains("todo-week-prev") ? -1 : 1;
    const cur = new Date(dashboardState.currentWeekKey || computeWeekKey());
    cur.setDate(cur.getDate() + direction * 7);
    const newKey = computeWeekKey(cur);
    if (!dashboardState.todos[newKey]) dashboardState.todos[newKey] = [];
    dashboardState.currentWeekKey = newKey;
    renderDashboard();
    queueSave();
    return;
  }

  // Add todo
  const addBtn = target.closest(".todo-add-btn");
  if (addBtn) {
    const day = parseInt(addBtn.dataset.day, 10);
    const weekKey = dashboardState.currentWeekKey || computeWeekKey();
    const arr = dashboardState.todos[weekKey] || [];
    arr.push({
      id: createWidgetId(),
      text: "",
      done: false,
      day,
    });
    dashboardState.todos[weekKey] = arr;
    renderDashboard();
    queueSave();
    return;
  }

  // Delete todo
  const deleteTodoBtn = target.closest(".todo-delete-btn");
  if (deleteTodoBtn) {
    const todoId = deleteTodoBtn.dataset.todoId;
    const weekKey = dashboardState.currentWeekKey || computeWeekKey();
    const arr = dashboardState.todos[weekKey] || [];
    dashboardState.todos[weekKey] = arr.filter((t) => t.id !== todoId);
    renderDashboard();
    queueSave();
    return;
  }

  // Dock item click (open link)
  const dockItem = target.closest(".dock-item");
  if (dockItem && !target.classList.contains("dock-delete-btn")) {
    const dockId = dockItem.dataset.dockId;
    const item = (dashboardState.appDock || []).find((d) => d.id === dockId);
    if (item && !isEditMode) {
      window.open(item.url, "_blank", "noopener");
    }
    return;
  }

  // Dock delete
  const dockDeleteBtn = target.closest(".dock-delete-btn");
  if (dockDeleteBtn) {
    const dockId = dockDeleteBtn.dataset.dockId;
    dashboardState.appDock = (dashboardState.appDock || []).filter((d) => d.id !== dockId);
    renderDashboard();
    queueSave();
    return;
  }

  // Pomodoro buttons
  const pomBtn = target.closest("[data-pomodoro-action]");
  if (pomBtn) {
    const action = pomBtn.dataset.pomodoroAction;
    handlePomodoroAction(action);
    return;
  }

  // Widget reorder / remove (edit mode only)
  if (isEditMode) {
    if (target.classList.contains("widget-remove-btn")) {
      const id = target.dataset.widgetId;
      dashboardState.widgets = dashboardState.widgets.filter((w) => w.id !== id);
      renderDashboard();
      queueSave();
      return;
    }

    if (target.classList.contains("widget-move-up") || target.classList.contains("widget-move-down")) {
      const id = target.dataset.widgetId;
      const idx = dashboardState.widgets.findIndex((w) => w.id === id);
      if (idx === -1) return;
      const dir = target.classList.contains("widget-move-up") ? -1 : 1;
      const newIdx = idx + dir;
      if (newIdx < 0 || newIdx >= dashboardState.widgets.length) return;
      const tmp = dashboardState.widgets[idx];
      dashboardState.widgets[idx] = dashboardState.widgets[newIdx];
      dashboardState.widgets[newIdx] = tmp;
      renderDashboard();
      queueSave();
      return;
    }
  }
}

function handleGridInput(e) {
  const target = e.target;

  // Todo checkbox
  if (target.classList.contains("todo-checkbox")) {
    const todoId = target.dataset.todoId;
    const weekKey = dashboardState.currentWeekKey || computeWeekKey();
    const arr = dashboardState.todos[weekKey] || [];
    const item = arr.find((t) => t.id === todoId);
    if (item) {
      item.done = target.checked;
      dashboardState.todos[weekKey] = arr;
      renderDashboard(); // update stats
      queueSave();
    }
    return;
  }

  // Todo text
  if (target.classList.contains("todo-text")) {
    const todoId = target.dataset.todoId;
    const weekKey = dashboardState.currentWeekKey || computeWeekKey();
    const arr = dashboardState.todos[weekKey] || [];
    const item = arr.find((t) => t.id === todoId);
    if (item) {
      item.text = target.value;
      dashboardState.todos[weekKey] = arr;
      queueSave();
    }
    return;
  }

  // Notes
  if (target.classList.contains("notes-textarea")) {
    dashboardState.notes = target.value;
    queueSave();
    return;
  }

  // Pomodoro settings
  if (target.classList.contains("pomodoro-input")) {
    const field = target.dataset.pomodoroField;
    const value = Math.max(1, parseInt(target.value || "1", 10));
    if (!dashboardState.pomodoro) dashboardState.pomodoro = createDefaultState().pomodoro;
    dashboardState.pomodoro[field] = value;

    if (dashboardState.pomodoro.mode === "focus" && field === "focusMinutes") {
      dashboardState.pomodoro.remainingSeconds = value * 60;
    }
    if (dashboardState.pomodoro.mode === "break" && field === "breakMinutes") {
      dashboardState.pomodoro.remainingSeconds = value * 60;
    }

    updatePomodoroDisplay();
    queueSave();
    return;
  }
}

function handleDockAddSubmit(e) {
  const form = e.target.closest(".dock-add-form");
  if (!form) return;
  e.preventDefault();
  const labelInput = form.querySelector(".dock-input-label");
  const urlInput = form.querySelector(".dock-input-url");
  const label = (labelInput.value || "").trim();
  const url = (urlInput.value || "").trim();

  if (!url) return;
  if (!dashboardState.appDock) dashboardState.appDock = [];
  dashboardState.appDock.push({
    id: createWidgetId(),
    label: label || url,
    url,
  });

  labelInput.value = "";
  urlInput.value = "";
  renderDashboard();
  queueSave();
}

// ---------- Pomodoro logic ----------
function clearPomodoroInterval() {
  if (pomodoroIntervalId) {
    clearInterval(pomodoroIntervalId);
    pomodoroIntervalId = null;
  }
}

function handlePomodoroAction(action) {
  if (!dashboardState.pomodoro) {
    dashboardState.pomodoro = createDefaultState().pomodoro;
  }
  const p = dashboardState.pomodoro;

  if (action === "toggle") {
    if (p.isRunning) {
      p.isRunning = false;
      clearPomodoroInterval();
    } else {
      p.isRunning = true;
      if (!p.remainingSeconds) {
        p.remainingSeconds = (p.mode === "focus" ? p.focusMinutes : p.breakMinutes) * 60;
      }
      clearPomodoroInterval();
      pomodoroIntervalId = setInterval(() => {
        if (!dashboardState.pomodoro.isRunning) return;
        dashboardState.pomodoro.remainingSeconds -= 1;
        if (dashboardState.pomodoro.remainingSeconds <= 0) {
          dashboardState.pomodoro.remainingSeconds = 0;
          updatePomodoroDisplay();
          clearPomodoroInterval();
          dashboardState.pomodoro.isRunning = false;
          alert("Time is up!");
        } else {
          updatePomodoroDisplay();
        }
      }, 1000);
    }
    renderDashboard();
    queueSave();
    return;
  }

  if (action === "reset") {
    clearPomodoroInterval();
    p.isRunning = false;
    p.remainingSeconds = (p.mode === "focus" ? p.focusMinutes : p.breakMinutes) * 60;
    updatePomodoroDisplay();
    renderDashboard();
    queueSave();
    return;
  }

  if (action === "switch") {
    clearPomodoroInterval();
    p.isRunning = false;
    p.mode = p.mode === "focus" ? "break" : "focus";
    p.remainingSeconds = (p.mode === "focus" ? p.focusMinutes : p.breakMinutes) * 60;
    updatePomodoroDisplay();
    renderDashboard();
    queueSave();
    return;
  }
}

// ---------- Widgets panel / edit mode ----------
function toggleEditMode() {
  isEditMode = !isEditMode;
  const fab = document.getElementById("widgets-fab");
  if (fab) {
    fab.classList.toggle("widgets-fab--active", isEditMode);
    fab.querySelector(".widgets-fab-icon").textContent = isEditMode ? "✅" : "⚙️";
  }
  renderDashboard();
}

function showWidgetsPanel(show) {
  const panel = document.getElementById("widgets-panel");
  if (!panel) return;
  panel.classList.toggle("widgets-panel--visible", !!show);
}

function addWidget(type) {
  dashboardState.widgets.push({
    id: createWidgetId(),
    type,
  });
  renderDashboard();
  queueSave();
}

// ---------- Theme ----------
function initTheme() {
  const stored = localStorage.getItem("dashboardTheme");
  const root = document.documentElement;
  if (stored === "light" || stored === "dark") {
    root.setAttribute("data-theme", stored);
  } else {
    root.setAttribute("data-theme", "dark");
  }

  const toggleBtn = document.getElementById("theme-toggle");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      const current = root.getAttribute("data-theme") === "light" ? "light" : "dark";
      const next = current === "light" ? "dark" : "light";
      root.setAttribute("data-theme", next);
      localStorage.setItem("dashboardTheme", next);
    });
  }
}

// ---------- Auth ----------
async function initSupabase() {
  if (!window.supabase) {
    console.error("Supabase script not loaded");
    return;
  }
  const { createClient } = window.supabase;
  if (!SUPABASE_URL.includes("YOUR-PROJECT")) {
    supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }

  if (!supabaseClient) return;

  // onAuthStateChange
  supabaseClient.auth.onAuthStateChange((event, session) => {
    currentUser = session?.user ?? null;
    if (currentUser) {
      forcedOfflineMode = false;
      setOfflineIndicator(false);
    } else if (!forcedOfflineMode) {
      setOfflineIndicator(false);
    }
    updateAuthUI();
    if (currentUser) {
      loadDashboardState().then(renderDashboard);
    } else {
      dashboardState = null;
    }
  });

  const { data } = await supabaseClient.auth.getSession();
  currentUser = data.session?.user ?? null;
  if (currentUser) {
    forcedOfflineMode = false;
    setOfflineIndicator(false);
  }
  updateAuthUI();
  if (currentUser) {
    await loadDashboardState();
    renderDashboard();
  }
}

function updateAuthUI() {
  const overlay = document.getElementById("auth-overlay");
  const logoutBtn = document.getElementById("logout-btn");
  const authed = !!currentUser;

  if (overlay) {
    overlay.classList.toggle("auth-overlay--visible", !authed);
  }
  if (logoutBtn) {
    logoutBtn.style.display = authed ? "inline-flex" : "none";
  }
}

async function handleAuthSubmit() {
  const emailInput = document.getElementById("auth-email");
  const passwordInput = document.getElementById("auth-password");
  const errorEl = document.getElementById("auth-error");

  const email = emailInput.value.trim();
  const password = passwordInput.value.trim();

  if (!supabaseClient) {
    const msg = forcedOfflineMode
      ? "Supabase sync is paused while you're offline. Reload when it's back to sign in."
      : "Supabase is not configured. Set SUPABASE_URL & key in app.js.";
    errorEl.textContent = msg;
    if (forcedOfflineMode) {
      showOfflineModeOption(msg);
    }
    return;
  }

  if (!email) {
    errorEl.textContent = "Enter your email.";
    return;
  }

  // If no password is provided, assume this is a returning user and send a magic link.
  if (!password) {
    await sendMagicLink(email, errorEl);
    return;
  }

  // With a password: try to create account.
  // If the user already exists, fall back to magic link login.
  errorEl.textContent = "Creating your account...";

  try {
    const { data, error } = await supabaseClient.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: window.location.origin,
      },
    });

    if (error) {
      if (isSupabaseEmailFailure(error)) {
        handleSupabaseEmailFailure(errorEl);
        return;
      }
      const msg = (error.message || "").toLowerCase();

      // If user already exists, we treat this as a login attempt via magic link
      if (msg.includes("already registered") || msg.includes("user already exists")) {
        await sendMagicLink(email, errorEl);
        return;
      }

      console.error("Sign-up error:", error);
      errorEl.textContent = error.message || "Sign-up error.";
      return;
    }

    // Remember that this email has an account (optional but nice to have)
    localStorage.setItem("dashboardMagicEmail", email);

    if (data.session && data.session.user) {
      // Email confirmation disabled: user is already logged in
      currentUser = data.session.user;
      errorEl.textContent = "";
      updateAuthUI();
      await loadDashboardState();
      renderDashboard();
    } else {
      // Email confirmation enabled: they must click the verification email
      errorEl.textContent =
        "Account created. Check your email to confirm. After that, use the magic link to log in.";
    }
  } catch (e) {
    if (isSupabaseEmailFailure(e)) {
      handleSupabaseEmailFailure(errorEl);
      return;
    }
    console.error("Unexpected sign-up error:", e);
    errorEl.textContent = "Unexpected error.";
  }
}

async function handleLogout() {
  forcedOfflineMode = false;
  setOfflineIndicator(false);
  if (!supabaseClient) {
    currentUser = null;
    dashboardState = null;
    updateAuthUI();
    const errorEl = document.getElementById("auth-error");
    if (errorEl) {
      errorEl.textContent = "Reload the page once Supabase is back online to sign in.";
    }
    return;
  }
  await supabaseClient.auth.signOut();
  currentUser = null;
  dashboardState = null;
  updateAuthUI();
}

// ---------- Init ----------
function initEvents() {
  const grid = document.getElementById("dashboard-grid");
  grid.addEventListener("click", handleGridClick);
  grid.addEventListener("input", handleGridInput);
  grid.addEventListener("submit", (e) => {
    if (e.target.closest(".dock-add-form")) {
      handleDockAddSubmit(e);
    }
  });

  const authSubmit = document.getElementById("auth-submit");
  if (authSubmit) authSubmit.addEventListener("click", handleAuthSubmit);

  const authPassword = document.getElementById("auth-password");
  if (authPassword) {
    authPassword.addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleAuthSubmit();
    });
  }

  const offlineBtn = document.getElementById("auth-offline");
  if (offlineBtn) {
    offlineBtn.addEventListener("click", () => {
      enterOfflineMode("Offline mode enabled. Data will stay on this device until Supabase is back.");
    });
  }

  const logoutBtn = document.getElementById("logout-btn");
  if (logoutBtn) logoutBtn.addEventListener("click", handleLogout);

  const fab = document.getElementById("widgets-fab");
  if (fab) {
    fab.addEventListener("click", () => {
      toggleEditMode();
      showWidgetsPanel(true);
    });
  }

  const panelClose = document.getElementById("widgets-panel-close");
  if (panelClose) {
    panelClose.addEventListener("click", () => showWidgetsPanel(false));
  }

  const panel = document.getElementById("widgets-panel");
  if (panel) {
    panel.addEventListener("click", (e) => {
      const btn = e.target.closest(".widgets-panel-item");
      if (!btn) return;
      const type = btn.dataset.widgetType;
      addWidget(type);
    });
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  initTheme();
  initEvents();
  await initSupabase();

  // If Supabase isn't configured, fall back to local-only mode
  if (!supabaseClient) {
    enterOfflineMode("Supabase is not configured. Using offline mode.");
  }
});

async function sendMagicLink(email, statusEl) {
  if (!supabaseClient) {
    if (statusEl) {
      statusEl.textContent = forcedOfflineMode
        ? "Supabase sync is paused while you're offline. Reload later to request a magic link."
        : "Supabase is not configured.";
    }
    if (forcedOfflineMode) {
      const offlineMessage = statusEl ? statusEl.textContent : "";
      showOfflineModeOption(offlineMessage);
    }
    return;
  }

  if (statusEl) statusEl.textContent = "Sending magic link...";

  try {
    const { error } = await supabaseClient.auth.signInWithOtp({
      email,
      options: {
        // where Supabase will redirect after the user clicks the email link
        emailRedirectTo: window.location.origin,
      },
    });

    if (error) {
      if (isSupabaseEmailFailure(error)) {
        handleSupabaseEmailFailure(statusEl);
        return;
      }
      console.error("Magic link error:", error);
      if (statusEl) statusEl.textContent = error.message || "Could not send magic link.";
      return;
    }

    if (statusEl) {
      statusEl.textContent = "Magic link sent. Check your email to log in.";
    }
  } catch (e) {
    if (isSupabaseEmailFailure(e)) {
      handleSupabaseEmailFailure(statusEl);
      return;
    }
    console.error("sendMagicLink exception:", e);
    if (statusEl) statusEl.textContent = "Unexpected error sending magic link.";
  }
}


/*
Supabase table (run in SQL editor):

create table public.dashboard_state (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users on delete cascade,
  data jsonb not null,
  inserted_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.dashboard_state
  add constraint dashboard_state_user_unique unique (user_id);

-- RLS:
alter table public.dashboard_state enable row level security;

create policy "dashboard_state_select" on public.dashboard_state
  for select using (auth.uid() = user_id);

create policy "dashboard_state_upsert" on public.dashboard_state
  for insert with check (auth.uid() = user_id);

create policy "dashboard_state_update" on public.dashboard_state
  for update using (auth.uid() = user_id);
*/

