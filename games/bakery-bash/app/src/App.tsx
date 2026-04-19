import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./contexts/AuthContext";
import { GameProvider } from "./contexts/GameContext";
import { DevNav } from "./components/ui/DevNav";
import { LandingPage } from "./pages/LandingPage";
import { TeamPage } from "./pages/TeamPage";
import { LobbyPage } from "./pages/LobbyPage";
import { GamePage } from "./pages/GamePage";
import { AuctionPage } from "./pages/AuctionPage";
import { LeaderboardPage } from "./pages/LeaderboardPage";
import { ProfessorPage } from "./pages/ProfessorPage";

export default function App() {
  return (
    <AuthProvider>
      <GameProvider>
        <BrowserRouter>
          <DevNav />
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/team" element={<TeamPage />} />
            <Route path="/lobby" element={<LobbyPage />} />
            <Route path="/game" element={<GamePage />} />
            <Route path="/game/:phase" element={<GamePage />} />
            <Route path="/auction" element={<AuctionPage />} />
            <Route path="/leaderboard" element={<LeaderboardPage />} />
            <Route path="/professor" element={<ProfessorPage />} />
          </Routes>
        </BrowserRouter>
      </GameProvider>
    </AuthProvider>
  );
}
