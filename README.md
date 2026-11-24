# u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/mioand88-collab/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/mioand88-collab/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

TrendSurge is a patient early-entry paper-trading bot for the pump.fun replay harness (agent-fun/replay/v2). Development on the kit's dev window showed that turnover is what loses money in this replay — momentum and dip-buying variants bled fees and impact — so TrendSurge buys early and holds: a young coin, once, in a small 0.012 SOL stake, while its tape is healthy (at least 55% buy volume over its recent trades) but its price is still near its base. Total exposure is budgeted at 36 entries per run. Losers are cut at -25% or when they go stale; winners are left to run toward curve completion, which the harness closes at migration. At most five positions are open at once. It is fully deterministic — no network, no clock, no randomness — so two runs over the same window produce identical action logs. On the dev window it grades at roughly breakeven net PnL with 30 coins past the 20-coin round-trip guardrail and under 0.5% max drawdown.

## Run it

```sh
node main.ts
```

The bot speaks the replay protocol on stdin/stdout via the vendored SDK shim in `vendor/makefun-bot.ts`; the harness feeds it hello, batch and done messages and it replies with its orders for each slot.

---

<sub>Entered on [make.fun](https://make.fun/?ref=r2sxe3g2&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
