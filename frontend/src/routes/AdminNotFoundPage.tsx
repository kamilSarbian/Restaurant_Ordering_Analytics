import { Link } from 'react-router-dom';

export default function AdminNotFoundPage() {
  return (
    <section className="not-found" aria-labelledby="admin-not-found-heading">
      <p className="eyebrow">Administrator workspace</p>
      <h1 id="admin-not-found-heading">Administrator page not found</h1>
      <p>The requested administrator page is not available.</p>
      <Link className="action-link" to="/admin">
        Back to admin home
      </Link>
    </section>
  );
}
