import { Link } from "react-router-dom";
import { Logo } from "../components/Logo";

/** Minimal stub for routes not yet built (Take new call, call review). Keeps
    navigation real without overbuilding screens outside this page's scope. */
export function Placeholder({ title }: { title: string }) {
  return (
    <main className="min-h-screen bg-bg text-text">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <Link to="/" className="inline-block animate-fade-up">
          <Logo />
        </Link>
        <div className="mt-16 animate-fade-up text-center">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-2 text-sm text-text-muted">Coming soon.</p>
          <Link
            to="/"
            className="mt-6 inline-block font-mono text-xs text-accent hover:brightness-110"
          >
            ← Back to Past Calls
          </Link>
        </div>
      </div>
    </main>
  );
}
