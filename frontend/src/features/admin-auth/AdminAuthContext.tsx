import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Outlet } from 'react-router-dom';

import { AdminApiRequestError } from '../../api/adminApi';
import { fetchCurrentAdmin, loginAdmin, type AdminProfile } from './adminAuthApi';
import { clearAdminAuth, loadAdminAuth, saveAdminAuth } from './adminAuthStorage';

export type AdminAuthPhase =
  'authenticated' | 'checking-session' | 'temporarily-unavailable' | 'unauthenticated';

export type AdminLoginOutcome =
  | { kind: 'authenticated' }
  | { kind: 'invalid-credentials' }
  | { kind: 'rate-limited'; retryAfterSeconds: number | null }
  | { kind: 'service-unavailable' }
  | { kind: 'network' }
  | { kind: 'timeout' }
  | { kind: 'invalid-response' }
  | { kind: 'aborted' }
  | { kind: 'session-unavailable' };

interface AdminAuthState {
  admin: AdminProfile | null;
  phase: AdminAuthPhase;
}

interface AdminAuthContextValue extends AdminAuthState {
  expireSession: () => void;
  getAccessToken: () => string | null;
  login: (email: string, password: string) => Promise<AdminLoginOutcome>;
  logout: () => void;
  retrySessionValidation: () => Promise<void>;
}

const AdminAuthContext = createContext<AdminAuthContextValue | null>(null);

function classifyLoginError(error: unknown): AdminLoginOutcome {
  if (!(error instanceof AdminApiRequestError)) {
    return { kind: 'network' };
  }
  if (error.kind === 'aborted') {
    return { kind: 'aborted' };
  }
  if (error.kind === 'timeout') {
    return { kind: 'timeout' };
  }
  if (error.kind === 'network') {
    return { kind: 'network' };
  }
  if (error.kind === 'invalid-response') {
    return { kind: 'invalid-response' };
  }
  if (error.status === 401) {
    return { kind: 'invalid-credentials' };
  }
  if (error.status === 429) {
    return {
      kind: 'rate-limited',
      retryAfterSeconds: error.retryAfterSeconds,
    };
  }
  if (error.status === 503) {
    return { kind: 'service-unavailable' };
  }
  return { kind: 'network' };
}

export function AdminAuthProvider({ children }: { children?: ReactNode }) {
  const [initialAccessToken] = useState(() => loadAdminAuth());
  const [state, setState] = useState<AdminAuthState>(() => ({
    admin: null,
    phase: initialAccessToken === null ? 'unauthenticated' : 'checking-session',
  }));
  const accessTokenRef = useRef<string | null>(initialAccessToken);
  const activeControllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);

  const beginRequest = useCallback(() => {
    generationRef.current += 1;
    activeControllerRef.current?.abort();
    const controller = new AbortController();
    activeControllerRef.current = controller;
    return { controller, generation: generationRef.current };
  }, []);

  const requestIsCurrent = useCallback(
    (generation: number) => generationRef.current === generation,
    [],
  );

  const clearSession = useCallback(() => {
    generationRef.current += 1;
    activeControllerRef.current?.abort();
    activeControllerRef.current = null;
    accessTokenRef.current = null;
    clearAdminAuth();
    setState({ admin: null, phase: 'unauthenticated' });
  }, []);

  const validateStoredToken = useCallback(
    async (accessToken: string): Promise<boolean> => {
      const { controller, generation } = beginRequest();
      try {
        const admin = await fetchCurrentAdmin(accessToken, controller.signal);
        if (!requestIsCurrent(generation)) {
          return false;
        }
        activeControllerRef.current = null;
        setState({ admin, phase: 'authenticated' });
        return true;
      } catch (error: unknown) {
        if (!requestIsCurrent(generation)) {
          return false;
        }
        activeControllerRef.current = null;
        if (
          error instanceof AdminApiRequestError &&
          error.kind === 'http' &&
          error.status === 401
        ) {
          accessTokenRef.current = null;
          clearAdminAuth();
          setState({ admin: null, phase: 'unauthenticated' });
          return false;
        }
        if (error instanceof AdminApiRequestError && error.kind === 'aborted') {
          return false;
        }
        setState({ admin: null, phase: 'temporarily-unavailable' });
        return false;
      }
    },
    [beginRequest, requestIsCurrent],
  );

  useEffect(() => {
    if (initialAccessToken === null) {
      return undefined;
    }
    const validationStartId = window.setTimeout(() => {
      void validateStoredToken(initialAccessToken);
    }, 0);

    return () => {
      window.clearTimeout(validationStartId);
      generationRef.current += 1;
      activeControllerRef.current?.abort();
      activeControllerRef.current = null;
    };
  }, [initialAccessToken, validateStoredToken]);

  const login = useCallback(
    async (email: string, password: string): Promise<AdminLoginOutcome> => {
      const { controller, generation } = beginRequest();
      try {
        const response = await loginAdmin(email, password, controller.signal);
        if (!requestIsCurrent(generation)) {
          return { kind: 'aborted' };
        }

        accessTokenRef.current = response.accessToken;
        saveAdminAuth(response.accessToken);
        activeControllerRef.current = null;
        const authenticated = await validateStoredToken(response.accessToken);
        return authenticated
          ? { kind: 'authenticated' }
          : accessTokenRef.current === null
            ? { kind: 'invalid-credentials' }
            : { kind: 'session-unavailable' };
      } catch (error: unknown) {
        if (!requestIsCurrent(generation)) {
          return { kind: 'aborted' };
        }
        activeControllerRef.current = null;
        return classifyLoginError(error);
      }
    },
    [beginRequest, requestIsCurrent, validateStoredToken],
  );

  const retrySessionValidation = useCallback(async () => {
    const token = accessTokenRef.current;
    if (token === null) {
      setState({ admin: null, phase: 'unauthenticated' });
      return;
    }
    setState({ admin: null, phase: 'checking-session' });
    await validateStoredToken(token);
  }, [validateStoredToken]);

  const getAccessToken = useCallback(
    () => (state.phase === 'authenticated' ? accessTokenRef.current : null),
    [state.phase],
  );

  const value = useMemo<AdminAuthContextValue>(
    () => ({
      ...state,
      expireSession: clearSession,
      getAccessToken,
      login,
      logout: clearSession,
      retrySessionValidation,
    }),
    [clearSession, getAccessToken, login, retrySessionValidation, state],
  );

  return (
    <AdminAuthContext.Provider value={value}>
      {children ?? <Outlet />}
    </AdminAuthContext.Provider>
  );
}

/** Access administrator authentication state within the administrator route tree. */
// The hook intentionally shares its context with the provider in this scoped module.
// eslint-disable-next-line react-refresh/only-export-components
export function useAdminAuth(): AdminAuthContextValue {
  const context = useContext(AdminAuthContext);
  if (context === null) {
    throw new Error('useAdminAuth must be used within AdminAuthProvider');
  }
  return context;
}
