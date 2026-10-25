/* habit-tracker 习惯打卡
 * 纯前端实现：无依赖、无构建、无后端。
 * 数据结构（localStorage key: "habit-tracker:v1"）：
 * {
 *   habits:   [{ id, name, color, createdAt }],
 *   checkins: { [habitId]: ["YYYY-MM-DD", ...] }
 * }
 */
"use strict";

const STORAGE_KEY = "habit-tracker:v1";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PALETTE = ["#4f6ef7", "#10b981", "#f59e0b", "#e5484d", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316"];
const DEMO_HABITS = [
  { name: "喝水 8 杯", color: "#4f6ef7" },
  { name: "阅读 30 分钟", color: "#f59e0b" },
  { name: "运动 20 分钟", color: "#10b981" },
];

let state = null;                    // 全部数据
let view = { year: 2026, month: 0 }; // 月历当前查看的年月（month: 0-11），仅会话内有效
let editingId = null;                // 正在编辑的习惯 id（null = 新建）
let confirmResolve = null;           // 删除确认弹窗的 Promise resolve
let toastTimer = null;

/* ================= 工具 ================= */

const $ = (sel) => document.querySelector(sel);

function uid() {
  return (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : "id-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function fmt(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function addDays(date, n) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + n);
  return d;
}

function todayKey() { return fmt(new Date()); }

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
}

/* ================= 数据 ================= */

function looksLikeBackup(d) {
  return d && typeof d === "object"
    && Array.isArray(d.habits)
    && d.checkins && typeof d.checkins === "object";
}

/* 过滤并修正外部/历史数据，保证写入的状态总是可靠 */
function normalize(data) {
  const habits = [];
  const checkins = {};
  for (const h of data.habits) {
    if (!h || typeof h.id !== "string" || !h.id || typeof h.name !== "string" || !h.name.trim()) continue;
    if (habits.some((x) => x.id === h.id)) continue;
    habits.push({
      id: h.id,
      name: h.name.trim().slice(0, 60),
      color: /^#[0-9a-fA-F]{6}$/.test(h.color || "") ? h.color : PALETTE[habits.length % PALETTE.length],
      createdAt: typeof h.createdAt === "string" && DATE_RE.test(h.createdAt) ? h.createdAt : todayKey(),
    });
    const list = Array.isArray(data.checkins[h.id]) ? data.checkins[h.id] : [];
    checkins[h.id] = [...new Set(list.filter((k) => typeof k === "string" && DATE_RE.test(k)))];
  }
  return { habits, checkins };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (looksLikeBackup(parsed)) return normalize(parsed);
    }
  } catch (e) {
    console.warn("读取本地数据失败，改用示例数据：", e);
  }
  return seedDemo();
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    toast("保存失败：浏览器存储不可用");
    console.error(e);
  }
}

/* 首次使用时内置 3 个示例习惯，并附带最近 6 周的演示打卡记录（今天留空，等你来打） */
function seedDemo() {
  const s = { habits: [], checkins: {} };
  DEMO_HABITS.forEach((demo, i) => {
    const id = uid();
    s.habits.push({ id, name: demo.name, color: demo.color, createdAt: fmt(addDays(new Date(), -42)) });
    s.checkins[id] = demoDates(i);
  });
  return s;
}

function demoDates(habitIndex) {
  const dates = [];
  for (let i = 1; i <= 42; i++) {
    const dense = habitIndex === 0 && i <= 9;           // 第 1 个示例最近连续 9 天
    const sparse = (i * 7 + habitIndex * 3) % 10 >= 2;  // 其余约八成日期打卡，制造自然间隔
    if (dense || sparse) dates.push(fmt(addDays(new Date(), -i)));
  }
  return dates;
}

function commit() {
  saveState();
  render();
}

/* ================= 统计 ================= */

function datesOf(id) { return state.checkins[id] || []; }

/* 当前连续：若今天已打卡则从今天往回数，否则从昨天往回数 */
function currentStreak(keys) {
  const set = new Set(keys);
  let d = set.has(todayKey()) ? new Date() : addDays(new Date(), -1);
  let n = 0;
  while (set.has(fmt(d))) { n++; d = addDays(d, -1); }
  return n;
}

function longestStreak(keys) {
  const sorted = [...new Set(keys)].sort();
  let best = 0, cur = 0, prev = null;
  for (const key of sorted) {
    const d = parseKey(key);
    cur = prev && Math.round((d - prev) / 86400000) === 1 ? cur + 1 : 1;
    if (cur > best) best = cur;
    prev = d;
  }
  return best;
}

/* ================= 渲染 ================= */

function render() {
  const d = new Date();
  $("#todayLabel").textContent =
    `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 · 星期${"日一二三四五六"[d.getDay()]}`;
  $("#monthLabel").textContent = `${view.year} 年 ${view.month + 1} 月`;

  const t = todayKey();
  const total = state.habits.length;
  const done = state.habits.filter((h) => datesOf(h.id).includes(t)).length;
  $("#todayProgress").textContent = `${done}/${total}`;
  $("#todayProgressBar").style.width = total ? `${(done / total) * 100}%` : "0%";

  $("#habitGrid").innerHTML = state.habits.map(habitCardHTML).join("");
  $("#emptyState").hidden = total > 0;
}

function habitCardHTML(h) {
  const keys = datesOf(h.id);
  const set = new Set(keys);
  const done = set.has(todayKey());
  return `
  <article class="habit-card" data-id="${h.id}" style="--accent:${h.color}">
    <div class="habit-head">
      <span class="dot"></span>
      <h3 class="habit-name">${esc(h.name)}</h3>
      <button class="icon-btn" data-action="edit" type="button" title="编辑" aria-label="编辑">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
      </button>
      <button class="icon-btn" data-action="delete" type="button" title="删除" aria-label="删除">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
      </button>
    </div>
    <div class="stats">
      <div class="stat"><b>${currentStreak(keys)}</b><span>当前连续(天)</span></div>
      <div class="stat"><b>${longestStreak(keys)}</b><span>最长连续(天)</span></div>
      <div class="stat"><b>${keys.length}</b><span>累计打卡(次)</span></div>
    </div>
    <button class="check-btn${done ? " checked" : ""}" data-action="toggle" type="button">
      ${done ? "✓ 今日已打卡" : "打卡"}
    </button>
    <div class="cal-week">${["一", "二", "三", "四", "五", "六", "日"].map((d) => `<span>${d}</span>`).join("")}</div>
    <div class="cal-grid">${calendarCellsHTML(set)}</div>
    <div class="cal-foot">本月打卡 <b>${monthCount(set)}</b> 天 · 点击日期可补打卡/取消</div>
  </article>`;
}

function calendarCellsHTML(set) {
  const { year, month } = view;
  const offset = (new Date(year, month, 1).getDay() + 6) % 7; // 周一为第一列
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const t = todayKey();
  let html = "";
  for (let i = 0; i < offset; i++) html += `<span class="cal-day empty"></span>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const key = fmt(new Date(year, month, d));
    const isFuture = key > t;
    const cls = ["cal-day"];
    if (set.has(key)) cls.push("done");
    if (key === t) cls.push("today");
    if (isFuture) cls.push("future");
    html += `<button type="button" class="${cls.join(" ")}" data-action="day" data-date="${key}"
      ${isFuture ? "disabled" : ""} title="${key}${set.has(key) ? " 已打卡" : ""}">${d}</button>`;
  }
  return html;
}

function monthCount(set) {
  const prefix = `${view.year}-${String(view.month + 1).padStart(2, "0")}`;
  let n = 0;
  for (const k of set) if (k.startsWith(prefix)) n++;
  return n;
}

/* ================= 弹窗 ================= */

function openModal(id) {
  $("#" + id).classList.add("open");
  document.body.classList.add("modal-open");
}

function closeModal() {
  const open = document.querySelector(".modal.open");
  if (!open) return;
  open.classList.remove("open");
  document.body.classList.remove("modal-open");
  if (open.id === "confirmModal" && confirmResolve) {
    const r = confirmResolve;
    confirmResolve = null;
    r(false);
  }
}

document.querySelectorAll(".modal").forEach((m) => {
  m.addEventListener("click", (e) => {
    if (e.target === m || e.target.closest("[data-close]")) closeModal();
  });
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

$("#confirmOk").addEventListener("click", () => {
  const r = confirmResolve;
  confirmResolve = null;
  closeModal();
  if (r) r(true);
});

function confirmModal(message) {
  return new Promise((resolve) => {
    $("#confirmText").textContent = message;
    confirmResolve = resolve;
    openModal("confirmModal");
  });
}

/* ================= 操作 ================= */

function toggleCheckin(habitId, key) {
  const list = state.checkins[habitId] || (state.checkins[habitId] = []);
  const i = list.indexOf(key);
  if (i >= 0) list.splice(i, 1);
  else list.push(key);
  commit();
}

async function onDelete(habitId) {
  const h = state.habits.find((x) => x.id === habitId);
  if (!h) return;
  const ok = await confirmModal(`确定删除「${h.name}」？该习惯的全部打卡记录将一并删除。`);
  if (!ok) return;
  state.habits = state.habits.filter((x) => x.id !== habitId);
  delete state.checkins[habitId];
  commit();
  toast("已删除习惯");
}

$("#habitGrid").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn || btn.disabled) return;
  const card = btn.closest(".habit-card");
  if (!card) return;
  const id = card.dataset.id;
  switch (btn.dataset.action) {
    case "toggle": toggleCheckin(id, todayKey()); break;
    case "day": toggleCheckin(id, btn.dataset.date); break;
    case "edit": openHabitModal(id); break;
    case "delete": onDelete(id); break;
  }
});

/* ---------- 新建 / 编辑习惯 ---------- */

$("#btnAdd").addEventListener("click", () => openHabitModal(null));

function openHabitModal(id) {
  editingId = id;
  const h = id ? state.habits.find((x) => x.id === id) : null;
  $("#habitModalTitle").textContent = h ? "编辑习惯" : "新建习惯";
  $("#habitNameInput").value = h ? h.name : "";
  renderSwatches(h ? h.color : PALETTE[0]);
  openModal("habitModal");
  setTimeout(() => $("#habitNameInput").focus(), 30);
}

function renderSwatches(selected) {
  $("#colorSwatches").innerHTML = PALETTE.map((c) =>
    `<button type="button" class="swatch${c === selected ? " selected" : ""}" data-color="${c}" style="--c:${c}" aria-label="颜色 ${c}"></button>`
  ).join("");
}

$("#colorSwatches").addEventListener("click", (e) => {
  const b = e.target.closest(".swatch");
  if (b) renderSwatches(b.dataset.color);
});

$("#habitForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("#habitNameInput").value.trim();
  if (!name) { toast("请先填写习惯名称"); return; }
  const sel = document.querySelector("#colorSwatches .selected");
  const color = sel ? sel.dataset.color : PALETTE[0];
  if (editingId) {
    const h = state.habits.find((x) => x.id === editingId);
    if (h) { h.name = name; h.color = color; }
    toast("已保存修改");
  } else {
    const id = uid();
    state.habits.push({ id, name, color, createdAt: todayKey() });
    state.checkins[id] = [];
    toast("已添加习惯");
  }
  commit();
  closeModal();
});

/* ---------- 月历翻页 ---------- */

function shiftMonth(n) {
  let m = view.month + n, y = view.year;
  if (m < 0) { m = 11; y--; }
  if (m > 11) { m = 0; y++; }
  view = { year: y, month: m };
  render();
}
$("#prevMonth").addEventListener("click", () => shiftMonth(-1));
$("#nextMonth").addEventListener("click", () => shiftMonth(1));
$("#nowMonth").addEventListener("click", () => {
  const n = new Date();
  view = { year: n.getFullYear(), month: n.getMonth() };
  render();
});

/* ---------- 导出 ---------- */

$("#btnExport").addEventListener("click", () => {
  $("#exportTextarea").value = JSON.stringify(state, null, 2);
  openModal("exportModal");
});

$("#btnCopyExport").addEventListener("click", async () => {
  const ta = $("#exportTextarea");
  ta.select();
  try {
    await navigator.clipboard.writeText(ta.value);
    toast("已复制到剪贴板");
  } catch {
    document.execCommand("copy");
    toast("已复制到剪贴板");
  }
});

$("#btnDownloadExport").addEventListener("click", () => {
  const blob = new Blob([$("#exportTextarea").value], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `habit-tracker-backup-${todayKey()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("已开始下载");
});

/* ---------- 导入 ---------- */

$("#btnImport").addEventListener("click", () => {
  $("#importTextarea").value = "";
  $("#importFile").value = "";
  $("#importMsg").textContent = "";
  openModal("importModal");
});

$("#importFile").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => { $("#importTextarea").value = reader.result; };
  reader.readAsText(f);
});

$("#btnDoImport").addEventListener("click", () => {
  const raw = $("#importTextarea").value.trim();
  if (!raw) { $("#importMsg").textContent = "请先粘贴 JSON 或选择备份文件"; return; }
  try {
    const data = JSON.parse(raw);
    if (!looksLikeBackup(data)) throw new Error("结构不符");
    state = normalize(data);
    commit();
    closeModal();
    toast(`导入成功：共 ${state.habits.length} 个习惯`);
  } catch {
    $("#importMsg").textContent = "导入失败：内容不是有效的备份数据（需包含 habits 与 checkins）";
  }
});

/* ---------- 空状态 ---------- */

$("#btnRestoreDemo").addEventListener("click", () => {
  state = seedDemo();
  commit();
  toast("已恢复示例习惯");
});

/* ================= 启动 ================= */

function init() {
  const now = new Date();
  view = { year: now.getFullYear(), month: now.getMonth() };
  state = loadState();
  commit();
}

init();
