/* =============================================================================
   🛡 guard.js — shared client helpers (auth guard, api, toasts, dom)
   Browser side ka chhota sa toolkit. Koi secret yahan nahi hota.
   ============================================================================= */
(function () {
  "use strict";

  const SHD = (window.SHD = window.SHD || {});

  /* ── tiny DOM helpers ───────────────────────────────────────────────────── */
  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "html") node.innerHTML = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
      else if (key === "dataset") Object.assign(node.dataset, value);
      else node.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of children.flat(9)) {
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
    }
    return node;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function esc(text) {
    return String(text === null || text === undefined ? "" : text);
  }

  /* ── toasts ─────────────────────────────────────────────────────────────── */
  function toast(message, kind) {
    const wrap = document.getElementById("toasts");
    if (!wrap) return;
    const item = h("div", { class: "toast " + (kind || "") }, esc(message));
    wrap.appendChild(item);
    setTimeout(() => {
      item.style.opacity = "0";
      item.style.transition = "opacity .25s";
      setTimeout(() => item.remove(), 260);
    }, kind === "bad" ? 5200 : 3400);
  }

  /* ── api ────────────────────────────────────────────────────────────────── */
  async function api(path, options) {
    const opts = Object.assign({ method: "GET" }, options || {});
    const init = {
      method: opts.method,
      headers: Object.assign({ Accept: "application/json" }, opts.headers || {}),
      credentials: "same-origin",
      cache: "no-store",
    };
    if (opts.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch (error) {
      throw Object.assign(new Error("Network error — server tak pahunch nahi paye."), { status: 0, code: "NETWORK" });
    }

    let data = null;
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (_) {
        data = { message: text.slice(0, 240) };
      }
    }

    if (!res.ok) {
      const message = (data && (data.message || data.error)) || `Request failed (${res.status})`;
      throw Object.assign(new Error(message), { status: res.status, code: (data && data.error) || "", data });
    }
    return data || {};
  }

  /* ── session state ──────────────────────────────────────────────────────── */
  const state = {
    config: null,
    student: null,
    admin: false,
    adminConfigured: false,
  };

  async function loadConfig() {
    if (state.config) return state.config;
    try {
      state.config = await api("/api/config");
    } catch (error) {
      state.config = { ok: false, appName: "Study helper Doc", dailyLimit: 20, resetTimeIST: "12:00 AM" };
      toast("Config load nahi hua: " + error.message, "bad");
    }
    paintChrome();
    return state.config;
  }

  async function loadSession() {
    try {
      const [student, admin] = await Promise.all([api("/api/auth/session"), api("/api/admin/session")]);
      state.student = student && student.loggedIn ? student : null;
      state.admin = Boolean(admin && admin.loggedIn);
      state.adminConfigured = Boolean(admin && admin.configured);
    } catch (_) {
      state.student = null;
      state.admin = false;
    }
    paintChrome();
    return state;
  }

  function paintChrome() {
    const cfg = state.config || {};
    const brandName = document.getElementById("brandName");
    const brandTag = document.getElementById("brandTag");
    const footerNote = document.getElementById("footerNote");
    const footerTelegram = document.getElementById("footerTelegram");
    const who = document.getElementById("whoami");
    const authButton = document.getElementById("authButton");
    const navAdmin = document.getElementById("navAdmin");

    if (brandName) brandName.textContent = cfg.appName || "Study helper Doc";
    if (footerNote) footerNote.textContent = `${cfg.appName || "Study helper Doc"} · videos Telegram par milte hain`;
    if (footerTelegram && cfg.telegramUrl) footerTelegram.href = cfg.telegramUrl;
    if (brandTag) brandTag.textContent = cfg.tagline || "Courses · Lectures · PDFs";
    if (document.title && cfg.appName) document.title = cfg.appName;

    if (navAdmin) navAdmin.hidden = !(state.admin || state.adminConfigured);
    if (who) who.textContent = state.student ? `${state.student.name || state.student.uid}` : state.admin ? "admin" : "";
    if (authButton) {
      authButton.textContent = state.student || state.admin ? "Logout" : "Login";
      authButton.dataset.mode = state.student || state.admin ? "out" : "in";
    }

    const hash = location.hash || "#/";
    document.querySelectorAll("[data-nav]").forEach((link) => {
      const key = link.getAttribute("data-nav");
      link.classList.toggle("is-on", hash.startsWith("#/" + key) || (key === "courses" && (hash === "#/" || hash === "")));
    });
  }

  /** Login zaroori ho aur na ho → true (page guard) */
  function requireLogin(then) {
    if (state.student) return then ? then() : true;
    openLoginSheet("student");
    if (then) SHD.pendingAfterLogin = then;
    return false;
  }

  function requireAdmin(then) {
    if (state.admin) return then ? then() : true;
    openLoginSheet("admin");
    if (then) SHD.pendingAfterLogin = then;
    return false;
  }

  /* ── login sheet ────────────────────────────────────────────────────────── */
  let sheetTab = "student";

  function openLoginSheet(tab) {
    const sheet = document.getElementById("loginSheet");
    if (!sheet) return;
    sheetTab = tab === "admin" ? "admin" : "student";
    syncSheet();
    sheet.hidden = false;
    const input = document.getElementById("loginId");
    if (input) {
      input.value = "";
      setTimeout(() => input.focus(), 40);
    }
    const err = document.getElementById("loginError");
    if (err) err.hidden = true;
  }

  function closeLoginSheet() {
    const sheet = document.getElementById("loginSheet");
    if (sheet) sheet.hidden = true;
  }

  function syncSheet() {
    const isAdminTab = sheetTab === "admin";
    document.querySelectorAll("#loginTabs .tab-mini").forEach((button) => {
      button.classList.toggle("is-on", button.dataset.tab === sheetTab);
    });
    const title = document.getElementById("loginTitle");
    const idLabel = document.getElementById("idLabel");
    const submit = document.getElementById("loginSubmit");
    if (title) title.textContent = isAdminTab ? "Admin login" : "Student login";
    if (idLabel) idLabel.textContent = isAdminTab ? "Admin email" : "Login id / email / mobile";
    if (submit) submit.textContent = isAdminTab ? "Login as admin" : "Login";
  }

  async function submitLogin(event) {
    event.preventDefault();
    const id = String((document.getElementById("loginId") || {}).value || "").trim();
    const password = String((document.getElementById("loginPassword") || {}).value || "");
    const err = document.getElementById("loginError");
    const submit = document.getElementById("loginSubmit");
    if (err) err.hidden = true;
    if (!id || !password) {
      if (err) {
        err.textContent = "Id aur password dono zaroori hain.";
        err.hidden = false;
      }
      return;
    }
    if (submit) submit.disabled = true;
    try {
      if (sheetTab === "admin") {
        await api("/api/admin/login", { method: "POST", body: { email: id, password } });
        toast("Admin login ho gaya ✅", "ok");
      } else {
        await api("/api/auth/login", { method: "POST", body: { identifier: id, password } });
        toast("Login ho gaya ✅", "ok");
      }
      closeLoginSheet();
      await loadSession();
      const pending = SHD.pendingAfterLogin;
      SHD.pendingAfterLogin = null;
      if (typeof pending === "function") pending();
      else if (SHD.route) SHD.route(true);
    } catch (error) {
      if (err) {
        err.textContent = error.message;
        err.hidden = false;
      }
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  async function logout() {
    try {
      await Promise.all([api("/api/auth/logout", { method: "POST" }), api("/api/admin/logout", { method: "POST" })]);
    } catch (_) {
      /* ignore */
    }
    state.student = null;
    state.admin = false;
    paintChrome();
    toast("Logout ho gaya");
    location.hash = "#/";
    if (SHD.route) SHD.route(true);
  }

  /* ── formatting ─────────────────────────────────────────────────────────── */
  function when(ms) {
    const value = Number(ms || 0);
    if (!value) return "—";
    try {
      return new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
    } catch (_) {
      return String(value);
    }
  }

  function ago(ms) {
    const value = Number(ms || 0);
    if (!value) return "never";
    const sec = Math.max(0, Math.floor((Date.now() - value) / 1000));
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
  }

  /* ── boot ───────────────────────────────────────────────────────────────── */
  function boot() {
    const sheet = document.getElementById("loginSheet");
    document.querySelectorAll("[data-close-sheet]").forEach((button) => button.addEventListener("click", closeLoginSheet));
    if (sheet) sheet.addEventListener("click", (event) => { if (event.target === sheet) closeLoginSheet(); });
    document.querySelectorAll("#loginTabs .tab-mini").forEach((button) => {
      button.addEventListener("click", () => { sheetTab = button.dataset.tab; syncSheet(); });
    });
    const form = document.getElementById("loginForm");
    if (form) form.addEventListener("submit", submitLogin);
    const authButton = document.getElementById("authButton");
    if (authButton) {
      authButton.addEventListener("click", () => {
        if (authButton.dataset.mode === "out") logout();
        else openLoginSheet("student");
      });
    }
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeLoginSheet();
    });
  }

  Object.assign(SHD, {
    h, clear, esc, toast, api, state, loadConfig, loadSession, paintChrome,
    requireLogin, requireAdmin, openLoginSheet, closeLoginSheet, logout, when, ago, boot,
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
