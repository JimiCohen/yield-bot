# Allocator go-live — the 10-minute path to your first real on-chain dollar

The PARK+GUARD allocator earns posted, borrower-paid yield from audited USDC
vaults on Base. Nothing is predicted; accrual is measured from the vault's own
on-chain accounting. Its live gate opens automatically after 7 days of
measured positive paper accrual — check with:

    npm run allocate -- --report      # "live gate ✅ OPEN" = ready

## The three steps only you can do

1. **Dedicated wallet.** Create a fresh wallet (Rabby/MetaMask). Never reuse
   your main wallet. Fund it on **Base** with the USDC you want to deploy
   (start with what you can shrug off) plus ~$2 of ETH for gas.

2. **Key into the environment** (never a file in git, never chat):

       cd aerodrome-yield-bot
       # .env is gitignored — verified
       echo 'BOT_PRIVATE_KEY=0x<your key>' >> .env

3. **Arm and deposit** (two-key: config AND flag):

       # config.yaml: change  mode: paper  ->  mode: live
       npm run allocate -- --deposit 500 --live

   The command refuses unless the gate is open, the venue passes on-chain
   verification, and the amount is inside allocator.capital_usd and
   position.max_position_usd. It approves the exact amount only.

## What happens after

- The same guard loop that watched paper now watches your REAL position
  (hourly): on-chain accrual, TVL drain, yield divergence, USDC depeg.
- **auto_flee: true** — if a bank-run or accrual-stall guard trips, the bot
  withdraws everything to your wallet automatically and alerts.
- Withdraw anytime yourself: `npm run allocate -- --withdraw --live`
- Watch it: dashboard "Honest yield" card, or `npm run allocate -- --report`.

## Expectations (honest)

- ~4–5.5%/yr measured. On $1,500 ≈ $0.17–0.22/day, first dollar in ~5–6 days.
- Worst case is bounded to a failure of a single heavily-audited protocol
  (Morpho vault / Aave / Fluid) or a USDC depeg — not market direction.
- Anything advertising much more than 6% on stables is, per our verified
  research, presumptively emissions or risk you're not being paid for.
