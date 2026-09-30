/* NGWANU Closet — everything is stored on the phone (IndexedDB).
   Only "Style me" talks to the network: it sends small thumbnails to the
   Cloudflare Worker in /closet-api, which asks Claude for outfit ideas. */
(function () {
  "use strict";

  var CONFIG = window.CLOSET_CONFIG || {};
  var WHATSAPP_NUMBER = "2348118494314";
  var LAGOS = { lat: 6.5244, lon: 3.3792, name: "Lagos" };

  var CATEGORIES = ["Top", "Bottom", "Dress", "Native wear", "Outerwear", "Shoes", "Bag", "Accessory"];
  var COLORS = [
    ["Black", "#111"], ["White", "#fff"], ["Grey", "#9e9e9e"], ["Navy", "#1f2a5a"], ["Blue", "#2f6fd6"],
    ["Green", "#2e8b57"], ["Red", "#c62828"], ["Pink", "#e991b4"], ["Yellow", "#f2c12e"], ["Orange", "#e08020"],
    ["Brown", "#7b4a2a"], ["Beige", "#d9c3a0"], ["Purple", "#7b3fa0"],
    ["Multi", "conic-gradient(#c62828,#f2c12e,#2e8b57,#2f6fd6,#7b3fa0,#c62828)"]
  ];
  var OCCASIONS = ["Casual", "Work", "Church", "Mosque", "Owambe", "Wedding", "Date night", "Gym", "Travel"];

  /* ---------- storage ---------- */
  var dbPromise;
  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise(function (resolve, reject) {
        var req = indexedDB.open("ngwanu-closet", 1);
        req.onupgradeneeded = function () {
          var db = req.result;
          db.createObjectStore("items", { keyPath: "id" });
          db.createObjectStore("outfits", { keyPath: "id" });
          db.createObjectStore("plans", { keyPath: "date" });
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    }
    return dbPromise;
  }
  function tx(store, mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(store, mode);
        var req = fn(t.objectStore(store));
        t.oncomplete = function () { resolve(req && req.result); };
        t.onerror = function () { reject(t.error); };
      });
    });
  }
  var DB = {
    all: function (s) { return tx(s, "readonly", function (st) { return st.getAll(); }); },
    put: function (s, v) { return tx(s, "readwrite", function (st) { return st.put(v); }); },
    del: function (s, k) { return tx(s, "readwrite", function (st) { return st.delete(k); }); }
  };

  /* ---------- state ---------- */
  var state = {
    items: [], outfits: [], plans: {},
    filter: "All", occasion: "Casual",
    calMonth: firstOfMonth(new Date()),
    weather: null, coords: LAGOS
  };

  /* ---------- helpers ---------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function uid() { return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)); }
  function pad(n) { return String(n).padStart(2, "0"); }
  function iso(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function firstOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function niceDate(isoStr) {
    var p = isoStr.split("-");
    return new Date(+p[0], +p[1] - 1, +p[2]).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  }
  function itemById(id) { return state.items.find(function (i) { return i.id === id; }); }
  function outfitById(id) { return state.outfits.find(function (o) { return o.id === id; }); }
  function outfitItems(o) { return (o.itemIds || []).map(itemById).filter(Boolean); }
  function itemLabel(i) { return i.name || [i.color, i.category].filter(Boolean).join(" ") || "Item"; }
  function waLink(msg) { return "https://wa.me/" + WHATSAPP_NUMBER + "?text=" + encodeURIComponent(msg); }
  function show(el, on) { el.hidden = !on; }
  function openSheet(d) { if (!d.open) d.showModal(); }

  function strip(items) {
    return '<div class="strip">' + items.map(function (i) {
      return '<img src="' + i.thumb + '" alt="' + esc(itemLabel(i)) + '" loading="lazy" />';
    }).join("") + "</div>";
  }

  /* Shrink a photo to a JPEG data URL whose longest side is `max` px. */
  function resize(file, max, quality) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement("canvas");
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        var ctx = c.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL("image/jpeg", quality));
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("Could not read that photo.")); };
      img.src = url;
    });
  }

  /* ---------- navigation ---------- */
  var VIEWS = ["closet", "style", "calendar", "outfits"];
  function go(view) {
    if (VIEWS.indexOf(view) < 0) view = "closet";
    VIEWS.forEach(function (v) { $("#v-" + v).classList.toggle("active", v === view); });
    document.querySelectorAll("nav.bottom button").forEach(function (b) {
      if (b.dataset.view === view) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    $("#fab").classList.toggle("show", view === "closet");
    if (location.hash !== "#" + view) history.replaceState(null, "", "#" + view);
    window.scrollTo(0, 0);
    if (view === "style") loadWeather();
  }

  /* ---------- closet ---------- */
  function renderCount() {
    var n = state.items.length;
    $("#count").textContent = n ? n + " item" + (n === 1 ? "" : "s") : "";
  }

  function renderFilter() {
    var cats = ["All"].concat(CATEGORIES.filter(function (c) {
      return state.items.some(function (i) { return i.category === c; });
    }));
    if (cats.indexOf(state.filter) < 0) state.filter = "All";
    $("#cat-filter").innerHTML = cats.map(function (c) {
      return '<button class="chip" data-filter="' + esc(c) + '" aria-pressed="' + (c === state.filter) + '">' + esc(c) + "</button>";
    }).join("");
    show($("#cat-filter"), state.items.length > 0);
  }

  function renderCloset() {
    renderCount();
    renderFilter();
    var list = state.items.filter(function (i) { return state.filter === "All" || i.category === state.filter; });
    var grid = $("#closet-grid");
    if (!state.items.length) {
      grid.style.display = "block";
      grid.innerHTML = '<div class="empty"><b>Your closet is empty</b>Snap a photo of each piece you wear — shirts, trousers, native wear, shoes. Plain background works best.<div style="margin-top:14px"><button class="btn" data-action="add-item">+ Add your first item</button></div></div>';
      return;
    }
    grid.style.display = "";
    grid.innerHTML = list.map(function (i) {
      return '<button class="tile" data-item="' + i.id + '"><img src="' + i.thumb + '" alt="" loading="lazy" /><span class="lbl">' + esc(itemLabel(i)) + "</span></button>";
    }).join("");
  }

  var draft = null;
  function openAdd() {
    draft = { color: "", tags: [], photo: "", thumb: "" };
    $("#add-form").reset();
    $("#photo-drop").innerHTML = "<span>📷<br />Tap to take or choose a photo</span>";
    $("#item-cat").innerHTML = CATEGORIES.map(function (c) { return "<option>" + esc(c) + "</option>"; }).join("");
    $("#item-colors").innerHTML = COLORS.map(function (c) {
      return '<button type="button" class="sw" data-color="' + c[0] + '" aria-pressed="false" aria-label="' + c[0] + '" title="' + c[0] + '" style="background:' + c[1] + '"></button>';
    }).join("");
    $("#item-tags").innerHTML = OCCASIONS.map(function (o) {
      return '<button type="button" class="chip" data-tag="' + esc(o) + '" aria-pressed="false">' + esc(o) + "</button>";
    }).join("");
    show($("#add-error"), false);
    openSheet($("#d-add"));
  }

  function onPhoto(file) {
    if (!file) return;
    $("#photo-drop").innerHTML = "<span>Processing…</span>";
    Promise.all([resize(file, 900, 0.82), resize(file, 320, 0.72)]).then(function (r) {
      draft.photo = r[0];
      draft.thumb = r[1];
      $("#photo-drop").innerHTML = '<img src="' + r[1] + '" alt="Selected photo" />';
    }).catch(function (e) {
      $("#photo-drop").innerHTML = "<span>📷<br />Tap to take or choose a photo</span>";
      showErr("#add-error", e.message);
    });
  }

  function saveItem(e) {
    e.preventDefault();
    if (!draft.thumb) return showErr("#add-error", "Add a photo of the item first.");
    var item = {
      id: uid(),
      name: $("#item-name").value.trim(),
      category: $("#item-cat").value,
      color: draft.color,
      tags: draft.tags.slice(),
      photo: draft.photo,
      thumb: draft.thumb,
      created: Date.now()
    };
    DB.put("items", item).then(function () {
      state.items.unshift(item);
      $("#d-add").close();
      renderCloset();
    }).catch(function () { showErr("#add-error", "Couldn't save — your phone may be low on storage."); });
  }

  function openItem(id) {
    var i = itemById(id);
    if (!i) return;
    var body = $("#item-body");
    body.innerHTML =
      '<div class="sheet-head"><h2 id="h-item">' + esc(itemLabel(i)) + '</h2><button type="button" class="x" data-close aria-label="Close">×</button></div>' +
      '<img src="' + (i.photo || i.thumb) + '" alt="" style="width:100%;max-height:50vh;object-fit:contain;border-radius:12px;background:var(--paper)" />' +
      '<p class="row" style="margin:12px 0">' + [i.category, i.color].concat(i.tags || []).filter(Boolean).map(function (t) { return '<span class="tag">' + esc(t) + "</span>"; }).join("") + "</p>" +
      '<p class="muted" style="font-size:.9rem;margin:0 0 8px">Need it cleaned or adjusted? NGWANU EXPRESS will pick it up and bring it back.</p>' +
      '<div class="sheet-foot" style="margin-top:8px">' +
      '<a class="btn btn--accent" target="_blank" rel="noopener" href="' + waLink("Hi NGWANU EXPRESS 👋 I'd like a pickup to take my " + itemLabel(i) + " to the laundry. My pickup address is: ") + '">🧺 Laundry pickup</a>' +
      '<a class="btn btn--ghost" target="_blank" rel="noopener" href="' + waLink("Hi NGWANU EXPRESS 👋 I'd like a pickup to take my " + itemLabel(i) + " to my tailor. Pickup address: \nTailor's address: ") + '">🪡 Send to tailor</a>' +
      "</div>" +
      '<div class="sheet-foot" style="margin-top:10px"><button class="btn btn--danger" data-delete-item="' + i.id + '">Delete item</button></div>';
    openSheet($("#d-item"));
  }

  function deleteItem(id) {
    if (!confirm("Delete this item from your closet?")) return;
    var jobs = [DB.del("items", id)];
    state.items = state.items.filter(function (i) { return i.id !== id; });
    state.outfits.forEach(function (o) {
      if (o.itemIds.indexOf(id) < 0) return;
      o.itemIds = o.itemIds.filter(function (x) { return x !== id; });
      jobs.push(o.itemIds.length ? DB.put("outfits", o) : removeOutfit(o.id));
    });
    Promise.all(jobs).then(function () {
      $("#d-item").close();
      renderAll();
    });
  }

  /* ---------- outfits ---------- */
  function saveOutfit(o) {
    return DB.put("outfits", o).then(function () {
      state.outfits = state.outfits.filter(function (x) { return x.id !== o.id; });
      state.outfits.unshift(o);
    });
  }

  function removeOutfit(id) {
    state.outfits = state.outfits.filter(function (o) { return o.id !== id; });
    var jobs = [DB.del("outfits", id)];
    Object.keys(state.plans).forEach(function (d) {
      if (state.plans[d] === id) { delete state.plans[d]; jobs.push(DB.del("plans", d)); }
    });
    return Promise.all(jobs);
  }

  function planDay(date, outfitId) {
    state.plans[date] = outfitId;
    return DB.put("plans", { date: date, outfitId: outfitId });
  }

  function renderOutfits() {
    var el = $("#outfit-list");
    if (!state.outfits.length) {
      el.innerHTML = '<div class="empty"><b>No outfits yet</b>Build one yourself, or let the AI stylist suggest some.<div class="row" style="justify-content:center;margin-top:14px"><button class="btn" data-action="new-outfit">+ New outfit</button><button class="btn btn--ghost" data-view="style">✨ Style me</button></div></div>';
      return;
    }
    var today = iso(new Date());
    el.innerHTML = state.outfits.map(function (o) {
      return '<article class="card"><h3>' + esc(o.title || "Outfit") + "</h3>" +
        (o.occasion ? '<span class="tag">' + esc(o.occasion) + "</span>" : "") +
        strip(outfitItems(o)) +
        (o.why ? '<p class="muted" style="margin:0 0 10px;font-size:.92rem">' + esc(o.why) + "</p>" : "") +
        '<div class="row"><input type="date" value="' + today + '" aria-label="Date to wear" style="flex:1;min-width:140px" data-plan-date="' + o.id + '" />' +
        '<button class="btn btn--sm" data-plan="' + o.id + '">Plan</button>' +
        '<button class="btn btn--sm btn--danger" data-delete-outfit="' + o.id + '">Delete</button></div></article>';
    }).join("");
  }

  var picked = [];
  function openBuilder() {
    if (state.items.length < 2) { alert("Add at least 2 items to your closet first."); return; }
    picked = [];
    $("#outfit-form").reset();
    show($("#outfit-error"), false);
    $("#outfit-picker").innerHTML = state.items.map(function (i) {
      return '<button type="button" class="tile pick" data-pick="' + i.id + '" aria-pressed="false"><img src="' + i.thumb + '" alt="" /><span class="lbl">' + esc(itemLabel(i)) + "</span></button>";
    }).join("");
    openSheet($("#d-outfit"));
  }

  function submitBuilder(e) {
    e.preventDefault();
    if (picked.length < 2) return showErr("#outfit-error", "Pick at least 2 items.");
    saveOutfit({ id: uid(), title: $("#outfit-title").value.trim() || "My outfit", itemIds: picked.slice(), source: "manual", created: Date.now() })
      .then(function () { $("#d-outfit").close(); renderOutfits(); });
  }

  /* ---------- calendar ---------- */
  function renderCalendar() {
    var m = state.calMonth;
    $("#cal-title").textContent = m.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    var html = ["S", "M", "T", "W", "T", "F", "S"].map(function (d) { return '<div class="dow" aria-hidden="true">' + d + "</div>"; }).join("");
    for (var b = 0; b < m.getDay(); b++) html += '<div class="day blank"></div>';
    var days = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
    var today = iso(new Date());
    for (var d = 1; d <= days; d++) {
      var key = iso(new Date(m.getFullYear(), m.getMonth(), d));
      var o = state.plans[key] && outfitById(state.plans[key]);
      var first = o && outfitItems(o)[0];
      html += '<button class="day' + (key === today ? " today" : "") + '" data-day="' + key + '" aria-label="' + niceDate(key) + (o ? ", planned: " + esc(o.title) : "") + '"><span>' + d + "</span>" +
        (first ? '<img src="' + first.thumb + '" alt="" />' : "") + "</button>";
    }
    $("#cal").innerHTML = html;
  }

  function openDay(date) {
    var planned = state.plans[date] && outfitById(state.plans[date]);
    var html = '<div class="sheet-head"><h2 id="h-day">' + esc(niceDate(date)) + '</h2><button type="button" class="x" data-close aria-label="Close">×</button></div>';
    if (planned) {
      html += '<div class="card"><b>Planned: ' + esc(planned.title) + "</b>" + strip(outfitItems(planned)) +
        '<button class="btn btn--sm btn--danger" data-unplan="' + date + '">Remove from this day</button></div>';
    }
    if (state.outfits.length) {
      html += '<p class="muted" style="margin:8px 0">' + (planned ? "Or switch to:" : "Choose an outfit:") + "</p>" +
        state.outfits.filter(function (o) { return !planned || o.id !== planned.id; }).map(function (o) {
          return '<button class="card" style="width:100%;text-align:left;cursor:pointer" data-choose="' + o.id + '" data-date="' + date + '"><b>' + esc(o.title) + "</b>" + strip(outfitItems(o)) + "</button>";
        }).join("");
    } else {
      html += '<p class="muted">You have no saved outfits yet.</p>';
    }
    html += '<div class="sheet-foot"><button class="btn btn--accent" data-style-for="' + date + '">✨ Ask the stylist for this day</button></div>';
    $("#day-body").innerHTML = html;
    openSheet($("#d-day"));
  }

  /* ---------- weather (Open-Meteo, free, no key) ---------- */
  var WMO = { 0: "Clear sky", 1: "Mostly clear", 2: "Partly cloudy", 3: "Cloudy", 45: "Foggy", 48: "Foggy", 51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
    61: "Light rain", 63: "Rain", 65: "Heavy rain", 80: "Rain showers", 81: "Rain showers", 82: "Heavy showers", 95: "Thunderstorm", 96: "Thunderstorm", 99: "Thunderstorm" };
  var weatherLoading = null;

  function loadWeather(force) {
    if (weatherLoading && !force) return weatherLoading.then(renderWeather);
    var c = state.coords;
    var url = "https://api.open-meteo.com/v1/forecast?latitude=" + c.lat + "&longitude=" + c.lon +
      "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=16";
    weatherLoading = fetch(url).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      state.weather = j && j.daily ? j.daily : null;
    }).catch(function () { state.weather = null; });
    return weatherLoading.then(renderWeather);
  }

  function weatherFor(date) {
    var w = state.weather;
    if (!w) return null;
    var i = w.time.indexOf(date);
    if (i < 0) return null;
    var desc = WMO[w.weather_code[i]] || "Mixed weather";
    var rain = w.precipitation_probability_max[i];
    return state.coords.name + ": " + desc + ", " + Math.round(w.temperature_2m_min[i]) + "–" + Math.round(w.temperature_2m_max[i]) + "°C" +
      (rain != null ? ", " + rain + "% chance of rain" : "");
  }

  function renderWeather() {
    var text = weatherFor($("#style-date").value);
    var btn = state.coords === LAGOS && navigator.geolocation ? '<button class="btn btn--sm btn--ghost" id="use-loc">Use my location</button>' : "";
    $("#weather").innerHTML = "<span>" + (text ? "🌤️ " + esc(text) : "Weather forecast not available for this date.") + "</span>" + btn;
  }

  /* ---------- AI stylist ---------- */
  function renderOccasions() {
    $("#occ-chips").innerHTML = OCCASIONS.map(function (o) {
      return '<button class="chip" data-occasion="' + esc(o) + '" aria-pressed="' + (o === state.occasion) + '">' + esc(o) + "</button>";
    }).join("");
  }

  function showErr(sel, msg) { var el = $(sel); el.textContent = msg; show(el, !!msg); }

  var lastSuggestions = [];
  function suggest() {
    showErr("#style-error", "");
    if (!CONFIG.apiUrl) return showErr("#style-error", "The AI stylist isn't connected yet. Set apiUrl in closet/config.js to your Cloudflare Worker address.");
    if (state.items.length < 2) return showErr("#style-error", "Add at least 2 items (e.g. a top and a bottom) to your closet first.");

    var date = $("#style-date").value || iso(new Date());
    var btn = $("#suggest-btn");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Styling you…';
    $("#suggestions").innerHTML = "";

    var payload = {
      items: state.items.slice(0, 60).map(function (i) {
        return { id: i.id, name: i.name, category: i.category, color: i.color, tags: i.tags, image: i.thumb };
      }),
      occasion: state.occasion,
      date: date,
      weather: weatherFor(date) || "",
      note: $("#style-note").value.trim()
    };

    fetch(CONFIG.apiUrl.replace(/\/$/, "") + "/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || "Something went wrong. Please try again.");
        return j;
      });
    }).then(function (j) {
      lastSuggestions = j.outfits || [];
      renderSuggestions(j, date);
    }).catch(function (e) {
      showErr("#style-error", e.message === "Failed to fetch" ? "Couldn't reach the stylist. Check your internet connection." : e.message);
    }).then(function () {
      btn.disabled = false;
      btn.textContent = "✨ Suggest outfits";
    });
  }

  function renderSuggestions(res, date) {
    var el = $("#suggestions");
    var html = "";
    if (!lastSuggestions.length) html += '<div class="notice">The stylist couldn\'t build an outfit from your closet for this occasion.</div>';
    html += lastSuggestions.map(function (o, idx) {
      var items = o.item_ids.map(itemById).filter(Boolean);
      return '<article class="card"><h3>' + esc(o.title) + "</h3>" + strip(items) +
        '<p style="margin:0 0 6px">' + esc(o.why) + "</p>" +
        (o.tip ? '<p class="muted" style="margin:0 0 12px;font-size:.92rem">💡 ' + esc(o.tip) + "</p>" : "") +
        '<div class="row"><button class="btn btn--sm" data-wear="' + idx + '" data-date="' + date + '">Wear on ' + esc(niceDate(date)) + '</button>' +
        '<button class="btn btn--sm btn--ghost" data-save-sugg="' + idx + '">Save outfit</button></div></article>';
    }).join("");
    if (res.missing) html += '<div class="notice">🛍️ <b>Would unlock more looks:</b> ' + esc(res.missing) + "</div>";
    el.innerHTML = html;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function suggestionToOutfit(idx) {
    var s = lastSuggestions[idx];
    if (!s) return null;
    if (s.savedId) return Promise.resolve(outfitById(s.savedId));
    var o = { id: uid(), title: s.title, itemIds: s.item_ids.slice(), why: s.why, occasion: state.occasion, source: "ai", created: Date.now() };
    s.savedId = o.id;
    return saveOutfit(o).then(function () { renderOutfits(); return o; });
  }

  /* ---------- wiring ---------- */
  function renderAll() { renderCloset(); renderOutfits(); renderCalendar(); }

  function toggle(btn) {
    var on = btn.getAttribute("aria-pressed") !== "true";
    btn.setAttribute("aria-pressed", String(on));
    return on;
  }

  document.addEventListener("click", function (e) {
    var t = e.target.closest("button, a, dialog");
    if (!t) return;
    var d = t.dataset;

    if (t.tagName === "DIALOG") { if (e.target === t) t.close(); return; }
    if (d.close !== undefined) { t.closest("dialog").close(); return; }
    if (d.view) { var dlg = t.closest("dialog"); if (dlg) dlg.close(); go(d.view); return; }
    if (d.action === "add-item" || t.id === "fab") return openAdd();
    if (d.action === "new-outfit") return openBuilder();
    if (d.filter) { state.filter = d.filter; return renderCloset(); }
    if (d.item) return openItem(d.item);
    if (d.deleteItem) return deleteItem(d.deleteItem);
    if (d.color) {
      document.querySelectorAll("#item-colors .sw").forEach(function (b) { b.setAttribute("aria-pressed", String(b === t)); });
      draft.color = d.color;
      return;
    }
    if (d.tag) {
      var on = toggle(t);
      draft.tags = draft.tags.filter(function (x) { return x !== d.tag; });
      if (on) draft.tags.push(d.tag);
      return;
    }
    if (d.pick) {
      picked = picked.filter(function (x) { return x !== d.pick; });
      if (toggle(t)) picked.push(d.pick);
      return;
    }
    if (d.plan) {
      var date = $('[data-plan-date="' + d.plan + '"]').value;
      if (!date) return;
      return planDay(date, d.plan).then(function () {
        state.calMonth = firstOfMonth(new Date(date + "T00:00"));
        renderCalendar();
        go("calendar");
      });
    }
    if (d.deleteOutfit) {
      if (!confirm("Delete this outfit?")) return;
      return removeOutfit(d.deleteOutfit).then(function () { renderOutfits(); renderCalendar(); });
    }
    if (d.day) return openDay(d.day);
    if (d.choose) return planDay(d.date, d.choose).then(function () { $("#d-day").close(); renderCalendar(); });
    if (d.unplan) {
      delete state.plans[d.unplan];
      return DB.del("plans", d.unplan).then(function () { $("#d-day").close(); renderCalendar(); });
    }
    if (d.styleFor) {
      $("#d-day").close();
      $("#style-date").value = d.styleFor;
      go("style");
      return;
    }
    if (d.occasion) { state.occasion = d.occasion; return renderOccasions(); }
    if (d.saveSugg !== undefined) {
      return suggestionToOutfit(+d.saveSugg).then(function () { t.textContent = "Saved ✓"; t.disabled = true; });
    }
    if (d.wear !== undefined) {
      var wd = d.date;
      return suggestionToOutfit(+d.wear).then(function (o) { return planDay(wd, o.id); }).then(function () {
        state.calMonth = firstOfMonth(new Date(wd + "T00:00"));
        renderCalendar();
        t.textContent = "Planned ✓";
        t.disabled = true;
      });
    }
    if (t.id === "suggest-btn") return suggest();
    if (t.id === "use-loc") {
      t.disabled = true;
      navigator.geolocation.getCurrentPosition(function (p) {
        state.coords = { lat: p.coords.latitude.toFixed(3), lon: p.coords.longitude.toFixed(3), name: "Your area" };
        loadWeather(true);
      }, function () { t.disabled = false; }, { timeout: 10000 });
      return;
    }
    if (t.id === "cal-prev" || t.id === "cal-next") {
      var m = state.calMonth;
      state.calMonth = new Date(m.getFullYear(), m.getMonth() + (t.id === "cal-next" ? 1 : -1), 1);
      return renderCalendar();
    }
  });

  $("#photo-input").addEventListener("change", function (e) { onPhoto(e.target.files[0]); e.target.value = ""; });
  $("#add-form").addEventListener("submit", saveItem);
  $("#outfit-form").addEventListener("submit", submitBuilder);
  $("#style-date").addEventListener("change", renderWeather);

  /* ---------- start ---------- */
  $("#style-date").value = iso(new Date());
  renderOccasions();
  Promise.all([DB.all("items"), DB.all("outfits"), DB.all("plans")]).then(function (r) {
    state.items = r[0].sort(function (a, b) { return b.created - a.created; });
    state.outfits = r[1].sort(function (a, b) { return b.created - a.created; });
    r[2].forEach(function (p) { state.plans[p.date] = p.outfitId; });
    renderAll();
    go(location.hash.slice(1));
  }).catch(function () {
    $("#closet-grid").innerHTML = '<div class="empty"><b>Storage unavailable</b>Your browser is blocking storage (private mode?). Open this page in a normal tab.</div>';
  });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () { navigator.serviceWorker.register("sw.js").catch(function () {}); });
  }
})();
