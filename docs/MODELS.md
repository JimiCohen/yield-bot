# Models

The four load-bearing models in this bot, with their assumptions stated
plainly. Anything labeled *assumption* is a config parameter to be validated
(and re-fitted) against the Phase 3 backtest and the live
predicted-vs-realized ledger.

---

## 1. Net Expected Yield (NEY)

For every eligible pool, over the configured horizon `H` (default 7 days),
**everything in USDC**:

```
NEY = max( conf_fee · Fees(w),  conf_em · Emissions_realizable ) · T_in_range(w, σ, H)
      − LVR(w, σ, H)
      − E[rebalances(w, σ, H)] · cost_per_rebalance
      − amortized entry/exit gas + slippage
```

Notes:

- **`max(...)`, not `+`.** On Aerodrome, a gauge-staked Slipstream position
  earns AERO emissions and forfeits swap fees (they go to veAERO voters); an
  unstaked position earns fees and no AERO. The bot chooses the better arm
  per pool. In ve(3,3) equilibrium the staked/emission arm usually wins —
  which means most yield is in the low-confidence bucket, by construction.
- `conf_fee = 0.9` (fees accrue in the pair's own assets; high confidence),
  `conf_em = 0.7` (AERO-denominated; price risk between harvest events).
- `w` is the range width chosen by the optimizer in §3, not a constant.
- Slippage is computed per decision by simulating our actual trade size
  through the on-chain quoter — never a fixed constant. At $500 against
  $8–12M pools it is near zero; the model keeps it explicit anyway because
  the same code must be honest at $250k.
- APR is only ever a display format. Decisions compare USDC over `H`.

**Outlier rejection:** if DeFiLlama (or any advisory source) shows an APY
that on-chain fee growth + gauge `rewardRate` cannot reconcile within
tolerance, the pool is rejected as unverifiable rather than believed.

---

## 2. Emission valuation (realizable, not spot)

AERO emissions are valued by answering: *"if we harvested and sold right
now, at our size, what USDC would we actually hold?"* — then discounting.

```
aero_per_year   = gauge.rewardRate · 31_536_000 · our_share_of_staked_liquidity
usdc_realizable = quoter(AERO -> USDC, harvest_lot_size)   // includes our own price impact
value           = usdc_realizable · (1 − haircut) · (1 − decay_30d)^(H/30)
```

- `haircut` (default 0.15): covers swap fees, realization timing, and the
  structural fact that AERO is continuously emitted and continuously sold.
- `decay_30d` (default 0.10): *assumption* of AERO price erosion over the
  horizon. Conservative on purpose; re-fit from realized data.
- Auto-compound policy: harvest → swap to pool ratio → re-add liquidity, but
  **only** when pending rewards ≥ `compound.min_cost_multiple` × estimated
  compounding cost (gas + swap fees). At $500 this clears roughly weekly;
  compounding more often than that just donates the yield to gas.

---

## 3. Fees vs LVR: range width selection

For a CL position of width `w` (price band around current price), the
leverage factor `L(w)` amplifies **both** sides of the same coin while the
price is in range:

- Fee share: `L(w)` × the full-range fee rate.
- Loss-versus-rebalancing: `L(w)` × the full-range LVR base rate, which for
  a GBM price with volatility σ is **σ²/8 per unit time** on position value
  (Milionis–Moallemi–Roughgarden–Zhang).

So concentration is only profitable when the pool's in-range fee (or
emission) rate exceeds the LVR base rate, and the true costs of tightness
are (a) time spent out of range earning nothing and (b) rebalance frequency
× fixed cost. The optimizer maximizes over a grid of widths:

```
J(w) = L(w) · P_in_range(w, σ, H) · (yield_rate − σ²/8) · H
       − E[rebalances(w, σ, H)] · cost_per_rebalance
```

with σ estimated as EWMA realized volatility from on-chain price history.
`P_in_range` and `E[rebalances]` come from first-exit-time statistics of the
price process against the band edges (E[T_exit] = ln(m_eff)²/σ², zero drift
assumed — conservative, since drift only shortens exits).

Two constraints live INSIDE the optimizer, not just in the execution layer:

- **Rate limit as dead time:** range exits beyond `max_rebalances_per_day`
  are not serviced, so the model charges them as out-of-range time (position
  one-sided, earning nothing) rather than pretending extra rebalances are
  free. This is what stops the optimizer from choosing absurdly tight ranges.
- **Tick-spacing floor:** a position must span at least one tick spacing, so
  wide-spacing pools (e.g. 2000) cannot be given tight ranges.

Oracle-TWAP vol is corrected by √(3/2): differencing consecutive window
averages of a diffusion damps realized variance by 2/3, and understating σ
understates LVR — the expensive direction to be wrong in.

Consequences you should expect to see:

- **Wider ranges at small capital.** With $500, `cost_per_rebalance` is large
  relative to absolute yield, so the optimizer picks widths needing ~0–1
  rebalances/week. As capital scales to $10k+, optimal widths tighten
  automatically — same model, different cost amortization.
- Correlated pairs (WETH/cbBTC) tolerate tighter ranges than USD pairs at
  the same width because relative-price σ is lower.
- Rough starting expectations (not constants — the model decides): ±3–5%
  ETH/USDC, ±2.5–4% cbBTC/USDC, ±1.5–3% ETH/cbBTC.

**Why LVR and not naive IL:** naive IL compares against HODL between two
endpoints and ignores path. LVR is the running cost actually paid to
arbitrageurs as the price diffuses — it is path-aware, additive over time,
and a direct function of range width, which makes it the correct term to
trade off against fee income for a CL position.

---

## 4. Anti-over-rebalancing

Three independent gates; **all must pass** before any rebalance:

1. **Dead-band:** price must be beyond the range edge by
   `deadband_fraction` × width (default 25%) **sustained** for
   `sustain_minutes` (default 45). Transient wicks do not trigger action.
2. **Net benefit with margin:** projected extra USDC yield over the horizon
   must exceed `net_benefit_margin` × full move cost (default 3×; pool
   *switches* use `switch_margin` = 4× on full round-trip cost).
3. **Rate limit:** at most `max_rebalances_per_day` (default 2) per position.

Plus timing jitter (`timing_jitter_minutes`) so on-chain observers cannot
front-run a predictable schedule.

Every action **blocked** by a gate is recorded in the decision audit log with
the gate that blocked it. That record — skipped rebalances and what they
would have cost/earned — is the dataset used to tune these thresholds against
the backtest rather than by feel.

---

## 5. Backtest validation methodology (and what it has caught so far)

The backtester (`npm run backtest`) replays the full strategy with
**no lookahead** over sampled on-chain history: fee growth, vol, reward
rates and AERO price as-of each decision block; position value computed
exactly (path-independent between rebalances); all costs charged at
historical liquidity.

**Validation target: alpha, not raw P&L.** An LP position is ~half long the
risky asset; raw P&L in a trending window is dominated by market beta, which
the zero-drift NEY model deliberately does not predict. Each closed entry is
compared against holding its exact entry inventory: `alpha = LP proceeds −
HODL value`. Predicted NEY must track realized alpha (sign agreement +
magnitude ratio) before any live execution.

**Calibration findings already baked in** (each found by the replay, each a
classic way these bots lose money):

1. **Killed gauges report stale rewardRate forever.** Liveness =
   `periodFinish` in the future, never `rewardRate > 0`. Without this, dead
   pools looked like emission goldmines (a fake 40x return appeared).
2. **Trailing fee rates mean-revert.** Projecting a 24h fee window over a
   week overestimated fees ~3x → `fee_persistence` (default 0.5).
3. **Rate-limited tight widths are infeasible, not discounted.** Modeling
   excess range-exits as dead time made tight widths look safe; the replay
   showed each capped rebalance locking in divergence. Widths whose natural
   exit frequency exceeds the rate limit are excluded outright.
4. **Calm-spell vol readings precede vol expansion.** Short-memory EWMA vol
   is floored at the config prior (vol clusters; the floor is the long-run
   prior, measurement can only raise it).
5. **Marginal predictions are noise.** Entry requires clearing
   `min_net_yield_apr` (default 15%), not mere positivity.

**Current status: NOT validated.** With all gates active the strategy
correctly sat out most of a −19% ETH / −16% BTC fortnight (one entry,
realized alpha −$1.46/7d vs predicted +$3.33/7d — realized IL exceeded
modeled LVR under heavy trend). One entry has no statistical power. Needed
before live: a longer window via archive RPC and/or accumulated
paper-trading entries in the predicted-vs-realized ledger, with sign
agreement ≥ 70% and mean alpha/predicted ratio in [0.4, 2.5].
