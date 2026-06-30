import Globe from 'globe.gl';
import './style.css';

import countries, { FIELD_META } from './data/countries.js';
import worldGeo from './data/world.json';
import {
  formatValue,
  density,
  featureCode,
  featureName,
  buildProfile,
} from './lib/format.js';
import { fetchHeadlines, sourceLinks, timeAgo } from './lib/news.js';

/* ------------------------------------------------------------------ *
 *  Data prep
 * ------------------------------------------------------------------ */

// Keep only real countries (drop Antarctica & similar non-clickable masses).
const features = worldGeo.features.filter(
  (f) => featureName(f.properties) !== 'Antarctica'
);

// Build a quick lookup + search index and stash a rough centroid per feature.
const index = features.map((f) => {
  const code = featureCode(f.properties);
  const profile = buildProfile(f.properties, code ? countries[code] : null);
  const [lng, lat] = featureCentroid(f);
  f.__profile = profile;
  f.__center = { lat, lng };
  return { code, name: profile.name, flag: profile.flag, region: profile.region, lat, lng, feature: f };
});
index.sort((a, b) => a.name.localeCompare(b.name));

/* ------------------------------------------------------------------ *
 *  Region palette (default coloring) + metric color scale
 * ------------------------------------------------------------------ */

const REGION_COLORS = {
  'North America': '#4f8cff',
  'South America': '#33c2a6',
  'Central America': '#3bb3c9',
  Caribbean: '#3bb0e0',
  Europe: '#8a7bff',
  Africa: '#f2a154',
  Asia: '#ff7b9c',
  'Middle East': '#e0b341',
  Oceania: '#5ad1a0',
};
function regionColor(region) {
  return REGION_COLORS[region] || '#6b7a9c';
}

// 5-stop perceptual-ish scale matching the CSS legend.
const SCALE = ['#2a3a66', '#5b9dff', '#8a7bff', '#f6c177', '#f87272'].map(hexToRgb);
function colorScale(t) {
  t = Math.max(0, Math.min(1, t));
  const seg = t * (SCALE.length - 1);
  const i = Math.floor(seg);
  const f = seg - i;
  const a = SCALE[i];
  const b = SCALE[Math.min(i + 1, SCALE.length - 1)];
  const mix = (k) => Math.round(a[k] + (b[k] - a[k]) * f);
  return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`;
}

/* ------------------------------------------------------------------ *
 *  App state
 * ------------------------------------------------------------------ */

const state = {
  colorBy: 'none',
  selected: null, // feature
  compareMode: false,
  slots: [null, null], // feature | null
  activeSlot: 0,
  metricRange: null, // {min,max} for current colorBy
};

/* ------------------------------------------------------------------ *
 *  Globe setup
 * ------------------------------------------------------------------ */

const globeEl = document.getElementById('globe');
const world = new Globe(globeEl, { animateIn: true })
  .backgroundColor('rgba(4, 7, 14, 1)')
  .showGlobe(true)
  .showAtmosphere(true)
  .atmosphereColor('#5b9dff')
  .atmosphereAltitude(0.18)
  .polygonsData(features)
  .polygonCapColor(capColor)
  .polygonSideColor(() => 'rgba(91, 157, 255, 0.12)')
  .polygonStrokeColor(() => 'rgba(220, 232, 255, 0.35)')
  .polygonAltitude(polyAltitude)
  .polygonLabel(polyLabel)
  .polygonsTransitionDuration(280)
  .onPolygonClick(onCountryClick)
  .onPolygonHover(onCountryHover);

// Deep-ocean globe material (no external texture needed).
world.globeMaterial().color.set('#0c1830');
world.globeMaterial().emissive.set('#06101f');
world.globeMaterial().emissiveIntensity = 0.35;
world.globeMaterial().shininess = 8;

// Gentle auto-rotate until the user interacts.
const controls = world.controls();
controls.autoRotate = true;
controls.autoRotateSpeed = 0.45;
controls.minDistance = 180;
controls.maxDistance = 600;
['mousedown', 'touchstart', 'wheel'].forEach((ev) =>
  globeEl.addEventListener(ev, () => { controls.autoRotate = false; }, { passive: true })
);

world.pointOfView({ lat: 20, lng: 10, altitude: 2.5 }, 0);

function sizeGlobe() {
  world.width(window.innerWidth).height(window.innerHeight);
}
sizeGlobe();
window.addEventListener('resize', sizeGlobe);

// Hide the loader once the first frame is up.
requestAnimationFrame(() => {
  setTimeout(() => document.getElementById('loader').classList.add('hide'), 350);
});

/* ------------------------------------------------------------------ *
 *  Globe accessors (color / altitude / label / events)
 * ------------------------------------------------------------------ */

let hovered = null;

function capColor(feat) {
  if (feat === state.selected) return '#ffffff';
  if (state.slots.includes(feat)) return '#36d399';
  if (feat === hovered) return '#cfe0ff';

  if (state.colorBy !== 'none' && state.metricRange) {
    const t = metricT(feat, state.colorBy);
    if (t === null) return 'rgba(120, 140, 175, 0.35)';
    return colorScale(t);
  }
  return regionColor(feat.__profile.region);
}

function polyAltitude(feat) {
  if (feat === state.selected) return 0.16;
  if (state.slots.includes(feat)) return 0.1;
  if (feat === hovered) return 0.06;
  return 0.012;
}

function polyLabel(feat) {
  const p = feat.__profile;
  const gdp = formatValue(p.gdp, 'usdB');
  const pop = formatValue(p.population, 'millions');
  return `
    <div style="font: 13px Inter, sans-serif; color:#fff; background:rgba(12,18,32,0.92);
                border:1px solid rgba(120,160,255,0.3); padding:8px 11px; border-radius:10px;
                box-shadow:0 8px 24px rgba(0,0,0,0.5)">
      <div style="font-size:15px; font-weight:700">${p.flag} ${p.name}</div>
      <div style="color:#93a0bd; font-size:11px; margin-top:3px">
        GDP ${gdp} · Pop ${pop}${p.curated ? '' : ' · limited data'}
      </div>
    </div>`;
}

function onCountryHover(feat) {
  hovered = feat;
  globeEl.style.cursor = feat ? 'pointer' : 'grab';
  world.polygonAltitude(polyAltitude).polygonCapColor(capColor);
}

function onCountryClick(feat) {
  controls.autoRotate = false;
  if (state.compareMode) {
    assignSlot(feat);
    return;
  }
  selectCountry(feat, { focus: true });
}

/* ------------------------------------------------------------------ *
 *  Metric coloring helpers
 * ------------------------------------------------------------------ */

function metricValue(feat, key) {
  const v = feat.__profile[key];
  return v === null || v === undefined || Number.isNaN(v) ? null : v;
}

// Normalised 0..1 where 1 = "hotter" end of the scale.
function metricT(feat, key) {
  const v = metricValue(feat, key);
  if (v === null || !state.metricRange) return null;
  const { min, max } = state.metricRange;
  if (max === min) return 0.5;
  let t = (v - min) / (max - min);
  // For "lower is better" metrics, invert so strong/healthy = cool end.
  if (FIELD_META[key] && FIELD_META[key].higher === false && key === 'militaryRank') {
    t = 1 - t;
  }
  return t;
}

function computeRange(key) {
  const vals = features.map((f) => metricValue(f, key)).filter((v) => v !== null);
  if (!vals.length) return null;
  return { min: Math.min(...vals), max: Math.max(...vals) };
}

function setColorBy(key) {
  state.colorBy = key;
  state.metricRange = key === 'none' ? null : computeRange(key);
  world.polygonCapColor(capColor);
  renderLegend();
}

/* ------------------------------------------------------------------ *
 *  Country selection + info panel
 * ------------------------------------------------------------------ */

let newsAbort = null;

function selectCountry(feat, { focus = false } = {}) {
  state.selected = feat;
  world.polygonAltitude(polyAltitude).polygonCapColor(capColor);
  if (focus) focusOn(feat);
  renderPanel(feat);
}

function focusOn(feat) {
  const { lat, lng } = feat.__center;
  world.pointOfView({ lat, lng, altitude: 1.7 }, 900);
}

const panel = document.getElementById('panel');

function statCard(label, value, sub, icon) {
  return `
    <div class="stat">
      <div class="stat-label">${icon ? `<span>${icon}</span>` : ''}${label}</div>
      <div class="stat-value${String(value).length > 8 ? ' small' : ''}">${value}</div>
      ${sub ? `<div class="stat-sub">${sub}</div>` : ''}
    </div>`;
}

function renderPanel(feat) {
  const p = feat.__profile;
  const dens = density(p);
  const rankWorld = p.militaryRank ? worldMilitaryNote(p.militaryRank) : null;

  const chips = [
    p.capital && `🏛️ ${p.capital}`,
    p.region && `📍 ${p.region}`,
    p.gov && `🏷️ ${p.gov}`,
    p.currency && `💱 ${p.currency}`,
  ].filter(Boolean);

  const cards = [
    statCard('GDP (nominal)', formatValue(p.gdp, 'usdB'), 'Total economic output', '💰'),
    statCard('GDP per capita', formatValue(p.gdpPerCapita, 'usd'), 'Per person', '👤'),
    statCard('Population', formatValue(p.population, 'millions'), dens ? `${Math.round(dens)} /km²` : '', '👥'),
    statCard('HDI', formatValue(p.hdi, 'hdi'), hdiTier(p.hdi), '📈'),
    statCard('Military strength', formatValue(p.militaryRank, 'rank'), rankWorld, '🛡️'),
    statCard('Inflation', formatValue(p.inflation, 'pct'), 'Annual CPI', '🔥'),
    statCard('Area', formatValue(p.area, 'km2'), '', '🗺️'),
  ].join('');

  panel.innerHTML = `
    <div class="panel-header">
      <button class="panel-close" title="Close" aria-label="Close">✕</button>
      <div class="panel-title">
        <span class="panel-flag">${p.flag}</span>
        <div>
          <h2>${p.name}</h2>
          <p class="panel-sub">${p.curated ? 'Key indicators' : 'Limited data — derived from map dataset'}</p>
        </div>
      </div>
    </div>
    <div class="panel-body">
      ${chips.length ? `<div class="meta-row">${chips.map((c) => `<span class="chip">${c}</span>`).join('')}</div>` : ''}
      <div class="stat-grid">${cards}</div>

      <div class="section-title">📰 Recent news</div>
      <div id="news" class="news-list">
        <div class="news-skeleton"></div>
        <div class="news-skeleton"></div>
        <div class="news-skeleton"></div>
      </div>
      <div class="source-links">
        ${sourceLinks(p.name).map((l) => `<a class="source-link" href="${l.url}" target="_blank" rel="noopener">${l.label} ↗</a>`).join('')}
      </div>

      <div class="panel-actions">
        <button class="btn" id="panel-compare">⚖️ Compare this country</button>
      </div>
    </div>`;

  panel.hidden = false;
  panel.scrollTop = 0;
  panel.querySelector('.panel-close').addEventListener('click', closePanel);
  panel.querySelector('#panel-compare').addEventListener('click', () => startCompareWith(feat));

  loadNews(p.name);
}

function closePanel() {
  panel.hidden = true;
  state.selected = null;
  if (newsAbort) newsAbort.abort();
  world.polygonAltitude(polyAltitude).polygonCapColor(capColor);
}

async function loadNews(countryName) {
  if (newsAbort) newsAbort.abort();
  newsAbort = new AbortController();
  const container = document.getElementById('news');
  try {
    const items = await fetchHeadlines(countryName, { signal: newsAbort.signal });
    if (!container.isConnected) return;
    if (!items.length) {
      container.innerHTML = `<div class="news-status">Live headlines couldn't be loaded right now — use the sources below to read the latest on ${countryName}.</div>`;
      return;
    }
    container.innerHTML = items
      .map(
        (n) => `
        <a class="news-item" href="${n.link}" target="_blank" rel="noopener">
          <div class="news-headline">${escapeHtml(n.headline)}</div>
          <div class="news-meta">
            ${n.source ? `<span>${escapeHtml(n.source)}</span>` : ''}
            ${n.pubDate ? `<span>· ${timeAgo(n.pubDate)}</span>` : ''}
          </div>
        </a>`
      )
      .join('');
  } catch (err) {
    if (err?.name === 'AbortError') return;
    if (container.isConnected) {
      container.innerHTML = `<div class="news-status">Couldn't reach the news service — try the source links below.</div>`;
    }
  }
}

/* ------------------------------------------------------------------ *
 *  Comparison tool
 * ------------------------------------------------------------------ */

const compareToggle = document.getElementById('compare-toggle');
const compareTray = document.getElementById('compare-tray');
const compareRun = document.getElementById('compare-run');
const compareExit = document.getElementById('compare-exit');
const compareModal = document.getElementById('compare-modal');
const compareCard = document.getElementById('compare-card');

function setCompareMode(on) {
  state.compareMode = on;
  compareToggle.classList.toggle('active', on);
  compareTray.hidden = !on;
  if (on) {
    closePanel();
    controls.autoRotate = false;
  } else {
    state.slots = [null, null];
    state.activeSlot = 0;
    world.polygonAltitude(polyAltitude).polygonCapColor(capColor);
  }
  renderTray();
}

function startCompareWith(feat) {
  setCompareMode(true);
  state.slots = [feat, null];
  state.activeSlot = 1;
  world.polygonCapColor(capColor).polygonAltitude(polyAltitude);
  renderTray();
}

function assignSlot(feat) {
  // Avoid the same country in both slots.
  const other = state.slots[1 - state.activeSlot];
  if (other === feat) return;
  state.slots[state.activeSlot] = feat;
  // Advance to the empty slot if there is one.
  if (!state.slots[0]) state.activeSlot = 0;
  else if (!state.slots[1]) state.activeSlot = 1;
  else state.activeSlot = state.activeSlot === 0 ? 1 : 0;
  world.polygonCapColor(capColor).polygonAltitude(polyAltitude);
  renderTray();
}

function renderTray() {
  const slotEls = compareTray.querySelectorAll('.tray-slot');
  slotEls.forEach((el, i) => {
    const feat = state.slots[i];
    el.classList.toggle('filled', !!feat);
    el.classList.toggle('active', state.activeSlot === i && state.compareMode);
    el.querySelector('.slot-flag').textContent = feat ? feat.__profile.flag : '＋';
    el.querySelector('.slot-name').textContent = feat ? feat.__profile.name : `Country ${i === 0 ? 'A' : 'B'}`;
  });
  compareRun.disabled = !(state.slots[0] && state.slots[1]);
}

compareToggle.addEventListener('click', () => setCompareMode(!state.compareMode));
compareExit.addEventListener('click', () => setCompareMode(false));
compareTray.querySelectorAll('.tray-slot').forEach((el) => {
  el.addEventListener('click', () => {
    state.activeSlot = Number(el.dataset.slot);
    renderTray();
  });
});
compareRun.addEventListener('click', () => {
  if (state.slots[0] && state.slots[1]) renderComparison(state.slots[0], state.slots[1]);
});

const COMPARE_METRICS = [
  { key: 'gdp', format: 'usdB', higher: true, icon: '💰' },
  { key: 'gdpPerCapita', format: 'usd', higher: true, icon: '👤' },
  { key: 'population', format: 'millions', higher: true, icon: '👥' },
  { key: 'hdi', format: 'hdi', higher: true, icon: '📈' },
  { key: 'militaryRank', format: 'rank', higher: false, icon: '🛡️' },
  { key: 'inflation', format: 'pct', higher: false, icon: '🔥' },
  { key: 'area', format: 'km2', higher: true, icon: '🗺️' },
];

function renderComparison(fa, fb) {
  const a = fa.__profile;
  const b = fb.__profile;
  let winsA = 0;
  let winsB = 0;

  const rows = COMPARE_METRICS.map((m) => {
    const va = a[m.key];
    const vb = b[m.key];
    const meta = FIELD_META[m.key] || {};
    const label = meta.label || m.key;
    const hasBoth = va != null && vb != null;

    let winner = 0; // -1 a, 1 b, 0 none
    if (hasBoth && va !== vb) {
      const aBetter = m.higher ? va > vb : va < vb;
      winner = aBetter ? -1 : 1;
      if (aBetter) winsA++; else winsB++;
    }

    // Fuller bar always = better.
    let fillA = 0;
    let fillB = 0;
    if (hasBoth) {
      if (m.higher) {
        const mx = Math.max(va, vb) || 1;
        fillA = va / mx; fillB = vb / mx;
      } else {
        const mn = Math.min(va, vb) || 1;
        fillA = mn / (va || 1); fillB = mn / (vb || 1);
      }
    }

    return `
      <div class="cmp-metric">
        <div class="cmp-metric-label">${m.icon} ${label}</div>
        <div class="cmp-bars">
          <div class="cmp-val left ${winner === -1 ? 'win' : ''}">${formatValue(va, m.format)}</div>
          <div class="cmp-center">${m.higher ? 'higher = better' : 'lower = better'}</div>
          <div class="cmp-val right ${winner === 1 ? 'win' : ''}">${formatValue(vb, m.format)}</div>
        </div>
        <div class="cmp-bar-row" style="margin-top:8px">
          <div class="cmp-track left"><span class="fill" style="width:${(fillA * 100).toFixed(1)}%"></span></div>
          <div class="cmp-track right"><span class="fill" style="width:${(fillB * 100).toFixed(1)}%"></span></div>
        </div>
      </div>`;
  }).join('');

  const verdict =
    winsA === winsB
      ? `Even — ${winsA} metric${winsA === 1 ? '' : 's'} each`
      : `${winsA > winsB ? a.name : b.name} leads ${Math.max(winsA, winsB)}–${Math.min(winsA, winsB)} across metrics`;

  compareCard.innerHTML = `
    <button class="modal-close" title="Close" aria-label="Close">✕</button>
    <div class="cmp-head">
      <div class="cmp-country">
        <div class="cmp-flag">${a.flag}</div>
        <h3>${a.name}</h3>
        <p>${a.capital || a.region || ''}</p>
      </div>
      <div class="cmp-vs">VS</div>
      <div class="cmp-country">
        <div class="cmp-flag">${b.flag}</div>
        <h3>${b.name}</h3>
        <p>${b.capital || b.region || ''}</p>
      </div>
    </div>
    <div class="cmp-body">
      <div class="cmp-metric-label" style="font-size:13px;color:#bcd1ff;margin-bottom:6px">🏆 ${verdict}</div>
      ${rows}
    </div>`;

  compareModal.hidden = false;
  compareCard.querySelector('.modal-close').addEventListener('click', closeModal);
}

function closeModal() {
  compareModal.hidden = true;
}
compareModal.querySelector('.modal-backdrop').addEventListener('click', closeModal);

/* ------------------------------------------------------------------ *
 *  Color-by control + legend
 * ------------------------------------------------------------------ */

const colorBySelect = document.getElementById('color-by');
colorBySelect.addEventListener('change', () => setColorBy(colorBySelect.value));

const legend = document.getElementById('legend');
function renderLegend() {
  if (state.colorBy === 'none' || !state.metricRange) {
    legend.hidden = true;
    return;
  }
  const meta = FIELD_META[state.colorBy];
  const { min, max } = state.metricRange;
  document.getElementById('legend-label').textContent = `${meta.label}${meta.higher === false ? ' (lower = better)' : ''}`;
  // For inverted scales show the labels accordingly.
  const lowLabel = formatValue(min, meta.format);
  const highLabel = formatValue(max, meta.format);
  document.getElementById('legend-min').textContent = state.colorBy === 'militaryRank' ? highLabel : lowLabel;
  document.getElementById('legend-max').textContent = state.colorBy === 'militaryRank' ? lowLabel : highLabel;
  legend.hidden = false;
}

/* ------------------------------------------------------------------ *
 *  Search
 * ------------------------------------------------------------------ */

const searchInput = document.getElementById('search');
const searchResults = document.getElementById('search-results');
let activeResult = -1;

function runSearch(q) {
  q = q.trim().toLowerCase();
  if (!q) {
    searchResults.hidden = true;
    return;
  }
  const matches = index
    .filter((c) => c.name.toLowerCase().includes(q))
    .slice(0, 8);
  if (!matches.length) {
    searchResults.innerHTML = `<li style="color:var(--text-dim);cursor:default">No match</li>`;
    searchResults.hidden = false;
    return;
  }
  activeResult = -1;
  searchResults.innerHTML = matches
    .map(
      (m, i) => `
      <li data-code="${m.code}" data-i="${i}">
        <span class="res-flag">${m.flag}</span>
        <span>${m.name}</span>
        <span class="res-region">${m.region || ''}</span>
      </li>`
    )
    .join('');
  searchResults.hidden = false;
  searchResults.querySelectorAll('li[data-code]').forEach((li) => {
    li.addEventListener('click', () => pickSearch(li.dataset.code));
  });
}

function pickSearch(code) {
  const entry = index.find((c) => c.code === code);
  if (!entry) return;
  searchInput.value = '';
  searchResults.hidden = true;
  controls.autoRotate = false;
  if (state.compareMode) {
    assignSlot(entry.feature);
  } else {
    selectCountry(entry.feature, { focus: true });
  }
}

searchInput.addEventListener('input', () => runSearch(searchInput.value));
searchInput.addEventListener('keydown', (e) => {
  const items = [...searchResults.querySelectorAll('li[data-code]')];
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeResult = Math.min(activeResult + 1, items.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeResult = Math.max(activeResult - 1, 0);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const pick = items[activeResult] || items[0];
    if (pick) pickSearch(pick.dataset.code);
    return;
  } else if (e.key === 'Escape') {
    searchResults.hidden = true;
    return;
  }
  items.forEach((li, i) => li.classList.toggle('active', i === activeResult));
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-wrap')) searchResults.hidden = true;
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!compareModal.hidden) closeModal();
    else if (!panel.hidden) closePanel();
  }
});

/* ------------------------------------------------------------------ *
 *  Small utilities
 * ------------------------------------------------------------------ */

function featureCentroid(feature) {
  const geom = feature.geometry;
  let ring;
  if (geom.type === 'Polygon') {
    ring = geom.coordinates[0];
  } else if (geom.type === 'MultiPolygon') {
    // Use the polygon with the most points (roughly the largest landmass).
    ring = geom.coordinates.reduce((best, poly) =>
      poly[0].length > (best?.length || 0) ? poly[0] : best, null);
  }
  if (!ring || !ring.length) return [0, 0];
  let x = 0;
  let y = 0;
  ring.forEach(([lng, lat]) => { x += lng; y += lat; });
  return [x / ring.length, y / ring.length];
}

function hdiTier(hdi) {
  if (hdi == null) return '';
  if (hdi >= 0.8) return 'Very high';
  if (hdi >= 0.7) return 'High';
  if (hdi >= 0.55) return 'Medium';
  return 'Low';
}

function worldMilitaryNote(rank) {
  if (rank <= 10) return 'Top-10 globally';
  if (rank <= 30) return 'Major power';
  if (rank <= 60) return 'Mid-tier';
  return 'Smaller force';
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// Expose a tiny bit for debugging in the console.
window.__geoglobe = { world, state, index };
