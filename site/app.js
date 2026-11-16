/* Flight price dashboard. Static: reads the JSON files the fetch workflow commits to data/. */
(() => {
  "use strict";

  const TZ = "Europe/Warsaw";
  const FETCH_CRONS_UTC = [[6, 0], [11, 0]]; // keep in sync with fetch-prices.yml (API) and scrape-prices.yml (scraper)
  const STALE_HOURS = 26;
  const PAGE_SIZE = 8;
  const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];
  const BAG_LABEL = { included: "Bag included", "fare-dependent": "Bag depends on fare", extra: "Bag costs extra", unknown: "Bag unknown" };
  const BAG_RANK = { included: 0, "fare-dependent": 1, unknown: 2, extra: 3 };

  const $ = (id) => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem("fcm:" + k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem("fcm:" + k, v); } catch { /* private mode */ } },
  };

  let base = null; // "" when deployed (data/ next to index.html), "../" when serving the repo root locally
  let index = null;
  let config = null;
  let usage = null;
  let bundle = null; // data for the selected route
  const state = {
    route: store.get("route"),
    returnDate: "all",
    origin: "all",
    bags: "any",
    view: "best",
    shown: PAGE_SIZE,
    source: ["all", "api", "scraper"].includes(store.get("source")) ? store.get("source") : "all",
    length: "any",
  };

  /* ---------- formatting ---------- */
  const nf = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 0 });
  const money = (v, cur = "PLN") => (v == null ? "–" : `${nf.format(v)} ${cur === "PLN" ? "zł" : cur}`);
  const kfmt = (v) => (v >= 10000 ? (v / 1000).toFixed(1).replace(/\.0$/, "") + "k" : nf.format(v));
  const dtFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const dayFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
  const shortDay = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "numeric", month: "short" });
  const fmtWhen = (iso) => dtFmt.format(new Date(iso));
  const fmtDate = (ymd) => dayFmt.format(new Date(ymd + "T00:00:00Z"));
  const fmtDateShort = (ymd) => fmtDate(ymd).replace(/^\w+ /, "");
  const hm = (s) => (s ? s.slice(11, 16) : "");
  const dur = (m) => (m == null ? "" : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  function ago(iso) {
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min ago`;
    const h = Math.round(mins / 60);
    if (h < 48) return `${h} h ago`;
    return `${Math.round(h / 24)} days ago`;
  }
  function plusDays(a, b) {
    if (!a || !b) return "";
    const d = (Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 86400000;
    return d > 0 ? `<sup>+${d}</sup>` : "";
  }
  const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  const ymdFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ });
  function fmtNext(d) {
    const today = ymdFmt.format(new Date());
    return (ymdFmt.format(d) === today ? "" : "tomorrow ") + timeFmt.format(d);
  }
  function nextCheck(now = new Date()) {
    const c = [];
    for (let add = 0; add < 2; add++) {
      for (const [h, m] of FETCH_CRONS_UTC) {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + add, h, m));
        if (d > now) c.push(d);
      }
    }
    return c.sort((a, b) => a - b)[0];
  }

  /* ---------- loading ---------- */
  async function getJSON(path, optional = false) {
    const res = await fetch(`${base}${path}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) {
      if (optional) return null;
      throw new Error(`${path}: HTTP ${res.status}`);
    }
    return res.json();
  }
  async function findBase() {
    for (const b of ["", "../"]) {
      try {
        const r = await fetch(`${b}data/index.json?t=${Date.now()}`, { cache: "no-store" });
        if (r.ok) return b;
      } catch { /* try next */ }
    }
    throw new Error("data/index.json not found");
  }

  async function loadAll() {
    $("refresh").classList.add("spin");
    try {
      if (base == null) base = await findBase();
      [index, config, usage] = await Promise.all([
        getJSON("data/index.json"),
        getJSON("config/routes.json", true).catch(() => null),
        getJSON("data/usage.json", true).catch(() => null),
      ]);
      const routes = index.routes || [];
      if (!routes.length) throw new Error("No routes in data/index.json yet.");
      if (!routes.some((r) => r.id === state.route)) state.route = routes[0].id;
      renderRoutePicker(routes);
      await loadRoute(state.route);
    } catch (err) {
      $("meta").textContent = "Could not load data.";
      $("alerts").innerHTML = `<div class="alert err"><b>Could not load the price data</b>${esc(err.message)}</div>`;
    } finally {
      $("refresh").classList.remove("spin");
    }
  }

  async function loadRoute(id) {
    const dir = `data/${encodeURIComponent(id)}/`;
    const [latest, history, scraped, scrapedHistory] = await Promise.all([
      getJSON(dir + "latest.json", true),
      getJSON(dir + "history.json", true),
      getJSON(dir + "scraped_latest.json", true).catch(() => null),
      getJSON(dir + "scraped_history.json", true).catch(() => null),
    ]);
    bundle = { id, latest, history, scraped, scrapedHistory, summary: index.routes.find((r) => r.id === id) };
    bundle.allOptions = buildOptions(bundle);
    bundle.timeline = buildTimeline(bundle);
    render();
  }

  /* ---------- data shaping ---------- */
  function routeInfo() {
    return bundle.latest?.route || (config?.routes || []).find((r) => r.id === bundle.id) || bundle.summary || {};
  }
  function paxCount() {
    if (bundle.latest?.passengers_total) return bundle.latest.passengers_total;
    const p = routeInfo().passengers;
    return p ? Object.values(p).reduce((a, b) => a + b, 0) : 1;
  }
  function currency() { return bundle.summary?.currency || "PLN"; }

  function gfSearchUrl(origin, dest, out, back) {
    const q = `Flights from ${origin} to ${dest} on ${out} through ${back}`;
    return `https://www.google.com/travel/flights?hl=en&curr=PLN&q=${encodeURIComponent(q)}`;
  }

  function buildOptions(b) {
    const pax = paxCount();
    const info = routeInfo();
    const out = [];
    for (const r of b.latest?.results || []) {
      for (const o of r.options || []) {
        const urlGroup = (r.google_flights_urls || []).find((g) => (g.origins || []).includes(o.origin)) || (r.google_flights_urls || [])[0];
        out.push({
          source: "api",
          fetchedAt: b.latest.fetched_at,
          returnDate: r.return_date,
          price: o.price,
          pp: o.price_per_person ?? Math.round(o.price / pax),
          origin: o.origin,
          originName: o.origin_name,
          destination: o.destination,
          dep: o.departure_time,
          arr: o.arrival_time,
          minutes: o.total_duration_minutes,
          minutesLabel: "total",
          stops: o.stops,
          via: (o.layovers || []).map((l) => l.airport),
          airlines: o.airlines || [],
          legs: o.legs || [],
          layovers: o.layovers || [],
          baggage: o.baggage || [],
          bag: o.baggage_flag || "unknown",
          longTrip: typeof o.long_trip === "boolean" ? o.long_trip : null,
          durationLabel: o.duration_label || null,
          ret: o.return_leg || null,
          url: urlGroup?.url || gfSearchUrl(o.origin, o.destination, info.outbound_date, r.return_date),
          exactLink: !!urlGroup,
        });
      }
    }
    for (const r of b.scraped?.results || []) {
      for (const o of r.options || []) {
        if (!o.price) continue;
        out.push({
          source: "scraper",
          fetchedAt: b.scraped.fetched_at,
          returnDate: r.return_date,
          price: o.price,
          pp: o.price_per_person ?? Math.round(o.price / pax),
          origin: o.origin,
          originName: null,
          destination: o.destination,
          dep: o.departure_time,
          arr: o.arrival_time,
          minutes: o.flying_minutes,
          minutesLabel: "in the air",
          stops: o.stops,
          via: o.via || [],
          airlines: o.airlines || [],
          legs: o.legs || [],
          layovers: [],
          baggage: o.baggage || [],
          bag: o.baggage_flag || "unknown",
          longTrip: typeof o.long_trip === "boolean" ? o.long_trip : null,
          durationLabel: o.duration_label || null,
          ret: null,
          url: gfSearchUrl(o.origin, o.destination, info.outbound_date, r.return_date),
          exactLink: false,
        });
      }
    }
    return out.sort((a, b) => a.price - b.price || BAG_RANK[a.bag] - BAG_RANK[b.bag]);
  }

  /* One point per check: the cheapest known price per return date, per source and combined. */
  function buildTimeline(b) {
    const rows = [];
    for (const e of b.history?.entries || []) rows.push({ ...e, source: "api" });
    for (const e of b.scrapedHistory?.entries || []) rows.push({ ...e, source: "scraper" });
    rows.sort((a, c) => a.fetched_at.localeCompare(c.fetched_at));
    const dates = [...new Set([...(routeInfo().return_dates || []), ...rows.map((r) => r.return_date)])].sort();
    const current = { api: {}, scraper: {} };
    const points = []; // {t, source, api:{rd:price}, scraper:{rd:price}, both:{rd:price}}
    let i = 0;
    while (i < rows.length) {
      const t = rows[i].fetched_at;
      const src = rows[i].source;
      const run = {};
      while (i < rows.length && rows[i].fetched_at === t && rows[i].source === src) {
        run[rows[i].return_date] = rows[i].min_price ?? null;
        i++;
      }
      // a run that failed for a date tells us nothing new; keep the last known price for "both"
      for (const [rd, p] of Object.entries(run)) if (p != null) current[src][rd] = p;
      const both = {};
      for (const rd of dates) {
        const vals = [current.api[rd], current.scraper[rd]].filter((v) => v != null);
        both[rd] = vals.length ? Math.min(...vals) : null;
      }
      points.push({ t, source: src, run, both });
    }
    return { dates, points };
  }

  function trendSeries(mode) {
    const { dates, points } = bundle.timeline;
    const pts = mode === "both" ? points : points.filter((p) => p.source === mode);
    return dates.map((rd, k) => ({
      key: rd,
      label: fmtDateShort(rd),
      color: SERIES[k % SERIES.length],
      values: pts.map((p) => ({ t: new Date(p.t).getTime(), iso: p.t, v: mode === "both" ? p.both[rd] : p.run[rd] ?? null })),
    }));
  }

  /* ---------- rendering ---------- */
  function renderRoutePicker(routes) {
    const sel = $("route-select");
    $("route-pick").hidden = routes.length < 2;
    sel.innerHTML = routes.map((r) => `<option value="${esc(r.id)}">${esc(r.name || r.id)}</option>`).join("");
    sel.value = state.route;
  }

  const trendMode = () => (state.source === "all" ? "both" : state.source);
  const SOURCE_NAME = { all: "Everything", api: "API only", scraper: "Scraper only" };

  function render() {
    // the page-wide source switch: every section below works on bundle.options
    bundle.options = bundle.allOptions.filter((o) => state.source === "all" || o.source === state.source);
    renderSourceSwitch();
    const info = routeInfo();
    $("route-name").textContent = info.name || bundle.id;
    document.title = `Flight prices · ${info.name || bundle.id}`;
    const updated = [bundle.latest?.fetched_at, bundle.scraped?.fetched_at].filter(Boolean).sort().pop();
    const nc = nextCheck();
    $("meta").innerHTML = updated
      ? `Updated ${esc(ago(updated))} (${esc(fmtWhen(updated))}) · next check about ${esc(fmtNext(nc))}`
      : "No price check has run yet.";
    renderAlerts(updated);
    renderHero();
    renderMatrix();
    renderFilters();
    renderOptions();
    renderTrend();
    renderInfo();
  }

  function renderSourceSwitch() {
    const n = (src) => bundle.allOptions.filter((o) => src === "all" || o.source === src).length;
    $("source-switch").innerHTML = [["all", "Everything"], ["api", "API"], ["scraper", "Scraper"]].map(([v, t]) =>
      `<button type="button" data-s="${v}" aria-pressed="${state.source === v}">${t} <span class="n">${n(v)}</span></button>`).join("");
  }

  function renderAlerts(updated) {
    const a = [];
    if (updated && Date.now() - new Date(updated).getTime() > STALE_HOURS * 3600e3) {
      a.push(`<div class="alert warn"><b>Data is ${esc(ago(updated).replace(" ago", ""))} old</b>The scheduled check may have failed. See the Actions tab in GitHub.</div>`);
    }
    for (const r of bundle.latest?.results || []) {
      if (r.error) a.push(`<div class="alert err"><b>API search for return ${esc(fmtDate(r.return_date))} failed</b>${esc(r.error)}</div>`);
      for (const e of r.partial_errors || []) a.push(`<div class="alert warn"><b>Partial error, return ${esc(fmtDate(r.return_date))}</b>${esc(typeof e === "string" ? e : JSON.stringify(e))}</div>`);
    }
    const scrapeErrs = (bundle.scraped?.results || []).reduce((n, r) => n + (r.errors || []).length, 0);
    if (scrapeErrs) {
      a.push(`<div class="alert warn"><b>Scraper: ${scrapeErrs} of its searches failed</b>Google may have blocked some requests. API prices are unaffected.</div>`);
    }
    $("alerts").innerHTML = a.join("");
  }

  // Trips above this per-direction duration still show, but get a "longer trip" label.
  function preferredMinutes() {
    const r = routeInfo();
    return r.preferred_max_duration_minutes || r.long_trip_minutes || 960;
  }
  function longestMinutes(o) {
    return Math.max(o.minutes || 0, o.ret?.total_duration_minutes || 0);
  }
  // The fetcher sets long_trip / duration_label on each option; older snapshots fall back to minutes.
  function isLong(o) { return o.longTrip ?? longestMinutes(o) > preferredMinutes(); }

  function badges(o, withSource = true) {
    const bagNote = o.baggage.map((x) => `${x.airline}: ${x.note}`).join(" · ");
    return [
      `<span class="badge bag ${esc(o.bag)}" title="${esc(bagNote)}">${esc(BAG_LABEL[o.bag] || o.bag)}</span>`,
      `<span class="badge">${o.stops === 0 ? "Direct" : o.stops === 1 ? `1 stop${o.via.length ? " · " + esc(o.via.join(", ")) : ""}` : `${o.stops} stops`}</span>`,
      isLong(o) ? `<span class="badge long" title="${esc(o.durationLabel || `Longer than the preferred ${Math.round(preferredMinutes() / 60)} h per direction`)}">${o.durationLabel ? esc(o.durationLabel) : `Longer trip · ${dur(longestMinutes(o))}`}</span>` : "",
      withSource ? `<span class="badge src-${o.source}">${o.source === "api" ? "API" : "Scraper"}</span>` : "",
    ].join("");
  }

  function renderHero() {
    const cur = currency();
    const best = bundle.options[0];
    const bestBag = bundle.options.find((o) => o.bag === "included");
    const trend = trendSeries(trendMode());
    const series = (trend[0]?.values || []).map((_, k) => {
      const v = trend.map((s) => s.values[k].v).filter((x) => x != null);
      return v.length ? Math.min(...v) : null;
    }).filter((v) => v != null);
    const allTime = series.length ? Math.min(...series, best?.price ?? Infinity) : best?.price;
    let delta = null;
    if (series.length >= 2) {
      const last = series[series.length - 1];
      let prev = null;
      for (let k = series.length - 2; k >= 0; k--) if (series[k] !== last) { prev = series[k]; break; }
      delta = prev == null ? 0 : last - prev;
    }
    if (!best) {
      const msg = state.source === "scraper"
        ? "No scraper results yet. The scraper adds Emirates, Etihad and Qatar prices once it is switched on and has run."
        : "No options in the latest check.";
      $("hero").innerHTML = `<div class="hero-main"><div class="hero-label">Cheapest right now${state.source === "all" ? "" : " · " + esc(SOURCE_NAME[state.source])}</div><div class="hero-price">–</div><div class="hero-pp">${esc(msg)}</div></div>`;
      return;
    }
    const deltaHtml = delta == null ? "–"
      : delta === 0 ? "No change"
      : `<span class="${delta < 0 ? "delta-down" : "delta-up"}">${delta < 0 ? "▼" : "▲"} ${money(Math.abs(delta), cur)}</span>`;
    $("hero").innerHTML = `
      <div class="hero-main">
        <div class="hero-label">Cheapest right now${state.source === "all" ? "" : " · " + esc(SOURCE_NAME[state.source])} · ${paxCount()} passengers, round trip</div>
        <div class="hero-price">${money(best.price, cur)}</div>
        <div class="hero-pp">${money(best.pp, cur)} per person</div>
        <div class="hero-what"><b>${esc(best.airlines.join(" + "))}</b> · ${esc(best.origin)} → ${esc(best.destination)} · back ${esc(fmtDate(best.returnDate))}</div>
        <div class="hero-what">${badges(best)}</div>
      </div>
      <div class="hero-side">
        <div class="stat"><div class="hero-label">Since last change</div><div class="v">${deltaHtml}</div><div class="s">cheapest overall</div></div>
        <div class="stat"><div class="hero-label">Lowest seen</div><div class="v">${money(allTime, cur)}</div><div class="s">since tracking began</div></div>
        <div class="stat" style="grid-column: span 2"><div class="hero-label">Cheapest with bag included</div>
          <div class="v">${bestBag ? money(bestBag.price, cur) : "–"}</div>
          <div class="s">${bestBag ? `${esc(bestBag.airlines.join(" + "))} · ${esc(bestBag.origin)} · back ${esc(fmtDateShort(bestBag.returnDate))} · ${money(bestBag.pp, cur)} pp` : "None in the latest check"}</div></div>
      </div>`;
  }

  function renderMatrix() {
    const info = routeInfo();
    const cur = currency();
    const dates = [...new Set([...(info.return_dates || []), ...bundle.options.map((o) => o.returnDate)])].sort();
    const origins = [...new Set([...(info.origins || []), ...bundle.options.map((o) => o.origin)])];
    const names = Object.fromEntries(bundle.options.filter((o) => o.originName).map((o) => [o.origin, o.originName]));
    const cell = {};
    for (const o of bundle.options) {
      const k = o.origin + "|" + o.returnDate;
      if (!cell[k] || o.price < cell[k].price) cell[k] = o;
    }
    const min = bundle.options[0]?.price;
    const head = `<thead><tr><th>From</th>${dates.map((d) => `<th>Back ${esc(fmtDate(d))}</th>`).join("")}</tr></thead>`;
    const body = origins.map((org) => `<tr><td class="ap">${esc(org)}${names[org] ? `<small>${esc(names[org].replace(/ (International )?Airport$/, ""))}</small>` : ""}</td>${dates.map((d) => {
      const o = cell[org + "|" + d];
      if (!o) return `<td class="none">–</td>`;
      const active = state.origin === org && state.returnDate === d;
      return `<td class="${o.price === min ? "best" : ""}"><button type="button" data-o="${esc(org)}" data-d="${esc(d)}" class="${active ? "active" : ""}" aria-label="${esc(org)}, back ${esc(fmtDate(d))}: ${money(o.price, cur)}">${money(o.price, cur)}<span class="sub">${esc(o.airlines.join(" + "))}</span></button></td>`;
    }).join("")}</tr>`).join("");
    $("matrix").innerHTML = head + `<tbody>${body}</tbody>`;
  }

  function chipRow(label, key, items) {
    return `<div class="chips" role="group" aria-label="${esc(label)}"><span class="chip-label">${esc(label)}</span>${items.map(([v, t]) =>
      `<button type="button" class="chip" data-k="${key}" data-v="${esc(v)}" aria-pressed="${state[key] === v}">${esc(t)}</button>`).join("")}</div>`;
  }

  function renderFilters() {
    const info = routeInfo();
    const dates = [...new Set([...(info.return_dates || []), ...bundle.options.map((o) => o.returnDate)])].sort();
    const origins = [...new Set([...(info.origins || []), ...bundle.options.map((o) => o.origin)])];
    $("filters").innerHTML = [
      chipRow("Back", "returnDate", [["all", "Any day"], ...dates.map((d) => [d, fmtDate(d)])]),
      chipRow("From", "origin", [["all", "Any airport"], ...origins.map((o) => [o, o])]),
      chipRow("Bags", "bags", [["any", "Any"], ["included", "Included only"], ["ok", "Included or by fare"]]),
      bundle.options.some(isLong) ? chipRow("Length", "length", [["any", "Any"], ["short", `Up to ${Math.round(preferredMinutes() / 60)} h`]]) : "",
      chipRow("Show", "view", [["best", "Cheapest per airline"], ["all", "Every option"]]),
    ].join("");
  }

  function filteredOptions() {
    let list = bundle.options.filter((o) =>
      (state.returnDate === "all" || o.returnDate === state.returnDate) &&
      (state.origin === "all" || o.origin === state.origin) &&
      (state.length === "any" || !isLong(o)) &&
      (state.bags === "any" || (state.bags === "included" ? o.bag === "included" : o.bag === "included" || o.bag === "fare-dependent")));
    if (state.view === "best") {
      const seen = new Set();
      list = list.filter((o) => {
        const k = `${o.returnDate}|${o.origin}|${o.airlines.join("+")}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    return list;
  }

  function legsHtml(title, legs, layovers) {
    if (!legs?.length) return "";
    const lay = Object.fromEntries((layovers || []).map((l) => [l.airport, l]));
    return `<li class="dir">${esc(title)}</li>` + legs.map((l, k) => {
      const row = `<li>${esc(l.from)} ${esc(hm(l.departure_time))} → ${esc(l.to)} ${esc(hm(l.arrival_time))}${plusDays(l.departure_time, l.arrival_time)} · ${esc([l.flight_number || l.airline, l.airplane].filter(Boolean).join(" · "))}${l.duration_minutes ? " · " + dur(l.duration_minutes) : ""}</li>`;
      const lo = k < legs.length - 1 ? lay[l.to] : null;
      return row + (lo ? `<li class="lay">Layover in ${esc(lo.name || lo.airport)}: ${dur(lo.duration_minutes)}${lo.overnight ? " (overnight)" : ""}</li>` : "");
    }).join("");
  }

  function renderOptions() {
    const cur = currency();
    const info = routeInfo();
    const list = filteredOptions();
    $("options-count").textContent = `${list.length} ${list.length === 1 ? "option" : "options"}`;
    if (!list.length) {
      $("options").innerHTML = `<li class="empty">Nothing matches these filters.</li>`;
      $("more").hidden = true;
      return;
    }
    const minPrice = bundle.options[0]?.price;
    $("options").innerHTML = list.slice(0, state.shown).map((o) => {
      const ret = o.ret;
      const bagNotes = o.baggage.map((x) => `${esc(x.airline)}: ${esc(x.note)}`).join("<br>");
      return `<li class="opt ${o.price === minPrice ? "top" : ""}">
        <div class="opt-head">
          <div>
            <div class="opt-air">${esc(o.airlines.join(" + "))}</div>
            <div class="opt-route">${esc(o.origin)} ${esc(hm(o.dep))} → ${esc(o.destination)} ${esc(hm(o.arr))}${plusDays(o.dep, o.arr)} · ${esc(fmtDateShort(info.outbound_date || o.dep?.slice(0, 10) || ""))}${o.minutes ? ` · ${dur(o.minutes)} ${o.minutesLabel}` : ""}</div>
            <div class="opt-route">Back ${esc(fmtDate(o.returnDate))}${ret ? ` · ${esc(ret.origin)} ${esc(hm(ret.departure_time))} → ${esc(ret.destination)} ${esc(hm(ret.arrival_time))}${plusDays(ret.departure_time, ret.arrival_time)} · ${dur(ret.total_duration_minutes)}` : ""}</div>
          </div>
          <div class="opt-price"><div class="t">${money(o.price, cur)}</div><div class="p">${money(o.pp, cur)} pp</div></div>
        </div>
        <div class="opt-badges">${badges(o)}</div>
        <details><summary>Flights and bags</summary>
          <ul class="legs">${legsHtml("Outbound", o.legs, o.layovers)}${ret ? legsHtml("Return", ret.legs, ret.layovers) : `<li class="lay">Return flight details were not fetched for this option.</li>`}</ul>
          <div class="opt-note">${bagNotes}</div>
        </details>
        <div class="opt-links"><a href="${esc(o.url)}" target="_blank" rel="noopener">${o.exactLink ? "Open this search in Google Flights" : "Search in Google Flights"}</a></div>
      </li>`;
    }).join("");
    $("more").hidden = list.length <= state.shown;
    $("more").textContent = `Show more (${list.length - state.shown} left)`;
  }

  /* ---------- trend chart ---------- */
  function renderTrend() {
    const mode = trendMode();
    $("trend-hint").textContent = mode === "both"
      ? "Cheapest round trip per return date at each check, best of API and scraper."
      : `Cheapest round trip per return date at each ${mode === "api" ? "API" : "scraper"} check.`;
    const series = trendSeries(mode);
    $("trend-legend").innerHTML = series.length > 1
      ? series.map((s) => `<span><i style="background:${s.color}"></i>Back ${esc(s.label)}</span>`).join("")
      : "";
    drawChart(series);
    renderHistoryTable(series);
  }

  function niceTicks(lo, hi, n = 4) {
    const span = hi - lo || 1;
    const step0 = span / n;
    const mag = 10 ** Math.floor(Math.log10(step0));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0);
    const start = Math.floor(lo / step) * step;
    const ticks = [];
    for (let v = start; v <= hi + step * 0.5; v += step) ticks.push(v);
    return ticks;
  }

  let chartGeom = null;
  function drawChart(series) {
    const el = $("chart");
    const W = Math.max(280, el.clientWidth || 600);
    const H = W < 500 ? 220 : 260;
    const m = { l: 44, r: 48, t: 10, b: 26 };
    const all = series.flatMap((s) => s.values.filter((v) => v.v != null));
    if (!all.length) {
      el.innerHTML = `<svg viewBox="0 0 ${W} 80" role="img" aria-label="No price history yet"><text class="empty-msg" x="${W / 2}" y="44" text-anchor="middle">No price history yet</text></svg>`;
      chartGeom = null;
      return;
    }
    const times = [...new Set(series.flatMap((s) => s.values.map((v) => v.t)))].sort((a, b) => a - b);
    let t0 = times[0], t1 = times[times.length - 1];
    if (t0 === t1) { t0 -= 6 * 3600e3; t1 += 6 * 3600e3; }
    const vals = all.map((v) => v.v);
    const ticks = niceTicks(Math.min(...vals) * 0.98, Math.max(...vals) * 1.02);
    const y0 = ticks[0], y1 = ticks[ticks.length - 1];
    const x = (t) => m.l + ((t - t0) / (t1 - t0)) * (W - m.l - m.r);
    const y = (v) => m.t + (1 - (v - y0) / (y1 - y0 || 1)) * (H - m.t - m.b);

    // x ticks: day boundaries in Warsaw time, thinned to fit
    const dayMs = 86400e3;
    const span = t1 - t0;
    const maxTicks = Math.max(2, Math.floor((W - m.l - m.r) / 70));
    const stepDays = Math.max(1, Math.ceil(span / dayMs / maxTicks));
    const xticks = [];
    const startDay = new Date(t0); startDay.setUTCHours(0, 0, 0, 0);
    for (let t = startDay.getTime(); t <= t1; t += stepDays * dayMs) if (t >= t0) xticks.push(t);
    if (!xticks.length) xticks.push(times[0]);

    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Price trend chart; the same data is in the table below">`;
    svg += `<g class="grid">${ticks.map((v) => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`).join("")}</g>`;
    svg += `<g class="axis">${ticks.map((v) => `<text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${kfmt(v)}</text>`).join("")}`;
    svg += xticks.map((t) => `<text x="${x(t)}" y="${H - 6}" text-anchor="middle">${esc(shortDay.format(new Date(t)))}</text>`).join("") + `</g>`;

    const ends = [];
    for (const s of series) {
      const segs = [];
      let cur = [];
      for (const p of s.values) {
        if (p.v == null) { if (cur.length) segs.push(cur); cur = []; } else cur.push(p);
      }
      if (cur.length) segs.push(cur);
      for (const seg of segs) {
        svg += `<path class="line" stroke="${s.color}" d="${seg.map((p, k) => `${k ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("")}"/>`;
      }
      const pts = s.values.filter((p) => p.v != null);
      const showDots = pts.length <= 40;
      for (const p of showDots ? pts : pts.slice(-1)) {
        svg += `<circle class="dot" cx="${x(p.t)}" cy="${y(p.v)}" r="4" fill="${s.color}"/>`;
      }
      const last = pts[pts.length - 1];
      if (last) ends.push({ y: y(last.v), x: x(last.t), text: s.label });
    }
    // direct end labels, nudged apart so they never overlap
    ends.sort((a, b) => a.y - b.y);
    for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 13) ends[k].y = ends[k - 1].y + 13;
    if (series.length > 1) svg += ends.map((e) => `<text class="end-label" x="${e.x + 8}" y="${e.y + 4}">${esc(e.text)}</text>`).join("");
    svg += `<line class="xhair" id="xhair" y1="${m.t}" y2="${H - m.b}" x1="-10" x2="-10" visibility="hidden"/>`;
    svg += `<rect id="hit" x="${m.l}" y="0" width="${W - m.l - m.r}" height="${H}" fill="transparent"/>`;
    svg += `</svg>`;
    el.innerHTML = svg;
    chartGeom = { series, times, x, W, H, m };
  }

  function chartHover(ev) {
    if (!chartGeom) return;
    const svg = $("chart").querySelector("svg");
    const rect = svg.getBoundingClientRect();
    const scale = chartGeom.W / rect.width;
    const px = (ev.clientX - rect.left) * scale;
    let best = chartGeom.times[0];
    for (const t of chartGeom.times) if (Math.abs(chartGeom.x(t) - px) < Math.abs(chartGeom.x(best) - px)) best = t;
    const xh = $("xhair");
    xh.setAttribute("x1", chartGeom.x(best));
    xh.setAttribute("x2", chartGeom.x(best));
    xh.setAttribute("visibility", "visible");
    const cur = currency();
    const rows = chartGeom.series.map((s) => {
      const p = s.values.find((v) => v.t === best);
      return `<div class="tt-r"><span><i style="background:${s.color}"></i>Back ${esc(s.label)}</span><b>${p && p.v != null ? money(p.v, cur) : "–"}</b></div>`;
    }).join("");
    const tt = $("tooltip");
    tt.innerHTML = `<div class="tt-h">${esc(fmtWhen(new Date(best).toISOString()))}</div>${rows}`;
    tt.hidden = false;
    const ttW = tt.offsetWidth, ttH = tt.offsetHeight;
    const sx = rect.left + chartGeom.x(best) / scale;
    let left = sx + 12;
    if (left + ttW > window.innerWidth - 8) left = sx - ttW - 12;
    tt.style.left = Math.max(8, left) + "px";
    tt.style.top = Math.max(8, rect.top + 8) + "px";
    if (ttH + rect.top + 8 > window.innerHeight) tt.style.top = window.innerHeight - ttH - 8 + "px";
  }
  function chartLeave() {
    $("tooltip").hidden = true;
    const xh = $("xhair");
    if (xh) xh.setAttribute("visibility", "hidden");
  }

  function renderHistoryTable(series) {
    const cur = currency();
    const times = [...new Set(series.flatMap((s) => s.values.map((v) => v.t)))].sort((a, b) => b - a);
    $("history-table").innerHTML = `<thead><tr><th>Checked</th>${series.map((s) => `<th>Back ${esc(s.label)}</th>`).join("")}</tr></thead><tbody>${
      times.map((t) => `<tr><td>${esc(fmtWhen(new Date(t).toISOString()))}</td>${series.map((s) => {
        const p = s.values.find((v) => v.t === t);
        return `<td>${p && p.v != null ? money(p.v, cur) : "–"}</td>`;
      }).join("")}</tr>`).join("")}</tbody>`;
  }

  function renderInfo() {
    const r = routeInfo();
    const scr = (config?.routes || []).find((x) => x.id === bundle.id)?.scraper;
    const settings = config?.settings || {};
    const month = new Date().toISOString().slice(0, 7);
    const used = usage?.[month];
    const rows = [
      ["Out", r.outbound_date ? fmtDate(r.outbound_date) : "–"],
      ["Back", (r.return_dates || []).map(fmtDate).join(", ") || "–"],
      ["From", (r.origins || []).join(", ")],
      ["To", (r.destinations || []).join(", ")],
      ["Passengers", r.passenger_note || `${paxCount()}`],
      ["Limits", [r.max_stops != null ? `max ${r.max_stops} stop${r.max_stops === 1 ? "" : "s"}` : "", r.max_duration_minutes ? `max ${Math.round(r.max_duration_minutes / 60)} h per direction` : "", r.travel_class || ""].filter(Boolean).join(" · ")],
      ["Airlines", r.include_airlines_note || (r.include_airlines || []).join(", ") || "Any"],
      scr?.enabled ? ["Scraper", `${(scr.airlines || []).join(", ")} to ${scr.destination || (r.destinations || [])[0]}`] : null,
      used != null ? ["API quota", `${used} searches used this month${settings.monthly_search_budget ? ` of ${settings.monthly_search_budget}` : ""}`] : null,
    ].filter(Boolean);
    $("search-info").innerHTML = `<h2>Search settings</h2><dl class="info-grid">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
  }

  /* ---------- events ---------- */
  $("refresh").addEventListener("click", () => loadAll());
  $("route-select").addEventListener("change", (e) => {
    state.route = e.target.value;
    store.set("route", state.route);
    Object.assign(state, { returnDate: "all", origin: "all", shown: PAGE_SIZE });
    loadRoute(state.route);
  });
  $("filters").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-k]");
    if (!b) return;
    state[b.dataset.k] = b.dataset.v;
    state.shown = PAGE_SIZE;
    renderFilters();
    renderOptions();
    renderMatrix();
  });
  $("matrix").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-o]");
    if (!b) return;
    const same = state.origin === b.dataset.o && state.returnDate === b.dataset.d;
    state.origin = same ? "all" : b.dataset.o;
    state.returnDate = same ? "all" : b.dataset.d;
    state.shown = PAGE_SIZE;
    renderMatrix();
    renderFilters();
    renderOptions();
    if (!same) $("options-card").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("more").addEventListener("click", () => { state.shown += PAGE_SIZE; renderOptions(); });
  $("source-switch").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-s]");
    if (!b || b.dataset.s === state.source) return;
    state.source = b.dataset.s;
    store.set("source", state.source);
    Object.assign(state, { returnDate: "all", origin: "all", shown: PAGE_SIZE });
    render();
  });
  const chart = $("chart");
  chart.addEventListener("pointermove", chartHover);
  chart.addEventListener("pointerdown", chartHover);
  chart.addEventListener("pointerleave", chartLeave);
  document.addEventListener("scroll", chartLeave, { passive: true });
  let rz;
  window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => bundle && renderTrend(), 150); });
  document.addEventListener("visibilitychange", () => {
    // coming back to the tab after a while: pick up a newer check
    if (document.visibilityState === "visible" && bundle?.latest && Date.now() - new Date(bundle.latest.fetched_at).getTime() > 6 * 3600e3) loadAll();
  });

  loadAll();
})();
