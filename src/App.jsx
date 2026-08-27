import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip,
  ComposedChart,
  Bar,
  Scatter,
  Customized,
} from "recharts";
import {
  TrendingUp,
  TrendingDown,
  Radar,
  ChevronRight,
  AlertTriangle,
  Wallet,
  History,
  Zap,
  Settings,
  RefreshCw,
  X,
  Activity,
} from "lucide-react";

const CONVICTION_BUY = 72;
const CONVICTION_SELL = 30;
const TOTAL_START = 2000; // $1000 stocks + $1000 crypto, seeded by the backend on migrate
const BACKEND_URL_KEY = "desk-backend-url";
const POLL_MS = 30000; // pick up server-side cron trades without a manual refresh
const RETRY_MS = 5000; // retry sooner while unreachable (e.g. a free-tier host waking from sleep)

// ---------- backend calls ----------
function normalizeUrl(u) {
  return u.trim().replace(/\/+$/, "");
}

async function fetchState(backendUrl) {
  const res = await fetch(`${backendUrl}/api/desk/state`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Backend returned ${res.status}${body ? `: ${body.slice(0, 150)}` : ""}`,
    );
  }
  const data = await res.json();
  const s = data.state || {};

  const candidates = (data.candidates || [])
    .map((c) => ({
      ticker: c.ticker,
      name: c.name,
      sector: c.sector,
      cls: c.cls,
      price: Number(c.price),
      confidence: Math.round(c.confidence),
      targetPrice: c.target_price != null ? Number(c.target_price) : null,
      supplierNote: c.supplier_note || "No supply-chain note returned.",
      riskNote: c.risk_note || "No risk note returned.",
    }))
    .sort((a, b) => b.confidence - a.confidence);

  const holdings = {};
  (data.holdings || []).forEach((h) => {
    holdings[h.ticker] = {
      qty: Number(h.shares),
      avgCost: Number(h.avg_price),
      cls: h.cls,
      name: h.name,
    };
  });

  const prices = {};
  const targets = {};
  candidates.forEach((c) => {
    prices[c.ticker] = c.price;
    targets[c.ticker] = c.targetPrice;
  });

  const trades = (data.trades || []).map((t) => ({
    day: t.day_count,
    action: (t.action || "").toUpperCase(),
    ticker: t.ticker,
    qty: Number(t.shares),
    price: Number(t.price),
    confidence: t.confidence,
    cls: t.cls,
    reason: t.reason || null,
    createdAt: t.created_at || null,
  }));

  const history = (data.history || []).map((h) => ({
    day: h.day_count,
    value: Number(h.total_value),
  }));

  const intradayPositions = (data.intradayPositions || []).map((p) => ({
    ticker: p.ticker,
    cls: p.cls,
    shares: Number(p.shares),
    entryPrice: Number(p.entry_price),
    openedAt: p.opened_at,
  }));
  const intradayPrices = data.intradayLatestPrices || {};

  return {
    day: s.day_count || 0,
    cash: {
      stocks: Number(s.cash_stocks || 0),
      crypto: Number(s.cash_crypto || 0),
    },
    intradayCash: {
      stocks: Number(s.intraday_cash_stocks || 0),
      crypto: Number(s.intraday_cash_crypto || 0),
    },
    holdings,
    prices,
    targets,
    candidates,
    trades,
    history,
    intradayPositions,
    intradayPrices,
    updatedAt: s.updated_at || null,
  };
}

async function triggerScan(backendUrl) {
  const res = await fetch(`${backendUrl}/api/desk/scan`, { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Scan failed (${res.status})`);
  }
  return res.json();
}

function pct(n) {
  return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
}
function usd(n) {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: n < 5 ? 4 : 2,
  });
}
function timeAgo(iso) {
  if (!iso) return "";
  const mins = Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 60000),
  );
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

// A "Failed to fetch" is the browser's generic network-error message - it
// fires before any HTTP response comes back at all, which on this app is
// almost always the free-tier backend host waking up from an idle sleep
// rather than a real outage. Surface that plainly instead of the scary
// raw browser message.
function friendlyConnError(message) {
  if (message && message.includes("Failed to fetch")) {
    return "Backend is waking up from an idle sleep (free hosting spins it down after inactivity) - this can take up to a minute. Retrying automatically.";
  }
  return message;
}

function buildCandles(points, targetCandles = 40) {
  if (!points || points.length === 0) return [];
  const sorted = [...points].sort((a, b) => a.time - b.time);
  if (sorted.length === 1) {
    const p = sorted[0];
    return [
      {
        time: p.time,
        open: p.price,
        high: p.price,
        low: p.price,
        close: p.price,
      },
    ];
  }
  const span = sorted[sorted.length - 1].time - sorted[0].time;
  const bucketMs = Math.max(
    10000,
    Math.round(span / targetCandles / 1000) * 1000,
  );
  const buckets = new Map();
  for (const p of sorted) {
    const start = Math.floor(p.time / bucketMs) * bucketMs;
    const existing = buckets.get(start);
    if (!existing) {
      buckets.set(start, {
        time: start,
        open: p.price,
        high: p.price,
        low: p.price,
        close: p.price,
      });
    } else {
      existing.high = Math.max(existing.high, p.price);
      existing.low = Math.min(existing.low, p.price);
      existing.close = p.price;
    }
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

function bucketTradeTime(ts, bucketMs) {
  return Math.floor(ts / bucketMs) * bucketMs;
}

const fontDisplay = "'Fraunces', Georgia, serif";
const fontMono = "'IBM Plex Mono', 'SF Mono', monospace";
const fontUtil = "'Inter', system-ui, sans-serif";

const amber = "#E8A33D";
const mint = "#4FAE8C";
const red = "#C4453B";
const ink = "#0B1220";
const panel = "#121B2E";
const panel2 = "#182238";
const paper = "#EDE6D6";
const dim = "#8A93A6";

export default function TradingDesk() {
  const [backendUrl, setBackendUrl] = useState(null);
  const [urlChecked, setUrlChecked] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState("scan");
  const [scanError, setScanError] = useState(null);
  const [connError, setConnError] = useState(null);
  const pollRef = useRef(null);

  // live price chart: which ticker is selected, and its accumulated points
  const [chartTicker, setChartTicker] = useState(null);
  const [chartData, setChartData] = useState([]);

  // load saved backend URL once on mount
  useEffect(() => {
    (async () => {
      try {
        const stored = window.localStorage.getItem(BACKEND_URL_KEY);
        if (stored) {
          setBackendUrl(stored);
          setUrlInput(stored);
        }
      } catch (e) {
        // no saved URL yet — that's fine
      }
      setUrlChecked(true);
    })();
  }, []);

  const loadState = useCallback(async (url) => {
    setLoading(true);
    try {
      const next = await fetchState(url);
      setState(next);
      setConnError(null);
      return true;
    } catch (e) {
      setConnError(e.message || "Could not reach backend");
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  // once we have a backend URL, load state + poll - faster while unreachable
  // (e.g. a free-tier host cold-starting) so the dashboard recovers quickly,
  // then back to the normal cadence as soon as a request succeeds.
  useEffect(() => {
    if (!backendUrl) return;
    let cancelled = false;
    const tick = async () => {
      const ok = await loadState(backendUrl);
      if (cancelled) return;
      pollRef.current = setTimeout(tick, ok ? POLL_MS : RETRY_MS);
    };
    tick();
    return () => {
      cancelled = true;
      clearTimeout(pollRef.current);
    };
  }, [backendUrl, loadState]);

  const saveBackendUrl = async (raw) => {
    const url = normalizeUrl(raw);
    if (!url) return;
    try {
      window.localStorage.setItem(BACKEND_URL_KEY, url);
    } catch (e) {
      console.error("could not save backend url", e);
    }
    setBackendUrl(url);
    setSettingsOpen(false);
  };

  const runScan = async () => {
    if (!backendUrl || running) return;
    setRunning(true);
    setScanError(null);
    try {
      await triggerScan(backendUrl);
      await loadState(backendUrl);
    } catch (e) {
      setScanError(e.message || "Scan failed");
    } finally {
      setRunning(false);
    }
  };

  const portfolioValue = (s) => {
    let v = s.cash.stocks + s.cash.crypto;
    Object.entries(s.holdings).forEach(([t, h]) => {
      const price = s.prices[t] || h.avgCost;
      v += h.qty * price;
    });
    return v;
  };

  // Live chart's ticker universe: whatever's currently open, plus whatever the
  // daily scan rates buy-eligible - the same set the intraday engine can trade.
  // Computed unconditionally (state may still be null) so it can sit above the
  // early-return guards, next to the effect that depends on it.
  const bestStock = state
    ? (state.candidates || [])
        .filter((c) => c.cls === "stocks")
        .sort((a, b) => b.confidence - a.confidence)[0]
    : null;
  const bestCrypto = state
    ? (state.candidates || [])
        .filter((c) => c.cls === "crypto")
        .sort((a, b) => b.confidence - a.confidence)[0]
    : null;
  const openTickersForChart = state
    ? (state.intradayPositions || []).map((p) => p.ticker)
    : [];
  const bestTickers = [bestStock, bestCrypto]
    .filter(Boolean)
    .map((c) => c.ticker);
  const chartableTickers = [
    ...new Set([...openTickersForChart, ...bestTickers]),
  ];
  const activeChartTicker =
    chartTicker && chartableTickers.includes(chartTicker)
      ? chartTicker
      : chartableTickers[0] || null;
  const chartTickerCls = (() => {
    const openMatch =
      state &&
      (state.intradayPositions || []).find(
        (p) => p.ticker === activeChartTicker,
      );
    if (openMatch) return openMatch.cls;
    const candMatch =
      state &&
      (state.candidates || []).find((c) => c.ticker === activeChartTicker);
    return candMatch ? candMatch.cls : "crypto";
  })();

  // Seeds from recent price_ticks history, then polls a fresh quote every 8s
  // while the Intraday tab is open - independent of the 30s full-state poll,
  // so the chart visibly moves instead of only updating on the slow cycle.
  useEffect(() => {
    if (!backendUrl || !activeChartTicker) return;
    let cancelled = false;
    setChartData([]);
    const ticker = activeChartTicker;
    const cls = chartTickerCls;

    (async () => {
      try {
        const res = await fetch(
          `${backendUrl}/api/desk/price-history/${ticker}`,
        );
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (cancelled) return;
        setChartData(
          (data.ticks || []).map((t) => ({
            time: newDate(t.recorded_at).getTime(),
            price: Number(t.price),
          })),
        );
      } catch (e) {
        // history fetch failed - the chart just seeds empty and fills in live
      }
    })();

    const poll = async () => {
      try {
        const res = await fetch(
          `${backendUrl}/api/desk/quote/${ticker}?cls=${cls}`,
        );
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (cancelled || data.price == null) return;
        setChartData((prev) =>
          [...prev, { time: Date.now(), price: Number(data.price) }].slice(
            -150,
          ),
        );
      } catch (e) {
        // transient - next tick retries
      }
    };
    const id = setInterval(poll, 8000);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [backendUrl, activeChartTicker, chartTickerCls]);

  // ---------- setup screen: no backend URL saved yet ----------
  if (!urlChecked) {
    return <LoadingScreen label="loading desk…" />;
  }
  if (!backendUrl || settingsOpen) {
    return (
      <SetupScreen
        urlInput={urlInput}
        setUrlInput={setUrlInput}
        onSave={saveBackendUrl}
        onCancel={backendUrl ? () => setSettingsOpen(false) : null}
      />
    );
  }

  if (connError && !state) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: ink,
          color: paper,
          fontFamily: fontUtil,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
        }}
      >
        <div style={{ maxWidth: 340, textAlign: "center" }}>
          <div
            style={{
              fontFamily: fontDisplay,
              fontSize: 20,
              color: amber,
              marginBottom: 8,
            }}
          >
            Can't reach the desk.
          </div>
          <div
            style={{
              fontSize: 13,
              color: dim,
              marginBottom: 16,
              lineHeight: 1.5,
            }}
          >
            {friendlyConnError(connError)}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <button
              onClick={() => loadState(backendUrl)}
              style={btnStyle(amber, ink)}
            >
              <RefreshCw size={13} /> Retry
            </button>
            <button
              onClick={() => setSettingsOpen(true)}
              style={btnStyle("transparent", dim, `1px solid #26314A`)}
            >
              <Settings size={13} /> Backend URL
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (loading && !state) {
    return <LoadingScreen label="loading desk…" />;
  }
  if (!state) return null;

  const totalValue = portfolioValue(state);
  const totalChange = (totalValue - TOTAL_START) / TOTAL_START;
  const candidateByTicker = {};
  (state.candidates || []).forEach((c) => (candidateByTicker[c.ticker] = c));
  const holdingsList = Object.entries(state.holdings).map(([t, h]) => {
    const price = state.prices[t] || h.avgCost;
    const cand = candidateByTicker[t];
    const confidence = cand ? Math.round(cand.confidence) : null;
    const targetPrice =
      state.targets && state.targets[t] != null ? state.targets[t] : null;
    let signal = "HOLD";
    if (confidence != null) {
      if (confidence >= CONVICTION_BUY) signal = "BUY";
      else if (confidence < CONVICTION_SELL) signal = "SELL";
    }
    return {
      t,
      ...h,
      price,
      pl: (price - h.avgCost) / h.avgCost,
      val: h.qty * price,
      confidence,
      targetPrice,
      signal,
    };
  });

  const intradayList = (state.intradayPositions || []).map((p) => {
    const currentPrice = state.intradayPrices[p.ticker] ?? null;
    const pl =
      currentPrice != null
        ? (currentPrice - p.entryPrice) / p.entryPrice
        : null;
    return { ...p, currentPrice, pl };
  });
  const intradayValue =
    state.intradayCash.stocks +
    state.intradayCash.crypto +
    intradayList.reduce(
      (sum, p) => sum + p.shares * (p.currentPrice ?? p.entryPrice),
      0,
    );
  const intradayChange = (intradayValue - 200) / 200;
  const TRADE_SIZE_CLIENT = 50; // mirrors TRADE_SIZE in the backend's intradayEngine.js
  const intradayClosedToday = (state.trades || [])
    .filter(
      (t) =>
        t.createdAt &&
        new Date(t.createdAt).toDateString() === new Date().toDateString() &&
        (t.reason === "intraday take-profit" ||
          t.reason === "intraday stop-loss" ||
          t.reason === "intraday stagnant"),
    )
    .map((t) => {
      const pnl = t.qty * t.price - TRADE_SIZE_CLIENT;
      const win = pnl > 0;
      return { ...t, win, pnl };
    });
  const intradayWins = intradayClosedToday.filter((t) => t.win).length;
  const intradayLosses = intradayClosedToday.length - intradayWins;
  const intradayPnlToday = intradayClosedToday.reduce(
    (sum, t) => sum + t.pnl,
    0,
  );

  const candles = buildCandles(chartData, 20);
  const intradayTradeMarkers = (state.trades || [])
    .filter(
      (t) =>
        t.ticker === activeChartTicker &&
        t.reason &&
        t.reason.startsWith("intraday") &&
        t.createdAt,
    )
    .map((t) => ({
      time: new Date(t.createdAt).getTime(),
      price: t.price,
      action: t.action,
      reason: t.reason,
    }));

  const Dial = ({ score, size = 44 }) => {
    const color =
      score >= CONVICTION_BUY ? mint : score < CONVICTION_SELL ? red : amber;
    return (
      <div
        style={{
          position: "relative",
          width: size,
          height: size,
          flexShrink: 0,
        }}
      >
        <svg width={size} height={size} viewBox="0 0 44 44">
          <circle
            cx="22"
            cy="22"
            r="19"
            fill="none"
            stroke="#26314A"
            strokeWidth="3"
          />
          <circle
            cx="22"
            cy="22"
            r="19"
            fill="none"
            stroke={color}
            strokeWidth="3"
            strokeDasharray={`${(score / 100) * 119} 119`}
            strokeLinecap="round"
            transform="rotate(-90 22 22)"
          />
          <text
            x="22"
            y="26"
            textAnchor="middle"
            fontSize="12"
            fontFamily={fontMono}
            fill={paper}
            fontWeight="600"
          >
            {score}
          </text>
        </svg>
      </div>
    );
  };

  const TabBtn = ({ id, label, icon: Icon }) => (
    <button
      onClick={() => setTab(id)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "9px 14px",
        background: tab === id ? panel2 : "transparent",
        color: tab === id ? amber : dim,
        border: "none",
        borderBottom:
          tab === id ? `2px solid ${amber}` : "2px solid transparent",
        fontFamily: fontUtil,
        fontSize: 13,
        fontWeight: 600,
        cursor: "pointer",
        letterSpacing: 0.2,
      }}
    >
      <Icon size={14} /> {label}
    </button>
  );

  return (
    <div
      style={{
        minHeight: "100vh",
        background: ink,
        color: paper,
        fontFamily: fontUtil,
      }}
    >
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <style>{`
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,700&family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap');
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              * { box-sizing: border-box; }
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      body { margin: 0; }
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              ::-webkit-scrollbar { width: 6px; height: 6px; }
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      ::-webkit-scrollbar-thumb { background: #26314A; border-radius: 4px; }
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      .spin { animation: spin 0.8s linear infinite; }
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      .pulse { animation: pulse 1.4s ease-in-out infinite; }
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            `}</style>

      {/* header */}
      <div
        style={{ padding: "20px 16px 14px", borderBottom: `1px solid #1E293D` }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
          }}
        >
          <div>
            <div
              style={{
                fontFamily: fontMono,
                fontSize: 11,
                color: amber,
                letterSpacing: 1.5,
                textTransform: "uppercase",
              }}
            >
              Paper Desk · Day {state.day}
            </div>
            <div
              style={{
                fontFamily: fontDisplay,
                fontSize: 26,
                fontWeight: 700,
                marginTop: 2,
              }}
            >
              {usd(totalValue)}
            </div>
            <div
              style={{
                fontFamily: fontMono,
                fontSize: 13,
                color: totalChange >= 0 ? mint : red,
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              {totalChange >= 0 ? (
                <TrendingUp size={13} />
              ) : (
                <TrendingDown size={13} />
              )}
              {pct(totalChange)} since inception
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              onClick={() => loadState(backendUrl)}
              title="Refresh"
              style={{
                background: "transparent",
                border: `1px solid #26314A`,
                borderRadius: 8,
                width: 34,
                height: 34,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: dim,
                cursor: "pointer",
              }}
            >
              <RefreshCw size={14} className={loading ? "spin" : ""} />
            </button>
            <button
              onClick={() => setSettingsOpen(true)}
              title="Backend settings"
              style={{
                background: "transparent",
                border: `1px solid #26314A`,
                borderRadius: 8,
                width: 34,
                height: 34,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: dim,
                cursor: "pointer",
              }}
            >
              <Settings size={14} />
            </button>
            <button
              onClick={runScan}
              disabled={running}
              style={{
                background: amber,
                color: ink,
                border: "none",
                borderRadius: 8,
                padding: "10px 14px",
                fontFamily: fontUtil,
                fontWeight: 700,
                fontSize: 13,
                display: "flex",
                alignItems: "center",
                gap: 6,
                cursor: running ? "default" : "pointer",
                opacity: running ? 0.6 : 1,
                whiteSpace: "nowrap",
              }}
            >
              <Zap size={14} /> {running ? "Scanning…" : "Run Scan"}
            </button>
          </div>
        </div>

        {scanError && (
          <div
            style={{
              marginTop: 10,
              background: "rgba(196,69,59,0.12)",
              border: "1px solid rgba(196,69,59,0.4)",
              borderRadius: 8,
              padding: "8px 10px",
              fontFamily: fontMono,
              fontSize: 12,
              color: red,
            }}
          >
            Scan failed: {scanError}
          </div>
        )}
        {connError && state && (
          <div
            style={{
              marginTop: 10,
              background: "rgba(196,69,59,0.12)",
              border: "1px solid rgba(196,69,59,0.4)",
              borderRadius: 8,
              padding: "8px 10px",
              fontFamily: fontMono,
              fontSize: 12,
              color: red,
            }}
          >
            {connError.includes("Failed to fetch")
              ? "Backend went quiet for a moment (likely waking up from an idle sleep) — retrying automatically, showing cached data."
              : `Last refresh failed: ${connError} — showing cached data.`}
          </div>
        )}

        {/* chart */}
        {state.history.length > 1 && (
          <div style={{ height: 70, marginTop: 14 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={state.history}>
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke={amber}
                  strokeWidth={2}
                  dot={false}
                />
                <XAxis dataKey="day" hide />
                <YAxis hide domain={["dataMin - 20", "dataMax + 20"]} />
                <Tooltip
                  contentStyle={{
                    background: panel2,
                    border: `1px solid #26314A`,
                    borderRadius: 6,
                    fontFamily: fontMono,
                    fontSize: 12,
                  }}
                  labelFormatter={(d) => `Day ${d}`}
                  formatter={(v) => [usd(v), "Value"]}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {chartableTickers.length > 0 && (
          <div
            style={{
              background: panel,
              borderRadius: 10,
              padding: 12,
              border: "1px solid #1E293D",
              marginTop: 14,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 8,
                flexWrap: "wrap",
                gap: 8,
              }}
            >
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {chartableTickers.map((t) => (
                  <button
                    key={t}
                    onClick={() => setChartTicker(t)}
                    style={{
                      fontFamily: fontMono,
                      fontSize: 11,
                      fontWeight: 700,
                      padding: "4px 8px",
                      borderRadius: 6,
                      border: `1px solid ${t === activeChartTicker ? amber : "#26314A"}`,
                      background:
                        t === activeChartTicker ? `${amber}22` : "transparent",
                      color: t === activeChartTicker ? amber : dim,
                      cursor: "pointer",
                    }}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  fontFamily: fontMono,
                  fontSize: 10,
                  color: mint,
                  letterSpacing: 0.5,
                }}
              >
                <span
                  className="pulse"
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: mint,
                    display: "inline-block",
                  }}
                />
                LIVE
              </div>
            </div>
            {chartData.length > 1 ? (
              <>
                <div style={{ height: 170 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart
                      data={chartData}
                      margin={{ top: 6, right: 4, left: 4, bottom: 0 }}
                    >
                      <XAxis
                        dataKey="time"
                        type="number"
                        domain={["dataMin", "dataMax"]}
                        tick={{ fontSize: 9, fill: dim, fontFamily: fontMono }}
                        tickFormatter={(t) =>
                          new Date(t).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        }
                        minTickGap={40}
                        axisLine={{ stroke: "#26314A" }}
                        tickLine={false}
                      />
                      <YAxis hide domain={["dataMin", "dataMax"]} />
                      <Tooltip content={<CandleTooltip candles={candles} />} />
                      <Customized
                        component={CandlestickLayer}
                        candles={candles}
                      />
                      <Line
                        type="monotone"
                        dataKey="price"
                        stroke="transparent"
                        dot={false}
                        activeDot={false}
                        isAnimationActive={false}
                      />
                      {intradayTradeMarkers.length > 0 && (
                        <Scatter
                          data={intradayTradeMarkers}
                          dataKey="price"
                          shape={TradeMarker}
                          isAnimationActive={false}
                        />
                      )}
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginTop: 4,
                  }}
                >
                  <div
                    style={{
                      fontFamily: fontMono,
                      fontSize: 11,
                      color: dim,
                      display: "flex",
                      gap: 10,
                    }}
                  >
                    <span>{activeChartTicker}</span>
                    {intradayTradeMarkers.length > 0 && (
                      <span
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                        }}
                      >
                        <span style={{ color: mint }}>▲ buy</span>
                        <span style={{ color: red }}>▼ sell</span>
                      </span>
                    )}
                  </div>
                  <div style={{ fontFamily: fontMono, fontSize: 13 }}>
                    {usd(chartData[chartData.length - 1].price)}
                  </div>
                </div>
              </>
            ) : (
              <div
                style={{
                  padding: "20px 0",
                  textAlign: "center",
                  color: dim,
                  fontSize: 12,
                  fontFamily: fontUtil,
                }}
              >
                Gathering live price history for {activeChartTicker}…
              </div>
            )}
          </div>
        )}
      </div>

      {/* tabs */}
      <div
        style={{
          display: "flex",
          borderBottom: `1px solid #1E293D`,
          position: "sticky",
          top: 0,
          background: ink,
          zIndex: 10,
        }}
      >
        <TabBtn id="scan" label="Scan" icon={Radar} />
        <TabBtn id="holdings" label="Holdings" icon={Wallet} />
        <TabBtn id="intraday" label="Intraday" icon={Activity} />
        <TabBtn id="log" label="Trade Log" icon={History} />
      </div>

      <div style={{ padding: 14, paddingBottom: 40 }}>
        {tab === "scan" && (
          <>
            {state.candidates.length === 0 ? (
              <EmptyState label="Run a scan to generate today's candidates." />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div
                  style={{
                    fontFamily: fontMono,
                    fontSize: 11,
                    color: dim,
                    marginBottom: 2,
                    letterSpacing: 0.5,
                  }}
                >
                  BUY ≥ {CONVICTION_BUY} · SELL &lt; {CONVICTION_SELL} ·
                  auto-scans daily at 9:35am server time
                </div>
                {state.candidates.map((c) => (
                  <div
                    key={c.ticker}
                    style={{
                      background: panel,
                      borderRadius: 10,
                      padding: 12,
                      border: "1px solid #1E293D",
                    }}
                  >
                    <div
                      style={{ display: "flex", gap: 10, alignItems: "center" }}
                    >
                      <Dial score={c.confidence} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "baseline",
                          }}
                        >
                          <span
                            style={{
                              fontFamily: fontMono,
                              fontWeight: 600,
                              fontSize: 14,
                            }}
                          >
                            {c.ticker}
                          </span>
                          <div style={{ textAlign: "right" }}>
                            <div
                              style={{
                                fontFamily: fontMono,
                                fontSize: 13,
                                color: dim,
                              }}
                            >
                              {usd(c.price)}
                            </div>
                            {c.targetPrice != null && (
                              <div
                                style={{
                                  fontFamily: fontMono,
                                  fontSize: 11,
                                  color: dim,
                                }}
                              >
                                target {usd(c.targetPrice)}
                              </div>
                            )}
                          </div>
                        </div>
                        <div style={{ fontSize: 12, color: dim }}>
                          {c.name} · {c.sector} ·{" "}
                          {c.cls === "stocks" ? "Equity" : "Crypto"}
                        </div>
                      </div>
                    </div>
                    <div
                      style={{
                        marginTop: 8,
                        display: "flex",
                        flexDirection: "column",
                        gap: 4,
                      }}
                    >
                      <Note
                        icon={<AlertTriangle size={11} />}
                        text={c.supplierNote}
                      />
                      <Note
                        icon={<ChevronRight size={11} />}
                        text={c.riskNote}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {tab === "holdings" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", gap: 10 }}>
              <CashCard label="Stocks cash" value={state.cash.stocks} />
              <CashCard label="Crypto cash" value={state.cash.crypto} />
            </div>
            {holdingsList.length === 0 ? (
              <EmptyState label="No open positions yet." />
            ) : (
              holdingsList.map((h) => {
                const signalColor =
                  h.signal === "BUY" ? mint : h.signal === "SELL" ? red : dim;
                return (
                  <div
                    key={h.t}
                    style={{
                      background: panel,
                      borderRadius: 10,
                      padding: 12,
                      border: "1px solid #1E293D",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <div>
                      <div
                        style={{
                          fontFamily: fontMono,
                          fontWeight: 600,
                          fontSize: 14,
                        }}
                      >
                        {h.t}
                      </div>
                      <div style={{ fontSize: 12, color: dim }}>
                        {h.qty.toFixed(h.cls === "crypto" ? 4 : 2)} sh @{" "}
                        {usd(h.avgCost)}
                      </div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          marginTop: 4,
                        }}
                      >
                        <span
                          style={{
                            fontFamily: fontMono,
                            fontSize: 10,
                            fontWeight: 700,
                            padding: "2px 6px",
                            borderRadius: 4,
                            background: `${signalColor}22`,
                            color: signalColor,
                          }}
                        >
                          {h.signal}
                        </span>
                        {h.targetPrice != null && (
                          <span style={{ fontSize: 11, color: dim }}>
                            target {usd(h.targetPrice)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontFamily: fontMono, fontSize: 14 }}>
                        {usd(h.val)}
                      </div>
                      <div
                        style={{
                          fontFamily: fontMono,
                          fontSize: 12,
                          color: h.pl >= 0 ? mint : red,
                        }}
                      >
                        {pct(h.pl)}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {tab === "intraday" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div
              style={{
                fontFamily: fontMono,
                fontSize: 11,
                color: dim,
                marginBottom: 2,
                letterSpacing: 0.5,
              }}
            $50/trade · stop-loss/take-profit at ±0.05%, wins run uncapped
            until they pull back · trades every ticker the daily scan tracks{" "}
            · checks every few seconds
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <CashCard
                label="Intraday stocks cash"
                value={state.intradayCash.stocks}
              />
              <CashCard
                label="Intraday crypto cash"
                value={state.intradayCash.crypto}
              />
            </div>
            <div
              style={{
                background: panel,
                borderRadius: 10,
                padding: 12,
                border: "1px solid #1E293D",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div style={{ fontSize: 12, color: dim }}>
                Intraday pool value
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontFamily: fontMono, fontSize: 14 }}>
                  {usd(intradayValue)}
                </div>
                <div
                  style={{
                    fontFamily: fontMono,
                    fontSize: 12,
                    color: intradayChange >= 0 ? mint : red,
                  }}
                >
                  {pct(intradayChange)} since $200 seed
                </div>
              </div>
            </div>
            <div
              style={{
                background: panel,
                borderRadius: 10,
                padding: 12,
                border: "1px solid #1E293D",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div style={{ fontSize: 12, color: dim }}>
                Today's intraday P&L
              </div>
              <div style={{ textAlign: "right" }}>
                <div
                  style={{
                    fontFamily: fontMono,
                    fontSize: 14,
                    color: intradayPnlToday >= 0 ? mint : red,
                  }}
                >
                  {intradayPnlToday >= 0 ? "+" : ""}
                  {usd(intradayPnlToday)}
                </div>
                <div style={{ fontFamily: fontMono, fontSize: 11, color: dim }}>
                  {intradayWins}W / {intradayLosses}L today
                </div>
              </div>
            </div>
            {intradayClosedToday.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div
                  style={{
                    fontFamily: fontMono,
                    fontSize: 11,
                    color: dim,
                    letterSpacing: 0.5,
                  }}
                >
                  CLOSED TODAY
                </div>
                {intradayClosedToday
                  .slice()
                  .reverse()
                  .map((t, i) => (
                    <div
                      key={i}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        background: panel,
                        borderRadius: 8,
                        padding: "9px 12px",
                        border: "1px solid #1E293D",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                        }}
                      >
                        <span
                          style={{
                            fontFamily: fontMono,
                            fontSize: 11,
                            fontWeight: 700,
                            padding: "2px 6px",
                            borderRadius: 4,
                            background: t.win
                              ? "rgba(79,174,140,0.15)"
                              : "rgba(196,69,59,0.15)",
                            color: t.win ? mint : red,
                          }}
                        >
                          {t.win ? "WIN" : "LOSS"}
                        </span>
                        <span style={{ fontFamily: fontMono, fontSize: 13 }}>
                          {t.ticker}
                        </span>
                      </div>
                      <div
                        style={{
                          fontFamily: fontMono,
                          fontSize: 12,
                          color: t.pnl >= 0 ? mint : red,
                        }}
                      >
                        {t.pnl >= 0 ? "+" : ""}
                        {usd(t.pnl)}
                      </div>
                    </div>
                  ))}
              </div>
            )}
            {intradayList.length === 0 ? (
              <EmptyState label="No open intraday positions right now." />
            ) : (
              intradayList.map((p) => (
                <div
                  key={p.ticker}
                  style={{
                    background: panel,
                    borderRadius: 10,
                    padding: 12,
                    border: "1px solid #1E293D",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontFamily: fontMono,
                        fontWeight: 600,
                        fontSize: 14,
                      }}
                    >
                      {p.ticker}
                    </div>
                    <div style={{ fontSize: 12, color: dim }}>
                      {p.shares.toFixed(p.cls === "crypto" ? 4 : 2)} sh @{" "}
                      {usd(p.entryPrice)}
                    </div>
                    <div style={{ fontSize: 11, color: dim, marginTop: 4 }}>
                      opened {timeAgo(p.openedAt)}
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontFamily: fontMono, fontSize: 14 }}>
                      {p.currentPrice != null ? usd(p.currentPrice) : "—"}
                    </div>
                    <div
                      style={{
                        fontFamily: fontMono,
                        fontSize: 12,
                        color: p.pl == null ? dim : p.pl >= 0 ? mint : red,
                      }}
                    >
                      {p.pl != null ? pct(p.pl) : "waiting for price"}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {tab === "log" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {state.trades.length === 0 ? (
              <EmptyState label="No trades yet. Run a scan to let the desk act." />
            ) : (
              state.trades.map((t, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    background: panel,
                    borderRadius: 8,
                    padding: "9px 12px",
                    border: "1px solid #1E293D",
                  }}
                >
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 8 }}
                  >
                    <span
                      style={{
                        fontFamily: fontMono,
                        fontSize: 11,
                        fontWeight: 700,
                        padding: "2px 6px",
                        borderRadius: 4,
                        background:
                          t.action === "BUY"
                            ? "rgba(79,174,140,0.15)"
                            : "rgba(196,69,59,0.15)",
                        color: t.action === "BUY" ? mint : red,
                      }}
                    >
                      {t.action}
                    </span>
                    <span style={{ fontFamily: fontMono, fontSize: 13 }}>
                      {t.ticker}
                    </span>
                    <span style={{ fontSize: 11, color: dim }}>
                      day {t.day}
                    </span>
                  </div>
                  <div
                    style={{ fontFamily: fontMono, fontSize: 12, color: dim }}
                  >
                    {usd(t.qty * t.price)} @ {t.confidence}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function btnStyle(bg, color, border) {
  return {
    background: bg,
    color,
    border: border || "none",
    borderRadius: 8,
    padding: "9px 14px",
    fontFamily: fontUtil,
    fontWeight: 700,
    fontSize: 13,
    display: "flex",
    alignItems: "center",
    gap: 6,
    cursor: "pointer",
  };
}

function LoadingScreen({ label }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: ink,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: paper,
        fontFamily: fontMono,
      }}
    >
      {label}
    </div>
  );
}

function SetupScreen({ urlInput, setUrlInput, onSave, onCancel }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: ink,
        color: paper,
        fontFamily: fontUtil,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          maxWidth: 380,
          width: "100%",
          background: panel,
          border: "1px solid #1E293D",
          borderRadius: 12,
          padding: 22,
          position: "relative",
        }}
      >
        {onCancel && (
          <button
            onClick={onCancel}
            style={{
              position: "absolute",
              top: 14,
              right: 14,
              background: "transparent",
              border: "none",
              color: dim,
              cursor: "pointer",
            }}
          >
            <X size={16} />
          </button>
        )}
        <div
          style={{
            fontFamily: fontMono,
            fontSize: 11,
            color: amber,
            letterSpacing: 1.5,
            textTransform: "uppercase",
          }}
        >
          Paper Desk
        </div>
        <div
          style={{
            fontFamily: fontDisplay,
            fontSize: 20,
            fontWeight: 700,
            marginTop: 4,
            marginBottom: 10,
          }}
        >
          Connect your backend
        </div>
        <div
          style={{
            fontSize: 13,
            color: dim,
            lineHeight: 1.5,
            marginBottom: 14,
          }}
        >
          Paste the URL of your Render web service (no trailing slash needed) —
          e.g. https://trading-desk.onrender.com
        </div>
        <input
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          placeholder="https://your-service.onrender.com"
          style={{
            width: "100%",
            background: panel2,
            border: "1px solid #26314A",
            borderRadius: 8,
            padding: "10px 12px",
            color: paper,
            fontFamily: fontMono,
            fontSize: 13,
            marginBottom: 12,
          }}
        />
        <button
          onClick={() => onSave(urlInput)}
          disabled={!urlInput.trim()}
          style={{
            width: "100%",
            background: amber,
            color: ink,
            border: "none",
            borderRadius: 8,
            padding: "11px 14px",
            fontFamily: fontUtil,
            fontWeight: 700,
            fontSize: 13,
            cursor: urlInput.trim() ? "pointer" : "default",
            opacity: urlInput.trim() ? 1 : 0.5,
          }}
        >
          Connect
        </button>
      </div>
    </div>
  );
}

function Note({ icon, text }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 6,
        alignItems: "flex-start",
        fontSize: 12,
        color: dim,
        fontFamily: fontUtil,
        lineHeight: 1.4,
      }}
    >
      <span style={{ marginTop: 2 }}>{icon}</span>
      <span>{text}</span>
    </div>
  );
}

// Draws real OHLC candlesticks (wick + body) directly on the chart's own
// pixel scales via Recharts' <Customized> hook. This bypasses Bar's
// category-axis bar-layout math, which doesn't handle a numeric time axis
// reliably and was why the price chart only ever showed the buy/sell
// trade-marker triangles instead of real candles.
function CandlestickLayer(props) {
  const { xAxisMap, yAxisMap, candles } = props;
  if (!candles || candles.length === 0 || !xAxisMap || !yAxisMap) return null;
  const xAxis = Object.values(xAxisMap)[0];
  const yAxis = Object.values(yAxisMap)[0];
  if (!xAxis || !yAxis) return null;
  const xScale = xAxis.scale;
  const yScale = yAxis.scale;

  let bodyWidth = 6;
  if (candles.length > 1) {
    const gaps = [];
    for (let i = 1; i < candles.length; i++) {
      gaps.push(
        Math.abs(xScale(candles[i].time) - xScale(candles[i - 1].time)),
      );
    }
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    bodyWidth = Math.max(2, Math.min(14, avgGap * 0.6));
  }

  return (
    <g>
      {candles.map((c) => {
        const x = xScale(c.time);
        if (x == null || Number.isNaN(x)) return null;
        const isUp = c.close >= c.open;
        const color = isUp ? mint : red;
        const highY = yScale(c.high);
        const lowY = yScale(c.low);
        const openY = yScale(c.open);
        const closeY = yScale(c.close);
        const bodyTop = Math.min(openY, closeY);
        const bodyHeight = Math.max(1.5, Math.abs(closeY - openY));
        return (
          <g key={c.time}>
            <line
              x1={x}
              x2={x}
              y1={highY}
              y2={lowY}
              stroke={color}
              strokeWidth={1.5}
            />
            <rect
              x={x - bodyWidth / 2}
              y={bodyTop}
              width={bodyWidth}
              height={bodyHeight}
              fill={color}
              rx={1}
            />
          </g>
        );
      })}
    </g>
  );
}

function TradeMarker({ cx, cy, payload }) {
  if (cx == null || cy == null) return null;
  const isBuy = payload.action === "BUY";
  const color = isBuy ? mint : red;
  const points = isBuy
    ? `${cx},${cy - 7} ${cx - 5},${cy + 3} ${cx + 5},${cy + 3}`
    : `${cx},${cy + 7} ${cx - 5},${cy - 3} ${cx + 5},${cy - 3}`;
  return <polygon points={points} fill={color} stroke={ink} strokeWidth={1} />;
}

// Looks up the OHLC candle nearest the hovered time directly from `candles`,
// rather than relying on Recharts' per-series tooltip payload (which only
// ever carried the trade-marker Scatter data once the candles moved to the
// Customized layer above).
function CandleTooltip({ active, payload, label, candles }) {
  if (!active) return null;
  const candle =
    candles && candles.length
      ? candles.reduce(
          (best, c) =>
            best == null ||
            Math.abs(c.time - label) < Math.abs(best.time - label)
              ? c
              : best,
          null,
        )
      : null;
  const trade = payload && payload.find((p) => p.payload && p.payload.action);
  if (!candle && !trade) return null;
  return (
    <div
      style={{
        background: panel2,
        border: `1px solid #26314A`,
        borderRadius: 6,
        fontFamily: fontMono,
        fontSize: 11,
        padding: "6px 8px",
        color: paper,
      }}
    >
      <div style={{ color: dim, marginBottom: 4 }}>
        {new Date(label).toLocaleTimeString()}
      </div>
      {candle && (
        <div>
          O {usd(candle.open)} · H {usd(candle.high)} · L {usd(candle.low)} · C{" "}
          {usd(candle.close)}
        </div>
      )}
      {trade && (
        <div
          style={{
            color: trade.payload.action === "BUY" ? mint : red,
            marginTop: candle ? 4 : 0,
          }}
        >
          {trade.payload.action} @ {usd(trade.payload.price)} (
          {trade.payload.reason})
        </div>
      )}
    </div>
  );
}

function CashCard({ label, value }) {
  return (
    <div
      style={{
        flex: 1,
        background: panel,
        borderRadius: 10,
        padding: 12,
        border: "1px solid #1E293D",
      }}
    >
      <div style={{ fontSize: 11, color: dim, fontFamily: fontUtil }}>
        {label}
      </div>
      <div style={{ fontFamily: fontMono, fontSize: 16, marginTop: 2 }}>
        {usd(value)}
      </div>
    </div>
  );
}

function EmptyState({ label }) {
  return (
    <div style={{ textAlign: "center", padding: "40px 20px", color: dim }}>
      <div
        style={{
          fontFamily: fontDisplay,
          fontSize: 18,
          color: amber,
          marginBottom: 6,
        }}
      >
        Desk is quiet.
      </div>
      <div style={{ fontFamily: fontUtil, fontSize: 13 }}>{label}</div>
    </div>
  );
}
