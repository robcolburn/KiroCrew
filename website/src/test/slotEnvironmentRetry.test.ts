/**
 * The slot-environment query's retry policy: a transient failure is retried
 * twice, the `owner_only` refusal (a Shared Crew guest) never is.
 */
import { describe, it, expect } from 'vitest'
import { ApiError, OWNER_GATE_REFUSAL_CODES, isOwnerOnlyRefusal } from '../api/apiError'
import { SLOT_ENVIRONMENT_RETRY } from '../components/sessionEnvironmentHooks'

const ownerOnly = () => new ApiError(403, 'owner authorization required', '{"code":"owner_only"}')

describe('SLOT_ENVIRONMENT_RETRY', () => {
  it('does not retry the owner_only refusal', () => {
    expect(SLOT_ENVIRONMENT_RETRY.retry(0, ownerOnly())).toBe(false)
    expect(isOwnerOnlyRefusal(ownerOnly(), OWNER_GATE_REFUSAL_CODES)).toBe(true)
  })

  it('retries every other failure twice', () => {
    for (const error of [new Error('blip'), new ApiError(500, 'boom', '{"code":"internal"}'), new ApiError(403, 'sign in', '{"code":"auth_required"}'), new ApiError(403, 'forbidden', '')]) {
      expect(SLOT_ENVIRONMENT_RETRY.retry(0, error)).toBe(true)
      expect(SLOT_ENVIRONMENT_RETRY.retry(1, error)).toBe(true)
      expect(SLOT_ENVIRONMENT_RETRY.retry(2, error)).toBe(false)
    }
  })

  it('reads only a 403 with that code as the refusal', () => {
    expect(isOwnerOnlyRefusal(new ApiError(500, 'x', '{"code":"owner_only"}'), OWNER_GATE_REFUSAL_CODES)).toBe(false)
    expect(isOwnerOnlyRefusal(new Error('owner_only'), OWNER_GATE_REFUSAL_CODES)).toBe(false)
    expect(isOwnerOnlyRefusal(null, OWNER_GATE_REFUSAL_CODES)).toBe(false)
    // The relay's owner-only codes are not the owner gate's answer, so the read retries them.
    expect(SLOT_ENVIRONMENT_RETRY.retry(0, new ApiError(403, 'x', '{"code":"relay_local_credential"}'))).toBe(true)
  })
})
