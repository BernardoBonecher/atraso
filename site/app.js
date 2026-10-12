import * as Plot from "https://cdn.jsdelivr.net/npm/@observablehq/plot@0.6.16/+esm";
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm";
import * as topojson from "https://cdn.jsdelivr.net/npm/topojson-client@3.1.0/+esm";

const OUTCOMES = [
  { key: "on_time", label: "No horário", color: "--o-on" },
  { key: "late", label: "15–60 min", color: "--o-late" },
  { key: "very_late", label: "Mais de 1 h", color: "--o-very" },
  { key: "cancelled", label: "Cancelado", color: "--o-cancel" },
];
const PERIODS = [
  { key: "all", label: "Qualquer horário", hours: [0, 23] },
  { key: "dawn", label: "Madrugada (0h–5h)", hours: [0, 5] },
  { key: "morning", label: "Manhã (6h–11h)", hours: [6, 11] },
  { key: "afternoon", label: "Tarde (12h–17h)", hours: [12, 17] },
  { key: "night", label: "Noite (18h–23h)", hours: [18, 23] },
];
const WEEKDAYS = ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"];
const POPULAR = ["SBPA-SBSP", "SBSP-SBRJ", "SBGR-SBSV", "SBBR-SBGR", "SBCF-SBSP", "SBKP-SBRF"];
const DEFAULT_ROUTE = "SBPA-SBSP";
const THIN_HOUR = 20;
// Heatmap and map encode the same measure, so they share one color scale.
// In dark mode the low end must recede into the dark surface, so the ramp runs dark -> bright.
const isDark = () => document.documentElement.dataset.theme
  ? document.documentElement.dataset.theme === "dark"
  : matchMedia("(prefers-color-scheme: dark)").matches;
const badScale = (width) => ({
  type: "linear", domain: [0, 0.3], clamp: true, legend: true, tickFormat: "%", label: "% atrasados ou cancelados", width,
  ...(isDark() ? { range: ["#3a2a20", "#ff9a3d"], interpolate: "lab" } : { scheme: "oranges" }),
});

const $ = (sel) => document.querySelector(sel);
const pct = (x) => `${Math.round(x * 100)}%`;
const fmtInt = new Intl.NumberFormat("pt-BR");
const fmtMonth = (m) => new Date(`${m}-15`).toLocaleDateString("pt-BR", { month: "short", year: "numeric" }).replace(".", "");

let meta, routes, heat, world;
let current = null; // { key, origin, dest, data }

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const outcomeColors = () => OUTCOMES.map((o) => css(o.color));

// ---------- statistics ----------

/** Wilson score interval for a proportion (95%). Honest about small samples. */
export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = k / n;
  const den = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

const sum = (arr) => arr.reduce((a, b) => a + b, 0);
const addCounts = (a, b) => a.map((v, i) => v + b[i]);
const zero = () => [0, 0, 0, 0];

// ---------- labels ----------

function shortName(code) {
  const a = meta.airports[code];
  if (!a) return code;
  return `${a.city} (${a.iata || code})`;
}

function airportLabel(code) {
  const a = meta.airports[code];
  const name = a.name.replace(/International Airport|Airport|Aeroporto( Internacional)?( de)?/gi, "").replace(/\s+/g, " ").trim();
  return `${a.city} (${a.iata || code}) — ${name}`;
}

function airlineName(code) {
  return meta.airlines[code]?.name ?? code;
}

/** Accepts "POA", "SBPA", "Porto Alegre (POA) — ..." or a city name. */
function resolveAirport(text, allowed) {
  const t = text.trim().toUpperCase();
  if (!t) return null;
  const pool = allowed ?? Object.keys(meta.airports);
  const byLabel = pool.find((c) => airportLabel(c).toUpperCase() === t);
  if (byLabel) return byLabel;
  const code = t.match(/\(([A-Z0-9]{3,4})\)/)?.[1] ?? t;
  const byCode = pool.find((c) => c === code || meta.airports[c].iata === code);
  if (byCode) return byCode;
  const byCity = pool.filter((c) => meta.airports[c].city.toUpperCase() === t);
  if (byCity.length) return byCity.sort((a, b) => sum(meta.airports[b].dep) - sum(meta.airports[a].dep))[0];
  return null;
}

// ---------- search ----------

function destinationsFrom(origin) {
  return Object.keys(routes).filter((k) => k.startsWith(`${origin}-`)).map((k) => k.slice(5));
}

function fillDatalist(el, codes) {
  el.replaceChildren(...codes
    .sort((a, b) => sum(meta.airports[b].dep) - sum(meta.airports[a].dep))
    .map((c) => Object.assign(document.createElement("option"), { value: airportLabel(c) })));
}

function setupSearch() {
  const origins = [...new Set(Object.keys(routes).map((k) => k.slice(0, 4)))];
  fillDatalist($("#origin-list"), origins);

  $("#origin").addEventListener("change", () => {
    const o = resolveAirport($("#origin").value, origins);
    fillDatalist($("#dest-list"), o ? destinationsFrom(o) : []);
  });

  $("#swap").addEventListener("click", () => {
    [$("#origin").value, $("#dest").value] = [$("#dest").value, $("#origin").value];
    $("#origin").dispatchEvent(new Event("change"));
  });

  $("#search").addEventListener("submit", (e) => {
    e.preventDefault();
    const o = resolveAirport($("#origin").value);
    const d = resolveAirport($("#dest").value);
    const msg = $("#search-msg");
    if (!o || !d) {
      msg.textContent = `Não encontrei ${!o ? "a origem" : "o destino"}. Tente o código de 3 letras, como POA ou GRU.`;
      return;
    }
    if (o === d) {
      msg.textContent = "Origem e destino são o mesmo aeroporto.";
      return;
    }
    if (!routes[`${o}-${d}`]) {
      const alt = destinationsFrom(o).length;
      msg.textContent = `Não há voo direto regular de ${shortName(o)} para ${shortName(d)} com pelo menos ${meta.limits.min_route} voos no período.`
        + (alt ? ` De ${shortName(o)} saem voos para ${alt} destinos.` : "");
      return;
    }
    msg.textContent = "";
    showRoute(`${o}-${d}`, true);
  });

  $("#popular").replaceChildren(...POPULAR.filter((k) => routes[k]).map((k) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    const [o, d] = k.split("-");
    b.textContent = `${meta.airports[o].iata} → ${meta.airports[d].iata}`;
    b.addEventListener("click", () => showRoute(k, true));
    return b;
  }));
}

// ---------- route ----------

function routeCounts(data, airline, period) {
  const entries = airline === "all" ? Object.values(data.airlines) : [data.airlines[airline]];
  let c = zero();
  for (const a of entries) {
    if (!a) continue;
    if (period.key === "all") c = addCounts(c, a.o);
    else for (const [h, v] of Object.entries(a.h)) {
      if (+h >= period.hours[0] && +h <= period.hours[1]) c = addCounts(c, v);
    }
  }
  return c;
}

function showRoute(key, scroll = false) {
  const [origin, dest] = key.split("-");
  current = { key, origin, dest, data: routes[key] };
  $("#origin").value = airportLabel(origin);
  $("#dest").value = airportLabel(dest);
  fillDatalist($("#dest-list"), destinationsFrom(origin));
  history.replaceState(null, "", `#${meta.airports[origin].iata || origin}-${meta.airports[dest].iata || dest}`);

  const total = routeCounts(current.data, "all", PERIODS[0]);
  const n = sum(total);
  const onTime = total[0] / n;
  $("#route-name").textContent = `${shortName(origin)} → ${shortName(dest)}`;
  animateNumber($("#hero-pct"), Math.round(onTime * 100));
  const late = (total[1] + total[2]) / n;
  $("#hero-sub").textContent = `dos voos chegaram no horário. ${pct(late)} chegaram com mais de 15 min de atraso e ${pct(total[3] / n)} foram cancelados.`;
  $("#hero-note").textContent = `${fmtInt.format(n)} voos regulares entre ${fmtMonth(meta.window[0])} e ${fmtMonth(meta.window[1])}.`;

  const airlines = Object.keys(current.data.airlines).sort((a, b) => sum(current.data.airlines[b].o) - sum(current.data.airlines[a].o));
  $("#hour-airline").replaceChildren(
    new Option("Todas as companhias", "all"),
    ...airlines.map((a) => new Option(airlineName(a), a)),
  );
  for (const [i, fs] of document.querySelectorAll(".option").entries()) {
    const sel = fs.querySelector(".opt-airline");
    sel.replaceChildren(new Option("Qualquer companhia", "all"), ...airlines.map((a) => new Option(airlineName(a), a)));
    sel.value = airlines[Math.min(i, airlines.length - 1)];
    fs.querySelector(".opt-period").replaceChildren(...PERIODS.map((p) => new Option(p.label, p.key)));
  }

  $("#result").hidden = false;
  renderRoute();
  if (scroll) $("#result").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

function animateNumber(el, to) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { el.textContent = to; return; }
  const from = +el.textContent || 0;
  const start = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - start) / 600);
    el.textContent = Math.round(from + (to - from) * d3.easeCubicOut(k));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderRoute() {
  if (!current) return;
  renderAirlines();
  renderHours();
  renderCompare();
}

function stackRows(groups) {
  // groups: [{ name, counts, extra }] -> long format with shares for a 100% stack
  return groups.flatMap((g) => {
    const n = sum(g.counts);
    return OUTCOMES.map((o, i) => ({ ...g, outcome: o.label, k: g.counts[i], n, share: n ? g.counts[i] / n : 0 }));
  });
}

function outcomeScale() {
  return { domain: OUTCOMES.map((o) => o.label), range: outcomeColors(), legend: false };
}

function renderAirlines() {
  const { data } = current;
  const groups = Object.entries(data.airlines)
    .map(([code, a]) => ({ name: airlineName(code), counts: a.o, p: a.p }))
    .sort((a, b) => b.counts[0] / sum(b.counts) - a.counts[0] / sum(a.counts));
  const rows = stackRows(groups);
  const el = $("#chart-airlines");
  const width = el.clientWidth || 640;
  el.replaceChildren(Plot.plot({
    width,
    height: 56 + groups.length * 44,
    marginLeft: width < 560 ? 84 : 110,
    marginRight: 16,
    x: { domain: [0, 1], tickFormat: "%", label: null, grid: true, ticks: 5 },
    y: { domain: groups.map((g) => g.name), label: null, padding: 0.35 },
    color: outcomeScale(),
    style: { background: "transparent", fontSize: "13px" },
    marks: [
      Plot.barX(rows, Plot.stackX({
        x: "share", y: "name", fill: "outcome", order: OUTCOMES.map((o) => o.label),
        insetLeft: 1, insetRight: 1, rx: 3,
        tip: true,
        title: (d) => `${d.name}\n${d.outcome}: ${pct(d.share)} (${fmtInt.format(d.k)} de ${fmtInt.format(d.n)} voos)`,
      })),
      Plot.text(groups, {
        x: 0, y: "name", dy: -17, dx: 2, textAnchor: "start", fill: "currentColor", fillOpacity: 0.7, fontSize: 11,
        text: (g) => {
          const n = `${fmtInt.format(sum(g.counts))} voos`;
          if (!g.p) return n;
          const late = Math.max(0, g.p[1]);
          return width < 560 ? `${n} · 1 em 5 > ${late} min` : `${n} · 1 em cada 5 atrasa mais de ${late} min`;
        },
      }),
      Plot.ruleX([0]),
    ],
  }));

  $("#table-airlines").replaceChildren(table(
    ["Companhia", "Voos", "No horário", "15–60 min", "> 1 h", "Cancelado", "Atraso típico", "1 em 5 atrasa mais de"],
    groups.map((g) => {
      const n = sum(g.counts);
      return [g.name, fmtInt.format(n), ...g.counts.map((c) => pct(c / n)),
        g.p ? `${g.p[0]} min` : "—", g.p ? `${g.p[1]} min` : "—"];
    }),
  ));
}

function renderHours() {
  const { data } = current;
  const airline = $("#hour-airline").value || "all";
  const entries = airline === "all" ? Object.values(data.airlines) : [data.airlines[airline]];
  const byHour = new Map();
  for (const a of entries) for (const [h, v] of Object.entries(a.h)) byHour.set(+h, addCounts(byHour.get(+h) ?? zero(), v));
  const hours = [...byHour.keys()].sort((a, b) => a - b);
  const groups = hours.map((h) => ({ name: `${h}h`, hour: h, counts: byHour.get(h) }));
  const rows = stackRows(groups);
  const el = $("#chart-hours");

  if (!groups.length) {
    el.replaceChildren(Object.assign(document.createElement("p"), { className: "muted", textContent: "Sem voos dessa companhia nesta rota." }));
    return;
  }

  const width = el.clientWidth || 640;
  const every = Math.ceil(groups.length / Math.max(4, Math.floor(width / 38)));
  el.replaceChildren(Plot.plot({
    width,
    height: 260,
    marginLeft: 44,
    x: { domain: groups.map((g) => g.name), label: "Hora de partida (local)", padding: 0.25,
         tickFormat: (name, i) => (i % every === 0 ? name : "") },
    y: { domain: [0, 1], tickFormat: "%", label: null, grid: true, ticks: 5 },
    color: outcomeScale(),
    style: { background: "transparent", fontSize: "12px" },
    marks: [
      Plot.barY(rows, Plot.stackY({
        x: "name", y: "share", fill: "outcome", order: OUTCOMES.map((o) => o.label),
        insetTop: 1, insetBottom: 1, rx: 2,
        fillOpacity: (d) => (d.n < THIN_HOUR ? 0.35 : 1),
        tip: true,
        title: (d) => `Partida às ${d.name}\n${d.outcome}: ${pct(d.share)} (${fmtInt.format(d.k)} de ${fmtInt.format(d.n)} voos)`,
      })),
      Plot.ruleY([0]),
    ],
  }));

  $("#table-hours").replaceChildren(table(
    ["Partida", "Voos", "No horário", "15–60 min", "> 1 h", "Cancelado"],
    groups.map((g) => {
      const n = sum(g.counts);
      return [g.name, fmtInt.format(n), ...g.counts.map((c) => pct(c / n))];
    }),
  ));
}

function renderCompare() {
  const results = [...document.querySelectorAll(".option")].map((fs) => {
    const airline = fs.querySelector(".opt-airline").value;
    const period = PERIODS.find((p) => p.key === fs.querySelector(".opt-period").value) ?? PERIODS[0];
    const counts = routeCounts(current.data, airline, period);
    const n = sum(counts);
    const out = fs.querySelector(".opt-out");
    if (!n) {
      out.innerHTML = `<p class="muted">Nenhum voo nessa combinação.</p>`;
      return null;
    }
    const ci = wilson(counts[0], n);
    out.innerHTML = `
      <div class="big">${pct(counts[0] / n)}</div>
      <p>no horário <span class="muted">(margem ${pct(ci[0])}–${pct(ci[1])})</span></p>
      <p class="muted small">${pct(counts[2] / n)} com mais de 1 h · ${pct(counts[3] / n)} cancelados · ${fmtInt.format(n)} voos</p>`;
    const label = `${airline === "all" ? "qualquer companhia" : airlineName(airline)}, ${period.label.toLowerCase()}`;
    return { counts, n, ci, label };
  });

  const [a, b] = results;
  const v = $("#verdict");
  if (!a || !b) { v.textContent = ""; return; }
  const pa = a.counts[0] / a.n, pb = b.counts[0] / b.n;
  const overlap = a.ci[0] <= b.ci[1] && b.ci[0] <= a.ci[1];
  const diff = Math.round(Math.abs(pa - pb) * 100);
  if (overlap || diff < 1) {
    v.textContent = `Na prática, empate: as margens se sobrepõem, então a diferença de ${diff} ponto${diff === 1 ? "" : "s"} pode ser acaso.`;
  } else {
    const [best, worst] = pa > pb ? [a, b] : [b, a];
    v.textContent = `A opção ${best === a ? "A" : "B"} (${best.label}) chegou no horário ${diff} pontos percentuais mais vezes que a ${worst === a ? "A" : "B"}. A diferença é maior que a margem de acaso.`;
  }
}

// ---------- Brazil-wide ----------

function setupBrasil() {
  const sel = $("#heat-airport");
  const codes = Object.keys(heat).filter((k) => k !== "ALL")
    .sort((a, b) => sum(meta.airports[b].dep) - sum(meta.airports[a].dep));
  sel.replaceChildren(new Option("Todos os aeroportos", "ALL"), ...codes.map((c) => new Option(shortName(c), c)));
  sel.addEventListener("change", renderHeat);
}

function renderHeat() {
  const code = $("#heat-airport").value || "ALL";
  const grid = heat[code];
  const cells = grid.flatMap((day, d) => day.map(([n, bad], h) => ({ day: WEEKDAYS[d], hour: h, n, bad, share: n ? bad / n : null })));
  const el = $("#chart-heat");
  const width = el.clientWidth || 900;
  const every = width < 480 ? 6 : width < 760 ? 3 : 1;
  el.replaceChildren(Plot.plot({
    width,
    height: width < 480 ? 220 : 260,
    marginLeft: 40,
    padding: 0.06,
    x: { label: "Hora de partida (local)", tickFormat: (h) => (h % every === 0 ? `${h}h` : "") },
    y: { domain: WEEKDAYS, label: null },
    color: badScale(280),
    style: { background: "transparent", fontSize: "12px" },
    marks: [
      Plot.cell(cells.filter((c) => c.n >= THIN_HOUR), {
        x: "hour", y: "day", fill: "share", rx: 3, tip: true,
        title: (c) => `${c.day}, ${c.hour}h\n${pct(c.share)} atrasados ou cancelados\n${fmtInt.format(c.n)} voos`,
      }),
      Plot.cell(cells.filter((c) => c.n > 0 && c.n < THIN_HOUR), {
        x: "hour", y: "day", fill: "currentColor", fillOpacity: 0.06, rx: 3,
      }),
    ],
  }));

  $("#table-heat").replaceChildren(table(
    ["Dia", ...Array.from({ length: 24 }, (_, h) => `${h}h`)],
    WEEKDAYS.map((day, d) => [day, ...grid[d].map(([n, bad]) => (n >= THIN_HOUR ? pct(bad / n) : "—"))]),
  ));

  // One sentence the reader can act on: how much worse the evening is than the morning.
  const band = (h0, h1) => {
    let n = 0, bad = 0;
    for (const day of grid) for (let h = h0; h <= h1; h++) { n += day[h][0]; bad += day[h][1]; }
    return n ? bad / n : null;
  };
  const morning = band(5, 9), evening = band(17, 21);
  $("#heat-insight").textContent = morning != null && evening != null
    ? `Saindo entre 5h e 9h, ${pct(morning)} dos voos chegaram atrasados ou foram cancelados; entre 17h e 21h, ${pct(evening)}. `
      + (evening > morning * 1.3 ? "O atraso de um voo passa para o próximo do mesmo avião, então ele se acumula ao longo do dia." : "")
    : "";
}

function renderRank() {
  const rows = Object.entries(meta.airports)
    .filter(([code]) => heat[code])
    .map(([code, a]) => {
      const n = sum(a.dep);
      const [lo, hi] = wilson(a.dep[0], n);
      return { code, name: shortName(code), n, share: a.dep[0] / n, lo, hi };
    })
    .sort((a, b) => b.share - a.share);
  const el = $("#chart-rank");
  const selected = current?.origin;
  el.replaceChildren(Plot.plot({
    width: el.clientWidth || 480,
    height: 40 + rows.length * 18,
    marginLeft: 170,
    marginRight: 16,
    x: { tickFormat: "%", label: null, grid: true, ticks: 4, domain: [d3.min(rows, (r) => r.lo) - 0.02, d3.max(rows, (r) => r.hi) + 0.01] },
    y: { domain: rows.map((r) => r.name), label: null },
    style: { background: "transparent", fontSize: "11px" },
    marks: [
      Plot.ruleY(rows, { x1: "lo", x2: "hi", y: "name", stroke: "currentColor", strokeOpacity: 0.35, strokeWidth: 2 }),
      Plot.dot(rows, {
        x: "share", y: "name", r: 4.5, stroke: css("--surface"), strokeWidth: 2,
        fill: (r) => (r.code === selected ? css("--o-late") : css("--o-on")),
        tip: true,
        title: (r) => `${r.name}\n${pct(r.share)} no horário (margem ${pct(r.lo)}–${pct(r.hi)})\n${fmtInt.format(r.n)} voos partindo`,
      }),
    ],
  }));
  $("#table-rank").replaceChildren(table(
    ["Aeroporto", "Voos partindo", "No horário", "Margem 95%"],
    rows.map((r) => [r.name, fmtInt.format(r.n), pct(r.share), `${pct(r.lo)}–${pct(r.hi)}`]),
  ));
}

function renderMap() {
  const el = $("#chart-map");
  if (!world) { el.replaceChildren(Object.assign(document.createElement("p"), { className: "muted", textContent: "Mapa indisponível." })); return; }
  const brazil = topojson.feature(world, world.objects.countries).features.find((f) => f.id === "076");
  const dots = Object.entries(meta.airports)
    .map(([code, a]) => ({ code, ...a, n: sum(a.dep), bad: (a.dep[1] + a.dep[2] + a.dep[3]) / Math.max(1, sum(a.dep)) }))
    .filter((d) => d.n >= 500)
    .sort((a, b) => b.n - a.n);
  const width = el.clientWidth || 480;
  const plot = Plot.plot({
    width,
    height: Math.round(width * 0.95),
    projection: { type: "mercator", domain: brazil, inset: 8 },
    color: badScale(240),
    r: { range: [2, 16] },
    style: { background: "transparent", fontSize: "11px" },
    marks: [
      Plot.geo(brazil, { fill: "currentColor", fillOpacity: 0.05, stroke: "currentColor", strokeOpacity: 0.25 }),
      Plot.dot(dots, {
        x: "lon", y: "lat", r: "n", fill: "bad", stroke: css("--surface"), strokeWidth: 1.5,
        tip: true,
        title: (d) => `${d.city} (${d.iata || d.code})\n${pct(d.bad)} atrasados ou cancelados\n${fmtInt.format(d.n)} voos partindo`,
      }),
    ],
  });
  plot.addEventListener("click", () => {
    const d = plot.value;
    if (!d) return;
    $("#origin").value = airportLabel(d.code);
    $("#origin").dispatchEvent(new Event("change"));
    $("#dest").value = "";
    $("#dest").focus();
    $("#search-msg").textContent = `Origem: ${shortName(d.code)}. Agora escolha o destino.`;
    $("#rota").scrollIntoView({ behavior: "smooth" });
  });
  el.replaceChildren(plot);
}

// ---------- shared ----------

function table(head, body) {
  const t = document.createElement("table");
  const thead = t.createTHead().insertRow();
  for (const h of head) thead.appendChild(Object.assign(document.createElement("th"), { textContent: h, scope: "col" }));
  const tb = t.createTBody();
  for (const r of body) {
    const tr = tb.insertRow();
    r.forEach((v, i) => {
      const cell = i === 0 ? document.createElement("th") : document.createElement("td");
      if (i === 0) cell.scope = "row";
      cell.textContent = v;
      tr.appendChild(cell);
    });
  }
  return t;
}

function setupTables() {
  for (const btn of document.querySelectorAll("[data-table]")) {
    btn.setAttribute("aria-expanded", "false");
    btn.addEventListener("click", () => {
      const wrap = $(`#table-${btn.dataset.table}`);
      wrap.hidden = !wrap.hidden;
      btn.setAttribute("aria-expanded", String(!wrap.hidden));
      btn.textContent = wrap.hidden ? "Ver tabela" : "Ver gráfico";
      $(`#chart-${btn.dataset.table}`).hidden = !wrap.hidden;
    });
  }
}

function setupTheme() {
  const root = document.documentElement;
  try { const saved = localStorage.getItem("atraso-theme"); if (saved) root.dataset.theme = saved; } catch {}
  $("#theme").addEventListener("click", () => {
    root.dataset.theme = isDark() ? "light" : "dark";
    try { localStorage.setItem("atraso-theme", root.dataset.theme); } catch {}
    renderAll();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", renderAll);
}

function renderAll() {
  renderRoute();
  renderHeat();
  renderRank();
  renderMap();
}

function routeFromHash() {
  const m = location.hash.slice(1).toUpperCase().match(/^([A-Z0-9]{3,4})-([A-Z0-9]{3,4})$/);
  if (!m) return null;
  const o = resolveAirport(m[1]), d = resolveAirport(m[2]);
  return o && d && routes[`${o}-${d}`] ? `${o}-${d}` : null;
}

async function main() {
  try {
    [meta, routes, heat] = await Promise.all(["meta", "routes", "heat"].map((f) => fetch(`data/${f}.json`).then((r) => {
      if (!r.ok) throw new Error(`${f}.json: HTTP ${r.status}`);
      return r.json();
    })));
  } catch (err) {
    $("#loading").hidden = true;
    const e = $("#error");
    e.hidden = false;
    e.textContent = "Não consegui carregar os dados. Recarregue a página.";
    console.error(err);
    return;
  }
  world = await fetch("https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json").then((r) => r.json()).catch(() => null);

  $("#coverage").textContent = `${fmtInt.format(meta.flights)} voos domésticos regulares, ${fmtMonth(meta.window[0])} a ${fmtMonth(meta.window[1])}. Fonte: ANAC.`;
  $("#source-link").href = meta.source_url;

  setupSearch();
  setupBrasil();
  setupTables();
  setupTheme();
  $("#hour-airline").addEventListener("change", renderHours);
  for (const s of document.querySelectorAll(".option select")) s.addEventListener("change", renderCompare);

  showRoute(routeFromHash() ?? DEFAULT_ROUTE);
  renderHeat();
  renderRank();
  renderMap();
  $("#loading").hidden = true;

  let w = innerWidth;
  addEventListener("resize", () => {
    if (Math.abs(innerWidth - w) < 40) return;
    w = innerWidth;
    renderAll();
  });
}

main();
