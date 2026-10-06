import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { ExuarClient, verifyWebhook } from './exuar-client.mjs'

/**
 * A partner's backend, simulated from the command line.
 *
 *   npm run partner -- <command> [args]
 *
 * See README.md for every command.
 */

const client = new ExuarClient({
  baseUrl: process.env.EXUAR_API_URL ?? 'http://localhost:3000',
  keyId: process.env.EXUAR_KEY_ID,
  secret: process.env.EXUAR_KEY_SECRET,
})

const [command, ...rest] = process.argv.slice(2)

// --flag value pairs, anywhere in the arguments.
const flags = {}
const args = []
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) {
    flags[rest[i].slice(2)] = rest[i + 1] ?? true
    i++
  } else {
    args.push(rest[i])
  }
}

const newKey = () => `sim-${Date.now()}-${randomBytes(3).toString('hex')}`

function print({ status, ok, data }) {
  const mark = ok ? '✓' : '✗'
  console.log(`${mark} ${status}${!ok && data?.code ? ` ${data.code}` : ''}`)
  console.log(JSON.stringify(ok ? data : { code: data?.code, message: data?.message }, null, 2))
  if (!ok) process.exitCode = 1
}

function beneficiary(currency, a) {
  if (currency === 'RWF') {
    const [msisdn, ...name] = a
    return { name: name.join(' '), msisdn }
  }
  const [accountNumber, bankName, ...name] = a
  return { name: name.join(' '), accountNumber, bankName }
}

function instruction(currency, amount, a) {
  return {
    idempotencyKey: flags.key ?? newKey(),
    ...(flags.ref ? { partnerReference: flags.ref } : {}),
    currency,
    amount: String(amount),
    beneficiary: beneficiary(currency, a),
  }
}

const commands = {
  async limits() { print(await client.limits()) },

  async banks() { print(await client.banks()) },

  /** payout rwf <amount> <msisdn> <full name…>
   *  payout ngn <amount> <account> <bank> <full name…>   (quote multi-word banks) */
  async payout() {
    const [ccy, amount, ...a] = args
    const currency = (ccy ?? '').toUpperCase()
    if (!['RWF', 'NGN'].includes(currency) || !amount) return usage()
    const body = instruction(currency, amount, a)
    console.log(`→ ${currency} ${amount} to ${body.beneficiary.name} (idempotency key ${body.idempotencyKey})`)
    print(await client.instructPayout(body))
  },

  /** The same instruction twice with one key: the second must return the first. */
  async replay() {
    const [ccy, amount, ...a] = args
    const currency = (ccy ?? '').toUpperCase()
    if (!['RWF', 'NGN'].includes(currency) || !amount) return usage()
    const body = instruction(currency, amount, a)
    const first = await client.instructPayout(body)
    const second = await client.instructPayout(body)
    console.log(`first:  ${first.status} ${first.data?.ref ?? first.data?.code}`)
    console.log(`second: ${second.status} ${second.data?.ref ?? second.data?.code} (replayed: ${second.data?.replayed})`)
    console.log(first.data?.ref && first.data.ref === second.data?.ref ? '✓ one payout' : '✗ NOT the same payout')
  },

  /** burst <n> rwf <amount> <msisdn> <name…> — n payouts in a row, to find the limits. */
  async burst() {
    const [n, ccy, amount, ...a] = args
    const currency = (ccy ?? '').toUpperCase()
    if (!Number(n) || !['RWF', 'NGN'].includes(currency) || !amount) return usage()
    for (let i = 1; i <= Number(n); i++) {
      const res = await client.instructPayout({ ...instruction(currency, amount, a), idempotencyKey: newKey() })
      console.log(`${String(i).padStart(3)}: ${res.status} ${res.ok ? res.data.ref : `${res.data?.code} — ${res.data?.message}`}`)
      if (!res.ok && ['DAILY_CAP_EXCEEDED', 'CREDIT_LIMIT_EXCEEDED', 'INSUFFICIENT_LIQUIDITY'].includes(res.data?.code)) break
    }
  },

  async status() { if (!args[0]) return usage(); print(await client.payout(args[0])) },

  async cancel() { if (!args[0]) return usage(); print(await client.cancel(args[0])) },

  /** Watch a payout until it is paid, failed or cancelled. */
  async watch() {
    if (!args[0]) return usage()
    for (;;) {
      const res = await client.payout(args[0])
      if (!res.ok) return print(res)
      process.stdout.write(`\r${new Date().toLocaleTimeString()} ${res.data.status}${res.data.failureReason ? ` (${res.data.failureReason})` : ''}   `)
      if (!['PENDING', 'PROCESSING'].includes(res.data.status)) return console.log()
      await new Promise((r) => setTimeout(r, 3000))
    }
  },

  async cycles() { print(await client.cycles()) },

  async statement() { if (!args[0]) return usage(); print(await client.statement(args[0])) },

  async rates() { print(await client.rates()) },

  async address() { print(await client.settlementAddress()) },

  /** list [--status S] [--currency C] [--ref R] [--limit N] [--all] */
  async list() {
    const query = {
      status: flags.status, currency: flags.currency, partnerReference: flags.ref,
      from: flags.from, to: flags.to, limit: flags.limit,
    }
    let cursor
    let page = 0
    do {
      const res = await client.listPayouts({ ...query, cursor })
      if (!res.ok) return print(res)
      page++
      for (const p of res.data.payouts) {
        console.log(`${p.createdAt}  ${p.status.padEnd(10)} ${p.currency} ${p.amount.padStart(12)}  ${p.ref}${p.partnerReference ? `  (${p.partnerReference})` : ''}`)
      }
      cursor = res.data.nextCursor ?? undefined
    } while (cursor && flags.all)
    if (cursor) console.log(`… more: run again with --all`)
  },

  /** batch <n> rwf <amount> <msisdn> <name…> — one request of n payouts. */
  async batch() {
    const [n, ccy, amount, ...a] = args
    const currency = (ccy ?? '').toUpperCase()
    if (!Number(n) || !['RWF', 'NGN'].includes(currency) || !amount) return usage()
    const items = Array.from({ length: Number(n) }, () => ({ ...instruction(currency, amount, a), idempotencyKey: newKey() }))
    const res = await client.instructBatch(items)
    if (!res.ok) return print(res)
    for (const r of res.data.results) {
      console.log(`${String(r.index).padStart(3)}: ${r.result.padEnd(13)} ${r.payout?.ref ?? (r.error ? `${r.error.code ?? r.error.statusCode} — ${r.error.message}` : '')}`)
    }
    console.log(JSON.stringify(res.data.summary))
  },

  /** dispute <cycleId> <ref…> --reason "…" */
  async dispute() {
    const [cycleId, ...refs] = args
    if (!cycleId || refs.length === 0) return usage()
    print(await client.dispute(cycleId, refs, flags.reason ?? 'Beneficiary reports nothing received'))
  },

  async disputes() { print(await client.disputes(flags.status)) },

  /** webhook register <url> [--events a,b] | show | remove | test | events [--status S] | replay <id> | listen [port] */
  async webhook() {
    const [sub, x] = args
    if (sub === 'register') {
      if (!x) return usage()
      const res = await client.registerWebhook(x, flags.events ? String(flags.events).split(',') : undefined)
      print(res)
      if (res.ok) console.log(`\nPut the secret in .env as EXUAR_WEBHOOK_SECRET=${res.data.secret} — it is not shown again.`)
      return
    }
    if (sub === 'show') return print(await client.webhook())
    if (sub === 'remove') return print(await client.removeWebhook())
    if (sub === 'test') return print(await client.testWebhook())
    if (sub === 'events') return print(await client.webhookEvents(flags.status))
    if (sub === 'replay') { if (!x) return usage(); return print(await client.replayWebhookEvent(x)) }
    if (sub === 'listen') return listen(Number(x ?? 4000))
    usage()
  },
}

/**
 * A partner's webhook endpoint, on this machine: verifies every delivery with
 * EXUAR_WEBHOOK_SECRET, prints it, and answers 200 — or 401 for a bad signature.
 * Register it with: webhook register http://localhost:4000/hooks
 * (http and localhost are accepted only by a non-production API).
 */
function listen(port) {
  const secret = process.env.EXUAR_WEBHOOK_SECRET
  if (!secret) {
    console.error('✗ EXUAR_WEBHOOK_SECRET is not set: register the webhook first and put its secret in .env.')
    process.exitCode = 1
    return
  }
  const seen = new Set()
  createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const valid = verifyWebhook(secret, req.headers, raw)
      const id = req.headers['x-exuar-webhook-id']
      res.statusCode = valid ? 200 : 401
      res.end()
      const t = new Date().toLocaleTimeString()
      if (!valid) return console.log(`[${t}] ✗ rejected: bad or stale signature (${id ?? 'no id'})`)
      const repeat = seen.has(id)
      seen.add(id)
      let body = {}
      try { body = JSON.parse(raw) } catch { /* verified, so it is JSON */ }
      const d = body.data ?? {}
      console.log(`[${t}] ✓ ${body.type}${repeat ? ' (repeat — ignored)' : ''}  ${d.ref ?? d.cycleId ?? d.txHash ?? ''} ${d.status ?? d.usdtDue ?? ''}${d.failureReason ? ` (${d.failureReason})` : ''}`)
    })
  }).listen(port, () => console.log(`listening for Exuar webhooks on http://localhost:${port}/hooks`))
}

function usage() {
  console.log(`Commands:
  limits                                         daily caps, credit limit, headroom
  banks                                          NGN banks a payout can go to
  payout rwf <amount> <msisdn> <full name>       e.g. payout rwf 50000 250788123456 Jean Mukamana
  payout ngn <amount> <account> <bank> <name>    e.g. payout ngn 20000 0123456789 GTBank Ada Okafor
         [--key <idempotency key>] [--ref <your reference>]
  replay rwf <amount> <msisdn> <name>            send one instruction twice; must be one payout
  burst <n> rwf <amount> <msisdn> <name>         n payouts until a limit refuses
  status <ref>                                   a payout's status
  watch <ref>                                    poll until paid, failed or cancelled
  cancel <ref>                                   withdraw a payout not yet picked up
  cycles                                         settlement cycles
  statement <cycleId>                            a closed cycle's statement
  rates                                          your rate per currency (USDT/RWF, USDT/NGN)
  address                                        where to send USDT
  list [--status S] [--currency C] [--ref R] [--all]   your payouts, newest first
  batch <n> rwf <amount> <msisdn> <name>         one request of n payouts
  dispute <cycleId> <ref…> [--reason "…"]        dispute unpaid payouts on a closed cycle
  disputes [--status S]                          your disputes and their outcomes
  webhook register <url> [--events a,b]          register (or replace) your endpoint
  webhook show | remove | test                   see it, remove it, send a test event
  webhook events [--status DEAD] | replay <id>   deliveries, and resending one
  webhook listen [port]                          a local endpoint that verifies signatures`)
  process.exitCode = 1
}

const run = commands[command]
if (!run) usage()
else run().catch((e) => { console.error(`✗ ${e.message}`); process.exitCode = 1 })
