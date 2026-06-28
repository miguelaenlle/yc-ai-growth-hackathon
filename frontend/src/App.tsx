// Placeholder shell only — the real CallTree UI (Browse / Review / Mock / Live)
// is intentionally NOT built yet. This page just confirms the toolchain
// (Vite + React + Tailwind) and the libraries we'll build on are wired up.

const LIBS = [
  ['react-router-dom', 'routing across Browse / Review / Mock / Live'],
  ['@xyflow/react', 'the decision-tree canvas'],
  ['@tanstack/react-query', 'fetching + caching the CallTree API'],
  ['axios', 'HTTP client'],
  ['zustand', 'live-session client state'],
  ['tailwindcss', 'styling'],
] as const

function App() {
  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 flex items-center justify-center p-8">
      <div className="max-w-xl w-full space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">
            CallTree <span className="text-emerald-400">·</span>{' '}
            <span className="text-neutral-400 font-normal">frontend scaffold</span>
          </h1>
          <p className="text-neutral-400 text-sm">
            Toolchain is up. The actual UI has not been started — this is a
            placeholder. The backend contract lives at{' '}
            <code className="text-emerald-300">http://localhost:3001</code>.
          </p>
        </header>

        <section className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-5">
          <h2 className="text-xs uppercase tracking-wider text-neutral-500 mb-3">
            Installed libraries
          </h2>
          <ul className="space-y-2">
            {LIBS.map(([name, why]) => (
              <li key={name} className="flex items-baseline gap-3 text-sm">
                <code className="text-emerald-300 shrink-0">{name}</code>
                <span className="text-neutral-500">{why}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  )
}

export default App
