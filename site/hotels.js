/* Bangkok hotel price dashboard. Static: reads data/hotels/*.json and config/hotels.json. */
(() => {
  "use strict";

  const TZ = "Europe/Warsaw";
  const FETCH_CRON_UTC = [8, 0]; // keep in sync with .github/workflows/fetch-hotels.yml
  const STALE_HOURS = 26;
  const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];

  const $ = (id) => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem("fcm:hotels:" + k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem("fcm:hotels:" + k, v); } catch { /* private mode */ } },
  };

  let base = null;
  let latest = null;
  let history = null;
  let config = null;
  const state = {
    stay: store.get("stay") === "last" ? "last" : "first",
    pick: {}, // stay id -> { date, nights }
    sort: store.get("sort") === "rating" ? "rating" : "price",
  };
  try { Object.assign(state.pick, JSON.parse(store.get("pick") || "{}")); } catch { /* ignore */ }

  /* ---------- formatting ---------- */
  const nf = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 0 });
  const kfmt = (v) => (v >= 10000 ? (v / 1000).toFixed(1).replace(/\.0$/, "") + "k" : nf.format(v));
  const dtFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const dayFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
  const shortDay = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "numeric", month: "short" });
  const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  const fmtWhen = (iso) => dtFmt.format(new Date(iso));
  const fmtDate = (ymd) => dayFmt.format(new Date(ymd + "T00:00:00Z"));
  const fmtDateShort = (ymd) => fmtDate(ymd).replace(/^\w+ /, "");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  function ago(iso) {
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min ago`;
    const h = Math.round(mins / 60);
    if (h < 48) return `${h} h ago`;
    return `${Math.round(h / 24)} days ago`;
  }
  function nextCheck(now = new Date()) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), ...FETCH_CRON_UTC));
    if (d <= now) d.setUTCDate(d.getUTCDate() + 1);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(now);
    return (new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d) === today ? "" : "tomorrow ") + timeFmt.format(d);
  }

  // Prices are stored in the fetch currency (EUR); shown in PLN when the run had an NBP rate.
  const fx = () => latest?.pln_rate || null;
  const cur = () => (fx() ? "PLN" : latest?.currency || "EUR");
  const conv = (eur, rate = fx()) => (eur == null ? null : rate ? Math.round(eur * rate) : eur);
  const money = (v) => (v == null ? "–" : `${nf.format(v)} ${cur() === "PLN" ? "zł" : cur() === "EUR" ? "€" : cur()}`);
  const eur = (v) => (v == null || !fx() ? "" : `${nf.format(v)} €`);

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
        const r = await fetch(`${b}config/hotels.json?t=${Date.now()}`, { cache: "no-store" });
        if (r.ok) return b;
      } catch { /* try next */ }
    }
    throw new Error("config/hotels.json not found");
  }

  async function loadAll() {
    $("refresh").classList.add("spin");
    try {
      if (base == null) base = await findBase();
      [config, latest, history] = await Promise.all([
        getJSON("config/hotels.json"),
        getJSON("data/hotels/latest.json", true),
        getJSON("data/hotels/history.json", true),
      ]);
      render();
    } catch (err) {
      $("meta").textContent = "Could not load data.";
      $("alerts").innerHTML = `<div class="alert err"><b>Could not load the hotel data</b>${esc(err.message)}</div>`;
    } finally {
      $("refresh").classList.remove("spin");
    }
  }

  /* ---------- model ---------- */
  const stayCfg = () => config.stays.find((s) => s.id === state.stay) || config.stays[0];
  const byCheckout = (s = stayCfg()) => !!s.checkout_dates;
  const stayDates = (s = stayCfg()) => s.checkout_dates || s.checkin_dates || [];
  function hotelInfo(id) {
    const cfg = config.hotels.find((h) => h.id === id) || { id, name: id };
    const live = (latest?.hotels || []).find((h) => h.id === id) || {};
    return { ...cfg, ...Object.fromEntries(Object.entries(live).filter(([, v]) => v != null)) };
  }
  function pick() {
    const s = stayCfg();
    const p = state.pick[s.id];
    const valid = (x) => x && stayDates(s).includes(x.date) && s.nights.includes(Number(x.nights));
    if (valid(p)) return { date: p.date, nights: Number(p.nights) };
    if (valid(s.default)) return { ...s.default };
    return { date: stayDates(s)[0], nights: s.nights[0] };
  }
  function datesOf(date, nights, s = stayCfg()) {
    const d = new Date(date + "T00:00:00Z");
    const other = new Date(d.getTime() + (byCheckout(s) ? -nights : nights) * 86400e3).toISOString().slice(0, 10);
    return byCheckout(s) ? { chkIn: other, chkOut: date } : { chkIn: date, chkOut: other };
  }
  const quotesFor = (date, nights) => (latest?.quotes || []).filter((q) =>
    q.stay === state.stay && q.date === date && q.nights === nights);
  const priced = (qs) => qs.filter((q) => q.total != null).sort((a, b) => a.total - b.total);

  function bookingUrl(h, chkIn, chkOut) {
    const g = latest?.guests || { adults: 2, children_ages: [12], rooms: 1 };
    const p = new URLSearchParams({ ss: `${h.name}, Bangkok`, checkin: chkIn, checkout: chkOut,
      group_adults: g.adults, group_children: (g.children_ages || []).length, no_rooms: g.rooms || 1,
      selected_currency: cur() === "PLN" ? "PLN" : "EUR", lang: "en-gb" });
    for (const a of g.children_ages || []) p.append("age", a);
    return `https://www.booking.com/searchresults.html?${p}`;
  }
  const googleUrl = (h) => `https://www.google.com/travel/search?${new URLSearchParams({ q: `${h.name} Bangkok`, hl: "en", gl: "pl", curr: cur() })}`;
  const taUrl = (h) => (h.tripadvisor_url && /^https:\/\//.test(h.tripadvisor_url) ? h.tripadvisor_url
    : h.tripadvisor_url ? `https://www.tripadvisor.com${h.tripadvisor_url.startsWith("/") ? "" : "/"}${h.tripadvisor_url}` : null);

  /* ---------- render ---------- */
  function render() {
    const g = config.settings || {};
    $("guests").textContent = `${g.adults || 2} adults + ${(g.children_ages || []).length ? `child aged ${(g.children_ages || []).join(", ")}` : "no children"} · ${g.rooms || 1} room · 5-star, outdoor pool, high-rise, next to BTS/MRT`;
    const updated = latest?.fetched_at;
    $("meta").innerHTML = updated
      ? `Updated ${esc(ago(updated))} (${esc(fmtWhen(updated))}) · next check about ${esc(nextCheck())}`
      : "No price check has run yet.";
    renderStaySwitch();
    renderAlerts(updated);
    renderHero();
    renderMatrix();
    renderHotels();
    renderTrend();
    renderInfo();
  }

  function stayLabel(s) {
    const d = stayDates(s);
    const span = d.length > 1 ? `${fmtDateShort(d[0]).replace(/ \w+$/, "")}–${fmtDateShort(d[d.length - 1])}` : fmtDateShort(d[0]);
    return s.checkout_dates ? `Last stay · out ${span}` : `First stay · in ${span}`; // e.g. "First stay · in 18–22 Jan"
  }
  function renderStaySwitch() {
    $("stay-switch").innerHTML = config.stays.map((s) =>
      `<button type="button" data-s="${esc(s.id)}" aria-pressed="${state.stay === s.id}">${esc(stayLabel(s))}</button>`).join("");
  }

  function renderAlerts(updated) {
    const a = [];
    if (!latest) {
      a.push(`<div class="alert warn"><b>No hotel prices yet</b>They appear after the first "Fetch hotel prices" run (daily at 09:00, or start it from the Actions tab).</div>`);
    } else if (Date.now() - new Date(updated).getTime() > STALE_HOURS * 3600e3) {
      a.push(`<div class="alert warn"><b>Data is ${esc(ago(updated).replace(" ago", ""))} old</b>The scheduled check may have failed. See the Actions tab in GitHub.</div>`);
    }
    for (const e of latest?.errors || []) a.push(`<div class="alert warn"><b>Problem in the last check</b>${esc(e)}</div>`);
    const failed = (latest?.quotes || []).filter((q) => q.error).length;
    if (failed) a.push(`<div class="alert warn"><b>${failed} of ${(latest.quotes || []).length} price requests failed</b>Those hotels and dates show as unavailable until the next check.</div>`);
    $("alerts").innerHTML = a.join("");
  }

  function lowestSeen(hotelId, chkIn, nights) {
    let best = null;
    for (const e of history?.entries || []) {
      for (const [k, v] of Object.entries(e.prices || {})) {
        const [h, s, ci, n] = k.split("|");
        if (s !== state.stay || ci !== chkIn || Number(n) !== nights || (hotelId && h !== hotelId)) continue;
        const pln = conv(v, e.pln_rate || fx());
        if (best == null || pln < best) best = pln;
      }
    }
    return best;
  }
  function previousBest(chkIn, nights) {
    // cheapest across hotels at the previous check, to show the change since then
    const entries = history?.entries || [];
    if (entries.length < 2) return null;
    const e = entries[entries.length - 2];
    const vals = Object.entries(e.prices || {}).filter(([k]) => {
      const [, s, ci, n] = k.split("|");
      return s === state.stay && ci === chkIn && Number(n) === nights;
    }).map(([, v]) => conv(v, e.pln_rate || fx()));
    return vals.length ? Math.min(...vals) : null;
  }

  function hotelBadges(h) {
    return [
      h.rating != null ? `<span class="badge rating" title="Tripadvisor">★ ${esc(h.rating)}${h.reviews ? ` · ${nf.format(h.reviews)} reviews` : ""}</span>` : "",
      h.station ? `<span class="badge transit" title="${esc(h.station_note || "")}">${esc(h.station)}${h.station_note ? ` · ${esc(h.station_note)}` : ""}</span>` : "",
      h.pool ? `<span class="badge">${esc(h.pool)}</span>` : "",
      h.building ? `<span class="badge">${esc(h.building)}</span>` : "",
      h.family_note ? `<span class="badge flex">${esc(h.family_note)}</span>` : "",
    ].join("");
  }

  function renderHero() {
    const s = stayCfg();
    const p = pick();
    const { chkIn, chkOut } = datesOf(p.date, p.nights);
    const list = priced(quotesFor(p.date, p.nights));
    const best = list[0];
    const head = `${esc(s.name || s.id)} · ${esc(fmtDate(chkIn))} → ${esc(fmtDate(chkOut))} · ${p.nights} nights`;
    if (!best) {
      $("hero").innerHTML = `<div class="hero-main"><div class="hero-label">${head}</div><div class="hero-price">–</div><div class="hero-pp">No prices for these dates in the latest check.</div></div>`;
      return;
    }
    const h = hotelInfo(best.hotel);
    const total = conv(best.total);
    const prev = previousBest(chkIn, p.nights);
    const delta = prev == null ? null : total - prev;
    const deltaHtml = delta == null ? "–" : delta === 0 ? "No change"
      : `<span class="${delta < 0 ? "delta-down" : "delta-up"}">${delta < 0 ? "▼" : "▲"} ${money(Math.abs(delta))}</span>`;
    const rated = list.map((q) => ({ q, h: hotelInfo(q.hotel) })).filter((x) => x.h.rating != null)
      .sort((a, b) => b.h.rating - a.h.rating || a.q.total - b.q.total)[0];
    $("hero").innerHTML = `
      <div class="hero-main">
        <div class="hero-label">Cheapest for ${head}</div>
        <div class="hero-price">${money(total)}</div>
        <div class="hero-pp">${money(conv(best.min_rate))} a night · on ${esc(best.min_site)}${fx() ? ` · ${eur(best.total)}` : ""}</div>
        <div class="hero-route"><b>${esc(h.name)}</b> · ${esc(h.area || "")}</div>
        <div class="hero-what">${hotelBadges(h)}</div>
      </div>
      <div class="hero-side">
        <div class="stat"><div class="hero-label">Since last check</div><div class="v">${deltaHtml}</div><div class="s">cheapest for these dates</div></div>
        <div class="stat"><div class="hero-label">Lowest seen</div><div class="v">${money(lowestSeen(null, chkIn, p.nights))}</div><div class="s">these dates, any hotel</div></div>
        <div class="stat" style="grid-column: span 2"><div class="hero-label">Best reviewed with a price</div>
          <div class="v">${rated ? money(conv(rated.q.total)) : "–"}</div>
          <div class="s">${rated ? `${esc(rated.h.name)} · ★ ${esc(rated.h.rating)}` : "No review scores yet"}</div></div>
      </div>`;
  }

  function renderMatrix() {
    const s = stayCfg();
    const p = pick();
    $("matrix-title").textContent = byCheckout(s) ? "Cheapest last stay by check-out date and nights" : "Cheapest first stay by check-in date and nights";
    $("matrix-hint").textContent = `Whole stay, one room${s.note ? `. ${s.note}` : ""} Tap a price to see every hotel for those dates.`;
    const cells = stayDates(s).map((d) => s.nights.map((n) => priced(quotesFor(d, n))[0] || null));
    const all = cells.flat().filter(Boolean).map((q) => q.total);
    const min = all.length ? Math.min(...all) : null;
    $("matrix").innerHTML = `<thead><tr><th>${byCheckout(s) ? "Check-out" : "Check-in"}</th>${s.nights.map((n) => `<th>${n} nights</th>`).join("")}</tr></thead><tbody>${
      stayDates(s).map((d, i) => `<tr><td class="ap">${esc(fmtDate(d))}<small>${byCheckout(s) ? "in " : "out "}${s.nights.map((n) => esc(fmtDateShort(byCheckout(s) ? datesOf(d, n).chkIn : datesOf(d, n).chkOut))).join(" / ")}</small></td>${
        s.nights.map((n, j) => {
          const q = cells[i][j];
          const active = p.date === d && p.nights === n;
          if (!q) return `<td class="none"><button type="button" data-d="${d}" data-n="${n}" class="${active ? "active" : ""}">–</button></td>`;
          return `<td class="${q.total === min ? "best" : ""}"><button type="button" data-d="${d}" data-n="${n}" class="${active ? "active" : ""}">${money(conv(q.total))}<span class="sub">${esc(hotelInfo(q.hotel).name.replace(/^(The|Bangkok) /, "").slice(0, 26))}</span></button></td>`;
        }).join("")}</tr>`).join("")}</tbody>`;
  }

  function renderHotels() {
    const p = pick();
    const { chkIn, chkOut } = datesOf(p.date, p.nights);
    $("hotels-title").textContent = `Hotels · ${fmtDateShort(chkIn)} → ${fmtDateShort(chkOut)}`;
    $("hotels-hint").textContent = `${p.nights} nights, whole stay for one room. Cheapest site first; open a hotel for every site's price.`;
    $("sort-switch").innerHTML = [["price", "Price"], ["rating", "Reviews"]].map(([v, t]) =>
      `<button type="button" data-o="${v}" aria-pressed="${state.sort === v}">${t}</button>`).join("");
    const qs = quotesFor(p.date, p.nights);
    const rows = config.hotels.filter((h) => h.enabled !== false).map((cfg) => {
      const q = qs.find((x) => x.hotel === cfg.id);
      return { h: hotelInfo(cfg.id), q: q && q.total != null ? q : null, err: q?.error };
    });
    rows.sort((a, b) => {
      if (!!a.q !== !!b.q) return a.q ? -1 : 1;
      if (state.sort === "rating") return (b.h.rating ?? -1) - (a.h.rating ?? -1) || (a.q?.total ?? 0) - (b.q?.total ?? 0);
      return (a.q?.total ?? 0) - (b.q?.total ?? 0);
    });
    const cheapest = Math.min(...rows.filter((r) => r.q).map((r) => r.q.total));
    $("hotels").innerHTML = rows.map(({ h, q, err }) => {
      const ta = taUrl(h);
      const links = [`<a href="${esc(bookingUrl(h, chkIn, chkOut))}" target="_blank" rel="noopener">Booking.com for these dates</a>`,
        `<a href="${esc(googleUrl(h))}" target="_blank" rel="noopener">Google Hotels</a>`,
        ta ? `<a href="${esc(ta)}" target="_blank" rel="noopener">Tripadvisor</a>` : ""].filter(Boolean).join(" · ");
      const rates = q ? `<details><summary>${q.rates.length} site${q.rates.length === 1 ? "" : "s"}</summary><ul class="legs">${
        q.rates.map((r) => `<li>${esc(r.name)}: <b>${money(conv(r.rate * q.nights))}</b> <span class="lay">(${money(conv(r.rate))} a night${fx() ? ` · ${nf.format(r.rate)} €` : ""})</span></li>`).join("")}</ul></details>` : "";
      return `<li class="opt${q && q.total === cheapest ? " top" : ""}">
        <div class="opt-head">
          <div><div class="opt-air">${esc(h.name)}</div><div class="opt-route">${esc(h.area || "")}</div></div>
          <div class="opt-price">${q ? `<div class="t">${money(conv(q.total))}</div><div class="p">${money(conv(q.min_rate))} a night · ${esc(q.min_site)}</div>` : `<div class="p">${err ? "Check failed" : "No rates for these dates"}</div>`}</div>
        </div>
        <div class="opt-badges">${hotelBadges(h)}</div>
        ${rates}
        <div class="opt-links">${links}</div>
      </li>`;
    }).join("") || `<li class="empty">No hotels configured.</li>`;
  }

  /* ---------- trend ---------- */
  function trendSeries() {
    const p = pick();
    const { chkIn } = datesOf(p.date, p.nights);
    const top = priced(quotesFor(p.date, p.nights)).slice(0, 3).map((q) => q.hotel);
    const entries = history?.entries || [];
    return top.map((id, i) => ({
      label: hotelInfo(id).name.replace(/^(The|Bangkok) /, ""),
      color: SERIES[i],
      values: entries.map((e) => {
        const v = e.prices?.[`${id}|${state.stay}|${chkIn}|${p.nights}`];
        return { t: new Date(e.fetched_at).getTime(), v: v == null ? null : conv(v, e.pln_rate || fx()) };
      }),
    }));
  }
  function renderTrend() {
    const series = trendSeries();
    $("trend-legend").innerHTML = series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join("");
    drawChart(series);
    const times = [...new Set(series.flatMap((s) => s.values.map((v) => v.t)))].sort((a, b) => b - a);
    $("history-table").innerHTML = `<thead><tr><th>Checked</th>${series.map((s) => `<th>${esc(s.label)}</th>`).join("")}</tr></thead><tbody>${
      times.map((t) => `<tr><td>${esc(fmtWhen(new Date(t).toISOString()))}</td>${series.map((s) => {
        const pt = s.values.find((v) => v.t === t);
        return `<td>${pt && pt.v != null ? money(pt.v) : "–"}</td>`;
      }).join("")}</tr>`).join("")}</tbody>`;
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
    const m = { l: 44, r: 12, t: 10, b: 26 };
    const all = series.flatMap((s) => s.values.filter((v) => v.v != null));
    if (!all.length) {
      el.innerHTML = `<svg viewBox="0 0 ${W} 80" role="img" aria-label="No price history yet"><text class="empty-msg" x="${W / 2}" y="44" text-anchor="middle">No price history yet</text></svg>`;
      chartGeom = null;
      return;
    }
    const times = [...new Set(all.map((v) => v.t))].sort((a, b) => a - b);
    let t0 = times[0], t1 = times[times.length - 1];
    if (t0 === t1) { t0 -= 12 * 3600e3; t1 += 12 * 3600e3; }
    const vals = all.map((v) => v.v);
    const ticks = niceTicks(Math.min(...vals) * 0.98, Math.max(...vals) * 1.02);
    const y0 = ticks[0], y1 = ticks[ticks.length - 1];
    const x = (t) => m.l + ((t - t0) / (t1 - t0)) * (W - m.l - m.r);
    const y = (v) => m.t + (1 - (v - y0) / (y1 - y0 || 1)) * (H - m.t - m.b);
    const dayMs = 86400e3;
    const maxTicks = Math.max(2, Math.floor((W - m.l - m.r) / 70));
    const stepDays = Math.max(1, Math.ceil((t1 - t0) / dayMs / maxTicks));
    const xticks = [];
    const startDay = new Date(t0); startDay.setUTCHours(0, 0, 0, 0);
    for (let t = startDay.getTime(); t <= t1; t += stepDays * dayMs) if (t >= t0) xticks.push(t);
    if (!xticks.length) xticks.push(times[0]);
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Price trend chart; the same data is in the table below">`;
    svg += `<g class="grid">${ticks.map((v) => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`).join("")}</g>`;
    svg += `<g class="axis">${ticks.map((v) => `<text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${kfmt(v)}</text>`).join("")}`;
    svg += xticks.map((t) => `<text x="${x(t)}" y="${H - 6}" text-anchor="middle">${esc(shortDay.format(new Date(t)))}</text>`).join("") + `</g>`;
    for (const s of series) {
      let seg = [];
      const flush = () => { if (seg.length) svg += `<path class="line" stroke="${s.color}" d="${seg.map((p, k) => `${k ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("")}"/>`; seg = []; };
      for (const p of s.values) { if (p.v == null) flush(); else seg.push(p); }
      flush();
      const pts = s.values.filter((p) => p.v != null);
      for (const p of pts.length <= 40 ? pts : pts.slice(-1)) svg += `<circle class="dot" cx="${x(p.t)}" cy="${y(p.v)}" r="4" fill="${s.color}"/>`;
    }
    svg += `<line class="xhair" id="xhair" y1="${m.t}" y2="${H - m.b}" x1="-10" x2="-10" visibility="hidden"/></svg>`;
    el.innerHTML = svg;
    chartGeom = { series, times, x, W };
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
    const rows = chartGeom.series.map((s) => {
      const p = s.values.find((v) => v.t === best);
      return `<div class="tt-r"><span><i style="background:${s.color}"></i>${esc(s.label)}</span><b>${p && p.v != null ? money(p.v) : "–"}</b></div>`;
    }).join("");
    const tt = $("tooltip");
    tt.innerHTML = `<div class="tt-h">${esc(fmtWhen(new Date(best).toISOString()))}</div>${rows}`;
    tt.hidden = false;
    const sx = rect.left + chartGeom.x(best) / scale;
    let left = sx + 12;
    if (left + tt.offsetWidth > window.innerWidth - 8) left = sx - tt.offsetWidth - 12;
    tt.style.left = Math.max(8, left) + "px";
    tt.style.top = Math.max(8, rect.top + 8) + "px";
  }
  function chartLeave() {
    $("tooltip").hidden = true;
    const xh = $("xhair");
    if (xh) xh.setAttribute("visibility", "hidden");
  }

  function renderInfo() {
    const g = config.settings || {};
    const rows = [
      ["Guests", g.guests_note || ""],
      ...config.stays.map((s) => [s.name || s.id, `${byCheckout(s) ? "Check-out" : "Check-in"} ${stayDates(s).map(fmtDateShort).join(", ")} · ${s.nights.join(", ")} nights`]),
      ["Hotels", `${config.hotels.filter((h) => h.enabled !== false).length} picked for 5 stars, an outdoor pool, a high-rise building, good reviews and a BTS or MRT station within a short walk`],
      ["Source", `${latest?.source || "Xotelo (Tripadvisor rates)"}${latest?.requests ? ` · ${latest.requests} requests last run` : ""}`],
      ["Currency", latest?.pln_rate ? `Fetched in ${latest.currency}, shown in PLN at ${latest.pln_rate} (${latest.pln_rate_source})` : `Shown in ${cur()}`],
    ];
    $("search-info").innerHTML = `<h2>Search settings</h2><dl class="info-grid">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
  }

  /* ---------- events ---------- */
  $("refresh").addEventListener("click", () => loadAll());
  $("stay-switch").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-s]");
    if (!b || b.dataset.s === state.stay) return;
    state.stay = b.dataset.s;
    store.set("stay", state.stay);
    render();
  });
  $("matrix").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-d]");
    if (!b) return;
    state.pick[state.stay] = { date: b.dataset.d, nights: Number(b.dataset.n) };
    store.set("pick", JSON.stringify(state.pick));
    renderHero();
    renderMatrix();
    renderHotels();
    renderTrend();
  });
  $("sort-switch").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-o]");
    if (!b) return;
    state.sort = b.dataset.o;
    store.set("sort", state.sort);
    renderHotels();
  });
  const chart = $("chart");
  chart.addEventListener("pointermove", chartHover);
  chart.addEventListener("pointerdown", chartHover);
  chart.addEventListener("pointerleave", chartLeave);
  document.addEventListener("scroll", chartLeave, { passive: true });
  let rz;
  window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => config && renderTrend(), 150); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && latest && Date.now() - new Date(latest.fetched_at).getTime() > 6 * 3600e3) loadAll();
  });

  loadAll();
})();
