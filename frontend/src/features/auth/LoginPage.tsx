import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';

import BrandMark from '../../components/branding/BrandMark';
import Button from '../../components/ui/Button';
import Notice from '../../components/ui/Notice';
import { isCustomerDemoSessionEntryEnabled } from '../../config/customerDemoSession';
import { isDemoSessionEntryEnabled } from '../../config/demoSession';
import { isPortfolioModeEnabled } from '../../config/portfolioMode';
import { useAuth, type AuthActionOutcome } from './AuthContext';
import {
  isAdminContinuation,
  parseSafeNext,
  resolveAuthDestination,
} from './authNavigation';
import styles from './AuthPage.module.css';

interface LoginErrors {
  email?: string;
  password?: string;
}

function AuthBrand() {
  return (
    <div className={styles.brand}>
      <BrandMark className={styles.brandMark} size={24} />
      <span>Nordic Hearth</span>
    </div>
  );
}

function isPlausibleEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function outcomeMessage(outcome: AuthActionOutcome): string {
  switch (outcome.kind) {
    case 'invalid-credentials':
      return 'The email or password is incorrect.';
    case 'rate-limited':
      return 'Too many sign-in attempts. Try again later.';
    case 'service-unavailable':
    case 'session-unavailable':
      return 'Sign-in is temporarily unavailable. Try again.';
    case 'timeout':
      return 'The sign-in request timed out. Check your connection and try again.';
    case 'network':
      return 'We could not sign you in. Check your connection and try again.';
    case 'invalid-response':
      return 'We could not complete sign-in. Try again later.';
    case 'aborted':
      return 'The sign-in request was cancelled.';
    case 'account-exists':
    case 'validation':
      return 'We could not sign you in with those details.';
    case 'authenticated':
      return '';
  }
}

function demoOutcomeMessage(
  outcome: AuthActionOutcome,
  demoLabel: 'admin' | 'customer',
): string {
  const label = `${demoLabel} demo`;
  switch (outcome.kind) {
    case 'rate-limited':
      return 'Too many demo requests. Try again later.';
    case 'service-unavailable':
    case 'session-unavailable':
      return `The ${label} is temporarily unavailable.`;
    case 'timeout':
      return `The ${label} timed out. Try again.`;
    case 'network':
      return `Could not start the ${label}. Check your connection.`;
    case 'aborted':
      return `The ${label} request was cancelled.`;
    case 'invalid-response':
    case 'account-exists':
    case 'invalid-credentials':
    case 'validation':
      return `Could not start the ${label}. Try again later.`;
    case 'authenticated':
      return '';
  }
}

/** Render the role-neutral Nordic Hearth sign-in experience. */
export default function LoginPage() {
  const {
    login,
    logout,
    phase,
    retrySession,
    startCustomerDemoSession,
    startDemoSession,
    user,
  } = useAuth();
  const [searchParams] = useSearchParams();
  const demoSessionEntryEnabled = isDemoSessionEntryEnabled();
  const customerDemoSessionEntryEnabled = isCustomerDemoSessionEntryEnabled();
  const portfolioModeEnabled = isPortfolioModeEnabled();
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const submitButtonRef = useRef<HTMLButtonElement>(null);
  const demoButtonRef = useRef<HTMLButtonElement>(null);
  const customerDemoButtonRef = useRef<HTMLButtonElement>(null);
  const demoRequestActiveRef = useRef(false);
  const demoFocusTargetRef = useRef<'admin' | 'customer'>('admin');
  const restoreSubmitFocusRef = useRef(false);
  const restoreDemoFocusRef = useRef(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<LoginErrors>({});
  const [feedback, setFeedback] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [demoSubmitting, setDemoSubmitting] = useState(false);
  const [customerDemoSubmitting, setCustomerDemoSubmitting] = useState(false);
  const [demoNavigationTarget, setDemoNavigationTarget] = useState<
    'admin' | 'customer' | null
  >(null);
  const [retrySeconds, setRetrySeconds] = useState(0);
  const [demoRetrySeconds, setDemoRetrySeconds] = useState(0);
  const [passwordVisible, setPasswordVisible] = useState(false);

  useEffect(() => {
    if (retrySeconds <= 0) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      setRetrySeconds((current) => Math.max(0, current - 1));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [retrySeconds]);

  useEffect(() => {
    if (demoRetrySeconds <= 0) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      setDemoRetrySeconds((current) => Math.max(0, current - 1));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [demoRetrySeconds]);

  useEffect(() => {
    if (submitting || !restoreSubmitFocusRef.current) {
      return;
    }

    const activeElement = document.activeElement;
    if (activeElement !== null && activeElement !== document.body) {
      restoreSubmitFocusRef.current = false;
      return;
    }
    if (retrySeconds > 0) {
      return;
    }

    submitButtonRef.current?.focus();
    restoreSubmitFocusRef.current = false;
  }, [retrySeconds, submitting]);

  useEffect(() => {
    if (demoSubmitting || customerDemoSubmitting || !restoreDemoFocusRef.current) {
      return;
    }

    const activeElement = document.activeElement;
    if (activeElement !== null && activeElement !== document.body) {
      restoreDemoFocusRef.current = false;
      return;
    }
    if (demoRetrySeconds > 0) {
      return;
    }

    if (demoFocusTargetRef.current === 'customer') {
      customerDemoButtonRef.current?.focus();
    } else {
      demoButtonRef.current?.focus();
    }
    restoreDemoFocusRef.current = false;
  }, [customerDemoSubmitting, demoRetrySeconds, demoSubmitting]);

  if (phase === 'authenticated' && user !== null) {
    const next =
      demoNavigationTarget === 'admin'
        ? '/admin'
        : demoNavigationTarget === 'customer'
          ? '/account'
          : searchParams.get('next');
    const safeNext = parseSafeNext(next);
    const denied =
      user.role === 'customer' && safeNext !== null && isAdminContinuation(safeNext);
    return (
      <Navigate
        to={resolveAuthDestination(next, user.role)}
        replace
        state={denied ? { accessDenied: 'administrator' } : undefined}
      />
    );
  }

  if (phase === 'checking-session') {
    return (
      <main className={styles.screen}>
        <section className={styles.panel} role="status" aria-live="polite">
          <AuthBrand />
          <div className={styles.heading}>
            <p className="eyebrow">Account access</p>
            <h1>Checking your session</h1>
          </div>
          <p className={styles.intro}>Please wait before signing in again.</p>
        </section>
      </main>
    );
  }

  if (phase === 'temporarily-unavailable') {
    return (
      <main className={styles.screen}>
        <section className={styles.panel} role="alert" aria-live="assertive">
          <AuthBrand />
          <div className={styles.heading}>
            <p className="eyebrow">Account access</p>
            <h1>Session validation is unavailable</h1>
          </div>
          <p className={styles.intro}>
            Your saved session remains available for another validation attempt.
          </p>
          <div className={styles.actions}>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void retrySession()}
            >
              Retry validation
            </Button>
            <Button type="button" variant="ghost" onClick={logout}>
              Clear session
            </Button>
          </div>
        </section>
      </main>
    );
  }

  const validate = (): LoginErrors => {
    const nextErrors: LoginErrors = {};
    if (email.trim() === '') {
      nextErrors.email = 'Email is required.';
    } else if (!isPlausibleEmail(email)) {
      nextErrors.email = 'Enter a valid email address.';
    }
    const passwordLength = Array.from(password).length;
    if (passwordLength === 0) {
      nextErrors.password = 'Password is required.';
    } else if (passwordLength > 128) {
      nextErrors.password = 'Password must contain at most 128 characters.';
    }
    return nextErrors;
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || demoSubmitting || customerDemoSubmitting || retrySeconds > 0) {
      return;
    }
    const nextErrors = validate();
    setErrors(nextErrors);
    setFeedback('');
    if (nextErrors.email !== undefined) {
      emailRef.current?.focus();
      return;
    }
    if (nextErrors.password !== undefined) {
      passwordRef.current?.focus();
      return;
    }

    restoreSubmitFocusRef.current = document.activeElement === submitButtonRef.current;
    setDemoNavigationTarget(null);
    setSubmitting(true);
    setFeedback('Signing in and validating your session…');
    const outcome = await login(email, password);
    setSubmitting(false);
    if (outcome.kind === 'authenticated') {
      setPassword('');
      return;
    }
    if (outcome.kind === 'rate-limited') {
      setRetrySeconds(outcome.retryAfterSeconds ?? 0);
    }
    setFeedback(outcomeMessage(outcome));
  };

  const handleDemoSession = async (demoKind: 'admin' | 'customer') => {
    const enabled =
      demoKind === 'admin' ? demoSessionEntryEnabled : customerDemoSessionEntryEnabled;
    if (
      !enabled ||
      demoRequestActiveRef.current ||
      submitting ||
      demoRetrySeconds > 0
    ) {
      return;
    }

    demoRequestActiveRef.current = true;
    demoFocusTargetRef.current = demoKind;
    setDemoNavigationTarget(demoKind);
    restoreDemoFocusRef.current =
      document.activeElement ===
      (demoKind === 'admin' ? demoButtonRef.current : customerDemoButtonRef.current);
    if (demoKind === 'admin') {
      setDemoSubmitting(true);
    } else {
      setCustomerDemoSubmitting(true);
    }
    setFeedback(`Starting the ${demoKind} demo and validating its session…`);
    try {
      const outcome =
        demoKind === 'admin'
          ? await startDemoSession()
          : await startCustomerDemoSession();
      if (outcome.kind === 'authenticated') {
        return;
      }
      if (outcome.kind === 'rate-limited') {
        setDemoRetrySeconds(outcome.retryAfterSeconds ?? 0);
      }
      if (outcome.kind !== 'session-unavailable') {
        setDemoNavigationTarget(null);
      }
      setFeedback(demoOutcomeMessage(outcome, demoKind));
    } finally {
      demoRequestActiveRef.current = false;
      if (demoKind === 'admin') {
        setDemoSubmitting(false);
      } else {
        setCustomerDemoSubmitting(false);
      }
    }
  };

  const retryLabel =
    retrySeconds > 0 ? `Try again in ${retrySeconds} seconds` : 'Sign in';
  const demoRetryLabel =
    demoRetrySeconds > 0
      ? `Try admin demo in ${demoRetrySeconds} seconds`
      : 'Try admin demo';
  const customerDemoRetryLabel =
    demoRetrySeconds > 0
      ? `Try customer demo in ${demoRetrySeconds} seconds`
      : 'Try customer demo';
  const demoSessionAccess = demoSessionEntryEnabled ? (
    <div className={styles.demoAccess}>
      {!portfolioModeEnabled ? (
        <div className={styles.demoDivider} aria-hidden="true">
          <span>or</span>
        </div>
      ) : null}
      <p className={styles.demoGuidance}>
        Explore the administrator workspace with shared synthetic data.
      </p>
      <Button
        ref={demoButtonRef}
        className={styles.demoButton}
        type="button"
        disabled={submitting || customerDemoSubmitting || demoRetrySeconds > 0}
        loading={demoSubmitting}
        loadingLabel="Starting admin demo"
        size="lg"
        variant="secondary"
        onClick={() => void handleDemoSession('admin')}
      >
        {demoRetryLabel}
      </Button>
    </div>
  ) : null;
  const customerDemoSessionAccess = customerDemoSessionEntryEnabled ? (
    <div className={styles.demoAccess}>
      <p className={styles.demoGuidance}>
        Explore a shared synthetic customer account and its order history. Other demo
        visitors may see the same account activity.
      </p>
      <Button
        ref={customerDemoButtonRef}
        className={styles.demoButton}
        type="button"
        disabled={submitting || demoSubmitting || demoRetrySeconds > 0}
        loading={customerDemoSubmitting}
        loadingLabel="Starting customer demo"
        size="lg"
        variant="secondary"
        onClick={() => void handleDemoSession('customer')}
      >
        {customerDemoRetryLabel}
      </Button>
    </div>
  ) : null;
  const next = searchParams.get('next');
  const registerDestination =
    next === null ? '/register' : `/register?next=${encodeURIComponent(next)}`;

  if (portfolioModeEnabled) {
    return (
      <main className={styles.screen}>
        <section className={styles.panel} aria-labelledby="portfolio-login-heading">
          <AuthBrand />
          <div className={styles.heading}>
            <p className="eyebrow">Portfolio access</p>
            <h1 id="portfolio-login-heading">
              {demoSessionEntryEnabled || customerDemoSessionEntryEnabled
                ? 'Choose a portfolio demo path'
                : 'Account access is unavailable'}
            </h1>
          </div>
          <p className={styles.intro}>
            {demoSessionEntryEnabled || customerDemoSessionEntryEnabled
              ? 'Start a temporary shared session without a password, or browse and order as a guest.'
              : 'Password sign-in is not available in this portfolio experience.'}
          </p>
          <div className={styles.demoAccess}>
            <p className={styles.demoGuidance}>
              Guest checkout uses a private order link for this browser and does not
              create an account.
            </p>
            <Link className={styles.backLink} to="/menu">
              Continue as guest
            </Link>
          </div>
          {customerDemoSessionAccess}
          {demoSessionAccess}
          <p className={styles.guidance}>
            The free demo service may need a short wake-up before the first request
            completes.
          </p>
          <Link className={styles.backLink} to="/menu">
            Back to Menu
          </Link>
          <div className={styles.feedbackSlot}>
            {feedback !== '' ? (
              <Notice
                className={styles.feedbackNotice}
                role={feedback.startsWith('Starting') ? 'status' : 'alert'}
                variant={feedback.startsWith('Starting') ? 'info' : 'danger'}
              >
                {feedback}
              </Notice>
            ) : null}
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className={styles.screen}>
      <section className={styles.panel} aria-labelledby="login-heading">
        <AuthBrand />
        <div className={styles.heading}>
          <p className="eyebrow">Account access</p>
          <h1 id="login-heading">Sign in</h1>
        </div>
        <p className={styles.intro}>Use your customer or administrator account.</p>
        <form
          aria-busy={submitting || demoSubmitting || customerDemoSubmitting}
          className={styles.form}
          noValidate
          onSubmit={(event) => void handleSubmit(event)}
        >
          <div className={styles.field}>
            <label htmlFor="login-email">Email</label>
            <input
              ref={emailRef}
              id="login-email"
              type="email"
              autoComplete="username"
              value={email}
              aria-describedby={
                errors.email === undefined ? undefined : 'login-email-error'
              }
              aria-invalid={errors.email !== undefined}
              onChange={(event) => setEmail(event.target.value)}
            />
            <div className={styles.fieldMessage}>
              {errors.email !== undefined ? (
                <p id="login-email-error" className={styles.fieldError}>
                  {errors.email}
                </p>
              ) : null}
            </div>
          </div>
          <div className={styles.field}>
            <label htmlFor="login-password">Password</label>
            <div className={styles.passwordControl}>
              <input
                ref={passwordRef}
                id="login-password"
                type={passwordVisible ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                aria-describedby={
                  errors.password === undefined ? undefined : 'login-password-error'
                }
                aria-invalid={errors.password !== undefined}
                onChange={(event) => setPassword(event.target.value)}
              />
              <button
                aria-controls="login-password"
                aria-label={passwordVisible ? 'Hide password' : 'Show password'}
                aria-pressed={passwordVisible}
                className={styles.passwordToggle}
                type="button"
                onClick={() => setPasswordVisible((visible) => !visible)}
              >
                {passwordVisible ? 'Hide' : 'Show'}
              </button>
            </div>
            <div className={styles.fieldMessage}>
              {errors.password !== undefined ? (
                <p id="login-password-error" className={styles.fieldError}>
                  {errors.password}
                </p>
              ) : null}
            </div>
          </div>
          <Button
            ref={submitButtonRef}
            className={styles.submitButton}
            type="submit"
            disabled={demoSubmitting || customerDemoSubmitting || retrySeconds > 0}
            loading={submitting}
            loadingLabel="Signing in"
            size="lg"
          >
            {retryLabel}
          </Button>
          {demoSessionAccess}
          <p className={styles.authSwitch}>
            New here?{' '}
            <Link className={styles.inlineLink} to={registerDestination}>
              Create an account
            </Link>
          </p>
          <Link className={styles.backLink} to="/">
            ← Back to home
          </Link>
          <div className={styles.feedbackSlot}>
            {feedback !== '' ? (
              <Notice
                className={styles.feedbackNotice}
                role={
                  feedback.startsWith('Signing') || feedback.startsWith('Starting')
                    ? 'status'
                    : 'alert'
                }
                variant={
                  feedback.startsWith('Signing') || feedback.startsWith('Starting')
                    ? 'info'
                    : 'danger'
                }
              >
                {feedback}
              </Notice>
            ) : null}
          </div>
        </form>
      </section>
    </main>
  );
}
