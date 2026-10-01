import { randomBytes } from 'node:crypto'
import { ExuarClient } from './exuar-client.mjs'

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
  statement <cycleId>                            a closed cycle's statement`)
  process.exitCode = 1
}

const run = commands[command]
if (!run) usage()
else run().catch((e) => { console.error(`✗ ${e.message}`); process.exitCode = 1 })
