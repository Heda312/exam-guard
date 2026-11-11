import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { api, ApiError, errorMessage } from "./api";
import type { MeResponse, ProctorPermissions } from "./types";

interface AuthState {
  me: MeResponse | null;
  loading: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  canManageExam: (examId: string, permission: keyof ProctorPermissions) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await api.me();
      setMe(response);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setMe(null);
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (username: string, password: string) => {
    const response = await api.login({ username, password });
    setMe(response);
    setError(null);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setMe(null);
    }
  }, []);

  const canManageExam = useCallback(
    (examId: string, permission: keyof ProctorPermissions) => {
      if (!me) return false;
      if (me.permissions.is_admin) return true;
      const assignment = me.permissions.exams.find((item) => item.exam_id === examId);
      if (!assignment) return false;
      return Boolean(assignment.permissions[permission]);
    },
    [me],
  );

  const value = useMemo<AuthState>(
    () => ({ me, loading, error, login, logout, refresh, canManageExam }),
    [me, loading, error, login, logout, refresh, canManageExam],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth harus dipakai di dalam AuthProvider");
  return context;
}
