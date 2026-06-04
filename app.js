// Family Dinners — Weekly Planner
// Plain JS, single file, no build step.
// State can be backed by either localStorage (offline / pre-setup) or a GitHub
// data.json file via the GitHub Contents API. With GitHub backing, all visitors
// who configured the same owner/repo + PAT share the same data.

(function () {
  "use strict";

  // ---------- Storage layout ----------
  // Data shape on the wire (and in localStorage mirror):
  //   {
  //     schema: 1,
  //     updatedAt: "2026-06-05T12:34:56.000Z",
  //     people:  [{ id, name, createdAt }],
  //     dinners: { "YYYY-MM-DD": "Tacos" },
  //     votes:   { "YYYY-MM-DD|personId": true }
  //   }
  //
  // UI prefs are kept in a separate localStorage key (per-device, not shared).

  const KEY = {
    DATA:      "fd.data",          // shared data (in repo)
    UI:        "fd.ui",            // per-device UI prefs
    SETTINGS:  "fd.settings",      // per-device GitHub connection settings (incl. PAT)
  };

  const DAYS = [
    { short: "Mon", long: "Monday" },
    { short: "Tue", long: "Tuesday" },
    { short: "Wed", long: "Wednesday" },
    { short: "Thu", long: "Thursday" },
    { short: "Fri", long: "Friday" },
    { short: "Sat", long: "Saturday" },
    { short: "Sun", long: "Sunday" },
  ];

  const POLL_MS = 30_000;          // background poll cadence
  const SAVE_DEBOUNCE_MS = 1_000;   // coalesce rapid edits
  const SCHEMA = 1;
  const DEFAULT_SETTINGS = {
    owner: "TroyKirkland",
    repo: "FamilyDinners",
    branch: "main",
    path: "data.json",
    token: "",
  };

  // ---------- Tiny utilities ----------
  const $ = (sel, root = document) => root.querySelector(sel);

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      console.warn("Failed to parse", key, e);
      return fallback;
    }
  }
  function saveJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function uid() {
    return "p_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function ymd(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  function parseYmd(s) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  function startOfWeek(date) {
    const d = new Date(date);
    const dow = d.getDay();
    const diff = (dow + 6) % 7;
    d.setDate(d.getDate() - diff);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  function addDays(date, n) {
    const d = new Date(date);
    d.setDate(d.getDate() + n);
    return d;
  }
  function formatWeekLabel(monday) {
    const sunday = addDays(monday, 6);
    const sameMonth = monday.getMonth() === sunday.getMonth();
    const sameYear = monday.getFullYear() === sunday.getFullYear();
    const monthA = monday.toLocaleString(undefined, { month: "short" });
    const monthB = sunday.toLocaleString(undefined, { month: "short" });
    const year = sunday.getFullYear();
    if (sameMonth) return `${monthA} ${monday.getDate()}–${sunday.getDate()}, ${year}`;
    if (sameYear) return `${monthA} ${monday.getDate()} – ${monthB} ${sunday.getDate()}, ${year}`;
    return `${monthA} ${monday.getDate()}, ${monday.getFullYear()} – ${monthB} ${sunday.getDate()}, ${sunday.getFullYear()}`;
  }
  function isSameDay(a, b) {
    return a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth()
      && a.getDate() === b.getDate();
  }

  function debounce(fn, ms) {
    let t = null;
    return function (...args) {
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; fn.apply(this, args); }, ms);
    };
  }

  function emptyData() {
    return { schema: SCHEMA, updatedAt: new Date().toISOString(), people: [], dinners: {}, votes: {} };
  }
  function normalizeData(d) {
    d = d || {};
    return {
      schema: SCHEMA,
      updatedAt: d.updatedAt || new Date().toISOString(),
      people: Array.isArray(d.people) ? d.people : [],
      dinners: (d.dinners && typeof d.dinners === "object") ? d.dinners : {},
      votes:   (d.votes   && typeof d.votes   === "object") ? d.votes   : {},
    };
  }

  // ---------- Backends ----------
  // A backend is anything with { load(), save(data) } where save returns a
  // Promise<void> that throws on failure.

  const LocalBackend = {
    name: "local",
    isConfigured() { return true; },
    async load() {
      return normalizeData(loadJson(KEY.DATA, null) || (loadJson("fd.people") ? migrateLegacy() : emptyData()));
    },
    async save(data) {
      data = normalizeData(data);
      data.updatedAt = new Date().toISOString();
      saveJson(KEY.DATA, data);
    },
  };

  // Read from old fd.people / fd.dinners / fd.votes keys and convert to new shape.
  function migrateLegacy() {
    const d = emptyData();
    d.people = loadJson("fd.people", []);
    d.dinners = loadJson("fd.dinners", {});
    d.votes = loadJson("fd.votes", {});
    return d;
  }

  const GitHubBackend = {
    name: "github",
    isConfigured(s) { return !!(s && s.token && s.owner && s.repo && s.branch && s.path); },

    _url(s) {
      return `https://api.github.com/repos/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}/contents/${encodeURIComponent(s.path)}?ref=${encodeURIComponent(s.branch)}`;
    },

    async load(s) {
      const res = await fetch(this._url(s), {
        headers: { "Accept": "application/vnd.github+json", "Authorization": `Bearer ${s.token}` },
      });
      if (res.status === 404) {
        // No data.json yet. Caller can decide to create it on first save.
        return { data: normalizeData(emptyData()), sha: null, exists: false };
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`GitHub load failed (${res.status}): ${text || res.statusText}`);
      }
      const body = await res.json();
      const decoded = decodeBase64Utf8(body.content);
      let parsed;
      try { parsed = JSON.parse(decoded); }
      catch (e) { throw new Error(`data.json is not valid JSON: ${e.message}`); }
      return { data: normalizeData(parsed), sha: body.sha, exists: true };
    },

    async save(s, data, lastSha) {
      data = normalizeData(data);
      data.updatedAt = new Date().toISOString();
      const body = {
        message: `Update family dinners (${new Date().toISOString()})`,
        content: encodeBase64Utf8(JSON.stringify(data, null, 2)),
        branch: s.branch,
      };
      if (lastSha) body.sha = lastSha;
      const res = await fetch(this._url(s), {
        method: "PUT",
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": `Bearer ${s.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`GitHub save failed (${res.status}): ${text || res.statusText}`);
      }
      const out = await res.json();
      return { sha: out.content.sha };
    },
  };

  // Base64 helpers that work with non-ASCII (UTF-8) content.
  function encodeBase64Utf8(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function decodeBase64Utf8(b64) {
    // GitHub may include newlines; strip them.
    const cleaned = b64.replace(/\s+/g, "");
    const bin = atob(cleaned);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  // ---------- Store ----------
  // Single source of truth: state.data. Mutations go through helper methods
  // that call _scheduleSave(). Backend choice is determined by settings.

  const store = {
    data: normalizeData(emptyData()),
    settings: { ...DEFAULT_SETTINGS, ...loadJson(KEY.SETTINGS, {}) },
    ui: loadJson(KEY.UI, {}),
    backend: LocalBackend,
    lastSha: null,
    remoteExists: false,
    _saveTimer: null,
    _saveInFlight: null,
    _saveQueued: false,
    _pollTimer: null,
    _listeners: new Set(),

    init() {
      if (!this.ui.weekAnchor) this.ui.weekAnchor = ymd(startOfWeek(new Date()));
      if (!this.ui.currentUserId) this.ui.currentUserId = null;
      this.backend = GitHubBackend.isConfigured(this.settings) ? GitHubBackend : LocalBackend;
    },

    on(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); },
    _emit(evt) { for (const fn of this._listeners) { try { fn(evt); } catch (e) { console.error(e); } } },

    async load() {
      try {
        const r = await this.backend.load(this.settings);
        this.data = r.data;
        this.lastSha = r.sha;
        this.remoteExists = !!r.exists;
        this._emit({ type: "loaded", backend: this.backend.name });
      } catch (e) {
        console.error(e);
        this._emit({ type: "error", phase: "load", error: e });
      }
    },

    _scheduleSave() {
      this._saveQueued = true;
      this._emit({ type: "dirty" });
      if (this._saveTimer) clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(() => this._flushSave(), SAVE_DEBOUNCE_MS);
    },

    async _flushSave() {
      if (!this._saveQueued) return;
      this._saveQueued = false;
      this._saveTimer = null;
      this._emit({ type: "saving" });

      // Snapshot the data we're about to write so further edits during the
      // request don't get clobbered.
      const snapshot = normalizeData(this.data);

      try {
        if (this.backend === LocalBackend) {
          await this.backend.save(snapshot);
          this._emit({ type: "saved", backend: this.backend.name });
          return;
        }

        // GitHub: if a previous save is in flight, let it finish first; we
        // always re-save the latest snapshot afterwards.
        if (this._saveInFlight) {
          await this._saveInFlight;
        }
        const run = (async () => {
          let attempt = 0;
          for (;;) {
            attempt++;
            try {
              const r = await this.backend.save(this.settings, snapshot, this.lastSha);
              this.lastSha = r.sha;
              this.remoteExists = true;
              return;
            } catch (e) {
              // 409 = conflict (someone else saved with a stale SHA). Re-read
              // and merge their fresh keys in, then retry up to 3 times.
              if (e.message && e.message.includes("(409)") && attempt < 3) {
                const fresh = await this.backend.load(this.settings);
                const merged = mergeData(snapshot, fresh.data);
                snapshot.people = merged.people;
                snapshot.dinners = merged.dinners;
                snapshot.votes = merged.votes;
                this.lastSha = fresh.sha;
                continue;
              }
              throw e;
            }
          }
        })();
        this._saveInFlight = run;
        try { await run; }
        finally { if (this._saveInFlight === run) this._saveInFlight = null; }

        // If edits happened during the save, keep the in-memory data on top
        // of remote and re-save once more so those edits land too.
        if (this._saveQueued) {
          this._saveQueued = false;
          await this._flushSave();
        }
        this._emit({ type: "saved", backend: this.backend.name });
      } catch (e) {
        console.error("Save failed", e);
        this._emit({ type: "error", phase: "save", error: e });
        // Re-queue so the next interaction retries.
        this._saveQueued = true;
      }
    },

    // Public mutation methods
    addPerson(name) {
      const trimmed = (name || "").trim();
      if (!trimmed) return null;
      const exists = this.data.people.find(p => p.name.toLowerCase() === trimmed.toLowerCase());
      if (exists) return exists;
      const person = { id: uid(), name: trimmed, createdAt: Date.now() };
      this.data.people.push(person);
      this._scheduleSave();
      this._emit({ type: "data" });
      return person;
    },

    removePerson(id) {
      const person = this.data.people.find(p => p.id === id);
      if (!person) return false;
      this.data.people = this.data.people.filter(p => p.id !== id);
      for (const k of Object.keys(this.data.votes)) {
        if (k.endsWith("|" + id)) delete this.data.votes[k];
      }
      if (this.ui.currentUserId === id) {
        this.ui.currentUserId = null;
        saveJson(KEY.UI, this.ui);
      }
      this._scheduleSave();
      this._emit({ type: "data" });
      return true;
    },

    setDinner(dateKey, value) {
      if (value) this.data.dinners[dateKey] = value;
      else delete this.data.dinners[dateKey];
      this._scheduleSave();
    },

    setVote(dateKey, personId, home) {
      const k = `${dateKey}|${personId}`;
      if (home) this.data.votes[k] = true;
      else delete this.data.votes[k];
      this._scheduleSave();
    },

    setCurrentUser(id) {
      this.ui.currentUserId = id || null;
      saveJson(KEY.UI, this.ui);
      this._emit({ type: "ui" });
    },

    setWeekAnchor(ymdStr) {
      this.ui.weekAnchor = ymdStr;
      saveJson(KEY.UI, this.ui);
      this._emit({ type: "ui" });
    },

    updateSettings(patch) {
      this.settings = { ...this.settings, ...patch };
      saveJson(KEY.SETTINGS, this.settings);
      this.backend = GitHubBackend.isConfigured(this.settings) ? GitHubBackend : LocalBackend;
      this._emit({ type: "settings" });
    },

    startPolling() {
      this.stopPolling();
      if (this.backend !== GitHubBackend) return;
      this._pollTimer = setInterval(() => this.refreshFromRemote(), POLL_MS);
    },
    stopPolling() {
      if (this._pollTimer) clearInterval(this._pollTimer);
      this._pollTimer = null;
    },

    async refreshFromRemote() {
      if (this.backend !== GitHubBackend) return;
      try {
        // Flush pending local writes first so we don't overwrite someone's edit.
        if (this._saveQueued) await this._flushSave();
        const r = await this.backend.load(this.settings);
        // Preserve any unsaved local edits: merge remote in.
        const merged = mergeData(this.data, r.data);
        const wasChanged = !shallowEqualData(this.data, merged);
        this.data = merged;
        this.lastSha = r.sha;
        this.remoteExists = !!r.exists;
        if (wasChanged) this._emit({ type: "data" });
        this._emit({ type: "loaded", backend: this.backend.name });
      } catch (e) {
        console.warn("Refresh failed", e);
        this._emit({ type: "error", phase: "refresh", error: e });
      }
    },
  };

  // Merge two data objects. Strategy:
  //   - people: union by id; for shared ids, keep the higher createdAt (so
  //     renaming on one device wins elsewhere).
  //   - dinners: per-date, prefer the value with the later updatedAt parent
  //     (caller passes updatedAt; we use the snapshot for the local side).
  //     For simplicity, treat dinners as last-writer-wins by string-compare of
  //     updatedAt on the parent data.
  //   - votes: union of keys. (Removing a vote is a delete, which won't merge
  //     against an add from elsewhere. To remove a vote everywhere, click the
  //     box on every device once — we don't propagate deletes here.)
  function mergeData(local, remote) {
    const localTs = Date.parse(local.updatedAt || "") || 0;
    const remoteTs = Date.parse(remote.updatedAt || "") || 0;
    const newer = remoteTs > localTs ? "remote" : "local";

    // People
    const byId = new Map();
    for (const p of local.people || []) byId.set(p.id, p);
    for (const p of remote.people || []) {
      const cur = byId.get(p.id);
      if (!cur) byId.set(p.id, p);
      else if ((p.createdAt || 0) > (cur.createdAt || 0)) byId.set(p.id, p);
    }
    const people = Array.from(byId.values());

    // Dinners: per-day last-writer-wins.
    const dinners = { ...(newer === "remote" ? remote.dinners : local.dinners) };
    if (newer === "remote") {
      for (const k of Object.keys(local.dinners || {})) {
        if (!(k in dinners)) dinners[k] = local.dinners[k];
      }
    } else {
      for (const k of Object.keys(remote.dinners || {})) {
        if (!(k in dinners)) dinners[k] = remote.dinners[k];
      }
    }

    // Votes: union of keys. True wins over undefined; either way true means home.
    const votes = { ...(local.votes || {}) };
    for (const [k, v] of Object.entries(remote.votes || {})) {
      if (v === true) votes[k] = true;
    }

    return {
      schema: SCHEMA,
      updatedAt: new Date().toISOString(),
      people,
      dinners,
      votes,
    };
  }

  function shallowEqualData(a, b) {
    if (a.people.length !== b.people.length) return false;
    const aNames = new Set(a.people.map(p => p.id + ":" + p.name + ":" + p.createdAt));
    for (const p of b.people) if (!aNames.has(p.id + ":" + p.name + ":" + p.createdAt)) return false;
    if (Object.keys(a.dinners).length !== Object.keys(b.dinners).length) return false;
    for (const k of Object.keys(a.dinners)) if (a.dinners[k] !== b.dinners[k]) return false;
    if (Object.keys(a.votes).length !== Object.keys(b.votes).length) return false;
    for (const k of Object.keys(a.votes)) if (a.votes[k] !== b.votes[k]) return false;
    return true;
  }

  // ---------- View ----------
  // Thin layer that re-renders the DOM when the store changes.

  const view = {
    init() {
      store.on((evt) => this._onStoreEvent(evt));
      this._bindStatic();
      this.render();
    },

    _bindStatic() {
      $("#current-user").addEventListener("change", (e) => {
        store.setCurrentUser(e.target.value);
      });
      $("#prev-week").addEventListener("click", () => {
        const m = parseYmd(store.ui.weekAnchor);
        store.setWeekAnchor(ymd(addDays(m, -7)));
      });
      $("#next-week").addEventListener("click", () => {
        const m = parseYmd(store.ui.weekAnchor);
        store.setWeekAnchor(ymd(addDays(m, 7)));
      });
      $("#today-btn").addEventListener("click", () => {
        store.setWeekAnchor(ymd(startOfWeek(new Date())));
      });
      $("#add-person-btn").addEventListener("click", () => openModal("add"));
      $("#manage-people-btn").addEventListener("click", () => openModal("manage"));
      $("#settings-btn").addEventListener("click", () => openModal("settings"));
      $("#refresh-btn").addEventListener("click", () => store.refreshFromRemote());
      $("#sync-status").addEventListener("click", () => store.refreshFromRemote());
      $("#setup-link")?.addEventListener("click", (e) => { e.preventDefault(); openModal("settings"); });

      $("#modal-cancel").addEventListener("click", closeModal);
      modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !modal.hidden) closeModal();
      });
    },

    _onStoreEvent(evt) {
      if (evt.type === "data" || evt.type === "loaded" || evt.type === "ui" || evt.type === "settings") {
        this.render();
      } else if (evt.type === "saving") {
        this._setSyncStatus("saving", "Saving…");
      } else if (evt.type === "saved") {
        this._setSyncStatus("ok", "Saved");
      } else if (evt.type === "dirty") {
        this._setSyncStatus("saving", "Editing…");
      } else if (evt.type === "error") {
        const msg = evt.phase === "refresh" ? "Refresh failed" :
                    evt.phase === "save"    ? "Save failed"    : "Load failed";
        this._setSyncStatus("error", msg);
      }
    },

    _setSyncStatus(kind, label) {
      const el = $("#sync-status");
      el.classList.remove("sync-status--ok", "sync-status--saving", "sync-status--error", "sync-status--loading", "sync-status--local");
      el.classList.add("sync-status--" + kind);
      el.querySelector(".label").textContent = label;
    },

    render() {
      this._renderSetupBanner();
      this._renderUserBar();
      this._renderWeekNav();
      this._renderGrid();
      this._renderSyncStatus();
    },

    _renderSetupBanner() {
      const banner = $("#setup-banner");
      if (store.backend === LocalBackend) {
        banner.hidden = false;
      } else {
        banner.hidden = true;
      }
    },

    _renderSyncStatus() {
      if (store.backend === LocalBackend) {
        this._setSyncStatus("local", "Local only");
      } else if (store._saveQueued) {
        this._setSyncStatus("saving", "Saving…");
      } else {
        this._setSyncStatus("ok", "Synced");
      }
    },

    _renderUserBar() {
      const sel = $("#current-user");
      sel.innerHTML = "";
      if (store.data.people.length === 0) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "— no one yet —";
        sel.appendChild(opt);
        sel.disabled = true;
        return;
      }
      sel.disabled = false;
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "— select —";
      sel.appendChild(placeholder);
      for (const p of store.data.people) {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.name + (p.id === store.ui.currentUserId ? " (you)" : "");
        sel.appendChild(opt);
      }
      sel.value = store.ui.currentUserId || "";
    },

    _renderWeekNav() {
      const monday = parseYmd(store.ui.weekAnchor);
      const today = new Date();
      const thisMonday = ymd(startOfWeek(today));
      const label = (thisMonday === store.ui.weekAnchor) ? "This week" : formatWeekLabel(monday);
      $("#week-label").textContent = label;
    },

    _renderGrid() {
      const grid = $("#week-grid");
      grid.innerHTML = "";
      const monday = parseYmd(store.ui.weekAnchor);
      const today = new Date();

      for (let i = 0; i < 7; i++) {
        const date = addDays(monday, i);
        const dateKey = ymd(date);
        const day = DAYS[i];

        const card = document.createElement("section");
        card.className = "day-card" + (isSameDay(date, today) ? " today" : "");
        card.dataset.date = dateKey;

        const h3 = document.createElement("h3");
        const dow = document.createElement("span");
        dow.className = "dow";
        dow.textContent = day.long;
        const dateSpan = document.createElement("span");
        dateSpan.className = "date";
        dateSpan.textContent = date.toLocaleString(undefined, { month: "short", day: "numeric" });
        h3.appendChild(dow);
        h3.appendChild(dateSpan);
        card.appendChild(h3);

        const dinner = document.createElement("input");
        dinner.type = "text";
        dinner.className = "dinner-input";
        dinner.placeholder = "Dinner idea…";
        dinner.value = store.data.dinners[dateKey] || "";
        // Use 'change' to keep typing responsive (we save on every keystroke
        // with a debounce, but the input itself doesn't need to rerender).
        dinner.addEventListener("input", (e) => {
          store.setDinner(dateKey, e.target.value);
        });
        card.appendChild(dinner);

        const ul = document.createElement("ul");
        ul.className = "votes";
        if (store.data.people.length === 0) {
          const li = document.createElement("li");
          li.className = "empty";
          li.textContent = "Add a person to start voting.";
          ul.appendChild(li);
        } else {
          for (const person of store.data.people) {
            const li = document.createElement("li");
            li.className = "vote-row";
            const voteKey = `${dateKey}|${person.id}`;
            const home = store.data.votes[voteKey] === true;
            li.classList.add(home ? "home" : "away");
            li.dataset.voteKey = voteKey;

            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = home;
            cb.setAttribute("aria-label", `${person.name} is home on ${day.long}`);

            const name = document.createElement("span");
            name.className = "name";
            name.textContent = person.name;

            li.appendChild(cb);
            li.appendChild(name);

            li.addEventListener("click", (e) => {
              if (e.target !== cb) cb.checked = !cb.checked;
              const isHome = cb.checked;
              store.setVote(dateKey, person.id, isHome);
              // Local optimistic update — no full re-render.
              li.classList.toggle("home", isHome);
              li.classList.toggle("away", !isHome);
              this._renderGrid();
            });

            ul.appendChild(li);
          }
        }
        card.appendChild(ul);

        const summary = document.createElement("div");
        summary.className = "day-summary";
        if (store.data.people.length > 0) {
          const total = store.data.people.length;
          let homeCount = 0;
          for (const p of store.data.people) {
            if (store.data.votes[`${dateKey}|${p.id}`] === true) homeCount++;
          }
          const count = document.createElement("div");
          count.className = "count";
          count.innerHTML = `<strong>${homeCount}</strong> of <strong>${total}</strong> home`;
          summary.appendChild(count);

          if (homeCount === total) {
            const plan = document.createElement("div");
            plan.className = "plan";
            plan.textContent = "✓ Dinner on: " + (store.data.dinners[dateKey] || "— pick a meal —");
            summary.appendChild(plan);
          }
        }
        card.appendChild(summary);

        grid.appendChild(card);
      }
    },
  };

  // ---------- Modal ----------
  const modal = $("#modal");
  const modalTitle = $("#modal-title");
  const modalBody = $("#modal-body");

  function openModal(mode) {
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    if (mode === "add") renderAddPerson();
    else if (mode === "manage") renderManagePeople();
    else if (mode === "settings") renderSettings();
  }
  function closeModal() {
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
    modalBody.innerHTML = "";
  }

  function renderAddPerson() {
    modalTitle.textContent = "Add a person";
    modalBody.innerHTML = `
      <div class="form-row">
        <input type="text" id="new-person-name" placeholder="Name (e.g. Troy)" maxlength="40" />
        <button type="button" id="new-person-submit" class="btn">Add</button>
      </div>
    `;
    const input = $("#new-person-name", modalBody);
    const submit = $("#new-person-submit", modalBody);
    const onSubmit = () => {
      const person = store.addPerson(input.value);
      input.value = "";
      input.focus();
      if (!person) return;
    };
    submit.addEventListener("click", onSubmit);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") onSubmit(); });
    setTimeout(() => input.focus(), 0);
  }

  function renderManagePeople() {
    modalTitle.textContent = "Manage people";
    modalBody.innerHTML = "";
    if (store.data.people.length === 0) {
      const p = document.createElement("p");
      p.style.color = "var(--muted)";
      p.style.margin = "0 0 0.5rem";
      p.textContent = "No people yet. Use \"Add person\" to create one.";
      modalBody.appendChild(p);
      return;
    }
    const list = document.createElement("ul");
    list.className = "person-list";
    for (const person of store.data.people) {
      const li = document.createElement("li");
      const left = document.createElement("span");
      left.textContent = person.name;
      const right = document.createElement("span");
      right.className = "meta";
      right.textContent = `added ${new Date(person.createdAt).toLocaleDateString()}`;
      li.appendChild(left);
      li.appendChild(right);
      const del = document.createElement("button");
      del.className = "btn btn-danger";
      del.textContent = "Remove";
      del.addEventListener("click", () => {
        if (confirm(`Remove ${person.name}? Their votes will be cleared.`)) {
          store.removePerson(person.id);
          renderManagePeople();
        }
      });
      li.appendChild(del);
      list.appendChild(li);
    }
    modalBody.appendChild(list);
  }

  function renderSettings() {
    modalTitle.textContent = "Settings — GitHub sharing";
    const s = { ...DEFAULT_SETTINGS, ...store.settings };
    modalBody.innerHTML = "";

    const form = document.createElement("div");
    form.className = "settings-form";

    form.innerHTML = `
      <label>Owner (GitHub username or org)
        <input type="text" id="cfg-owner" value="${escapeAttr(s.owner)}" />
      </label>
      <label>Repository
        <input type="text" id="cfg-repo" value="${escapeAttr(s.repo)}" />
      </label>
      <label>Branch
        <input type="text" id="cfg-branch" value="${escapeAttr(s.branch)}" />
      </label>
      <label>File path
        <input type="text" id="cfg-path" value="${escapeAttr(s.path)}" />
      </label>
      <label>Personal access token (with Contents: Read and write)
        <input type="password" id="cfg-token" value="${escapeAttr(s.token)}" placeholder="github_pat_..." autocomplete="off" />
        <span class="hint">
          Generate at
          <a class="help-link" href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noopener">github.com/settings/tokens</a>
          — restrict the token to this one repo.
          Stored only in this browser.
        </span>
      </label>
      <label class="checkbox">
        <input type="checkbox" id="cfg-migrate" />
        Migrate existing local data into the shared file
      </label>
      <div id="cfg-status" class="status-line" hidden></div>
      <div class="modal-actions" style="margin-top:0.5rem;">
        <button type="button" id="cfg-test" class="btn">Test connection</button>
        <button type="button" id="cfg-save" class="btn">Save</button>
      </div>
    `;
    modalBody.appendChild(form);

    const status = $("#cfg-status", form);
    function setStatus(text, kind) {
      status.hidden = false;
      status.textContent = text;
      status.classList.remove("ok", "error");
      if (kind) status.classList.add(kind);
    }

    function readForm() {
      return {
        owner:  $("#cfg-owner",  form).value.trim(),
        repo:   $("#cfg-repo",   form).value.trim(),
        branch: $("#cfg-branch", form).value.trim() || "main",
        path:   $("#cfg-path",   form).value.trim() || "data.json",
        token:  $("#cfg-token",  form).value.trim(),
      };
    }

    $("#cfg-test", form).addEventListener("click", async () => {
      const candidate = readForm();
      if (!GitHubBackend.isConfigured(candidate)) {
        setStatus("Please fill in owner, repo, branch, path, and token.", "error");
        return;
      }
      setStatus("Testing…");
      try {
        const r = await GitHubBackend.load(candidate);
        if (r.exists) {
          setStatus(`Connection OK. Existing data has ${r.data.people.length} people, ${Object.keys(r.data.dinners).length} dinners, ${Object.keys(r.data.votes).length} votes.`, "ok");
        } else {
          setStatus("Connection OK. No data.json yet — it will be created on the first save.", "ok");
        }
      } catch (e) {
        setStatus(String(e.message || e), "error");
      }
    });

    $("#cfg-save", form).addEventListener("click", async () => {
      const candidate = readForm();
      if (!GitHubBackend.isConfigured(candidate)) {
        setStatus("Please fill in owner, repo, branch, path, and token.", "error");
        return;
      }
      setStatus("Saving settings…");

      // Optionally seed the remote with current local data on first write.
      const migrate = $("#cfg-migrate", form).checked;
      let localSnapshot = null;
      if (migrate) {
        localSnapshot = normalizeData(loadJson(KEY.DATA, null));
        if (!localSnapshot || (localSnapshot.people.length === 0 && Object.keys(localSnapshot.dinners).length === 0 && Object.keys(localSnapshot.votes).length === 0)) {
          localSnapshot = null;
        }
      }

      try {
        // Apply settings first so the store points at GitHub, then load.
        store.updateSettings(candidate);
        await store.load();
        if (migrate && localSnapshot) {
          const merged = mergeData(store.data, localSnapshot);
          store.data = merged;
          store._saveQueued = true;
          await store._flushSave();
        }
        store.startPolling();
        setStatus("Saved. You're now sharing via GitHub.", "ok");
        view.render();
        setTimeout(closeModal, 700);
      } catch (e) {
        setStatus(String(e.message || e), "error");
      }
    });
  }

  function escapeAttr(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------- Bootstrap ----------
  async function init() {
    // Carry over legacy fd.people / fd.dinners / fd.votes on first run so
    // the user doesn't lose their existing local data.
    if (!loadJson(KEY.DATA, null) && (loadJson("fd.people") || loadJson("fd.dinners") || loadJson("fd.votes"))) {
      const legacy = migrateLegacy();
      saveJson(KEY.DATA, legacy);
    }

    store.init();
    view.init();
    await store.load();
    view.render();
    if (store.backend === GitHubBackend) store.startPolling();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
