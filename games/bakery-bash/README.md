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

The Firestore emulator requires Java. If Java was installed through Homebrew,
run Firebase emulator commands with OpenJDK on your path:

```bash
PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:rules
```

To make that permanent for future terminals:

```bash
echo 'export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"' >> ~/.zshrc
```

### Running the emulators

From the `games/bakery-bash/backend/` directory:

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

### Firebase project link

The backend folder is linked to Firebase project `bakery-bash-54d12` through `backend/.firebaserc`.

Deploy backend resources from `games/bakery-bash/backend/`:

```bash
firebase deploy --only firestore:rules,functions --project bakery-bash-54d12
```

Anonymous Authentication must also be enabled in Firebase Console before deployed clients can sign in anonymously:

```text
Authentication -> Sign-in method -> Anonymous -> Enable
```

### Auth/player login flow

See `backend/AUTH_PLAYER_FLOW.md` for the shared backend/frontend contract.

The short version:

1. Frontend signs in anonymously with Firebase Auth.
2. Firebase provides a persistent `uid`.
3. Frontend calls the backend `joinGame` callable with `joinCode` and `displayName`.
4. Backend creates `/games/{gameId}/players/{uid}` using that Auth UID as the document ID.
5. Firestore rules let players read/write only their own private player data.

### Pointing your app at the emulators

In your app's entry point, add the following after initializing Firebase:

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
cd games/bakery-bash/backend
npm install
PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:rules
```

Run the anonymous Auth + player join flow integration test:

```bash
cd games/bakery-bash/backend
PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:auth-flow
```

This starts the Auth, Firestore, and Functions emulators, signs in anonymously,
calls `joinGame`, verifies the player document is created at
`/games/{gameId}/players/{uid}`, then verifies a repeated join reuses the same
UID without incrementing `totalPlayers` again.

Or start the emulator and run tests separately:

```bash
# Terminal 1
cd games/bakery-bash/backend
firebase emulators:start --only firestore

# Terminal 2
cd games/bakery-bash/backend
npm test
```

### Seeding local emulator data

After starting the Firestore emulator, seed a demo lobby game:

```bash
cd games/bakery-bash/backend
npm run seed:emulator
```

This writes demo data from `backend/seed/local-game.json`.

Demo game:

```text
joinCode: ABC123
gameId: demo-lobby
```

---

## Security Rules Summary

See `firestore.rules` for the full rules. The policy is:

- **Players** can read/write only their own player document (`/games/{gameId}/players/{uid}`), and only the `displayName`, `pendingDecision`, and `pendingBids` fields. Financial state is Cloud Functions only.
- **Game state** (`/games/{gameId}`) is read-only for players. Phase transitions are Cloud Functions only.
- **Leaderboard** (`/games/{gameId}/leaderboard/current`) is read-only for all authenticated players.
- **Aggregate rounds** (`/games/{gameId}/rounds/{roundId}`) are read-only for all authenticated players.
- **CSV rows** are readable only by the player they belong to.
- **Decisions** can be created once per round but never updated or deleted.
