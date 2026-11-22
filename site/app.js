/* =============================================================================
   📱 app.js — student side (router + pages)
   -----------------------------------------------------------------------------
   v5 rule: website video PLAY ya DOWNLOAD nahi karti. Watch page par poster +
   "▶ Open in Telegram" button hai → button ek delivery request banata hai aur
   Telegram bot ko deep-link karta hai. Bot video bhejta hai, 2 ghante baad
   auto-delete.
   ============================================================================= */
(function () {
  "use strict";

  const SHD = window.SHD;
  const { h, clear, api, state, toast, when } = SHD;

  const view = () => document.getElementById("view");
  const treeCache = new Map();

  /* ── router ─────────────────────────────────────────────────────────────── */
  function parseHash() {
    const raw = String(location.hash || "#/").replace(/^#\/?/, "");
    const parts = raw.split("/").filter(Boolean).map(decodeURIComponent);
    return { name: parts[0] || "home", parts };
  }

  async function route(force) {
    const { name, parts } = parseHash();
    if (!force) SHD.paintChrome();
    const target = view();
    if (!target) return;
    clear(target);
    target.appendChild(h("div", { class: "loader" }, "Loading…"));

    try {
      if (name === "home") await pageHome(target);
      else if (name === "courses") await pageCourses(target);
      else if (name === "course") await pageCourse(target, parts[1]);
      else if (name === "watch") await pageWatch(target, parts[1], parts[2]);
      else if (name === "requests") await pageRequests(target);
      else if (name === "login") { clear(target); await pageHome(target); SHD.openLoginSheet("student"); }
      else if (name === "admin") await window.SHDAdmin.render(target);
      else pageNotFound(target);
    } catch (error) {
      clear(target);
      target.appendChild(
        h("div", { class: "notice bad" }, `Page load nahi hua: ${error.message}`)
      );
    }
    SHD.paintChrome();
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  }

  function pageNotFound(target) {
    clear(target);
    target.appendChild(
      h("div", { class: "card" },
        h("h2", { class: "font-display" }, "Page not found"),
        h("p", { class: "muted" }, "Yeh link kaam nahi karta."),
        h("a", { class: "btn btn-primary", href: "#/courses" }, "Courses dekhiye"))
    );
  }

  function pageHead(title, subtitle, ...actions) {
    return h("div", { class: "page-head" },
      h("div", {}, h("h1", {}, title), subtitle ? h("p", {}, subtitle) : null),
      h("div", { class: "spacer" }),
      ...actions);
  }

  /* ── home ───────────────────────────────────────────────────────────────── */
  async function pageHome(target) {
    const cfg = await SHD.loadConfig();
    let batches = [];
    if (state.student) {
      try {
        batches = ((await api("/api/batches")).batches) || [];
      } catch (error) {
        toast(error.message, "bad");
      }
    }

    clear(target);
    target.appendChild(
      h("section", { class: "hero" },
        h("h1", {}, "Aapke courses, ", h("em", {}, "seedha Telegram par."), ""),
        h("p", {},
          `${cfg.appName || "Study helper Doc"} par lecture kholiye, "▶ Open in Telegram" dabaiye — ` +
          `video aapke Telegram chat me aa jayega aur ${cfg.autoDeleteHours || 2} ghante baad apne aap delete ho jayega.`),
        h("div", { class: "hero-actions" },
          state.student
            ? h("a", { class: "btn btn-primary", href: "#/courses" }, "Browse courses")
            : h("button", { class: "btn btn-primary", type: "button", onclick: () => SHD.openLoginSheet("student") }, "Login karke shuru kijiye"),
          h("a", { class: "btn btn-ghost", href: cfg.telegramUrl || "https://t.me/krishna84", target: "_blank", rel: "noopener noreferrer" }, "Telegram channel"),
          h("a", { class: "btn btn-ghost", href: "#/requests" }, "My requests"))));

    if (cfg.maintenanceMode) {
      target.appendChild(h("div", { class: "notice warn" }, cfg.maintenanceMessage || "Site under maintenance."));
    }

    target.appendChild(
      h("div", { class: "section-title" },
        h("h2", {}, state.student ? "Aapke courses" : "Login ke baad courses dikhenge"),
        h("div", { class: "spacer" }),
        state.student ? h("a", { class: "tiny", href: "#/courses" }, "sabhi dekhiye →") : null));

    if (!state.student) {
      target.appendChild(h("div", { class: "empty" }, "Content login ke baad khulta hai — upar Login dabaiye."));
      return;
    }
    if (!batches.length) {
      target.appendChild(h("div", { class: "empty" }, "Abhi koi course nahi hai."));
      return;
    }
    target.appendChild(courseGrid(batches.slice(0, 8)));
  }

  function courseGrid(batches) {
    return h("div", { class: "grid courses" },
      batches.map((batch) =>
        h("a", { class: "card course-card", href: `#/course/${encodeURIComponent(batch.id)}` },
          batch.thumbnail
            ? h("img", { class: "course-thumb", src: batch.thumbnail, alt: "", loading: "lazy", referrerpolicy: "no-referrer" })
            : h("div", { class: "course-thumb-empty" }, (batch.name || "?").slice(0, 1).toUpperCase()),
          h("div", { class: "course-body" },
            h("h3", { class: "course-title" }, batch.name || `Course ${batch.id}`),
            h("div", { class: "course-meta" },
              h("span", { class: "chip" }, `🎬 ${batch.videos || 0}`),
              h("span", { class: "chip" }, `📄 ${batch.files || 0}`),
              batch.source && batch.source !== "file" ? h("span", { class: "chip ember" }, "telegram") : null)))));
  }

  /* ── courses ────────────────────────────────────────────────────────────── */
  async function pageCourses(target) {
    if (!SHD.requireLogin(() => route(true))) { clear(target); return; }
    const data = await api("/api/batches");
    const batches = data.batches || [];

    clear(target);
    target.appendChild(pageHead("Courses", `${batches.length} course available`, h("a", { class: "btn btn-ghost btn-sm", href: "#/requests" }, "My requests")));

    const search = h("input", { type: "search", placeholder: "Course ka naam dhoondhiye…", value: "" });
    const listWrap = h("div", {});
    const paint = () => {
      const q = String(search.value || "").trim().toLowerCase();
      const filtered = q ? batches.filter((b) => String(b.name || "").toLowerCase().includes(q)) : batches;
      clear(listWrap);
      listWrap.appendChild(filtered.length ? courseGrid(filtered) : h("div", { class: "empty" }, "Kuch nahi mila."));
    };
    search.addEventListener("input", paint);
    target.appendChild(h("div", { class: "searchbar" }, search, h("span", { class: "tiny" }, `${batches.length} total`)));
    target.appendChild(listWrap);
    paint();
  }

  /* ── course tree ────────────────────────────────────────────────────────── */
  async function loadTree(batchId) {
    const key = String(batchId);
    if (treeCache.has(key)) return treeCache.get(key);
    const data = await api(`/api/batches/${encodeURIComponent(key)}`);
    treeCache.set(key, data);
    return data;
  }

  async function pageCourse(target, batchId) {
    if (!batchId) return pageCourses(target);
    if (!SHD.requireLogin(() => route(true))) { clear(target); return; }
    const batch = await loadTree(batchId);

    clear(target);
    target.appendChild(h("div", { class: "breadcrumb" },
      h("a", { href: "#/courses" }, "Courses"), h("span", { class: "sep" }, "/"), h("span", {}, batch.name)));
    target.appendChild(pageHead(batch.name,
      `${batch.counts ? batch.counts.videos : 0} videos · ${batch.counts ? batch.counts.files : 0} files`,
      batch.thumbnail ? h("img", { src: batch.thumbnail, alt: "", style: "height:52px;border-radius:2px 9px 2px 9px;border:1px solid var(--hairline)", referrerpolicy: "no-referrer" }) : null));

    const search = h("input", { type: "search", placeholder: "Lecture dhoondhiye (title me)…" });
    const treeWrap = h("div", { class: "tree" });
    const statusLine = h("div", { class: "tiny", style: "margin:0 0 8px" }, "");

    function nodeRow(node, depth) {
      const isVideo = String(node.type || "").toUpperCase() === "VIDEO";
      const row = h("div", { class: "node" + (isVideo ? " is-video" : "") },
        h("span", { class: "node-icon" }, isVideo ? "▶" : "🗀"),
        h("span", { class: "node-title", title: node.title }, node.title || "(untitled)"),
        h("span", { class: "node-side" },
          isVideo
            ? (node.hasTelegram
              ? h("span", { class: "chip ember" }, "telegram")
              : node.youtubeOnly
                ? h("span", { class: "chip warn" }, "jaldi aayega")
                : h("span", { class: "chip" }, "soon"))
            : h("span", { class: "chip" }, `${node.videosCount || 0} 🎬`)));

      if (isVideo) {
        row.addEventListener("click", () => {
          location.hash = `#/watch/${encodeURIComponent(batch.id)}/${encodeURIComponent(node.id)}`;
        });
        return row;
      }

      const kids = h("div", { class: "children" });
      (node.children || []).forEach((child) => kids.appendChild(nodeRow(child, depth + 1)));
      const toggle = (open) => {
        kids.hidden = !open;
        row.querySelector(".node-icon").textContent = open ? "🗁" : "🗀";
      };
      row.addEventListener("click", () => toggle(kids.hidden));
      kids.hidden = depth > 0;
      toggle(!kids.hidden);
      return h("div", {}, row, kids);
    }

    const paint = () => {
      const q = String(search.value || "").trim().toLowerCase();
      clear(treeWrap);
      if (!q) {
        (batch.tree || []).forEach((node) => treeWrap.appendChild(nodeRow(node, 0)));
        statusLine.textContent = `${(batch.tree || []).length} top folders`;
        return;
      }
      // search: sirf matching video rows (flat)
      const hits = [];
      const walk = (nodes, trail) => {
        for (const node of nodes || []) {
          const next = [...trail, node.title || ""];
          if (String(node.type || "").toUpperCase() === "VIDEO") {
            if (String(node.title || "").toLowerCase().includes(q) || next.join(" ").toLowerCase().includes(q)) {
              hits.push({ node, trail: next });
            }
          } else walk(node.children, next);
        }
      };
      walk(batch.tree, []);
      statusLine.textContent = `${hits.length} result`;
      hits.slice(0, 200).forEach(({ node, trail }) => {
        const row = h("div", { class: "node is-video" },
          h("span", { class: "node-icon" }, "▶"),
          h("span", { class: "node-title" }, node.title),
          h("span", { class: "node-side" }, node.hasTelegram ? h("span", { class: "chip ember" }, "telegram") : h("span", { class: "chip" }, "soon")));
        row.addEventListener("click", () => {
          location.hash = `#/watch/${encodeURIComponent(batch.id)}/${encodeURIComponent(node.id)}`;
        });
        treeWrap.appendChild(h("div", {}, row, h("div", { class: "tiny", style: "margin:-2px 0 4px 32px" }, trail.slice(0, -1).join(" › "))));
      });
      if (!hits.length) treeWrap.appendChild(h("div", { class: "empty" }, "Kuch nahi mila."));
    };

    search.addEventListener("input", paint);
    target.appendChild(h("div", { class: "searchbar" }, search));
    target.appendChild(statusLine);
    target.appendChild(treeWrap);
    paint();
  }

  /* ── watch page (poster + ▶ Open in Telegram) ───────────────────────────── */
  async function pageWatch(target, batchId, nodeId) {
    if (!batchId || !nodeId) return pageCourses(target);
    if (!SHD.requireLogin(() => route(true))) { clear(target); return; }

    const cfg = await SHD.loadConfig();
    const batch = await loadTree(batchId);
    const found = findPublicNode(batch.tree || batch.publicTree || [], nodeId);
    if (!found) {
      clear(target);
      target.appendChild(h("div", { class: "notice bad" }, "Yeh lecture is course me nahi mila."));
      return;
    }
    const { node, trail } = found;

    clear(target);
    target.appendChild(h("div", { class: "breadcrumb" },
      h("a", { href: "#/courses" }, "Courses"), h("span", { class: "sep" }, "/"),
      h("a", { href: `#/course/${encodeURIComponent(batchId)}` }, batch.name), h("span", { class: "sep" }, "/"),
      h("span", {}, trail.slice(0, -1).join(" › ") || "—")));

    const quotaLine = h("div", { class: "quota-line" }, "");
    const button = h("button", { class: "play-btn", type: "button" }, "▶ Open in Telegram");
    const poster = h("div", { class: "poster" },
      node.thumbnail
        ? h("img", { src: node.thumbnail, alt: "", referrerpolicy: "no-referrer" })
        : h("div", { class: "poster-fallback" }, node.title),
      h("div", { class: "play-overlay" }, button));

    const statusBox = h("div", {});

    target.appendChild(h("div", { class: "watch" },
      h("div", {}, poster, quotaLine, statusBox),
      h("div", { class: "card" },
        h("h2", { class: "font-display" }, node.title),
        h("dl", { class: "kv", style: "margin:12px 0 0" },
          h("dt", {}, "Course"), h("dd", {}, batch.name),
          h("dt", {}, "Folder"), h("dd", {}, trail.slice(0, -1).join(" › ") || "—"),
          node.uploadedAt ? h("dt", {}, "Uploaded") : null,
          node.uploadedAt ? h("dd", {}, node.uploadedAt) : null,
          node.sizeMb ? h("dt", {}, "Size") : null,
          node.sizeMb ? h("dd", {}, `${node.sizeMb} MB`) : null),
        h("div", { class: "notice", style: "margin-top:14px" },
          h("strong", {}, "Kaise milega?"),
          h("ol", { class: "steps", style: "margin-top:6px" },
            h("li", {}, "▶ Open in Telegram dabaiye."),
            h("li", {}, "Telegram me bot ka chat khulega — Start dabaiye."),
            h("li", {}, `Bot video yahan bhej dega aur ${cfg.autoDeleteHours || 2} ghante baad delete kar dega.`),
            h("li", {}, `Roz ${cfg.dailyLimit || 20} video — limit ${cfg.resetTimeIST || "12:00 AM"} (Indian time) par reset.`))))));

    // quota line (sirf ek chhoti line — baaki messaging bot me hai)
    try {
      const quota = await api("/api/tg/quota");
      quotaLine.textContent = `${quota.remaining} of ${quota.limit} left today · resets ${quota.resetTimeIST}`;
    } catch (error) {
      quotaLine.textContent = "";
    }

    if (!node.hasTelegram) {
      button.disabled = true;
      button.textContent = "Not available yet";
      statusBox.appendChild(
        h("div", { class: "notice warn", style: "margin-top:12px" },
          node.youtubeOnly
            ? "This content is not available on Telegram yet. It will be uploaded soon."
            : "This lecture has no Telegram source yet. It will be uploaded soon."));
      return;
    }

    let busy = false;
    button.addEventListener("click", async () => {
      if (busy) return;
      busy = true;
      button.disabled = true;
      button.textContent = "Requesting…";
      clear(statusBox);
      try {
        const res = await api("/api/tg/request", {
          method: "POST",
          body: { batchId, nodeId, title: node.title },
        });
        const link = res.deepLink;
        if (!link) {
          statusBox.appendChild(h("div", { class: "notice bad" },
            "Bot username set nahi hai — admin se boliye (TELEGRAM_BOT_USERNAME)."));
          toast("Bot username missing", "bad");
          return;
        }
        statusBox.appendChild(
          h("div", { class: "notice ok", style: "margin-top:12px" },
            h("strong", {}, res.reused ? "Request already active ✅" : "Request ban gayi ✅"),
            h("p", { class: "muted", style: "margin:6px 0 10px" },
              "Telegram me bot khulega — Start dabaiye aur video mil jayega."),
            h("a", { class: "btn btn-primary btn-wide", href: link, target: "_blank", rel: "noopener noreferrer" }, "📲 Open Telegram bot"),
            h("div", { class: "tiny", style: "margin-top:8px" }, `request id: ${res.requestId}`)));
        try {
          window.open(link, "_blank", "noopener,noreferrer");
        } catch (_) {
          location.href = link;
        }
        toast("Telegram me Start dabaiye", "ok");
      } catch (error) {
        statusBox.appendChild(h("div", { class: "notice bad", style: "margin-top:12px" },
          h("strong", {}, "Request fail"), h("div", {}, error.message),
          error.code === "DAILY_LIMIT" && error.data && error.data.resetTimeIST
            ? h("div", { class: "tiny", style: "margin-top:4px" }, `Resets at ${error.data.resetTimeIST} (Indian time)`)
            : null));
        toast(error.message, "bad");
      } finally {
        busy = false;
        button.disabled = false;
        button.textContent = "▶ Open in Telegram";
        try {
          const quota = await api("/api/tg/quota");
          quotaLine.textContent = `${quota.remaining} of ${quota.limit} left today · resets ${quota.resetTimeIST}`;
        } catch (_) { /* ignore */ }
      }
    });
  }

  function findPublicNode(nodes, nodeId, trail) {
    for (const node of nodes || []) {
      const next = [...(trail || []), node.title || ""];
      if (String(node.id) === String(nodeId)) return { node, trail: next };
      const found = findPublicNode(node.children, nodeId, next);
      if (found) return found;
    }
    return null;
  }

  /* ── my requests ────────────────────────────────────────────────────────── */
  async function pageRequests(target) {
    if (!SHD.requireLogin(() => route(true))) { clear(target); return; }
    const cfg = await SHD.loadConfig();
    clear(target);
    target.appendChild(pageHead("My requests", "Aapki bheji hui delivery requests",
      h("a", { class: "btn btn-ghost btn-sm", href: "#/courses" }, "Courses")));

    const quotaLine = h("div", { class: "notice" }, "…");
    target.appendChild(quotaLine);
    try {
      const quota = await api("/api/tg/quota");
      clear(quotaLine);
      quotaLine.className = "notice";
      quotaLine.appendChild(h("strong", {}, `${quota.remaining} of ${quota.limit} left today`));
      quotaLine.appendChild(h("span", { class: "muted" }, ` · resets ${quota.resetTimeIST} (Indian time)`));
    } catch (error) {
      quotaLine.className = "notice bad";
      quotaLine.textContent = error.message;
    }

    const saved = JSON.parse(localStorage.getItem("shd_requests") || "[]");
    if (!saved.length) {
      target.appendChild(h("div", { class: "empty" }, "Abhi koi request nahi. Course kholiye aur ▶ Open in Telegram dabaiye."));
      return;
    }

    const wrap = h("div", { class: "table-wrap", style: "margin-top:14px" });
    const table = h("table", {},
      h("thead", {}, h("tr", {},
        h("th", {}, "Lecture"), h("th", {}, "Course"), h("th", {}, "Status"), h("th", {}, "Created"), h("th", {}, ""))),
      h("tbody", {}));
    wrap.appendChild(table);
    target.appendChild(wrap);

    for (const item of saved.slice(-40).reverse()) {
      const row = h("tr", {},
        h("td", {}, item.title || "—"),
        h("td", {}, item.course || "—"),
        h("td", {}, h("span", { class: "chip" }, "checking…")),
        h("td", { class: "tiny" }, when(item.createdAt)),
        h("td", {}, item.deepLink
          ? h("a", { class: "btn btn-sm btn-ghost", href: item.deepLink, target: "_blank", rel: "noopener noreferrer" }, "Open bot")
          : null));
      table.querySelector("tbody").appendChild(row);
      try {
        const res = await api(`/api/tg/request/${encodeURIComponent(item.id)}`);
        const chip = row.children[2].firstChild;
        chip.className = "chip " + (res.status === "delivered" ? "ok" : res.status === "failed" ? "bad" : "warn");
        chip.textContent = `${res.status} · used ${res.usedCount}`;
      } catch (error) {
        const chip = row.children[2].firstChild;
        chip.className = "chip bad";
        chip.textContent = error.status === 404 ? "expired" : error.code || "error";
      }
    }
  }

  /* ── boot ───────────────────────────────────────────────────────────────── */
  async function start() {
    await SHD.loadConfig();
    await SHD.loadSession();
    SHD.route = route;
    window.addEventListener("hashchange", () => route(false));

    // request history (sirf is browser me, koi secret nahi)
    const origApi = SHD.api;
    SHD.api = async function (path, options) {
      const res = await origApi(path, options);
      if (path === "/api/tg/request" && options && options.method === "POST" && res && res.requestId) {
        try {
          const list = JSON.parse(localStorage.getItem("shd_requests") || "[]");
          list.push({
            id: res.requestId,
            title: (options.body && options.body.title) || "",
            course: (options.body && options.body.course) || "",
            createdAt: Date.now(),
            deepLink: res.deepLink || "",
          });
          localStorage.setItem("shd_requests", JSON.stringify(list.slice(-80)));
        } catch (_) { /* ignore */ }
      }
      return res;
    };

    await route(true);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
