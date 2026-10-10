import { initializeApp, getApps, cert, applicationDefault, App } from 'firebase-admin/app';
import { getAuth, Auth, UserRecord } from 'firebase-admin/auth';
import { getFirestore, Firestore } from 'firebase-admin/firestore';
import { randomBytes } from 'node:crypto';
import type { AuthClaims, UserRole } from '../types/tenant.js';

let initialized = false;

export function getFirebaseAdminApp(): App {
  const existingApps = getApps();
  if (existingApps.length > 0) {
    return existingApps[0];
  }

  // The project comes from the environment only (there is no config file). With a service account key the
  // key's own project is used; FIREBASE_PROJECT_ID / VITE_FIREBASE_PROJECT_ID say what the app was built for.
  const projectId = (process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID || '').trim() || undefined;

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (serviceAccountJson) {
    try {
      const parsed = JSON.parse(serviceAccountJson);
      // The browser build and the server key must point to the SAME Firebase project, otherwise every
      // login is rejected ("Invalid or expired session") with no obvious reason. Say so loudly.
      if (projectId && parsed.project_id && parsed.project_id !== projectId) {
        console.error(
          `[Firebase Admin] PROJECT MISMATCH: FIREBASE_SERVICE_ACCOUNT_JSON is for "${parsed.project_id}" but the app is configured for "${projectId}". ` +
            'Set VITE_FIREBASE_PROJECT_ID (and the other VITE_FIREBASE_* values) for the same project in this environment.'
        );
      }
      return initializeApp({
        credential: cert(parsed),
        projectId: parsed.project_id || projectId,
      });
    } catch (e) {
      console.warn('[Firebase Admin] Warning parsing FIREBASE_SERVICE_ACCOUNT_JSON:', e);
    }
  }

  // No usable key: the server cannot verify logins or reach the database. Say so once, clearly.
  if (!serviceAccountJson) {
    console.error(
      '[Firebase Admin] FIREBASE_SERVICE_ACCOUNT_JSON is missing in this environment. ' +
        'Add the service account key of your Firebase project and redeploy.'
    );
  }

  try {
    return initializeApp({
      credential: applicationDefault(),
      projectId,
    });
  } catch {
    try {
      return initializeApp({
        projectId,
      });
    } catch {
      return getApps()[0] || initializeApp();
    }
  }
}

export function getAdminAuth(): Auth {
  const app = getFirebaseAdminApp();
  return getAuth(app);
}

let firestoreConfigured = false;

export function getAdminFirestore(): Firestore {
  const app = getFirebaseAdminApp();
  // Database name: FIRESTORE_DATABASE_ID, otherwise the project's "(default)" database.
  const dbId = (process.env.FIRESTORE_DATABASE_ID || '').trim() || '(default)';
  let fs: Firestore;
  if (dbId && dbId !== '(default)') {
    try {
      fs = (getFirestore as any)(app, dbId);
    } catch {
      fs = getFirestore(app);
    }
  } else {
    fs = getFirestore(app);
  }
  if (!firestoreConfigured) {
    // Match the old client-SDK behaviour: skip `undefined` fields instead of throwing.
    try { fs.settings({ ignoreUndefinedProperties: true }); } catch {}
    firestoreConfigured = true;
  }
  return fs;
}

/**
 * Assigns tenant custom claims to a Firebase Auth user
 */
export async function setTenantUserClaims(
  uid: string,
  claims: AuthClaims
): Promise<void> {
  const auth = getAdminAuth();
  await auth.setCustomUserClaims(uid, {
    tenantId: claims.tenantId || null,
    role: claims.role || 'member',
    platformAdmin: Boolean(claims.platformAdmin),
  });
}

/**
 * Creates a user in Firebase Auth and assigns claims.
 * - An existing account is never silently moved to another tenant.
 * - With no password, a random one is generated; the user sets their own via
 *   the password-reset link (see createPasswordSetupLink).
 */
export async function createTenantUser(params: {
  email: string;
  password?: string;
  displayName?: string;
  tenantId: string;
  role: UserRole;
}): Promise<UserRecord & { existed?: boolean; passwordSet?: boolean }> {
  const auth = getAdminAuth();
  const email = params.email.trim().toLowerCase();
  let userRecord: UserRecord;
  let existed = false;
  let passwordSet = Boolean(params.password);

  try {
    userRecord = await auth.getUserByEmail(email);
    existed = true;
    const existing = (userRecord.customClaims || {}) as AuthClaims;
    if (existing.platformAdmin) {
      throw new Error('This email belongs to a platform administrator');
    }
    if (existing.tenantId && existing.tenantId !== params.tenantId) {
      throw new Error('This email already belongs to another workspace');
    }
    // An admin re-adding someone from the same workspace sets their password (the account already exists,
    // so without this the typed password would be silently ignored). Accounts that are not yet in this
    // workspace are never modified.
    if (params.password && existing.tenantId === params.tenantId) {
      await auth.updateUser(userRecord.uid, { password: params.password });
    } else {
      passwordSet = false;
    }
  } catch (error: any) {
    if (error?.code === 'auth/user-not-found') {
      userRecord = await auth.createUser({
        email,
        password: params.password || randomBytes(18).toString('base64url') + 'aA1!',
        displayName: params.displayName || email.split('@')[0],
        emailVerified: false,
      });
    } else {
      throw error;
    }
  }

  await setTenantUserClaims(userRecord.uid, {
    tenantId: params.tenantId,
    role: params.role,
    platformAdmin: params.role === 'platformAdmin',
  });

  return Object.assign(userRecord, { existed, passwordSet });
}

/** Link the user opens to set their own password (used for invites). */
export async function createPasswordSetupLink(email: string, continueUrl?: string): Promise<string> {
  return getAdminAuth().generatePasswordResetLink(
    email,
    continueUrl ? { url: continueUrl } : undefined
  );
}

/** Force all existing sessions of a user to re-authenticate. */
export async function revokeUserSessions(uid: string): Promise<void> {
  await getAdminAuth().revokeRefreshTokens(uid);
}