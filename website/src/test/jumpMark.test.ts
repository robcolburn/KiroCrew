import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FLASH_HIGHLIGHT_MS, LANDED_HIGHLIGHT_MS, useJumpMark } from '../pages/chat/page/jumpMark'

afterEach(() => { vi.useRealTimers() })

function setup() {
  const setHighlightTs = vi.fn()
  const setLandedTs = vi.fn()
  const { result } = renderHook(() => useJumpMark(setHighlightTs, setLandedTs))
  return { mark: result.current, setHighlightTs, setLandedTs }
}

describe('useJumpMark', () => {
  it('marks the landing highlight, clears the flash, and expires after its own time', () => {
    vi.useFakeTimers()
    const { mark, setHighlightTs, setLandedTs } = setup()
    act(() => mark('a', true))
    expect(setLandedTs).toHaveBeenLastCalledWith('a')
    expect(setHighlightTs).toHaveBeenLastCalledWith(null)
    act(() => { vi.advanceTimersByTime(LANDED_HIGHLIGHT_MS - 1) })
    expect(setLandedTs).toHaveBeenLastCalledWith('a')
    act(() => { vi.advanceTimersByTime(1) })
    expect(setLandedTs).toHaveBeenLastCalledWith(null)
  })

  it('marks the flash for its shorter time', () => {
    vi.useFakeTimers()
    const { mark, setHighlightTs, setLandedTs } = setup()
    act(() => mark('p', false))
    expect(setHighlightTs).toHaveBeenLastCalledWith('p')
    expect(setLandedTs).toHaveBeenLastCalledWith(null)
    act(() => { vi.advanceTimersByTime(FLASH_HIGHLIGHT_MS) })
    expect(setHighlightTs).toHaveBeenLastCalledWith(null)
  })

  it('an older mark’s expiry never clears a newer target', () => {
    vi.useFakeTimers()
    const { mark, setLandedTs } = setup()
    act(() => mark('a', true))
    act(() => { vi.advanceTimersByTime(LANDED_HIGHLIGHT_MS - 100) })
    act(() => mark('b', true))
    act(() => { vi.advanceTimersByTime(100) })
    expect(setLandedTs).toHaveBeenLastCalledWith('b')
    act(() => { vi.advanceTimersByTime(LANDED_HIGHLIGHT_MS) })
    expect(setLandedTs).toHaveBeenLastCalledWith(null)
  })
})
