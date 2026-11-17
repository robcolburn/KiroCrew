/**
 * The App SDK's `useBrowserMedia`: the owner's media buttons reach the app's own
 * browsing tab through the one declared path, and say why when they cannot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { AppApiProvider, BROWSER_MEDIA_PATH, useBrowserMedia } from '../app-sdk/index'

const PLAYING = { kind: 'video', paused: false, ended: false, currentTime: 12, duration: 200, volume: 1, muted: false }

let bodies: Record<string, unknown>[]
let answer: () => Response

beforeEach(() => {
  bodies = []
  answer = () => new Response(JSON.stringify({ ok: true, session_key: 'app-tunes-1', media: PLAYING }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(new URL(String(input), 'http://localhost').pathname).toBe(BROWSER_MEDIA_PATH)
    bodies.push(JSON.parse(String(init?.body ?? '{}')))
    return answer()
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function mount(api: string[]) {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(AppApiProvider, { appName: 'tunes', allowedApiPaths: api, allowedEvents: [] }, children)
  return renderHook(() => useBrowserMedia('app-tunes-1'), { wrapper })
}

describe('useBrowserMedia', () => {
  it('reads the state once, then sends each button as one action', async () => {
    const { result } = mount([BROWSER_MEDIA_PATH])
    await waitFor(() => expect(result.current.media).toEqual(PLAYING))
    await act(async () => { await result.current.pause() })
    await act(async () => { await result.current.seek(30) })
    await act(async () => { await result.current.setVolume(0.4) })
    expect(bodies).toEqual([
      { session_key: 'app-tunes-1', action: 'state' },
      { session_key: 'app-tunes-1', action: 'pause' },
      { session_key: 'app-tunes-1', action: 'seek', value: 30 },
      { session_key: 'app-tunes-1', action: 'volume', value: 0.4 },
    ])
  })

  it('reports the route refusal code', async () => {
    answer = () => new Response(JSON.stringify({ error: 'no tab', code: 'no_tab' }), { status: 409 })
    const { result } = mount([BROWSER_MEDIA_PATH])
    await waitFor(() => expect(result.current.error).toBe('no_tab'))
    expect(result.current.media).toBeNull()
  })

  it('sends nothing for an app that did not declare the path', async () => {
    const { result } = mount([])
    await waitFor(() => expect(result.current.error).toBe('not_declared'))
    expect(bodies).toEqual([])
  })
})
