import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./contexts/AuthContext";
import { GameProvider } from "./contexts/GameContext";
import { DevNav } from "./components/ui/DevNav";
import { GamePhaseListener } from "./components/GamePhaseListener";
import { LandingPage } from "./pages/LandingPage";
import { TeamPage } from "./pages/TeamPage";
import { LobbyPage } from "./pages/LobbyPage";
import { GamePage } from "./pages/GamePage";
import { AuctionPage } from "./pages/AuctionPage";
import { LeaderboardPage } from "./pages/LeaderboardPage";
import { ProfessorPage } from "./pages/ProfessorPage";
import { ProfessorLeaderboardPage } from "./pages/ProfessorLeaderboardPage";
import { EmailPhasePage } from "./pages/EmailPhasePage";
import { RosterPhasePage } from "./pages/RosterPhasePage";
import { ConclusionPage } from "./pages/ConclusionPage";

export default function App() {
  return (
    <AuthProvider>
      <GameProvider>
        <BrowserRouter>
          <DevNav />
          <GamePhaseListener />
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/team" element={<TeamPage />} />
            <Route path="/lobby" element={<LobbyPage />} />
            <Route path="/game" element={<GamePage />} />
            <Route path="/game/email" element={<EmailPhasePage />} />
            <Route path="/game/roster" element={<RosterPhasePage />} />
            <Route path="/game/conclusion" element={<ConclusionPage />} />
            <Route path="/game/:phase" element={<GamePage />} />
            <Route path="/auction" element={<AuctionPage />} />
            <Route path="/leaderboard" element={<LeaderboardPage />} />
            <Route path="/professor" element={<ProfessorPage />} />
            <Route
              path="/professor/leaderboard"
              element={<ProfessorLeaderboardPage />}
            />
          </Routes>
        </BrowserRouter>
      </GameProvider>
    </AuthProvider>
  );
}
