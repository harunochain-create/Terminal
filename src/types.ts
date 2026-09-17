export type MiningStatus = 
  | 'STARTING'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'HASHING'
  | 'DISCONNECTED'
  | 'ERROR'
  | 'STOPPED';

export interface XmrigStats {
  hashrate: number | null;
  hashrate10s?: number | null;
  hashrate60s?: number | null;
  hashrate15m?: number | null;
  highestHashrate?: number | null;
  accepted: number;
  rejected: number;
  poolConnected: boolean;
  poolUrl?: string;
  diff?: number;
  lastShare: number;
  workerRunning: boolean;
  uptimeSeconds?: number;
  statusText?: string;
}

export interface AppState {
  isMining: boolean;
  miningStatus: MiningStatus;
  sessionStartTime: number | null;
  currentSessionEarned: number;
  totalEarnedXMR: number;
  balance: number;
  walletAddress: string;
  priceUSD: number;
  priceIDR: number;
  isBackendAvailable: boolean;
  miningError: string | null;
  transactions: Transaction[];
  xmrigStats: XmrigStats | null;
  threads: number;
  autoMining: boolean;
  poolName?: string;
  workerId?: string;
}

export interface Transaction {
  id: string;
  amount: number;
  status: string;
  date: number;
}

export interface DiagnosticCheck {
  name: string;
  status: 'ok' | 'warning' | 'error';
  message: string;
}
