import Link from "next/link";

export default function NotFound() {
  return (
    <main className="centered-page">
      <div className="error-panel">
        <p className="eyebrow">404</p>
        <h1>That page does not exist.</h1>
        <Link className="button-primary" href="/">
          Back to Trellis
        </Link>
      </div>
    </main>
  );
}
