# Bakery Bash

Competitive bakery simulation. Players run competing bakeries in a shared plaza, making strategic decisions about pricing, advertising, hiring, and menu items. Revenue is the target variable. Best strategy wins.

**Status:** In Development

---

## Firebase Emulator Setup

All development should be done against the local Firebase emulator — not the live project. This avoids burning through free tier quota and lets the whole team work offline.

### Prerequisites

Install the Firebase CLI if you haven't already:

```bash
npm install -g firebase-tools
firebase login
```

Install the emulator suite (one-time):

```bash
firebase emulators:install
```

### Running the emulators

From the `games/bakery-bash/` directory:

```bash
firebase emulators:start --project bakery-bash-54d12
```

This starts the following emulators:

| Service    | Port |
|------------|------|
| Auth       | 9099 |
| Firestore  | 8080 |
| Functions  | 5001 |
| Hosting    | 5000 |
| Emulator UI| 4000 |

Open [http://localhost:4000](http://localhost:4000) in your browser to see the Emulator UI — you can inspect Firestore documents, Auth users, and Function logs in real time.

### Pointing your app at the emulators

In your app's entry point (e.g. `index.jsx`), add the following after initializing Firebase:

```js
import { connectFirestoreEmulator } from "firebase/firestore";
import { connectAuthEmulator } from "firebase/auth";
import { db, auth } from "./firebase";

if (import.meta.env.MODE === "development") {
  connectFirestoreEmulator(db, "localhost", 8080);
  connectAuthEmulator(auth, "http://localhost:9099");
}
```

### Testing security rules

Run the rules test suite against the emulator:

```bash
firebase emulators:exec --only firestore "npm test"
```

Or start the emulator and run tests separately:

```bash
# Terminal 1
firebase emulators:start --only firestore

# Terminal 2
npm test
```

---

## Security Rules Summary

See `firestore.rules` for the full rules. The policy is:

- **Players** can read/write only their own player document (`/games/{gameId}/players/{uid}`), and only the `displayName`, `pendingDecision`, and `pendingBids` fields. Financial state is Cloud Functions only.
- **Game state** (`/games/{gameId}`) is read-only for players. Phase transitions are Cloud Functions only.
- **Leaderboard** (`/games/{gameId}/leaderboard`) is read-only for all authenticated players.
- **Aggregate rounds** (`/games/{gameId}/rounds/{roundId}`) are read-only for all authenticated players.
- **CSV rows** are readable only by the player they belong to.
- **Decisions** can be created once per round but never updated or deleted.
