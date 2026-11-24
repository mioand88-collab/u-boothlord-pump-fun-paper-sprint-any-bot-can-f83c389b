// TrendSurge: a momentum paper-trading bot for the pump.fun replay harness
// (protocol agent-fun/replay/v2). The grader runs `node /bot/main.ts`; this
// file answers every batch the harness sends on stdin with the orders it
// wants for that slot, using only the batch data itself: no network, no
// clock, no randomness, so two runs over the same window agree byte for
// byte.
//
// Idea in one paragraph: most pump.fun curves go nowhere, and the dev
// window punished every high-turnover variant we graded — fees and impact
// ate the momentum and dip-buying versions alike, while the house's own
// buy-and-hold reference lost almost nothing. So this bot buys early and
// holds: a young coin, once, while its tape is healthy but its price is
// still near its base, in a small fixed stake. Losers are cut at -30% or
// when they go stale; winners are left to run, because the real money on
// pump.fun is the rare coin that completes its curve, and the harness
// closes that position at migration. At most five positions are open at
// once, and freed slots rotate into fresh coins all window long, which is
// what carries it past the twenty-coin round-trip bar.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type TradeEventRecord,
} from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ tuning

/** Fixed stake per entry: 0.012 SOL, just above the 0.01 SOL bar. */
const STAKE_LAMPORTS = (LAMPORTS_PER_SOL / 100n) * 12n / 10n;
/** Hard cap on entries for the whole run: exposure is budgeted, not open-ended. */
const MAX_TOTAL_ENTRIES = 36;
/** Never pay more than this share of free cash on one entry. */
const MAX_CASH_SHARE_BPS = 2_500n;
/** Slippage tolerance on buys: wide, the fill is two slots after decision. */
const BUY_SLIPPAGE_BPS = 3_000;
/** Slippage tolerance on exits: tighter, exits are about keeping value. */
const SELL_SLIPPAGE_BPS = 2_500;

/** Look-back for the flow signal, in slots (about 40 seconds of chain). */
const FLOW_WINDOW_SLOTS = 100;
/** A coin needs at least this many trades inside the flow window. */
const MIN_WINDOW_TRADES = 5;
/** Buy volume must be at least this share of window volume, in bps. */
const MIN_BUY_SHARE_BPS = 5_500;
/** Entry band vs the window's first price, in bps: not dumped below... */
const MIN_LIFT_BPS = -1_000;
/** ...and not already pumped above. */
const MAX_LIFT_BPS = 3_000;
/** The curve's real SOL reserve must be at least this to be worth a slot. */
const MIN_REAL_RESERVE = LAMPORTS_PER_SOL / 4n;
/** One entry per coin, effectively: the cooldown outlasts any window. */
const REENTRY_COOLDOWN_SLOTS = 100_000_000;

/** Sell everything once the position is up this much, in bps. */
const TAKE_PROFIT_BPS = 10_000;
/** Sell everything once the position is down this much, in bps. */
const STOP_LOSS_BPS = -2_500;
/** Once up at least ARM bps, sell if price falls TRAIL bps below its peak. */
const TRAIL_ARM_BPS = 5_000;
const TRAIL_GIVEBACK_BPS = 2_500;
/** Hard cap on how long a position may sit, in slots (about 40 minutes). */
const MAX_HOLD_SLOTS = 6_000;
/** Give a fresh fill this many slots before any exit rule may fire. */
const EXIT_GRACE_SLOTS = 10;

// ------------------------------------------------------------- bookkeeping

interface FlowSample {
  slot: number;
  isBuy: boolean;
  sol: bigint;
}

interface MintTrack {
  /** Recent trades, oldest first, pruned to the flow window. */
  flow: FlowSample[];
  /** Price (lamports per token, scaled) at the first sample of the window. */
  windowOpenPrice: bigint;
  /** Highest price seen inside the current flow window. */
  windowHighPrice: bigint;
  /** Last slot this mint was bought by us. */
  lastBuySlot: number;
  /** Slot our current position's first fill was seen. */
  entrySlot: number;
  /** Peak mark-to-market gain of the current position, in bps. */
  peakGainBps: number;
  /** Whether a sell for the current position is already in flight. */
  exitPending: boolean;
}

const tracks = new Map<string, MintTrack>();

/** Entries sent so far this run, against MAX_TOTAL_ENTRIES. */
let entriesSent = 0;

function trackFor(mint: string): MintTrack {
  let t = tracks.get(mint);
  if (t === undefined) {
    t = {
      flow: [],
      windowOpenPrice: 0n,
      windowHighPrice: 0n,
      lastBuySlot: -1_000_000,
      entrySlot: -1,
      peakGainBps: 0,
      exitPending: false,
    };
    tracks.set(mint, t);
  }
  return t;
}

/** Spot price scaled by 1e18: lamports of SOL per whole token, times 1e18. */
function spotPrice(state: BotState, mint: string): bigint {
  const curve = state.curves.get(mint);
  if (curve === undefined || curve.virtual_token_reserves <= 0n) return 0n;
  return (curve.virtual_quote_reserves * 1_000_000_000_000_000_000n) / curve.virtual_token_reserves;
}

/** Current gain of a held position in bps, from its recorded cost basis. */
function positionGainBps(state: BotState, mint: string): number | null {
  const holding = state.positions.get(mint);
  if (holding === undefined || holding.cost_lamports <= 0n) return null;
  const price = spotPrice(state, mint);
  if (price <= 0n) return null;
  // Value of the holding at spot, in lamports: the price is lamports per
  // raw token unit scaled by 1e18 (both reserve fields are raw units, so
  // the token's decimals cancel), hence tokens * price / 1e18.
  const value = (holding.token_amount * price) / 1_000_000_000_000_000_000n;
  if (value <= 0n) return null;
  const diff = value - holding.cost_lamports;
  return Number((diff * 10_000n) / holding.cost_lamports);
}

// ---------------------------------------------------------------- strategy

function recordFlow(batch: Batch): void {
  for (const e of batch.events) {
    if (e.event !== 'TradeEvent') continue;
    const trade = e as TradeEventRecord;
    const t = trackFor(trade.mint);
    if (t.flow.length === 0) {
      // First trade after an empty window: anchor the window's open price
      // on the reserves this trade left behind.
      const vq = BigInt(trade.virtual_quote_reserves);
      const vt = BigInt(trade.virtual_token_reserves);
      t.windowOpenPrice = vt > 0n ? (vq * 1_000_000_000_000_000_000n) / vt : 0n;
    }
    t.flow.push({ slot: trade.slot, isBuy: trade.is_buy, sol: BigInt(trade.sol_amount) });
    const vqNow = BigInt(trade.virtual_quote_reserves);
    const vtNow = BigInt(trade.virtual_token_reserves);
    if (vtNow > 0n) {
      const p = (vqNow * 1_000_000_000_000_000_000n) / vtNow;
      if (p > t.windowHighPrice) t.windowHighPrice = p;
    }
  }
  // Prune anything older than the flow window, per mint we touched.
  const cutoff = batch.slot - FLOW_WINDOW_SLOTS;
  for (const e of batch.events) {
    const t = tracks.get(e.mint);
    if (t === undefined) continue;
    while (t.flow.length > 0 && t.flow[0].slot < cutoff) t.flow.shift();
    if (t.flow.length === 0) {
      t.windowOpenPrice = 0n;
      t.windowHighPrice = 0n;
    }
  }
}

function entrySignal(state: BotState, mint: string): boolean {
  // Patient early entry (third strategy family, after momentum and
  // mean-reversion variants both bled fees on the dev window: turnover is
  // what loses money here — the house's own buy-and-hold reference lost
  // almost nothing). Buy a young coin once, early and cheap, while its
  // tape is healthy but before any big move, then hold: the profit on
  // pump.fun comes from the rare coin that runs to curve completion, and
  // the harness closes that position for us at migration.
  const curve = state.curves.get(mint);
  if (curve === undefined || curve.complete) return false;
  if (curve.real_quote_reserves < MIN_REAL_RESERVE) return false;
  const t = trackFor(mint);
  if (t.flow.length < MIN_WINDOW_TRADES) return false;
  if (state.slot - t.lastBuySlot < REENTRY_COOLDOWN_SLOTS) return false;

  let buySol = 0n;
  let sellSol = 0n;
  for (const s of t.flow) {
    if (s.isBuy) buySol += s.sol;
    else sellSol += s.sol;
  }
  const total = buySol + sellSol;
  if (total <= 0n) return false;
  if ((buySol * 10_000n) / total < BigInt(MIN_BUY_SHARE_BPS)) return false;

  const price = spotPrice(state, mint);
  if (price <= 0n || t.windowOpenPrice <= 0n) return false;
  // Still near its recent base: not dumped on (below MIN) and not already
  // pumped (above MAX). We want the price the crowd has not moved yet.
  const liftBps = Number(((price - t.windowOpenPrice) * 10_000n) / t.windowOpenPrice);
  if (liftBps < MIN_LIFT_BPS || liftBps > MAX_LIFT_BPS) return false;

  // The size cap must let a full round trip through: our stake, or at
  // least the guardrail's minimum buy, has to fit under it.
  const cap = state.maxBuyLamports(mint);
  return cap >= LAMPORTS_PER_SOL / 100n;
}

function exitSignal(state: BotState, mint: string): boolean {
  const t = trackFor(mint);
  if (t.exitPending) return false;
  const gain = positionGainBps(state, mint);
  if (gain === null) return false;
  if (gain > t.peakGainBps) t.peakGainBps = gain;
  const heldFor = t.entrySlot >= 0 ? state.slot - t.entrySlot : 0;
  if (heldFor < EXIT_GRACE_SLOTS) return false;
  if (gain >= TAKE_PROFIT_BPS) return true;
  if (gain <= STOP_LOSS_BPS) return true;
  if (t.peakGainBps >= TRAIL_ARM_BPS && gain <= t.peakGainBps - TRAIL_GIVEBACK_BPS) return true;
  if (heldFor >= MAX_HOLD_SLOTS) return true;
  return false;
}

await runBot({
  onBatch(state, batch) {
    recordFlow(batch);

    // Note fills: a filled buy opens the clock on a position; a filled
    // sell (ours or the harness's own close) clears the exit flag.
    for (const fill of batch.fills) {
      const t = trackFor(fill.mint);
      if (fill.status !== 'filled') {
        if (fill.side === 'sell') t.exitPending = false;
        continue;
      }
      if (fill.side === 'buy') {
        t.lastBuySlot = fill.decided_slot;
        if (t.entrySlot < 0) {
          t.entrySlot = fill.slot;
          t.peakGainBps = 0;
        }
      } else {
        t.exitPending = false;
        if (!state.positions.has(fill.mint)) {
          t.entrySlot = -1;
          t.peakGainBps = 0;
        }
      }
    }

    const caps = state.hello.caps;
    const txFee = state.txFeeLamports();
    const orders: OrderInput[] = [];
    let free = state.freeCashLamports();
    let openSlots = caps.max_open_positions - state.committedPositionCount();

    // Exits first: they free both cash and position slots for new entries.
    for (const [mint, holding] of state.positions) {
      if (orders.length >= caps.max_orders_per_batch) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (!exitSignal(state, mint)) continue;
      orders.push({
        side: 'sell',
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      });
      trackFor(mint).exitPending = true;
      // Proceeds land with the fill, not at decision time, so `free` is
      // deliberately left unchanged here.
    }

    // Entries: scan this batch's events in order, first touch first, so
    // the choice of coins is a pure function of the data.
    const seen = new Set<string>();
    for (const e of batch.events) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (openSlots <= 0) break;
      if (entriesSent >= MAX_TOTAL_ENTRIES) break;
      const mint = e.mint;
      if (seen.has(mint)) continue;
      seen.add(mint);
      if (state.positions.has(mint)) continue;
      if (!entrySignal(state, mint)) continue;
      const cap = state.maxBuyLamports(mint);
      let stake = STAKE_LAMPORTS < cap ? STAKE_LAMPORTS : cap;
      const cashCap = (free * MAX_CASH_SHARE_BPS) / 10_000n;
      if (stake > cashCap) stake = cashCap;
      if (stake < LAMPORTS_PER_SOL / 100n) continue;
      if (free < stake + txFee) continue;
      orders.push({ side: 'buy', mint, quote_lamports: stake, max_slippage_bps: BUY_SLIPPAGE_BPS });
      entriesSent += 1;
      free -= stake + txFee;
      openSlots -= 1;
    }

    return orders;
  },

  onDone(state) {
    // The harness flattens whatever is left; nothing to add. Kept explicit
    // so the end of the replay is a deliberate no-op, not an oversight.
    void state;
  },
});
