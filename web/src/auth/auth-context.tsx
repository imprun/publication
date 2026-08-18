import type { User, UserManager } from "oidc-client-ts";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { PublicConfig } from "../config";
import { createUserManager, safeLocalReturnTo } from "./session";

type AuthStatus = "loading" | "authenticated" | "anonymous" | "error";

interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  error: string | null;
  signIn: (returnTo?: string) => Promise<void>;
  signOut: () => Promise<void>;
  invalidateSession: () => Promise<void>;
  completeSignIn: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({
  config,
  children,
}: {
  config: Extract<PublicConfig, { mode: "cloud" }>;
  children: ReactNode;
}) {
  const manager = useMemo(() => createUserManager(config), [config]);
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void manager
      .getUser()
      .then((current) => {
        if (!active) return;
        const valid = current && !current.expired ? current : null;
        setUser(valid);
        setStatus(valid ? "authenticated" : "anonymous");
      })
      .catch(() => {
        if (!active) return;
        setStatus("error");
        setError("로그인 상태를 확인하지 못했습니다.");
      });
    const loaded = (current: User) => {
      setUser(current);
      setStatus("authenticated");
      setError(null);
    };
    const unloaded = () => {
      setUser(null);
      setStatus("anonymous");
    };
    manager.events.addUserLoaded(loaded);
    manager.events.addUserUnloaded(unloaded);
    return () => {
      active = false;
      manager.events.removeUserLoaded(loaded);
      manager.events.removeUserUnloaded(unloaded);
    };
  }, [manager]);

  const invalidateSession = useCallback(async () => {
    await manager.removeUser();
    setUser(null);
    setStatus("anonymous");
  }, [manager]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      error,
      signIn: async (returnTo = "/") => {
        setError(null);
        await manager.signinRedirect({ state: { returnTo: safeLocalReturnTo(returnTo) } });
      },
      signOut: async () => {
        await manager.signoutRedirect();
      },
      invalidateSession,
      completeSignIn: async () => {
        try {
          const completed = await manager.signinRedirectCallback();
          setUser(completed);
          setStatus("authenticated");
          setError(null);
          const state = completed.state as { returnTo?: string } | undefined;
          window.location.replace(safeLocalReturnTo(state?.returnTo));
        } catch {
          setStatus("error");
          setError("로그인 응답을 확인하지 못했습니다. 다시 로그인해 주세요.");
        }
      },
    }),
    [error, invalidateSession, manager, status, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within AuthProvider");
  return value;
}

export type { UserManager };
