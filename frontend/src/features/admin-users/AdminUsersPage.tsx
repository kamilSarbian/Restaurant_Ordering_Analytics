import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useNavigate } from 'react-router-dom';

import { AdminApiRequestError } from '../../api/adminApi';
import Button from '../../components/ui/Button';
import Notice, { type NoticeVariant } from '../../components/ui/Notice';
import StatusBadge, { type StatusBadgeVariant } from '../../components/ui/StatusBadge';
import { useAuth, type AuthenticatedSession } from '../auth/AuthContext';
import {
  type AdminUserListItem,
  type AdminUsersResponse,
  type OrdinaryAdminUserRole,
  fetchAdminUsers,
  updateAdminUserRole,
} from './adminUsersApi';
import styles from './AdminUsersPage.module.css';

const PAGE_LIMIT = 50;

type ListLoadReason = 'initial' | 'manual' | 'post-mutation' | 'reconcile';
type NoticeKind = 'error' | 'success' | 'warning';

interface MutationNotice {
  readonly kind: NoticeKind;
  readonly message: string;
}

interface PendingTransition {
  readonly currentRole: OrdinaryAdminUserRole;
  readonly email: string;
  readonly targetRole: OrdinaryAdminUserRole;
  readonly userId: string;
}

type AsyncFocusTarget = 'feedback' | 'origin' | 'results';

interface ActiveAsyncFocus {
  readonly origin: HTMLButtonElement;
  readonly successTarget: Exclude<AsyncFocusTarget, 'feedback'>;
}

interface PendingAsyncFocus {
  readonly origin: HTMLButtonElement;
  readonly target: AsyncFocusTarget;
}

function shouldRestoreAsyncFocus(origin: HTMLElement): boolean {
  const activeElement = document.activeElement;
  return (
    activeElement === null ||
    activeElement === document.body ||
    activeElement === origin ||
    !activeElement.isConnected
  );
}

function formatAdminUserDate(timestamp: string): string {
  return new Intl.DateTimeFormat('en-NO', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp));
}

function getRoleLabel(role: AdminUserListItem['role']): string {
  return {
    admin: 'Administrator',
    customer: 'Customer',
    super_admin: 'Super administrator',
  }[role];
}

function getTargetRole(user: AdminUserListItem): OrdinaryAdminUserRole | null {
  if (user.role === 'customer') {
    return 'admin';
  }
  if (user.role === 'admin') {
    return 'customer';
  }
  return null;
}

function getActionLabel(targetRole: OrdinaryAdminUserRole): string {
  return targetRole === 'admin' ? 'Promote to admin' : 'Demote to customer';
}

function getListErrorMessage(error: unknown): string {
  if (!(error instanceof AdminApiRequestError)) {
    return 'The user list could not be loaded. Check your connection and try again.';
  }
  if (error.kind === 'network' || error.kind === 'timeout') {
    return 'The user service could not be reached. Check your connection and try again.';
  }
  if (error.kind === 'invalid-response') {
    return 'The user service returned an unexpected response. Try again later.';
  }
  if (error.status === 422) {
    return 'The requested user page is not valid. Return to the first page and try again.';
  }
  if (error.status === 503 || (error.status !== null && error.status >= 500)) {
    return 'The user service is temporarily unavailable. Try again later.';
  }
  return 'The user list could not be loaded. Try again.';
}

function isAmbiguousMutationFailure(error: unknown): boolean {
  return (
    !(error instanceof AdminApiRequestError) ||
    error.kind === 'network' ||
    error.kind === 'timeout' ||
    error.kind === 'invalid-response' ||
    (error.status !== null && error.status >= 500)
  );
}

function getNoticeVariant(kind: NoticeKind): NoticeVariant {
  return {
    error: 'danger',
    success: 'success',
    warning: 'warning',
  }[kind] as NoticeVariant;
}

function getNoticeTitle(kind: NoticeKind): string {
  return {
    error: 'Role update blocked',
    success: 'Role updated',
    warning: 'Review required',
  }[kind];
}

interface UserActionProps {
  readonly currentUserId: string;
  readonly disabled: boolean;
  readonly onSelect: (
    user: AdminUserListItem,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => void;
  readonly user: AdminUserListItem;
}

function UserAction({ currentUserId, disabled, onSelect, user }: UserActionProps) {
  if (user.id === currentUserId) {
    return <StatusBadge variant="neutral">Read only</StatusBadge>;
  }
  const targetRole = getTargetRole(user);
  if (targetRole === null) {
    return <StatusBadge variant="neutral">Read only</StatusBadge>;
  }
  const actionLabel = getActionLabel(targetRole);
  return (
    <Button
      className={styles.actionButton}
      disabled={disabled}
      aria-label={`${actionLabel} for ${user.email}`}
      onClick={(event) => onSelect(user, event)}
      variant="secondary"
    >
      {actionLabel}
    </Button>
  );
}

function UserRole({ user }: { readonly user: AdminUserListItem }) {
  const variant: StatusBadgeVariant = {
    admin: 'info',
    customer: 'neutral',
    super_admin: 'success',
  }[user.role] as StatusBadgeVariant;
  return (
    <StatusBadge className={styles.roleBadge} variant={variant}>
      {getRoleLabel(user.role)}
    </StatusBadge>
  );
}

function UserActivity({ user }: { readonly user: AdminUserListItem }) {
  return (
    <StatusBadge variant={user.isActive ? 'success' : 'neutral'}>
      {user.isActive ? 'Active' : 'Inactive'}
    </StatusBadge>
  );
}

function UserIdentity({
  currentUserId,
  user,
}: {
  readonly currentUserId: string;
  readonly user: AdminUserListItem;
}) {
  return (
    <span className={styles.identity}>
      <span>{user.email}</span>
      {user.id === currentUserId ? <StatusBadge variant="info">You</StatusBadge> : null}
    </span>
  );
}

interface UserCollectionProps {
  readonly controlsDisabled: boolean;
  readonly currentUserId: string;
  readonly data: AdminUsersResponse;
  readonly onSelect: UserActionProps['onSelect'];
}

function UsersTable({
  controlsDisabled,
  currentUserId,
  data,
  onSelect,
}: UserCollectionProps) {
  return (
    <div className={styles.tableWrapper}>
      <table className={styles.table}>
        <caption>Registered users, oldest first</caption>
        <thead>
          <tr>
            <th scope="col">Email</th>
            <th scope="col">Role</th>
            <th scope="col">Account state</th>
            <th scope="col">Created</th>
            <th scope="col">Updated</th>
            <th scope="col">Role action</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((user) => (
            <tr key={user.id}>
              <th scope="row">
                <UserIdentity currentUserId={currentUserId} user={user} />
              </th>
              <td>
                <UserRole user={user} />
              </td>
              <td>
                <UserActivity user={user} />
              </td>
              <td>
                <time dateTime={user.createdAt}>
                  {formatAdminUserDate(user.createdAt)}
                </time>
              </td>
              <td>
                <time dateTime={user.updatedAt}>
                  {formatAdminUserDate(user.updatedAt)}
                </time>
              </td>
              <td>
                <UserAction
                  currentUserId={currentUserId}
                  disabled={controlsDisabled}
                  onSelect={onSelect}
                  user={user}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UsersCards({
  controlsDisabled,
  currentUserId,
  data,
  onSelect,
}: UserCollectionProps) {
  return (
    <ul className={styles.cards} aria-label="Registered users, oldest first">
      {data.items.map((user) => {
        const headingId = `admin-user-${user.id}`;
        return (
          <li className={styles.card} key={user.id}>
            <article aria-labelledby={headingId}>
              <h2 id={headingId}>
                <UserIdentity currentUserId={currentUserId} user={user} />
              </h2>
              <dl className={styles.cardDetails}>
                <div>
                  <dt>Role</dt>
                  <dd>
                    <UserRole user={user} />
                  </dd>
                </div>
                <div>
                  <dt>Account state</dt>
                  <dd>
                    <UserActivity user={user} />
                  </dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd>
                    <time dateTime={user.createdAt}>
                      {formatAdminUserDate(user.createdAt)}
                    </time>
                  </dd>
                </div>
                <div>
                  <dt>Updated</dt>
                  <dd>
                    <time dateTime={user.updatedAt}>
                      {formatAdminUserDate(user.updatedAt)}
                    </time>
                  </dd>
                </div>
              </dl>
              <div className={styles.cardAction}>
                <UserAction
                  currentUserId={currentUserId}
                  disabled={controlsDisabled}
                  onSelect={onSelect}
                  user={user}
                />
              </div>
            </article>
          </li>
        );
      })}
    </ul>
  );
}

/** Display super-administrator-only user governance controls. */
export default function AdminUsersPage() {
  const {
    getAuthenticatedSession,
    invalidateSessionIfCurrent,
    logout,
    phase,
    refreshCurrentUser,
    user,
  } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState<AdminUsersResponse | null>(null);
  const [offset, setOffset] = useState(0);
  const [isListLoading, setIsListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [pendingTransition, setPendingTransition] = useState<PendingTransition | null>(
    null,
  );
  const [mutationInFlight, setMutationInFlight] = useState(false);
  const [mutationNotice, setMutationNotice] = useState<MutationNotice | null>(null);
  const [reconciliationRequired, setReconciliationRequired] = useState(false);
  const activeAsyncFocusRef = useRef<ActiveAsyncFocus | null>(null);
  const dataRef = useRef<AdminUsersResponse | null>(null);
  const emptyHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const listControllerRef = useRef<AbortController | null>(null);
  const listGenerationRef = useRef(0);
  const mutationControllerRef = useRef<AbortController | null>(null);
  const mutationInFlightRef = useRef(false);
  const reconciliationRequiredRef = useRef(false);
  const mountedRef = useRef(true);
  const feedbackRef = useRef<HTMLDivElement | null>(null);
  const confirmationHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const initiatingActionRef = useRef<HTMLButtonElement | null>(null);
  const pendingAsyncFocusRef = useRef<PendingAsyncFocus | null>(null);
  const resultsRef = useRef<HTMLDivElement | null>(null);

  const beginAsyncFocus = useCallback(
    (
      origin: HTMLButtonElement,
      successTarget: Exclude<AsyncFocusTarget, 'feedback'>,
    ) => {
      activeAsyncFocusRef.current = { origin, successTarget };
      pendingAsyncFocusRef.current = null;
    },
    [],
  );

  const queueAsyncFocus = useCallback((target?: AsyncFocusTarget) => {
    const activeFocus = activeAsyncFocusRef.current;
    if (activeFocus === null) return;
    activeAsyncFocusRef.current = null;
    pendingAsyncFocusRef.current = {
      origin: activeFocus.origin,
      target: target ?? activeFocus.successTarget,
    };
  }, []);

  const focusFeedback = useCallback(() => {
    queueAsyncFocus('feedback');
  }, [queueAsyncFocus]);

  const storeData = useCallback((nextData: AdminUsersResponse | null) => {
    dataRef.current = nextData;
    setData(nextData);
  }, []);

  const setReconciliationGate = useCallback((required: boolean) => {
    if (required) {
      listGenerationRef.current += 1;
      listControllerRef.current?.abort();
      listControllerRef.current = null;
      setIsListLoading(false);
    }
    reconciliationRequiredRef.current = required;
    setReconciliationRequired(required);
  }, []);

  const sessionIsCurrent = useCallback(
    (session: AuthenticatedSession): boolean => {
      const currentSession = getAuthenticatedSession();
      return (
        currentSession !== null &&
        currentSession.accessToken === session.accessToken &&
        currentSession.generation === session.generation
      );
    },
    [getAuthenticatedSession],
  );

  const refreshRoleAfterForbidden = useCallback(
    async (session: AuthenticatedSession) => {
      if (!sessionIsCurrent(session)) {
        return null;
      }
      const refreshedUser = await refreshCurrentUser();
      if (!mountedRef.current || refreshedUser === null) {
        return null;
      }
      if (refreshedUser.role === 'customer') {
        navigate('/account', { replace: true });
        return refreshedUser;
      }
      if (refreshedUser.role === 'admin') {
        navigate('/admin', { replace: true });
      }
      return refreshedUser;
    },
    [navigate, refreshCurrentUser, sessionIsCurrent],
  );

  const loadUsers = useCallback(
    async (reason: ListLoadReason = 'manual'): Promise<boolean> => {
      if (
        mutationInFlightRef.current &&
        reason !== 'post-mutation' &&
        reason !== 'reconcile'
      ) {
        return false;
      }
      if (phase !== 'authenticated' || user?.role !== 'super_admin') {
        return false;
      }
      const authSession = getAuthenticatedSession();
      if (authSession === null) {
        logout();
        return false;
      }

      listGenerationRef.current += 1;
      const generation = listGenerationRef.current;
      listControllerRef.current?.abort();
      const controller = new AbortController();
      listControllerRef.current = controller;
      setIsListLoading(true);
      setListError(null);

      try {
        const response = await fetchAdminUsers({
          accessToken: authSession.accessToken,
          limit: PAGE_LIMIT,
          offset,
          signal: controller.signal,
        });
        if (generation !== listGenerationRef.current || !mountedRef.current) {
          return false;
        }
        listControllerRef.current = null;

        if (response.items.length === 0 && offset > 0 && offset >= response.total) {
          const lastOffset =
            response.total === 0
              ? 0
              : Math.floor((response.total - 1) / PAGE_LIMIT) * PAGE_LIMIT;
          storeData(null);
          setOffset(lastOffset);
          return false;
        }

        const gateWasRequired = reconciliationRequiredRef.current;
        storeData(response);
        setPendingTransition(null);
        setReconciliationGate(false);
        if (reason === 'post-mutation') {
          setMutationNotice({
            kind: 'success',
            message: 'The role was updated and the authoritative user list was loaded.',
          });
        } else if (reason === 'reconcile') {
          setMutationNotice({
            kind: 'warning',
            message:
              'The latest user state was loaded. Review it before choosing another role action.',
          });
        } else if (gateWasRequired) {
          setMutationNotice({
            kind: 'success',
            message:
              'The latest user state was loaded. Role actions are available again.',
          });
        } else if (reason === 'manual') {
          setMutationNotice(null);
        }
        if (reason === 'post-mutation' || reason === 'reconcile' || gateWasRequired) {
          focusFeedback();
        } else {
          queueAsyncFocus();
        }
        return true;
      } catch (error: unknown) {
        if (generation !== listGenerationRef.current || !mountedRef.current) {
          return false;
        }
        listControllerRef.current = null;
        if (error instanceof AdminApiRequestError && error.kind === 'aborted') {
          return false;
        }
        if (error instanceof AdminApiRequestError && error.status === 401) {
          invalidateSessionIfCurrent(authSession);
          return false;
        }
        if (error instanceof AdminApiRequestError && error.status === 403) {
          const refreshedUser = await refreshRoleAfterForbidden(authSession);
          if (mountedRef.current && refreshedUser?.role === 'super_admin') {
            setReconciliationGate(true);
            setListError(
              'Your super-administrator access was confirmed, but the user service denied this request. Refresh and try again.',
            );
            focusFeedback();
          }
          return false;
        }

        setListError(getListErrorMessage(error));
        if (reason === 'post-mutation') {
          setMutationNotice({
            kind: 'warning',
            message:
              'The role update was accepted, but the authoritative list could not be refreshed. Refresh before another role action.',
          });
        } else if (reason === 'reconcile') {
          setMutationNotice({
            kind: 'warning',
            message:
              'The latest user state could not be reconciled. Refresh before another role action.',
          });
        }
        if (reason !== 'initial' || activeAsyncFocusRef.current !== null) {
          focusFeedback();
        }
        return false;
      } finally {
        if (generation === listGenerationRef.current && mountedRef.current) {
          setIsListLoading(false);
        }
      }
    },
    [
      getAuthenticatedSession,
      focusFeedback,
      invalidateSessionIfCurrent,
      logout,
      offset,
      phase,
      queueAsyncFocus,
      refreshRoleAfterForbidden,
      setReconciliationGate,
      storeData,
      user?.role,
    ],
  );

  useEffect(() => {
    mountedRef.current = true;
    if (phase !== 'authenticated' || user?.role !== 'super_admin') {
      return undefined;
    }
    const requestStartId = window.setTimeout(() => void loadUsers('initial'), 0);
    return () => {
      window.clearTimeout(requestStartId);
      listGenerationRef.current += 1;
      listControllerRef.current?.abort();
      listControllerRef.current = null;
    };
  }, [loadUsers, phase, user?.role]);

  useEffect(
    () => () => {
      mountedRef.current = false;
      listGenerationRef.current += 1;
      listControllerRef.current?.abort();
      mutationControllerRef.current?.abort();
      listControllerRef.current = null;
      mutationControllerRef.current = null;
      mutationInFlightRef.current = false;
      activeAsyncFocusRef.current = null;
      pendingAsyncFocusRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (pendingTransition !== null) {
      confirmationHeadingRef.current?.focus();
    }
  }, [pendingTransition]);

  useEffect(() => {
    const pendingFocus = pendingAsyncFocusRef.current;
    if (pendingFocus === null || isListLoading || mutationInFlight) return;

    const target =
      pendingFocus.target === 'feedback'
        ? feedbackRef.current
        : pendingFocus.target === 'origin'
          ? pendingFocus.origin
          : data?.items.length === 0
            ? emptyHeadingRef.current
            : resultsRef.current;
    if (target === null || !target.isConnected) return;

    pendingAsyncFocusRef.current = null;
    if (!shouldRestoreAsyncFocus(pendingFocus.origin)) return;
    if (target instanceof HTMLButtonElement && target.disabled) return;
    target.focus();
  }, [
    data,
    isListLoading,
    listError,
    mutationInFlight,
    mutationNotice,
    reconciliationRequired,
  ]);

  const selectTransition = (
    selectedUser: AdminUserListItem,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    if (
      mutationInFlightRef.current ||
      reconciliationRequiredRef.current ||
      isListLoading ||
      pendingTransition !== null ||
      selectedUser.id === user?.id
    ) {
      return;
    }
    const currentRole = selectedUser.role;
    if (currentRole === 'super_admin') {
      return;
    }
    const targetRole: OrdinaryAdminUserRole =
      currentRole === 'customer' ? 'admin' : 'customer';
    initiatingActionRef.current = event.currentTarget;
    setPendingTransition({
      currentRole,
      email: selectedUser.email,
      targetRole,
      userId: selectedUser.id,
    });
    setMutationNotice(null);
  };

  const cancelTransition = useCallback(() => {
    if (mutationInFlightRef.current) {
      return;
    }
    setPendingTransition(null);
    window.setTimeout(() => initiatingActionRef.current?.focus(), 0);
  }, []);

  const handleConfirmationKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && !mutationInFlightRef.current) {
      event.preventDefault();
      cancelTransition();
    }
  };

  const confirmTransition = useCallback(async () => {
    if (
      pendingTransition === null ||
      mutationInFlightRef.current ||
      reconciliationRequiredRef.current ||
      listControllerRef.current !== null
    ) {
      return;
    }
    const authSession = getAuthenticatedSession();
    if (authSession === null) {
      logout();
      return;
    }

    const transition = pendingTransition;
    const controller = new AbortController();
    mutationControllerRef.current = controller;
    mutationInFlightRef.current = true;
    setMutationInFlight(true);
    setMutationNotice(null);

    try {
      await updateAdminUserRole(transition.userId, {
        accessToken: authSession.accessToken,
        role: transition.targetRole,
        signal: controller.signal,
      });
      if (!mountedRef.current || !sessionIsCurrent(authSession)) {
        return;
      }

      setPendingTransition(null);
      setReconciliationGate(true);
      setMutationNotice({
        kind: 'warning',
        message: 'The role update was accepted. Refreshing the user list.',
      });
      await loadUsers('post-mutation');
    } catch (error: unknown) {
      if (!mountedRef.current) {
        return;
      }
      if (error instanceof AdminApiRequestError && error.kind === 'aborted') {
        return;
      }
      if (error instanceof AdminApiRequestError && error.status === 401) {
        invalidateSessionIfCurrent(authSession);
        return;
      }
      if (error instanceof AdminApiRequestError && error.status === 403) {
        setPendingTransition(null);
        const refreshedUser = await refreshRoleAfterForbidden(authSession);
        if (mountedRef.current && refreshedUser?.role === 'super_admin') {
          setReconciliationGate(true);
          setMutationNotice({
            kind: 'error',
            message:
              'Your super-administrator access was confirmed, but the role update was denied. Refresh the user list before trying again.',
          });
          focusFeedback();
        }
        return;
      }
      if (
        error instanceof AdminApiRequestError &&
        (error.status === 404 || error.status === 409)
      ) {
        setPendingTransition(null);
        setReconciliationGate(true);
        setMutationNotice({
          kind: 'warning',
          message:
            'The selected user changed or is no longer available. Refreshing the authoritative user list.',
        });
        await loadUsers('reconcile');
        return;
      }
      if (error instanceof AdminApiRequestError && error.status === 422) {
        setPendingTransition(null);
        setReconciliationGate(true);
        setMutationNotice({
          kind: 'error',
          message:
            'The requested role transition was not valid. Refresh the list and review the current role.',
        });
        focusFeedback();
        return;
      }
      if (isAmbiguousMutationFailure(error)) {
        setPendingTransition(null);
        setReconciliationGate(true);
        setMutationNotice({
          kind: 'warning',
          message:
            'We could not confirm whether the role changed. Refresh the user list before any other role action.',
        });
        focusFeedback();
        return;
      }

      setPendingTransition(null);
      setMutationNotice({
        kind: 'error',
        message:
          'The role could not be updated. Review the current state and try again.',
      });
      focusFeedback();
    } finally {
      mutationControllerRef.current = null;
      mutationInFlightRef.current = false;
      if (mountedRef.current) {
        setMutationInFlight(false);
      }
    }
  }, [
    getAuthenticatedSession,
    focusFeedback,
    invalidateSessionIfCurrent,
    loadUsers,
    logout,
    pendingTransition,
    refreshRoleAfterForbidden,
    sessionIsCurrent,
    setReconciliationGate,
  ]);

  const changePage = (
    nextOffset: number,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    if (
      mutationInFlightRef.current ||
      reconciliationRequiredRef.current ||
      isListLoading ||
      pendingTransition !== null
    ) {
      return;
    }
    beginAsyncFocus(event.currentTarget, 'results');
    setPendingTransition(null);
    setMutationNotice(null);
    setListError(null);
    storeData(null);
    setOffset(nextOffset);
  };

  if (phase !== 'authenticated' || user?.role !== 'super_admin') {
    return null;
  }

  const controlsDisabled =
    mutationInFlight ||
    reconciliationRequired ||
    isListLoading ||
    pendingTransition !== null;
  const page = Math.floor(offset / PAGE_LIMIT) + 1;

  return (
    <section
      className={styles.page}
      aria-busy={isListLoading || mutationInFlight}
      aria-labelledby="admin-users-heading"
    >
      <header className={styles.pageHeader}>
        <div>
          <p className="eyebrow">User governance</p>
          <h1 id="admin-users-heading">Users</h1>
          <p>
            Review registered accounts and govern ordinary customer and administrator
            roles.
          </p>
          <p className={styles.securityContract}>
            Every privilege change is confirmed by the server before the list changes.
          </p>
        </div>
        <Button
          className={styles.refreshButton}
          disabled={mutationInFlight || pendingTransition !== null}
          loading={isListLoading}
          loadingLabel="Refreshing users"
          onClick={(event) => {
            beginAsyncFocus(event.currentTarget, 'origin');
            void loadUsers('manual');
          }}
          variant="secondary"
        >
          Refresh
        </Button>
      </header>

      {reconciliationRequired ? (
        <div
          ref={feedbackRef}
          aria-label="User management feedback"
          className={styles.feedback}
          tabIndex={-1}
        >
          <Notice
            role="alert"
            title="Refresh required"
            variant={mutationNotice?.kind === 'error' ? 'danger' : 'warning'}
          >
            <div className={styles.noticeBody}>
              {mutationNotice === null ? null : <p>{mutationNotice.message}</p>}
              {listError === null ? null : <p>{listError}</p>}
              <p>
                Role actions remain disabled until the latest authoritative user list
                loads successfully.
              </p>
              {listError === null ? null : (
                <Button
                  disabled={mutationInFlight}
                  loading={isListLoading}
                  loadingLabel="Retrying user list"
                  onClick={(event) => {
                    beginAsyncFocus(event.currentTarget, 'results');
                    void loadUsers('manual');
                  }}
                  variant="secondary"
                >
                  Retry
                </Button>
              )}
            </div>
          </Notice>
        </div>
      ) : listError !== null ? (
        <div
          ref={feedbackRef}
          aria-label="User management feedback"
          className={styles.feedback}
          tabIndex={-1}
        >
          <Notice
            role="alert"
            title={data === null ? 'Unable to load users' : 'Unable to refresh users'}
            variant="danger"
          >
            <div className={styles.noticeBody}>
              <p>{listError}</p>
              <Button
                disabled={mutationInFlight}
                loading={isListLoading}
                loadingLabel="Retrying user list"
                onClick={(event) => {
                  beginAsyncFocus(event.currentTarget, 'results');
                  void loadUsers('manual');
                }}
                variant="secondary"
              >
                Retry
              </Button>
            </div>
          </Notice>
        </div>
      ) : mutationNotice !== null ? (
        <div
          ref={feedbackRef}
          aria-label="User management feedback"
          className={styles.feedback}
          tabIndex={-1}
        >
          <Notice
            role={mutationNotice.kind === 'success' ? 'status' : 'alert'}
            title={getNoticeTitle(mutationNotice.kind)}
            variant={getNoticeVariant(mutationNotice.kind)}
          >
            {mutationNotice.message}
          </Notice>
        </div>
      ) : null}

      {pendingTransition !== null ? (
        <div
          className={styles.confirmationPanel}
          role="group"
          aria-busy={mutationInFlight}
          aria-describedby="role-confirmation-guidance"
          aria-labelledby="role-confirmation-heading"
          data-risk={pendingTransition.targetRole === 'admin' ? 'elevated' : 'reduced'}
          onKeyDown={handleConfirmationKeyDown}
        >
          <h2 id="role-confirmation-heading" ref={confirmationHeadingRef} tabIndex={-1}>
            Confirm role change
          </h2>
          <dl className={styles.confirmationDetails}>
            <div>
              <dt>Account</dt>
              <dd>{pendingTransition.email}</dd>
            </div>
            <div>
              <dt>Current role</dt>
              <dd>{getRoleLabel(pendingTransition.currentRole)}</dd>
            </div>
            <div>
              <dt>Requested role</dt>
              <dd>{getRoleLabel(pendingTransition.targetRole)}</dd>
            </div>
          </dl>
          <p id="role-confirmation-guidance" className={styles.confirmationGuidance}>
            {pendingTransition.targetRole === 'admin'
              ? 'This grants administrator access. Confirm only when the privilege is required.'
              : 'This removes administrator access after the server accepts the change.'}
          </p>
          <div className={styles.confirmationActions}>
            <Button
              disabled={reconciliationRequired || isListLoading}
              loading={mutationInFlight}
              loadingLabel="Updating role"
              onClick={(event) => {
                beginAsyncFocus(event.currentTarget, 'results');
                void confirmTransition();
              }}
              variant={pendingTransition.targetRole === 'admin' ? 'danger' : 'primary'}
            >
              Confirm
            </Button>
            <Button
              disabled={mutationInFlight}
              onClick={cancelTransition}
              variant="secondary"
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {isListLoading && data === null ? (
        <div className={styles.statePanel} role="status" aria-live="polite">
          <h2>Loading users</h2>
          <p>The current registered-user page is being requested.</p>
        </div>
      ) : null}

      {data !== null && data.items.length === 0 && !isListLoading ? (
        <div className={styles.statePanel}>
          <h2 ref={emptyHeadingRef} tabIndex={-1}>
            No users found
          </h2>
          <p>No registered users are available on this page.</p>
        </div>
      ) : null}

      {data !== null && data.items.length > 0 ? (
        <div
          ref={resultsRef}
          aria-label={'User list results'}
          className={styles.results}
          role={'region'}
          tabIndex={-1}
        >
          <div className={styles.resultHeader}>
            <p className={styles.resultSummary} aria-live="polite">
              Showing {data.offset + 1}&ndash;{data.offset + data.items.length} of{' '}
              {data.total}
            </p>
            {isListLoading ? (
              <p className={styles.refreshing} role="status" aria-live="polite">
                Refreshing users&hellip;
              </p>
            ) : null}
          </div>
          <UsersTable
            controlsDisabled={controlsDisabled}
            currentUserId={user.id}
            data={data}
            onSelect={selectTransition}
          />
          <UsersCards
            controlsDisabled={controlsDisabled}
            currentUserId={user.id}
            data={data}
            onSelect={selectTransition}
          />
        </div>
      ) : null}

      {data !== null && data.total > 0 ? (
        <nav className={styles.pagination} aria-label="Users pagination">
          <Button
            disabled={
              offset === 0 ||
              isListLoading ||
              mutationInFlight ||
              reconciliationRequired ||
              pendingTransition !== null
            }
            onClick={(event) => changePage(Math.max(0, offset - PAGE_LIMIT), event)}
            variant="secondary"
          >
            Previous
          </Button>
          <span aria-current="page">Page {page}</span>
          <Button
            disabled={
              data.offset + data.items.length >= data.total ||
              isListLoading ||
              mutationInFlight ||
              reconciliationRequired ||
              pendingTransition !== null
            }
            onClick={(event) => changePage(offset + PAGE_LIMIT, event)}
            variant="secondary"
          >
            Next
          </Button>
        </nav>
      ) : null}
    </section>
  );
}
