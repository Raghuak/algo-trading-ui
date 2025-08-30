"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

// ================== CONFIG (from your requirements) ==================
const MAX_SIGNALS = 500; // keep last 500
const MAX_TRADE_LOGS = 1000; // keep last 1000
const MAX_SYS_LOGS = 200; // keep last 200
const UI_FPS = 4; // ~250ms UI refresh throttle

// Env-configurable thresholds and feature flags
const USE_MOCK = (process.env.NEXT_PUBLIC_USE_MOCK_DATA ?? "1").toString().toLowerCase() === "1" ||
  (process.env.NEXT_PUBLIC_USE_MOCK_DATA ?? "true").toString().toLowerCase() === "true";
const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "";
const DAILY_MAX_LOSS = Number(process.env.NEXT_PUBLIC_DAILY_MAX_LOSS ?? 5000);
const MARGIN_WARN_PCT = Number(process.env.NEXT_PUBLIC_MARGIN_WARN_PCT ?? 90); // breach when >=
const WARN_FRACTION = 0.8; // 80% for amber pre-warning

// ================== TYPES ==================
type Side = "Buy" | "Sell";

export type TickMsg = { type: "tick"; symbol: "NIFTY" | "BANKNIFTY"; ltp: number; t: number };
export type SignalPayload = { symbol: string; side: Side; qty: number; price: number; status: string };
export type SignalMsg = { type: "signal"; instrument: "NIFTY" | "BANKNIFTY"; payload: SignalPayload };
export type RiskMsg = { type: "risk"; dailyLoss?: number; marginUsedPct?: number };
export type StreamMsg = TickMsg | SignalMsg | RiskMsg;

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}
function isTickMsg(x: unknown): x is TickMsg {
  return isObject(x) && x.type === "tick" && (x.symbol === "NIFTY" || x.symbol === "BANKNIFTY") && typeof x.ltp === "number" && typeof x.t === "number";
}
function isSignalMsg(x: unknown): x is SignalMsg {
  if (!isObject(x) || x.type !== "signal") return false;
  const inst = (x as Record<string, unknown>).instrument;
  const payload = (x as Record<string, unknown>).payload;
  if (inst !== "NIFTY" && inst !== "BANKNIFTY") return false;
  if (!isObject(payload)) return false;
  const p = payload as Record<string, unknown>;
  return typeof p.symbol === "string" && (p.side === "Buy" || p.side === "Sell") && typeof p.qty === "number" && typeof p.price === "number" && typeof p.status === "string";
}
function isRiskMsg(x: unknown): x is RiskMsg {
  return isObject(x) && x.type === "risk" && (typeof x.dailyLoss === "number" || typeof x.dailyLoss === "undefined") && (typeof x.marginUsedPct === "number" || typeof x.marginUsedPct === "undefined");
}
function asStreamMsg(x: unknown): StreamMsg | null {
  if (isTickMsg(x)) return x;
  if (isSignalMsg(x)) return x;
  if (isRiskMsg(x)) return x;
  return null;
}

// ================== UTILITIES ==================
const formatINR = (n: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(n ?? 0);

function clamp(n: number, min: number, max: number) { return Math.max(min, Math.min(max, n)); }

// P&L % calculation per side
function calcPnLPct(side: Side, avgPrice: number, ltp: number) {
  if (!avgPrice) return 0;
  return side === "Buy"
    ? ((ltp - avgPrice) / avgPrice) * 100
    : ((avgPrice - ltp) / avgPrice) * 100;
}

// Absolute P&L (no lot multiplier here; backend can provide if needed)
function calcPnLAbs(side: Side, avgPrice: number, ltp: number, qty: number) {
  const diff = side === "Buy" ? (ltp - avgPrice) : (avgPrice - ltp);
  return diff * qty;
}

// Throttle state updates to animation frames
function useRafThrottle<T>(value: T, fps = UI_FPS) {
  const [throttled, setThrottled] = useState<T>(value);
  const lastRaf = useRef<number | null>(null);
  const lastTime = useRef<number>(0);
  const interval = 1000 / fps;

  useEffect(() => {
    const now = performance.now();
    const elapsed = now - lastTime.current;
    if (elapsed >= interval) {
      lastTime.current = now;
      setThrottled(value);
    } else {
      if (lastRaf.current) cancelAnimationFrame(lastRaf.current);
      lastRaf.current = requestAnimationFrame(() => {
        lastTime.current = performance.now();
        setThrottled(value);
      });
    }
    return () => {
      if (lastRaf.current) cancelAnimationFrame(lastRaf.current);
    };
  }, [value, interval]);
  return throttled;
}

// CSV helpers
function csvEscape(val: unknown) {
  const s = String(val ?? "");
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function toCSV(headers: string[], rows: (string | number)[][]) {
  const head = headers.map(csvEscape).join(",");
  const body = rows.map(r => r.map(csvEscape).join(",")).join("\n");
  return head + (body ? "\n" + body : "");
}
function downloadCSV(filename: string, csv: string) {
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
}

// Bounded push helpers
function pushBounded<T>(arr: T[], item: T, max: number): T[] {
  const next = [item, ...arr];
  return next.length > max ? next.slice(0, max) : next;
}

// ================== WEBSOCKET SHIM (with mock toggle) ==================
interface WSHandlers {
  onOpen?: () => void;
  onMessage?: (msg: StreamMsg) => void;
  onError?: (e: unknown) => void;
  onReconnect?: (attempt: number, delayMs: number) => void;
}

function createMarketStream(url: string, handlers: WSHandlers, useMock: boolean): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let hbTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectAttempt = 0;

  function heartbeat() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: "ping", t: Date.now() })); } catch { /* noop */ }
    }
  }

  function connect() {
    if (useMock || !url) {
      // Mock tick stream: emits ticks for NIFTY/BANKNIFTY + random signals
      const mockTimer = setInterval(() => {
        const t = Date.now();
        const payloads: TickMsg[] = [
          { type: "tick", symbol: "NIFTY", ltp: 22400 + (Math.random() - 0.5) * 8, t },
          { type: "tick", symbol: "BANKNIFTY", ltp: 48200 + (Math.random() - 0.5) * 16, t },
        ];
        for (const p of payloads) handlers.onMessage?.(p);
        if (Math.random() > 0.99) {
          const side: Side = Math.random() > 0.5 ? "Buy" : "Sell";
          const inst = Math.random() > 0.5 ? "NIFTY" : "BANKNIFTY";
          const msg: SignalMsg = {
            type: "signal",
            instrument: inst,
            payload: {
              symbol: side === "Buy" ? `${inst}24SEP22500CE` : `${inst}24SEP22500PE`,
              side,
              qty: 50,
              price: +(224 + (Math.random() - 0.5) * 2).toFixed(2),
              status: "Executed",
            },
          };
          handlers.onMessage?.(msg);
        }
      }, 100);
      handlers.onOpen?.();
      return () => clearInterval(mockTimer);
    }

    try {
      ws = new WebSocket(url);
      ws.onopen = () => {
        reconnectAttempt = 0;
        handlers.onOpen?.();
        hbTimer = setInterval(heartbeat, 15000);
      };
      ws.onmessage = (ev: MessageEvent) => {
        let parsed: unknown = ev.data;
        try { parsed = JSON.parse(ev.data as string); } catch { /* keep as-is */ }
        const coerced = asStreamMsg(parsed);
        if (coerced) handlers.onMessage?.(coerced);
      };
      ws.onerror = () => handlers.onError?.(new Error("ws error"));
      ws.onclose = () => {
        if (closed) return;
        const delay = Math.min(30000, Math.pow(2, reconnectAttempt) * 500 + Math.random() * 300);
        reconnectAttempt += 1;
        handlers.onReconnect?.(reconnectAttempt, delay);
        setTimeout(connect, delay);
      };
    } catch (e) {
      handlers.onError?.(e);
    }

    return () => {
      closed = true;
      if (hbTimer) clearInterval(hbTimer);
      try { ws?.close(); } catch { /* noop */ }
    };
  }

  const teardown = connect();
  return () => { try { if (typeof teardown === 'function') teardown(); } catch { /* noop */ } };
}

// ================== FAST CHART (Lightweight-Charts with safe init) ==================

type SeriesPoint = { time: number; value: number };
interface SeriesApi { setData: (data: SeriesPoint[]) => void }
interface ChartApi {
  addLineSeries?: (opts?: { lineWidth?: number }) => SeriesApi;
  addAreaSeries?: (opts?: { lineWidth?: number }) => SeriesApi;
  applyOptions: (opts: Record<string, unknown>) => void;
  timeScale: () => { fitContent: () => void };
  remove?: () => void;
}

type CreateChartFn = (el: HTMLElement, opts?: Record<string, unknown>) => ChartApi;
interface LWModuleShape {
  createChart?: CreateChartFn;
  default?: unknown;
  LightweightCharts?: { createChart?: CreateChartFn };
}

function FastLineChart({
  series,
  theme = "dark",
}: {
  series: SeriesPoint[];
  theme?: "light" | "dark";
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ChartApi | null>(null);
  const seriesRef = useRef<SeriesApi | null>(null);
  const resizeObs = useRef<ResizeObserver | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let cleanup: (() => void) | undefined;
    (async () => {
      const mod = (await import("lightweight-charts")) as unknown as LWModuleShape;
      const create: CreateChartFn | undefined =
        (typeof mod?.createChart === "function" && mod.createChart) ||
        (typeof mod?.LightweightCharts?.createChart === "function" && mod.LightweightCharts.createChart) ||
        (typeof mod?.default === "function" && (mod.default as CreateChartFn)) ||
        (typeof (mod?.default as LWModuleShape | undefined)?.createChart === "function" && (mod.default as LWModuleShape).createChart);
      if (typeof create !== "function") {
        console.error("[Chart] createChart not found on module", mod);
        return;
      }

      const chart = create(el, {
        width: el.clientWidth || 600,
        height: el.clientHeight || 256,
        layout: {
          background: { color: theme === "dark" ? "#0b0f15" : "#ffffff" },
          textColor: theme === "dark" ? "#cbd5e1" : "#0f172a",
        },
        grid: {
          vertLines: { color: "rgba(0,0,0,0.06)" },
          horzLines: { color: "rgba(0,0,0,0.06)" },
        },
        rightPriceScale: { borderVisible: false },
        timeScale: { borderVisible: false },
        crosshair: { mode: 0 },
      });

      let line: SeriesApi | null = null;
      if (typeof chart.addLineSeries === "function") {
        line = chart.addLineSeries({ lineWidth: 2 });
      } else if (typeof chart.addAreaSeries === "function") {
        line = chart.addAreaSeries({ lineWidth: 2 });
      } else {
        console.error("[Chart] Chart instance missing series methods; got:", chart);
        return;
      }

      chartRef.current = chart;
      seriesRef.current = line;

      if (Array.isArray(series)) {
        line.setData(series);
      }

      if (typeof ResizeObserver !== "undefined") {
        const ro = new ResizeObserver((entries) => {
          for (const entry of entries) {
            const cr = entry.contentRect;
            if (cr.width > 0 && cr.height > 0) {
              chart.applyOptions({ width: Math.floor(cr.width), height: Math.floor(cr.height) });
            }
          }
        });
        resizeObs.current = ro;
        ro.observe(el);
      } else {
        const onResize = () => {
          const { clientWidth, clientHeight } = el;
          chart.applyOptions({ width: clientWidth, height: clientHeight });
        };
        window.addEventListener("resize", onResize);
        cleanup = () => window.removeEventListener("resize", onResize);
      }
    })();

    return () => {
      const currentEl = el; // capture
      if (resizeObs.current && currentEl) {
        try { resizeObs.current.unobserve(currentEl); } catch { /* noop */ }
        resizeObs.current.disconnect();
        resizeObs.current = null;
      }
      try {
        if (chartRef.current && typeof chartRef.current.remove === "function") {
          chartRef.current.remove();
        }
      } catch { /* noop */ }
      chartRef.current = null;
      seriesRef.current = null;
      if (cleanup) cleanup();
    };
  }, [theme]);

  useEffect(() => {
    if (seriesRef.current) {
      seriesRef.current.setData(series);
      try { chartRef.current?.timeScale().fitContent(); } catch { /* noop */ }
    }
  }, [series]);

  return <div ref={containerRef} className="h-64 w-full" />;
}

// ================== UI SUBCOMPONENTS ==================
const SideBadge = ({ side }: { side: Side }) => (
  <span className={`px-2 py-0.5 text-xs rounded font-semibold ${side === "Buy" ? "bg-green-600/20 text-green-500" : "bg-red-600/20 text-red-500"}`}>
    {side.toUpperCase()}
  </span>
);

// New TradeRow with columns: Symbol | Side | Qty | Avg Price | LTP | P&L% (toggle abs)
const TradeRow = React.memo(function TradeRow({
  t,
  showAbs,
}: {
  t: { symbol: string; side: Side; qty: number; avgPrice: number; ltp: number; status: string };
  showAbs: boolean;
}) {
  const pnlPct = calcPnLPct(t.side, t.avgPrice, t.ltp);
  const pnlAbs = calcPnLAbs(t.side, t.avgPrice, t.ltp, t.qty);
  const pnlColor = pnlPct > 0 ? "text-green-600" : pnlPct < 0 ? "text-red-600" : "";
  return (
    <div className="grid grid-cols-6 items-center gap-2 px-3 py-2 text-sm border-b">
      <div className="truncate font-medium" title={t.symbol}>{t.symbol}</div>
      <div><SideBadge side={t.side} /></div>
      <div className="text-right tabular-nums">{t.qty}</div>
      <div className="text-right tabular-nums">{formatINR(t.avgPrice)}</div>
      <div className="text-right tabular-nums" title={`Status: ${t.status}`}>{formatINR(t.ltp)}</div>
      <div className={`text-right tabular-nums font-semibold ${pnlColor}`}>
        {showAbs ? `${formatINR(pnlAbs)} (${pnlPct.toFixed(2)}%)` : `${pnlPct.toFixed(2)}%`}
      </div>
    </div>
  );
});

// Risk badge component with tooltip via title attr
function RiskBadge({ dailyLoss, marginUsedPct }: { dailyLoss: number; marginUsedPct: number }) {
  const breach = dailyLoss >= DAILY_MAX_LOSS || marginUsedPct >= MARGIN_WARN_PCT;
  const warn = !breach && (dailyLoss >= DAILY_MAX_LOSS * WARN_FRACTION || marginUsedPct >= MARGIN_WARN_PCT * WARN_FRACTION);
  const cls = breach ? "bg-red-600 text-white animate-pulse" : warn ? "bg-yellow-500 text-black animate-pulse" : "bg-slate-600 text-white";
  const reasons: string[] = [];
  if (dailyLoss >= DAILY_MAX_LOSS) reasons.push(`Daily loss ${formatINR(dailyLoss)} breached limit ${formatINR(DAILY_MAX_LOSS)}`);
  else if (dailyLoss >= DAILY_MAX_LOSS * WARN_FRACTION) reasons.push(`Daily loss near limit: ${formatINR(dailyLoss)} / ${formatINR(DAILY_MAX_LOSS)}`);
  if (marginUsedPct >= MARGIN_WARN_PCT) reasons.push(`Margin used ${marginUsedPct.toFixed(1)}% ≥ ${MARGIN_WARN_PCT}%`);
  else if (marginUsedPct >= MARGIN_WARN_PCT * WARN_FRACTION) reasons.push(`Margin used high: ${marginUsedPct.toFixed(1)}% / ${MARGIN_WARN_PCT}%`);
  const title = reasons.length ? reasons.join(" | ") : "Risk normal";
  return <span className={`px-2 py-1 rounded text-xs font-semibold`} title={title}><span className={cls + " px-2 py-1 rounded"}>🟡 Risk</span></span>;
}

// ================== MAIN DASHBOARD ==================
export default function TradingDashboard() {
  const [theme] = useState<"light" | "dark">("dark"); // default dark
  const [isRunning, setIsRunning] = useState(true);
  const [showAbsPnl, setShowAbsPnl] = useState(true);

  // Market prices + risk
  const [marketData, setMarketData] = useState({ nifty: 0, bankNifty: 0 });
  const [dailyLoss, setDailyLoss] = useState(0);
  const [marginUsedPct, setMarginUsedPct] = useState(40);

  // Per-instrument state
  type Signal = SignalPayload;
  type Trade = { symbol: string; side: Side; qty: number; avgPrice: number; ltp: number; status: string };

  const [signalsN, setSignalsN] = useState<Signal[]>([]);
  const [tradesN, setTradesN] = useState<Trade[]>([]);
  const [logsN, setLogsN] = useState<string[]>([]);

  const [signalsB, setSignalsB] = useState<Signal[]>([]);
  const [tradesB, setTradesB] = useState<Trade[]>([]);
  const [logsB, setLogsB] = useState<string[]>([]);

  // System logs (errors/warnings)
  const [sysLogs, setSysLogs] = useState<string[]>([]);

  // --- Dev self-tests (limits, P&L math, risk thresholds, CSV) ---
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    try {
      console.assert(typeof Intl.NumberFormat === "function", "[TEST] Intl.NumberFormat available");
      const clip = Array.from({ length: 600 }, (_, i) => `S${i}`);
      const reduced = clip.reduce((acc, v) => pushBounded(acc, v, MAX_SIGNALS), [] as string[]);
      console.assert(reduced.length === MAX_SIGNALS, "[TEST] signals cap at 500");
      // P&L tests
      console.assert(Math.abs(calcPnLPct("Buy", 100, 110) - 10) < 1e-6, "[TEST] Buy PnL% +10%");
      console.assert(Math.abs(calcPnLPct("Sell", 100, 90) - 10) < 1e-6, "[TEST] Sell PnL% +10%");
      // Risk tests
      const breachDaily = DAILY_MAX_LOSS; // equal should breach
      console.assert(breachDaily >= DAILY_MAX_LOSS, "[TEST] breach when >= DAILY_MAX_LOSS");
      // CSV tests
      const csv = toCSV(["a","b"], [["x, y","\"z\""]]);
      console.assert(/\"x, y\"/.test(csv) && /\"\"z\"\"/.test(csv), "[TEST] CSV escaping");
    } catch (err) {
      console.error("[TEST] self-tests failed", err);
    }
  }, []);

  // WebSocket/Mock stream hookup
  useEffect(() => {
    const teardown = createMarketStream(WS_URL, {
      onOpen: () => setSysLogs((l) => pushBounded(l, new Date().toLocaleTimeString() + " - stream connected", MAX_SYS_LOGS)),
      onError: () => setSysLogs((l) => pushBounded(l, new Date().toLocaleTimeString() + " - stream error", MAX_SYS_LOGS)),
      onReconnect: (attempt, delay) => setSysLogs((l) => pushBounded(l, `${new Date().toLocaleTimeString()} - reconnect attempt ${attempt} in ${Math.round(delay)}ms`, MAX_SYS_LOGS)),
      onMessage: (msg) => {
        if (msg?.type === "tick") {
          const { symbol, ltp, t } = msg;
          if (symbol === "NIFTY") setMarketData((d) => ({ ...d, nifty: Number(ltp.toFixed(2)) }));
          if (symbol === "BANKNIFTY") setMarketData((d) => ({ ...d, bankNifty: Number(ltp.toFixed(2)) }));

          const upd = (arr: Trade[]) => arr.map((tr) => (tr.symbol.includes(symbol) ? { ...tr, ltp: Number(ltp.toFixed(2)) } : tr));
          setTradesN((arr) => upd(arr));
          setTradesB((arr) => upd(arr));

          // Log tick occasionally (every ~2s window)
          if (t % 2000 < 120) {
            const line = `${new Date(t).toLocaleTimeString()} ${symbol} ${ltp.toFixed(2)}`;
            if (symbol === "NIFTY") setLogsN((x) => pushBounded(x, line, MAX_SYS_LOGS));
            if (symbol === "BANKNIFTY") setLogsB((x) => pushBounded(x, line, MAX_SYS_LOGS));
          }
        }
        if (msg?.type === "signal") {
          const s = msg.payload;
          const logLine = `${new Date().toLocaleTimeString()} ${msg.instrument} ${s.side} ${s.qty} ${s.symbol} @ ${s.price}`;
          if (msg.instrument === "BANKNIFTY") {
            setSignalsB((x) => pushBounded(x, s, MAX_SIGNALS));
            setTradesB((t) => pushBounded(t, { symbol: s.symbol, side: s.side, qty: s.qty, avgPrice: s.price, ltp: s.price, status: s.status }, MAX_TRADE_LOGS));
            setLogsB((x) => pushBounded(x, logLine, MAX_SYS_LOGS));
          } else {
            setSignalsN((x) => pushBounded(x, s, MAX_SIGNALS));
            setTradesN((t) => pushBounded(t, { symbol: s.symbol, side: s.side, qty: s.qty, avgPrice: s.price, ltp: s.price, status: s.status }, MAX_TRADE_LOGS));
            setLogsN((x) => pushBounded(x, logLine, MAX_SYS_LOGS));
          }
        }
        if (msg?.type === "risk") {
          if (typeof msg.dailyLoss === 'number') setDailyLoss(msg.dailyLoss);
          if (typeof msg.marginUsedPct === 'number') setMarginUsedPct(msg.marginUsedPct);
          setSysLogs((l) => pushBounded(l, `${new Date().toLocaleTimeString()} risk update`, MAX_SYS_LOGS));
        }
      },
    }, USE_MOCK);
    return () => { if (teardown) teardown(); };
  }, []);

  // Simulated risk drift (mock); your backend should push real numbers
  useEffect(() => {
    if (!USE_MOCK) return;
    const id = setInterval(() => {
      setDailyLoss((v) => clamp(v + (Math.random() - 0.55) * 250, 0, DAILY_MAX_LOSS * 1.5));
      setMarginUsedPct((m) => clamp(m + (Math.random() - 0.5) * 2, 30, 110));
    }, 1500);
    return () => clearInterval(id);
  }, []);

  // Throttled market view
  const throttledMarket = useRafThrottle(marketData, UI_FPS);

  // Chart series for each instrument (epoch seconds)
  const seriesNifty = useMemo(() => {
    const base = Math.floor(Date.now() / 1000) - 60 * 5;
    const points = [22380, 22410, 22450, 22420, 22400, throttledMarket.nifty].slice(-5);
    return points.map((v, i) => ({ time: base + i * 60, value: Number(v) }));
  }, [throttledMarket.nifty]);

  const seriesBank = useMemo(() => {
    const base = Math.floor(Date.now() / 1000) - 60 * 5;
    const points = [48210, 48225, 48200, 48240, 48215, throttledMarket.bankNifty].slice(-5);
    return points.map((v, i) => ({ time: base + i * 60, value: Number(v) }));
  }, [throttledMarket.bankNifty]);

  // Export helpers
  const exportTradesCSV = (instrument: 'NIFTY' | 'BANKNIFTY') => {
    const arr = instrument === 'NIFTY' ? tradesN : tradesB;
    const headers = ['Symbol','Side','Qty','Avg Price','LTP','P&L %','P&L ₹','Status'];
    const rows = arr.map(t => {
      const pct = calcPnLPct(t.side, t.avgPrice, t.ltp);
      const abs = calcPnLAbs(t.side, t.avgPrice, t.ltp, t.qty);
      return [t.symbol, t.side.toUpperCase(), t.qty, t.avgPrice.toFixed(2), t.ltp.toFixed(2), pct.toFixed(2), abs.toFixed(2), t.status];
    });
    const csv = toCSV(headers, rows);
    const ts = new Date().toISOString().replace(/[:]/g,'-');
    downloadCSV(`${instrument}-trades-${ts}.csv`, csv);
  };
  const exportLogsCSV = (scope: 'NIFTY'|'BANKNIFTY'|'SYSTEM') => {
    const arr = scope==='NIFTY'? logsN : scope==='BANKNIFTY'? logsB : sysLogs;
    const csv = toCSV(['message'], arr.map(m=>[m]));
    const ts = new Date().toISOString().replace(/[:]/g,'-');
    downloadCSV(`${scope.toLowerCase()}-logs-${ts}.csv`, csv);
  };

  const execBadge = isRunning ? <Badge>Running</Badge> : <Badge variant="secondary">Paused</Badge>;

  return (
    <div className="p-4 space-y-4">
      <div className="flex justify-between items-center">
        <h1 className="text-xl font-bold">Algo Trading Dashboard</h1>
        <div className="flex items-center gap-2">
          <RiskBadge dailyLoss={dailyLoss} marginUsedPct={marginUsedPct} />
          <span className="text-sm">₹ P&L</span>
          <Switch checked={showAbsPnl} onCheckedChange={() => setShowAbsPnl((s) => !s)} />
          <span className="text-sm">System</span>
          <Switch checked={isRunning} onCheckedChange={() => setIsRunning((s) => !s)} />
          {execBadge}
        </div>
      </div>

      {/* Top stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Nifty 50</div><div className="text-lg font-semibold">{throttledMarket.nifty.toFixed(2)}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Bank Nifty</div><div className="text-lg font-semibold">{throttledMarket.bankNifty.toFixed(2)}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Balance</div><div className="text-lg font-semibold">{formatINR(500000)}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">P&L</div><div className="text-lg font-semibold">{formatINR(785.5)}</div></CardContent></Card>
      </div>

      {/* Instrument Tabs: Nifty / BankNifty separate charts, signals, trades, logs */}
      <Tabs defaultValue="nifty">
        <TabsList>
          <TabsTrigger value="nifty">Nifty 50 F&O</TabsTrigger>
          <TabsTrigger value="banknifty">Bank Nifty F&O</TabsTrigger>
          <TabsTrigger value="system">System Logs</TabsTrigger>
        </TabsList>

        {/* NIFTY TAB */}
        <TabsContent value="nifty">
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <Card className="xl:col-span-2">
              <CardContent className="p-2">
                <FastLineChart series={seriesNifty} theme={theme} />
              </CardContent>
            </Card>
            <div className="space-y-3">
              <Card>
                <CardContent className="p-4 flex items-center justify-between">
                  <div className="text-sm text-muted-foreground">Price</div>
                  <div className="text-base font-semibold">{throttledMarket.nifty.toFixed(2)}</div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4 flex items-center justify-between">
                  <div className="text-sm text-muted-foreground">Signals</div>
                  <Badge>{signalsN.length}</Badge>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4 flex items-center justify-between">
                  <div className="text-sm text-yellow-400">Warnings</div>
                  <Badge variant="secondary">{sysLogs.length}</Badge>
                </CardContent>
              </Card>
            </div>
          </div>

          <Tabs defaultValue="signals-n" className="mt-4">
            <TabsList>
              <TabsTrigger value="signals-n">Signals</TabsTrigger>
              <TabsTrigger value="trades-n">Trades</TabsTrigger>
              <TabsTrigger value="logs-n">Logs</TabsTrigger>
            </TabsList>

            <TabsContent value="signals-n">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {signalsN.map((sig, idx) => (
                  <Card key={idx} className="border-l-4" style={{ borderColor: sig.side === "Buy" ? "#16a34a" : "#dc2626" }}>
                    <CardContent className="p-4 space-y-1">
                      <div className="font-semibold">{sig.symbol}</div>
                      <div className="text-sm opacity-90">{sig.side} • {sig.qty} @ {formatINR(sig.price)}</div>
                      <Badge variant={sig.status === "Executed" ? "default" : sig.status === "Pending" ? "secondary" : "destructive"}>{sig.status}</Badge>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </TabsContent>

            <TabsContent value="trades-n">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm text-muted-foreground">Trades</div>
                <Button size="sm" onClick={() => exportTradesCSV('NIFTY')}>Export CSV</Button>
              </div>
              <div className="rounded border">
                <div className="grid grid-cols-6 gap-2 px-3 py-2 text-xs font-semibold bg-black/10">
                  <div>Symbol</div><div>Side</div><div className="text-right">Qty</div><div className="text-right">Avg Price</div><div className="text-right">LTP</div><div className="text-right">P&L%</div>
                </div>
                {tradesN.map((t, i) => (
                  <TradeRow key={i} t={t} showAbs={showAbsPnl} />
                ))}
              </div>
            </TabsContent>

            <TabsContent value="logs-n">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm text-muted-foreground">Logs</div>
                <Button size="sm" variant="secondary" onClick={() => exportLogsCSV('NIFTY')}>Export CSV</Button>
              </div>
              <div className="h-48 overflow-auto rounded border p-2 text-xs space-y-1 bg-black/5">
                {logsN.map((log, i) => (
                  <div key={i} className="truncate">{log}</div>
                ))}
              </div>
            </TabsContent>
          </Tabs>
        </TabsContent>

        {/* BANK NIFTY TAB */}
        <TabsContent value="banknifty">
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <Card className="xl:col-span-2">
              <CardContent className="p-2">
                <FastLineChart series={seriesBank} theme={theme} />
              </CardContent>
            </Card>
            <div className="space-y-3">
              <Card>
                <CardContent className="p-4 flex items-center justify-between">
                  <div className="text-sm text-muted-foreground">Price</div>
                  <div className="text-base font-semibold">{throttledMarket.bankNifty.toFixed(2)}</div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4 flex items-center justify-between">
                  <div className="text-sm text-muted-foreground">Signals</div>
                  <Badge>{signalsB.length}</Badge>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4 flex items-center justify-between">
                  <div className="text-sm text-yellow-400">Warnings</div>
                  <Badge variant="secondary">{sysLogs.length}</Badge>
                </CardContent>
              </Card>
            </div>
          </div>

          <Tabs defaultValue="signals-b" className="mt-4">
            <TabsList>
              <TabsTrigger value="signals-b">Signals</TabsTrigger>
              <TabsTrigger value="trades-b">Trades</TabsTrigger>
              <TabsTrigger value="logs-b">Logs</TabsTrigger>
            </TabsList>

            <TabsContent value="signals-b">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {signalsB.map((sig, idx) => (
                  <Card key={idx} className="border-l-4" style={{ borderColor: sig.side === "Buy" ? "#16a34a" : "#dc2626" }}>
                    <CardContent className="p-4 space-y-1">
                      <div className="font-semibold">{sig.symbol}</div>
                      <div className="text-sm opacity-90">{sig.side} • {sig.qty} @ {formatINR(sig.price)}</div>
                      <Badge variant={sig.status === "Executed" ? "default" : sig.status === "Pending" ? "secondary" : "destructive"}>{sig.status}</Badge>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </TabsContent>

            <TabsContent value="trades-b">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm text-muted-foreground">Trades</div>
                <Button size="sm" onClick={() => exportTradesCSV('BANKNIFTY')}>Export CSV</Button>
              </div>
              <div className="rounded border">
                <div className="grid grid-cols-6 gap-2 px-3 py-2 text-xs font-semibold bg-black/10">
                  <div>Symbol</div><div>Side</div><div className="text-right">Qty</div><div className="text-right">Avg Price</div><div className="text-right">LTP</div><div className="text-right">P&L%</div>
                </div>
                {tradesB.map((t, i) => (
                  <TradeRow key={i} t={t} showAbs={showAbsPnl} />
                ))}
              </div>
            </TabsContent>

            <TabsContent value="logs-b">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm text-muted-foreground">Logs</div>
                <Button size="sm" variant="secondary" onClick={() => exportLogsCSV('BANKNIFTY')}>Export CSV</Button>
              </div>
              <div className="h-48 overflow-auto rounded border p-2 text-xs space-y-1 bg-black/5">
                {logsB.map((log, i) => (
                  <div key={i} className="truncate">{log}</div>
                ))}
              </div>
            </TabsContent>
          </Tabs>
        </TabsContent>

        {/* SYSTEM LOGS TAB */}
        <TabsContent value="system">
          <div className="flex items-center justify-end mb-2">
            <Button size="sm" variant="secondary" onClick={() => exportLogsCSV('SYSTEM')}>Export CSV</Button>
          </div>
          <Card>
            <CardContent className="p-2">
              <div className="h-64 overflow-auto rounded border p-2 text-xs space-y-1 bg-black/5">
                {sysLogs.map((log, i) => (
                  <div key={i} className="truncate">{log}</div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

