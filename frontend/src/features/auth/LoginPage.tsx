import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';

import BrandMark from '../../components/branding/BrandMark';
import Button from '../../components/ui/Button';
import Notice from '../../components/ui/Notice';
import { isDemoSessionEntryEnabled } from '../../config/demoSession';
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

function demoOutcomeMessage(outcome: AuthActionOutcome): string {
  switch (outcome.kind) {
    case 'rate-limited':
      return 'Too many demo requests. Try again later.';
    case 'service-unavailable':
    case 'session-unavailable':
      return 'The admin demo is temporarily unavailable.';
    case 'timeout':
      return 'The admin demo timed out. Try again.';
    case 'network':
      return 'Could not start the admin demo. Check your connection.';
    case 'aborted':
      return 'The admin demo request was cancelled.';
    case 'invalid-response':
    case 'account-exists':
    case 'invalid-credentials':
    case 'validation':
      return 'Could not start the admin demo. Try again later.';
    case 'authenticated':
      return '';
  }
}

/** Render the role-neutral Nordic Hearth sign-in experience. */
export default function LoginPage() {
  const { login, logout, phase, retrySession, startDemoSession, user } = useAuth();
  const [searchParams] = useSearchParams();
  const demoSessionEntryEnabled = isDemoSessionEntryEnabled();
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const submitButtonRef = useRef<HTMLButtonElement>(null);
  const demoButtonRef = useRef<HTMLButtonElement>(null);
  const demoRequestActiveRef = useRef(false);
  const restoreSubmitFocusRef = useRef(false);
  const restoreDemoFocusRef = useRef(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<LoginErrors>({});
  const [feedback, setFeedback] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [demoSubmitting, setDemoSubmitting] = useState(false);
  const [demoNavigationRequested, setDemoNavigationRequested] = useState(false);
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
    if (demoSubmitting || !restoreDemoFocusRef.current) {
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

    demoButtonRef.current?.focus();
    restoreDemoFocusRef.current = false;
  }, [demoRetrySeconds, demoSubmitting]);

  if (phase === 'authenticated' && user !== null) {
    const next = demoNavigationRequested ? '/admin' : searchParams.get('next');
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
    if (submitting || demoSubmitting || retrySeconds > 0) {
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
    setDemoNavigationRequested(false);
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

  const handleDemoSession = async () => {
    if (
      !demoSessionEntryEnabled ||
      demoRequestActiveRef.current ||
      submitting ||
      demoRetrySeconds > 0
    ) {
      return;
    }

    demoRequestActiveRef.current = true;
    setDemoNavigationRequested(true);
    restoreDemoFocusRef.current = document.activeElement === demoButtonRef.current;
    setDemoSubmitting(true);
    setFeedback('Starting the admin demo and validating its session…');
    try {
      const outcome = await startDemoSession();
      if (outcome.kind === 'authenticated') {
        return;
      }
      if (outcome.kind === 'rate-limited') {
        setDemoRetrySeconds(outcome.retryAfterSeconds ?? 0);
      }
      if (outcome.kind !== 'session-unavailable') {
        setDemoNavigationRequested(false);
      }
      setFeedback(demoOutcomeMessage(outcome));
    } finally {
      demoRequestActiveRef.current = false;
      setDemoSubmitting(false);
    }
  };

  const retryLabel =
    retrySeconds > 0 ? `Try again in ${retrySeconds} seconds` : 'Sign in';
  const demoRetryLabel =
    demoRetrySeconds > 0
      ? `Try admin demo in ${demoRetrySeconds} seconds`
      : 'Try admin demo';
  const next = searchParams.get('next');
  const registerDestination =
    next === null ? '/register' : `/register?next=${encodeURIComponent(next)}`;

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
          aria-busy={submitting || demoSubmitting}
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
            disabled={demoSubmitting || retrySeconds > 0}
            loading={submitting}
            loadingLabel="Signing in"
            size="lg"
          >
            {retryLabel}
          </Button>
          {demoSessionEntryEnabled ? (
            <div className={styles.demoAccess}>
              <div className={styles.demoDivider} aria-hidden="true">
                <span>or</span>
              </div>
              <p className={styles.demoGuidance}>
                Explore the administrator workspace with shared synthetic data.
              </p>
              <Button
                ref={demoButtonRef}
                className={styles.demoButton}
                type="button"
                disabled={submitting || demoRetrySeconds > 0}
                loading={demoSubmitting}
                loadingLabel="Starting admin demo"
                size="lg"
                variant="secondary"
                onClick={() => void handleDemoSession()}
              >
                {demoRetryLabel}
              </Button>
            </div>
          ) : null}
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
