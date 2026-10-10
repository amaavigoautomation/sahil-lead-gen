import { initializeApp, getApps } from 'firebase/app';
import { getFirestore, Firestore, doc, getDocFromServer } from 'firebase/firestore';
import { getAuth, Auth } from 'firebase/auth';

// ALL Firebase settings come from environment variables. There is no config file and no built-in project:
// whichever Firebase project the environment names is the one this deployment uses.
//   Browser build:  VITE_FIREBASE_PROJECT_ID, VITE_FIREBASE_API_KEY, VITE_FIREBASE_AUTH_DOMAIN,
//                   VITE_FIREBASE_APP_ID, VITE_FIRESTORE_DATABASE_ID (+ optional storage bucket / sender id)
//   Server:         FIREBASE_SERVICE_ACCOUNT_JSON, FIRESTORE_DATABASE_ID (see src/server/firebaseAdmin.ts)

// Safely detect environment variables in both Vite browser client and Node serverless functions
const envProjectId =
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_FIREBASE_PROJECT_ID) ||
  (typeof process !== 'undefined' && process.env?.VITE_FIREBASE_PROJECT_ID) ||
  (typeof process !== 'undefined' && process.env?.FIREBASE_PROJECT_ID);

const envApiKey =
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_FIREBASE_API_KEY) ||
  (typeof process !== 'undefined' && process.env?.VITE_FIREBASE_API_KEY) ||
  (typeof process !== 'undefined' && process.env?.FIREBASE_API_KEY);

// The remaining settings can also come from the environment, so ONE codebase can run against different
// Firebase projects (for example: production on the main database, a test deployment on another one).
// Each name is written out literally because Vite only replaces literal `import.meta.env.VITE_*` references.
const envAuthDomain =
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_FIREBASE_AUTH_DOMAIN) ||
  (typeof process !== 'undefined' && process.env?.VITE_FIREBASE_AUTH_DOMAIN);

const envStorageBucket =
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_FIREBASE_STORAGE_BUCKET) ||
  (typeof process !== 'undefined' && process.env?.VITE_FIREBASE_STORAGE_BUCKET);

const envMessagingSenderId =
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_FIREBASE_MESSAGING_SENDER_ID) ||
  (typeof process !== 'undefined' && process.env?.VITE_FIREBASE_MESSAGING_SENDER_ID);

const envAppId =
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_FIREBASE_APP_ID) ||
  (typeof process !== 'undefined' && process.env?.VITE_FIREBASE_APP_ID);

// Browser builds read VITE_FIRESTORE_DATABASE_ID; the server also accepts its own FIRESTORE_DATABASE_ID.
const envDatabaseId =
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_FIRESTORE_DATABASE_ID) ||
  (typeof process !== 'undefined' && process.env?.VITE_FIRESTORE_DATABASE_ID) ||
  (typeof process !== 'undefined' && process.env?.FIRESTORE_DATABASE_ID);

// On the server the project can also be read from the service account key, so a script that only has
// FIREBASE_SERVICE_ACCOUNT_JSON still knows which project it is working on. (Never available in the browser.)
function projectIdFromServiceAccount(): string {
  try {
    const raw = typeof process !== 'undefined' ? process.env?.FIREBASE_SERVICE_ACCOUNT_JSON : '';
    return raw ? String(JSON.parse(raw).project_id || '') : '';
  } catch {
    return '';
  }
}

const resolvedProjectId: string = envProjectId || projectIdFromServiceAccount() || '';

export const firebaseConfig = {
  projectId: resolvedProjectId,
  apiKey: (envApiKey || '') as string,
  authDomain: (envAuthDomain || (resolvedProjectId ? `${resolvedProjectId}.firebaseapp.com` : '')) as string,
  storageBucket: (envStorageBucket || (resolvedProjectId ? `${resolvedProjectId}.firebasestorage.app` : '')) as string,
  messagingSenderId: (envMessagingSenderId || '') as string,
  appId: (envAppId || '') as string,
  firestoreDatabaseId: (envDatabaseId || '(default)') as string,
};

// Say exactly which setting is missing instead of failing later with a cryptic Firebase error.
const projectIdMissing = !firebaseConfig.projectId;
const webApiKeyMissing = !firebaseConfig.apiKey;
if (typeof console !== 'undefined') {
  if (projectIdMissing) {
    console.error(
      '[Firebase] VITE_FIREBASE_PROJECT_ID is missing. Set the VITE_FIREBASE_* values for your Firebase project ' +
        'in this environment and redeploy. Without them the app cannot reach any database.'
    );
  } else if (webApiKeyMissing && typeof window !== 'undefined') {
    console.error(
      `[Firebase] VITE_FIREBASE_API_KEY is missing for project "${firebaseConfig.projectId}". ` +
        'Set it (with the other VITE_FIREBASE_* values) in this environment and redeploy.'
    );
  }
}

// Initialize Firebase App singleton for Firestore & Authentication.
// (Placeholders keep start-up from crashing when a setting is missing; the errors above explain what to fix.
// The server does not use the web API key at all.)
export const app =
  getApps().find((a) => a.name === '[DEFAULT]') ||
  initializeApp({
    ...firebaseConfig,
    projectId: firebaseConfig.projectId || 'missing-project-id',
    apiKey: firebaseConfig.apiKey || 'missing-web-api-key',
  });

// Initialize Firestore with specific database ID
export const db: Firestore = firebaseConfig.firestoreDatabaseId
  ? getFirestore(app, firebaseConfig.firestoreDatabaseId)
  : getFirestore(app);

// Auth for the project selected above.
export const auth: Auth = getAuth(app);

// The server talks to Firebase with the service account, so only the browser needs the web API key.
export const isFirebaseConfigured = Boolean(firebaseConfig.projectId && (firebaseConfig.apiKey || typeof window === 'undefined'));

// Validate connection per skill guideline (browser client only; skip during Node SSR/build)
async function testFirestoreConnection() {
  if (typeof window === 'undefined') return;
  if (!isFirebaseConfigured || !db) return;
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.warn('Firebase client is offline or connection not established.');
    }
  }
}
testFirestoreConnection();