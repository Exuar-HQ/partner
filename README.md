# partner — a stand-in for a partner's backend

Calls the Exuar partner API exactly as a partner's own server would: every
request signed, nothing but Node's standard library. Used to exercise the
partner liquidity channel locally, and the working reference for partners'
developers — `src/exuar-client.mjs` is the part they would copy.

## Set up, locally

1. **The API's `.env`** (in `exuar-api`) needs:

   ```
   FOUNDER_USER_IDS=<your user id>[,<frank's>]
   TRUSTED_PROXY_HOPS=0          # local only: nothing sits between us and the API
   ```

2. **In the admin console**, as a founder (Partners):
   - create a partner, and set up its RWF and/or NGN corridor;
   - **Security**: allowed IPs `127.0.0.1` and `::1` (calls to localhost arrive
     from one of these), plus a settlement address and a sending address — any
     TRC20-shaped address works locally, e.g. `TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf`;
   - **Issue sandbox key** to test everything with nobody paid; to send live
     payouts, **Activate**, then **Issue live key**. Copy the key id and
     secret — the secret is shown once.

3. **Here**:

   ```
   cp .env.example .env     # then paste the key id and secret
   npm run partner -- limits
   ```

Node 20.6 or later. No `npm install` — there are no dependencies.

## Commands

```
npm run partner -- limits
npm run partner -- banks
npm run partner -- payout rwf 50000 250788123456 Jean Mukamana
npm run partner -- payout ngn 20000 0123456789 GTBank Ada Okafor
npm run partner -- payout ngn 20000 0123456789 "First Bank Of Nigeria" Ada Okafor
npm run partner -- payout rwf 50000 250788123456 Jean Mukamana --ref ORDER-123 --key my-key-0001
npm run partner -- replay rwf 50000 250788123456 Jean Mukamana     # one key, sent twice: one payout
npm run partner -- burst 10 rwf 1000000 250788123456 Jean Mukamana # until a limit refuses
npm run partner -- status <ref>
npm run partner -- watch <ref>                                     # until paid/failed/cancelled
npm run partner -- cancel <ref>
npm run partner -- cycles
npm run partner -- statement <cycleId>
npm run partner -- rates                                           # USDT/RWF and USDT/NGN
npm run partner -- address                                         # where to send USDT
npm run partner -- list --status SUCCESSFUL --all                  # every payout, paged
npm run partner -- batch 20 rwf 50000 250788123456 Jean Mukamana   # one request, 20 payouts
npm run partner -- dispute <cycleId> <ref> <ref> --reason "not received"
npm run partner -- disputes --status OPEN
```

## Repeats

The same account and amount sent twice within 10 minutes, under two keys, is
held until the partner acknowledges the first payout's outcome by webhook (or
refused, with no webhook). Try it:

```
npm run partner -- payout rwf 50000 250788123456 Jean Mukamana
npm run partner -- payout rwf 50000 250788123456 Jean Mukamana       # heldFor: the first
npm run partner -- payout rwf 50000 250788123456 Jean Mukamana --allow-duplicate
```

## Webhooks, locally

```
npm run partner -- webhook register http://localhost:4000/hooks   # prints the secret, once
# put it in .env as EXUAR_WEBHOOK_SECRET=whsec_…
npm run partner -- webhook listen 4000                            # in its own terminal
npm run partner -- webhook test                                   # a webhook.test arrives
npm run partner -- webhook events --status DEAD                   # deliveries that gave up
npm run partner -- webhook replay <eventId>
```

`listen` verifies every delivery's signature exactly as a partner's server must
(`verifyWebhook` in `src/exuar-client.mjs`), rejects a bad or stale one with
`401`, and flags repeats. Plain `http` and `localhost` are accepted only by a
non-production API; in production the endpoint must be public `https`.

With a sandbox key, sandbox payouts send their events as they age —
`payout.processing` after 20 s, the outcome after 30 s.

A payout is `PENDING` until the daemon claims it. To see one through, run the
daemon against the local API — or, with no daemon, claim and report it by hand
on the API's daemon endpoints.

## What a refusal looks like

Every refusal carries a stable `code`, for a partner's code to act on:

| Code | Meaning | What to do |
| --- | --- | --- |
| `DAILY_CAP_EXCEEDED` | Today's volume in that currency would pass the cap | Wait for tomorrow (partner's timezone) |
| `CREDIT_LIMIT_EXCEEDED` | Owed plus in flight would pass the credit limit | Settle a cycle, then retry |
| `INSUFFICIENT_LIQUIDITY` | Exuar's float cannot fund it right now | Retry later |
| `RATE_UNAVAILABLE` | No fresh rate to price it at | Retry shortly |
| `INVALID_BENEFICIARY` | Name, number, account or bank is wrong | Fix the instruction |
| `AMOUNT_OUT_OF_RANGE` | Outside the corridor's min/max, or not whole units | Fix the amount |
| `CORRIDOR_UNAVAILABLE` | That currency is not enabled for you | Ask Exuar |
| `PARTNER_NOT_ACTIVE` | Suspended, or not yet live | Ask Exuar |
| `IDEMPOTENCY_CONFLICT` | That key was used for a different payout | Use a new key |

A `401` is always "Invalid partner credentials", whatever the cause: check the
clock (±60 s), the signed path (it includes `/api`), the key, and the IP.
# partner
