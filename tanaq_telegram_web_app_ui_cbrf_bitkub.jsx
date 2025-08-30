import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Bot, RefreshCw, Calculator, ChevronDown, Wallet, History, Copy, Check, Settings, Sparkles } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

// -------------------------------------------------
// TANAQ – Telegram Mobile Web App UI
// Upgrades:
//  - Telegram WebApp integration (theme, MainButton, haptics)
//  - CBRF rates (official RUB quotes)
//  - Bitkub liquidity path (USDT→THB orderbook -> THB→RUB via CBRF)
//  - Result shows Δ vs CBRF
// -------------------------------------------------

const DEFAULT_CURRENCIES = [
  { code: "USD", name: "US Dollar" },
  { code: "USDT", name: "Tether USD" },
  { code: "EUR", name: "Euro" },
  { code: "CNY", name: "Chinese Yuan" },
  { code: "THB", name: "Thai Baht" },
  { code: "AED", name: "UAE Dirham" },
  { code: "HKD", name: "Hong Kong Dollar" },
  { code: "TRY", name: "Turkish Lira" },
  { code: "INR", name: "Indian Rupee" },
  { code: "JPY", name: "Japanese Yen" },
];

const LOCAL_STORAGE_KEY = "tanaq_state_v2";

function usePersistentState(initial) {
  const [state, setState] = useState(() => {
    try {
      const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
      return raw ? JSON.parse(raw) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try { localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(state)); } catch { }
  }, [state]);
  return [state, setState];
}

export default function TanaqTelegramApp() {
  const [state, setState] = usePersistentState({
    amount: "1000",
    currency: "USD",
    autoFetch: true,
    addBankSpread: true,
    spreadPct: 1.2,
    rates: {},
    lastUpdated: null,
    dark: true,
    history: [], // {ts, amount, currency, rate, rub}
    customRate: "",
    // sources
    source: "market", // 'market' | 'cbrf' | 'bitkub'
    cbrfRates: {},
    cbrfUpdated: null,
    bitkubDepth: null, // { bids:[[price,qty],...], asks:[[price,qty],...] }
    bitkubUpdated: null,
  });

  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const tgRef = useRef(null);

  // -------- Providers --------
  async function fetchRates(selected = state.currency) {
    setLoading(true);
    setError("");
    try {
      const url = `https://api.exchangerate.host/latest?base=${encodeURIComponent(selected)}&symbols=RUB`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Network error");
      const data = await res.json();
      const rate = data?.rates?.RUB;
      if (!rate) throw new Error("No RUB rate");
      setState((s) => ({
        ...s,
        rates: { ...s.rates, [selected]: rate },
        lastUpdated: new Date().toISOString(),
      }));
    } catch (e) {
      console.error(e);
      setError((p) => p || "Не удалось обновить рыночный курс.");
    } finally {
      setLoading(false);
    }
  }

  async function fetchCbrfRates() {
    try {
      const res = await fetch("https://www.cbr-xml-daily.ru/daily_json.js");
      if (!res.ok) throw new Error("CBRF network error");
      const data = await res.json();
      const map = { RUB: 1 };
      if (data && data.Valute) {
        Object.values(data.Valute).forEach((v) => {
          const code = v.CharCode;
          const nominal = Number(v.Nominal) || 1;
          const value = Number(v.Value);
          if (code && value) map[code] = value / nominal; // RUB per 1 unit
        });
      }
      setState((s) => ({ ...s, cbrfRates: map, cbrfUpdated: new Date().toISOString() }));
    } catch (e) {
      console.error(e);
      setError((p) => p || "Не удалось получить курс ЦБ РФ.");
    }
  }

  async function fetchBitkubDepth() {
    try {
      const res = await fetch("https://api.bitkub.com/api/market/depth?sym=THB_USDT");
      if (!res.ok) throw new Error("Bitkub network error");
      const data = await res.json();
      setState((s) => ({ ...s, bitkubDepth: data, bitkubUpdated: new Date().toISOString() }));
    } catch (e) {
      console.error(e);
      setError((p) => p || "Bitkub недоступен (возможен CORS).");
    }
  }

  // Weighted avg from orderbook levels [ [price, qty], ... ]
  function weightedAvg(levels = [], qty) {
    if (!Array.isArray(levels) || !(qty > 0)) return { avg: null, covered: 0 };
    let remaining = qty;
    let totalCost = 0;
    let filled = 0;
    for (const [price, amount] of levels) {
      const take = Math.min(remaining, amount);
      if (take <= 0) break;
      totalCost += take * price;
      remaining -= take;
      filled += take;
      if (remaining <= 0) break;
    }
    return filled > 0 ? { avg: totalCost / filled, covered: filled / qty } : { avg: null, covered: 0 };
  }

  // -------- Telegram Integration --------
  useEffect(() => {
    const tg = window?.Telegram?.WebApp;
    if (!tg) return;
    tgRef.current = tg;
    try {
      tg.ready();
      tg.expand();
      if (tg.colorScheme) setState((s) => ({ ...s, dark: tg.colorScheme === "dark" }));
      const onTheme = () => setState((s) => ({ ...s, dark: tg.colorScheme === "dark" }));
      const onClick = () => { saveToHistory(); tg.HapticFeedback?.impactOccurred?.("light"); };
      tg.onEvent("themeChanged", onTheme);
      tg.onEvent("mainButtonClicked", onClick);
      return () => { tg.offEvent("themeChanged", onTheme); tg.offEvent("mainButtonClicked", onClick); };
    } catch { }
  }, []);

  useEffect(() => {
    const tg = tgRef.current;
    if (!tg) return;
    const label = rubResult > 0 ? `Сохранить ${rubResult.toLocaleString(undefined, { maximumFractionDigits: 2 })} ₽` : "Сохранить расчёт";
    tg.MainButton.setParams?.({ text: label });
    if (rubResult > 0) tg.MainButton.show?.(); else tg.MainButton.hide?.();
  }, [state.amount]);

  // -------- Auto fetches --------
  useEffect(() => {
    if (state.autoFetch && !state.rates[state.currency]) fetchRates(state.currency);
  }, [state.currency]);

  useEffect(() => {
    if (state.autoFetch && (!state.cbrfUpdated || Object.keys(state.cbrfRates).length === 0)) fetchCbrfRates();
  }, []);

  useEffect(() => {
    if (state.source === "bitkub" && state.currency === "USDT") fetchBitkubDepth();
  }, [state.source, state.currency]);

  // -------- Derived values --------
  const cbrfRate = useMemo(() => state.cbrfRates?.[state.currency] ?? null, [state.cbrfRates, state.currency]);

  const bitkubCalc = useMemo(() => {
    if (state.currency !== "USDT" || !state.bitkubDepth) return null;
    const amt = Number(state.amount.replace(",", "."));
    if (!(amt > 0)) return null;
    // selling USDT -> hit bids
    const { avg, covered } = weightedAvg(state.bitkubDepth?.bids ?? [], amt);
    return { avgThbPerUsdt: avg, covered };
  }, [state.currency, state.amount, state.bitkubDepth]);

  const bitkubRubRate = useMemo(() => {
    if (!bitkubCalc?.avgThbPerUsdt) return null;
    const thbRub = state.cbrfRates?.THB; // RUB per 1 THB
    if (!thbRub) return null;
    return bitkubCalc.avgThbPerUsdt * thbRub; // RUB per 1 USDT
  }, [bitkubCalc, state.cbrfRates]);

  const activeRate = useMemo(() => {
    const direct = Number(state.customRate);
    if (!isNaN(direct) && direct > 0) return direct;

    let base = null;
    if (state.source === "cbrf" && cbrfRate) base = cbrfRate;
    else if (state.source === "bitkub" && bitkubRubRate) base = bitkubRubRate;
    else {
      const r = state.rates?.[state.currency];
      if (r) base = r;
    }
    if (!base) return null;
    return state.addBankSpread ? base * (1 - state.spreadPct / 100) : base;
  }, [state.customRate, state.source, cbrfRate, bitkubRubRate, state.rates, state.currency, state.addBankSpread, state.spreadPct]);

  const rubResult = useMemo(() => {
    const amt = Number(state.amount.replace(",", "."));
    if (isNaN(amt) || !activeRate) return 0;
    return Math.round(amt * activeRate * 100) / 100;
  }, [state.amount, activeRate]);

  const deltaAbs = useMemo(() => (activeRate && cbrfRate ? activeRate - cbrfRate : null), [activeRate, cbrfRate]);
  const deltaPct = useMemo(() => (deltaAbs !== null && cbrfRate ? (deltaAbs / cbrfRate) * 100 : null), [deltaAbs, cbrfRate]);

  // -------- UX helpers --------
  const saveToHistory = () => {
    if (!activeRate) return;
    const item = { ts: Date.now(), amount: Number(state.amount), currency: state.currency, rate: activeRate, rub: rubResult };
    setState((s) => ({ ...s, history: [item, ...s.history].slice(0, 25) }));
  };

  const copyResult = async () => {
    try { await navigator.clipboard.writeText(String(rubResult)); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { }
  };

  const toggleTheme = () => setState((s) => ({ ...s, dark: !s.dark }));

  // -------- UI --------
  return (
    <div className={state.dark ? "min-h-screen bg-[#0f1115] text-white" : "min-h-screen bg-white text-slate-900"}>
      {/* Simulated Telegram top bar */}
      <div className={"sticky top-0 z-30 backdrop-blur " + (state.dark ? "bg-[#0f1115]/70" : "bg-white/70 border-b border-slate-200")}>
        <div className="max-w-md mx-auto px-3 py-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bot className="w-5 h-5" />
            <span className="text-sm opacity-70">Web App</span>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant={state.dark ? "secondary" : "outline"} onClick={toggleTheme}>Тема</Button>
          </div>
        </div>
      </div>

      <main className="max-w-md mx-auto p-4 pb-24">
        {/* Logo / Wordmark */}
        <div className="flex items-center justify-center mb-4">
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} className="text-3xl font-black tracking-[0.25em]">TANAQ</motion.div>
        </div>

        {/* Headline */}
        <div className="text-center mb-6">
          <h1 className="text-xl font-semibold">Конвертер валют → RUB</h1>
          <p className={"mt-1 text-sm " + (state.dark ? "text-slate-300" : "text-slate-600")}>Для закупки лабораторного оборудования: быстро, точно, с учётом спрэда.</p>
        </div>

        {/* Converter Card */}
        <Card className={state.dark ? "bg-[#141821] border-slate-800" : "bg-white"}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Calculator className="w-5 h-5" /> Введите сумму и выберите валюту
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-12 gap-2 items-end">
              <div className="col-span-7">
                <Label htmlFor="amount">Сумма в иностранной валюте</Label>
                <Input id="amount" inputMode="decimal" value={state.amount} onChange={(e) => setState({ ...state, amount: e.target.value })} className={state.dark ? "bg-[#0f1115] border-slate-700" : ""} placeholder="Например, 1250" />
              </div>
              <div className="col-span-5">
                <Label>Валюта</Label>
                <div className="relative">
                  <select value={state.currency} onChange={(e) => setState({ ...state, currency: e.target.value })} className={"w-full appearance-none rounded-md border px-3 py-2 pr-8 text-sm focus:outline-none " + (state.dark ? "bg-[#0f1115] border-slate-700" : "bg-white border-slate-300")}>
                    {DEFAULT_CURRENCIES.map((c) => (<option key={c.code} value={c.code}>{c.code} — {c.name}</option>))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2 top-2.5 h-4 w-4 opacity-60" />
                </div>
              </div>
            </div>

            {/* Quick currency chips */}
            <div className="flex flex-wrap gap-2">
              {DEFAULT_CURRENCIES.slice(0, 6).map((c) => (
                <Button key={c.code} variant={state.currency === c.code ? "default" : "outline"} size="sm" onClick={() => setState({ ...state, currency: c.code })}>{c.code}</Button>
              ))}
            </div>

            {/* Rate Row */}
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm">
                <div className="opacity-70">Курс (≈ RUB за 1 {state.currency})</div>
                <div className="text-lg font-semibold">{activeRate ? activeRate.toFixed(4) : "—"}</div>
                <div className="text-xs opacity-60 mt-1">Источник: {state.source === 'market' ? 'exchangerate.host' : state.source === 'cbrf' ? 'ЦБ РФ' : 'Bitkub + ЦБ РФ (THB→RUB)'} {state.lastUpdated ? new Date(state.lastUpdated).toLocaleString() : '—'}</div>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => fetchRates(state.currency)} disabled={loading}><RefreshCw className={"h-4 w-4 mr-1 " + (loading ? "animate-spin" : "")} /> Обновить</Button>
                <Button size="sm" variant="outline" onClick={() => { fetchRates(state.currency); fetchCbrfRates(); if (state.source === 'bitkub' && state.currency === 'USDT') fetchBitkubDepth(); }}>Обновить всё</Button>
              </div>
            </div>

            {/* Bitkub liquidity (USDT only) */}
            {state.source === 'bitkub' && state.currency === 'USDT' && (
              <Card className={state.dark ? "bg-[#0b0e14] border-slate-800" : "bg-slate-50"}>
                <CardContent className="py-3 text-sm">
                  <div className="flex items-center justify-between">
                    <div>Bitkub средняя цена THB/USDT для объёма {state.amount}: <span className="font-medium">{bitkubCalc?.avgThbPerUsdt ? bitkubCalc.avgThbPerUsdt.toFixed(2) : '—'}</span></div>
                    <div>Покрытие: {bitkubCalc?.covered ? Math.round(bitkubCalc.covered * 100) : 0}%</div>
                  </div>
                  <div className="text-xs opacity-60 mt-1">{state.bitkubUpdated ? `Обновлено: ${new Date(state.bitkubUpdated).toLocaleString()}` : '—'}</div>
                </CardContent>
              </Card>
            )}

            {/* Advanced settings */}
            <details className="rounded-lg border p-3 text-sm " open>
              <summary className="cursor-pointer select-none font-medium flex items-center gap-2"><Settings className="w-4 h-4" /> Настройки точности</summary>
              <div className="mt-3 grid gap-3">
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <Label htmlFor="source">Источник курса</Label>
                    <div className="text-xs opacity-70">Выберите источник расчёта RUB за 1 единицу валюты</div>
                  </div>
                  <select id="source" value={state.source} onChange={(e) => setState({ ...state, source: e.target.value })} className={"w-44 rounded-md border px-2 py-2 text-sm " + (state.dark ? "bg-[#0f1115] border-slate-700" : "bg-white border-slate-300")}>
                    <option value="market">Рынок (exchangerate.host)</option>
                    <option value="cbrf">ЦБ РФ (официальный)</option>
                    <option value="bitkub">Bitkub ликвидность (USDT→THB)</option>
                  </select>
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <Label htmlFor="spread">Учитывать банковский спред</Label>
                    <div className="text-xs opacity-70">Консервативно уменьшает получаемый курс на указанный %</div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Input id="spread" type="number" className={"w-20 text-right " + (state.dark ? "bg-[#0f1115] border-slate-700" : "")} value={state.spreadPct} onChange={(e) => setState({ ...state, spreadPct: Number(e.target.value) })} />
                    <Switch checked={state.addBankSpread} onCheckedChange={(v) => setState({ ...state, addBankSpread: v })} />
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <Label htmlFor="customRate">Пользовательский курс (RUB за 1 {state.currency})</Label>
                    <div className="text-xs opacity-70">Если задан, используется вместо выбранного источника</div>
                  </div>
                  <Input id="customRate" placeholder="Например, 98.45" className={"w-32 text-right " + (state.dark ? "bg-[#0f1115] border-slate-700" : "")} value={state.customRate} onChange={(e) => setState({ ...state, customRate: e.target.value })} />
                </div>
              </div>
            </details>

            {/* Result */}
            <Card className={state.dark ? "bg-[#0b0e14] border-slate-800" : "bg-slate-50"}>
              <CardContent className="py-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm opacity-70">Итого в рублях</div>
                    <div className="text-3xl font-bold">{rubResult.toLocaleString(undefined, { maximumFractionDigits: 2 })} ₽</div>
                  </div>
                  <div className="text-right text-xs opacity-80">
                    <div>Курс ЦБ РФ: {cbrfRate ? cbrfRate.toFixed(4) : '—'} ₽ за 1 {state.currency}</div>
                    {deltaPct !== null && (
                      <div>Δ к ЦБ РФ: {deltaAbs!.toFixed(4)} ₽ ({deltaPct!.toFixed(2)}%) на 1 {state.currency}</div>
                    )}
                    {deltaPct !== null && (
                      <div>На сумму: {(Number(state.amount.replace(',', '.')) * (deltaAbs || 0)).toLocaleString(undefined, { maximumFractionDigits: 2 })} ₽</div>
                    )}
                  </div>
                </div>
                <div className="flex gap-2 mt-3">
                  <Button onClick={saveToHistory}><Wallet className="w-4 h-4 mr-1" /> Сохранить</Button>
                  <Button variant="outline" onClick={copyResult}>{copied ? <Check className="w-4 h-4 mr-1" /> : <Copy className="w-4 h-4 mr-1" />}{copied ? "Скопировано" : "Копировать"}</Button>
                </div>
              </CardContent>
            </Card>

            {error && (<div className="text-sm text-red-400">{error}</div>)}
          </CardContent>
        </Card>

        {/* Quick supplier presets */}
        <div className="mt-6">
          <div className="flex items-center gap-2 mb-2"><Sparkles className="w-4 h-4" /><div className="text-sm font-medium">Популярные валюты у поставщиков</div></div>
          <div className="grid grid-cols-3 gap-2">{["USD", "USDT", "EUR", "CNY", "HKD", "THB"].map(code => (<Button key={code} variant="secondary" onClick={() => setState({ ...state, currency: code })}>{code}</Button>))}</div>
        </div>

        {/* History */}
        <div className="mt-6">
          <div className="flex items-center gap-2 mb-2"><History className="w-4 h-4" /><div className="text-sm font-medium">История</div></div>
          <AnimatePresence>
            {state.history.length === 0 ? (
              <div className={"text-sm " + (state.dark ? "text-slate-400" : "text-slate-600")}>Сохраняйте расчёты, чтобы быстро вернуться к ним.</div>
            ) : (
              state.history.map((h) => (
                <motion.div key={h.ts} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} className={"flex items-center justify-between rounded-xl border p-3 mb-2 " + (state.dark ? "bg-[#0f1115] border-slate-800" : "bg-white")}>
                  <div className="text-sm">
                    <div className="font-medium">{h.amount.toLocaleString()} {h.currency} → {h.rub.toLocaleString()} ₽</div>
                    <div className="opacity-70 text-xs">Курс: {h.rate.toFixed(4)} | {new Date(h.ts).toLocaleString()}</div>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(String(h.rub))}><Copy className="w-4 h-4" /></Button>
                </motion.div>
              ))
            )}
          </AnimatePresence>
        </div>
      </main>

      {/* Bottom bar */}
      <div className={"fixed bottom-0 left-0 right-0 z-40 border-t p-3 " + (state.dark ? "bg-[#0f1115]/85 border-slate-800 backdrop-blur" : "bg-white/90 border-slate-200 backdrop-blur")}>
        <div className="max-w-md mx-auto flex gap-2">
          <Button className="flex-1" onClick={saveToHistory}><Wallet className="w-4 h-4 mr-1" />Сохранить расчёт</Button>
          <Button variant="outline" className="w-12" onClick={() => { fetchRates(state.currency); if (state.source === 'cbrf') fetchCbrfRates(); if (state.source === 'bitkub' && state.currency === 'USDT') fetchBitkubDepth(); }}>
            <RefreshCw className={"w-4 h-4 mx-auto " + (loading ? "animate-spin" : "")} />
          </Button>
        </div>
      </div>
    </div>
  );
}
