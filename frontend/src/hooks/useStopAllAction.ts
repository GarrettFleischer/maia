import { useMaiaState } from '@/hooks/useMaiaState'

export function useStopAllAction() {
  const { dispatch } = useMaiaState()
  return () =>
    dispatch({
      type: 'stop_all',
      at: new Date().toISOString(),
    })
}
