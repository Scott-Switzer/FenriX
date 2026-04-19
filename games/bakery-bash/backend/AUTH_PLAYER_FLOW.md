# Bakery Bash — Auth and Player Login Flow

This backend contract is for the MVP player identity flow. Frontend should use it before reading or writing any player-specific game data.

## Firebase project connection

The backend folder is connected to Firebase project `bakery-bash-54d12` through `.firebaserc`.

Run Firebase commands from:

```bash
games/bakery-bash/backend
```

Local emulator command:

```bash
firebase emulators:start --project bakery-bash-54d12
```

## Required Firebase console setting

Anonymous Authentication must be enabled in Firebase Console:

Authentication -> Sign-in method -> Anonymous -> Enable

The emulator supports anonymous users locally, but the deployed app will not accept anonymous sign-ins until that provider is enabled in the real Firebase project.

## Identity model

Firebase Authentication is the source of truth for player identity.

- A player signs in anonymously.
- Firebase returns an Auth UID.
- That Auth UID is used as the Firestore player document ID.
- Player document path: `/games/{gameId}/players/{uid}`.
- The same UID persists across browser refreshes as long as the client keeps Firebase Auth local persistence enabled.
- The UID persists across all rounds in the same game.

## Frontend contract

Frontend should do this on app load:

1. Initialize Firebase.
2. Set Auth persistence to local browser persistence.
3. If there is no current user, call anonymous sign-in.
4. Keep the returned `uid`.
5. After the user enters a bakery name and game code, call the backend `joinGame` function.

Frontend should not create the initial player document directly. The backend creates it so budget, revenue, and result fields cannot be spoofed by a player.

Expected callable request:

```js
joinGame({
  joinCode: "ABC123",
  displayName: "The Rolling Scone"
})
```

Expected callable response:

```js
{
  uid: "firebase-auth-uid",
  gameId: "firestore-game-doc-id",
  playerId: "firebase-auth-uid",
  displayName: "The Rolling Scone",
  joinedAt: 1710000000000
}
```

## Backend callable function

`joinGame` requires an authenticated Firebase user. If the request is unauthenticated, it fails.

The function:

- validates the 6-character join code
- validates the display name length
- finds a game in `lobby` phase with that join code
- creates `/games/{gameId}/players/{uid}` if it does not exist
- initializes budget, pending decision fields, pending bid fields, and last round result
- increments `totalPlayers` on the game document only for a new player
- returns the `gameId` and `uid` to Frontend

If the player refreshes the page and rejoins with the same anonymous Auth session, the same UID is reused and the existing player document is updated only with the display name.

## Security rule expectations

The Firestore rules require `request.auth.uid` to match the player document ID for private player data.

Players can read:

- `/games/{gameId}`
- `/games/{gameId}/config/params`
- `/games/{gameId}/leaderboard/latest`
- `/games/{gameId}/roster/{playerId}` (lobby roster — public-safe fields only)
- `/games/{gameId}/rounds/{roundId}`
- their own `/games/{gameId}/players/{uid}`
- their own `/games/{gameId}/players/{uid}/decisions/{roundId}`
- their own `/games/{gameId}/players/{uid}/rounds/{roundId}`
- their own `/games/{gameId}/csvRows/{uid}/rounds/{roundId}`

Players cannot read other teams' player documents, private round results, decisions, or CSV rows.

Players cannot write financial state, leaderboard data, aggregate round data, or simulation output. Those fields are backend-owned.
