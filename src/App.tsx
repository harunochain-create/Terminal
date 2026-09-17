/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import { Pickaxe, AlertCircle, RefreshCw, Sun, Moon } from 'lucide-react';
import type { AppState } from './types';

function formatHashrate(rate: number | undefined | null, status?: string): string {
  if (rate !== undefined && rate !== null && rate > 0) {
    if (rate < 1000) return `${rate.toFixed(2)} H/s`;
    if (rate < 1000000) return `${(rate / 1000).toFixed(2)} kH/s`;
    return `${(rate / 1000000).toFixed(2)} MH/s`;
  }
  
  if (status === 'STARTING' || status === 'CONNECTING') {
    return 'Waiting for hashrate...';
  }
  if (status === 'CONNECTED') {
    return 'Initializing dataset...';
  }
  return '0.00 H/s';
}

function formatXMR(val: number | string | undefined | null): string {
  if (val === undefined || val === null || val === '') return '0.000000000000';
  const num = Number(val);
  if (isNaN(num)) return '0.000000000000';
  return num.toFixed(12);
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('mining_theme');
      if (saved === 'light' || saved === 'dark') return saved;
    }
    return 'dark';
  });

  const toggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    if (typeof window !== 'undefined') {
      localStorage.setItem('mining_theme', nextTheme);
    }
  };

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let intervalId: any;
    let eventSource: EventSource | null = null;
    let isSubscribed = true;

    const fetchState = async () => {
      try {
        const res = await fetch('/api/state');
        if (res.ok && isSubscribed) {
          const data = await res.json();
          setState(data);
          setLoading(false);
        }
      } catch (err) {
        // Silently retry during initial connection / dev server restart
        if (isSubscribed && !intervalId) {
          intervalId = setInterval(fetchState, 1500);
        }
      }
    };

    // Initial fetch
    fetchState();

    const connectSSE = () => {
      try {
        eventSource = new EventSource('/api/events');

        eventSource.onmessage = (event) => {
          try {
            if (!isSubscribed) return;
            const data = JSON.parse(event.data);
            setState(data);
            setLoading(false);
          } catch (err) {
            // Non-fatal parse error
          }
        };

        eventSource.onerror = () => {
          if (eventSource) {
            eventSource.close();
            eventSource = null;
          }
          if (isSubscribed && !intervalId) {
            intervalId = setInterval(fetchState, 2000);
          }
        };
      } catch (e) {
        if (isSubscribed && !intervalId) {
          intervalId = setInterval(fetchState, 2000);
        }
      }
    };

    connectSSE();

    // Fallback polling to guarantee state freshness
    const backupPolling = setInterval(() => {
      if (isSubscribed) {
        fetchState();
      }
    }, 5000);

    return () => {
      isSubscribed = false;
      if (eventSource) eventSource.close();
      if (intervalId) clearInterval(intervalId);
      clearInterval(backupPolling);
    };
  }, []);

  const isDark = theme === 'dark';

  if (loading || !state) {
    return (
      <div className={`min-h-screen flex items-center justify-center px-4 ${isDark ? 'bg-black text-white' : 'bg-white text-black'}`}>
        <div className="flex items-center gap-3">
          <RefreshCw className="w-6 h-6 animate-spin" />
          <span className="text-lg font-medium">Connecting to Auto-Miner...</span>
        </div>
      </div>
    );
  }

  const {
    isMining,
    miningStatus = 'STARTING',
    balance = 0,
    totalEarnedXMR = 0,
    priceUSD = 0,
    priceIDR = 0,
    isBackendAvailable,
    miningError,
    xmrigStats,
    threads = 8
  } = state;

  const formatTimeAgo = (timestamp: number | undefined) => {
    if (!timestamp || timestamp === 0) return 'Never';
    const diff = now - timestamp;
    if (diff < 0) return 'Just now';
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return `${sec} sec ago`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m < 60) return `${m}m ${s}s ago`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m ago`;
  };

  const usdValue = (balance * priceUSD).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

  const idrValue = (balance * priceIDR).toLocaleString('id-ID', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

  const formattedHashrate = formatHashrate(xmrigStats?.hashrate, miningStatus);
  const isPoolConnected = Boolean(xmrigStats?.poolConnected);
  const isWorkerRunning = Boolean(xmrigStats?.workerRunning || isMining);

  // Status Badge Helper
  const getStatusBadge = () => {
    if (miningStatus === 'HASHING') {
      return { label: 'ACTIVE', color: 'bg-emerald-500 animate-pulse' };
    }
    if (miningStatus === 'CONNECTED') {
      return { label: 'CONNECTED', color: 'bg-emerald-500' };
    }
    if (miningStatus === 'CONNECTING') {
      return { label: 'CONNECTING', color: 'bg-amber-500 animate-pulse' };
    }
    if (miningStatus === 'STARTING') {
      return { label: 'INITIALIZING', color: 'bg-amber-500 animate-pulse' };
    }
    if (miningStatus === 'DISCONNECTED') {
      return { label: 'DISCONNECTED', color: 'bg-amber-500' };
    }
    return { label: 'OFFLINE', color: 'bg-red-500' };
  };

  const statusBadge = getStatusBadge();

  return (
    <div
      className={`min-h-screen flex flex-col justify-center items-center p-4 sm:p-8 transition-colors duration-150 antialiased font-sans ${
        isDark ? 'bg-black text-white' : 'bg-white text-black'
      }`}
    >
      <main className="w-full max-w-2xl">
        
        {/* ONE SINGLE MAIN CONTAINER (No Inner Box Cards) */}
        <div
          id="mining-dashboard-container"
          className={`w-full rounded-3xl p-6 sm:p-10 border transition-colors duration-150 space-y-7 ${
            isDark
              ? 'bg-black border-neutral-800 text-white shadow-2xl'
              : 'bg-white border-neutral-300 text-black shadow-lg'
          }`}
        >
          
          {/* Header Row */}
          <div className="flex items-center justify-between gap-4 pb-2 border-b border-inherit">
            <div className="flex items-center gap-3">
              <Pickaxe className="w-7 h-7 shrink-0" />
              <div>
                <h1 className="text-xl sm:text-2xl font-bold tracking-tight leading-tight">
                  Mining Dashboard
                </h1>
                <p className="text-xs sm:text-sm font-medium">
                  Continuous 24/7 Auto-Mining
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              {/* Theme Toggle Button (Only SVG Icon, No Text) */}
              <button
                type="button"
                id="theme-toggle-btn"
                onClick={toggleTheme}
                aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
                title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
                className={`p-2.5 rounded-full border transition-transform hover:scale-110 active:scale-95 cursor-pointer flex items-center justify-center ${
                  isDark
                    ? 'border-neutral-700 bg-neutral-900 text-white'
                    : 'border-neutral-300 bg-neutral-100 text-black'
                }`}
              >
                {isDark ? (
                  <Sun className="w-5 h-5" />
                ) : (
                  <Moon className="w-5 h-5" />
                )}
              </button>

              {/* Status Badge */}
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-inherit text-xs sm:text-sm font-bold">
                <span className={`w-2.5 h-2.5 rounded-full ${statusBadge.color}`}></span>
                <span>{statusBadge.label}</span>
              </div>
            </div>
          </div>

          {/* Backend Error Banner (if any) */}
          {!isBackendAvailable && (
            <div className="border border-red-500 rounded-xl p-3 flex items-start gap-2.5 text-xs sm:text-sm">
              <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
              <span>{miningError || 'Mining backend is currently unavailable.'}</span>
            </div>
          )}

          {/* Telemetry Section (Pure direct layout, no nested box cards) */}
          <div className="space-y-6">
            
            {/* Hashrate & Threads */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-xs sm:text-sm font-semibold uppercase tracking-wider mb-1">
                  Hashrate
                </div>
                <div className={`font-mono tracking-tight ${typeof xmrigStats?.hashrate === 'number' && xmrigStats.hashrate > 0 ? 'text-3xl sm:text-5xl font-extrabold' : 'text-xl sm:text-2xl font-bold'}`}>
                  {formattedHashrate}
                </div>
              </div>
              <div>
                <div className="text-xs sm:text-sm font-semibold uppercase tracking-wider mb-1">
                  Threads
                </div>
                <div className="text-2xl sm:text-3xl font-bold font-mono">
                  {threads} Threads
                </div>
                <div className="text-xs sm:text-sm font-medium mt-1">
                  ● Auto Mode (24/7)
                </div>
              </div>
            </div>

            {/* Accepted & Rejected */}
            <div className="grid grid-cols-2 gap-4 pt-1">
              <div>
                <div className="text-xs sm:text-sm font-semibold uppercase tracking-wider mb-1">
                  Accepted
                </div>
                <div className="text-2xl sm:text-3xl font-bold font-mono">
                  {xmrigStats?.accepted ?? 0}
                </div>
              </div>
              <div>
                <div className="text-xs sm:text-sm font-semibold uppercase tracking-wider mb-1">
                  Rejected
                </div>
                <div className="text-2xl sm:text-3xl font-bold font-mono">
                  {xmrigStats?.rejected ?? 0}
                </div>
              </div>
            </div>

            {/* Pool & Last Share */}
            <div className="grid grid-cols-2 gap-4 pt-1">
              <div>
                <div className="text-xs sm:text-sm font-semibold uppercase tracking-wider mb-1">
                  Pool
                </div>
                <div className="text-lg sm:text-xl font-bold flex items-center gap-2">
                  <span className={`w-2.5 h-2.5 rounded-full ${isPoolConnected ? 'bg-emerald-500' : 'bg-amber-500'}`}></span>
                  <span>{isPoolConnected ? 'Connected' : (miningStatus === 'CONNECTING' || miningStatus === 'STARTING' ? 'Connecting...' : 'Disconnected')}</span>
                </div>
              </div>
              <div>
                <div className="text-xs sm:text-sm font-semibold uppercase tracking-wider mb-1">
                  Last Share
                </div>
                <div className="text-lg sm:text-xl font-bold font-mono">
                  {formatTimeAgo(xmrigStats?.lastShare)}
                </div>
              </div>
            </div>

            {/* Worker & Auto Mining */}
            <div className="grid grid-cols-2 gap-4 pt-1">
              <div>
                <div className="text-xs sm:text-sm font-semibold uppercase tracking-wider mb-1">
                  Worker
                </div>
                <div className="text-lg sm:text-xl font-bold">
                  {isWorkerRunning ? 'Running' : 'Initializing'}
                </div>
              </div>
              <div>
                <div className="text-xs sm:text-sm font-semibold uppercase tracking-wider mb-1">
                  Auto Mining
                </div>
                <div className="text-lg sm:text-xl font-bold">
                  Continuous 24/7
                </div>
              </div>
            </div>

          </div>

          {/* Divider */}
          <hr className="border-inherit" />

          {/* Confirmed Balance & Values Section (No inner boxes) */}
          <div className="space-y-5">
            <div>
              <div className="flex items-center justify-between text-xs sm:text-sm font-semibold uppercase tracking-wider mb-1.5">
                <span>Total Confirmed Balance</span>
                <span className="text-[10px] sm:text-xs font-mono opacity-60">12 Decimals (Atomic Precision)</span>
              </div>
              <div className="text-3xl sm:text-5xl font-extrabold font-mono tracking-tight break-all">
                {formatXMR(balance)}{' '}
                <span className="text-lg sm:text-2xl font-normal">
                  XMR
                </span>
              </div>
              {totalEarnedXMR > balance && (
                <div className="text-xs sm:text-sm font-mono opacity-75 mt-1">
                  Lifetime Total: {formatXMR(totalEarnedXMR)} XMR
                </div>
              )}
            </div>

            {/* Currency Conversions */}
            <div className="grid grid-cols-2 gap-4 pt-1">
              <div>
                <div className="text-xs sm:text-sm font-semibold uppercase tracking-wider mb-1">
                  USD Equivalent
                </div>
                <div className="text-2xl sm:text-3xl font-bold font-mono">
                  ${usdValue}
                </div>
              </div>

              <div>
                <div className="text-xs sm:text-sm font-semibold uppercase tracking-wider mb-1">
                  IDR Equivalent
                </div>
                <div className="text-2xl sm:text-3xl font-bold font-mono">
                  Rp{idrValue}
                </div>
              </div>
            </div>

            {/* Live Reference Market Rates */}
            <div className="pt-3 border-t border-inherit grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs sm:text-sm font-mono">
              <div>
                1 XMR = ${priceUSD.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
              <div>
                1 XMR = Rp{priceIDR.toLocaleString('id-ID', { maximumFractionDigits: 0 })}
              </div>
            </div>
          </div>

          {/* Footer Telemetry Status */}
          <div className="pt-2 border-t border-inherit flex items-center justify-between text-xs font-mono">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
              <span>SSE Realtime Stream Active</span>
            </div>
            <span>Auto-Updated</span>
          </div>

        </div>

      </main>
    </div>
  );
}
