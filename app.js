// Wedding Seating Planner
// Phase 1: auth + create/list weddings.  Phase 2: guest management + CSV import/export.
// Plain browser JS, no build step. Supabase loaded via CDN in index.html.

(function () {
  "use strict";

  const cfg = window.SUPABASE_CONFIG || {};
  const configured =
    cfg.url &&
    cfg.anonKey &&
    !cfg.url.includes("PASTE_") &&
    !cfg.anonKey.includes("PASTE_");

  const $ = (id) => document.getElementById(id);
  const views = {
    loading: $("loadingView"),
    login: $("loginView"),
    dashboard: $("dashboardView"),
    wedding: $("weddingView"),
  };
  const userArea = $("userArea");
  const userEmail = $("userEmail");

  // app state
  let currentWedding = null; // { id, name, ... }
  let guestCache = []; // guests for the open wedding
  let myUserId = null; // current signed-in user id

  function showView(name) {
    Object.entries(views).forEach(([k, el]) => (el.hidden = k !== name));
  }

  if (!configured) {
    showView("login");
    const msg = $("loginMsg");
    msg.hidden = false;
    msg.classList.add("error");
    msg.textContent =
      "Supabase isn't configured yet. Paste your project URL and anon key into config.js.";
    $("loginForm").querySelector("button").disabled = true;
    return;
  }

  const db = window.supabase.createClient(cfg.url, cfg.anonKey);

  // --- styled confirm dialog (replaces window.confirm) ---
  let confirmResolve = null;
  function uiConfirm(message, opts) {
    opts = opts || {};
    $("confirmMsg").textContent = message;
    const yes = $("confirmYes");
    yes.textContent = opts.okText || "OK";
    yes.classList.toggle("danger", !!opts.danger);
    $("confirmDialog").showModal();
    return new Promise((resolve) => { confirmResolve = resolve; });
  }
  function resolveConfirm(val) {
    const r = confirmResolve;
    confirmResolve = null;
    $("confirmDialog").close();
    if (r) r(val);
  }
  $("confirmYes").addEventListener("click", () => resolveConfirm(true));
  $("confirmNo").addEventListener("click", () => resolveConfirm(false));
  $("confirmDialog").addEventListener("close", () => resolveConfirm(false));

  // ============================================================
  // AUTH
  // ============================================================
  async function init() {
    const { data } = await db.auth.getSession();
    render(data.session);
    db.auth.onAuthStateChange((_event, session) => render(session));
  }

  function render(session) {
    if (session && session.user) {
      myUserId = session.user.id;
      userArea.hidden = false;
      userEmail.textContent = session.user.email;
      if (!currentWedding) {
        claimAndLoadDashboard();
      }
    } else {
      myUserId = null;
      userArea.hidden = true;
      currentWedding = null;
      showView("login");
    }
  }

  async function claimAndLoadDashboard() {
    // attach any pending invites addressed to this user's email, then show weddings
    try { await db.rpc("claim_invites"); } catch (e) { /* ignore if not set up yet */ }
    showView("dashboard");
    loadWeddings();
  }

  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("emailInput").value.trim();
    const msg = $("loginMsg");
    msg.hidden = false;
    msg.classList.remove("error");
    msg.textContent = "Sending…";
    const { error } = await db.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.href.split("#")[0] },
    });
    if (error) {
      msg.classList.add("error");
      msg.textContent = "Couldn't send link: " + error.message;
    } else {
      msg.textContent =
        "✉️ Check your inbox for " + email + " and click the link to sign in.";
    }
  });

  $("signOutBtn").addEventListener("click", () => db.auth.signOut());

  // ============================================================
  // WEDDINGS (dashboard)
  // ============================================================
  async function loadWeddings() {
    const list = $("weddingList");
    const empty = $("emptyState");
    list.innerHTML = "";

    const { data, error } = await db
      .from("weddings")
      .select("id, name, event_date, owner_id")
      .order("created_at", { ascending: false });

    if (error) {
      empty.hidden = false;
      empty.textContent = "Couldn't load weddings: " + error.message;
      return;
    }

    const { data: me } = await db.auth.getUser();
    const myId = me.user ? me.user.id : null;

    if (!data || data.length === 0) {
      empty.hidden = false;
      empty.textContent = "No weddings yet. Create your first one to get started.";
      return;
    }
    empty.hidden = true;

    data.forEach((w) => {
      const item = document.createElement("div");
      item.className = "wedding-item";
      const dateStr = w.event_date
        ? new Date(w.event_date + "T00:00:00").toLocaleDateString(undefined, {
            year: "numeric",
            month: "long",
            day: "numeric",
          })
        : "No date set";
      const role = w.owner_id === myId ? "Owner" : "Editor";
      item.innerHTML =
        '<div><div class="w-name"></div><div class="w-meta"></div></div>' +
        '<span class="badge"></span>';
      item.querySelector(".w-name").textContent = w.name;
      item.querySelector(".w-meta").textContent = dateStr;
      item.querySelector(".badge").textContent = role;
      item.addEventListener("click", () => openWedding(w));
      list.appendChild(item);
    });
  }

  const dialog = $("weddingDialog");
  $("newWeddingBtn").addEventListener("click", () => {
    $("weddingName").value = "";
    $("weddingDate").value = "";
    dialog.showModal();
  });
  $("cancelWedding").addEventListener("click", () => dialog.close());

  $("weddingForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("weddingName").value.trim();
    const date = $("weddingDate").value || null;
    if (!name) return;
    const { data: me } = await db.auth.getUser();
    const { error } = await db
      .from("weddings")
      .insert({ name, event_date: date, owner_id: me.user.id });
    dialog.close();
    if (error) return alert("Couldn't create wedding: " + error.message);
    loadWeddings();
  });

  // ============================================================
  // WEDDING VIEW + GUESTS
  // ============================================================
  function openWedding(w) {
    currentWedding = w;
    $("wvTitle").textContent = w.name;
    $("shareBtn").hidden = w.owner_id !== myUserId; // only the owner can invite
    showView("wedding");
    showTab("guests");
    loadGuests();
    loadConstraints();
  }

  async function loadConstraints() {
    const { data, error } = await db
      .from("constraints")
      .select("*")
      .eq("wedding_id", currentWedding.id);
    if (!error) constraintsCache = data || [];
  }

  $("backBtn").addEventListener("click", () => {
    currentWedding = null;
    showView("dashboard");
    loadWeddings();
  });

  // ============================================================
  // SHARING / COLLABORATORS
  // ============================================================
  const shareDialog = $("shareDialog");
  $("shareBtn").addEventListener("click", () => {
    $("inviteEmail").value = "";
    $("inviteMsg").hidden = true;
    loadCollaborators();
    shareDialog.showModal();
  });
  $("closeShare").addEventListener("click", () => shareDialog.close());

  async function loadCollaborators() {
    const list = $("collabList");
    list.innerHTML = "<p class='muted'>Loading…</p>";
    const { data, error } = await db
      .from("collaborators")
      .select("*")
      .eq("wedding_id", currentWedding.id)
      .order("created_at");
    if (error) { list.innerHTML = "<p class='muted'>Couldn't load: " + error.message + "</p>"; return; }
    if (!data || data.length === 0) {
      list.innerHTML = "<p class='muted'>No one invited yet.</p>";
      return;
    }
    list.innerHTML = "";
    data.forEach((c) => {
      const row = document.createElement("div");
      row.className = "collab-item";
      const status = c.user_id ? "Active" : "Pending";
      row.innerHTML =
        "<div><div class='collab-email'></div><div class='collab-status'></div></div>" +
        "<button class='link-btn' type='button'>Remove</button>";
      row.querySelector(".collab-email").textContent = c.invited_email || "(linked account)";
      row.querySelector(".collab-status").textContent = status;
      row.querySelector("button").addEventListener("click", () => removeCollaborator(c.id));
      list.appendChild(row);
    });
  }

  $("inviteForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("inviteEmail").value.trim().toLowerCase();
    const msg = $("inviteMsg");
    if (!email) return;
    msg.hidden = false;
    msg.classList.remove("error");
    msg.textContent = "Inviting…";
    const { error } = await db.from("collaborators").insert({
      wedding_id: currentWedding.id,
      invited_email: email,
      role: "editor",
    });
    if (error) {
      msg.classList.add("error");
      msg.textContent = "Couldn't invite: " + error.message;
      return;
    }
    msg.textContent = "✓ Invited " + email + ". They'll see this wedding after they sign in.";
    $("inviteEmail").value = "";
    loadCollaborators();
  });

  async function removeCollaborator(id) {
    if (!(await uiConfirm("Remove this person's access to the wedding?", { okText: "Remove" }))) return;
    const { error } = await db.from("collaborators").delete().eq("id", id);
    if (error) return alert("Couldn't remove: " + error.message);
    loadCollaborators();
  }

  const RSVP_LABELS = { yes: "Attending", no: "Declined", maybe: "Maybe", pending: "Pending" };

  async function loadGuests() {
    const tbody = $("guestRows");
    const empty = $("guestEmpty");
    tbody.innerHTML = "";

    const { data, error } = await db
      .from("guests")
      .select("*")
      .eq("wedding_id", currentWedding.id)
      .order("name", { ascending: true });

    if (error) {
      empty.hidden = false;
      empty.textContent = "Couldn't load guests: " + error.message;
      return;
    }

    guestCache = data || [];
    renderStats();
    refreshGroupSuggestions();

    renderGuestRows();
  }

  function renderGuestRows() {
    const tbody = $("guestRows");
    const empty = $("guestEmpty");
    tbody.innerHTML = "";

    if (guestCache.length === 0) {
      empty.hidden = false;
      empty.textContent = "No guests yet. Add them one by one, or import a CSV.";
      $("tableWrap").hidden = true;
      return;
    }

    const q = ($("guestTableSearch").value || "").trim().toLowerCase();
    const rows = q
      ? guestCache.filter((g) =>
          (g.name + " " + (g.guest_group || "") + " " + (g.side || "") + " " + (g.dietary || ""))
            .toLowerCase().includes(q))
      : guestCache;

    if (rows.length === 0) {
      empty.hidden = false;
      empty.textContent = "No guests match “" + $("guestTableSearch").value + "”.";
      $("tableWrap").hidden = true;
      return;
    }
    empty.hidden = true;
    $("tableWrap").hidden = false;

    rows.forEach((g) => {
      const tr = document.createElement("tr");
      const rsvp = g.rsvp_status || "pending";
      tr.innerHTML =
        "<td class='c-name'></td>" +
        "<td class='c-side'></td>" +
        "<td class='c-group'></td>" +
        "<td><span class='pill'></span></td>" +
        "<td class='c-diet'></td>" +
        "<td class='c-plus'></td>" +
        "<td class='row-actions'><button class='link-btn'>Edit</button></td>";
      tr.querySelector(".c-name").textContent = g.name;
      if (g.is_child) {
        const tag = document.createElement("span");
        tag.className = "kid-tag";
        tag.textContent = "kid";
        tr.querySelector(".c-name").appendChild(tag);
      }
      tr.querySelector(".c-side").textContent = g.side || "—";
      tr.querySelector(".c-group").textContent = g.guest_group || "—";
      const pill = tr.querySelector(".pill");
      pill.classList.add(rsvp);
      pill.textContent = RSVP_LABELS[rsvp] || rsvp;
      tr.querySelector(".c-diet").textContent = g.dietary || "";
      tr.querySelector(".c-plus").textContent = g.plus_one ? "＋1" : "";
      tr.addEventListener("click", () => openGuestDialog(g));
      tbody.appendChild(tr);
    });
  }

  function renderStats() {
    const total = guestCache.length;
    const counts = { yes: 0, no: 0, maybe: 0, pending: 0 };
    let heads = 0, kids = 0;
    guestCache.forEach((g) => {
      const s = g.rsvp_status || "pending";
      counts[s] = (counts[s] || 0) + 1;
      if (g.is_child) kids++;
      if (s === "yes") heads += 1 + (g.plus_one ? 1 : 0);
    });
    $("guestStats").innerHTML =
      "<strong>" + total + "</strong> guests · " +
      "<strong>" + counts.yes + "</strong> attending · " +
      counts.pending + " pending · " +
      counts.no + " declined · " +
      kids + " kids · " +
      "<strong>" + heads + "</strong> seats needed";
  }

  function fillDatalist(id, values) {
    const dl = $(id);
    dl.innerHTML = "";
    values.forEach((v) => {
      const opt = document.createElement("option");
      opt.value = v;
      dl.appendChild(opt);
    });
  }
  function refreshGroupSuggestions() {
    fillDatalist("groupList", [...new Set(guestCache.map((g) => g.guest_group).filter(Boolean))]);
    fillDatalist("sideList", [...new Set(guestCache.map((g) => g.side).filter(Boolean))]);
  }

  // --- add / edit guest dialog ---
  const guestDialog = $("guestDialog");

  function openGuestDialog(g) {
    const editing = !!g;
    $("guestDialogTitle").textContent = editing ? "Edit guest" : "Add guest";
    $("guestId").value = editing ? g.id : "";
    $("gName").value = editing ? g.name : "";
    $("gSide").value = editing ? g.side || "" : "";
    $("gGroup").value = editing ? g.guest_group || "" : "";
    $("gRsvp").value = editing ? g.rsvp_status || "pending" : "pending";
    $("gDietary").value = editing ? g.dietary || "" : "";
    $("gPlusOne").checked = editing ? !!g.plus_one : false;
    $("gChild").checked = editing ? !!g.is_child : false;
    $("gNotes").value = editing ? g.notes || "" : "";
    $("deleteGuestBtn").hidden = !editing;
    $("guestLinks").hidden = !editing;
    if (editing) renderGuestLinks(g.id);
    guestDialog.showModal();
  }

  function partnerName(id) {
    const g = guestById(id);
    return g ? g.name : "(unknown)";
  }

  function renderGuestLinks(guestId) {
    // populate the "add" picker with every other guest
    const sel = $("linkGuest");
    sel.innerHTML = "";
    guestCache
      .filter((g) => g.id !== guestId)
      .forEach((g) => {
        const o = document.createElement("option");
        o.value = g.id;
        o.textContent = g.name + (g.guest_group ? " (" + g.guest_group + ")" : "");
        sel.appendChild(o);
      });

    const mine = constraintsCache.filter((c) => c.guest_a === guestId || c.guest_b === guestId);
    const other = (c) => (c.guest_a === guestId ? c.guest_b : c.guest_a);

    const fill = (el, kind) => {
      el.innerHTML = "";
      const items = mine.filter((c) => c.kind === kind);
      if (items.length === 0) {
        const e = document.createElement("span");
        e.className = "empty";
        e.textContent = "—";
        el.appendChild(e);
        return;
      }
      items.forEach((c) => {
        const chip = document.createElement("span");
        chip.className = "link-chip" + (kind === "apart" ? " apart" : "");
        const label = document.createElement("span");
        label.textContent = partnerName(other(c));
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = "×";
        btn.title = "Remove";
        btn.addEventListener("click", () => removeLink(c.id, guestId));
        chip.appendChild(label);
        chip.appendChild(btn);
        el.appendChild(chip);
      });
    };
    fill($("togetherList"), "together");
    fill($("apartList"), "apart");
  }

  async function addLink(kind) {
    const guestId = $("guestId").value;
    const otherId = $("linkGuest").value;
    if (!guestId || !otherId || guestId === otherId) return;
    // avoid duplicates (either direction, same kind)
    const dup = constraintsCache.some(
      (c) => c.kind === kind &&
        ((c.guest_a === guestId && c.guest_b === otherId) ||
         (c.guest_a === otherId && c.guest_b === guestId))
    );
    if (dup) return;
    const { error } = await db.from("constraints").insert({
      wedding_id: currentWedding.id, guest_a: guestId, guest_b: otherId, kind,
    });
    if (error) return alert("Couldn't add link: " + error.message);
    await loadConstraints();
    renderGuestLinks(guestId);
    if (!$("floorPanel").hidden) loadFloor();
  }
  async function removeLink(id, guestId) {
    const { error } = await db.from("constraints").delete().eq("id", id);
    if (error) return alert("Couldn't remove link: " + error.message);
    await loadConstraints();
    renderGuestLinks(guestId);
    if (!$("floorPanel").hidden) loadFloor();
  }
  $("addTogether").addEventListener("click", () => addLink("together"));
  $("addApart").addEventListener("click", () => addLink("apart"));

  $("addGuestBtn").addEventListener("click", () => openGuestDialog(null));
  $("guestTableSearch").addEventListener("input", renderGuestRows);
  $("cancelGuest").addEventListener("click", () => guestDialog.close());

  $("guestForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("guestId").value;
    const payload = {
      wedding_id: currentWedding.id,
      name: $("gName").value.trim(),
      side: $("gSide").value.trim() || null,
      guest_group: $("gGroup").value.trim() || null,
      rsvp_status: $("gRsvp").value,
      dietary: $("gDietary").value.trim() || null,
      plus_one: $("gPlusOne").checked,
      is_child: $("gChild").checked,
      notes: $("gNotes").value.trim() || null,
    };
    if (!payload.name) return;

    let error;
    if (id) {
      ({ error } = await db.from("guests").update(payload).eq("id", id));
    } else {
      ({ error } = await db.from("guests").insert(payload));
    }
    guestDialog.close();
    if (error) return alert("Couldn't save guest: " + error.message);
    loadGuests();
    if (!$("floorPanel").hidden) loadFloor();
  });

  $("deleteGuestBtn").addEventListener("click", async () => {
    const id = $("guestId").value;
    if (!id) return;
    if (!(await uiConfirm("Delete this guest? This can't be undone.", { okText: "Delete" }))) return;
    const { error } = await db.from("guests").delete().eq("id", id);
    guestDialog.close();
    if (error) return alert("Couldn't delete guest: " + error.message);
    loadGuests();
    if (!$("floorPanel").hidden) loadFloor();
  });

  // ============================================================
  // CSV IMPORT
  // ============================================================
  // Aliases are matched case-insensitively: first by exact match, then by substring.
  const FIELD_ALIASES = {
    name: ["name", "full name", "fullname", "guest name", "guest", "nom complet"],
    first_name: ["nom", "first name", "first", "firstname", "given name", "nombre"],
    last_name: ["cognom", "cognoms", "last name", "lastname", "surname", "family name", "apellido", "apellidos"],
    side: ["side", "banda", "costat", "lado"],
    guest_group: ["grup", "group", "grupo", "category", "categoria", "party", "table group"],
    rsvp_status: ["rsvp", "status", "rsvp status", "attending", "response", "resposta", "asistencia"],
    dietary: ["food/diet", "dietary", "diet", "dietary needs", "allergies", "food", "meal", "comida", "dieta", "alergias"],
    is_child: ["child", "kid", "infantil", "niño", "menor"],
    plus_one: ["+1", "+1?", "plus one", "plus_one", "plusone", "plus 1", "acompañante", "acompanyant"],
    notes: ["notes", "note", "comments", "comment", "remarks", "comentarios", "observaciones"],
  };
  const IMPORT_FIELDS = ["name", "first_name", "last_name", "side", "guest_group", "rsvp_status", "dietary", "is_child", "plus_one", "notes"];
  const FIELD_LABEL = {
    name: "Full name", first_name: "First name", last_name: "Last name",
    side: "Side", guest_group: "Group", rsvp_status: "RSVP",
    dietary: "Dietary", is_child: "Child?", plus_one: "Plus-one", notes: "Notes",
  };

  let parsedRows = null; // { headers, rows }
  let columnMap = []; // per-column: field key or ""

  const importDialog = $("importDialog");
  $("importBtn").addEventListener("click", () => {
    $("csvFile").value = "";
    $("csvText").value = "";
    $("importPreview").hidden = true;
    $("importPreview").innerHTML = "";
    $("confirmImport").disabled = true;
    parsedRows = null;
    importDialog.showModal();
  });
  $("cancelImport").addEventListener("click", () => importDialog.close());

  $("csvFile").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      $("csvText").value = reader.result;
    };
    reader.readAsText(file);
  });

  function parseCSV(text) {
    const rows = [];
    let row = [], field = "", i = 0, inQuotes = false;
    while (i < text.length) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += ch; i++; continue;
      }
      if (ch === '"') { inQuotes = true; i++; continue; }
      if (ch === ",") { row.push(field); field = ""; i++; continue; }
      if (ch === "\r") { i++; continue; }
      if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
      field += ch; i++;
    }
    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((c) => c.trim() !== ""));
  }

  function autoMap(headers) {
    const used = new Set();
    return headers.map((h) => {
      const norm = h.trim().toLowerCase();
      // pass 1: exact alias match
      for (const field of IMPORT_FIELDS) {
        if (!used.has(field) && FIELD_ALIASES[field].includes(norm)) {
          used.add(field);
          return field;
        }
      }
      // pass 2: substring match (header contains an alias)
      for (const field of IMPORT_FIELDS) {
        if (used.has(field)) continue;
        if (FIELD_ALIASES[field].some((a) => norm.includes(a))) {
          used.add(field);
          return field;
        }
      }
      return "";
    });
  }

  $("parseBtn").addEventListener("click", () => {
    const text = $("csvText").value.trim();
    if (!text) return alert("Paste some CSV or choose a file first.");
    const all = parseCSV(text);
    if (all.length < 2) return alert("Need a header row plus at least one data row.");
    const headers = all[0];
    const rows = all.slice(1);
    parsedRows = { headers, rows };
    columnMap = autoMap(headers);
    renderImportPreview();
  });

  function renderImportPreview() {
    const { headers, rows } = parsedRows;
    const wrap = $("importPreview");
    const sample = rows.slice(0, 5);

    let html = "<table><thead><tr>";
    headers.forEach((h, ci) => {
      html += "<th><div>" + escapeHtml(h) + "</div><select data-col='" + ci + "'>";
      html += "<option value=''>— ignore —</option>";
      IMPORT_FIELDS.forEach((f) => {
        const sel = columnMap[ci] === f ? " selected" : "";
        html += "<option value='" + f + "'" + sel + ">" + FIELD_LABEL[f] + "</option>";
      });
      html += "</select></th>";
    });
    html += "</tr></thead><tbody>";
    sample.forEach((r) => {
      html += "<tr>" + headers.map((_, ci) => "<td>" + escapeHtml(r[ci] || "") + "</td>").join("") + "</tr>";
    });
    html += "</tbody></table>";
    html += "<p class='import-note'>" + rows.length + " rows ready. Map at least the <strong>Name</strong> column, then Import.</p>";
    wrap.innerHTML = html;
    wrap.hidden = false;

    wrap.querySelectorAll("select").forEach((sel) => {
      sel.addEventListener("change", (e) => {
        const ci = +e.target.dataset.col;
        columnMap[ci] = e.target.value;
        validateMap();
      });
    });
    validateMap();
  }

  function validateMap() {
    const hasName =
      columnMap.includes("name") ||
      columnMap.includes("first_name") ||
      columnMap.includes("last_name");
    $("confirmImport").disabled = !hasName;
  }

  function normalizeRsvp(v) {
    const s = (v || "").trim().toLowerCase();
    if (["yes", "y", "attending", "accepted", "accept", "1", "true", "s", "si", "sí"].includes(s)) return "yes";
    if (["no", "n", "declined", "decline", "regrets", "0", "false"].includes(s)) return "no";
    if (["maybe", "tentative", "?"].includes(s)) return "maybe";
    return "pending";
  }
  function normalizeBool(v) {
    const s = (v || "").trim().toLowerCase();
    return ["yes", "y", "true", "1", "x", "✓", "s", "si", "sí"].includes(s);
  }
  // "Infantil" / kid markers in a free-text (e.g. Food/Diet) cell mean the guest is a child.
  function looksLikeChild(v) {
    return /\b(infantil|child|kid|menor|ni[ñn]o|ni[ñn]a)\b/i.test(v || "");
  }

  $("confirmImport").addEventListener("click", async () => {
    if (!parsedRows) return;
    const { rows } = parsedRows;
    const colOf = (field) => columnMap.indexOf(field);
    const ci = {
      name: colOf("name"), first_name: colOf("first_name"), last_name: colOf("last_name"),
      side: colOf("side"), guest_group: colOf("guest_group"), dietary: colOf("dietary"),
      rsvp_status: colOf("rsvp_status"), is_child: colOf("is_child"),
      plus_one: colOf("plus_one"), notes: colOf("notes"),
    };
    const cell = (r, i) => (i >= 0 ? (r[i] || "").trim() : "");

    const payload = [];
    rows.forEach((r) => {
      // build name from a full-name column, or combine first + last
      let name = cell(r, ci.name);
      if (!name) name = (cell(r, ci.first_name) + " " + cell(r, ci.last_name)).trim();
      if (!name) return; // skip nameless rows

      // a "child" cell, an explicit Child? column, or an "Infantil"-style diet marker
      let dietary = cell(r, ci.dietary);
      let isChild = ci.is_child >= 0 ? normalizeBool(r[ci.is_child]) : false;
      if (looksLikeChild(dietary)) { isChild = true; dietary = ""; }
      if (ci.is_child >= 0 && looksLikeChild(r[ci.is_child])) isChild = true;

      payload.push({
        wedding_id: currentWedding.id,
        name,
        side: cell(r, ci.side) || null,
        guest_group: cell(r, ci.guest_group) || null,
        dietary: dietary || null,
        rsvp_status: ci.rsvp_status >= 0 ? normalizeRsvp(r[ci.rsvp_status]) : "pending",
        is_child: isChild,
        plus_one: ci.plus_one >= 0 ? normalizeBool(r[ci.plus_one]) : false,
        notes: ci.notes >= 0 ? cell(r, ci.notes) || null : null,
      });
    });

    if (payload.length === 0) return alert("No rows with a name to import.");
    $("confirmImport").disabled = true;
    $("confirmImport").textContent = "Importing…";
    const { error } = await db.from("guests").insert(payload);
    $("confirmImport").textContent = "Import";
    importDialog.close();
    if (error) return alert("Import failed: " + error.message);
    loadGuests();
  });

  // ============================================================
  // CSV EXPORT
  // ============================================================
  $("exportBtn").addEventListener("click", () => {
    if (guestCache.length === 0) return alert("No guests to export yet.");
    const cols = ["name", "side", "guest_group", "rsvp_status", "dietary", "plus_one", "is_child", "notes"];
    const head = ["Name", "Side", "Group", "RSVP", "Dietary", "PlusOne", "Child", "Notes"];
    const bools = { plus_one: 1, is_child: 1 };
    const lines = [head.map(csvCell).join(",")];
    guestCache.forEach((g) => {
      lines.push(cols.map((c) => csvCell(bools[c] ? (g[c] ? "yes" : "no") : g[c])).join(","));
    });
    const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (currentWedding.name || "guests").replace(/[^a-z0-9]+/gi, "_") + "_guests.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  // ============================================================
  // FLOOR PLAN (Phase 3) — tables + exact-seat assignment
  // ============================================================
  let tablesCache = [];
  let assignmentsCache = [];
  let constraintsCache = [];
  let warnGuestIds = new Set();
  let floorZoom = 1;

  function guestById(id) {
    return guestCache.find((g) => g.id === id);
  }
  function initials(name) {
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  // tabs
  function showTab(which) {
    const onFloor = which === "floor";
    $("guestsPanel").hidden = onFloor;
    $("floorPanel").hidden = !onFloor;
    $("tabGuests").classList.toggle("active", !onFloor);
    $("tabFloor").classList.toggle("active", onFloor);
    if (onFloor) loadFloor();
  }
  $("tabGuests").addEventListener("click", () => showTab("guests"));
  $("tabFloor").addEventListener("click", () => showTab("floor"));

  // --- seat geometry ---
  const SEAT = 34, GAP = 8, SLOT = 44;

  function roundLayout(n) {
    const circ = Math.max(n * SLOT, 3 * SLOT);
    let R = circ / (2 * Math.PI);
    const D = Math.max(86, 2 * R);
    R = D / 2;
    const ring = R + GAP + SEAT / 2;
    const C = ring + SEAT / 2 + 2;
    const seats = [];
    for (let i = 0; i < n; i++) {
      const a = ((-90 + (360 * i) / n) * Math.PI) / 180;
      seats.push({ x: C + ring * Math.cos(a), y: C + ring * Math.sin(a) });
    }
    return { w: 2 * C, h: 2 * C, surface: { left: C - R, top: C - R, w: D, h: D, round: true }, seats };
  }

  function rectLayout(n, sides, surfaceW, surfaceH) {
    const counts = {};
    sides.forEach((s) => (counts[s] = 0));
    for (let i = 0; i < n; i++) counts[sides[i % sides.length]]++;
    const left = GAP + SEAT, top = GAP + SEAT;
    const seats = [];
    const sx0 = left, sx1 = left + surfaceW, sy0 = top, sy1 = top + surfaceH;
    const along = (count, fixed, axis, start, end) => {
      for (let i = 0; i < count; i++) {
        const p = start + (end - start) * ((i + 1) / (count + 1));
        seats.push(axis === "x" ? { x: p, y: fixed } : { x: fixed, y: p });
      }
    };
    if (counts.top) along(counts.top, sy0 - GAP - SEAT / 2, "x", sx0, sx1);
    if (counts.bottom) along(counts.bottom, sy1 + GAP + SEAT / 2, "x", sx0, sx1);
    if (counts.left) along(counts.left, sx0 - GAP - SEAT / 2, "y", sy0, sy1);
    if (counts.right) along(counts.right, sx1 + GAP + SEAT / 2, "y", sy0, sy1);
    return {
      w: surfaceW + 2 * (GAP + SEAT), h: surfaceH + 2 * (GAP + SEAT),
      surface: { left, top, w: surfaceW, h: surfaceH, round: false }, seats,
    };
  }

  function seatLayout(shape, n) {
    n = Math.max(1, n | 0);
    if (shape === "round") return roundLayout(n);
    if (shape === "square") {
      const s = Math.max(96, Math.ceil(n / 4) * SLOT);
      return rectLayout(n, ["top", "right", "bottom", "left"], s, s);
    }
    return rectLayout(n, ["top", "bottom"], Math.max(120, Math.ceil(n / 2) * SLOT), 60);
  }

  // --- load + render ---
  async function loadFloor() {
    const [tRes, aRes, cRes] = await Promise.all([
      db.from("tables").select("*").eq("wedding_id", currentWedding.id).order("created_at"),
      db.from("seat_assignments").select("*").eq("wedding_id", currentWedding.id),
      db.from("constraints").select("*").eq("wedding_id", currentWedding.id),
    ]);
    if (tRes.error) return alert("Couldn't load tables: " + tRes.error.message);
    if (aRes.error) return alert("Couldn't load seating: " + aRes.error.message);
    tablesCache = tRes.data || [];
    assignmentsCache = aRes.data || [];
    if (!cRes.error) constraintsCache = cRes.data || [];
    const warnings = computeWarnings();
    warnGuestIds = warnings.ids;
    populateFilters();
    renderUnseated();
    renderCanvas();
    renderWarnings(warnings.messages);
    renderFloorStats();
  }

  function computeWarnings() {
    const messages = [];
    const ids = new Set();
    const seatOf = {};
    assignmentsCache.forEach((a) => (seatOf[a.guest_id] = a));
    const tLabel = (tid) => { const t = tablesCache.find((x) => x.id === tid); return t ? t.label : "?"; };
    constraintsCache.forEach((c) => {
      const a = seatOf[c.guest_a], b = seatOf[c.guest_b];
      const na = partnerName(c.guest_a), nb = partnerName(c.guest_b);
      if (c.kind === "apart") {
        if (a && b && a.table_id === b.table_id) {
          messages.push(na + " and " + nb + " should be kept apart, but are both at " + tLabel(a.table_id) + ".");
          ids.add(c.guest_a); ids.add(c.guest_b);
        }
      } else {
        if (a && b) {
          if (a.table_id !== b.table_id) {
            messages.push(na + " & " + nb + " should sit together, but are at different tables (" + tLabel(a.table_id) + " / " + tLabel(b.table_id) + ").");
            ids.add(c.guest_a); ids.add(c.guest_b);
          }
        } else if (a || b) {
          messages.push((a ? na : nb) + " is seated but " + (a ? nb : na) + " (sits together) is not yet seated.");
          ids.add(c.guest_a); ids.add(c.guest_b);
        }
      }
    });
    return { messages, ids };
  }

  function renderWarnings(messages) {
    const el = $("floorWarnings");
    if (!messages.length) { el.hidden = true; el.innerHTML = ""; return; }
    el.hidden = false;
    el.innerHTML = "";
    const head = document.createElement("div");
    head.className = "warn-head";
    head.textContent = "⚠ " + messages.length + " seating warning" + (messages.length > 1 ? "s" : "");
    const ul = document.createElement("ul");
    messages.forEach((m) => { const li = document.createElement("li"); li.textContent = m; ul.appendChild(li); });
    el.appendChild(head);
    el.appendChild(ul);
  }

  function renderFloorStats() {
    const seated = assignmentsCache.length;
    const capacity = tablesCache.reduce((s, t) => s + (t.seats || 0), 0);
    $("floorStats").innerHTML =
      "<strong>" + seated + "</strong> / " + guestCache.length + " seated · " +
      (guestCache.length - seated) + " unseated · " +
      tablesCache.length + " tables · " + capacity + " seats";
  }

  function populateFilters() {
    const sides = [...new Set(guestCache.map((g) => g.side).filter(Boolean))];
    const groups = [...new Set(guestCache.map((g) => g.guest_group).filter(Boolean))];
    const fill = (sel, label, vals) => {
      const cur = sel.value;
      sel.innerHTML = "<option value=''>" + label + "</option>";
      vals.forEach((v) => {
        const o = document.createElement("option");
        o.value = v; o.textContent = v;
        sel.appendChild(o);
      });
      if (vals.includes(cur)) sel.value = cur;
    };
    fill($("sideFilter"), "All sides", sides);
    fill($("groupFilter"), "All groups", groups);
  }

  function renderUnseated() {
    const list = $("unseatedList");
    list.innerHTML = "";
    const seatedIds = new Set(assignmentsCache.map((a) => a.guest_id));
    const q = $("guestSearch").value.trim().toLowerCase();
    const sideF = $("sideFilter").value;
    const groupF = $("groupFilter").value;

    const unseated = guestCache.filter((g) => {
      if (seatedIds.has(g.id)) return false;
      if (sideF && g.side !== sideF) return false;
      if (groupF && g.guest_group !== groupF) return false;
      if (q && !g.name.toLowerCase().includes(q)) return false;
      return true;
    });

    $("unseatedCount").textContent = "(" + unseated.length + ")";
    unseated.forEach((g) => {
      const chip = document.createElement("div");
      chip.className = "gchip" + (g.is_child ? " kid" : "");
      chip.draggable = true;
      chip.dataset.guest = g.id;
      chip.innerHTML = "<span></span><span class='chip-side'></span>";
      chip.children[0].textContent = g.name;
      chip.children[1].textContent = g.side || "";
      chip.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", g.id));
      list.appendChild(chip);
    });
  }

  function computeBounds() {
    let w = 400, h = 300;
    tablesCache.forEach((t) => {
      const l = seatLayout(t.shape, t.seats);
      w = Math.max(w, (t.pos_x || 0) + l.w + 40);
      h = Math.max(h, (t.pos_y || 0) + l.h + 40);
    });
    return { w, h };
  }
  function applyZoom() {
    const b = computeBounds();
    const inner = $("floorInner"), sizer = $("floorSizer");
    inner.style.width = b.w + "px";
    inner.style.height = b.h + "px";
    inner.style.transform = "scale(" + floorZoom + ")";
    sizer.style.width = b.w * floorZoom + "px";
    sizer.style.height = b.h * floorZoom + "px";
    $("zoomLabel").textContent = Math.round(floorZoom * 100) + "%";
  }
  function setZoom(z) {
    floorZoom = Math.max(0.25, Math.min(2, Math.round(z * 100) / 100));
    applyZoom();
  }
  $("zoomIn").addEventListener("click", () => setZoom(floorZoom + 0.25));
  $("zoomOut").addEventListener("click", () => setZoom(floorZoom - 0.25));
  $("zoomReset").addEventListener("click", () => {
    // fit width to the visible canvas
    const b = computeBounds();
    const avail = $("floorCanvas").clientWidth - 20;
    setZoom(avail > 0 ? avail / b.w : 1);
  });

  function renderCanvas() {
    const canvas = $("floorInner");
    canvas.innerHTML = "";
    tablesCache.forEach((table) => {
      const layout = seatLayout(table.shape, table.seats);
      const cont = document.createElement("div");
      cont.className = "ftable";
      cont.style.left = (table.pos_x || 0) + "px";
      cont.style.top = (table.pos_y || 0) + "px";
      cont.style.width = layout.w + "px";
      cont.style.height = layout.h + "px";

      const occ = assignmentsCache.filter((a) => a.table_id === table.id);
      const surf = document.createElement("div");
      surf.className = "ftable-surface" + (occ.length >= table.seats ? " full" : "");
      surf.style.left = layout.surface.left + "px";
      surf.style.top = layout.surface.top + "px";
      surf.style.width = layout.surface.w + "px";
      surf.style.height = layout.surface.h + "px";
      surf.style.borderRadius = layout.surface.round ? "50%" : "10px";
      const lbl = document.createElement("div");
      lbl.textContent = table.label;
      const cnt = document.createElement("div");
      cnt.textContent = occ.length + "/" + table.seats;
      cnt.style.fontWeight = "400";
      cnt.style.opacity = ".8";
      surf.appendChild(lbl);
      surf.appendChild(cnt);
      surf.addEventListener("mousedown", (e) => startTableDrag(e, table, cont));
      surf.addEventListener("dblclick", () => openTableDialog(table));
      cont.appendChild(surf);

      layout.seats.forEach((p, i) => {
        const seat = document.createElement("div");
        seat.className = "fseat";
        seat.style.left = p.x - SEAT / 2 + "px";
        seat.style.top = p.y - SEAT / 2 + "px";
        const a = occ.find((x) => x.seat_index === i);
        if (a) {
          const g = guestById(a.guest_id);
          seat.classList.add("occupied");
          if (warnGuestIds.has(a.guest_id)) seat.classList.add("warn");
          seat.draggable = true;
          seat.dataset.guest = a.guest_id;
          seat.title = g ? g.name : "";
          const nm = document.createElement("div");
          nm.className = "seat-name";
          nm.textContent = g ? initials(g.name) : "?";
          seat.appendChild(nm);
          seat.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", a.guest_id));
          seat.addEventListener("click", (e) => { e.stopPropagation(); if (g) showSeatInfo(g, seat); });
        }
        seat.addEventListener("dragover", (e) => { e.preventDefault(); seat.classList.add("drop-hover"); });
        seat.addEventListener("dragleave", () => seat.classList.remove("drop-hover"));
        seat.addEventListener("drop", (e) => {
          e.preventDefault();
          seat.classList.remove("drop-hover");
          const gid = e.dataTransfer.getData("text/plain");
          if (gid) assignSeat(gid, table.id, i);
        });
        cont.appendChild(seat);
      });
      canvas.appendChild(cont);
    });
    applyZoom();
  }

  // --- table dragging (reposition) ---
  function startTableDrag(e, table, cont) {
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const origX = table.pos_x || 0, origY = table.pos_y || 0;
    let nx = origX, ny = origY;
    const move = (ev) => {
      nx = Math.max(0, origX + (ev.clientX - startX) / floorZoom);
      ny = Math.max(0, origY + (ev.clientY - startY) / floorZoom);
      cont.style.left = nx + "px";
      cont.style.top = ny + "px";
    };
    const up = async () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      if (nx === origX && ny === origY) return;
      table.pos_x = nx; table.pos_y = ny;
      await db.from("tables").update({ pos_x: nx, pos_y: ny }).eq("id", table.id);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }

  // --- seat assignment ---
  async function assignSeat(guestId, tableId, seatIndex) {
    const target = assignmentsCache.find((a) => a.table_id === tableId && a.seat_index === seatIndex);
    if (target && target.guest_id === guestId) return;
    const movingFrom = assignmentsCache.find((a) => a.guest_id === guestId);

    const rows = [{ wedding_id: currentWedding.id, table_id: tableId, guest_id: guestId, seat_index: seatIndex }];
    if (target) {
      if (movingFrom) {
        // swap: current occupant takes the dragged guest's old seat
        rows.push({ wedding_id: currentWedding.id, table_id: movingFrom.table_id, guest_id: target.guest_id, seat_index: movingFrom.seat_index });
      } else {
        // dragged from the unseated pane: bump the occupant out
        const del = await db.from("seat_assignments").delete().eq("guest_id", target.guest_id);
        if (del.error) return alert("Couldn't reseat: " + del.error.message);
      }
    }
    const { error } = await db.from("seat_assignments").upsert(rows, { onConflict: "guest_id" });
    if (error) return alert("Couldn't assign seat: " + error.message);
    await maybeSeatPartner(guestId, tableId, seatIndex);
    loadFloor();
  }

  // If the just-seated guest is linked "sit together" with an unseated partner,
  // offer to drop that partner into the nearest empty seat at the same table.
  async function maybeSeatPartner(guestId, tableId, seatIndex) {
    const partnerIds = constraintsCache
      .filter((c) => c.kind === "together" && (c.guest_a === guestId || c.guest_b === guestId))
      .map((c) => (c.guest_a === guestId ? c.guest_b : c.guest_a));
    if (!partnerIds.length) return;
    const seated = new Set(assignmentsCache.map((a) => a.guest_id));
    seated.add(guestId);
    const partnerId = partnerIds.find((id) => !seated.has(id));
    if (!partnerId) return;
    const table = tablesCache.find((t) => t.id === tableId);
    if (!table) return;
    const occupied = new Set(assignmentsCache.filter((a) => a.table_id === tableId).map((a) => a.seat_index));
    occupied.add(seatIndex);
    if (occupied.size >= table.seats) return;
    const target = nearestEmptySeat(table.seats, seatIndex, occupied);
    if (target == null) return;
    const ok = await uiConfirm(
      partnerName(partnerId) + " is marked to sit together with them. Seat them in the next free chair?",
      { okText: "Seat together" }
    );
    if (!ok) return;
    await db.from("seat_assignments").upsert(
      [{ wedding_id: currentWedding.id, table_id: tableId, guest_id: partnerId, seat_index: target }],
      { onConflict: "guest_id" }
    );
  }
  function nearestEmptySeat(n, start, occupied) {
    for (let d = 1; d <= n; d++) {
      const a = (start + d) % n, b = (start - d + n) % n;
      if (!occupied.has(a)) return a;
      if (!occupied.has(b)) return b;
    }
    return null;
  }

  async function unseat(guestId) {
    const { error } = await db.from("seat_assignments").delete().eq("guest_id", guestId);
    if (error) return alert("Couldn't unseat: " + error.message);
    loadFloor();
  }

  // --- seated-guest info popover ---
  let seatPopover = null;
  function closeSeatInfo() {
    if (seatPopover) { seatPopover.remove(); seatPopover = null; }
  }
  function showSeatInfo(g, anchor) {
    closeSeatInfo();
    const pop = document.createElement("div");
    pop.className = "seat-pop";
    const meta = [g.side, g.guest_group].filter(Boolean).join(" · ") || "No side / group";
    pop.innerHTML =
      "<div class='sp-name'></div><div class='sp-meta'></div>" +
      "<div class='sp-tags'></div>" +
      "<div class='sp-actions'>" +
      "<button class='btn btn-ghost' data-act='edit'>Edit</button>" +
      "<button class='btn btn-ghost danger' data-act='unseat'>Unseat</button></div>";
    pop.querySelector(".sp-name").textContent = g.name;
    pop.querySelector(".sp-meta").textContent = meta;
    const tags = pop.querySelector(".sp-tags");
    if (g.is_child) { const t = document.createElement("span"); t.className = "kid-tag"; t.textContent = "kid"; tags.appendChild(t); }
    if (g.plus_one) { const t = document.createElement("span"); t.className = "pill maybe"; t.textContent = "+1"; tags.appendChild(t); }
    if (g.dietary) { const t = document.createElement("span"); t.className = "pill pending"; t.textContent = g.dietary; tags.appendChild(t); }

    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    let left = r.left, top = r.bottom + 6;
    if (left + pop.offsetWidth > window.innerWidth - 8) left = window.innerWidth - pop.offsetWidth - 8;
    if (top + pop.offsetHeight > window.innerHeight - 8) top = r.top - pop.offsetHeight - 6;
    pop.style.left = Math.max(8, left) + "px";
    pop.style.top = Math.max(8, top) + "px";

    pop.querySelector("[data-act='edit']").addEventListener("click", () => { closeSeatInfo(); openGuestDialog(g); });
    pop.querySelector("[data-act='unseat']").addEventListener("click", () => { closeSeatInfo(); unseat(g.id); });
    seatPopover = pop;
  }
  document.addEventListener("click", (e) => {
    if (seatPopover && !seatPopover.contains(e.target) &&
        !(e.target.closest && e.target.closest(".fseat.occupied"))) {
      closeSeatInfo();
    }
  });

  // unseated pane is a drop target (drag a seated guest here to remove them)
  (function wireUnseatedDrop() {
    const list = $("unseatedList");
    list.addEventListener("dragover", (e) => { e.preventDefault(); list.classList.add("drop-hover"); });
    list.addEventListener("dragleave", () => list.classList.remove("drop-hover"));
    list.addEventListener("drop", (e) => {
      e.preventDefault();
      list.classList.remove("drop-hover");
      const gid = e.dataTransfer.getData("text/plain");
      if (gid) unseat(gid);
    });
  })();

  $("guestSearch").addEventListener("input", renderUnseated);
  $("sideFilter").addEventListener("change", renderUnseated);
  $("groupFilter").addEventListener("change", renderUnseated);

  // --- add/edit table dialog ---
  const tableDialog = $("tableDialog");
  function openTableDialog(t) {
    const editing = !!t;
    $("tableDialogTitle").textContent = editing ? "Edit table" : "Add table";
    $("tableId").value = editing ? t.id : "";
    $("tLabel").value = editing ? t.label : "Table " + (tablesCache.length + 1);
    $("tShape").value = editing ? t.shape : "round";
    $("tSeats").value = editing ? t.seats : 8;
    $("deleteTableBtn").hidden = !editing;
    tableDialog.showModal();
  }
  $("addTableBtn").addEventListener("click", () => openTableDialog(null));
  $("cancelTable").addEventListener("click", () => tableDialog.close());

  $("tableForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("tableId").value;
    const label = $("tLabel").value.trim();
    const shape = $("tShape").value;
    const seats = Math.max(1, Math.min(100, parseInt($("tSeats").value, 10) || 8));
    if (!label) return;

    let error;
    if (id) {
      ({ error } = await db.from("tables").update({ label, shape, seats }).eq("id", id));
    } else {
      const n = tablesCache.length;
      const pos_x = 20 + (n % 4) * 200;
      const pos_y = 20 + Math.floor(n / 4) * 200;
      ({ error } = await db.from("tables").insert({ wedding_id: currentWedding.id, label, shape, seats, pos_x, pos_y }));
    }
    tableDialog.close();
    if (error) return alert("Couldn't save table: " + error.message);
    loadFloor();
  });

  $("deleteTableBtn").addEventListener("click", async () => {
    const id = $("tableId").value;
    if (!id) return;
    if (!(await uiConfirm("Delete this table? Anyone seated here will be unseated.", { okText: "Delete" }))) return;
    const { error } = await db.from("tables").delete().eq("id", id);
    tableDialog.close();
    if (error) return alert("Couldn't delete table: " + error.message);
    loadFloor();
  });

  function csvCell(v) {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  init();
})();
