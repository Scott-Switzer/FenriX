const fs = require("node:fs");
const path = require("node:path");
const { getApps, initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "Refusing to seed Firestore without FIRESTORE_EMULATOR_HOST. Start the emulator first."
  );
}

const seedPath = path.resolve(__dirname, "../seed/local-game.json");
const seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));

if (!getApps().length) {
  initializeApp({
    projectId: seed.projectId,
  });
}

async function main() {
  const db = getFirestore();
  const batch = db.batch();

  for (const item of seed.docs) {
    batch.set(db.doc(item.path), item.data);
  }

  await batch.commit();

  console.log(`Seeded ${seed.docs.length} documents into ${seed.projectId}.`);
  console.log("Demo game code: ABC123");
  console.log("Demo game path: games/demo-lobby");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
