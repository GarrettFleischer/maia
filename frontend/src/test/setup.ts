import '@testing-library/jest-dom/vitest'

const storage = new Map<string, string>()

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => (storage.has(key) ? storage.get(key)! : null),
    setItem: (key: string, value: string) => {
      storage.set(key, value)
    },
    removeItem: (key: string) => {
      storage.delete(key)
    },
    clear: () => {
      storage.clear()
    },
    get length() {
      return storage.size
    },
    key: (index: number) => Array.from(storage.keys())[index] ?? null,
  },
})

beforeEach(() => {
  storage.clear()
})
