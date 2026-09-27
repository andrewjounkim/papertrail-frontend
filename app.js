// ---------------------------------------------------------------------
// PaperTrail frontend. Everything the backend needs is behind API_BASE —
// switch this one constant between local dev and the deployed Render URL.
// ---------------------------------------------------------------------
const API_BASE = "https://papertrail-backend-un64.onrender.com";

const LEVELS = ["high_school", "undergrad", "expert"];

// --- Small DOM helpers ---------------------------------------------------

const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove("hidden");
const hide = (el) => el.classList.add("hidden");

function setLoading(prefix, isLoading) {
  const loadingEl = $(`${prefix}-loading`);
  if (loadingEl) loadingEl.classList.toggle("hidden", !isLoading);
}

function setError(prefix, message) {
  const errEl = $(`${prefix}-error`);
  if (!errEl) return;
  if (message) {
    errEl.textContent = message;
    show(errEl);
  } else {
    hide(errEl);
  }
}

// --- Networking ------------------------------------------------------------

/**
 * POST JSON to the backend with a timeout, and turn every failure mode
 * (network error / bad input / not found / upstream failure) into one
 * friendly Error the UI can just display.
 */
async function apiPost(path, body, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(
        "The server took too long to respond. It may still be waking up from sleep — please try again in a moment."
      );
    }
    throw new Error(
      "Could not reach the server. It may be asleep (free-tier backends take up to a minute to wake) or offline — please try again shortly."
    );
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try {
    data = await resp.json();
  } catch {
    // fall through: resp.ok check below will produce a generic message
  }

  if (!resp.ok) {
    const backendMessage = data && data.error;
    if (resp.status >= 500) {
      throw new Error(
        backendMessage
          ? `Upstream error: ${backendMessage}`
          : "The server hit an upstream error (PubMed, iCite, or the AI service). Please try again."
      );
    }
    throw new Error(backendMessage || `Request failed (HTTP ${resp.status}).`);
  }

  return data;
}

async function apiGet(path, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${API_BASE}${path}`, { signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

// --- Server wake-up banner --------------------------------------------

async function checkServerHealth() {
  const banner = $("server-banner");
  const slowTimer = setTimeout(() => {
    banner.textContent = "Waking up the server, this can take up to a minute…";
    show(banner);
  }, 1500);

  try {
    await apiGet("/health", 60000);
    clearTimeout(slowTimer);
    hide(banner);
  } catch {
    clearTimeout(slowTimer);
    banner.textContent =
      "Can't reach the backend right now. Double-check it's running, then reload this page.";
    show(banner);
  }
}

// --- Paper lookup ----------------------------------------------------------

let currentPmid = null;

async function lookupPaper(rawInput) {
  setError("paper", null);
  const trimmed = (rawInput || "").trim();
  if (!trimmed) {
    setError("paper", "Enter a PMID, PubMed URL, or DOI first.");
    return;
  }

  show($("paper-section"));
  hide($("paper-content"));
  setLoading("paper", true);
  hide($("explain-section"));
  hide($("whatnext-section"));
  hide($("trend-section"));

  $("paper-submit").disabled = true;
  try {
    const paper = await apiPost("/api/paper", { input: trimmed });
    currentPmid = paper.pmid;
    renderPaper(paper);
    show($("explain-section"));
    show($("whatnext-section"));
    show($("trend-section"));

    // Independent sections: one slow/failing section never blocks the others.
    loadExplain(currentPmid, LEVELS[Number($("level-slider").value)]);
    loadWhatNext(currentPmid);
    loadTrend(currentPmid, null);
  } catch (err) {
    setError("paper", err.message);
    hide($("paper-section"));
  } finally {
    setLoading("paper", false);
    $("paper-submit").disabled = false;
  }
}

function renderPaper(paper) {
  $("paper-title").textContent = paper.title;
  const authors = paper.authors && paper.authors.length ? paper.authors.join(", ") : "Unknown authors";
  $("paper-meta").textContent = `${authors} — ${paper.journal || "Unknown journal"}${paper.year ? ` (${paper.year})` : ""}`;

  const rcr =
    paper.relative_citation_ratio === null || paper.relative_citation_ratio === undefined
      ? "n/a"
      : paper.relative_citation_ratio.toFixed(2);
  $("paper-stats").innerHTML = `<strong>${paper.citation_count}</strong> citations &nbsp;·&nbsp; Relative Citation Ratio: <strong>${rcr}</strong>`;

  $("paper-abstract").textContent = paper.abstract || "(No abstract available.)";
  $("paper-link").href = paper.pubmed_url;

  show($("paper-content"));
}

// --- Explain slider -------------------------------------------------

let lastExplainKey = null; // `${pmid}:${level}` — must include pmid, or switching papers at the same slider position would skip the fetch and show stale text

async function loadExplain(pmid, level) {
  if (pmid !== currentPmid) return;
  const key = `${pmid}:${level}`;
  if (key === lastExplainKey) return; // avoid redundant re-fetch while dragging the slider
  lastExplainKey = key;

  setError("explain", null);
  setLoading("explain", true);
  try {
    const result = await apiPost("/api/explain", { pmid, level });
    if (pmid !== currentPmid) return; // a newer paper lookup superseded this one
    $("explain-text").textContent = result.explanation;
  } catch (err) {
    if (pmid !== currentPmid) return;
    setError("explain", err.message);
  } finally {
    if (pmid === currentPmid) setLoading("explain", false);
  }
}

// --- What happened next -------------------------------------------------

async function loadWhatNext(pmid) {
  setError("whatnext", null);
  hide($("whatnext-content"));
  setLoading("whatnext", true);
  try {
    const result = await apiPost("/api/what-next", { pmid }, 30000);
    if (pmid !== currentPmid) return;

    $("whatnext-count").textContent = `${result.citation_count} total citation${result.citation_count === 1 ? "" : "s"}`;
    $("whatnext-summary").textContent = result.summary;

    const list = $("whatnext-list");
    list.innerHTML = "";
    result.citing_papers.forEach((p) => {
      const li = document.createElement("li");

      const link = document.createElement("a");
      link.href = p.pubmed_url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = p.title;

      const yearSpan = document.createElement("span");
      yearSpan.className = "citing-year";
      yearSpan.textContent = ` (${p.year || "n.d."}${p.journal ? `, ${p.journal}` : ""})`;

      li.appendChild(link);
      li.appendChild(yearSpan);
      list.appendChild(li);
    });

    show($("whatnext-content"));
  } catch (err) {
    if (pmid !== currentPmid) return;
    setError("whatnext", err.message);
  } finally {
    if (pmid === currentPmid) setLoading("whatnext", false);
  }
}

// --- Trend chart -------------------------------------------------------

let trendChart = null;

async function loadTrend(pmid, query) {
  setError("trend", null);
  hide($("trend-content"));
  setLoading("trend", true);
  try {
    const body = query ? { pmid, query } : { pmid };
    const result = await apiPost("/api/trend", body, 45000); // ~20 sequential PubMed calls server-side
    if (pmid !== currentPmid) return;

    $("trend-query").value = result.query;
    renderTrendChart(result.years, result.counts);
    show($("trend-content"));
  } catch (err) {
    if (pmid !== currentPmid) return;
    setError("trend", err.message);
  } finally {
    if (pmid === currentPmid) setLoading("trend", false);
  }
}

function renderTrendChart(years, counts) {
  const ctx = $("trend-chart").getContext("2d");
  if (trendChart) trendChart.destroy();
  trendChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: years,
      datasets: [
        {
          label: "PubMed articles published",
          data: counts,
          borderColor: "#3457d5",
          backgroundColor: "rgba(52, 87, 213, 0.12)",
          fill: true,
          tension: 0.25,
          pointRadius: 3,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, title: { display: true, text: "Articles / year" } },
      },
    },
  });
}

// --- Wire up events ------------------------------------------------------

$("paper-form").addEventListener("submit", (e) => {
  e.preventDefault();
  lookupPaper($("paper-input").value);
});

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    $("paper-input").value = chip.dataset.value;
    lookupPaper(chip.dataset.value);
  });
});

$("level-slider").addEventListener("input", () => {
  if (!currentPmid) return;
  loadExplain(currentPmid, LEVELS[Number($("level-slider").value)]);
});

$("trend-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!currentPmid) return;
  const edited = $("trend-query").value.trim();
  if (!edited) return;
  loadTrend(currentPmid, edited);
});

checkServerHealth();
