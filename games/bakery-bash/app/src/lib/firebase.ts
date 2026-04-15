import { initializeApp } from "firebase/app";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";
import { getAuth, connectAuthEmulator } from "firebase/auth";
import { getFunctions, connectFunctionsEmulator } from "firebase/functions";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "demo-key",
  authDomain:
    import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ||
    "bakery-bash-54d12.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? "bakery-bash-54d12",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
export const functions = getFunctions(app);

// Connect to emulators in development
if (import.meta.env.DEV) {
  try {
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
    connectAuthEmulator(auth, "http://127.0.0.1:9099", {
      disableWarnings: true,
    });
    connectFunctionsEmulator(functions, "127.0.0.1", 5001);
    console.log("🔧 Connected to Firebase emulators");
  } catch {
    // Emulators already connected (hot reload)
  }
}
