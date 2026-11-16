import { createContext, useContext } from 'react'

/**
 * The `ts` of the message a jump just highlighted (a pin, a quote, a `?msg=`
 * link, Search all chats), or null. A turn whose step fold holds that message
 * opens the fold, as it does for an in-chat search match: a folded row is drawn
 * at zero height, so the reader would be scrolled to a highlight they cannot see.
 */
export interface JumpReveal {
  ts: string | null
  /** Ends the jump's own scroll, so the revealed row's scroll is not undone. */
  claimScroll: () => void
}

/** No jump target: the default, and what a measuring-only render provides. */
export const NO_JUMP_REVEAL: JumpReveal = { ts: null, claimScroll: () => {} }

const JumpRevealContext = createContext<JumpReveal>(NO_JUMP_REVEAL)

export const useJumpReveal = () => useContext(JumpRevealContext)
export default JumpRevealContext
