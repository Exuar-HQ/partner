import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * A minimal client for the Exuar partner API — everything a partner's backend
 * needs, and the reference for how to sign a request.
 *
 * ── Signing ─────────────────────────────────────────────────────────────────
 *
 * The secret never travels. Every request carries four headers:
 *
 *   X-Exuar-Key        your key id (pk_live_… or pk_test_…)
 *   X-Exuar-Timestamp  Unix time in seconds; must be within 60s of Exuar's clock
 *   X-Exuar-Nonce      16–64 characters of [A-Za-z0-9_-], never reused
 *   X-Exuar-Signature  lowercase hex HMAC-SHA256, keyed with your secret, of:
 *
 *       timestamp \n nonce \n METHOD \n path?query \n hex(SHA-256(raw body))
 *
 * `path` is the path exactly as sent, `/api` prefix and query string included.
 * The body hash is of the exact bytes sent — so serialise the body once, sign
 * those bytes, and send those same bytes. A GET has an empty body: the hash of
 * nothing. Every failure comes back as the same 401, "Invalid partner
 * credentials", by design; check the clock, the path, and that the bytes
 * signed are the bytes sent.
 *
 * Requests are also accepted only from your allowlisted IP addresses.
 */
export class ExuarClient {
  constructor({ baseUrl, keyId, secret }) {
    if (!baseUrl || !keyId || !secret) {
      throw new Error('baseUrl, keyId and secret are all required')
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.keyId = keyId
    this.secret = secret
  }

  /** The signature for one request. Exported logic, kept pure for testing. */
  static sign({ secret, timestamp, nonce, method, path, body }) {
    const bodyHash = createHash('sha256').update(body ?? '').digest('hex')
    const canonical = [timestamp, nonce, method.toUpperCase(), path, bodyHash].join('\n')
    return createHmac('sha256', secret).update(canonical, 'utf8').digest('hex')
  }

  /**
   * Send a signed request. Returns `{ status, ok, data }`, where `data` is the
   * API's payload — on failure, `{ message, code }`, `code` being a stable
   * reason such as DAILY_CAP_EXCEEDED or CREDIT_LIMIT_EXCEEDED.
   */
  async request(method, path, payload) {
    const fullPath = `/api${path}`
    // Serialised ONCE: these exact bytes are signed and sent.
    const body = payload === undefined ? '' : JSON.stringify(payload)
    const timestamp = String(Math.floor(Date.now() / 1000))
    const nonce = randomBytes(16).toString('hex')
    const signature = ExuarClient.sign({
      secret: this.secret, timestamp, nonce, method, path: fullPath, body,
    })

    const res = await fetch(`${this.baseUrl}${fullPath}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        'X-Exuar-Key': this.keyId,
        'X-Exuar-Timestamp': timestamp,
        'X-Exuar-Nonce': nonce,
        'X-Exuar-Signature': signature,
      },
      body: body || undefined,
    })

    let json = null
    try {
      json = await res.json()
    } catch {
      // A non-JSON body is an infrastructure answer, not the API's.
    }
    return { status: res.status, ok: res.ok, data: json?.data ?? json }
  }

  // ── The partner API ─────────────────────────────────────────────────────

  /** Daily cap used and remaining per currency; credit limit, exposure, headroom. */
  limits() { return this.request('GET', '/v1/partner/limits') }

  /** The Nigerian banks an NGN payout can go to, named as Exuar requires. */
  banks() { return this.request('GET', '/v1/partner/banks') }

  /**
   * Instruct a payout. `idempotencyKey` must be unique per payout (8–64 of
   * letters, digits, _ . : -): repeating it returns the original payout and
   * never pays twice, so a retry after a timeout is always safe.
   *
   *   RWF: { currency: 'RWF', amount: '1000000',
   *          beneficiary: { name, msisdn: '250788123456' } }
   *   NGN: { currency: 'NGN', amount: '500000',
   *          beneficiary: { name, accountNumber: '0123456789', bankName: 'GTBank' } }
   *
   * Amounts are decimal STRINGS in whole units. The beneficiary's full name is
   * required: Exuar pays only if it matches the name the rail shows.
   */
  instructPayout(instruction) { return this.request('POST', '/v1/partner/payouts', instruction) }

  /** A payout's authoritative status. Poll this; never infer from silence. */
  payout(ref) { return this.request('GET', `/v1/partner/payouts/${encodeURIComponent(ref)}`) }

  /** Withdraw a payout that has not yet been picked up for payment. */
  cancel(ref) { return this.request('POST', `/v1/partner/payouts/${encodeURIComponent(ref)}/cancel`) }

  /** Open and recent settlement cycles: due, paid, outstanding, overdue. */
  cycles() { return this.request('GET', '/v1/partner/cycles') }

  /** A closed cycle's statement: every payout billed, and the USDT due. */
  statement(cycleId) {
    return this.request('GET', `/v1/partner/cycles/${encodeURIComponent(cycleId)}/statement`)
  }

  /** Your rate per currency, as USDT/RWF and USDT/NGN. */
  rates() { return this.request('GET', '/v1/partner/rates') }

  /** Your payouts, newest first. The query string is signed with the path. */
  listPayouts(query = {}) {
    const qs = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== ''),
    ).toString()
    return this.request('GET', `/v1/partner/payouts${qs ? `?${qs}` : ''}`)
  }

  /** Up to 100 instructions; a result per payout. */
  instructBatch(payouts) { return this.request('POST', '/v1/partner/payouts/batch', { payouts }) }

  /** Where to send USDT, and the addresses you may send from. */
  settlementAddress() { return this.request('GET', '/v1/partner/settlement-address') }

  /** Dispute payouts on a closed, unpaid cycle. */
  dispute(cycleId, refs, reason) {
    return this.request('POST', `/v1/partner/cycles/${encodeURIComponent(cycleId)}/disputes`, { refs, reason })
  }

  disputes(status) {
    return this.request('GET', `/v1/partner/disputes${status ? `?status=${encodeURIComponent(status)}` : ''}`)
  }

  // ── Webhooks ────────────────────────────────────────────────────────────

  registerWebhook(url, events) {
    return this.request('POST', '/v1/partner/webhooks', events?.length ? { url, events } : { url })
  }
  webhook() { return this.request('GET', '/v1/partner/webhooks') }
  removeWebhook() { return this.request('DELETE', '/v1/partner/webhooks') }
  testWebhook() { return this.request('POST', '/v1/partner/webhooks/test') }
  webhookEvents(status) {
    return this.request('GET', `/v1/partner/webhooks/events${status ? `?status=${encodeURIComponent(status)}` : ''}`)
  }
  replayWebhookEvent(id) {
    return this.request('POST', `/v1/partner/webhooks/events/${encodeURIComponent(id)}/replay`)
  }
}

/**
 * Check a webhook delivery from Exuar, as a partner's server must: HMAC-SHA256
 * over `timestamp.id.rawBody` with the webhook secret, compared in constant
 * time, and refused when older than five minutes.
 */
export function verifyWebhook(secret, headers, rawBody, now = Date.now()) {
  const id = headers['x-exuar-webhook-id']
  const timestamp = headers['x-exuar-webhook-timestamp']
  const signature = headers['x-exuar-webhook-signature'] ?? ''
  if (!id || !timestamp) return false
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false
  const expected = createHmac('sha256', secret).update(`${timestamp}.${id}.${rawBody}`, 'utf8').digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  return a.length === b.length && timingSafeEqual(a, b)
}
