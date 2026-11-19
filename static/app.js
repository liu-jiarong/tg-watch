"use strict";

const $ = (id) => document.getElementById(id);
const topbar = $("topbar");
const list = $("log-list");
const dialog = $("rules-dialog");
const ruleForm = $("rule-form");
const ruleValue = $("rule-value");
const ruleNote = $("rule-note");
const tabs = [...document.querySelectorAll(".tab")];
const toastEl = $("toast");

const EDGE_DISTANCE = 900; // 距离顶部或底部多少像素时自动加载下一页
const POLL_INTERVAL = 30_000; // 只刷新状态和未读数，不打断阅读
const READ_DELAY = 1000; // 阅读位置最多每秒保存一次
const APP_TITLE = document.title;
const finePointer = matchMedia("(pointer: fine)");

const KINDS = {
  watch: {
    name: "关注词",
    hint: "消息包含任一关注词就会被记录。纯数字按完整数字匹配，例如 36 不会命中 136；区分大小写。用逗号分隔可一次添加多个。",
    placeholder: "输入关注词，回车添加",
  },
  ignore: {
    name: "屏蔽词",
    hint: "消息包含任一屏蔽词就不记录，优先级高于关注词和关注用户。用逗号分隔可一次添加多个。",
    placeholder: "输入屏蔽词，回车添加",
  },
  user: {
    name: "关注用户",
    hint: "这些用户的消息即使不含关注词也会记录（仍受屏蔽词和屏蔽用户约束）。只能填数字 ID，点击消息上的发送者可快速填入。",
    placeholder: "数字 ID",
    byId: true,
  },
  block: {
    name: "屏蔽用户",
    hint: "这些用户的消息一律不记录，优先级最高，命中关注词或同时被关注也不例外。只能填数字 ID；点击消息上的发送者填入后，切换到这里添加即可。",
    placeholder: "数字 ID",
    byId: true,
  },
};

const state = {
  ready: false,
  viewError: "",
  offline: "",
  busy: null,
  errors: {},
  firstId: 0,
  lastId: 0,
  hasOlder: false,
  latestId: 0,
  tag: null,
  dividerId: 0,
  monitor: null,
  rules: { watch: [], ignore: [], user: [], block: [] },
  kind: "watch",
};
const items = new Map();
let highlight = null;

const divider = h("div", "read-divider", "上次读到这里");
divider.setAttribute("role", "separator");

function h(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

async function api(path, { method = "GET", body, keepalive = false } = {}) {
  try {
    const response = await fetch(path, {
      method,
      cache: "no-store",
      keepalive,
      signal: AbortSignal.timeout(15000),
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401 && path !== "api/login") showLogin();
      throw new Error(typeof data?.detail === "string" ? data.detail : `请求失败（${response.status}）`);
    }
    return data;
  } catch (error) {
    if (error.name === "TimeoutError") throw new Error("请求超时，请稍后重试。");
    if (error instanceof TypeError) throw new Error("无法连接服务，请确认服务仍在运行。");
    throw error;
  }
}

// ---- 提示 ----

let toastTimer;
function toast(message, { tone = "", action, onAction } = {}) {
  clearTimeout(toastTimer);
  // 模态对话框位于顶层，提示需要放进对话框里才能显示在上方。
  (dialog.open ? dialog : document.body).append(toastEl);
  toastEl.replaceChildren(h("span", "", message));
  toastEl.dataset.tone = tone;
  if (action) {
    const button = h("button", "toast-action", action);
    button.type = "button";
    button.addEventListener("click", () => { toastEl.hidden = true; onAction(); }, { once: true });
    toastEl.append(button);
  }
  toastEl.hidden = false;
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, action ? 6000 : 2800);
}

// ---- 规则匹配（与服务端 chat.py 的 contains_keyword 保持一致） ----

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileRules() {
  const words = state.rules.watch.map((rule) => rule.value).sort((a, b) => b.length - a.length);
  highlight = words.length
    ? new RegExp(words.map((word) => (/^\p{Nd}+$/u.test(word)
      ? `(?<!\\p{Nd})${escapeRegExp(word)}(?!\\p{Nd})`
      : escapeRegExp(word))).join("|"), "gu")
    : null;
}

// 关注用户或屏蔽用户中与这条消息发送者匹配的规则。
function userRules(kind, item) {
  return state.rules[kind].filter((rule) => Number(rule.value) === item.sender_id);
}

// ---- 消息渲染 ----

// 服务端存带时区的 ISO 时间，这里统一按北京时间显示；今年的消息省略年份。
const beijingTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});

function timeParts(date) {
  return Object.fromEntries(beijingTime.formatToParts(date).map(({ type, value }) => [type, value]));
}

const currentYear = timeParts(new Date()).year;

function formatTime(value, full = false) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "—";
  const p = timeParts(date);
  const time = `${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  return full || p.year !== currentYear ? `${p.year}-${time}` : time;
}

function renderEntry(item) {
  items.set(item.id, item);
  const article = h("article", "entry");
  article.id = `log-${item.id}`;
  article.dataset.id = item.id;
  if (item.id > readId()) article.classList.add("is-unread");
  const meta = h("div", "entry-meta");
  const sender = h("button", "sender", item.sender);
  sender.type = "button";
  const group = h("span", "group", item.group_name);
  group.dataset.tone = [...item.group_name].reduce((sum, char) => sum + char.codePointAt(0), 0) % 5;
  meta.append(sender, group);
  const edited = item.action === "EDIT";
  if (edited) meta.append(h("span", "edited", "已编辑"));
  const time = h("time", "time", formatTime(edited ? item.edited_at : item.sent_at));
  time.dateTime = edited ? item.edited_at ?? "" : item.sent_at;
  time.title = `发送于 ${formatTime(item.sent_at, true)}`
    + (edited ? ` · 编辑于 ${formatTime(item.edited_at, true)}` : "");
  meta.append(time);
  article.append(meta, h("div", "text"));
  paint(article, item);
  return article;
}

// 按当前规则绘制关注词高亮和关注、屏蔽用户标记，规则变化时对已加载的消息重绘。
// 屏蔽只影响之后收到的消息，已记录的消息仍然显示，只是标为已屏蔽。
function paint(article, item) {
  const text = article.querySelector(".text");
  text.replaceChildren();
  let end = 0;
  for (const match of highlight ? item.text.matchAll(highlight) : []) {
    text.append(item.text.slice(end, match.index), h("mark", "", match[0]));
    end = match.index + match[0].length;
  }
  text.append(item.text.slice(end));
  const followed = userRules("user", item).length > 0;
  const blocked = userRules("block", item).length > 0;
  article.classList.toggle("is-followed", followed);
  article.classList.toggle("is-blocked", blocked);
  article.querySelector(".sender").title = blocked ? "已屏蔽，点击查看"
    : followed ? "已关注，点击查看" : "点击关注或屏蔽此用户";
}

function readId() {
  return state.tag?.log_id ?? 0;
}

// 日志 id 只增不减，已知的最新 id 大于已加载的最后一条，就说明还有更新的记录。
function hasNewer() {
  return state.latestId > state.lastId;
}

// 分隔线标在打开页面时的阅读位置，阅读过程中不随 Tag 前进而移动。
function placeDivider() {
  const entry = state.dividerId && $(`log-${state.dividerId}`);
  if (entry && state.lastId > state.dividerId) {
    if (entry.nextElementSibling !== divider) entry.after(divider);
  } else {
    divider.remove();
  }
}

// 列表从上到下排列，二分查找第一个底边低于 y 的元素下标。
function firstBelow(y) {
  const children = list.children;
  let low = 0;
  let high = children.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (children[middle].getBoundingClientRect().bottom > y) high = middle;
    else low = middle + 1;
  }
  return low;
}

// 插入内容或窗口宽度变化时，以视窗内第一条消息为锚点保持位置，避免阅读被打断。
function captureAnchor() {
  let entry = list.children[firstBelow(topbar.getBoundingClientRect().bottom)];
  if (entry === divider) entry = divider.nextElementSibling || divider.previousElementSibling;
  return entry ? { entry, top: entry.getBoundingClientRect().top } : null;
}

// 位置没变时不调用 scrollBy：手机上任何程序滚动都会打断正在进行的惯性滚动。
function restoreAnchor(anchor) {
  if (!anchor?.entry.isConnected) return;
  const delta = anchor.entry.getBoundingClientRect().top - anchor.top;
  if (Math.abs(delta) >= 1) window.scrollBy(0, delta);
}

function keepPosition(change) {
  const anchor = captureAnchor();
  change();
  restoreAnchor(anchor);
}

// ---- 界面状态 ----

function renderEdge(element, direction) {
  element.replaceChildren();
  if (!state.ready) return;
  const older = direction === "older";
  if (state.busy === direction) {
    element.append(h("span", "", "正在加载…"));
  } else if (state.errors[direction]) {
    const retry = h("button", "link-btn", "加载失败，点击重试");
    retry.type = "button";
    retry.title = state.errors[direction];
    retry.addEventListener("click", () => {
      delete state.errors[direction];
      (older ? loadOlder : loadNewer)();
    });
    element.append(retry);
  } else if (items.size && !(older ? state.hasOlder : hasNewer())) {
    // 列表为空时由空状态说明；还有更多时滚动到附近会自动加载，不需要按钮。
    element.append(h("span", "", older ? "已到第一条记录" : "已到最新记录"));
  }
}

function renderEmpty() {
  const empty = $("empty");
  empty.replaceChildren();
  if (state.viewError) {
    const retry = h("button", "btn", "重新读取");
    retry.type = "button";
    retry.addEventListener("click", start);
    empty.append(h("strong", "", "读取失败"), state.viewError, h("br"), retry);
  } else if (!state.ready) {
    empty.append("正在读取消息…");
  } else if (!items.size) {
    empty.append(h("strong", "", "还没有记录"), "命中关注词或来自关注用户的新消息会出现在这里。");
  }
  empty.hidden = !empty.childNodes.length;
}

// 只在出错时用提示条说明原因：服务离线、日志保存失败、监听停止或部分群未能监听。
function renderNotice() {
  const messages = [state.offline, state.monitor?.storage_error, state.monitor?.detail];
  const notice = $("notice");
  notice.textContent = messages.filter(Boolean).join("\n\n");
  notice.hidden = !notice.textContent;
}

function updateControls() {
  const unread = Math.max(0, state.latestId - readId());
  document.title = unread ? `(${unread}) ${APP_TITLE}` : APP_TITLE;
  $("reader").setAttribute("aria-busy", String(Boolean(state.busy) || !state.ready));
  renderEdge($("edge-older"), "older");
  renderEdge($("edge-newer"), "newer");
  renderEmpty();
  renderNotice();
}

// ---- 加载 ----

// 同一时间只进行一项加载，忙碌时直接跳过；结束后 afterLayout 会按滚动位置补上需要的加载。
async function exclusive(kind, task) {
  if (state.busy) return;
  state.busy = kind;
  updateControls();
  try {
    await task();
  } finally {
    state.busy = null;
    updateControls();
    requestAnimationFrame(afterLayout);
  }
}

// 只在打开页面时调用一次：回到上次阅读位置，从 Tag 之后的新消息继续看。
// 最新 id 只来自状态接口：打开页面前和每次轮询都会刷新，后续加载按它判断是否还有更新的记录。
async function showView() {
  const anchor = readId();
  let page;
  try {
    page = await api(anchor ? `api/logs?anchor=${anchor}` : "api/logs");
  } catch (error) {
    state.viewError = error.message;
    return;
  }
  list.replaceChildren(...page.items.map(renderEntry));
  state.firstId = page.items[0]?.id ?? 0;
  state.lastId = page.items.at(-1)?.id ?? 0;
  state.hasOlder = page.has_older;
  state.ready = true;
  state.dividerId = anchor;
  placeDivider();
  updateControls();

  if (divider.isConnected) {
    const offset = divider.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, offset - topbar.offsetHeight - 120);
  } else {
    window.scrollTo(0, document.documentElement.scrollHeight);
  }
}

function loadOlder() {
  return exclusive("older", async () => {
    try {
      const page = await api(`api/logs?before=${state.firstId}`);
      keepPosition(() => {
        list.prepend(...page.items.map(renderEntry));
        if (page.items.length) state.firstId = page.items[0].id;
        state.hasOlder = page.has_older;
        placeDivider();
      });
      delete state.errors.older;
    } catch (error) {
      state.errors.older = error.message;
    }
  });
}

function loadNewer() {
  return exclusive("newer", async () => {
    // 打开时列表为空，说明当时还没有任何记录，lastId 为 0 时从第一条开始读。
    try {
      const page = await api(`api/logs?after=${state.lastId}`);
      keepPosition(() => {
        list.append(...page.items.map(renderEntry));
        if (page.items.length) state.lastId = page.items.at(-1).id;
        placeDivider();
      });
      delete state.errors.newer;
    } catch (error) {
      state.errors.newer = error.message;
    }
  });
}

function checkEdges() {
  if (!state.ready || state.busy || dialog.open) return;
  const top = window.scrollY;
  const bottom = document.documentElement.scrollHeight - window.innerHeight - top;
  if (state.hasOlder && !state.errors.older && top < EDGE_DISTANCE) loadOlder();
  else if (hasNewer() && !state.errors.newer && bottom < EDGE_DISTANCE) loadNewer();
}

// 滚动、尺寸变化或内容加载后：按需加载下一页，并记录读到的位置。
function afterLayout() {
  checkEdges();
  trackRead();
}

// ---- 阅读 Tag ----

// 阅读位置只前进：轮询结果可能早于本机刚保存的位置，其他设备读得更靠后时则同步过来。
// 未读标记的边界就是当前 Tag，Tag 越过的消息去掉标记。
function setTag(tag) {
  if ((tag?.log_id ?? 0) <= readId()) return;
  state.tag = tag;
  for (const entry of list.querySelectorAll(".entry.is-unread")) {
    if (Number(entry.dataset.id) <= tag.log_id) entry.classList.remove("is-unread");
  }
  updateControls();
}

// 底边已进入视窗（完整显示过或已滚过）的最后一条消息，即读到的位置。
function lastSeenId() {
  if (document.body.classList.contains("locked")) return 0;
  let entry = list.children[firstBelow(window.innerHeight) - 1];
  if (entry === divider) entry = divider.previousElementSibling;
  return entry ? Number(entry.dataset.id) : 0;
}

let readTimer = null;
let readSaving = false;

// 窗口可见但焦点在别的程序时不记录，避免轮询自动加载的新消息被当作已读。
function trackRead() {
  if (readTimer || readSaving || !state.ready) return;
  if (document.visibilityState !== "visible" || !document.hasFocus()) return;
  if (lastSeenId() > readId()) readTimer = setTimeout(saveRead, READ_DELAY);
}

// 使用 keepalive，切走或关闭页面时发出的保存请求不会随页面卸载被取消。
async function saveRead() {
  clearTimeout(readTimer);
  readTimer = null;
  const logId = lastSeenId();
  if (logId <= readId()) return;
  readSaving = true;
  try {
    setTag(await api("api/tag", { method: "PUT", body: { log_id: logId }, keepalive: true }));
  } catch {
    // 不立即重试，下次滚动、加载或轮询后会再保存；服务离线时轮询会给出提示。
    return;
  } finally {
    readSaving = false;
  }
  trackRead(); // 保存期间可能又往下读了
}

// ---- 状态轮询 ----

// 轮询拿到的规则没变时跳过重绘，避免打断正在进行的文字选择。
function applyRules(rules) {
  if (JSON.stringify(rules) === JSON.stringify(state.rules)) return;
  state.rules = rules;
  compileRules();
  keepPosition(() => {
    for (const article of list.querySelectorAll(".entry")) {
      paint(article, items.get(Number(article.dataset.id)));
    }
  });
  renderRules();
}

function applyStatus(status) {
  state.offline = "";
  state.monitor = status.monitor;
  state.latestId = Math.max(state.latestId, status.latest_id);
  applyRules(status.rules);
  setTag(status.tag);
}

async function refreshStatus() {
  try {
    applyStatus(await api("api/status"));
  } catch (error) {
    state.offline = error.message;
  }
  updateControls();
  afterLayout(); // 顺带重试上次失败的阅读位置保存
}

let pollTimer;
function schedulePoll() {
  clearTimeout(pollTimer);
  // 已切到登录界面时不再轮询，登录成功后页面会重新加载。
  if (document.body.classList.contains("locked")) return;
  pollTimer = setTimeout(async () => {
    if (document.visibilityState === "visible") await refreshStatus();
    schedulePoll();
  }, POLL_INTERVAL);
}

// ---- 规则面板 ----

function selectKind(kind) {
  state.kind = kind;
  for (const tab of tabs) {
    const selected = tab.dataset.kind === kind;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  $("rule-hint").textContent = KINDS[kind].hint;
  ruleValue.placeholder = KINDS[kind].placeholder;
  ruleNote.hidden = !KINDS[kind].byId;
  renderRules();
}

function renderRule(rule) {
  const kind = state.kind;
  let element;
  if (KINDS[kind].byId) {
    element = h("li", "user-row");
    const info = h("div", "user-info");
    info.append(h("span", "user-name", rule.note || rule.value), h("span", "user-sub", rule.note ? `ID ${rule.value}` : "ID"));
    element.append(info);
  } else {
    element = h("li", "chip");
    element.append(h("span", "chip-text", rule.value));
  }
  element.dataset.id = rule.id;
  element.title = rule.note ? `${rule.value}（${rule.note}）` : rule.value;
  const remove = h("button", "remove", "×");
  remove.type = "button";
  remove.dataset.remove = rule.id;
  remove.setAttribute("aria-label", `删除${KINDS[kind].name}「${rule.note || rule.value}」`);
  element.append(remove);
  return element;
}

function renderRules() {
  for (const tab of tabs) tab.querySelector(".n").textContent = state.rules[tab.dataset.kind].length;
  const rules = state.rules[state.kind];
  const container = $("rule-list");
  container.dataset.kind = state.kind;
  container.replaceChildren(...rules.map(renderRule));
  container.hidden = !rules.length;
  const empty = $("rule-empty");
  empty.hidden = rules.length > 0;
  empty.textContent = `还没有${KINDS[state.kind].name}`;
}

function openRules(kind = state.kind, prefill = null) {
  selectKind(kind);
  if (prefill) {
    ruleValue.value = prefill.value;
    ruleNote.value = prefill.note || "";
  }
  if (!dialog.open) dialog.showModal();
  if (prefill || finePointer.matches) ruleValue.focus();
  else dialog.querySelector(`.tab[data-kind="${kind}"]`).focus();
}

function flashRules(ids) {
  requestAnimationFrame(() => {
    for (const id of ids) {
      const element = $("rule-list").querySelector(`[data-id="${id}"]`);
      if (!element) continue;
      element.scrollIntoView({ block: "nearest" });
      element.classList.remove("is-flash");
      void element.offsetWidth;
      element.classList.add("is-flash");
    }
  });
}

async function postRules(kind, values, note = "") {
  const result = await api("api/rules", { method: "POST", body: { kind, values, note } });
  applyRules(result.rules);
  return result;
}

async function submitRule(event) {
  event.preventDefault();
  const kind = state.kind;
  const raw = ruleValue.value;
  const { byId } = KINDS[kind];
  const values = (byId ? [raw] : raw.split(/[,，、;；]+/)).map((value) => value.trim()).filter(Boolean);
  if (!values.length) {
    ruleValue.focus();
    return;
  }
  const submit = ruleForm.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const result = await postRules(kind, values, byId ? ruleNote.value : "");
    ruleValue.value = "";
    ruleNote.value = "";
    if (!result.added) toast(`${KINDS[kind].name}已存在`);
    const added = new Set(values);
    flashRules(state.rules[kind].filter((rule) => added.has(rule.value)).map((rule) => rule.id));
  } catch (error) {
    toast(error.message, { tone: "error" });
  } finally {
    submit.disabled = false;
    if (finePointer.matches) ruleValue.focus();
  }
}

async function removeRule(button) {
  const kind = state.kind;
  const id = Number(button.dataset.remove);
  const rule = state.rules[kind].find((item) => item.id === id);
  button.disabled = true;
  try {
    const result = await api(`api/rules/${id}`, { method: "DELETE" });
    applyRules(result.rules);
    toast(`已删除${KINDS[kind].name}「${rule.note || rule.value}」`, {
      action: "撤销",
      onAction: () => postRules(kind, [rule.value], rule.note).catch((error) => toast(error.message, { tone: "error" })),
    });
  } catch (error) {
    button.disabled = false;
    toast(error.message, { tone: "error" });
  }
}

// ---- 事件 ----

let scrollScheduled = false;
let readingAnchor = null;
window.addEventListener("scroll", () => {
  if (scrollScheduled) return;
  scrollScheduled = true;
  requestAnimationFrame(() => {
    scrollScheduled = false;
    readingAnchor = captureAnchor();
    afterLayout();
  });
});
// 手机上地址栏随滚动收起或展开时也会触发 resize，但只改变视窗高度，消息不会重新排版。
// 这时手指往往还在滑动，锚点是上一帧记下的，恢复它会把刚滚过的距离拉回去并打断惯性滚动，
// 所以只在宽度变化（旋转屏幕、调整窗口宽度）导致重新排版时才恢复。
let layoutWidth = document.documentElement.clientWidth;
window.addEventListener("resize", () => {
  const width = document.documentElement.clientWidth;
  if (width !== layoutWidth) {
    layoutWidth = width;
    restoreAnchor(readingAnchor);
  }
  afterLayout();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") {
    // 切走或关闭页面时立即保存，不等节流计时。
    if (readTimer) saveRead();
    return;
  }
  if (!state.ready || document.body.classList.contains("locked")) return;
  refreshStatus(); // 结束时会记录阅读位置
  schedulePoll();
});
window.addEventListener("focus", trackRead);
window.addEventListener("blur", () => {
  // 失去焦点时立即保存已看到的位置，之后自动加载的消息不再计入。
  if (readTimer) saveRead();
});

$("open-rules").addEventListener("click", () => openRules());

list.addEventListener("click", (event) => {
  const sender = event.target.closest(".sender");
  if (!sender) return;
  const item = items.get(Number(sender.closest(".entry").dataset.id));
  // 屏蔽优先于关注，两者都有时定位到屏蔽用户。
  for (const kind of ["block", "user"]) {
    const matched = userRules(kind, item);
    if (!matched.length) continue;
    openRules(kind);
    flashRules(matched.map((rule) => rule.id));
    toast(`已${kind === "block" ? "屏蔽" : "关注"}「${item.sender}」`);
    return;
  }
  if (item.sender_id == null) {
    toast("这条消息没有发送者 ID，无法关注或屏蔽。", { tone: "error" });
  } else {
    // 填入后可直接关注，也可切换到“屏蔽用户”添加，切换标签不会清空输入。
    openRules("user", { value: String(item.sender_id), note: item.sender });
  }
});

tabs.forEach((tab, index) => {
  tab.addEventListener("click", () => selectKind(tab.dataset.kind));
  tab.addEventListener("keydown", (event) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    const next = tabs[(index + step + tabs.length) % tabs.length];
    selectKind(next.dataset.kind);
    next.focus();
  });
});
ruleForm.addEventListener("submit", submitRule);
// 单行输入框粘贴多行文本时会丢掉换行，先转成逗号以便批量添加。
ruleValue.addEventListener("paste", (event) => {
  const text = event.clipboardData.getData("text");
  if (KINDS[state.kind].byId || !/[\r\n]/.test(text)) return;
  event.preventDefault();
  const joined = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join("，");
  ruleValue.setRangeText(joined, ruleValue.selectionStart, ruleValue.selectionEnd, "end");
});
$("rule-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove]");
  if (button) removeRule(button);
});
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});
dialog.addEventListener("close", () => {
  if (toastEl.parentElement === dialog) document.body.append(toastEl);
  requestAnimationFrame(checkEdges);
});

// ---- 登录 ----

// 任一接口返回 401（未登录、登录过期或密码已修改）时切换到登录界面。
function showLogin() {
  if (document.body.classList.contains("locked")) return;
  clearTimeout(pollTimer);
  if (dialog.open) dialog.close();
  document.body.classList.add("locked");
  $("login").hidden = false;
  $("login-password").focus();
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("login-password");
  const error = $("login-error");
  const submit = event.currentTarget.querySelector('[type="submit"]');
  submit.disabled = true;
  error.hidden = true;
  try {
    await api("api/login", { method: "POST", body: { password: input.value } });
    location.reload();
  } catch (failure) {
    error.textContent = failure.message;
    error.hidden = false;
    submit.disabled = false;
    input.select();
  }
});

// ---- 启动 ----

async function start() {
  state.viewError = "";
  updateControls();
  try {
    applyStatus(await api("api/status"));
  } catch (error) {
    state.viewError = error.message;
    updateControls();
    return;
  }
  await exclusive("view", showView);
  schedulePoll();
}

selectKind("watch");
start();
