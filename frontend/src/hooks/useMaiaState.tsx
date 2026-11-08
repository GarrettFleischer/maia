import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import type { MaiaFixtureState } from '@/api/types'
import { FIXTURE_STORAGE_KEY, defaultFixtureState, normalizeFixtureState } from '@/fixtures/defaultFixture'
import { type MaiaAction, reduceMaiaState } from '@/state/maiaReducer'

interface MaiaContextValue {
  state: MaiaFixtureState
  dispatch: (action: MaiaAction) => void
  resetFixture: () => void
}

const MaiaContext = createContext<MaiaContextValue | null>(null)

function readStoredState(): MaiaFixtureState {
  if (typeof window === 'undefined') {
    return defaultFixtureState()
  }
  try {
    const raw = window.localStorage.getItem(FIXTURE_STORAGE_KEY)
    if (!raw) {
      return defaultFixtureState()
    }
    return normalizeFixtureState(JSON.parse(raw) as MaiaFixtureState)
  } catch {
    return defaultFixtureState()
  }
}

function subscribeToStorage(onStoreChange: () => void): () => void {
  const handler = (event: StorageEvent) => {
    if (event.key === FIXTURE_STORAGE_KEY) {
      onStoreChange()
    }
  }
  window.addEventListener('storage', handler)
  return () => window.removeEventListener('storage', handler)
}

function persistState(state: MaiaFixtureState): void {
  window.localStorage.setItem(FIXTURE_STORAGE_KEY, JSON.stringify(state))
}

export function MaiaProvider({
  children,
  initialState,
}: {
  children: ReactNode
  initialState?: MaiaFixtureState
}) {
  const [state, dispatch] = useReducer(
    reduceMaiaState,
    initialState ?? readStoredState(),
  )

  const dispatchAndPersist = useCallback((action: MaiaAction) => {
    dispatch(action)
  }, [])

  const resetFixture = useCallback(() => {
    const fresh = defaultFixtureState()
    persistState(fresh)
    dispatch({ type: 'set_client_class', client_class: fresh.client_class })
    window.location.reload()
  }, [])

  useEffect(() => {
    if (typeof window !== 'undefined') {
      persistState(state)
    }
  }, [state])

  const value = useMemo(
    () => ({ state, dispatch: dispatchAndPersist, resetFixture }),
    [state, dispatchAndPersist, resetFixture],
  )

  return <MaiaContext.Provider value={value}>{children}</MaiaContext.Provider>
}

export function useMaiaState(): MaiaContextValue {
  const ctx = useContext(MaiaContext)
  if (!ctx) {
    throw new Error('useMaiaState must be used within MaiaProvider')
  }
  return ctx
}

export function useMaiaExternalSnapshot(): MaiaFixtureState {
  return useSyncExternalStore(
    subscribeToStorage,
    readStoredState,
    defaultFixtureState,
  )
}
