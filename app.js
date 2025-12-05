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
let draggedWidgetId = null;

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

function createDefaultUpcomingEvents() {
  const templates = [
    { title: "Team sync", time: "09:30", location: "Product hub", tag: "Work" },
    { title: "Wellness break", time: "14:00", location: "Gym", tag: "Health" },
    { title: "Planning session", time: "11:00", location: "Remote", tag: "Focus" },
  ];

  return templates.map((template, index) => {
    const date = new Date();
    date.setDate(date.getDate() + (index + 1));
    return {
      id: createWidgetId(),
      title: template.title,
      date: date.toISOString().slice(0, 10),
      time: template.time,
      location: template.location,
      tag: template.tag,
      done: false,
    };
  });
}

function createDefaultHabits() {
  return [
    { id: createWidgetId(), label: "Hydrate x8", streak: 3, doneToday: false },
    { id: createWidgetId(), label: "Move for 20m", streak: 5, doneToday: false },
    { id: createWidgetId(), label: "Reflect & jot", streak: 2, doneToday: false },
  ];
}

function getDefaultSpanForType(type) {
  if (type === "weeklyTodo" || type === "notes") return 2;
  if (type === "upcoming") return 2;
  return 1;
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
    upcomingEvents: createDefaultUpcomingEvents(),
    habits: createDefaultHabits(),
    widgets: [
      { id: createWidgetId(), type: "weeklyTodo", span: 2 },
      { id: createWidgetId(), type: "upcoming", span: 2 },
      { id: createWidgetId(), type: "pomodoro", span: 1 },
      { id: createWidgetId(), type: "notes", span: 2 },
      { id: createWidgetId(), type: "habitTracker", span: 1 },
      { id: createWidgetId(), type: "stats", span: 1 },
      { id: createWidgetId(), type: "dailyBrief", span: 1 },
    ],
    ui: {
      notesMode: "edit",
    },
  };
}

function normalizeDashboardState() {
  if (!dashboardState) return false;
  let mutated = false;

  if (!dashboardState.widgets) {
    dashboardState.widgets = [];
    mutated = true;
  }

  const filteredWidgets = dashboardState.widgets.filter((widget) => widget.type !== "appDock");
  if (filteredWidgets.length !== dashboardState.widgets.length) {
    dashboardState.widgets = filteredWidgets;
    mutated = true;
  }

  dashboardState.widgets.forEach((widget) => {
    if (!widget.id) {
      widget.id = createWidgetId();
      mutated = true;
    }
    if (!widget.span) {
      widget.span = getDefaultSpanForType(widget.type);
      mutated = true;
    }
  });

  if (!dashboardState.upcomingEvents) {
    dashboardState.upcomingEvents = createDefaultUpcomingEvents();
    mutated = true;
  }

  if (!dashboardState.habits) {
    dashboardState.habits = createDefaultHabits();
    mutated = true;
  }

  if (!dashboardState.appDock) {
    dashboardState.appDock = [];
    mutated = true;
  }

  if (!dashboardState.ui) {
    dashboardState.ui = { notesMode: "edit" };
    mutated = true;
  }

  if (!dashboardState.ui.notesMode) {
    dashboardState.ui.notesMode = "edit";
    mutated = true;
  }

  return mutated;
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
  if (normalizeDashboardState()) {
    queueSave();
  }
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
    if (normalizeDashboardState()) {
      queueSave();
    }
  } catch (e) {
    console.error("loadDashboardState error:", e);
    const backup = localStorage.getItem("dashboardStateBackup");
    dashboardState = backup ? JSON.parse(backup) : createDefaultState();
    if (normalizeDashboardState()) {
      queueSave();
    }
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

  const previousScroll = grid.scrollTop;
  grid.innerHTML = "";
  dashboardState.widgets.forEach((widget) => {
    const span = widget.span || getDefaultSpanForType(widget.type);
    const el = document.createElement("div");
    el.className = "widget-card";
    el.dataset.widgetId = widget.id;
    el.dataset.widgetType = widget.type;
    el.dataset.span = span;
    el.draggable = !!isEditMode;
    el.innerHTML = renderWidgetInner(widget);
    grid.appendChild(el);
  });
  grid.scrollTop = previousScroll;
  grid.dataset.editing = isEditMode ? "true" : "false";
  updatePomodoroDisplay(); // sync timer display
  renderDockBar();
}

function renderWidgetInner(widget) {
  const titleMap = {
    weeklyTodo: "Weekly To-Do",
    upcoming: "Upcoming Week",
    pomodoro: "Pomodoro",
    notes: "Notes",
    stats: "Weekly Stats",
    habitTracker: "Habit Tracker",
    dailyBrief: "Daily Brief",
  };
  const title = titleMap[widget.type] || "Widget";

  const editControls = isEditMode
    ? `
      <div class="widget-edit-controls">
        <button class="widget-icon-btn widget-size-btn" data-widget-id="${widget.id}" title="Toggle width">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path d="M5 12h14M8 9l-3 3 3 3M16 9l3 3-3 3" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <button class="widget-remove-btn" data-widget-id="${widget.id}" title="Remove">x</button>
      </div>
    `
    : "";

  const dragHandle = isEditMode ? `<span class="widget-handle" aria-hidden="true"></span>` : "";

  let body = "";
  switch (widget.type) {
    case "weeklyTodo":
      body = renderWeeklyTodoBody();
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
    case "upcoming":
      body = renderUpcomingBody();
      break;
    case "habitTracker":
      body = renderHabitTrackerBody();
      break;
    case "dailyBrief":
      body = renderDailyBriefBody();
      break;
    default:
      body = `<div class="widget-body"><p>Unknown widget type: ${widget.type}</p></div>`;
  }

  return `
    <div class="widget-inner">
      <div class="widget-header">
        <div class="widget-title">${title}</div>
        ${dragHandle}
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
  const mode = dashboardState.ui?.notesMode || "edit";
  const previewHtml = convertMarkdownToHtml(text);
  return `
    <div class="widget-body notes-widget" data-notes-mode="${mode}">
      <div class="notes-tabs">
        <button type="button" class="notes-tab ${mode === "edit" ? "is-active" : ""}" data-notes-mode="edit">
          Edit
        </button>
        <button type="button" class="notes-tab ${mode === "preview" ? "is-active" : ""}" data-notes-mode="preview">
          Preview
        </button>
      </div>
      <div class="notes-pane notes-pane--edit ${mode === "edit" ? "is-visible" : ""}">
        <textarea class="notes-textarea" placeholder="Quick notes, ideas, scratchpad...">${escapeHtml(text)}</textarea>
      </div>
      <div class="notes-pane notes-pane--preview ${mode === "preview" ? "is-visible" : ""}">
        <div class="notes-preview">
          ${
            previewHtml ||
            `<p class="notes-empty">Start typing in Edit mode to see your formatted note.</p>`
          }
        </div>
      </div>
    </div>
  `;
}

function convertMarkdownToHtml(input = "") {
  if (!input) return "";
  let safe = input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  safe = safe.replace(/```([\s\S]*?)```/g, (_, code) => {
    return `<pre><code>${code.trim()}</code></pre>`;
  });
  safe = safe.replace(/^### (.*)$/gim, "<h4>$1</h4>");
  safe = safe.replace(/^## (.*)$/gim, "<h3>$1</h3>");
  safe = safe.replace(/^# (.*)$/gim, "<h2>$1</h2>");
  safe = safe.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
  safe = safe.replace(/\*(.*?)\*/g, "<em>$1</em>");
  safe = safe.replace(/`([^`]+)`/g, "<code>$1</code>");
  safe = safe.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  safe = safe.replace(/(?:^|\n)- (.*)(?=\n|$)/gm, "<li>$1</li>");
  safe = safe.replace(/(<li>[\s\S]*?<\/li>)+/g, (match) => `<ul>${match}</ul>`);
  safe = safe.replace(/\n{2,}/g, "<br><br>");
  return safe.replace(/\n/g, "<br>");
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

function getUpcomingEventsSorted() {
  const events = dashboardState.upcomingEvents || [];
  return events.slice().sort((a, b) => {
    return getEventDateValue(a) - getEventDateValue(b);
  });
}

function getEventDateValue(event) {
  const time = event.time || "09:00";
  const safeTime = time.length === 5 ? `${time}:00` : time;
  return new Date(`${event.date || computeWeekKey()}T${safeTime}`);
}

function formatCountdown(event) {
  const target = getEventDateValue(event);
  const now = new Date();
  const diffMs = target - now;
  if (diffMs <= 0) return "Today";
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays > 0) return `${diffDays}d`;
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  if (diffHours > 0) return `${diffHours}h`;
  const diffMinutes = Math.max(1, Math.floor(diffMs / (1000 * 60)));
  return `${diffMinutes}m`;
}

function formatEventDay(event) {
  const target = getEventDateValue(event);
  return target.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function renderUpcomingBody() {
  const events = getUpcomingEventsSorted();
  const todayIso = new Date().toISOString().slice(0, 10);
  const listHtml =
    events
      .map((event) => {
        return `
        <div class="upcoming-item ${event.done ? "done" : ""}" data-upcoming-id="${event.id}">
          <div class="upcoming-item-header">
            <div class="upcoming-title">${escapeHtml(event.title || "Untitled")}</div>
            <div class="upcoming-actions">
              <button class="upcoming-action-btn" data-upcoming-action="toggle" data-upcoming-id="${event.id}" title="Mark done">
                ${event.done ? "Reset" : "Done"}
              </button>
              <button class="upcoming-action-btn" data-upcoming-action="delete" data-upcoming-id="${event.id}" title="Remove">
                x
              </button>
            </div>
          </div>
          <div class="upcoming-meta">
            <span>${formatEventDay(event)} • ${event.time || "--:--"}</span>
            <span class="upcoming-countdown">${formatCountdown(event)}</span>
          </div>
          <div class="upcoming-meta">
            <span>${escapeHtml(event.location || "Any location")}</span>
            <span class="upcoming-tag">${escapeHtml(event.tag || "General")}</span>
          </div>
        </div>
      `;
      })
      .join("") || `<div class="upcoming-empty">Nothing scheduled — add the next thing below.</div>`;

  return `
    <div class="widget-body upcoming-widget">
      <div class="upcoming-list">
        ${listHtml}
      </div>
      <form class="upcoming-add-form" data-upcoming-form>
        <input type="text" name="title" placeholder="Title" aria-label="Event title" required />
        <input type="date" name="date" aria-label="Event date" value="${todayIso}" required />
        <input type="time" name="time" aria-label="Event time" />
        <input type="text" name="location" placeholder="Location / context" aria-label="Event location" />
        <button type="submit">Add</button>
      </form>
    </div>
  `;
}

function renderHabitTrackerBody() {
  const habits = dashboardState.habits || [];
  const items =
    habits
      .map(
        (habit) => `
      <div class="habit-row" data-habit-id="${habit.id}">
        <div class="habit-left">
          <input type="checkbox" class="habit-toggle" data-habit-id="${habit.id}" ${habit.doneToday ? "checked" : ""} />
          <span class="habit-name">${escapeHtml(habit.label || "New habit")}</span>
        </div>
        <span class="habit-streak">${habit.streak || 0}d</span>
      </div>
    `
      )
      .join("") || `<div class="habit-empty">Add a ritual and check it off daily.</div>`;

  return `
    <div class="widget-body habit-widget">
      ${items}
      <form class="habit-add-form" data-habit-form>
        <input type="text" name="habit" placeholder="New habit" aria-label="Habit name" required />
        <button type="submit">Add</button>
      </form>
    </div>
  `;
}

function getNextUpcomingEvent() {
  return getUpcomingEventsSorted().find((event) => !event.done) || null;
}

function renderDailyBriefBody() {
  const now = new Date();
  const stats = computeStats();
  const nextEvent = getNextUpcomingEvent();
  const dateText = now.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const timeText = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const chip = nextEvent
    ? `Next: ${escapeHtml(nextEvent.title || "Upcoming")} • ${formatEventDay(nextEvent)}`
    : "Your calendar is clear — plan something meaningful.";

  return `
    <div class="widget-body daily-brief-widget">
      <div class="brief-row">
        <span class="brief-label">Today</span>
        <span class="brief-value">${dateText}</span>
      </div>
      <div class="brief-row">
        <span class="brief-label">Time</span>
        <span class="brief-value">${timeText}</span>
      </div>
      <div class="brief-row">
        <span class="brief-label">Completion</span>
        <span class="brief-value">${stats.percent}%</span>
      </div>
      <div class="brief-chip">${chip}</div>
      <div class="brief-actions">
        <button type="button" class="brief-action-btn" data-brief-action="add-task">Quick task</button>
        <button type="button" class="brief-action-btn" data-brief-action="focus-now">Start focus</button>
      </div>
    </div>
  `;
}

function renderDockBar() {
  const list = document.getElementById("dock-bar-items");
  const addBtn = document.getElementById("dock-bar-add");
  const form = document.getElementById("dock-bar-form");
  if (!list || !dashboardState) return;

  const items = dashboardState.appDock || [];
  if (!items.length) {
    list.innerHTML = `<div class="dock-empty-state">Add links with the + button</div>`;
  } else {
    list.innerHTML = items
      .map(
        (item) => `
        <div class="dock-bar-item" data-dock-id="${item.id}" tabindex="0" role="button" aria-label="${escapeHtml(
          item.label || item.url
        )}">
          <img src="${getFaviconUrl(item.url)}" alt="" loading="lazy" />
          <span>${escapeHtml(item.label || item.url)}</span>
          ${
            isEditMode
              ? `<button type="button" class="dock-bar-delete" data-dock-id="${item.id}" title="Remove link">x</button>`
              : ""
          }
        </div>
      `
      )
      .join("");
  }

  if (addBtn && form) {
    addBtn.classList.toggle("is-active", form.classList.contains("dock-bar-form--visible"));
    addBtn.setAttribute("aria-expanded", form.classList.contains("dock-bar-form--visible") ? "true" : "false");
  }
}

function toggleDockForm(forceState) {
  const form = document.getElementById("dock-bar-form");
  const addBtn = document.getElementById("dock-bar-add");
  if (!form || !addBtn) return;
  const willShow = typeof forceState === "boolean" ? forceState : !form.classList.contains("dock-bar-form--visible");
  form.classList.toggle("dock-bar-form--visible", willShow);
  addBtn.classList.toggle("is-active", willShow);
  addBtn.setAttribute("aria-expanded", willShow ? "true" : "false");
  if (willShow) {
    form.querySelector("input")?.focus();
  }
}

function handleDockBarSubmit(e) {
  e.preventDefault();
  const form = e.target.closest("#dock-bar-form");
  if (!form) return;
  const label = form.querySelector("#dock-label-input")?.value.trim() || "";
  const url = form.querySelector("#dock-url-input")?.value.trim();
  if (!url) return;
  if (!dashboardState.appDock) dashboardState.appDock = [];
  dashboardState.appDock.push({
    id: createWidgetId(),
    label: label || url,
    url,
  });
  form.reset();
  toggleDockForm(false);
  renderDockBar();
  queueSave();
}

function openDockItem(dockId) {
  const entry = (dashboardState.appDock || []).find((dock) => dock.id === dockId);
  if (entry) {
    window.open(entry.url, "_blank", "noopener");
  }
}

function handleDockBarClick(e) {
  const deleteBtn = e.target.closest(".dock-bar-delete");
  if (deleteBtn) {
    const dockId = deleteBtn.dataset.dockId;
    dashboardState.appDock = (dashboardState.appDock || []).filter((item) => item.id !== dockId);
    renderDockBar();
    queueSave();
    return;
  }

  const item = e.target.closest(".dock-bar-item");
  if (item && !isEditMode) {
    const dockId = item.dataset.dockId;
    openDockItem(dockId);
  }
}

function handleDockBarKeydown(e) {
  if (e.key !== "Enter") return;
  const item = e.target.closest(".dock-bar-item");
  if (item && !isEditMode) {
    e.preventDefault();
    openDockItem(item.dataset.dockId);
  }
}

function handleUpcomingAction(action, id) {
  if (!dashboardState.upcomingEvents) dashboardState.upcomingEvents = [];
  if (action === "delete") {
    dashboardState.upcomingEvents = dashboardState.upcomingEvents.filter((event) => event.id !== id);
  } else if (action === "toggle") {
    const event = dashboardState.upcomingEvents.find((evt) => evt.id === id);
    if (event) {
      event.done = !event.done;
    }
  }
  renderDashboard();
  queueSave();
}

function handleUpcomingAddSubmit(e) {
  e.preventDefault();
  const form = e.target.closest("[data-upcoming-form]");
  if (!form) return;
  const formData = new FormData(form);
  const title = (formData.get("title") || "").trim();
  const date = formData.get("date") || computeWeekKey();
  const time = formData.get("time") || "";
  const location = (formData.get("location") || "").trim();
  if (!title) return;
  if (!dashboardState.upcomingEvents) dashboardState.upcomingEvents = [];
  dashboardState.upcomingEvents.push({
    id: createWidgetId(),
    title,
    date,
    time,
    location,
    tag: "Custom",
    done: false,
  });
  form.reset();
  renderDashboard();
  queueSave();
}

function handleHabitAddSubmit(e) {
  e.preventDefault();
  const form = e.target.closest("[data-habit-form]");
  if (!form) return;
  const input = form.querySelector('input[name="habit"]');
  const label = (input?.value || "").trim();
  if (!label) return;
  if (!dashboardState.habits) dashboardState.habits = [];
  dashboardState.habits.push({
    id: createWidgetId(),
    label,
    streak: 0,
    doneToday: false,
  });
  input.value = "";
  renderDashboard();
  queueSave();
}

function toggleWidgetSpan(widgetId) {
  const widget = dashboardState.widgets.find((w) => w.id === widgetId);
  if (!widget) return;
  widget.span = widget.span === 2 ? 1 : 2;
  renderDashboard();
  queueSave();
}

function handleBriefAction(action) {
  if (action === "add-task") {
    const dayIndex = ((new Date().getDay() + 6) % 7);
    const weekKey = dashboardState.currentWeekKey || computeWeekKey();
    const arr = dashboardState.todos[weekKey] || [];
    arr.push({
      id: createWidgetId(),
      text: "",
      done: false,
      day: dayIndex,
    });
    dashboardState.todos[weekKey] = arr;
    renderDashboard();
    queueSave();
    return;
  }

  if (action === "focus-now") {
    handlePomodoroAction("reset");
    const p = dashboardState.pomodoro;
    if (!p?.isRunning) {
      handlePomodoroAction("toggle");
    }
  }
}

function handleWidgetDragStart(e) {
  if (!isEditMode) {
    e.preventDefault();
    return;
  }
  const card = e.target.closest(".widget-card");
  if (!card) return;
  draggedWidgetId = card.dataset.widgetId;
  card.classList.add("widget-card--dragging");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", draggedWidgetId);
}

function handleWidgetDragOver(e) {
  if (!isEditMode || !draggedWidgetId) return;
  const card = e.target.closest(".widget-card");
  if (!card || card.dataset.widgetId === draggedWidgetId) return;
  e.preventDefault();
}

function handleWidgetDrop(e) {
  if (!isEditMode || !draggedWidgetId) return;
  const targetCard = e.target.closest(".widget-card");
  if (!targetCard) return;
  e.preventDefault();
  const targetId = targetCard.dataset.widgetId;
  if (!targetId || targetId === draggedWidgetId) return;
  reorderWidgets(draggedWidgetId, targetId);
  handleWidgetDragEnd();
}

function handleWidgetDragEnd() {
  document.querySelectorAll(".widget-card--dragging").forEach((el) => el.classList.remove("widget-card--dragging"));
  draggedWidgetId = null;
}

function reorderWidgets(sourceId, targetId) {
  const widgets = dashboardState.widgets || [];
  const fromIndex = widgets.findIndex((w) => w.id === sourceId);
  let toIndex = widgets.findIndex((w) => w.id === targetId);
  if (fromIndex === -1 || toIndex === -1) return;
  const [moved] = widgets.splice(fromIndex, 1);
  if (fromIndex < toIndex) {
    toIndex -= 1;
  }
  widgets.splice(toIndex, 0, moved);
  renderDashboard();
  queueSave();
}

// ---------- Event handlers ----------
function handleGridClick(e) {
  const grid = document.getElementById("dashboard-grid");
  if (!grid || !dashboardState) return;

  const target = e.target;

  // Week navigation
  const weekBtn = target.closest(".todo-week-nav");
  if (weekBtn) {
    const direction = weekBtn.classList.contains("todo-week-prev") ? -1 : 1;
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
  const addTodoBtn = target.closest(".todo-add-btn");
  if (addTodoBtn) {
    const day = parseInt(addTodoBtn.dataset.day, 10);
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

  // Pomodoro buttons
  const pomBtn = target.closest("[data-pomodoro-action]");
  if (pomBtn) {
    const action = pomBtn.dataset.pomodoroAction;
    handlePomodoroAction(action);
    return;
  }

  const upcomingBtn = target.closest("[data-upcoming-action]");
  if (upcomingBtn) {
    handleUpcomingAction(upcomingBtn.dataset.upcomingAction, upcomingBtn.dataset.upcomingId);
    return;
  }

  const notesTab = target.closest(".notes-tab");
  if (notesTab) {
    const mode = notesTab.dataset.notesMode;
    if (mode && dashboardState.ui) {
      dashboardState.ui.notesMode = mode;
      renderDashboard();
      queueSave();
    }
    return;
  }

  const sizeBtn = target.closest(".widget-size-btn");
  if (sizeBtn) {
    toggleWidgetSpan(sizeBtn.dataset.widgetId);
    return;
  }

  const briefBtn = target.closest(".brief-action-btn");
  if (briefBtn) {
    handleBriefAction(briefBtn.dataset.briefAction);
    return;
  }

  // Widget remove (edit mode only)
  if (isEditMode) {
    if (target.classList.contains("widget-remove-btn")) {
      const id = target.dataset.widgetId;
      dashboardState.widgets = dashboardState.widgets.filter((w) => w.id !== id);
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

  if (target.classList.contains("habit-toggle")) {
    const habitId = target.dataset.habitId;
    const habits = dashboardState.habits || [];
    const habit = habits.find((h) => h.id === habitId);
    if (habit) {
      const wasDone = habit.doneToday;
      habit.doneToday = target.checked;
      if (!wasDone && habit.doneToday) {
        habit.streak = (habit.streak || 0) + 1;
      }
      if (wasDone && !habit.doneToday && habit.streak > 0) {
        habit.streak -= 1;
      }
      dashboardState.habits = habits;
      renderDashboard();
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
    fab.setAttribute("aria-pressed", isEditMode ? "true" : "false");
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
    span: getDefaultSpanForType(type),
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
  grid.addEventListener("dragstart", handleWidgetDragStart);
  grid.addEventListener("dragover", handleWidgetDragOver);
  grid.addEventListener("drop", handleWidgetDrop);
  grid.addEventListener("dragend", handleWidgetDragEnd);
  grid.addEventListener("submit", (e) => {
    if (e.target.closest("[data-upcoming-form]")) {
      handleUpcomingAddSubmit(e);
    }
    if (e.target.closest("[data-habit-form]")) {
      handleHabitAddSubmit(e);
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

  const dockAddBtn = document.getElementById("dock-bar-add");
  if (dockAddBtn) {
    dockAddBtn.addEventListener("click", () => toggleDockForm());
  }

  const dockForm = document.getElementById("dock-bar-form");
  if (dockForm) {
    dockForm.addEventListener("submit", handleDockBarSubmit);
  }

  const dockBar = document.getElementById("dock-bar");
  if (dockBar) {
    dockBar.addEventListener("click", handleDockBarClick);
    dockBar.addEventListener("keydown", handleDockBarKeydown);
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

