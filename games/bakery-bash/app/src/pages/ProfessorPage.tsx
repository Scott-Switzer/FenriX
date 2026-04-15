import { PageShell } from "../components/ui/PageShell";

export function ProfessorPage() {
  return (
    <PageShell className="professor-page">
      <h1 className="professor-page__title">Professor Control Panel</h1>

      <div className="professor-page__controls">
        <button className="btn btn--primary" disabled>
          Start Game
        </button>
        <button className="btn btn--secondary" disabled>
          Advance Round
        </button>
        <button className="btn btn--secondary" disabled>
          Pause / Resume
        </button>
        <button className="btn btn--danger" disabled>
          End Game
        </button>
      </div>

      <p className="professor-page__note">
        Professor controls will be connected to Firestore once the backend is
        ready.
      </p>
    </PageShell>
  );
}
