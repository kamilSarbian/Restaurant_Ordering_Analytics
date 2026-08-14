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

import {
  AuthApiRequestError,
  type AuthUser,
  fetchCurrentUser,
  loginUser,
  registerUser,
} from './authApi';
import {
  clearAuthToken,
  clearLegacyAuthToken,
  loadAuthToken,
  loadLegacyAuthToken,
  saveAuthToken,
} from './authStorage';

export type AuthPhase =
  'authenticated' | 'checking-session' | 'temporarily-unavailable' | 'unauthenticated';

export type AuthActionOutcome =
  | { kind: 'aborted' }
  | { kind: 'account-exists' }
  | { kind: 'authenticated' }
  | { kind: 'invalid-credentials' }
  | { kind: 'invalid-response' }
  | { kind: 'network' }
  | { kind: 'rate-limited'; retryAfterSeconds: number | null }
  | { kind: 'service-unavailable' }
  | { kind: 'session-unavailable' }
  | { kind: 'timeout' }
  | { kind: 'validation' };

type TokenSource = 'canonical' | 'legacy';
type ValidationResult = 'aborted' | 'authenticated' | 'temporary' | 'unauthenticated';

interface AuthState {
  accessToken: string | null;
  phase: AuthPhase;
  user: AuthUser | null;
}

interface AuthContextValue extends AuthState {
  getAuthenticatedSession: () => AuthenticatedSession | null;
  invalidateSessionIfCurrent: (session: AuthenticatedSession) => void;
  login: (email: string, password: string) => Promise<AuthActionOutcome>;
  logout: () => void;
  refreshCurrentUser: () => Promise<AuthUser | null>;
  register: (email: string, password: string) => Promise<AuthActionOutcome>;
  retrySession: () => Promise<void>;
}

export interface AuthenticatedSession {
  readonly accessToken: string;
  readonly generation: number;
}

interface InitialSession {
  source: TokenSource | null;
  token: string | null;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function loadInitialSession(): InitialSession {
  const canonicalToken = loadAuthToken();
  if (canonicalToken !== null) {
    return { source: 'canonical', token: canonicalToken };
  }
  const legacyToken = loadLegacyAuthToken();
  return legacyToken === null
    ? { source: null, token: null }
    : { source: 'legacy', token: legacyToken };
}

function classifyCredentialError(error: unknown): AuthActionOutcome {
  if (!(error instanceof AuthApiRequestError)) {
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
  if (error.status === 409) {
    return { kind: 'account-exists' };
  }
  if (error.status === 422) {
    return { kind: 'validation' };
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

/** Provide one canonical authentication session to every application route. */
export function AuthProvider({ children }: { children?: ReactNode }) {
  const [initialSession] = useState(loadInitialSession);
  const [state, setState] = useState<AuthState>(() => ({
    accessToken: initialSession.token,
    phase: initialSession.token === null ? 'unauthenticated' : 'checking-session',
    user: null,
  }));
  const tokenRef = useRef(initialSession.token);
  const sourceRef = useRef(initialSession.source);
  const activeControllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const sessionGenerationRef = useRef(initialSession.token === null ? 0 : 1);

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
    sessionGenerationRef.current += 1;
    activeControllerRef.current?.abort();
    activeControllerRef.current = null;
    tokenRef.current = null;
    sourceRef.current = null;
    clearAuthToken();
    clearLegacyAuthToken();
    setState({ accessToken: null, phase: 'unauthenticated', user: null });
  }, []);

  const validateToken = useCallback(
    async (
      accessToken: string,
      source: TokenSource,
      controller: AbortController,
      generation: number,
    ): Promise<{ result: ValidationResult; user: AuthUser | null }> => {
      try {
        const user = await fetchCurrentUser(accessToken, controller.signal);
        if (!requestIsCurrent(generation)) {
          return { result: 'aborted', user: null };
        }
        activeControllerRef.current = null;
        tokenRef.current = accessToken;
        sourceRef.current = 'canonical';
        saveAuthToken(accessToken);
        clearLegacyAuthToken();
        setState({ accessToken, phase: 'authenticated', user });
        return { result: 'authenticated', user };
      } catch (error: unknown) {
        if (!requestIsCurrent(generation)) {
          return { result: 'aborted', user: null };
        }
        activeControllerRef.current = null;
        if (error instanceof AuthApiRequestError && error.kind === 'aborted') {
          return { result: 'aborted', user: null };
        }
        if (
          error instanceof AuthApiRequestError &&
          error.kind === 'http' &&
          error.status === 401
        ) {
          tokenRef.current = null;
          sourceRef.current = null;
          if (source === 'canonical') {
            clearAuthToken();
            clearLegacyAuthToken();
          } else {
            clearLegacyAuthToken();
          }
          setState({ accessToken: null, phase: 'unauthenticated', user: null });
          return { result: 'unauthenticated', user: null };
        }
        tokenRef.current = accessToken;
        sourceRef.current = source;
        setState({
          accessToken,
          phase: 'temporarily-unavailable',
          user: null,
        });
        return { result: 'temporary', user: null };
      }
    },
    [requestIsCurrent],
  );

  const validateCurrentSession = useCallback(async (): Promise<{
    result: ValidationResult;
    user: AuthUser | null;
  }> => {
    const accessToken = tokenRef.current;
    const source = sourceRef.current;
    if (accessToken === null || source === null) {
      setState({ accessToken: null, phase: 'unauthenticated', user: null });
      return { result: 'unauthenticated', user: null };
    }
    const { controller, generation } = beginRequest();
    return validateToken(accessToken, source, controller, generation);
  }, [beginRequest, validateToken]);

  useEffect(() => {
    if (initialSession.token === null) {
      return undefined;
    }
    const validationStartId = window.setTimeout(() => {
      void validateCurrentSession();
    }, 0);
    return () => {
      window.clearTimeout(validationStartId);
      generationRef.current += 1;
      activeControllerRef.current?.abort();
      activeControllerRef.current = null;
    };
  }, [initialSession.token, validateCurrentSession]);

  const establishCredentials = useCallback(
    async (
      requestToken: (signal: AbortSignal) => Promise<{ accessToken: string }>,
    ): Promise<AuthActionOutcome> => {
      const { controller, generation } = beginRequest();
      try {
        const tokenResponse = await requestToken(controller.signal);
        if (!requestIsCurrent(generation)) {
          return { kind: 'aborted' };
        }
        tokenRef.current = tokenResponse.accessToken;
        sourceRef.current = 'canonical';
        sessionGenerationRef.current += 1;
        saveAuthToken(tokenResponse.accessToken);
        setState({
          accessToken: tokenResponse.accessToken,
          phase: 'checking-session',
          user: null,
        });
        const validation = await validateToken(
          tokenResponse.accessToken,
          'canonical',
          controller,
          generation,
        );
        if (validation.result === 'authenticated') {
          return { kind: 'authenticated' };
        }
        if (validation.result === 'temporary') {
          return { kind: 'session-unavailable' };
        }
        if (validation.result === 'aborted') {
          return { kind: 'aborted' };
        }
        return { kind: 'invalid-credentials' };
      } catch (error: unknown) {
        if (!requestIsCurrent(generation)) {
          return { kind: 'aborted' };
        }
        activeControllerRef.current = null;
        return classifyCredentialError(error);
      }
    },
    [beginRequest, requestIsCurrent, validateToken],
  );

  const login = useCallback(
    (email: string, password: string) =>
      establishCredentials((signal) => loginUser(email, password, signal)),
    [establishCredentials],
  );

  const register = useCallback(
    (email: string, password: string) =>
      establishCredentials((signal) => registerUser(email, password, signal)),
    [establishCredentials],
  );

  const retrySession = useCallback(async () => {
    if (tokenRef.current === null || sourceRef.current === null) {
      setState({ accessToken: null, phase: 'unauthenticated', user: null });
      return;
    }
    setState({
      accessToken: tokenRef.current,
      phase: 'checking-session',
      user: null,
    });
    await validateCurrentSession();
  }, [validateCurrentSession]);

  const refreshCurrentUser = useCallback(async (): Promise<AuthUser | null> => {
    if (tokenRef.current === null || sourceRef.current === null) {
      clearSession();
      return null;
    }
    const validation = await validateCurrentSession();
    return validation.user;
  }, [clearSession, validateCurrentSession]);

  const invalidateSessionIfCurrent = useCallback(
    (session: AuthenticatedSession) => {
      if (
        tokenRef.current === session.accessToken &&
        sessionGenerationRef.current === session.generation
      ) {
        clearSession();
      }
    },
    [clearSession],
  );

  const getAuthenticatedSession = useCallback(
    (): AuthenticatedSession | null =>
      state.phase === 'authenticated' && tokenRef.current !== null
        ? {
            accessToken: tokenRef.current,
            generation: sessionGenerationRef.current,
          }
        : null,
    [state.phase],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      getAuthenticatedSession,
      invalidateSessionIfCurrent,
      login,
      logout: clearSession,
      refreshCurrentUser,
      register,
      retrySession,
    }),
    [
      clearSession,
      getAuthenticatedSession,
      invalidateSessionIfCurrent,
      login,
      refreshCurrentUser,
      register,
      retrySession,
      state,
    ],
  );

  return (
    <AuthContext.Provider value={value}>{children ?? <Outlet />}</AuthContext.Provider>
  );
}

/** Access the canonical application authentication state. */
// Auth state helpers intentionally share this module with their provider.
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === null) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
