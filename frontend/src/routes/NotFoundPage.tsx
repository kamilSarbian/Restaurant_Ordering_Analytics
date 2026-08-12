import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <section className="not-found" aria-labelledby="not-found-heading">
      <p className="eyebrow">404</p>
      <h1 id="not-found-heading">Page not found</h1>
      <p>The page you requested does not exist.</p>
      <Link className="action-link" to="/">
        Back to ordering
      </Link>
    </section>
  );
}
