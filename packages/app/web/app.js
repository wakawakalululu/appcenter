const el = (id) => document.getElementById(id);
const BS = String.fromCharCode(92);

const state = {
  entries: [],
  byId: new Map(),
  jobs: new Map(),
  restoreDir: "",
  skins: [],
  categories: [],
  activeCategory: "",
  source: "home",
  selfUpdate: null,
  staged: null,
  bundleRun: null,
};

const JOB_LABEL = {
  queued: "排队中",
  downloading: "下载中",
  verifying: "校验中",
  installing: "安装中",
  awaiting_approval: "等待审批",
  succeeded: "已完成",
  needs_reboot: "待重启",
  failed: "失败",
  cancelled: "已取消",
};

/** 整包进度面板：只在有点过"一键装机"之后出现，随任务事件刷新。 */
async function refreshBundleProgress() {
  if (!state.bundleRun) return;
  const progress = await rpc("bundle.progress", { runId: state.bundleRun.id });
  if (!progress) return;
  el("bundle-progress").hidden = false;
  el("bundle-title").textContent = "捆绑安装 · " + progress.run.title;
  el("bundle-meta").textContent =
    String(progress.done) + " 已完成 · " + String(progress.running) + " 进行中 · " + String(progress.failed) + " 失败" +
    (progress.awaitingApproval ? " · " + String(progress.awaitingApproval) + " 待审批" : "") +
    (progress.run.skipped.length ? " · " + String(progress.run.skipped.length) + " 已是最新" : "") +
    (progress.run.unknown.length ? " · " + String(progress.run.unknown.length) + " 已下架" : "");
  const bar = el("bundle-bar");
  bar.setAttribute("aria-valuenow", String(progress.percent));
  if (bar.firstElementChild) bar.firstElementChild.style.width = String(progress.percent) + "%";
  el("bundle-list").innerHTML = progress.jobs
    .map((job) => "<li><span>" + safe(job.appName) + '</span><span class="job-state">' + safe(JOB_LABEL[job.state] ?? job.state) + "</span></li>")
    .join("");
}

/** 内联 SVG 图标库：UI 里禁止 emoji/字符图形，动态渲染一律取自这里（静态结构里的图标直接写在 index.html）。 */
const ICONS = {
  search: '<svg viewBox="0 0 16 16" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.4"/><path d="m13.5 13.5-3.2-3.2"/></svg>',
  upgrade: '<svg viewBox="0 0 16 16" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 13V3.5M4.5 6.5 8 3l3.5 3.5M3 13.5h10"/></svg>',
  grid: '<svg viewBox="0 0 16 16" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="2" y="2" width="5" height="5" rx="1.2"/><rect x="9" y="2" width="5" height="5" rx="1.2"/><rect x="2" y="9" width="5" height="5" rx="1.2"/><rect x="9" y="9" width="5" height="5" rx="1.2"/></svg>',
  download: '<svg viewBox="0 0 16 16" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.5v7M5 7l3 3 3-3M2.5 11v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2"/></svg>',
  star: '<svg viewBox="0 0 16 16" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.8 9.9 5.6l4.2.6-3 3 .7 4.2L8 11.4l-3.8 2 .7-4.2-3-3 4.2-.6L8 1.8Z"/></svg>',
};

const STAR_SVG =
  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 1.6 9.9 5.5l4.3.6-3.1 3 .7 4.3L8 11.4l-3.8 2 .7-4.3-3.1-3 4.3-.6L8 1.6Z"/></svg>';

/** 检查结果的中文语义，避免把状态机原样丢给用户。 */
function selfUpdateLabel(result) {
  if (result.state === "available") return "发现 v" + result.version + (result.mandatory ? " · 强制升级，必须完成才能继续使用" : " · 可升级");
  if (result.state === "too-old") return "v" + result.version + " 要求当前版本不低于 v" + result.required + "，请先走全量安装";
  if (result.state === "not-in-rollout") return "v" + result.version + " 灰度 " + result.percent + "%，本机未命中，稍后再试";
  return "已是最新版本 v" + result.currentVersion;
}

const TOKEN_VARS = {
  primary: "--primary",
  primaryHover: "--primary-hover",
  primarySoft: "--primary-soft",
  background: "--background",
  surface: "--surface",
  surfaceRaised: "--surface-raised",
  textPrimary: "--text-primary",
  textSecondary: "--text-secondary",
  textMuted: "--text-muted",
  divider: "--divider",
  success: "--success",
  warning: "--warning",
  danger: "--danger",
  star: "--star",
  badgeExclusive: "--badge-exclusive",
  badgeRecommend: "--badge-recommend",
  navFrom: "--nav-from",
  navTo: "--nav-to",
  onNav: "--on-nav",
  bannerBg: "--banner-bg",
  sectionFrom: "--section-from",
  sectionTo: "--section-to",
};

const ACTION_LABEL = { open: "打开", upgrade: "升级", install: "一键安装", request: "申请" };
/** 手动安装的应用走描边按钮，弹安装向导由用户完成（安装按钮的第三种形态）。 */
const MANUAL_LABEL = "手动安装";
const STATE_LABEL = { "not-installed": "未安装", installed: "已安装", upgradable: "可升级", "needs-approval": "需审批" };
const TRAY_LABEL = { idle: "空闲", downloading: "下载中", "update-available": "有更新", "awaiting-approval": "待审批", "needs-reboot": "需重启", error: "有失败" };
const BUSY = ["queued", "downloading", "verifying", "installing"];

async function rpc(method, params) {
  const response = await fetch("/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params: params || {} }),
  });
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.error || "rpc failed");
  return payload.result;
}

function safe(value) {
  return String(value == null ? "" : value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

let toastTimer = null;
function toast(message, isError) {
  const node = el("toast");
  node.textContent = message;
  node.className = "toast show" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.className = "toast"), 3000);
}

function fail(err) {
  toast(String((err && err.message) || err), true);
}

function iconOf(entry, size) {
  const letter = safe(entry.app.name.slice(0, 1).toUpperCase());
  const inner = letter + (entry.iconUrl ? '<img src="' + safe(entry.iconUrl) + '" alt="" loading="lazy" />' : "");
  return '<span class="app-icon" style="' + (size ? "width:" + size + "px;height:" + size + "px" : "") + '" aria-hidden="true">' + inner + "</span>";
}

function chips(entry) {
  const list = [];
  if (entry.app.badge === "exclusive") list.push('<span class="chip exclusive">专属</span>');
  if (entry.app.badge === "recommend") list.push('<span class="chip recommend">推荐</span>');
  if (entry.installState === "needs-approval") list.push('<span class="chip approval">需审批</span>');
  const stateClass = { installed: "state-installed", upgradable: "state-upgradable", "needs-approval": "state-approval" }[entry.installState];
  if (stateClass) list.push('<span class="chip ' + stateClass + '">' + STATE_LABEL[entry.installState] + "</span>");
  (entry.app.tags || []).slice(0, 2).forEach((tag) => list.push('<span class="chip">' + safe(tag) + "</span>"));
  return '<div class="chips">' + list.join("") + "</div>";
}

function stars(distribution) {
  const mean = distribution && distribution.count ? distribution.mean : 0;
  const count = distribution && distribution.count ? distribution.count : 0;
  // 星标一律 SVG：实心评分星 fill 走 --star，空星只描边。
  let glyph = "";
  for (let i = 1; i <= 5; i++) {
    glyph += '<span class="star' + (i <= Math.round(mean) ? " on" : "") + '">' + STAR_SVG + "</span>";
  }
  return '<span class="stars" aria-label="评分 ' + mean.toFixed(1) + " 分，共 " + String(count) + ' 人评分">' + glyph + "</span> <span class=\"card-sub\">" + mean.toFixed(1) + " · " + String(count) + " 人</span>";
}

function jobOf(appId) {
  for (const job of state.jobs.values()) if (job.appId === appId) return job;
  return null;
}

function actionButton(entry) {
  const job = jobOf(entry.app.id);
  if (job && BUSY.includes(job.state)) {
    const pct = job.progress && job.progress.total ? Math.round((job.progress.received / job.progress.total) * 100) : 0;
    const label = { queued: "排队中", downloading: "下载中", verifying: "校验中", installing: "安装中" }[job.state] || job.state;
    return '<button class="primary" disabled>' + safe(label) + '</button><span class="progress" role="progressbar" aria-valuenow="' + String(pct) + '"><i style="width:' + String(pct) + '%"></i></span>';
  }
  if (job && job.state === "awaiting_approval") {
    return '<button class="outline" data-action="request" data-id="' + safe(entry.app.id) + '">去申请</button>';
  }
  if (job && job.state === "failed") {
    return '<button class="primary" data-action="install" data-id="' + safe(entry.app.id) + '">重试</button>';
  }
  const isManual = entry.action === "install" && entry.app.installMode === "manual";
  const core = isManual
    ? '<button class="outline" data-action="install" data-id="' + safe(entry.app.id) + '" title="弹出安装向导，由你完成安装">' + MANUAL_LABEL + "</button>"
    : '<button class="' + (entry.action === "request" ? "outline" : "primary") + '" data-action="' + safe(entry.action) + '" data-id="' + safe(entry.app.id) + '">' + ACTION_LABEL[entry.action] + "</button>";
  if (!isManual && entry.action === "install" && entry.otherVersions.length > 0) {
    return (
      '<span class="split-btn">' +
      core +
      '<button class="caret" data-versions="' + safe(entry.app.id) + '" aria-label="选择版本" aria-haspopup="true">▾</button>' +
      "</span>"
    );
  }
  return core;
}

function appRow(entry) {
  // 行内只有一个状态按钮；名称与描述整块可点开详情，替代原来的 ghost「详情」。
  return (
    '<div class="app-row">' +
    iconOf(entry) +
    '<div class="app-main" data-detail="' + safe(entry.app.id) + '" role="button" tabindex="0" aria-label="查看 ' + safe(entry.app.name) + ' 详情"><div class="app-name">' + safe(entry.app.name) + "</div>" +
    '<div class="app-desc" title="' + safe(entry.app.description || entry.app.publisher) + '">' + safe(entry.app.description || entry.app.publisher) + "</div></div>" +
    '<div class="card-actions">' + actionButton(entry) + "</div>" +
    "</div>"
  );
}

function appCard(entry) {
  return (
    '<article class="card" data-card="' + safe(entry.app.id) + '">' +
    '<div class="card-top">' + iconOf(entry) + "<div><div class=\"card-title app-name\">" + safe(entry.app.name) + "</div>" +
    '<div class="app-desc">' + safe(entry.app.publisher) + " · v" + safe(entry.app.latestVersion) + "</div></div></div>" +
    chips(entry) +
    '<div class="meta"><span>' + stars(entry.ratings) + "</span><span>" + String(entry.app.downloadCount) + " 次下载</span></div>" +
    '<div class="card-actions">' + actionButton(entry) + '<button class="ghost" data-detail="' + safe(entry.app.id) + '">详情</button></div>' +
    "</article>"
  );
}

function bannerBackground(image) {
  const url = String(image || "");
  if (!url || (!url.startsWith("/") && !/^https?:\/\//i.test(url))) return "";
  return ' style="background-image:url(&quot;' + safe(url) + '&quot;)"';
}

function renderHome(home) {
  el("banners").innerHTML = (home.banners || [])
    .map(
      (slide, index) =>
        '<div class="banner' + (index % 2 === 1 ? " alt" : "") + '"' + bannerBackground(slide.image) + '><span class="banner-art" aria-hidden="true"></span><h3>' + safe(slide.title) + "</h3><p>" + safe(slide.subtitle) + "</p>" +
        (slide.entry
          ? '<div class="banner-actions">' + actionButton(slide.entry) + '<button class="ghost" data-detail="' + safe(slide.entry.app.id) + '">查看详情</button></div>'
          : "") +
        "</div>",
    )
    .join("") || '<div class="banner"><h3>暂无运营位</h3><p>目录刷新后显示。</p></div>';

  el("essential-wall").innerHTML = (home.essential || [])
    // 必备条只有图标不带文字，名称走 title 提示。
    .map((entry) => '<button class="essential-item" data-detail="' + safe(entry.app.id) + '" title="' + safe(entry.app.name) + '" aria-label="' + safe(entry.app.name) + '">' + iconOf(entry, 44) + "</button>")
    .join("");

  const bundles = home.bundles || [];
  const bundleHost = el("bundles");
  bundleHost.hidden = bundles.length === 0;
  bundleHost.innerHTML = bundles
    .map(
      (bundle) =>
        '<div class="bundle-card"><div class="bundle-info"><h3>' + safe(bundle.title) + "</h3><p>" + safe(bundle.subtitle) + "</p>" +
        '<div class="bundle-apps">' + bundle.apps.map((entry) => iconOf(entry, 36)).join("") +
        '<span class="bundle-count">' + String(bundle.apps.length) + " 款" + (bundle.missing ? " · " + String(bundle.missing) + " 款已下架" : "") + "</span></div></div>" +
        '<button class="primary" data-bundle="' + safe(bundle.id) + '">一键装机</button></div>',
    )
    .join("");

  el("sections").innerHTML = (home.sections || [])
    .map(
      (section) =>
        '<section class="section-card"><div class="section-aside"><div><h3>' + safe(section.name) + "</h3>" +
        '<div class="path">' + safe(section.path.join(" / ")) + "</div></div>" +
        '<button class="outline" data-category="' + safe(section.categoryId) + '">查看全部 (' + String(section.total) + ")</button></div>" +
        '<div class="section-body">' + section.items.map(appRow).join("") + "</div></section>",
    )
    .join("");
}

async function loadView() {
  const entries = await rpc("catalog.view");
  state.entries = entries;
  state.byId = new Map(entries.map((entry) => [entry.app.id, entry]));
  return entries;
}

async function refreshHome() {
  await rpc("catalog.refresh").catch(() => 0);
  state.home = await rpc("catalog.home");
  renderHome(state.home);
  await refreshBadge();
}

const VIEWS = ["home", "exclusive", "categories", "search", "installed", "upgrade", "approvals", "cleanup", "settings"];

function viewFromHash() {
  const name = String(location.hash || "").replace(/^#\/?/, "");
  return VIEWS.includes(name) ? name : "home";
}

function closeMenu() {
  const menu = el("main-menu");
  if (menu && !menu.hidden) {
    menu.hidden = true;
    el("btn-menu").setAttribute("aria-expanded", "false");
  }
}

function toggleMenu() {
  const menu = el("main-menu");
  menu.hidden = !menu.hidden;
  el("btn-menu").setAttribute("aria-expanded", menu.hidden ? "false" : "true");
}

function showView(name) {
  const view = VIEWS.includes(name) ? name : "home";
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  const target = el("view-" + view);
  if (target) target.classList.add("active");
  document.querySelectorAll(".nav").forEach((n) => n.classList.toggle("active", n.dataset.view === view));
  // 返回键常驻、首页置灰（隐藏会让顶栏高度抖动）。
  el("btn-back").disabled = view === "home";
  // 用 replaceState 同步 hash：宿主按 #/settings 开独立窗口，也不会触发 hashchange 回环。
  if (String(location.hash).replace(/^#\/?/, "") !== view) history.replaceState(null, "", "#/" + view);
}

async function hydrate(view) {
  try {
    if (view === "home") renderHome(await rpc("catalog.home"));
    if (view === "categories") await loadCategories();
    if (view === "exclusive") await loadExclusive();
    if (view === "installed") await loadInstalled();
    if (view === "upgrade") await loadUpgrades();
    if (view === "approvals") await loadApprovals();
    if (view === "settings") await loadSettings();
    // 直接从地址栏进搜索页时给引导，而不是留一块空白。
    if (view === "search" && !el("search").value.trim() && !el("grid-search").children.length) {
      el("grid-search").innerHTML = emptyState("search", "输入关键字开始搜索", "支持软件名、拼音、厂商与标签");
      el("search-meta").textContent = "";
    }
  } catch (err) {
    fail(err);
  }
}

/** 专属应用页：没有授权时给空态，而不是一个空白网格。 */
async function loadExclusive() {
  const entries = await rpc("catalog.exclusive");
  el("exclusive-grid").innerHTML = entries.length
    ? entries.map(appCard).join("")
    : emptyState("star", "暂无专属应用", "管理端为贵单位授权后，应用会出现在这里");
}

async function loadCategories() {
  state.categories = await rpc("catalog.categories");
  if (!state.entries.length) {
    state.entries = await rpc("catalog.view");
    state.byId = new Map(state.entries.map((entry) => [entry.app.id, entry]));
  }
  const walk = (nodes) =>
    "<ul>" +
    nodes.map((node) => '<li data-category="' + safe(node.id) + '">' + safe(node.name) + " (" + String(node.appCount) + ")</li>" + (node.children.length ? walk(node.children) : "")).join("") +
    "</ul>";
  el("category-tree").innerHTML = state.categories.length ? walk(state.categories) : "<li>暂无分类</li>";
  // 右栏默认是分类总览卡格；选中某个分类后 openCategory 会把它换成该分类的应用列表。
  // 直接写进 #grid-category：它本身就是 .grid 网格，再套一层会被压成一列。
  if (!state.activeCategory) {
    el("grid-category").innerHTML = state.categories.length
      ? state.categories.map(categoryCard).join("")
      : emptyState("grid", "还没有分类", "服务端上架应用后会按分类自动归类");
  }
}

/** 该分类及其所有子分类的 id，父级卡片要统计子级里的应用。 */
function subtreeIds(node) {
  const ids = [node.id];
  for (const child of node.children ?? []) ids.push(...subtreeIds(child));
  return ids;
}

/** 分类卡：名称 + 累计数量 + 前四个应用图标 + 子分类，点卡片进该分类的列表。 */
function categoryCard(node) {
  const inside = new Set(subtreeIds(node));
  const previews = state.entries.filter((entry) => inside.has(entry.app.categoryId)).slice(0, 4);
  return (
    '<button class="cat-card" data-category="' + safe(node.id) + '">' +
    '<span class="cat-head"><strong>' + safe(node.name) + "</strong><span class=\"cat-count\">" + String(node.appCount) + " 款</span></span>" +
    '<span class="cat-icons">' + (previews.length ? previews.map((entry) => iconOf(entry, 36)).join("") : '<span class="cat-none">暂无上架应用</span>') + "</span>" +
    (node.children.length
      ? '<span class="cat-kids">' + node.children.map((child) => safe(child.name) + " (" + String(child.appCount) + ")").join(" · ") + "</span>"
      : "") +
    "</button>"
  );
}

async function openCategory(categoryId) {
  state.activeCategory = categoryId;
  document.querySelectorAll("#category-tree li").forEach((li) => li.classList.toggle("active", li.dataset.category === categoryId));
  const entries = (await loadView()).filter((entry) => {
    const path = entry.categoryPath || [];
    return path.length > 0 && entry.app.categoryId === categoryId;
  });
  el("grid-category").innerHTML = entries.length ? entries.map(appCard).join("") : '<p class="card-sub">该分类下还没有上架软件。</p>';
  showView("categories");
}

async function doSearch() {
  const text = el("search").value.trim();
  if (!text) return;
  const hits = await rpc("catalog.search", { text, limit: 30 });
  const entries = await loadView();
  const byId = new Map(entries.map((entry) => [entry.app.id, entry]));
  const merged = hits.map((hit) => byId.get(hit.app.id)).filter(Boolean);
  el("grid-search").innerHTML = merged.length ? merged.map(appCard).join("") : emptyState("search", "没有匹配的软件", "换个说法、拼音或厂商名再试一次");
  el("search-meta").textContent = "关键字 " + text + " · " + String(merged.length) + " 个结果" + (hits[0] ? " · 首位命中字段 " + hits[0].matchedOn : "");
  showView("search");
}

async function loadInstalled() {
  const apps = await rpc("installed.list");
  el("installed-meta").textContent = String(apps.length) + " 个应用 · 约 " + (apps.reduce((sum, a) => sum + (a.estimatedSizeKb || 0), 0) / 1024).toFixed(0) + " MB";
  el("installed-list").innerHTML = apps
    .slice(0, 60)
    .map(
      (a) =>
        '<div class="row"><div><strong>' + safe(a.displayName) + '</strong> <span class="app-desc">v' + safe(a.displayVersion) + " · " + safe(a.publisher) + "</span>" +
        '<div class="path">' + safe(a.installLocation || a.registryPath) + "</div></div>" +
        '<button class="ghost" data-residue="' + safe(a.displayName) + '">扫描残留</button>' +
        '<button class="danger" data-uninstall="' + safe(a.displayName) + '">卸载</button></div>',
    )
    .join("");
}

/** 空态占位：图形一律取自 SVG 图标库，不使用字符图形也不引入外部素材。 */
function emptyState(icon, title, hint) {
  return '<div class="empty-state"><span class="empty-glyph" aria-hidden="true">' + (ICONS[icon] || ICONS.grid) + "</span><strong>" + safe(title) + "</strong><p>" + safe(hint) + "</p></div>";
}

async function loadUpgrades() {
  const plan = await rpc("upgrade.plan");
  el("count-upgrade").textContent = plan.summary.total ? "(" + String(plan.summary.total) + ")" : "";
  el("upgrade-meta").textContent =
    String(plan.summary.total) + " 个可升级 · 合计 " + (plan.summary.bytes / 1048576).toFixed(1) + " MB · 需先卸载 " + String(plan.summary.needsUninstall) + " 个";
  el("btn-upgrade-all").disabled = plan.summary.total === 0;
  el("upgrade-list").innerHTML = plan.candidates.length
    ? plan.candidates
        .map(
          (c) =>
            '<div class="row"><div><strong>' + safe(c.name) + '</strong> <span class="app-desc">' + safe(c.installedVersion) + " → " + safe(c.availableVersion) + "</span>" +
            '<div class="path">' + safe(c.releaseNotes || c.reason) + "</div></div>" +
            '<button class="ghost" data-detail="' + safe(c.appId) + '">详情</button>' +
            '<button class="primary" data-action="upgrade" data-id="' + safe(c.appId) + '">升级</button></div>',
        )
        .join("")
    : emptyState("upgrade", "没有可升级的软件", "已安装的应用都是最新版本");
}

async function loadApprovals() {
  const list = await rpc("approval.list");
  el("count-approvals").textContent = list.length ? "(" + String(list.length) + ")" : "";
  const gated = state.entries.filter((entry) => entry.app.requiresApproval);
  el("approval-app").innerHTML = gated.length
    ? gated.map((entry) => '<option value="' + safe(entry.app.id) + '">' + safe(entry.app.name) + "</option>").join("")
    : '<option value="">没有需要审批的应用</option>';
  el("approval-list").innerHTML = list.length
    ? list
        .map(
          (r) =>
            '<div class="row"><div><strong>' + safe(r.appId) + '</strong> <span class="app-desc">' + safe(r.status) + "</span>" +
            '<div class="path">' + safe(r.reason) + "</div></div>" +
            '<button class="ghost" data-grant="' + safe(r.id) + '">取凭证</button>' +
            '<button class="primary" data-action="install" data-id="' + safe(r.appId) + '">重试安装</button></div>',
        )
        .join("")
    : '<p class="card-sub">还没有提交过申请。</p>';
}

async function openDetail(appId) {
  const entry = state.byId.get(appId) || (await loadView()).find((item) => item.app.id === appId);
  if (!entry) return toast("目录里没有这个应用", true);
  const app = await rpc("catalog.detail", { appId });
  const rating = await rpc("catalog.rating", { appId });
  el("detail-name").textContent = app.name;
  el("detail-body").innerHTML =
    '<div class="meta"><span>' + stars(rating) + "</span><span>" + String(app.downloadCount) + " 次下载</span></div>" +
    chips(entry) +
    "<p>" + safe(app.description) + "</p>" +
    '<div class="form-row"><select id="rate-stars" aria-label="星级"><option>5</option><option>4</option><option>3</option><option>2</option><option>1</option></select>' +
    '<input id="rate-comment" placeholder="评分理由（可选）" /><button class="primary" data-rate="' + safe(app.id) + '">提交评分</button></div>' +
    "<h4>版本历史</h4>" +
    (app.versions || []).map((v) => '<div class="version"><strong>' + safe(v.version) + '</strong> <span class="app-desc">' + safe(v.releasedAt) + " · " + (v.sizeBytes / 1048576).toFixed(1) + " MB</span><p>" + safe(v.releaseNotes) + "</p></div>").join("") +
    '<div class="card-actions">' + actionButton(entry) + "</div>";
  el("detail").classList.add("open");
}

async function runAction(action, appId, version) {
  try {
    if (action === "request") {
      showView("approvals");
      await hydrate("approvals");
      el("approval-app").value = appId;
      el("approval-reason").focus();
      return;
    }
    if (action === "open") {
      const result = await rpc("app.open", { appId });
      toast(result && result.launched ? "已启动 " + appId : String((result && result.message) || "未能启动"));
      return;
    }
    const job = await rpc(action === "upgrade" ? "app.upgrade" : "app.install", { appId, version });
    state.jobs.set(job.id, { id: job.id, appId, name: job.appName, state: job.state });
    repaint();
    if (job.state === "awaiting_approval") toast("该应用需要审批", true);
  } catch (err) {
    fail(err);
  }
}

function repaint() {
  if (state.home) renderHome(state.home);
  const active = document.querySelector(".view.active");
  if (!active) return;
  if (active.id === "view-search") document.querySelectorAll("#grid-search .card").forEach((card) => {
    const entry = state.byId.get(card.dataset.card);
    if (entry) card.querySelector(".card-actions").innerHTML = actionButton(entry) + '<button class="ghost" data-detail="' + safe(entry.app.id) + '">详情</button>';
  });
}

function closeMenus() {
  document.querySelectorAll(".menu").forEach((node) => node.remove());
}

async function showVersionMenu(anchor, appId) {
  closeMenus();
  const entry = state.byId.get(appId);
  if (!entry) return;
  const menu = document.createElement("ul");
  menu.className = "menu";
  menu.innerHTML = [entry.app.latestVersion].concat(entry.otherVersions).map((v) => '<li data-version="' + safe(v) + '">' + safe(v) + "</li>").join("");
  anchor.parentElement.appendChild(menu);
  menu.addEventListener("click", (event) => {
    const item = event.target.closest("[data-version]");
    if (!item) return;
    closeMenus();
    runAction("install", appId, item.dataset.version);
  });
  setTimeout(() => document.addEventListener("click", () => closeMenus(), { once: true }), 0);
}

function paintTray(view) {
  const label = TRAY_LABEL[view.status] || view.status;
  el("tray-status").textContent = label;
  el("tray-status-2").textContent = label;
  el("tray-menu").innerHTML = (view.menu || []).filter((m) => m.kind === "action").map((m) => "<li>" + safe(m.label) + (m.badge ? " (" + String(m.badge) + ")" : "") + "</li>").join("");
  document.title = view.icon.tooltip + " · 应用中心";
}

async function refreshBadge() {
  const active = [...state.jobs.values()].filter((job) => BUSY.includes(job.state)).length;
  const failed = [...state.jobs.values()].filter((job) => job.state === "failed").length;
  el("dot-downloads").hidden = active + failed === 0;
  el("btn-downloads").setAttribute("aria-label", "下载中心，" + String(active) + " 个进行中");
  el("downloads-body").innerHTML =
    [...state.jobs.values()].reverse()
      .map((job) => '<div class="row"><div><strong>' + safe(job.name || job.appId) + "</strong><div class=\"path\">" + safe(job.state) + (job.error ? " · " + safe(job.error) : "") + "</div></div><span></span><span></span></div>")
      .join("") || emptyState("download", "暂无下载任务", "在推荐或分类页点「一键安装」即可开始下载");
}

function connectEvents() {
  const source = new EventSource("/events");
  source.addEventListener("job", (event) => {
    const job = JSON.parse(event.data);
    state.jobs.set(job.id, job);
    void refreshBadge();
    void refreshBundleProgress();
    repaint();
  });
  source.addEventListener("tray", (event) => paintTray(JSON.parse(event.data)));
  source.addEventListener("hello", (event) => paintTray(JSON.parse(event.data).tray));
  source.onerror = () => {
    source.close();
    setTimeout(connectEvents, 2000);
  };
}

function applySkin(skin) {
  const root = document.documentElement;
  Object.entries(skin.tokens.color).forEach(([key, value]) => {
    if (TOKEN_VARS[key]) root.style.setProperty(TOKEN_VARS[key], value);
  });
  root.style.setProperty("--radius-sm", String(skin.tokens.radius.sm) + "px");
  root.style.setProperty("--radius-md", String(skin.tokens.radius.md) + "px");
  root.style.setProperty("--radius-lg", String(skin.tokens.radius.lg) + "px");
  root.style.setProperty("--font-size-base", String(skin.tokens.font.sizeBase) + "px");
  root.style.setProperty("--font-size-title", String(skin.tokens.font.sizeTitle) + "px");
  skin.tokens.spacing.slice(0, 6).forEach((value, index) => root.style.setProperty("--s" + String(index + 1), String(value) + "px"));
}

async function loadSettings() {
  const [skins, active, tray] = await Promise.all([rpc("ui.skins"), rpc("ui.skin"), rpc("ui.tray")]);
  state.skins = skins;
  el("skin").innerHTML = skins.map((s) => '<option value="' + safe(s.id) + '">' + safe(s.label) + "</option>").join("");
  el("skin").value = active.id;
  el("skin-meta").textContent = active.label + " · " + String(active.fallbacks.length) + " 个 token 由基础主题补齐 · " + String(active.errors.length) + " 个校验错误";
  paintTray(tray);
  const windows = await rpc("ui.windows");
  el("window-list").innerHTML = windows.length
    ? windows.map((w) => "<li>" + safe(w.role) + " · " + safe(w.route) + (w.visible ? "" : " (隐藏)") + ' <button class="ghost" data-close-window="' + safe(w.id) + '">关闭</button></li>').join("")
    : "<li>没有打开的窗口</li>";
  const dirs = await rpc("runtime.dirs");
  el("set-dirs").textContent = "安装包目录 " + String(dirs.packageDir).split(/[\\/]/).slice(-1)[0] + "… · 图标缓存 " + String(dirs.iconCount) + " 个";
  const runtime = await rpc("runtime.config");
  el("set-download-dir").value = runtime.config.downloadDir || "";
  el("set-concurrency").value = String(runtime.config.concurrency);
  el("set-cleanup").checked = runtime.config.installerCleanup === true;
  el("set-interval").value = String(runtime.config.updateCheckIntervalMinutes);
  el("runtime-issues").textContent = "配置文件 " + runtime.file;
  paintSchedule(runtime.scheduler);
  await loadNotifications();
  const pending = await rpc("selfupdate.pending");
  if (pending) {
    state.staged = pending;
    el("btn-selfupdate-apply").disabled = false;
    el("selfupdate-meta").textContent = "已暂存 v" + pending.version + "（" + new Date(pending.stagedAt).toLocaleString() + "），点立即应用即可换版";
  }
  await paintRepo();
}

const REPO_STATUS_LABEL = { saved: "已保存", failed: "失败", pending: "待取" };

async function paintRepo() {
  try {
    const status = await rpc("repo.status");
    if (!status.manifestExists) {
      el("repo-meta").textContent = "还没有清单，点「同步最新版」开始把安装包保存到本地。";
      el("repo-items").innerHTML = "";
      return;
    }
    el("repo-meta").textContent =
      status.root + " · 已保存 " + String(status.saved) + " / 失败 " + String(status.failed) + " / 待取 " + String(status.pending) +
      " · 合计 " + (status.totalBytes / 1048576).toFixed(1) + " MB";
    el("repo-items").innerHTML = status.items
      .slice(0, 10)
      .map(
        (item) =>
          "<li>[" + safe(REPO_STATUS_LABEL[item.status] || item.status) + "] " + safe(item.name) + " v" + safe(item.version) +
          " · " + (item.sizeBytes / 1024).toFixed(0) + " KB" + (item.error ? " · " + safe(item.error) : "") + " → " + safe(item.relativePath) + "</li>",
      )
      .join("") + (status.items.length > 10 ? "<li>… 其余 " + String(status.items.length - 10) + " 项见 manifest.json</li>" : "");
  } catch (err) {
    el("repo-meta").textContent = "仓库状态不可用：" + String((err && err.message) || err);
  }
}

async function runRepoSync(allVersions) {
  el("repo-meta").textContent = allVersions ? "正在同步全部历史版本……" : "正在同步最新版本……";
  try {
    const report = await rpc("repo.sync", { allVersions });
    toast("本地仓库同步完成：新存 " + String(report.saved.length) + "，已有 " + String(report.cached.length) + "，失败 " + String(report.failed.length));
  } catch (err) {
    fail(err);
  }
  await paintRepo();
}

function paintSchedule(scheduler) {
  if (!scheduler) return;
  const checked = scheduler.lastCheckAt ? new Date(scheduler.lastCheckAt).toLocaleString() : "从未";
  el("schedule-meta").textContent =
    (scheduler.running ? "检查调度运行中" : "检查调度已停止") + " · 上次检查 " + checked +
    (scheduler.lastCheckError ? " · 失败：" + scheduler.lastCheckError : "") +
    " · 未确认通知 " + String(scheduler.unreadNotifications);
}

async function loadNotifications() {
  const notes = await rpc("notification.list");
  el("notification-list").innerHTML = notes.length
    ? notes
        .map(
          (note) =>
            "<li>" +
            safe(note.appId) +
            " v" +
            safe(note.appVersion) +
            " · " +
            safe(note.status) +
            ' <button class="ghost" data-note-done="' +
            safe(note.id) +
            '">标记已读</button></li>',
        )
        .join("")
    : "<li>没有待确认的审批通知</li>";
}

async function scanResidue(name) {
  try {
    state.report = await rpc("residue.report", { name });
  } catch (err) {
    return fail(err);
  }
  showView("cleanup");
  el("cleanup-name").value = name;
  const counts = state.report.counts;
  el("residue-report").innerHTML =
    '<div class="meta"><span>' + safe(name) + " · " + String(state.report.items.length) + " 项残留</span><span>" + Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => k + "=" + String(n)).join(" ") + "</span></div>" +
    '<div class="meta"><span>分段耗时 ' + Object.entries(state.report.durationMs).map(([k, n]) => k + " " + String(n) + "ms").join(" / ") + "</span></div>" +
    state.report.items
      .map(
        (item, index) =>
          '<div class="row"><label><input type="checkbox" data-risk="' + safe(item.risk) + '" data-index="' + String(index) + '" ' + (item.risk === "low" ? "checked" : "") + ' /> ' +
          '<span class="risk-' + safe(item.risk) + '">[' + safe(item.risk) + "] " + safe(item.kind) + "</span>" +
          '<div class="path">' + safe(item.path) + "</div></label><span class=\"app-desc\">" + safe(item.detail) + "</span><span></span></div>",
      )
      .join("");
  el("cleanup-plan").innerHTML =
    '<div class="row-actions"><button class="ghost" id="btn-plan">生成清理计划</button><button class="primary" id="btn-cleanup-dry">试运行</button><button class="danger" id="btn-cleanup-run">确认执行</button>' +
    '<input id="confirm-token" placeholder="输入 CONFIRM 才能真删" style="max-width:200px" /></div>';
  toast("扫描完成，默认只列出计划");
}

function selectedPolicy(confirmToken) {
  const checked = [...document.querySelectorAll("#residue-report input:checked")].map((input) => ({ risk: input.dataset.risk, item: state.report.items[Number(input.dataset.index)] }));
  const roots = checked.filter((c) => c.item && (c.item.kind === "directory" || c.item.kind === "shortcut" || c.item.kind === "menu")).map((c) => c.item.path);
  return { includeRisks: checked.map((c) => c.risk), allowWriteRoots: roots.length ? roots : ["C:" + BS + "Program Files"], confirmToken };
}

async function runCleanup(mode, confirmToken) {
  if (!state.report) return toast("先扫描残留", true);
  try {
    const result = await rpc("cleanup.apply", { report: state.report, policy: selectedPolicy(confirmToken), dryRun: mode !== "run" });
    state.restoreDir = result.manifestFile ? String(result.manifestFile).split(/[\\/]/).slice(0, -1).join(BS) : "";
    const summary =
      "计划 " + String(result.planned.length) + " 项，跳过 " + String(result.skipped.length) + " 项，" +
      (result.dryRun ? "试运行未改动" : "已执行 " + String(result.applied.length) + " 项，失败 " + String(result.failed.length) + " 项") +
      (result.blockedReason ? "（被拦截：" + result.blockedReason + "）" : "") + "；备份 " + String((result.backups || []).length) + " 份";
    el("cleanup-plan").innerHTML =
      '<div class="row"><div>' + safe(summary) + '</div><span></span><span></span></div>' +
      (result.skipped || []).map((s) => '<div class="row"><div class="path">' + safe(s.item.path) + '</div><span class="app-desc">' + safe(s.reason) + "</span><span></span></div>").join("") +
      '<div class="row-actions"><button class="ghost" id="btn-plan">生成清理计划</button><button class="primary" id="btn-cleanup-dry">试运行</button><button class="danger" id="btn-cleanup-run">确认执行</button>' +
      (state.restoreDir ? '<button class="outline" id="btn-cleanup-restore">从备份撤销</button>' : "") +
      '<input id="confirm-token" placeholder="输入 CONFIRM 才能真删" style="max-width:200px" value="' + safe(confirmToken) + '" /></div>';
    toast(summary, !result.dryRun && result.failed.length > 0);
  } catch (err) {
    fail(err);
  }
}

document.addEventListener("click", async (event) => {
  // 菜单外任意点击都先收起，菜单项本身由 trigger 分支处理。
  if (!event.target.closest || !event.target.closest(".menu-host")) closeMenu();
  // 只有列在这里的选择器会进分发表；新增按钮必须同步加进来，否则点击会被静默丢弃。
  const trigger = event.target.closest("[data-action],[data-detail],[data-category],[data-residue],[data-uninstall],[data-grant],[data-rate],[data-close-window],[data-versions],[data-note-done],[data-bundle],[data-view],#bundle-close,#btn-bulk,#btn-upgrade-all,#btn-approval-submit,#btn-residue,#btn-plan,#btn-cleanup-dry,#btn-cleanup-run,#btn-cleanup-restore,#detail-close,#downloads-close,#btn-back,#btn-menu,#btn-downloads,#menu-upgrade-all,#menu-downloads,#btn-min,#btn-max,#btn-close,#btn-selfupdate,#btn-selfupdate-stage,#btn-selfupdate-apply,#btn-save-runtime,#btn-start-checks,#btn-stop-checks,#btn-repo-sync,#btn-repo-sync-all,#btn-repo-status");
  if (!trigger) return;
  const id = trigger.dataset.id;
  try {
    if (trigger.dataset.view) {
      const view = trigger.dataset.view;
      closeMenu();
      showView(view);
      return hydrate(view);
    }
    if (trigger.dataset.versions) return showVersionMenu(trigger, trigger.dataset.versions);
    if (trigger.dataset.detail) return openDetail(trigger.dataset.detail);
    if (trigger.dataset.category) return openCategory(trigger.dataset.category);
    if (trigger.dataset.action) return runAction(trigger.dataset.action, id, trigger.dataset.version);
    if (trigger.dataset.uninstall) {
      const job = await rpc("app.uninstall", { name: trigger.dataset.uninstall });
      toast("卸载结束，状态 " + job.state);
      await loadInstalled();
      return;
    }
    if (trigger.dataset.residue) return scanResidue(trigger.dataset.residue);
    if (trigger.dataset.grant) {
      await rpc("approval.attachGrant", { requestId: trigger.dataset.grant });
      return toast("凭证已注入，可重试安装");
    }
    if (trigger.dataset.rate) {
      await rpc("catalog.rate", { appId: trigger.dataset.rate, stars: Number(el("rate-stars").value), comment: el("rate-comment").value, verifiedInstall: true });
      return openDetail(trigger.dataset.rate);
    }
    if (trigger.dataset.closeWindow) {
      await rpc("window.control", { action: "close", windowId: trigger.dataset.closeWindow });
      return loadSettings();
    }
    if (trigger.id === "btn-bulk") {
      const home = await rpc("catalog.home");
      await rpc("app.bulkInstall", { appIds: home.essential.filter((e) => e.installState === "not-installed").map((e) => e.app.id) });
      return toast("已加入批量安装队列");
    }
    if (trigger.id === "btn-upgrade-all") {
      const plan = await rpc("upgrade.plan");
      await rpc("app.bulkInstall", { appIds: plan.candidates.map((c) => c.appId) });
      return toast("已加入批量升级队列");
    }
    if (trigger.id === "btn-approval-submit") {
      await rpc("approval.request", { appId: el("approval-app").value, reason: el("approval-reason").value });
      return loadApprovals();
    }
    if (trigger.id === "btn-residue") return scanResidue(el("cleanup-name").value);
    if (trigger.id === "btn-plan") {
      const plan = await rpc("cleanup.plan", { report: state.report, policy: selectedPolicy("") });
      el("cleanup-plan").insertAdjacentHTML("afterbegin", '<div class="meta">计划 ' + String(plan.actions.length) + " 项，跳过 " + String(plan.skipped.length) + " 项</div>");
      return;
    }
    if (trigger.id === "btn-cleanup-dry") return runCleanup("dry", "");
    if (trigger.id === "btn-cleanup-run") return runCleanup("run", el("confirm-token") ? el("confirm-token").value : "");
    if (trigger.id === "btn-cleanup-restore") {
      const result = await rpc("cleanup.restore", { backupDir: state.restoreDir });
      return toast("已还原 " + String(result.restored) + " 项" + (result.failed.length ? "，失败 " + String(result.failed.length) + " 项" : ""));
    }
    if (trigger.dataset.bundle) {
      const run = await rpc("bundle.install", { bundleId: trigger.dataset.bundle });
      state.bundleRun = run;
      await refreshBundleProgress();
      return toast("已开始安装 " + String(run.jobIds.length) + " 个应用");
    }
    if (trigger.id === "bundle-close") {
      state.bundleRun = null;
      el("bundle-progress").hidden = true;
      return;
    }
    if (trigger.dataset.noteDone) {
      await rpc("notification.done", { id: trigger.dataset.noteDone });
      await loadSettings();
      return toast("通知已确认");
    }
    if (trigger.id === "btn-save-runtime") {
      const saved = await rpc("runtime.updateConfig", {
        config: {
          downloadDir: el("set-download-dir").value,
          concurrency: Number(el("set-concurrency").value),
          installerCleanup: el("set-cleanup").checked,
          updateCheckIntervalMinutes: Number(el("set-interval").value),
        },
      });
      paintSchedule(saved.scheduler);
      el("runtime-issues").textContent = saved.issues.length
        ? "已保存，越界项回到默认：" + saved.issues.map((issue) => issue.field).join("、")
        : "已保存到 " + (await rpc("runtime.config")).file;
      return;
    }
    if (trigger.id === "btn-start-checks") return paintSchedule(await rpc("runtime.startChecks"));
    if (trigger.id === "btn-stop-checks") return paintSchedule(await rpc("runtime.stopChecks"));
    if (trigger.id === "btn-repo-sync") return runRepoSync(false);
    if (trigger.id === "btn-repo-sync-all") return runRepoSync(true);
    if (trigger.id === "btn-repo-status") return paintRepo();
    if (trigger.id === "btn-selfupdate") {
      const check = await rpc("selfupdate.check");
      state.selfUpdate = check.manifest;
      el("btn-selfupdate-stage").disabled = check.result.state !== "available";
      el("selfupdate-meta").textContent = selfUpdateLabel(check.result);
      return;
    }
    if (trigger.id === "btn-selfupdate-stage") {
      if (!state.selfUpdate) return toast("先检查更新", true);
      const staged = await rpc("selfupdate.stage", { manifest: state.selfUpdate });
      state.staged = staged;
      el("btn-selfupdate-apply").disabled = false;
      el("selfupdate-meta").textContent = "更新包已暂存 v" + staged.version + "（sha256 校验通过），应用前不会改动当前程序";
      return toast("已暂存 " + staged.version);
    }
    if (trigger.id === "btn-selfupdate-apply") {
      if (!state.staged) return toast("先下载更新包", true);
      const swapped = await rpc("selfupdate.apply", { staged: state.staged });
      el("selfupdate-meta").textContent = swapped.swapped
        ? "已替换为 v" + String(state.staged.version) + (swapped.backupPath ? "，原程序备份在 " + swapped.backupPath : "（首次安装，无历史版本可备份）") + "；下次启动自检通过后自动确认"
        : "替换未生效：" + swapped.message + (swapped.rolledBack ? "（已回滚到原程序）" : "");
      return toast(swapped.swapped ? "更新已应用" : "更新未生效", !swapped.swapped);
    }
    if (trigger.id === "detail-close") return el("detail").classList.remove("open");
    if (trigger.id === "downloads-close") return el("downloads").classList.remove("open");
    if (trigger.id === "btn-downloads") return el("downloads").classList.toggle("open");
    if (trigger.id === "btn-back") return showView("home");
    if (trigger.id === "btn-menu") return toggleMenu();
    if (trigger.id === "menu-downloads") { closeMenu(); return el("downloads").classList.toggle("open"); }
    if (trigger.id === "menu-upgrade-all") {
      closeMenu();
      const plan = await rpc("upgrade.plan");
      await rpc("app.bulkInstall", { appIds: plan.candidates.map((c) => c.appId) });
      return toast("已加入批量升级队列");
    }
    if (trigger.id === "btn-min") return rpc("window.control", { action: "minimize", windowId: (await rpc("ui.windows"))[0]?.id });
    if (trigger.id === "btn-max") return toast("最大化由桌面壳控制（当前为浏览器宿主）");
    if (trigger.id === "btn-close") return rpc("window.control", { action: "close", windowId: (await rpc("ui.windows"))[0]?.id });
  } catch (err) {
    fail(err);
  }
});

let searchTimer = null;
el("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(doSearch, 260);
});
el("search").addEventListener("keydown", (event) => {
  if (event.key === "Enter") doSearch();
});
addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenu();
  // 行内名称区是可聚焦的详情入口，键盘 Enter/Space 与点击同义。
  if ((event.key === "Enter" || event.key === " ") && event.target instanceof HTMLElement && event.target.matches(".app-main")) {
    event.preventDefault();
    void openDetail(event.target.dataset.detail);
  }
});
el("skin").addEventListener("change", async (event) => {
  try {
    const skin = await rpc("ui.setSkin", { id: event.target.value });
    applySkin(skin);
    toast("已切换到 " + skin.label + " 皮肤");
  } catch (err) {
    fail(err);
  }
});

/** 首屏骨架：banner 与分类卡先给 shimmer 占位，数据一到被真实渲染替换。 */
function paintSkeletons() {
  el("banners").innerHTML = Array.from({ length: 2 }, () => '<div class="banner skeleton"><div class="sk-line lg"></div><div class="sk-line md"></div></div>').join("");
  el("sections").innerHTML = Array.from(
    { length: 2 },
    () =>
      '<section class="section-card skeleton"><div class="section-aside"><div class="sk-line lg"></div><div class="sk-line sm"></div></div>' +
      '<div class="section-body"><div class="sk-line md"></div><div class="sk-line md"></div><div class="sk-line md"></div></div></section>',
  ).join("");
}

(async function boot() {
  connectEvents();
  // 图标 404 时摘掉 img，露出底层字母占位；error 不冒泡，只能在捕获阶段接。
  addEventListener(
    "error",
    (event) => {
      const node = event.target;
      if (node && node.tagName === "IMG" && node.closest(".app-icon")) node.remove();
    },
    true,
  );
  addEventListener("hashchange", async () => {
    const view = viewFromHash();
    showView(view);
    await hydrate(view);
  });
  try {
    // 桌面壳（Edge/Chrome --app 独立窗口）注入 shell=app：窗口控制交给 OS 标题条，隐藏自绘按钮避免双份。
    if (new URLSearchParams(location.search).get("shell") === "app") document.body.classList.add("shell-app");
    applySkin(await rpc("ui.skin"));
    paintSkeletons();
    await refreshHome();
    await loadView();
    const initial = viewFromHash();
    showView(initial);
    await hydrate(initial);
    toast("应用中心已就绪");
  } catch (err) {
    fail(err);
  }
})();
