/**
 * A jump's target inside a step fold opens the fold, as an in-chat search match
 * does, so the reader is not scrolled to a highlight drawn at zero height.
 */
import { afterEach, describe, it, expect, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import TurnBlock from '../pages/chat/TurnBlock'
import JumpRevealContext from '../hooks/JumpRevealContext'
import type { DisplayItem, TurnItem } from '../pages/chat/types'

const renderItem = (it: TurnItem, i: number) => (
  <div data-testid={`item-${i}`}>{it.kind === 'single' ? it.msg.content : 'group'}</div>
)

/** An interim fan-out region: both rows fold, so one toggle is rendered. */
const foldedTurn = (): Extract<DisplayItem, { kind: 'turn' }> => ({
  kind: 'turn',
  complete: true,
  interim: true,
  items: [
    { kind: 'single', msg: { role: 'assistant', content: 'Two of three agents are in…', ts: '1' }, idx: 0 },
    { kind: 'single', msg: { role: 'assistant', content: 'and the third just landed', ts: '2' }, idx: 1 },
  ],
})

const toggle = (c: HTMLElement) => c.querySelector('button[aria-expanded]')!

describe('TurnBlock — a jump into the fold', () => {
  it('stays folded with no jump target', () => {
    const { container } = render(<TurnBlock turn={foldedTurn()} renderItem={renderItem} />)
    expect(toggle(container).getAttribute('aria-expanded')).toBe('false')
  })

  it('opens when the jump target is a folded row', () => {
    const { container } = render(
      <JumpRevealContext.Provider value={{ ts: "2", claimScroll: () => {} }}>
        <TurnBlock turn={foldedTurn()} renderItem={renderItem} />
      </JumpRevealContext.Provider>,
    )
    expect(toggle(container).getAttribute('aria-expanded')).toBe('true')
  })

  it('stays folded when the jump target is in another turn', () => {
    const { container } = render(
      <JumpRevealContext.Provider value={{ ts: "99", claimScroll: () => {} }}>
        <TurnBlock turn={foldedTurn()} renderItem={renderItem} />
      </JumpRevealContext.Provider>,
    )
    expect(toggle(container).getAttribute('aria-expanded')).toBe('false')
  })
})

describe('TurnBlock — scrolling to the revealed row', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('ends the jump scroll, then scrolls the revealed row itself into view', () => {
    vi.useFakeTimers()
    const scrolled: string[] = []
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      scrolled.push((this as HTMLElement).dataset.jumpTarget ?? '')
    })
    const claimScroll = vi.fn()
    const markedItem = (it: TurnItem) => (
      <div data-jump-target={it.kind === 'single' ? it.msg.ts : undefined}>{it.kind === 'single' ? it.msg.content : 'group'}</div>
    )
    render(
      <JumpRevealContext.Provider value={{ ts: '2', claimScroll }}>
        <TurnBlock turn={foldedTurn()} renderItem={markedItem} />
      </JumpRevealContext.Provider>,
    )
    expect(claimScroll).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(250) })
    expect(claimScroll).toHaveBeenCalledTimes(1)
    expect(scrolled).toEqual(['2'])
  })
})

describe('TurnBlock — a jump target the fold does not hide', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('still scrolls the row itself into view, without a fold to open', () => {
    vi.useFakeTimers()
    const scrolled: string[] = []
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      scrolled.push((this as HTMLElement).dataset.jumpTarget ?? '')
    })
    const claimScroll = vi.fn()
    const markedItem = (it: TurnItem) => (
      <div data-jump-target={it.kind === 'single' ? it.msg.ts : undefined}>{it.kind === 'single' ? it.msg.content : 'group'}</div>
    )
    const flat: Extract<DisplayItem, { kind: 'turn' }> = {
      kind: 'turn',
      complete: true,
      items: [
        { kind: 'single', msg: { role: 'assistant', content: 'first reply', ts: 'x1' }, idx: 0 },
        { kind: 'single', msg: { role: 'assistant', content: 'second reply', ts: 'x2' }, idx: 1 },
      ],
    }
    const { container } = render(
      <JumpRevealContext.Provider value={{ ts: 'x1', claimScroll }}>
        <TurnBlock turn={flat} renderItem={markedItem} />
      </JumpRevealContext.Provider>,
    )
    expect(container.querySelector('button[aria-expanded]')).toBeNull()
    act(() => { vi.advanceTimersByTime(250) })
    expect(claimScroll).toHaveBeenCalledTimes(1)
    expect(scrolled).toEqual(['x1'])
  })
})
