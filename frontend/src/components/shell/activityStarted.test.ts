import { describe, expect, it } from 'vitest'
import { activityLineKey, pruneActivityStartedKeys } from '@/components/shell/activityStarted'

describe('pruneActivityStartedKeys', () => {
  it('removes timer keys when the Working strip empties', () => {
    const started = new Map<string, number>([
      ['router-1', 1000],
      ['task-a', 2000],
    ])
    pruneActivityStartedKeys(started, new Set())
    expect(started.size).toBe(0)
  })

  it('keeps keys that are still visible and drops the rest', () => {
    const started = new Map<string, number>([
      ['router-1', 1000],
      ['task-a', 2000],
      ['task-b', 3000],
    ])
    pruneActivityStartedKeys(started, new Set(['task-a']))
    expect([...started.keys()]).toEqual(['task-a'])
    expect(started.get('task-a')).toBe(2000)
  })
})

describe('activityLineKey', () => {
  it('uses task id when present and otherwise a router seq key', () => {
    expect(activityLineKey({ seq: 3, task_id: 'task-1' })).toBe('task-1')
    expect(activityLineKey({ seq: 3 })).toBe('router-3')
  })
})
