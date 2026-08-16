/* chatmany web UI (Section 7A). Vanilla JS SPA served from the Worker. A single-owner token
   (stored in localStorage) authorizes every /api call. The UI is a config editor + monitor over
   the same campaigns/events/conversations tables the engine uses — no new funnel behavior. */

const TOKEN_KEY = "chatmany_token";
const GH_URL = "https://github.com/";

const store = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  status: null,
  page: "automations",
  media: [],
  campaigns: [],
  automationStats: {}, // campaign_id -> { runs, ctr }
  draft: null,
  // JSON snapshot of the draft as it was last loaded or saved. Anything different
  // means there are unsaved edits — see isDirty(). Snapshotting the whole draft
  // catches click-driven toggles too, not just typed input.
  savedSnapshot: null,
  previewTab: "dm",
  captionExpanded: false,
  dash: null,
  contacts: [],
  dashDays: 30,
  dashCampaign: "",
  contactsCampaign: "",
  automationsSearch: "",
  automationsState: "",
  selectedAutomations: new Set(),
  archiveCampaigns: [],
  archiveSearch: "",
  mediaShowAll: false,
};

const $ = (sel, root = document) => root.querySelector(sel);
const el = (html) => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const slug = (s) =>
  String(s || "campaign").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "campaign";

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${store.token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    store.token = "";
    localStorage.removeItem(TOKEN_KEY);
    renderLogin("Session token was rejected. Enter it again.");
    throw new Error("unauthorized");
  }
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

function toast(msg, isErr = false) {
  const t = el(`<div class="toast ${isErr ? "err" : ""}">${esc(msg)}</div>`);
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 250);
  }, 2400);
}

/* ---------------- icons ---------------- */
const ICON = {
  spark: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 3 14h7l-1 8 10-12h-7z"/></svg>`,
  create: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/></svg>`,
  automations: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7z"/></svg>`,
  folder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>`,
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>`,
  grid: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`,
  dashboard: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>`,
  contacts: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  github: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49 0-.24-.01-.87-.01-1.71-2.78.62-3.37-1.22-3.37-1.22-.46-1.18-1.11-1.49-1.11-1.49-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.55-1.14-4.55-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05a9.3 9.3 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.33 4.81-4.56 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.6.69.49A10.02 10.02 0 0 0 22 12.25C22 6.58 17.52 2 12 2z"/></svg>`,
  heart: `<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M12 21s-7-4.35-9.5-8.5C.5 9 2 5.5 5.5 5.5c2 0 3.2 1.2 3.5 2 .3-.8 1.5-2 3.5-2 3.5 0 5 3.5 3 7C19 16.65 12 21 12 21z"/></svg>`,
  heartO: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M12 21s-7-4.35-9.5-8.5C.5 9 2 5.5 5.5 5.5c2 0 3.2 1.2 3.5 2 .3-.8 1.5-2 3.5-2 3.5 0 5 3.5 3 7C19 16.65 12 21 12 21z"/></svg>`,
  cmt: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5z"/></svg>`,
  send: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>`,
  inbox: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13l3.5 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/></svg>`,
  archive: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>`,
};

/* ---------------- boot ---------------- */
async function boot() {
  if (!store.token) return renderLogin();
  try {
    store.status = await api("/api/status");
  } catch {
    return; // renderLogin already shown on 401
  }
  renderApp();
}

/* ---------------- login / connect ---------------- */
function renderLogin(err) {
  document.title = "chatmany — sign in";
  const app = $("#app");
  app.innerHTML = "";
  const card = el(`
    <div class="login-wrap"><div class="login-card">
      <div class="brand"><span class="spark">${ICON.spark}</span><span class="name">chatmany</span></div>
      <h2>Owner sign in</h2>
      <p>Enter the owner token you set as the <code>OWNER_TOKEN</code> secret.</p>
      ${err ? `<div class="banner">${esc(err)}</div>` : ""}
      <label class="field"><span class="label">Owner token</span>
        <input type="password" id="tok" placeholder="Your OWNER_TOKEN" autocomplete="off" /></label>
      <button class="btn primary" id="go" style="width:100%">Continue</button>
    </div></div>`);
  app.appendChild(card);
  const submit = async () => {
    const val = $("#tok").value.trim();
    if (!val) return;
    store.token = val;
    try {
      store.status = await api("/api/status");
      localStorage.setItem(TOKEN_KEY, val);
      renderApp();
    } catch {
      /* 401 handled */
    }
  };
  $("#go").onclick = submit;
  $("#tok").onkeydown = (e) => {
    if (e.key === "Enter") submit();
  };
}

/* ---------------- app shell ---------------- */
function renderApp() {
  document.title = "chatmany";
  const s = store.status || {};
  const app = $("#app");
  app.innerHTML = "";
  const layout = el(`
    <div class="layout">
      <aside class="sidebar">
        <div class="brand"><span class="spark">${ICON.spark}</span><span class="name">chatmany</span></div>
        <nav class="nav">
          <button class="nav-item" data-page="automations">${ICON.automations}<span>Automations</span></button>
          <button class="nav-item" data-page="create">${ICON.create}<span>Create</span></button>
          <button class="nav-item" data-page="dashboard">${ICON.dashboard}<span>Dashboard</span></button>
          <button class="nav-item" data-page="contacts">${ICON.contacts}<span>Contacts</span></button>
          <button class="nav-item" data-page="archive">${ICON.archive}<span>Archive</span></button>
        </nav>
        <div class="sidebar-footer">
          <div class="profile">
            <img class="avatar" src="${s.profile_picture_url || ""}" alt="" onerror="this.style.visibility='hidden'"/>
            <div class="who">
              <div class="handle">${s.connected ? "@" + esc(s.username || "account") : "Not connected"}</div>
              <span class="tag">self-hosted</span>
            </div>
          </div>
          <a class="gh-link" href="${GH_URL}" target="_blank" rel="noopener">${ICON.github}<span>Star on GitHub</span></a>
          <div class="legal-links">
            <a href="/privacy" target="_blank" rel="noopener">Privacy</a>
            <span>·</span>
            <a href="/data-deletion" target="_blank" rel="noopener">Data deletion</a>
          </div>
        </div>
      </aside>
      <main class="main"><div class="main-wrap" id="view"></div></main>
    </div>`);
  app.appendChild(layout);
  layout.querySelectorAll(".nav-item").forEach((b) => {
    b.onclick = () => {
      if (store.page === "create" && b.dataset.page !== "create" && !confirmDiscard("leave this page")) return;
      store.page = b.dataset.page;
      paintNav();
      route();
    };
  });
  paintNav();
  route();
}

function paintNav() {
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.page === store.page));
}

function connectBanner() {
  const s = store.status || {};
  if (s.connected && !s.token_expired) return "";
  const msg = s.connected && s.token_expired ? "Your Instagram token expired — reconnect to resume." : "No Instagram account connected yet.";
  // /auth/authorize is owner-gated. A link navigation cannot send an Authorization header, so the
  // token goes in the query; the redirect it returns sets Referrer-Policy: no-referrer.
  const authorizeUrl = `/auth/authorize?token=${encodeURIComponent(store.token)}`;
  return `<div class="banner">${msg} <a href="${authorizeUrl}">Connect Instagram</a></div>`;
}

function route() {
  const view = $("#view");
  view.innerHTML = `<div class="empty">Loading…</div>`;
  if (store.page === "automations") renderAutomations();
  else if (store.page === "create") renderCreate();
  else if (store.page === "dashboard") renderDashboard();
  else if (store.page === "contacts") renderContacts();
  else if (store.page === "archive") renderArchive();
}

/** Relative time string ("4 hours ago") from a unix-seconds timestamp. */
function timeAgo(ts) {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

/** Open the Create builder pre-loaded with an existing campaign, or blank for a new one. */
function openInBuilder(campaign) {
  store.draft = campaign ? draftFromCampaign(campaign) : defaultDraft();
  markSaved();
  store.mediaShowAll = false;
  store.page = "create";
  paintNav();
  route();
}

/** Delete one or more campaigns by id, then refresh the automations list. */
async function deleteCampaigns(ids) {
  if (ids.length === 0) return;
  const label = ids.length === 1 ? "this automation" : `these ${ids.length} automations`;
  if (!confirm(`Delete ${label}? This can't be undone.`)) return;
  try {
    await Promise.all(ids.map((id) => api("/api/campaigns/delete", { method: "POST", body: { campaign_id: id } })));
    store.selectedAutomations.clear();
    toast(ids.length === 1 ? "Automation deleted" : `${ids.length} automations deleted`);
    renderAutomations();
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * Archive (or restore) one or more campaigns by id. Unlike delete, this is non-destructive —
 * archiving stops the automation and hides it from the main list, but keeps every conversation,
 * event, and comment record intact, and it can be restored from the Archive tab at any time.
 */
async function archiveCampaigns(ids, archived) {
  if (ids.length === 0) return;
  try {
    await Promise.all(ids.map((id) => api("/api/campaigns/archive", { method: "POST", body: { campaign_id: id, archived } })));
    store.selectedAutomations.clear();
    toast(
      archived
        ? ids.length === 1 ? "Automation archived" : `${ids.length} automations archived`
        : ids.length === 1 ? "Automation restored" : `${ids.length} automations restored`,
    );
    archived ? renderAutomations() : renderArchive();
  } catch (e) {
    toast(e.message, true);
  }
}

/* ================= AUTOMATIONS (list) ================= */
async function renderAutomations() {
  const view = $("#view");
  try {
    store.campaigns = (await api("/api/campaigns")).campaigns || [];
  } catch (e) {
    view.innerHTML = connectBanner() + `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  try {
    if (store.media.length === 0 && store.status.connected && !store.status.token_expired) {
      const r = await api("/api/media");
      store.media = r.media || [];
    }
  } catch {
    // thumbnails are a nice-to-have; don't block the list on a media fetch failure
  }

  // Pull lightweight all-time stats (runs = opening_sent, ctr = clicks/opens) per campaign.
  const statsEntries = await Promise.all(
    store.campaigns.map(async (c) => {
      try {
        const d = await api(`/api/dashboard?campaign_id=${encodeURIComponent(c.campaign_id)}&days=3650`);
        return [c.campaign_id, { runs: d.cards.sends, ctr: d.cards.ctr }];
      } catch {
        return [c.campaign_id, { runs: 0, ctr: 0 }];
      }
    }),
  );
  store.automationStats = Object.fromEntries(statsEntries);

  view.innerHTML = `
    ${connectBanner()}
    <div class="page-head">
      <div><div class="page-title">My automations</div><div class="page-sub">Every comment-to-DM funnel in this instance.</div></div>
      <button class="btn primary" id="newauto">+ New automation</button>
    </div>
    <div class="automations-toolbar">
      <div class="search-wrap">${ICON.search}<input class="search" id="autosearch" type="text" placeholder="Search all automations" value="${esc(store.automationsSearch)}"/></div>
      <select id="autotrigger"><option>Any trigger</option><option>Comment</option></select>
      <select id="autostate"><option value="">Any trigger states</option>
        <option value="live" ${store.automationsState === "live" ? "selected" : ""}>Live</option>
        <option value="stopped" ${store.automationsState === "stopped" ? "selected" : ""}>Stopped</option>
      </select>
    </div>
    <div class="automations-row2">
      <button class="folder-btn" id="newfolder">${ICON.folder} New folder</button>
      <button class="trash-link" id="trashlink">${ICON.archive} Archive</button>
    </div>
    <div class="automations-row3"><button class="grid-link" id="gridlink">${ICON.grid} View as grid</button></div>
    <div id="autolist"></div>`;

  $("#newauto").onclick = () => openInBuilder(null);
  $("#newfolder").onclick = () => toast("Folders are coming soon");
  $("#trashlink").onclick = () => { store.page = "archive"; paintNav(); route(); };
  $("#gridlink").onclick = () => toast("Grid view is coming soon");
  $("#autotrigger").onchange = () => {}; // only one trigger type exists today (comment); reserved for future triggers
  $("#autosearch").oninput = (e) => {
    store.automationsSearch = e.target.value;
    paintAutoList();
  };
  $("#autostate").onchange = (e) => {
    store.automationsState = e.target.value;
    paintAutoList();
  };

  paintAutoList();
}

function paintAutoList() {
  const box = $("#autolist");
  if (!box) return;
  const q = store.automationsSearch.trim().toLowerCase();
  const rows = store.campaigns.filter((c) => {
    if (q && !(c.name || c.campaign_id).toLowerCase().includes(q)) return false;
    if (store.automationsState === "live" && !c.active) return false;
    if (store.automationsState === "stopped" && c.active) return false;
    return true;
  });

  if (store.campaigns.length === 0) {
    box.innerHTML = `<div class="empty">${ICON.automations}<div>No automations yet. Click "+ New automation" to build your first comment-to-DM funnel.</div></div>`;
    return;
  }
  if (rows.length === 0) {
    box.innerHTML = `<div class="empty">No automations match your search.</div>`;
    return;
  }

  // Selection can only ever contain ids currently visible; drop any that scrolled out via filtering.
  const visibleIds = new Set(rows.map((c) => c.campaign_id));
  for (const id of [...store.selectedAutomations]) if (!visibleIds.has(id)) store.selectedAutomations.delete(id);
  const n = store.selectedAutomations.size;

  box.innerHTML = "";
  if (n > 0) {
    box.appendChild(
      el(`<div class="bulk-bar"><span>${n} selected</span><div class="spacer"></div>
        <button class="btn ghost sm" id="bulkarchive">${ICON.archive} Archive</button>
        <button class="btn danger sm" id="bulkdelete">${ICON.trash} Delete</button>
        <button class="btn ghost sm" id="bulkcancel">Cancel</button></div>`),
    );
  }
  box.appendChild(
    el(`<div class="auto-list-head"><span></span><span>Name ▾</span><span>Runs</span><span>CTR</span><span>Modified ▾</span></div>`),
  );
  rows.forEach((c) => {
    const thumb = (store.media.find((m) => m.id === c.media_id) || {}).thumbnail_url || "";
    const stats = store.automationStats[c.campaign_id] || { runs: 0, ctr: 0 };
    const kw = (c.keywords || [])[0] || "—";
    const checked = store.selectedAutomations.has(c.campaign_id);
    const row = el(`
      <div class="auto-row ${checked ? "selected" : ""}" data-id="${esc(c.campaign_id)}">
        <input type="checkbox" ${checked ? "checked" : ""}/>
        <div class="auto-name-cell">
          <div class="auto-name-line">
            <span class="status-pill ${c.active ? "live" : "stopped"}">${c.active ? "live" : "stopped"}</span>
            <span class="auto-name">${esc(c.name || c.campaign_id)}</span>
          </div>
          <div class="auto-trigger">
            ${thumb ? `<img src="${esc(thumb)}" alt=""/>` : ""}
            <span>User comments and comment contains</span>
            <span class="kw-pill">${esc(kw)}</span>
          </div>
        </div>
        <div><span class="num">${stats.runs}</span></div>
        <div><span class="num">${stats.runs > 0 ? stats.ctr + "%" : "n/a"}</span></div>
        <div class="muted">${timeAgo(c.updated_at)}</div>
      </div>`);
    row.querySelector('input[type="checkbox"]').onclick = (e) => {
      e.stopPropagation();
      if (e.target.checked) store.selectedAutomations.add(c.campaign_id);
      else store.selectedAutomations.delete(c.campaign_id);
      paintAutoList();
    };
    row.onclick = () => openInBuilder(c);
    box.appendChild(row);
  });

  const bulkArchive = $("#bulkarchive");
  if (bulkArchive) bulkArchive.onclick = (e) => { e.stopPropagation(); archiveCampaigns([...store.selectedAutomations], true); };
  const bulkDelete = $("#bulkdelete");
  if (bulkDelete) bulkDelete.onclick = (e) => { e.stopPropagation(); deleteCampaigns([...store.selectedAutomations]); };
  const bulkCancel = $("#bulkcancel");
  if (bulkCancel) bulkCancel.onclick = (e) => { e.stopPropagation(); store.selectedAutomations.clear(); paintAutoList(); };
}

/* ================= ARCHIVE ================= */
async function renderArchive() {
  const view = $("#view");
  try {
    store.archiveCampaigns = (await api("/api/campaigns?archived=1")).campaigns || [];
  } catch (e) {
    view.innerHTML = connectBanner() + `<div class="empty">${esc(e.message)}</div>`;
    return;
  }

  view.innerHTML = `
    ${connectBanner()}
    <div class="page-head">
      <div><div class="page-title">Archive</div><div class="page-sub">Stopped automations, kept out of the way but not deleted — restore any of them at any time.</div></div>
    </div>
    <div class="automations-toolbar">
      <div class="search-wrap">${ICON.search}<input class="search" id="archsearch" type="text" placeholder="Search archived automations" value="${esc(store.archiveSearch)}"/></div>
    </div>
    <div id="archlist"></div>`;

  $("#archsearch").oninput = (e) => {
    store.archiveSearch = e.target.value;
    paintArchiveList();
  };

  paintArchiveList();
}

function paintArchiveList() {
  const box = $("#archlist");
  if (!box) return;
  const q = store.archiveSearch.trim().toLowerCase();
  const rows = store.archiveCampaigns.filter((c) => !q || (c.name || c.campaign_id).toLowerCase().includes(q));

  if (store.archiveCampaigns.length === 0) {
    box.innerHTML = `<div class="empty">${ICON.archive}<div>Nothing archived. Archive an automation from the Automations tab to keep it around without it running.</div></div>`;
    return;
  }
  if (rows.length === 0) {
    box.innerHTML = `<div class="empty">No archived automations match your search.</div>`;
    return;
  }

  box.innerHTML = "";
  box.appendChild(
    el(`<div class="auto-list-head"><span></span><span>Name ▾</span><span></span><span></span><span>Archived ▾</span></div>`),
  );
  rows.forEach((c) => {
    const kw = (c.keywords || [])[0] || "—";
    const row = el(`
      <div class="auto-row archived-row" data-id="${esc(c.campaign_id)}">
        <span></span>
        <div class="auto-name-cell">
          <div class="auto-name-line">
            <span class="status-pill stopped">archived</span>
            <span class="auto-name">${esc(c.name || c.campaign_id)}</span>
          </div>
          <div class="auto-trigger"><span>User comments and comment contains</span><span class="kw-pill">${esc(kw)}</span></div>
        </div>
        <div></div>
        <div class="archive-actions">
          <button class="btn ghost sm" data-act="restore">Restore</button>
          <button class="btn danger sm" data-act="delete">Delete</button>
        </div>
        <div class="muted">${timeAgo(c.updated_at)}</div>
      </div>`);
    row.querySelector('[data-act="restore"]').onclick = (e) => {
      e.stopPropagation();
      archiveCampaigns([c.campaign_id], false);
    };
    row.querySelector('[data-act="delete"]').onclick = (e) => {
      e.stopPropagation();
      deleteFromArchive(c.campaign_id);
    };
    box.appendChild(row);
  });
}

/** Permanently delete an archived campaign, then refresh the archive list. */
async function deleteFromArchive(id) {
  if (!confirm("Permanently delete this automation? This can't be undone.")) return;
  try {
    await api("/api/campaigns/delete", { method: "POST", body: { campaign_id: id } });
    toast("Automation permanently deleted");
    renderArchive();
  } catch (e) {
    toast(e.message, true);
  }
}

/* ================= CREATE (builder) ================= */
function defaultDraft() {
  return {
    campaign_id: "",
    name: "My automation",
    media_id: "",
    media_thumb: "",
    keywords: ["Link"],
    exclude: [],
    public_reply: { enabled: false, texts: ["Sent you a DM! 📩", "Check your DMs 👀"] },
    opening_enabled: true,
    check_follow: false,
    ask_email: false,
    reward: { type: "link", value: "" },
    copy: {
      opening: "Hey! Tap below to grab the link 👇",
      opening_button: "Send it to me",
      follow_gate: "Make sure you're following so you don't miss the next one 🙌 Not following yet? Follow, then tap below.",
      follow_button: "✅ I followed",
      email_ask: "Want it in your inbox too? Tap your email or reply with it.",
      delivery: "Here you go 🎉 {reward}",
    },
    active: false,
  };
}

function draftFromCampaign(c) {
  return {
    campaign_id: c.campaign_id,
    name: c.name || c.campaign_id,
    media_id: c.media_id,
    media_thumb: (store.media.find((m) => m.id === c.media_id) || {}).thumbnail_url || "",
    keywords: c.keywords || [],
    exclude: c.exclude || [],
    public_reply: c.public_reply || { enabled: false, texts: ["Sent you a DM! 📩"] },
    opening_enabled: true,
    check_follow: !!c.check_follow,
    ask_email: !!c.ask_email,
    reward: c.reward || { type: "link", value: "" },
    copy: Object.assign(defaultDraft().copy, c.copy || {}),
    active: !!c.active,
  };
}

async function renderCreate() {
  const view = $("#view");
  if (!store.draft) {
    store.draft = defaultDraft();
    markSaved();
  }
  try {
    if (store.media.length === 0 && store.status.connected && !store.status.token_expired) {
      const r = await api("/api/media");
      store.media = r.media || [];
    }
    store.campaigns = (await api("/api/campaigns")).campaigns || [];
  } catch (e) {
    // media may fail if not connected; keep going with what we have
  }
  const d = store.draft;

  view.innerHTML = "";
  view.appendChild(el(connectBanner() || "<span></span>"));

  // top bar
  const top = el(`
    <div class="builder-topbar">
      <input class="name" id="cname" value="${esc(d.name)}" />
      <span class="status-pill ${d.active ? "live" : "stopped"}" id="statuspill">${d.active ? "live" : "stopped"}</span>
      <div class="spacer"></div>
      <select id="loadsel" style="width:auto"><option value="">New automation…</option>${store.campaigns
        .map((c) => `<option value="${esc(c.campaign_id)}" ${c.campaign_id === d.campaign_id ? "selected" : ""}>${esc(c.name || c.campaign_id)}</option>`)
        .join("")}</select>
      ${d.campaign_id ? `<button class="btn danger sm" id="deletebtn">${ICON.trash} Delete</button>` : ""}
      <button class="btn ghost sm" id="savebtn" title="Changes do not take effect until saved">Save</button>
      <button class="btn primary sm" id="golive">${d.active ? "Stop" : "Go live"}</button>
    </div>`);
  view.appendChild(top);

  const split = el(`<div class="builder"><div class="sections" id="sections"></div><div class="preview-col" id="previewcol"></div></div>`);
  view.appendChild(split);

  renderSections();
  renderPreview();
  refreshDirtyUI();

  $("#cname").oninput = (e) => {
    d.name = e.target.value;
  };
  $("#loadsel").onchange = (e) => {
    const id = e.target.value;
    if (!confirmDiscard("switch automations")) {
      // Put the dropdown back on the automation the user is actually editing.
      e.target.value = store.draft.campaign_id || "";
      return;
    }
    if (!id) store.draft = defaultDraft();
    else {
      const c = store.campaigns.find((x) => x.campaign_id === id);
      if (c) store.draft = draftFromCampaign(c);
    }
    markSaved();
    renderCreate();
  };
  $("#savebtn").onclick = () => saveCampaign(false);
  $("#golive").onclick = () => saveCampaign(!d.active ? "activate" : "deactivate");
  const deleteBtn = $("#deletebtn");
  if (deleteBtn) {
    deleteBtn.onclick = async () => {
      if (!confirm(`Delete "${d.name || d.campaign_id}"? This can't be undone.`)) return;
      try {
        await api("/api/campaigns/delete", { method: "POST", body: { campaign_id: d.campaign_id } });
        toast("Automation deleted");
        store.page = "automations";
        paintNav();
        route();
      } catch (e) {
        toast(e.message, true);
      }
    };
  }
}

function bindLive(root) {
  // re-render preview on any input change within the sections
  root.addEventListener("input", renderPreview);
  root.addEventListener("change", renderPreview);
}

const MEDIA_ROW_SIZE = 5;

function renderSections() {
  const d = store.draft;
  const box = $("#sections");
  const shownMedia = store.mediaShowAll ? store.media : store.media.slice(0, MEDIA_ROW_SIZE);
  const hasMore = store.media.length > MEDIA_ROW_SIZE;
  const mediaGrid =
    store.media.length > 0
      ? shownMedia
          .map(
            (m) => `<div class="media-thumb ${m.id === d.media_id ? "selected" : ""}" data-mid="${esc(m.id)}" data-thumb="${esc(m.thumbnail_url || m.media_url || "")}">
              <img src="${esc(m.thumbnail_url || m.media_url || "")}" alt="" loading="lazy"/></div>`,
          )
          .join("")
      : `<div class="muted" style="padding:8px 0">Connect Instagram to load your posts. You can still edit the copy and preview below.</div>`;
  const seeMoreBtn = hasMore
    ? `<button class="btn ghost sm" id="mediaSeeMore" style="margin-top:10px">${
        store.mediaShowAll ? "Show less" : `See more (${store.media.length - MEDIA_ROW_SIZE})`
      }</button>`
    : "";

  box.innerHTML = `
    <div class="card">
      <h3><span class="section-num">1</span>When someone comments on</h3>
      <div class="hint">Pick the post or reel this automation watches.</div>
      <div class="radio-row selected"><span class="radio-dot"></span><div><div class="rr-title">A specific post or reel</div><div class="rr-sub">Only comments on the selected media trigger the funnel.</div></div></div>
      <div class="radio-row disabled"><span class="radio-dot"></span><div><div class="rr-title">Any post or reel</div><div class="rr-sub">Soon</div></div></div>
      <div class="media-grid" id="mediagrid">${mediaGrid}</div>
      ${seeMoreBtn}
    </div>

    <div class="card">
      <h3><span class="section-num">2</span>And this comment has</h3>
      <div class="hint">Whole-word match, case-insensitive — “ai” fires on “I like this ai”, not “fair”.</div>
      <div class="radio-row selected"><span class="radio-dot"></span><div><div class="rr-title">A specific word or words</div></div></div>
      <label class="field"><span class="label">Keywords (comma separated)</span>
        <input type="text" id="keywords" value="${esc(d.keywords.join(", "))}" placeholder="Link, Guide"/></label>
      <div class="chips" id="kwchips">${["Price", "Link", "Shop"].map((k) => `<span class="chip" data-kw="${k}">${k}</span>`).join("")}</div>
      <label class="field" style="margin-top:14px"><span class="label">Exclude words (optional)</span>
        <input type="text" id="exclude" value="${esc((d.exclude || []).join(", "))}" placeholder="scam, fake"/></label>
      <div class="radio-row disabled"><span class="radio-dot"></span><div><div class="rr-title">Any word</div><div class="rr-sub">Soon</div></div></div>

      <div style="margin-top:8px">
        <div class="toggle-row"><div><div class="tr-title">Reply to their comment</div><div class="tr-sub">Post a public reply under the comment (rotates to look human).</div></div>
          <label class="switch"><input type="checkbox" id="pr_enabled" ${d.public_reply.enabled ? "checked" : ""}/><span class="slider"></span></label></div>
        <div id="pr_texts_wrap" style="${d.public_reply.enabled ? "" : "display:none"}">
          <label class="field"><span class="label">Public replies (one per line, rotated)</span>
            <textarea id="pr_texts">${esc((d.public_reply.texts || []).join("\n"))}</textarea></label>
        </div>
        <div class="toggle-row disabled"><div><div class="tr-title">Like their comment</div><div class="tr-sub">Not possible — Instagram's API has no way to like a comment.</div></div>
          <label class="switch"><input type="checkbox" disabled/><span class="slider"></span></label></div>
      </div>
    </div>

    <div class="card">
      <h3><span class="section-num">3</span>They will get</h3>
      <div class="toggle-row"><div><div class="tr-title">An opening DM</div><div class="tr-sub">Sent as a private reply with a button so it survives the Requests folder. Required to start the funnel.</div></div>
        <label class="switch"><input type="checkbox" id="opening_enabled" ${d.opening_enabled ? "checked" : ""}/><span class="slider"></span></label></div>
      <div id="opening_wrap" style="${d.opening_enabled ? "" : "display:none"}">
        <label class="field"><span class="label">Opening message</span><textarea id="c_opening">${esc(d.copy.opening)}</textarea></label>
        <label class="field"><span class="label">Button label</span><input type="text" id="c_opening_button" value="${esc(d.copy.opening_button)}"/></label>
      </div>
      <div class="toggle-row"><div><div class="tr-title">Ask them to follow you first</div><div class="tr-sub">Self-attestation — the tap advances (the API can’t verify a specific follow).</div></div>
        <label class="switch"><input type="checkbox" id="check_follow" ${d.check_follow ? "checked" : ""}/><span class="slider"></span></label></div>
      <div id="follow_wrap" style="${d.check_follow ? "" : "display:none"}">
        <label class="field"><span class="label">Follow message</span><textarea id="c_follow_gate">${esc(d.copy.follow_gate)}</textarea></label>
        <label class="field"><span class="label">Follow button label</span><input type="text" id="c_follow_button" value="${esc(d.copy.follow_button)}"/></label>
      </div>
      <div class="toggle-row"><div><div class="tr-title">Ask for their email</div><div class="tr-sub">Uses Instagram’s email chip, with a typed-reply fallback.</div></div>
        <label class="switch"><input type="checkbox" id="ask_email" ${d.ask_email ? "checked" : ""}/><span class="slider"></span></label></div>
      <div id="email_wrap" style="${d.ask_email ? "" : "display:none"}">
        <label class="field"><span class="label">Email ask message</span><textarea id="c_email_ask">${esc(d.copy.email_ask)}</textarea></label>
      </div>
    </div>

    <div class="card">
      <h3><span class="section-num">4</span>And then, they will get</h3>
      <div class="hint">The reward, delivered by DM. Use <code>{reward}</code> to place your link.</div>
      <label class="field"><span class="label">Delivery message</span><textarea id="c_delivery">${esc(d.copy.delivery)}</textarea></label>
      <label class="field"><span class="label">Link or reward</span><input type="url" id="reward_value" value="${esc(d.reward.value)}" placeholder="https://example.com/guide"/></label>
      <div class="toggle-row"><div><div class="tr-title">Follow-up DM if they don’t click</div><div class="tr-sub">Soon</div></div>
        <label class="switch"><input type="checkbox" disabled/><span class="slider"></span></label></div>
    </div>`;

  wireSections();
  bindLive(box);
}

function wireSections() {
  const d = store.draft;
  // media
  $("#mediagrid")?.querySelectorAll(".media-thumb").forEach((t) => {
    t.onclick = () => {
      d.media_id = t.dataset.mid;
      d.media_thumb = t.dataset.thumb;
      $("#mediagrid").querySelectorAll(".media-thumb").forEach((x) => x.classList.toggle("selected", x === t));
      renderPreview();
    };
  });
  const seeMore = $("#mediaSeeMore");
  if (seeMore) {
    seeMore.onclick = () => {
      store.mediaShowAll = !store.mediaShowAll;
      renderSections();
    };
  }
  // keyword chips
  $("#kwchips")?.querySelectorAll(".chip").forEach((c) => {
    c.onclick = () => {
      const input = $("#keywords");
      const set = new Set(input.value.split(",").map((x) => x.trim()).filter(Boolean));
      set.add(c.dataset.kw);
      input.value = [...set].join(", ");
      d.keywords = [...set];
      renderPreview();
    };
  });
  const bindText = (id, fn) => {
    const node = $("#" + id);
    if (node) node.oninput = (e) => fn(e.target.value);
  };
  bindText("keywords", (v) => (d.keywords = v.split(",").map((x) => x.trim()).filter(Boolean)));
  bindText("exclude", (v) => (d.exclude = v.split(",").map((x) => x.trim()).filter(Boolean)));
  bindText("pr_texts", (v) => (d.public_reply.texts = v.split("\n").map((x) => x.trim()).filter(Boolean)));
  bindText("c_opening", (v) => (d.copy.opening = v));
  bindText("c_opening_button", (v) => (d.copy.opening_button = v));
  bindText("c_follow_gate", (v) => (d.copy.follow_gate = v));
  bindText("c_follow_button", (v) => (d.copy.follow_button = v));
  bindText("c_email_ask", (v) => (d.copy.email_ask = v));
  bindText("c_delivery", (v) => (d.copy.delivery = v));
  bindText("reward_value", (v) => (d.reward.value = v));

  const bindToggle = (id, fn, wrapId) => {
    const node = $("#" + id);
    if (!node) return;
    node.onchange = (e) => {
      fn(e.target.checked);
      if (wrapId) $("#" + wrapId).style.display = e.target.checked ? "" : "none";
      renderPreview();
    };
  };
  bindToggle("pr_enabled", (v) => (d.public_reply.enabled = v), "pr_texts_wrap");
  bindToggle("opening_enabled", (v) => (d.opening_enabled = v), "opening_wrap");
  bindToggle("check_follow", (v) => (d.check_follow = v), "follow_wrap");
  bindToggle("ask_email", (v) => (d.ask_email = v), "email_wrap");
}

/* ---------------- live phone preview ---------------- */
const iosStatusBar = () => `
  <div class="ios-status">
    <span class="time">9:41</span>
    <span class="icons">
      <span class="bars"><span></span><span></span><span></span><span></span></span>
      <svg width="15" height="11" viewBox="0 0 15 11" fill="#fff"><path d="M7.5 0C4.9 0 2.5 1 .6 2.7a.6.6 0 0 0 0 .9l1 1a.6.6 0 0 0 .8 0A8 8 0 0 1 7.5 2.6a8 8 0 0 1 5.1 1.9.6.6 0 0 0 .8 0l1-1a.6.6 0 0 0 0-.9A10.5 10.5 0 0 0 7.5 0Zm0 4a6 6 0 0 0-4 1.5.6.6 0 0 0 0 .9l1 1a.6.6 0 0 0 .8 0 3.4 3.4 0 0 1 4.4 0 .6.6 0 0 0 .8 0l1-1a.6.6 0 0 0 0-.9A6 6 0 0 0 7.5 4Zm0 4a2.2 2.2 0 0 0-1.5.6.6.6 0 0 0 0 .9l1 1a.6.6 0 0 0 .8 0l1-1a.6.6 0 0 0 0-.9A2.2 2.2 0 0 0 7.5 8Z"/></svg>
      <span class="battery"></span>
    </span>
  </div>`;

function renderPreview() {
  refreshDirtyUI();
  const d = store.draft;
  const s = store.status || {};
  const col = $("#previewcol");
  if (!col) return;
  const avatar = s.profile_picture_url || "";
  const uname = s.username || "yourbrand";
  const media = store.media.find((m) => m.id === d.media_id) || store.media[0] || {};
  const thumb = d.media_thumb || media.thumbnail_url || media.media_url || "";
  const kw = d.keywords[0] || "Link";
  const reward = d.reward.value || "your link";
  const deliveryText = (d.copy.delivery || "").replace(/\{reward\}/g, reward);
  const caption = media.caption || `New drop is live 🔥 comment "${kw}" and I'll send it.`;
  const captionLong = caption.length > 70;
  const captionShown = store.captionExpanded || !captionLong ? caption : caption.slice(0, 70) + "…";

  const tabBtn = (id, label) => `<button class="${store.previewTab === id ? "active" : ""}" data-tab="${id}">${label}</button>`;

  let body = "";
  if (store.previewTab === "post") {
    body = `<div class="ig">
      <div class="ig-top"><img src="${esc(avatar)}" onerror="this.style.visibility='hidden'"/><span class="u">${esc(uname)}</span></div>
      ${thumb ? `<img class="ig-media" src="${esc(thumb)}"/>` : `<div class="ig-media"></div>`}
      <div class="ig-actions"><span class="heart">${ICON.heartO}</span><span>${ICON.cmt}</span><span>${ICON.send}</span></div>
      <div class="ig-stats">${(media.like_count ?? 128).toLocaleString()} likes · ${(media.comments_count ?? 0) + (d.public_reply.enabled ? 1 : 0)} comments</div>
      <div class="ig-caption"><span class="u">${esc(uname)}</span>${esc(captionShown)}${
        captionLong ? `<span class="ig-caption-toggle" id="captoggle"> ${store.captionExpanded ? "less" : "more"}</span>` : ""
      }</div>
    </div>`;
  } else if (store.previewTab === "comments") {
    body = `<div class="ig">
      ${thumb ? `<img class="ig-media" style="aspect-ratio:16/9;opacity:.5" src="${esc(thumb)}"/>` : ""}
      <div class="sheet">
        <div class="sheet-handle"></div>
        <div class="sheet-head"><span>Comments</span>${ICON.send}</div>
        <div class="sheet-body">
          <div class="cmt"><div class="av">@</div><div class="body"><span class="u">follower</span>${esc(kw)}!<div class="meta">2m · Reply</div></div>${""
          }</div>
          ${
            d.public_reply.enabled && (d.public_reply.texts[0] || "")
              ? `<div class="cmt reply"><div class="av">${esc((uname[0] || "y")).toUpperCase()}</div><div class="body"><span class="u">${esc(uname)}</span>${esc(d.public_reply.texts[0])}<div class="meta">now · Reply</div></div></div>`
              : ""
          }
        </div>
        <div class="sheet-emojis"><span>❤️</span><span>🙌</span><span>🔥</span><span>👏</span><span>😢</span><span>😍</span><span>😮</span><span>😂</span></div>
        <div class="sheet-input-row"><img class="av" src="${esc(avatar)}" onerror="this.style.visibility='hidden'"/><span class="fake-input">Add a comment for ${esc(uname)}...</span></div>
      </div>
    </div>`;
  } else {
    // DM funnel — a two-sided conversation: business messages on the left, the follower's taps
    // echoed back on the right at every step, so the preview reads as "this is what they'd see."
    const blocks = [];
    if (d.opening_enabled) {
      blocks.push(`<div class="bubble in">${esc(d.copy.opening)}</div>`);
      blocks.push(`<div class="dm-btn">${esc(d.copy.opening_button || "Continue")}</div>`);
      blocks.push(`<div class="bubble out">${esc(d.copy.opening_button || "Continue")}</div>`);
      blocks.push(`<div class="dm-note">tap moves the chat out of Requests →</div>`);
    } else {
      blocks.push(`<div class="dm-note">Opening DM is off — the funnel won’t start.</div>`);
    }
    if (d.check_follow) {
      // Rendered as a button, not a quick-reply chip, to match what the engine actually sends.
      blocks.push(`<div class="bubble in">${esc(d.copy.follow_gate)}</div>`);
      blocks.push(`<div class="dm-btn">${esc(d.copy.follow_button || "✅ I followed")}</div>`);
      blocks.push(`<div class="bubble out">${esc(d.copy.follow_button || "✅ I followed")}</div>`);
    }
    if (d.ask_email) {
      blocks.push(`<div class="bubble in">${esc(d.copy.email_ask)}</div>`);
      blocks.push(`<div class="qr"><span class="pill">your@email.com</span></div>`);
      blocks.push(`<div class="bubble out">your@email.com</div>`);
    }
    blocks.push(`<div class="bubble in">${esc(deliveryText)}</div>`);
    body = `<div class="ig"><div class="dm">${blocks.join("")}</div></div>`;
  }

  col.innerHTML = `
    <div class="phone"><div class="phone-screen">
      ${iosStatusBar()}
      <div class="seg">${tabBtn("post", "Post")}${tabBtn("comments", "Comments")}${tabBtn("dm", "DM")}</div>
      ${body}
    </div></div>`;
  col.querySelectorAll(".seg button").forEach((b) => (b.onclick = () => {
    store.previewTab = b.dataset.tab;
    store.captionExpanded = false;
    renderPreview();
  }));
  const capToggle = $("#captoggle");
  if (capToggle) {
    capToggle.onclick = () => {
      store.captionExpanded = !store.captionExpanded;
      renderPreview();
    };
  }
}

/* ---------------- unsaved-changes tracking ----------------
   Editing a live automation does nothing until it's saved. Before this, the only
   hint was a quiet "Save" button next to a loud "Go live" — and since Go live
   also saves, stopping and restarting appeared to "fix" edits that were simply
   never saved. Now the button announces pending changes and every exit is guarded. */

function draftSnapshot() {
  if (!store.draft) return null;
  const d = store.draft;
  return JSON.stringify({ ...d, __active: d.active });
}

/** Call after loading a campaign into the draft, or after a successful save. */
function markSaved() {
  store.savedSnapshot = draftSnapshot();
  refreshDirtyUI();
}

function isDirty() {
  return !!store.draft && store.savedSnapshot !== null && store.savedSnapshot !== draftSnapshot();
}

/** Repaint the Save button so pending changes are impossible to miss. */
function refreshDirtyUI() {
  const btn = document.querySelector("#savebtn");
  if (!btn) return;
  const dirty = isDirty();
  btn.className = `btn ${dirty ? "primary" : "ghost"} sm`;
  btn.textContent = dirty ? "Save changes •" : "Save";
}

/**
 * Guard an action that would discard unsaved edits. Returns true if it's safe
 * to proceed (nothing pending, or the user chose to discard).
 */
function confirmDiscard(what = "leave") {
  if (!isDirty()) return true;
  return confirm(
    `You have unsaved changes to "${store.draft.name || "this automation"}".\n\n` +
      `They will NOT take effect until you save. If you ${what} now, the changes are lost.\n\n` +
      `OK to discard them, or Cancel to go back and save.`,
  );
}

// Typed edits don't re-render, so refresh the button straight from the DOM event.
document.addEventListener("input", () => {
  if (store.page === "create") refreshDirtyUI();
});

// Closing the tab / hitting back with pending edits.
window.addEventListener("beforeunload", (e) => {
  if (!isDirty()) return;
  e.preventDefault();
  e.returnValue = "";
});

/* ---------------- save ---------------- */
function buildCampaignFromDraft() {
  const d = store.draft;
  return {
    campaign_id: d.campaign_id || `${slug(d.name)}-${Math.random().toString(36).slice(2, 8)}`,
    name: d.name,
    media_id: d.media_id,
    keywords: d.keywords,
    exclude: d.exclude,
    public_reply: d.public_reply.enabled ? { enabled: true, texts: d.public_reply.texts } : { enabled: false, texts: d.public_reply.texts },
    check_follow: d.check_follow,
    ask_email: d.ask_email,
    reward: d.reward,
    copy: d.copy,
  };
}

function validateDraft(d) {
  if (!d.media_id) return "Select a post or reel in section 1.";
  if (!d.keywords.length) return "Add at least one keyword in section 2.";
  if (!d.reward.value) return "Add your link or reward in section 4.";
  if (!d.opening_enabled) return "Turn on the opening DM — it’s required to start the funnel.";
  return null;
}

async function saveCampaign(activation) {
  const d = store.draft;
  const err = validateDraft(d);
  if (err && activation === "activate") return toast(err, true);
  if (err && !activation) return toast(err, true);
  const campaign = buildCampaignFromDraft();
  // persist name inside config via copy? name is stored on the campaign object (config_json).
  campaign.name = d.name;
  const active = activation === "activate" ? true : activation === "deactivate" ? false : d.active;
  try {
    await api("/api/campaigns", { method: "POST", body: { campaign, active } });
    if (activation) await api("/api/campaigns/status", { method: "POST", body: { campaign_id: campaign.campaign_id, active } });
    d.campaign_id = campaign.campaign_id;
    d.active = active;
    if (activation) {
      markSaved();
      // Going live or stopping is the "I'm done editing" signal — land back on the automations list.
      toast(activation === "activate" ? "Automation is live" : "Automation stopped");
      store.page = "automations";
      paintNav();
      route();
      return;
    }
    markSaved();
    $("#statuspill").className = `status-pill ${active ? "live" : "stopped"}`;
    $("#statuspill").textContent = active ? "live" : "stopped";
    $("#golive").textContent = active ? "Stop" : "Go live";
    toast("Saved");
  } catch (e) {
    toast(e.message, true);
  }
}

/* ================= DASHBOARD ================= */
async function renderDashboard() {
  const view = $("#view");
  try {
    store.campaigns = (await api("/api/campaigns")).campaigns || [];
  } catch {}
  const qs = new URLSearchParams();
  if (store.dashCampaign) qs.set("campaign_id", store.dashCampaign);
  qs.set("days", String(store.dashDays));
  let data;
  try {
    data = await api("/api/dashboard?" + qs.toString());
  } catch (e) {
    view.innerHTML = connectBanner() + `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  const c = data.cards;
  const card = (val, label, sub) => `<div class="metric"><div class="m-val">${val}</div><div class="m-label">${label}</div>${sub ? `<div class="m-sub">${sub}</div>` : ""}</div>`;

  view.innerHTML = `
    ${connectBanner()}
    <div class="page-head"><div><div class="page-title">Dashboard</div><div class="page-sub">Performance from logged funnel events.</div></div>
      <div class="toolbar">
        <div class="select-inline"><span class="muted">Campaign</span>
          <select id="dashcamp"><option value="">All campaigns</option>${store.campaigns.map((x) => `<option value="${esc(x.campaign_id)}" ${x.campaign_id === store.dashCampaign ? "selected" : ""}>${esc(x.name || x.campaign_id)}</option>`).join("")}</select></div>
        <div class="select-inline"><span class="muted">Range</span>
          <select id="dashdays">${[7, 30, 90].map((n) => `<option value="${n}" ${n === store.dashDays ? "selected" : ""}>Last ${n} days</option>`).join("")}</select></div>
      </div>
    </div>
    <div class="metrics">
      ${card(c.comments, "Comments")}
      ${card(c.sends, "Opening DMs")}
      ${card(c.clicks, "Clicks", c.ctr + "% of DMs")}
      ${card(c.follows, "Follows")}
      ${card(c.emails, "Emails")}
      ${card(c.delivered, "Delivered")}
    </div>
    <div class="card">
      <h3>Conversion funnel</h3>
      <div class="hint">Percentages are relative to comments with the keyword.</div>
      <div id="funnel"></div>
    </div>`;

  const funnel = $("#funnel");
  data.funnel.forEach((f) => {
    funnel.appendChild(
      el(`<div class="funnel-bar"><div class="fb-top"><span>${f.label}</span><span class="muted">${f.value} · ${f.pct}%</span></div>
        <div class="fb-track"><div class="fb-fill" style="width:${Math.max(2, f.pct)}%"></div></div></div>`),
    );
  });

  $("#dashcamp").onchange = (e) => {
    store.dashCampaign = e.target.value;
    renderDashboard();
  };
  $("#dashdays").onchange = (e) => {
    store.dashDays = Number(e.target.value);
    renderDashboard();
  };
}

/* ================= CONTACTS ================= */
function pillClass(state) {
  if (state === "DONE") return "done";
  if (state === "AWAITING_FOLLOW" || state === "AWAITING_EMAIL") return "wait";
  return "open";
}

async function renderContacts() {
  const view = $("#view");
  try {
    store.campaigns = (await api("/api/campaigns")).campaigns || [];
  } catch {}
  const qs = new URLSearchParams();
  if (store.contactsCampaign) qs.set("campaign_id", store.contactsCampaign);
  let rows = [];
  try {
    rows = (await api("/api/contacts?" + qs.toString())).contacts || [];
  } catch (e) {
    view.innerHTML = connectBanner() + `<div class="empty">${esc(e.message)}</div>`;
    return;
  }

  view.innerHTML = `
    ${connectBanner()}
    <div class="page-head"><div><div class="page-title">Contacts</div><div class="page-sub">Everyone who entered a campaign.</div></div>
      <div class="toolbar">
        <div class="select-inline"><span class="muted">Campaign</span>
          <select id="ccamp"><option value="">All campaigns</option>${store.campaigns.map((x) => `<option value="${esc(x.campaign_id)}" ${x.campaign_id === store.contactsCampaign ? "selected" : ""}>${esc(x.name || x.campaign_id)}</option>`).join("")}</select></div>
        <button class="btn ghost sm" id="exportcsv">Export CSV</button>
      </div>
    </div>
    <div id="contactlist"></div>`;

  const list = $("#contactlist");
  if (rows.length === 0) {
    list.innerHTML = `<div class="empty">${ICON.inbox}<div>No contacts yet. Once people comment your keyword, they’ll appear here.</div></div>`;
  } else {
    rows.forEach((r) => {
      const initial = (r.username || "?")[0].toUpperCase();
      list.appendChild(
        el(`<div class="contact-row">
          <div class="who"><div class="av">${esc(initial)}</div><span class="uname">${r.username ? "@" + esc(r.username) : esc(r.igsid)}</span></div>
          <div><span class="pill ${pillClass(r.state)}">${esc(r.status_label)}</span></div>
          <div class="col-hide">${r.followed ? "✓ followed" : '<span class="dash">—</span>'}</div>
          <div class="col-hide">${r.email ? esc(r.email) : '<span class="dash">—</span>'}</div>
          <div class="col-hide muted">${new Date(r.updated_at * 1000).toLocaleDateString()}</div>
        </div>`),
      );
    });
  }

  $("#ccamp").onchange = (e) => {
    store.contactsCampaign = e.target.value;
    renderContacts();
  };
  $("#exportcsv").onclick = async () => {
    // Fetch with the auth header (not a token in the URL) and download the blob.
    try {
      const res = await fetch("/api/contacts/export?" + qs.toString(), {
        headers: { authorization: `Bearer ${store.token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "chatmany-contacts.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      toast("Export failed: " + e.message, true);
    }
  };
}

boot();
