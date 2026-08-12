import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';

import { useAdminAuth, type AdminLoginOutcome } from './AdminAuthContext';
import styles from './AdminLoginPage.module.css';

interface LoginErrors {
  email?: string;
  password?: string;
}

interface LoginLocationState {
  returnTo?: unknown;
}

function isPlausibleEmail(value: string): boolean {
  const trimmed = value.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

function passwordCodePointLength(value: string): number {
  return Array.from(value).length;
}

function safeReturnTarget(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/admin/') ||
    value.startsWith('//') ||
    value === '/admin/login' ||
    value.startsWith('/admin/login?') ||
    value.includes('://') ||
    value.includes('\\')
  ) {
    return '/admin';
  }
  return value;
}

function outcomeMessage(outcome: AdminLoginOutcome): string {
  switch (outcome.kind) {
    case 'invalid-credentials':
      return 'The email or password is incorrect.';
    case 'service-unavailable':
      return 'The authentication service is temporarily unavailable. Try again.';
    case 'session-unavailable':
      return 'Your credentials were accepted, but session validation is temporarily unavailable.';
    case 'timeout':
      return 'The sign-in request timed out. Check your connection and try again.';
    case 'network':
      return 'Sign-in could not reach the authentication service. Try again.';
    case 'invalid-response':
      return 'The authentication service returned an invalid response. Try again later.';
    case 'aborted':
      return 'The sign-in request was cancelled.';
    case 'rate-limited':
      return 'Too many sign-in attempts. Try again later.';
    case 'authenticated':
      return '';
  }
}

export default function AdminLoginPage() {
  const { phase, login, logout, retrySessionValidation } = useAdminAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<LoginErrors>({});
  const [feedback, setFeedback] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [retrySeconds, setRetrySeconds] = useState(0);

  useEffect(() => {
    if (retrySeconds <= 0) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      setRetrySeconds((current) => Math.max(0, current - 1));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [retrySeconds]);

  if (phase === 'authenticated') {
    const state = location.state as LoginLocationState | null;
    return <Navigate to={safeReturnTarget(state?.returnTo)} replace />;
  }

  if (phase === 'checking-session') {
    return (
      <main className={styles.screen}>
        <section className={styles.panel} role="status" aria-live="polite">
          <p className="eyebrow">Administrator access</p>
          <h1>Checking your session</h1>
          <p className={styles.intro}>Please wait before signing in again.</p>
        </section>
      </main>
    );
  }

  if (phase === 'temporarily-unavailable') {
    return (
      <main className={styles.screen}>
        <section className={styles.panel} role="alert" aria-live="assertive">
          <p className="eyebrow">Administrator access</p>
          <h1>Session validation is unavailable</h1>
          <p className={styles.intro}>
            The saved administrator session remains available for another validation
            attempt.
          </p>
          <div className={styles.actions}>
            <button
              className={styles.secondaryButton}
              type="button"
              onClick={() => void retrySessionValidation()}
            >
              Retry validation
            </button>
            <button className={styles.secondaryButton} type="button" onClick={logout}>
              Clear session
            </button>
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
    const passwordLength = passwordCodePointLength(password);
    if (passwordLength === 0) {
      nextErrors.password = 'Password is required.';
    } else if (passwordLength > 128) {
      nextErrors.password = 'Password must contain at most 128 characters.';
    }
    return nextErrors;
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || retrySeconds > 0) {
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

    setSubmitting(true);
    setFeedback('Signing in and validating your session…');
    const outcome = await login(email, password);
    setSubmitting(false);
    if (outcome.kind === 'authenticated') {
      setPassword('');
      const state = location.state as LoginLocationState | null;
      navigate(safeReturnTarget(state?.returnTo), { replace: true });
      return;
    }
    if (outcome.kind === 'rate-limited') {
      setRetrySeconds(outcome.retryAfterSeconds ?? 0);
    }
    setFeedback(outcomeMessage(outcome));
  };

  const retryLabel =
    retrySeconds > 0 ? `Try again in ${retrySeconds} seconds` : 'Sign in';

  return (
    <main className={styles.screen}>
      <section className={styles.panel} aria-labelledby="admin-login-heading">
        <div>
          <p className="eyebrow">Restaurant administration</p>
          <h1 id="admin-login-heading">Administrator sign-in</h1>
        </div>
        <p className={styles.intro}>Use an authorized administrator account.</p>
        <form
          className={styles.form}
          noValidate
          onSubmit={(event) => void handleSubmit(event)}
        >
          <div className={styles.field}>
            <label htmlFor="admin-email">Email</label>
            <input
              ref={emailRef}
              id="admin-email"
              type="email"
              autoComplete="username"
              value={email}
              aria-describedby={
                errors.email === undefined ? undefined : 'admin-email-error'
              }
              aria-invalid={errors.email !== undefined}
              onChange={(event) => setEmail(event.target.value)}
            />
            {errors.email !== undefined ? (
              <p id="admin-email-error" className={styles.fieldError}>
                {errors.email}
              </p>
            ) : null}
          </div>
          <div className={styles.field}>
            <label htmlFor="admin-password">Password</label>
            <input
              ref={passwordRef}
              id="admin-password"
              type="password"
              autoComplete="current-password"
              value={password}
              aria-describedby={
                errors.password === undefined ? undefined : 'admin-password-error'
              }
              aria-invalid={errors.password !== undefined}
              onChange={(event) => setPassword(event.target.value)}
            />
            {errors.password !== undefined ? (
              <p id="admin-password-error" className={styles.fieldError}>
                {errors.password}
              </p>
            ) : null}
          </div>
          {feedback !== '' ? (
            <p
              className={
                feedback.startsWith('Signing')
                  ? styles.statusNotice
                  : styles.errorNotice
              }
              role={feedback.startsWith('Signing') ? 'status' : 'alert'}
              aria-live={feedback.startsWith('Signing') ? 'polite' : 'assertive'}
            >
              {feedback}
            </p>
          ) : null}
          <button
            className={styles.submitButton}
            type="submit"
            disabled={submitting || retrySeconds > 0}
          >
            {submitting ? 'Signing in…' : retryLabel}
          </button>
        </form>
      </section>
    </main>
  );
}
