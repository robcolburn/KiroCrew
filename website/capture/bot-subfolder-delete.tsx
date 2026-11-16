/**
 * Isolated capture entry for the Delete folder item on an empty folder inside a
 * Bot's home folder.
 *
 * The REAL `ChatSidebar` draws every row and decides every menu; only the folder
 * list is fixed, served over the real `/api/chat/folders` read by the shoot
 * script. The tree holds a Bot's home ("Radar") with an empty sub-folder
 * ("PR review") and one that holds an archived session ("Triage"), next to an
 * ordinary folder. Query string: ?theme=dark|light
 */
import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { Provider } from 'react-redux'

import { initI18n } from '../src/i18n/all'
import { store } from '../src/store'
import { sseConnected } from '../src/store/dashboardSlice'
import { ThemeProvider } from '../src/hooks/useTheme'
import ChatSidebar from '../src/pages/ChatSidebar'
import '../src/index.css'

const light = new URLSearchParams(location.search).get('theme') === 'light'
localStorage.setItem('mc-theme', light ? 'light' : 'dark')
localStorage.setItem('mc-color-theme', 'kiro')
localStorage.setItem('mc-sidebar-lane', 'tree')
localStorage.setItem('mc-sidebar-width', '420')

function Harness() {
  // A disconnected sidebar draws every row disabled, which is not what a person sees.
  useEffect(() => { store.dispatch(sseConnected()) }, [])
  return (
    <div className="flex h-screen bg-bg" data-capture-ready="">
      <ChatSidebar
        slots={[]}
        activeSlot={null}
        unreadSlots={[]}
        history={[]}
        historyHasMore={false}
        defaultAgent="kirocrew"
        installedAgents={[{ name: 'kirocrew', source: 'builtin' }]}
      />
    </div>
  )
}

initI18n()
createRoot(document.getElementById('root')!).render(
  <Provider store={store}>
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter>
          <Harness />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>
  </Provider>,
)
