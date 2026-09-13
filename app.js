const storageKey = "wxyy-2-thin-section-index";

const POLARIZATIONS = ["单偏光", "正交偏光", "反射光"];
const STATUS_FLOW = { pending: "待鉴定", reviewed: "已复核", needs_supplement: "需补充" };
const STATUS_VALUES = Object.keys(STATUS_FLOW);
const STATUS_BY_LABEL = Object.fromEntries(Object.entries(STATUS_FLOW).map(([value, label]) => [label, value]));
const MAX_COMPARE = 4;
const MAX_PHOTOS = 8;

/* ---------- 工具 ---------- */

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[ch]));

const pad2 = (n) => String(n).padStart(2, "0");

function localDateStr(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function fmtDate(iso) {
  return localDateStr(iso) || "未知日期";
}

function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "未知时间";
  return `${localDateStr(iso)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function splitMinerals(text) {
  return String(text || "").split(/[、,，;；/\s]+/).map((item) => item.trim()).filter(Boolean);
}

function sameTokens(a, b) {
  const listA = splitMinerals(a);
  const listB = splitMinerals(b);
  return listA.length === listB.length && listA.every((item, i) => item === listB[i]);
}

/* ---------- 数据模型与迁移 ---------- */

function snapshotOf(sample) {
  return {
    code: sample.code,
    location: sample.location,
    magnification: sample.magnification,
    polarization: sample.polarization,
    minerals: sample.minerals,
    texture: sample.texture,
    comment: sample.comment,
    photos: [...sample.photos],
    status: sample.status,
    reviewer: sample.reviewer
  };
}

function makeVersion(sample, note, reviewer) {
  return {
    savedAt: new Date().toISOString(),
    reviewer: reviewer ?? sample.reviewer ?? "",
    note: note || "",
    snapshot: snapshotOf(sample)
  };
}

function migrateSample(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const photos = Array.isArray(source.photos)
    ? source.photos.filter((item) => typeof item === "string")
    : (typeof source.photo === "string" && source.photo ? [source.photo] : []);
  const createdAt = Number.isNaN(Date.parse(source.createdAt)) ? new Date().toISOString() : new Date(source.createdAt).toISOString();
  const updatedAt = Number.isNaN(Date.parse(source.updatedAt)) ? createdAt : new Date(source.updatedAt).toISOString();
  const sample = {
    id: typeof source.id === "string" && source.id ? source.id : crypto.randomUUID(),
    code: typeof source.code === "string" ? source.code : "",
    location: typeof source.location === "string" ? source.location : "",
    magnification: typeof source.magnification === "string" ? source.magnification : "",
    polarization: POLARIZATIONS.includes(source.polarization) ? source.polarization : POLARIZATIONS[0],
    minerals: typeof source.minerals === "string" ? source.minerals : "",
    texture: typeof source.texture === "string" ? source.texture : "",
    comment: typeof source.comment === "string" ? source.comment : "",
    photos,
    status: STATUS_VALUES.includes(source.status) ? source.status : "pending",
    reviewer: typeof source.reviewer === "string" ? source.reviewer : "",
    revisionNote: typeof source.revisionNote === "string" ? source.revisionNote : "",
    versions: Array.isArray(source.versions)
      ? source.versions.filter((v) => v && typeof v === "object" && v.snapshot && typeof v.snapshot === "object")
      : [],
    createdAt,
    updatedAt
  };
  if (!sample.versions.length) {
    sample.versions = [{ savedAt: createdAt, reviewer: sample.reviewer, note: "初始录入", snapshot: snapshotOf(sample) }];
  }
  return sample;
}

function loadState() {
  let raw = {};
  try {
    raw = JSON.parse(localStorage.getItem(storageKey) || "{}");
  } catch {
    raw = {};
  }
  return {
    samples: Array.isArray(raw.samples) ? raw.samples.map(migrateSample) : [],
    compare: Array.isArray(raw.compare) ? raw.compare.filter((id) => typeof id === "string") : [],
    filters: {
      mineral: "", polarization: "", status: "", from: "", to: "",
      ...(raw.filters && typeof raw.filters === "object" ? raw.filters : {})
    }
  };
}

const state = loadState();

function save() {
  localStorage.setItem(storageKey, JSON.stringify(state));
}

/* ---------- DOM 引用 ---------- */

const form = document.querySelector("#sampleForm");
const formTitle = document.querySelector("#formTitle");
const formHint = document.querySelector("#formHint");
const submitBtn = document.querySelector("#submitBtn");
const cancelEditBtn = document.querySelector("#cancelEditBtn");
const statusSelect = document.querySelector("#statusSelect");
const photoInput = document.querySelector("#photoInput");
const photoTray = document.querySelector("#photoTray");
const sampleGrid = document.querySelector("#sampleGrid");
const comparePane = document.querySelector("#comparePane");
const compareSummary = document.querySelector("#compareSummary");
const compareCount = document.querySelector("#compareCount");
const resultCount = document.querySelector("#resultCount");
const notice = document.querySelector("#notice");
const mineralFilter = document.querySelector("#mineralFilter");
const polarFilter = document.querySelector("#polarFilter");
const statusFilter = document.querySelector("#statusFilter");
const dateFrom = document.querySelector("#dateFrom");
const dateTo = document.querySelector("#dateTo");
const resetFiltersBtn = document.querySelector("#resetFilters");
const importBtn = document.querySelector("#importBtn");
const importInput = document.querySelector("#importInput");
const importModal = document.querySelector("#importModal");
const importSummary = document.querySelector("#importSummary");
const importDetail = document.querySelector("#importDetail");
const importBlockReason = document.querySelector("#importBlockReason");
const confirmImportBtn = document.querySelector("#confirmImport");
const cancelImportBtn = document.querySelector("#cancelImport");

let editingId = null;
let pendingPhotos = [];   // 本次新选、尚未保存的照片
let existingPhotos = [];  // 编辑时保留的已有照片
let importPlan = null;
const expandedVersions = new Set();

let noticeTimer = 0;
function showNotice(text, isError = false) {
  notice.textContent = text;
  notice.hidden = false;
  notice.classList.toggle("error", isError);
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 4200);
}

/* ---------- 表单（录入 / 编辑） ---------- */

const HINT_NEW = "新样本一律从「待鉴定」开始；保存后可通过编辑将其转为已复核或需补充（需填写审核人），定型后状态不可再变更。";
const HINT_PENDING_EDIT = "该记录仍为待鉴定，可自由修改；也可直接转为已复核或需补充（需填写审核人）。";
const hintFinalized = (status) => `该记录已定型（${STATUS_FLOW[status]}），状态不可再变更；保存修改将生成新版本，需填写修订说明。`;

function readFileAsDataUrl(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(typeof reader.result === "string" ? reader.result : ""));
    reader.readAsDataURL(file);
  });
}

function renderPhotoTray() {
  const items = [
    ...existingPhotos.map((src, i) => ({ src, kind: "existing", index: i })),
    ...pendingPhotos.map((src, i) => ({ src, kind: "pending", index: i }))
  ];
  photoTray.innerHTML = items.map((item) => `
    <span class="thumb">
      <img src="${esc(item.src)}" alt="待保存照片">
      <button type="button" data-remove-kind="${item.kind}" data-remove-index="${item.index}" title="移除这张照片">×</button>
    </span>
  `).join("");
}

function resetForm() {
  editingId = null;
  pendingPhotos = [];
  existingPhotos = [];
  photoInput.value = "";
  form.reset();
  statusSelect.disabled = true; // 新建模式锁定为待鉴定
  statusSelect.value = "pending";
  formTitle.textContent = "样本录入";
  submitBtn.textContent = "保存样本";
  formHint.textContent = HINT_NEW;
  cancelEditBtn.hidden = true;
  renderPhotoTray();
}

function startEdit(id) {
  const sample = state.samples.find((item) => item.id === id);
  if (!sample) return;
  editingId = id;
  pendingPhotos = [];
  existingPhotos = [...sample.photos];
  photoInput.value = "";
  form.elements.code.value = sample.code;
  form.elements.location.value = sample.location;
  form.elements.magnification.value = sample.magnification;
  form.elements.polarization.value = sample.polarization;
  form.elements.minerals.value = sample.minerals;
  form.elements.texture.value = sample.texture;
  form.elements.comment.value = sample.comment;
  form.elements.reviewer.value = sample.reviewer;
  form.elements.revisionNote.value = "";
  statusSelect.value = sample.status;
  statusSelect.disabled = sample.status !== "pending";
  formTitle.textContent = `编辑样本 ${sample.code}`;
  submitBtn.textContent = "保存修改";
  formHint.textContent = sample.status === "pending" ? HINT_PENDING_EDIT : hintFinalized(sample.status);
  cancelEditBtn.hidden = false;
  renderPhotoTray();
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function fieldsChanged(sample, fields) {
  return sample.code !== fields.code
    || sample.location !== fields.location
    || sample.magnification !== fields.magnification
    || sample.polarization !== fields.polarization
    || sample.minerals !== fields.minerals
    || sample.texture !== fields.texture
    || sample.comment !== fields.comment
    || sample.reviewer !== fields.reviewer
    || sample.photos.length !== fields.photos.length
    || sample.photos.some((photo, i) => photo !== fields.photos[i]);
}

photoInput.addEventListener("change", async () => {
  const files = [...photoInput.files];
  photoInput.value = "";
  if (!files.length) return;
  const room = MAX_PHOTOS - existingPhotos.length - pendingPhotos.length;
  if (room <= 0) {
    showNotice(`每个样本最多保存 ${MAX_PHOTOS} 张照片`, true);
    return;
  }
  if (files.length > room) {
    showNotice(`超出照片上限，已只保留前 ${room} 张`, true);
  }
  const urls = await Promise.all(files.slice(0, room).map(readFileAsDataUrl));
  pendingPhotos.push(...urls.filter(Boolean));
  renderPhotoTray();
});

photoTray.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-kind]");
  if (!button) return;
  const index = Number(button.dataset.removeIndex);
  if (button.dataset.removeKind === "existing") {
    existingPhotos.splice(index, 1);
  } else {
    pendingPhotos.splice(index, 1);
  }
  renderPhotoTray();
});

cancelEditBtn.addEventListener("click", resetForm);

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const fields = {
    code: String(data.get("code") || "").trim(),
    location: String(data.get("location") || "").trim(),
    magnification: String(data.get("magnification") || "").trim(),
    polarization: POLARIZATIONS.includes(data.get("polarization")) ? data.get("polarization") : POLARIZATIONS[0],
    minerals: String(data.get("minerals") || "").trim(),
    texture: String(data.get("texture") || "").trim(),
    comment: String(data.get("comment") || "").trim(),
    reviewer: String(data.get("reviewer") || "").trim(),
    revisionNote: String(data.get("revisionNote") || "").trim(),
    photos: [...existingPhotos, ...pendingPhotos]
  };
  if (!fields.code) {
    showNotice("请填写样本编号", true);
    return;
  }
  const duplicate = state.samples.find((item) => item.code === fields.code && item.id !== editingId);
  if (duplicate) {
    showNotice(`样本编号 ${fields.code} 已存在`, true);
    return;
  }

  if (!editingId) {
    // 新建样本一律从待鉴定开始（下拉框已禁用，这里再兜底）
    const status = "pending";
    const now = new Date().toISOString();
    const sample = {
      id: crypto.randomUUID(),
      ...fields,
      status,
      revisionNote: fields.revisionNote,
      versions: [],
      createdAt: now,
      updatedAt: now
    };
    sample.versions = [{ savedAt: now, reviewer: sample.reviewer, note: "初始录入", snapshot: snapshotOf(sample) }];
    state.samples.unshift(sample);
    save();
    render();
    resetForm();
    showNotice(`已保存样本 ${sample.code}（${STATUS_FLOW[status]}）`);
    return;
  }

  const sample = state.samples.find((item) => item.id === editingId);
  if (!sample) {
    resetForm();
    return;
  }
  // 状态机：已定型记录不允许再变更状态（下拉框已禁用，这里再兜底）
  const targetStatus = sample.status !== "pending" ? sample.status
    : (STATUS_VALUES.includes(statusSelect.value) ? statusSelect.value : "pending");
  if (sample.status === "pending" && targetStatus !== "pending" && !fields.reviewer) {
    showNotice("转为已复核或需补充时，需填写审核人", true);
    return;
  }

  if (sample.status !== "pending") {
    // 已定型记录：有实际改动才生成新版本
    if (!fieldsChanged(sample, fields)) {
      showNotice("没有检测到改动");
      resetForm();
      return;
    }
    if (!fields.revisionNote) {
      showNotice("修改已定型记录需填写修订说明", true);
      return;
    }
    Object.assign(sample, fields, { status: targetStatus });
    sample.updatedAt = new Date().toISOString();
    sample.versions.push(makeVersion(sample, fields.revisionNote, fields.reviewer));
    save();
    render();
    resetForm();
    showNotice(`已保存修改，${sample.code} 现为 v${sample.versions.length}`);
    return;
  }

  // 待鉴定记录：自由修改，不产生版本
  Object.assign(sample, fields, { status: targetStatus });
  sample.updatedAt = new Date().toISOString();
  save();
  render();
  resetForm();
  showNotice(targetStatus === "pending" ? `已保存样本 ${sample.code}` : `已保存，${sample.code} 标记为${STATUS_FLOW[targetStatus]}`);
});

/* ---------- 筛选 ---------- */

function filteredSamples() {
  const f = state.filters;
  return state.samples.filter((sample) => {
    if (f.mineral && !sample.minerals.includes(f.mineral)) return false;
    if (f.polarization && sample.polarization !== f.polarization) return false;
    if (f.status && sample.status !== f.status) return false;
    const day = localDateStr(sample.createdAt);
    if (f.from && day < f.from) return false;
    if (f.to && day > f.to) return false;
    return true;
  });
}

const filterBindings = [
  [mineralFilter, "mineral"],
  [polarFilter, "polarization"],
  [statusFilter, "status"],
  [dateFrom, "from"],
  [dateTo, "to"]
];

filterBindings.forEach(([element, key]) => {
  element.addEventListener("input", () => {
    state.filters[key] = element.value;
    save();
    render();
  });
});

resetFiltersBtn.addEventListener("click", () => {
  state.filters = { mineral: "", polarization: "", status: "", from: "", to: "" };
  filterBindings.forEach(([element, key]) => { element.value = state.filters[key]; });
  save();
  render();
});

/* ---------- 渲染 ---------- */

function versionsHtml(sample) {
  return sample.versions.map((version, index) => {
    const snap = version.snapshot || {};
    return `<li>
      <strong>v${index + 1}</strong> · ${esc(fmtTime(version.savedAt))}${version.reviewer ? ` · 审核人：${esc(version.reviewer)}` : ""}
      ${version.note ? `<br>说明：${esc(version.note)}` : ""}
      <br><span class="muted">${esc(snap.polarization || "")} · 矿物：${esc(snap.minerals || "未记录")} · 状态：${esc(STATUS_FLOW[snap.status] || "待鉴定")}</span>
    </li>`;
  }).reverse().join("");
}

function sampleCardHtml(sample) {
  return `
  <article class="sample-card">
    <div class="photo-wrap">
      ${sample.photos[0]
        ? `<img src="${esc(sample.photos[0])}" alt="${esc(sample.code)}显微照片">`
        : `<div class="photo-placeholder">暂无照片</div>`}
      ${sample.photos.length > 1 ? `<span class="photo-count">共 ${sample.photos.length} 张</span>` : ""}
    </div>
    <div class="sample-body">
      <h3>${esc(sample.code)} <span class="badge status-${sample.status}">${STATUS_FLOW[sample.status]}</span></h3>
      <p class="muted">v${sample.versions.length} · 录入 ${fmtDate(sample.createdAt)} · 更新 ${fmtDate(sample.updatedAt)}</p>
      <p>${esc(sample.location || "未记录地点")} · ${esc(sample.magnification || "未记录倍数")} · ${esc(sample.polarization)}</p>
      <p>矿物：${esc(sample.minerals || "未记录")}</p>
      <p>结构：${esc(sample.texture || "未记录")}</p>
      <p>批注：${esc(sample.comment || "未填写")}</p>
      ${sample.reviewer ? `<p>审核人：${esc(sample.reviewer)}</p>` : ""}
      ${sample.revisionNote ? `<p>修订说明：${esc(sample.revisionNote)}</p>` : ""}
      <div class="card-actions">
        <label><input type="checkbox" data-compare="${sample.id}" ${state.compare.includes(sample.id) ? "checked" : ""}>对比</label>
        <button type="button" data-edit="${sample.id}">编辑</button>
        <button type="button" data-versions="${sample.id}">版本</button>
        <button type="button" data-delete="${sample.id}">删除</button>
      </div>
      ${expandedVersions.has(sample.id) ? `<ol class="versions">${versionsHtml(sample)}</ol>` : ""}
    </div>
  </article>`;
}

const chip = (text) => `<span class="chip">${esc(text)}</span>`;

function compareSummaryHtml(list) {
  if (list.length < 2) return "";
  const sets = list.map((sample) => splitMinerals(sample.minerals));
  const common = sets[0].filter((mineral) => sets.every((set) => set.includes(mineral)));
  const perSample = list.map((sample, i) => ({
    code: sample.code,
    diff: sets[i].filter((mineral) => !common.includes(mineral))
  }));
  const polarizations = new Set(list.map((sample) => sample.polarization));
  const textures = new Set(list.map((sample) => sample.texture));
  return `
    <p><strong>共同矿物：</strong>${common.length ? common.map(chip).join("") : '<span class="muted">无</span>'}</p>
    <p><strong>差异矿物（非全员共有）：</strong></p>
    <ul>${perSample.map((item) => `<li>${esc(item.code)}：${item.diff.length ? item.diff.map(chip).join("") : '<span class="muted">无</span>'}</li>`).join("")}</ul>
    ${polarizations.size > 1 ? '<p class="muted">偏光类型不一致</p>' : ""}
    ${textures.size > 1 ? '<p class="muted">颗粒结构记录不一致</p>' : ""}
  `;
}

function renderCompare() {
  const validIds = state.compare.filter((id) => state.samples.some((sample) => sample.id === id));
  if (validIds.length !== state.compare.length) {
    state.compare = validIds;
    save();
  }
  const list = state.compare
    .map((id) => state.samples.find((sample) => sample.id === id))
    .filter(Boolean)
    .slice(0, MAX_COMPARE);
  compareCount.textContent = list.length ? `已选 ${list.length}/${MAX_COMPARE}` : "";
  compareSummary.innerHTML = compareSummaryHtml(list);
  comparePane.innerHTML = list.length ? list.map((sample) => `
    <article class="compare-item">
      ${sample.photos[0] ? `<img src="${esc(sample.photos[0])}" alt="${esc(sample.code)}对比图">` : '<div class="photo-placeholder">暂无照片</div>'}
      <h3>${esc(sample.code)} <span class="badge status-${sample.status}">${STATUS_FLOW[sample.status]}</span></h3>
      <p>${esc(sample.polarization)} · ${esc(sample.magnification || "未记录倍数")}</p>
      <p>矿物：${esc(sample.minerals || "未记录")}</p>
      <p>结构：${esc(sample.texture || "未记录")}</p>
      <button type="button" class="secondary" data-uncompare="${sample.id}">移出对比</button>
    </article>
  `).join("") : `<p class="muted">勾选样本卡片上的「对比」即可并排查看，最多 ${MAX_COMPARE} 张，并自动汇总共同矿物与差异。</p>`;
}

function render() {
  const rows = filteredSamples();
  resultCount.textContent = `共 ${rows.length} 条记录（全部 ${state.samples.length} 条）`;
  sampleGrid.innerHTML = rows.length
    ? rows.map(sampleCardHtml).join("")
    : "<p>没有符合筛选条件的样本。</p>";
  renderCompare();
}

/* ---------- 卡片操作 ---------- */

sampleGrid.addEventListener("click", (event) => {
  const deleteId = event.target.dataset.delete;
  if (deleteId) {
    const sample = state.samples.find((item) => item.id === deleteId);
    if (!sample) return;
    if (sample.status !== "pending"
      && !window.confirm(`「${sample.code}」已定型（${STATUS_FLOW[sample.status]}），删除将一并删除其版本记录，确认删除？`)) {
      return;
    }
    state.samples = state.samples.filter((item) => item.id !== deleteId);
    state.compare = state.compare.filter((id) => id !== deleteId);
    expandedVersions.delete(deleteId);
    if (editingId === deleteId) resetForm();
    save();
    render();
    showNotice(`已删除 ${sample.code}`);
    return;
  }

  const editId = event.target.dataset.edit;
  if (editId) {
    startEdit(editId);
    return;
  }

  const versionsId = event.target.dataset.versions;
  if (versionsId) {
    if (expandedVersions.has(versionsId)) {
      expandedVersions.delete(versionsId);
    } else {
      expandedVersions.add(versionsId);
    }
    render();
  }
});

sampleGrid.addEventListener("change", (event) => {
  const id = event.target.dataset.compare;
  if (!id) return;
  if (event.target.checked) {
    if (state.compare.length >= MAX_COMPARE) {
      event.target.checked = false;
      showNotice(`最多同时对比 ${MAX_COMPARE} 张样本`, true);
      return;
    }
    state.compare = [...state.compare, id];
  } else {
    state.compare = state.compare.filter((item) => item !== id);
  }
  save();
  render();
});

comparePane.addEventListener("click", (event) => {
  const id = event.target.dataset.uncompare;
  if (!id) return;
  state.compare = state.compare.filter((item) => item !== id);
  save();
  render();
});

/* ---------- 导出 ---------- */

function exportRow(sample) {
  return {
    样本编号: sample.code,
    采样地点: sample.location,
    放大倍数: sample.magnification,
    偏光类型: sample.polarization,
    主要矿物: sample.minerals,
    颗粒结构: sample.texture,
    老师批注: sample.comment,
    鉴定状态: STATUS_FLOW[sample.status],
    审核人: sample.reviewer,
    修订说明: sample.revisionNote,
    照片: sample.photos,
    录入时间: sample.createdAt,
    更新时间: sample.updatedAt,
    版本: sample.versions.length,
    历史版本: sample.versions.map((version, index) => ({
      版本: index + 1,
      保存时间: version.savedAt,
      审核人: version.reviewer,
      修订说明: version.note,
      快照: {
        样本编号: version.snapshot.code,
        采样地点: version.snapshot.location,
        放大倍数: version.snapshot.magnification,
        偏光类型: version.snapshot.polarization,
        主要矿物: version.snapshot.minerals,
        颗粒结构: version.snapshot.texture,
        老师批注: version.snapshot.comment,
        鉴定状态: STATUS_FLOW[version.snapshot.status] || "待鉴定",
        审核人: version.snapshot.reviewer,
        照片: version.snapshot.photos
      }
    }))
  };
}

document.querySelector("#exportBtn").addEventListener("click", () => {
  const payload = state.samples.map(exportRow);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "thin-section-checklist.json";
  link.click();
  URL.revokeObjectURL(link.href);
  showNotice(`已导出 ${payload.length} 条记录`);
});

/* ---------- 导入（预览 → 确认 → 原子写入） ---------- */

function asText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return null; // 对象、布尔等视为不合法
}

function parseIsoDate(value) {
  if (value == null || value === "") return "";
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function parsePhotos(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
  if (value.length > MAX_PHOTOS) return null;
  return value;
}

function sanitizeVersionEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const snap = entry["快照"];
  if (!snap || typeof snap !== "object") return null;
  const photos = parsePhotos(snap["照片"]);
  return {
    savedAt: parseIsoDate(entry["保存时间"]) || "",
    reviewer: asText(entry["审核人"]) || "",
    note: asText(entry["修订说明"]) || "",
    snapshot: {
      code: asText(snap["样本编号"]) || "",
      location: asText(snap["采样地点"]) || "",
      magnification: asText(snap["放大倍数"]) || "",
      polarization: POLARIZATIONS.includes(snap["偏光类型"]) ? snap["偏光类型"] : POLARIZATIONS[0],
      minerals: asText(snap["主要矿物"]) || "",
      texture: asText(snap["颗粒结构"]) || "",
      comment: asText(snap["老师批注"]) || "",
      photos: photos || [],
      status: STATUS_BY_LABEL[asText(snap["鉴定状态"])] || "pending",
      reviewer: asText(snap["审核人"]) || ""
    }
  };
}

// 返回 { draft } 或 { error }
function parseImportRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return { error: "记录不是有效的对象" };
  }
  const code = asText(row["样本编号"]);
  if (!code) return { error: "缺少样本编号" };

  const textFields = {};
  for (const [key, label] of [["采样地点", "location"], ["放大倍数", "magnification"], ["颗粒结构", "texture"], ["老师批注", "comment"], ["审核人", "reviewer"], ["修订说明", "revisionNote"]]) {
    const value = asText(row[key]);
    if (value === null) return { error: `「${key}」格式不合法` };
    textFields[label] = value;
  }

  let minerals = "";
  const rawMinerals = row["主要矿物"];
  if (Array.isArray(rawMinerals)) {
    if (!rawMinerals.every((item) => typeof item === "string")) return { error: "「主要矿物」格式不合法" };
    minerals = rawMinerals.map((item) => item.trim()).filter(Boolean).join("、");
  } else {
    const value = asText(rawMinerals);
    if (value === null) return { error: "「主要矿物」格式不合法" };
    minerals = value;
  }

  const polarization = asText(row["偏光类型"]);
  if (polarization === null) return { error: "「偏光类型」格式不合法" };
  if (polarization && !POLARIZATIONS.includes(polarization)) {
    return { error: `「偏光类型」只能是：${POLARIZATIONS.join("、")}` };
  }

  const statusLabel = asText(row["鉴定状态"]);
  if (statusLabel === null) return { error: "「鉴定状态」格式不合法" };
  const status = statusLabel ? STATUS_BY_LABEL[statusLabel] : "pending";
  if (!status) return { error: `「鉴定状态」只能是：${Object.values(STATUS_FLOW).join("、")}` };
  if (status !== "pending" && !textFields.reviewer) {
    return { error: "已复核或需补充的记录必须填写审核人" };
  }

  const photos = parsePhotos(row["照片"]);
  if (photos === null) return { error: `「照片」必须是字符串数组，且不超过 ${MAX_PHOTOS} 张` };

  const createdAt = parseIsoDate(row["录入时间"]);
  if (createdAt === null) return { error: "「录入时间」不是有效日期" };
  const updatedAt = parseIsoDate(row["更新时间"]);
  if (updatedAt === null) return { error: "「更新时间」不是有效日期" };

  let versions = null;
  if (row["历史版本"] != null) {
    if (!Array.isArray(row["历史版本"])) return { error: "「历史版本」必须是数组" };
    versions = row["历史版本"].map(sanitizeVersionEntry).filter(Boolean);
  }

  return {
    draft: {
      code,
      ...textFields,
      minerals,
      polarization: polarization || POLARIZATIONS[0],
      status,
      photos,
      createdAt,
      updatedAt,
      versions
    }
  };
}

function sameContent(sample, draft) {
  return sample.code === draft.code
    && sample.location === draft.location
    && sample.magnification === draft.magnification
    && sample.polarization === draft.polarization
    && sample.texture === draft.texture
    && sample.comment === draft.comment
    && sample.status === draft.status
    && sample.reviewer === draft.reviewer
    && sample.revisionNote === draft.revisionNote
    && sameTokens(sample.minerals, draft.minerals)
    && sample.photos.length === draft.photos.length
    && sample.photos.every((photo, i) => photo === draft.photos[i]);
}

function buildImportPlan(rows) {
  const plan = { news: [], updates: [], conflicts: [], invalid: [], unchanged: [] };
  const byCode = new Map(state.samples.map((sample) => [sample.code, sample]));
  const seenInFile = new Set();
  rows.forEach((row, index) => {
    const line = `第 ${index + 1} 行`;
    const result = parseImportRow(row);
    if (result.error) {
      plan.invalid.push({ label: line, reason: result.error });
      return;
    }
    const draft = result.draft;
    if (seenInFile.has(draft.code)) {
      plan.invalid.push({ label: `${line}（${draft.code}）`, reason: "文件内样本编号重复" });
      return;
    }
    seenInFile.add(draft.code);
    const existing = byCode.get(draft.code);
    if (!existing) {
      plan.news.push(draft);
    } else if (sameContent(existing, draft)) {
      plan.unchanged.push(draft.code);
    } else if (existing.status !== "pending") {
      plan.conflicts.push({ code: draft.code, reason: `本地记录已定型（${STATUS_FLOW[existing.status]}），不能由导入覆盖` });
    } else {
      plan.updates.push({ id: existing.id, draft });
    }
  });
  return plan;
}

function draftToFields(draft) {
  return {
    code: draft.code,
    location: draft.location,
    magnification: draft.magnification,
    polarization: draft.polarization,
    minerals: draft.minerals,
    texture: draft.texture,
    comment: draft.comment,
    reviewer: draft.reviewer,
    revisionNote: draft.revisionNote,
    photos: draft.photos,
    status: draft.status
  };
}

function applyImport(plan) {
  const now = new Date().toISOString();
  const updatesById = new Map(plan.updates.map((item) => [item.id, item.draft]));
  // 一次计算出完整新数组，再单次赋值、单次落盘，保证不产生部分结果
  const nextSamples = state.samples.map((sample) => {
    const draft = updatesById.get(sample.id);
    if (!draft) return sample;
    return {
      ...sample,
      ...draftToFields(draft),
      versions: draft.versions && draft.versions.length ? draft.versions : sample.versions,
      updatedAt: draft.updatedAt || now
    };
  });
  const created = plan.news.map((draft) => {
    const sample = {
      id: crypto.randomUUID(),
      ...draftToFields(draft),
      createdAt: draft.createdAt || now,
      updatedAt: draft.updatedAt || now,
      versions: []
    };
    sample.versions = draft.versions && draft.versions.length
      ? draft.versions
      : [{ savedAt: sample.createdAt, reviewer: sample.reviewer, note: "初始录入", snapshot: snapshotOf(sample) }];
    return sample;
  });
  state.samples = [...created, ...nextSamples];
  save();
}

function openImportPreview(plan) {
  importPlan = plan;
  const blocked = plan.invalid.length > 0 || plan.conflicts.length > 0;
  importSummary.textContent =
    `新增 ${plan.news.length} 条 · 更新 ${plan.updates.length} 条 · 冲突 ${plan.conflicts.length} 条` +
    ` · 不合法 ${plan.invalid.length} 条 · 未变化 ${plan.unchanged.length} 条`;
  const rows = [
    ...plan.news.map((draft) => `<li><span class="tag tag-new">新增</span>${esc(draft.code)}</li>`),
    ...plan.updates.map((item) => `<li><span class="tag tag-update">更新</span>${esc(item.draft.code)}</li>`),
    ...plan.conflicts.map((item) => `<li><span class="tag tag-conflict">冲突</span>${esc(item.code)}：${esc(item.reason)}</li>`),
    ...plan.invalid.map((item) => `<li><span class="tag tag-invalid">不合法</span>${esc(item.label)}：${esc(item.reason)}</li>`),
    ...plan.unchanged.map((code) => `<li><span class="tag tag-same">未变化</span>${esc(code)}</li>`)
  ];
  importDetail.innerHTML = rows.join("") || "<li>文件中没有记录。</li>";
  importBlockReason.hidden = !blocked;
  confirmImportBtn.disabled = blocked || (plan.news.length + plan.updates.length === 0);
  importModal.hidden = false;
}

function closeImportPreview() {
  importModal.hidden = true;
  importPlan = null;
  importInput.value = "";
}

importBtn.addEventListener("click", () => importInput.click());

importInput.addEventListener("change", async () => {
  const file = importInput.files[0];
  if (!file) return;
  let rows;
  try {
    const parsed = JSON.parse(await file.text());
    if (!Array.isArray(parsed)) throw new Error("not an array");
    rows = parsed;
  } catch {
    showNotice("导入失败：文件不是有效的 JSON 清单（应为记录数组）", true);
    importInput.value = "";
    return;
  }
  openImportPreview(buildImportPlan(rows));
});

confirmImportBtn.addEventListener("click", () => {
  if (!importPlan || confirmImportBtn.disabled) return;
  const { news, updates } = importPlan;
  applyImport(importPlan);
  closeImportPreview();
  render();
  showNotice(`导入完成：新增 ${news.length} 条，更新 ${updates.length} 条`);
});

cancelImportBtn.addEventListener("click", closeImportPreview);

/* ---------- 初始化 ---------- */

filterBindings.forEach(([element, key]) => { element.value = state.filters[key]; });
resetForm();
render();
