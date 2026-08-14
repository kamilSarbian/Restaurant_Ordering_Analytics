import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';

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
      return 'The authentication service is temporarily unavailable. Try again.';
    case 'timeout':
      return 'The sign-in request timed out. Check your connection and try again.';
    case 'network':
      return 'Sign-in could not reach the authentication service. Try again.';
    case 'invalid-response':
      return 'The authentication service returned an invalid response. Try again later.';
    case 'aborted':
      return 'The sign-in request was cancelled.';
    case 'account-exists':
    case 'validation':
      return 'The sign-in request was not valid.';
    case 'authenticated':
      return '';
  }
}

export default function LoginPage() {
  const { login, logout, phase, retrySession, user } = useAuth();
  const [searchParams] = useSearchParams();
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

  if (phase === 'authenticated' && user !== null) {
    const next = searchParams.get('next');
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
          <p className="eyebrow">Account access</p>
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
          <p className="eyebrow">Account access</p>
          <h1>Session validation is unavailable</h1>
          <p className={styles.intro}>
            Your saved session remains available for another validation attempt.
          </p>
          <div className={styles.actions}>
            <button
              className={styles.secondaryButton}
              type="button"
              onClick={() => void retrySession()}
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
      <section className={styles.panel} aria-labelledby="login-heading">
        <div>
          <p className="eyebrow">Account access</p>
          <h1 id="login-heading">Sign in</h1>
        </div>
        <p className={styles.intro}>Use your customer or administrator account.</p>
        <form
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
            {errors.email !== undefined ? (
              <p id="login-email-error" className={styles.fieldError}>
                {errors.email}
              </p>
            ) : null}
          </div>
          <div className={styles.field}>
            <label htmlFor="login-password">Password</label>
            <input
              ref={passwordRef}
              id="login-password"
              type="password"
              autoComplete="current-password"
              value={password}
              aria-describedby={
                errors.password === undefined ? undefined : 'login-password-error'
              }
              aria-invalid={errors.password !== undefined}
              onChange={(event) => setPassword(event.target.value)}
            />
            {errors.password !== undefined ? (
              <p id="login-password-error" className={styles.fieldError}>
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
          <Link className={styles.backLink} to="/">
            ← Back to home
          </Link>
        </form>
      </section>
    </main>
  );
}
