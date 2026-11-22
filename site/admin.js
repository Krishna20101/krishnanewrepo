/* =============================================================================
   🛠 admin.js — 8 admin tabs
   OVERVIEW · COURSES · EXPLORER · TELEGRAM · BOT · SETTINGS · ACCOUNTS · LOGINS
   ============================================================================= */
(function () {
  "use strict";

  const SHD = window.SHD;
  const { h, clear, api, toast, when, ago } = SHD;

  const TABS = [
    ["OVERVIEW", "Overview"],
    ["COURSES", "Courses"],
    ["EXPLORER", "Explorer"],
    ["TELEGRAM", "Telegram"],
    ["BOT", "Bot"],
    ["SETTINGS", "Settings"],
    ["ACCOUNTS", "Accounts"],
    ["LOGINS", "Logins"],
  ];

  let active = "OVERVIEW";
  let root = null;

  async function render(target) {
    if (!SHD.requireAdmin(() => SHD.route(true))) {
      clear(target);
      target.appendChild(h("div", { class: "notice warn" }, "Admin login zaroori hai."));
      return;
    }
    root = target;
    const hashTab = String(location.hash || "").split("/")[2];
    if (hashTab && TABS.some(([id]) => id === hashTab.toUpperCase())) active = hashTab.toUpperCase();

    clear(target);
    target.appendChild(
      h("div", { class: "page-head" },
        h("div", {}, h("h1", {}, "Admin panel"), h("p", {}, "Courses, Telegram delivery, bot aur accounts — sab yahin se."))));

    const tabs = h("div", { class: "tabs" },
      TABS.map(([id, label]) =>
        h("button", {
          class: "tab" + (id === active ? " is-on" : ""),
          type: "button",
          onclick: () => { active = id; location.hash = `#/admin/${id.toLowerCase()}`; render(root); },
        }, label)));
    target.appendChild(tabs);

    const panel = h("div", {});
    target.appendChild(panel);
    panel.appendChild(h("div", { class: "loader" }, "Loading…"));

    try {
      if (active === "OVERVIEW") await tabOverview(panel);
      else if (active === "COURSES") await tabCourses(panel);
      else if (active === "EXPLORER") await tabExplorer(panel);
      else if (active === "TELEGRAM") await tabTelegram(panel);
      else if (active === "BOT") await tabBot(panel);
      else if (active === "SETTINGS") await tabSettings(panel);
      else if (active === "ACCOUNTS") await tabAccounts(panel);
      else if (active === "LOGINS") await tabLogins(panel);
    } catch (error) {
      clear(panel);
      panel.appendChild(h("div", { class: "notice bad" }, error.message));
    }
  }

  function card(title, ...body) {
    return h("section", { class: "card" },
      title ? h("div", { class: "card-head" }, h("h2", { class: "font-display" }, title)) : null,
      ...body);
  }

  function field(label, input) {
    return h("label", { class: "field" }, h("span", {}, label), input);
  }

  function table(headers, rows) {
    const body = h("tbody", {});
    for (const cells of rows) {
      body.appendChild(h("tr", {}, cells.map((cell) => h("td", {}, cell))));
    }
    return h("div", { class: "table-wrap" },
      h("table", {}, h("thead", {}, h("tr", {}, headers.map((t) => h("th", {}, t)))), body));
  }

  /* ── 1. OVERVIEW ────────────────────────────────────────────────────────── */
  async function tabOverview(panel) {
    const data = await api("/api/admin/overview");
    clear(panel);
    panel.appendChild(
      h("div", { class: "grid stats" },
        stat(data.courses, "courses"),
        stat(data.videos, "videos"),
        stat(data.requests, "requests"),
        stat(data.requestsToday, "requests today"),
        stat(data.students, "students"),
        stat(data.botUsers, "bot users")));

    panel.appendChild(card("System",
      h("dl", { class: "kv" },
        h("dt", {}, "Database"), h("dd", {}, data.backend === "firebase" ? "Firebase Realtime Database" : "local JSON (dev)"),
        h("dt", {}, "Delivery mode"), h("dd", {}, String(data.deliveryMode || "auto")),
        h("dt", {}, "Daily limit"), h("dd", {}, `${data.dailyLimit || 20} videos / Telegram id`),
        h("dt", {}, "Limit reset"), h("dd", {}, `${data.resetTimeIST || "12:00 AM"} (Indian time)`),
        h("dt", {}, "Bot heartbeat"),
        h("dd", {}, data.heartbeat && data.heartbeat.at
          ? `${ago(data.heartbeat.at)} · ${data.heartbeat.bot || "?"} · backend ${data.heartbeat.backend || "?"}`
          : "bot abhi online nahi dikha"))));

    if (data.backend !== "firebase") {
      panel.appendChild(h("div", { class: "notice warn" },
        "Firebase credentials set nahi hain → data local JSON file me ja raha hai (sirf testing ke liye). " +
        "FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY aur FIREBASE_DATABASE_URL set kijiye."));
    }
    if (!(data.heartbeat && data.heartbeat.at) || Date.now() - Number(data.heartbeat.at || 0) > 15 * 60 * 1000) {
      panel.appendChild(h("div", { class: "notice warn" },
        "Bot 15 minute se zyada purana heartbeat bhej raha hai. Render free tier par bot so jata hai — " +
        "external pinger (uptime robot) laga kar /healthz hit karwayiye."));
    }
  }

  function stat(value, label) {
    return h("div", { class: "card stat" }, h("b", {}, String(value ?? 0)), h("span", {}, label));
  }

  /* ── 2. COURSES ─────────────────────────────────────────────────────────── */
  async function tabCourses(panel) {
    const [list] = await Promise.all([api("/api/admin/batches")]);
    clear(panel);

    const name = h("input", { type: "text", placeholder: "Naya course ka naam" });
    const thumb = h("input", { type: "text", placeholder: "Thumbnail URL (optional)" });
    const price = h("input", { type: "text", placeholder: "Price label (optional)" });
    const createBtn = h("button", { class: "btn btn-primary", type: "button" }, "Create course");
    createBtn.addEventListener("click", async () => {
      createBtn.disabled = true;
      try {
        const res = await api("/api/admin/batches", { method: "POST", body: { name: name.value, thumbnail: thumb.value, price: price.value, source: "custom" } });
        toast(`Course ban gaya (${res.id})`, "ok");
        render(root);
      } catch (error) {
        toast(error.message, "bad");
      } finally {
        createBtn.disabled = false;
      }
    });

    panel.appendChild(card("Naya course (DB-only)",
      h("div", { class: "row" }, field("Name", name), field("Thumbnail", thumb), field("Price", price)),
      h("div", { style: "margin-top:10px" }, createBtn),
      h("p", { class: "tiny", style: "margin:10px 0 0" },
        "File-backed courses (data/batches/*.json) kabhi modify nahi hote — unke changes database override me jaate hain.")));

    const rows = (list.batches || []).map((batch) => [
      h("div", {}, h("div", {}, batch.name), h("div", { class: "mono" }, batch.id)),
      String(batch.source || "file"),
      `${batch.videos || 0} 🎬 · ${batch.files || 0} 📄`,
      batch.fileBacked ? h("span", { class: "chip warn" }, "file-backed (read-only)") : h("span", { class: "chip ok" }, "database"),
      batch.updatedAt ? ago(batch.updatedAt) : "—",
      h("div", { style: "display:flex;gap:6px;flex-wrap:wrap" },
        h("button", {
          class: "btn btn-sm", type: "button",
          onclick: () => editCourse(batch),
        }, "Edit"),
        h("a", { class: "btn btn-sm btn-ghost", href: `#/admin/explorer?batch=${encodeURIComponent(batch.id)}` }, "Explorer"),
        h("button", {
          class: "btn btn-sm btn-danger", type: "button",
          onclick: () => removeCourse(batch),
        }, batch.fileBacked ? "Hide" : "Delete"),
      ),
    ]);

    panel.appendChild(card(`Courses (${rows.length})`, rows.length ? table(["Course", "Source", "Items", "Storage", "Updated", ""], rows) : h("div", { class: "empty" }, "Koi course nahi.")));
  }

  async function editCourse(batch) {
    const name = h("input", { type: "text", value: batch.name || "" });
    const thumbnail = h("input", { type: "text", value: batch.thumbnail || "" });
    const price = h("input", { type: "text", value: String(batch.price ?? "") });
    const hidden = h("input", { type: "checkbox" });
    hidden.checked = Boolean(batch.hidden);

    const box = h("div", { class: "card" },
      h("h3", {}, `Edit: ${batch.name}`),
      h("div", { class: "row" }, field("Name", name), field("Thumbnail URL", thumbnail), field("Price", price)),
      h("label", { class: "switch", style: "margin-top:10px" }, hidden, "Website par chhupayiye (hidden)"),
      h("div", { style: "display:flex;gap:8px;margin-top:12px" },
        h("button", {
          class: "btn btn-primary", type: "button",
          onclick: async (event) => {
            event.target.disabled = true;
            try {
              await api(`/api/admin/batches/${encodeURIComponent(batch.id)}`, {
                method: "PUT",
                body: { name: name.value, thumbnail: thumbnail.value, price: price.value, hidden: hidden.checked },
              });
              toast("Course update ho gaya", "ok");
              render(root);
            } catch (error) {
              toast(error.message, "bad");
              event.target.disabled = false;
            }
          },
        }, "Save"),
        h("button", { class: "btn btn-ghost", type: "button", onclick: () => render(root) }, "Cancel")));
    root.appendChild(box);
    box.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function removeCourse(batch) {
    const verb = batch.fileBacked ? "hide" : "delete";
    if (!window.confirm(`${batch.name} ko ${verb} karna hai?`)) return;
    try {
      const res = await api(`/api/admin/batches/${encodeURIComponent(batch.id)}`, { method: "DELETE" });
      toast(res.hidden ? "Course hide ho gaya (file untouched)" : "Course delete ho gaya", "ok");
      render(root);
    } catch (error) {
      toast(error.message, "bad");
    }
  }

  /* ── 3. EXPLORER (Add by URL) ───────────────────────────────────────────── */
  async function tabExplorer(panel) {
    const list = await api("/api/admin/batches");
    clear(panel);

    const wanted = new URLSearchParams(String(location.hash || "").split("?")[1] || "").get("batch") || "";
    const select = h("select", {},
      h("option", { value: "" }, "— course chuniye —"),
      (list.batches || []).map((b) => {
        const option = h("option", { value: b.id }, `${b.name} (${b.videos || 0} videos)`);
        if (b.id === wanted) option.selected = true;
        return option;
      }));
    const body = h("div", {});
    panel.appendChild(card("Course explorer", field("Course", select), body));

    select.addEventListener("change", () => { location.hash = `#/admin/explorer?batch=${encodeURIComponent(select.value)}`; loadExplorer(body, select.value); });
    if (select.value) loadExplorer(body, select.value);
    else body.appendChild(h("div", { class: "empty", style: "margin-top:12px" }, "Course chuniye — tree khulega, har lecture par Telegram post link attach kar sakte hain."));
  }

  async function loadExplorer(body, batchId) {
    clear(body);
    if (!batchId) return;
    body.appendChild(h("div", { class: "loader" }, "Tree load ho raha hai…"));
    let batch;
    try {
      batch = await api(`/api/batches/${encodeURIComponent(batchId)}`);
    } catch (error) {
      // admin ke liye: agar student session nahi hai to admin batches endpoint se tree nahi milta
      clear(body);
      body.appendChild(h("div", { class: "notice bad" }, `${error.message} (Explorer ke liye student login bhi zaroori hai — content API student-guarded hai.)`));
      return;
    }
    clear(body);

    body.appendChild(h("div", { class: "card-head", style: "margin-top:14px" },
      h("h3", {}, batch.name),
      h("div", { class: "spacer" }),
      h("span", { class: "chip" }, `${batch.counts ? batch.counts.videos : 0} videos`)));

    const addForm = addNodeForm(batchId, "");
    body.appendChild(addForm);

    const wrap = h("div", { class: "tree", style: "margin-top:12px" });
    body.appendChild(wrap);
    renderAdminTree(wrap, batch.tree || [], batchId);
  }

  function addNodeForm(batchId, parentNodeId) {
    const url = h("input", { type: "text", placeholder: "https://t.me/channelname/1234" });
    const title = h("input", { type: "text", placeholder: "Lecture ka naam (optional)" });
    const kind = h("select", {},
      h("option", { value: "video" }, "🎬 Video"),
      h("option", { value: "pdf" }, "📄 PDF"));
    const button = h("button", { class: "btn btn-primary btn-sm", type: "button" }, "➕ Add by URL");
    const note = h("div", { class: "tiny", style: "margin-top:6px" }, "");
    button.addEventListener("click", async () => {
      button.disabled = true;
      note.textContent = "…";
      try {
        const res = await api("/api/admin/telegram/attach", {
          method: "POST",
          body: { batchId, parentNodeId: parentNodeId || undefined, url: url.value.trim(), title: title.value.trim(), kind: kind.value },
        });
        note.textContent = `✅ attach ho gaya · ${res.channelKind} source · ${res.deliveryHint}`;
        toast("Telegram link attach ho gaya", "ok");
        url.value = "";
      } catch (error) {
        note.textContent = "❌ " + error.message;
        toast(error.message, "bad");
      } finally {
        button.disabled = false;
      }
    });
    return h("div", { class: "card" },
      h("h3", {}, parentNodeId ? "Is folder me lecture add kijiye" : "Naya lecture add kijiye (top level)"),
      h("div", { class: "row" }, field("Telegram post link", url), field("Title", title), field("Media", kind)),
      h("div", { style: "margin-top:10px" }, button),
      note,
      h("p", { class: "tiny", style: "margin:10px 0 0" },
        "Public channel ka link → bot seedha forward karega. Private channel ya 'forwarding not allowed' → bot download karke fresh upload karega (source kabhi nahi dikhega)."));
  }

  function renderAdminTree(wrap, nodes, batchId) {
    const walk = (list, depth) => {
      for (const node of list || []) {
        const isVideo = String(node.type || "").toUpperCase() === "VIDEO";
        const row = h("div", { class: "node" + (isVideo ? " is-video" : "") },
          h("span", { class: "node-icon" }, isVideo ? "▶" : "🗀"),
          h("span", { class: "node-title" }, node.title || "(untitled)"),
          h("span", { class: "node-side" },
            node.hasTelegram ? h("span", { class: "chip ok" }, "video attached")
              : node.hasTelegramPdf ? h("span", { class: "chip ok" }, "pdf attached")
              : h("span", { class: "chip" }, "no source"),
            node.sizeMb ? h("span", { class: "chip" }, `${node.sizeMb} MB`) : null));

        if (isVideo) {
          const slot = h("div", { hidden: true });
          row.appendChild(h("button", {
            class: "btn btn-sm btn-ghost", type: "button",
            onclick: (event) => {
              event.stopPropagation();
              slot.hidden = !slot.hidden;
              if (!slot.hidden && !slot.dataset.built) {
                slot.dataset.built = "1";
                slot.appendChild(attachForm(batchId, node));
              }
            },
          }, "Attach link"));
          wrap.appendChild(h("div", {}, row, slot));
        } else {
          const kids = h("div", { class: "children", hidden: depth > 0 });
          row.appendChild(h("button", {
            class: "btn btn-sm btn-ghost", type: "button",
            onclick: (event) => { event.stopPropagation(); kids.hidden = !kids.hidden; },
          }, kids.hidden ? "Open" : "Close"));
          const addSlot = h("div", { hidden: true });
          row.appendChild(h("button", {
            class: "btn btn-sm btn-ghost", type: "button",
            onclick: (event) => {
              event.stopPropagation();
              addSlot.hidden = !addSlot.hidden;
              if (!addSlot.hidden && !addSlot.dataset.built) {
                addSlot.dataset.built = "1";
                addSlot.appendChild(h("div", { style: "margin:8px 0 8px 32px" }, addNodeForm(batchId, node.id)));
              }
            },
          }, "+ Add here"));
          walk(node.children, depth + 1);
          wrap.appendChild(h("div", {}, row, addSlot, kids));
          // children ko is wrap me daalna hai
          const container = wrap.lastChild;
          container.appendChild(kids);
          (node.children || []).length; // no-op
        }
      }
    };
    walk(nodes, 0);
  }

  function attachForm(batchId, node) {
    const url = h("input", { type: "text", placeholder: "https://t.me/channelname/1234" });
    const title = h("input", { type: "text", value: node.title || "" });
    const kind = h("select", {},
      h("option", { value: "video" }, "🎬 Video"),
      h("option", { value: "pdf" }, "📄 PDF"));
    if (node.hasTelegramPdf && !node.hasTelegram) kind.value = "pdf";
    const note = h("div", { class: "tiny", style: "margin-top:6px" }, "");
    const button = h("button", { class: "btn btn-primary btn-sm", type: "button" }, "Save link");
    button.addEventListener("click", async () => {
      button.disabled = true;
      note.textContent = "…";
      try {
        const res = await api("/api/admin/telegram/attach", {
          method: "POST",
          body: { batchId, nodeId: node.id, url: url.value.trim(), title: title.value.trim(), kind: kind.value },
        });
        note.textContent = `✅ ${res.channelKind} source · ${res.deliveryHint}`;
        toast("Link attach ho gaya", "ok");
        setTimeout(() => render(root), 700);
      } catch (error) {
        note.textContent = "❌ " + error.message;
        toast(error.message, "bad");
        button.disabled = false;
      }
    });
    return h("div", { class: "card", style: "margin:8px 0 8px 32px" },
      h("h3", {}, node.title),
      h("div", { class: "row" }, field("Telegram post link", url), field("Title", title), field("Media", kind)),
      h("div", { style: "margin-top:10px" }, button),
      note);
  }

  /* ── 4. TELEGRAM (groups · tasks · requests · purge) ────────────────────── */
  async function tabTelegram(panel) {
    const data = await api("/api/admin/bot");
    clear(panel);

    // scan task
    const invite = h("input", { type: "text", placeholder: "https://t.me/+AbCdEfGhIjKl (invite link)" });
    const chatId = h("input", { type: "text", placeholder: "ya channel id: @name / -100xxxxxxxxxx" });
    const batchId = h("input", { type: "text", placeholder: "kis course me daalna hai (batch id, optional)" });
    const scanBtn = h("button", { class: "btn btn-primary", type: "button" }, "Queue scan");
    scanBtn.addEventListener("click", async () => {
      scanBtn.disabled = true;
      try {
        const res = await api("/api/admin/bot/tasks", {
          method: "POST",
          body: { type: "scan_group", invite: invite.value.trim(), chatId: chatId.value.trim(), batchId: batchId.value.trim() },
        });
        toast(res.message || "Task queue ho gaya", "ok");
      } catch (error) {
        toast(error.message, "bad");
      } finally {
        scanBtn.disabled = false;
      }
    });
    panel.appendChild(card("Group / channel scan",
      h("div", { class: "row" }, field("Invite link", invite), field("Channel id", chatId), field("Course id", batchId)),
      h("div", { style: "margin-top:10px" }, scanBtn),
      h("p", { class: "tiny", style: "margin:10px 0 0" },
        "Scan bot karta hai (website GramJS use nahi karti). Bot online hone par task uthayega aur courses me videos/PDF add kar dega.")));

    // groups registry
    panel.appendChild(card(`Registered groups (${(data.groups || []).length})`,
      (data.groups || []).length
        ? table(["Title", "Chat id", "Items", "Last scan"],
          data.groups.map((g) => [g.title || g.key, h("span", { class: "mono" }, g.chatId || "—"), String(g.items || 0), g.lastScanAt ? ago(g.lastScanAt) : "—"]))
        : h("div", { class: "empty" }, "Koi group register nahi hai.")));

    // requests
    panel.appendChild(card(`Delivery requests (${(data.requests || []).length})`,
      (data.requests || []).length
        ? table(["Lecture", "Course", "Student", "Status", "Used", "Created"],
          data.requests.slice(0, 60).map((r) => [
            r.title || "—", r.courseName || "—", h("span", { class: "mono" }, r.uid || "—"),
            h("span", { class: "chip " + (r.status === "delivered" ? "ok" : r.status === "failed" ? "bad" : "warn") }, r.status),
            String(r.usedCount || 0), ago(r.createdAt),
          ]))
        : h("div", { class: "empty" }, "Koi request nahi.")));

    // ── danger zone: purge ────────────────────────────────────────────────
    const opts = {
      stripLinks: true,
      deleteTelegramNodes: false,
      deleteTelegramCourses: false,
      clearGroupRegistry: true,
      clearRequests: true,
      clearEmbeds: true,
      clearBotState: false,
    };
    const labels = {
      stripLinks: "Telegram tokens strip kijiye (links hat jayenge, lectures rahenge)",
      deleteTelegramNodes: "Telegram-sourced lecture nodes delete kijiye",
      deleteTelegramCourses: "Sirf Telegram-sourced (auto-sync) courses delete kijiye",
      clearGroupRegistry: "Group registry clear kijiye",
      clearRequests: "Pending delivery requests clear kijiye",
      clearEmbeds: "Saved embeds/previews clear kijiye",
      clearBotState: "Bot state clear kijiye (users, deletions, stats, tasks — config safe rahega)",
    };
    const boxes = Object.keys(opts).map((key) => {
      const input = h("input", { type: "checkbox" });
      input.checked = opts[key];
      input.addEventListener("change", () => { opts[key] = input.checked; });
      return h("label", { class: "switch" }, input, labels[key]);
    });
    const confirmInput = h("input", { type: "text", placeholder: 'PURGE likhiye' });
    const previewBox = h("div", {});
    const runNote = h("div", { class: "tiny", style: "margin-top:8px" }, "");

    const previewBtn = h("button", { class: "btn", type: "button" }, "Preview");
    previewBtn.addEventListener("click", async () => {
      previewBtn.disabled = true;
      try {
        const query = new URLSearchParams(Object.entries(opts).map(([k, v]) => [k, v ? "1" : ""])).toString();
        const res = await api(`/api/admin/purge/preview?${query}`);
        clear(previewBox);
        previewBox.appendChild(table(["Course", "Storage", "Telegram nodes", "Action"],
          (res.plan.courses || []).map((c) => [
            c.name, c.fileBacked ? "file-backed (protected)" : "database", String(c.telegramNodes || 0),
            c.fileBacked ? "override strip only" : opts.deleteTelegramCourses && c.telegramCourse ? "course delete" : opts.deleteTelegramNodes ? "nodes delete" : "links strip",
          ])));
        previewBox.appendChild(h("div", { class: "notice", style: "margin-top:10px" },
          `courses deleted: ${res.plan.coursesDeleted} · nodes stripped: ${res.plan.nodesStripped} · nodes deleted: ${res.plan.nodesDeleted} · ` +
          `requests cleared: ${res.plan.requestsCleared} · groups cleared: ${res.plan.groupsCleared}`));
        if ((res.plan.protectedCourses || []).length) {
          previewBox.appendChild(h("div", { class: "notice ok", style: "margin-top:8px" },
            `Protected (file-backed): ${res.plan.protectedCourses.join(", ")}`));
        }
      } catch (error) {
        toast(error.message, "bad");
      } finally {
        previewBtn.disabled = false;
      }
    });

    const runBtn = h("button", { class: "btn btn-danger", type: "button" }, "Run purge");
    runBtn.addEventListener("click", async () => {
      if (String(confirmInput.value || "").trim().toUpperCase() !== "PURGE") {
        runNote.textContent = '❌ Confirm box me "PURGE" likhiye.';
        return;
      }
      if (!window.confirm("Purge chalayein? Yeh Telegram-sourced additions hata dega.")) return;
      runBtn.disabled = true;
      runNote.textContent = "chal raha hai…";
      try {
        const res = await api("/api/admin/purge", { method: "POST", body: Object.assign({ confirm: "PURGE" }, opts) });
        runNote.textContent = `✅ done · errors: ${(res.errors || []).length}`;
        toast("Purge complete", "ok");
        render(root);
      } catch (error) {
        runNote.textContent = "❌ " + error.message;
        toast(error.message, "bad");
        runBtn.disabled = false;
      }
    });

    panel.appendChild(h("section", { class: "card danger" },
      h("div", { class: "card-head" }, h("h2", {}, "⚠️ Danger zone — Telegram purge")),
      h("p", { class: "muted", style: "margin:0 0 10px" },
        "File-backed courses (data/batches/*.json) aur YouTube links KABHI delete nahi hote. Bot config, student accounts aur site settings bhi safe hain."),
      h("div", { class: "opts" }, boxes),
      previewBox,
      h("div", { class: "row", style: "margin-top:12px" }, field('Confirm ("PURGE")', confirmInput)),
      h("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-top:10px" }, previewBtn, runBtn),
      runNote));
  }

  /* ── 5. BOT ─────────────────────────────────────────────────────────────── */
  async function tabBot(panel) {
    const data = await api("/api/admin/bot");
    const cfg = data.config || {};
    clear(panel);

    const inputs = {
      dailyLimit: h("input", { type: "number", min: "0", max: "1000", value: String(cfg.dailyLimit ?? 20) }),
      autoDeleteHours: h("input", { type: "number", min: "0", step: "0.5", value: String(cfg.autoDeleteHours ?? 2) }),
      dailyResetHourIST: h("input", { type: "number", min: "0", max: "23", value: String(cfg.dailyResetHourIST ?? 0) }),
      maxUploadMb: h("input", { type: "number", min: "0", value: String(cfg.maxUploadMb ?? 2000) }),
      globalDailyLimit: h("input", { type: "number", min: "0", value: String(cfg.globalDailyLimit ?? 500) }),
      requestReuseLimit: h("input", { type: "number", min: "1", value: String(cfg.requestReuseLimit ?? 1) }),
      maxPendingPerUser: h("input", { type: "number", min: "0", value: String(cfg.maxPendingPerUser ?? 3) }),
      requestCooldownMin: h("input", { type: "number", min: "0", value: String(cfg.requestCooldownMin ?? 5) }),
      requestTtlHours: h("input", { type: "number", min: "1", value: String(cfg.requestTtlHours ?? 168) }),
      creditUsername: h("input", { type: "text", value: String(cfg.creditUsername ?? "krishna84") }),
      contactUsername: h("input", { type: "text", value: String(cfg.contactUsername ?? "krishna84") }),
      joinGateChannel: h("input", { type: "text", value: String(cfg.joinGateChannel ?? ""), placeholder: "@channelname ya -100xxxx" }),
      joinGateInviteUrl: h("input", { type: "text", value: String(cfg.joinGateInviteUrl ?? ""), placeholder: "https://t.me/xxxx" }),
    };
    const deliveryMode = h("select", {},
      ["auto", "clean", "forward"].map((mode) => {
        const option = h("option", { value: mode },
          mode === "auto" ? "auto — public → forward, private → download+upload" : mode === "clean" ? "clean — hamesha download + fresh upload" : "forward — hamesha direct forward");
        if (String(cfg.deliveryMode || "auto") === mode) option.selected = true;
        return option;
      }));
    const joinGateEnabled = h("input", { type: "checkbox" });
    joinGateEnabled.checked = Boolean(cfg.joinGateEnabled);
    const paused = h("input", { type: "checkbox" });
    paused.checked = Boolean(cfg.paused);

    const save = h("button", { class: "btn btn-primary", type: "button" }, "Save bot config");
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        const body = {};
        for (const [key, input] of Object.entries(inputs)) body[key] = input.value;
        body.deliveryMode = deliveryMode.value;
        body.joinGateEnabled = joinGateEnabled.checked;
        body.paused = paused.checked;
        await api("/api/admin/bot/config", { method: "PUT", body });
        toast("Bot config save ho gaya", "ok");
        render(root);
      } catch (error) {
        toast(error.message, "bad");
      } finally {
        save.disabled = false;
      }
    });

    panel.appendChild(card("Delivery + limits",
      h("div", { class: "row" },
        field("Daily limit (per Telegram id)", inputs.dailyLimit),
        field("Limit reset hour (IST, 0 = raat 12 baje)", inputs.dailyResetHourIST),
        field("Auto-delete (hours)", inputs.autoDeleteHours),
        field("Max upload (MB)", inputs.maxUploadMb)),
      h("div", { class: "row", style: "margin-top:10px" },
        field("Delivery mode", deliveryMode),
        field("Global daily limit (site)", inputs.globalDailyLimit),
        field("Request reuse limit", inputs.requestReuseLimit)),
      h("div", { class: "row", style: "margin-top:10px" },
        field("Max pending per user", inputs.maxPendingPerUser),
        field("Request cooldown (min)", inputs.requestCooldownMin),
        field("Request TTL (hours)", inputs.requestTtlHours)),
      h("div", { class: "row", style: "margin-top:10px" },
        field("Credit username", inputs.creditUsername),
        field("Contact username", inputs.contactUsername)),
      h("label", { class: "switch", style: "margin-top:12px" }, paused, "Delivery PAUSE kijiye (bot online rahega, video nahi bhejega)"),
      h("div", { style: "margin-top:14px" }, save)));

    panel.appendChild(card("🔒 Channel join-gate",
      h("label", { class: "switch" }, joinGateEnabled, "Join gate ON (video se pehle channel join zaroori)"),
      h("div", { class: "row", style: "margin-top:10px" },
        field("Channel (@name ya -100…)", inputs.joinGateChannel),
        field("Invite link", inputs.joinGateInviteUrl)),
      h("p", { class: "tiny", style: "margin:10px 0 0" },
        "Bot ko channel me ADMIN hona chahiye. Check fail hone par gate fail-open hota hai (video ruk-ta nahi).")));

    panel.appendChild(card("Live state",
      h("dl", { class: "kv" },
        h("dt", {}, "Bot"), h("dd", {}, cfg.botUsername ? `@${cfg.botUsername}` : "unknown"),
        h("dt", {}, "Heartbeat"),
        h("dd", {}, data.heartbeat && data.heartbeat.at ? `${ago(data.heartbeat.at)} · user ${data.heartbeat.user || "?"}` : "no heartbeat"),
        h("dt", {}, "Videos sent"), h("dd", {}, String((data.stats && data.stats.totalVideosSent) || 0)),
        h("dt", {}, "Pending deletes"), h("dd", {}, String((data.stats && data.stats.pendingDeletions) || 0)),
        h("dt", {}, "Backend"), h("dd", {}, String((data.stats && data.stats.backend) || "—")))));

    panel.appendChild(card(`Bot users (${(data.users || []).length})`,
      (data.users || []).length
        ? table(["Telegram id", "Username", "Videos", "Banned", "Last seen"],
          data.users.map((u) => [h("span", { class: "mono" }, u.id), u.username || "—", String(u.totalVideos || 0),
            u.banned ? h("span", { class: "chip bad" }, "banned") : h("span", { class: "chip ok" }, "active"),
            u.lastSeen ? ago(u.lastSeen) : "—"]))
        : h("div", { class: "empty" }, "Abhi koi user nahi.")));
  }

  /* ── 6. SETTINGS ────────────────────────────────────────────────────────── */
  async function tabSettings(panel) {
    const data = await api("/api/admin/settings");
    const s = data.settings || {};
    clear(panel);

    const inputs = {
      appName: h("input", { type: "text", value: s.appName || "" }),
      tagline: h("input", { type: "text", value: s.tagline || "" }),
      telegramUrl: h("input", { type: "text", value: s.telegramUrl || "" }),
      telegramBotUsername: h("input", { type: "text", value: s.telegramBotUsername || "" }),
      creditUsername: h("input", { type: "text", value: s.creditUsername || "" }),
      contactUsername: h("input", { type: "text", value: s.contactUsername || "" }),
      dailyVideoLimit: h("input", { type: "number", min: "0", value: String(s.dailyVideoLimit ?? 20) }),
      autoDeleteHours: h("input", { type: "number", min: "0", step: "0.5", value: String(s.autoDeleteHours ?? 2) }),
      dailyResetHourIST: h("input", { type: "number", min: "0", max: "23", value: String(s.dailyResetHourIST ?? 0) }),
      maintenanceMessage: h("input", { type: "text", value: s.maintenanceMessage || "" }),
    };
    const flags = {
      loginRequired: h("input", { type: "checkbox" }),
      maintenanceMode: h("input", { type: "checkbox" }),
    };
    flags.loginRequired.checked = Boolean(s.loginRequired);
    flags.maintenanceMode.checked = Boolean(s.maintenanceMode);

    const save = h("button", { class: "btn btn-primary", type: "button" }, "Save settings");
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        const body = {};
        for (const [key, input] of Object.entries(inputs)) body[key] = input.value;
        for (const [key, input] of Object.entries(flags)) body[key] = input.checked;
        await api("/api/admin/settings", { method: "PUT", body });
        toast("Settings save ho gayi", "ok");
        state.config = null;
        await SHD.loadConfig();
        render(root);
      } catch (error) {
        toast(error.message, "bad");
      } finally {
        save.disabled = false;
      }
    });

    panel.appendChild(card("Website",
      h("div", { class: "row" }, field("App name", inputs.appName), field("Tagline", inputs.tagline)),
      h("div", { class: "row", style: "margin-top:10px" }, field("Telegram channel URL", inputs.telegramUrl), field("Bot username (deep link)", inputs.telegramBotUsername)),
      h("div", { class: "row", style: "margin-top:10px" }, field("Credit username", inputs.creditUsername), field("Contact username", inputs.contactUsername)),
      h("label", { class: "switch", style: "margin-top:12px" }, flags.loginRequired, "Content ke liye login zaroori")));

    panel.appendChild(card("Limits (website display)",
      h("div", { class: "row" },
        field("Daily video limit", inputs.dailyVideoLimit),
        field("Auto-delete hours", inputs.autoDeleteHours),
        field("Reset hour (IST, 0 = midnight)", inputs.dailyResetHourIST)),
      h("p", { class: "tiny", style: "margin:10px 0 0" },
        "Website sirf ek chhoti line dikhata hai (jaise “18 of 20 left today · resets 12:00 AM”). Poori limit messaging Telegram bot me English me hai.")));

    panel.appendChild(card("Maintenance",
      h("label", { class: "switch" }, flags.maintenanceMode, "Maintenance mode ON"),
      h("div", { class: "row", style: "margin-top:10px" }, field("Message", inputs.maintenanceMessage)),
      h("div", { style: "margin-top:14px" }, save)));
  }

  /* ── 7. ACCOUNTS ────────────────────────────────────────────────────────── */
  async function tabAccounts(panel) {
    const data = await api("/api/admin/accounts");
    clear(panel);

    const uid = h("input", { type: "text", placeholder: "login id / email / mobile" });
    const name = h("input", { type: "text", placeholder: "naam" });
    const password = h("input", { type: "text", placeholder: "password (min 4)" });
    const button = h("button", { class: "btn btn-primary", type: "button" }, "Create student");
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await api("/api/admin/accounts", { method: "POST", body: { uid: uid.value.trim(), name: name.value.trim(), password: password.value } });
        toast("Student account ban gaya", "ok");
        render(root);
      } catch (error) {
        toast(error.message, "bad");
        button.disabled = false;
      }
    });

    panel.appendChild(card("Naya student",
      h("div", { class: "row" }, field("Login id", uid), field("Name", name), field("Password", password)),
      h("div", { style: "margin-top:10px" }, button)));

    const rows = (data.accounts || []).map((account) => [
      h("div", {}, h("div", {}, account.name || account.uid), h("div", { class: "mono" }, account.uid)),
      account.email || account.phone || "—",
      account.disabled ? h("span", { class: "chip bad" }, "disabled") : h("span", { class: "chip ok" }, "active"),
      account.lastLoginAt ? ago(account.lastLoginAt) : "never",
      h("div", { style: "display:flex;gap:6px;flex-wrap:wrap" },
        h("button", {
          class: "btn btn-sm", type: "button",
          onclick: () => resetPassword(account),
        }, "Reset password"),
        h("button", {
          class: "btn btn-sm", type: "button",
          onclick: async () => {
            try {
              await api(`/api/admin/accounts/${encodeURIComponent(account.uid)}`, { method: "PUT", body: { disabled: !account.disabled } });
              toast(account.disabled ? "Account enable ho gaya" : "Account disable ho gaya", "ok");
              render(root);
            } catch (error) { toast(error.message, "bad"); }
          },
        }, account.disabled ? "Enable" : "Disable"),
        h("button", {
          class: "btn btn-sm btn-danger", type: "button",
          onclick: async () => {
            if (!window.confirm(`${account.uid} ko delete karna hai?`)) return;
            try {
              await api(`/api/admin/accounts/${encodeURIComponent(account.uid)}`, { method: "DELETE" });
              toast("Account delete ho gaya", "ok");
              render(root);
            } catch (error) { toast(error.message, "bad"); }
          },
        }, "Delete")),
    ]);

    panel.appendChild(card(`Students (${rows.length})`,
      rows.length ? table(["Login id", "Contact", "State", "Last login", ""], rows) : h("div", { class: "empty" }, "Koi account nahi.")));
  }

  async function resetPassword(account) {
    const password = window.prompt(`"${account.uid}" ka naya password (min 4 chars):`);
    if (!password) return;
    try {
      await api(`/api/admin/accounts/${encodeURIComponent(account.uid)}`, { method: "PUT", body: { password } });
      toast("Password reset ho gaya", "ok");
    } catch (error) {
      toast(error.message, "bad");
    }
  }

  /* ── 8. LOGINS / logs ───────────────────────────────────────────────────── */
  async function tabLogins(panel) {
    const kinds = ["", "login_ok", "login_failed", "admin_login_ok", "admin_login_failed", "tg_request", "telegram_attach", "settings_update", "bot_config", "telegram_purge", "account_create"];
    clear(panel);
    const select = h("select", {}, kinds.map((k) => h("option", { value: k }, k || "sabhi events")));
    const body = h("div", { style: "margin-top:12px" }, h("div", { class: "loader" }, "Loading…"));
    panel.appendChild(card("Activity / login logs", field("Filter", select), body));

    const load = async () => {
      clear(body);
      body.appendChild(h("div", { class: "loader" }, "Loading…"));
      try {
        const res = await api(`/api/admin/logs?kind=${encodeURIComponent(select.value)}&limit=300`);
        clear(body);
        if (!(res.logs || []).length) {
          body.appendChild(h("div", { class: "empty" }, "Koi log nahi."));
          return;
        }
        body.appendChild(table(["Time", "Event", "Details"],
          res.logs.map((log) => [
            when(log.at),
            h("span", { class: "chip " + (/failed|error/.test(log.kind) ? "bad" : log.kind.includes("purge") ? "warn" : "") }, log.kind),
            h("span", { class: "mono" }, JSON.stringify(log.data || {}).slice(0, 220)),
          ])));
      } catch (error) {
        clear(body);
        body.appendChild(h("div", { class: "notice bad" }, error.message));
      }
    };
    select.addEventListener("change", load);
    await load();
  }

  window.SHDAdmin = { render };
})();
