/**
 * @fileoverview Wraps the app: shows KeyEntry when no valid token, otherwise children.
 * @module app/components/AuthGuard
 */

"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { KeyEntry, clearStoredToken, getStoredToken } from "./KeyEntry";

const AuthContext = createContext<{ token: string; logout: () => void } | null>(null);

export function useAuth(): { token: string; logout: () => void } {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthGuard");
  return ctx;
}

type AuthGuardProps = {
  children: React.ReactNode;
};

/**
 * On mount, reads token from sessionStorage. If none, shows KeyEntry.
 * When user submits valid key, we store it and show children.
 * Children can call logout() to clear token and show KeyEntry again.
 */
export function AuthGuard({ children }: AuthGuardProps) {
  const [token, setToken] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setToken(getStoredToken());
    setMounted(true);
  }, []);

  const logout = useCallback(() => {
    clearStoredToken();
    setToken(null);
  }, []);

  if (!mounted) {
    return <main style={{ padding: "2rem", background: "var(--bg-primary)", color: "var(--text-primary)" }}>Loading…</main>;
  }

  if (!token) {
    return <KeyEntry onSuccess={setToken} />;
  }

  return (
    <AuthContext.Provider value={{ token, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
