import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type {
  AuthValidationProfile,
  ITokenStore,
  StoredAuthTokens,
} from "@traycer-clients/shared/platform/runner-host";

/**
 * The synthetic local session used when the serve process reports
 * `localMode: true` (fronting the open host, or forced with `--local`).
 *
 * There is no Traycer account in this mode. The shell seeds a constant
 * bearer before the app boots so `AuthService.start()` finds stored tokens,
 * and `BrowserRunnerHost` answers every validate/refresh call with the
 * synthetic identity below instead of calling authn. The bearer's VALUE is
 * irrelevant to the open host - its local-auth default maps any non-empty
 * bearer to the single local user - but the user id here must match the
 * host's verdict so chat ownership (`access.ownerUserId`) lines up.
 */

export const LOCAL_BEARER_TOKEN = "traycer-local";
export const LOCAL_REFRESH_TOKEN = "traycer-local-refresh";

/** Mirror of the open host's local-user verdict (host/src/auth.ts). */
export const LOCAL_USER_ID = "local-user";
const LOCAL_USER_NAME = "Local User";
const LOCAL_USER_EMAIL = "local@localhost";

/** Fixed timestamp so the synthetic identity is stable across loads. */
const LOCAL_EPOCH = "2024-01-01T00:00:00.000Z";

export function localStoredTokens(): StoredAuthTokens {
  return { token: LOCAL_BEARER_TOKEN, refreshToken: LOCAL_REFRESH_TOKEN };
}

export function localAuthProfile(): AuthValidationProfile {
  return {
    userId: LOCAL_USER_ID,
    userName: LOCAL_USER_NAME,
    email: LOCAL_USER_EMAIL,
  };
}

export function localAuthenticatedUser(): AuthenticatedUser {
  const epoch = new Date(LOCAL_EPOCH);
  return {
    user: {
      id: LOCAL_USER_ID,
      name: LOCAL_USER_NAME,
      providerId: "local",
      providerHandle: "local",
      providerType: "EMAIL",
      email: LOCAL_USER_EMAIL,
      avatarUrl: null,
      activatedAt: epoch,
      createdAt: epoch,
      updatedAt: epoch,
      lastSeenAt: null,
      privacyMode: true,
      isLearningEnabled: false,
    },
    // "PRO" keeps every plan-gated surface open; nothing is billed - the
    // open host never consults Traycer subscription state.
    userSubscription: {
      id: "local-subscription",
      userID: LOCAL_USER_ID,
      orgID: null,
      teamID: null,
      customerId: "local",
      createdAt: epoch,
      updatedAt: epoch,
      subscriptionExpiry: null,
      trialEndsAt: null,
      subscriptionStatus: "PRO",
      hasPaymentMethod: null,
      isInTrial: false,
      rechargeRateSeconds: 0,
    },
    payAsYouGoUsage: { allowPayAsYouGo: false },
    teamSubscriptions: [],
  };
}

/**
 * Seeds the constant local tokens into the shell's token store. Runs before
 * the app renders so `AuthService.start()` rehydrates straight into the
 * signed-in state - the user never sees a sign-in screen. Overwrites any
 * previously stored cloud tokens: a local-mode page has no authn to spend
 * them against.
 */
export async function ensureLocalSessionSeeded(
  tokenStore: ITokenStore,
): Promise<void> {
  const existing = await tokenStore.get();
  if (
    existing !== null &&
    existing.token === LOCAL_BEARER_TOKEN &&
    existing.refreshToken === LOCAL_REFRESH_TOKEN
  ) {
    return;
  }
  await tokenStore.set(localStoredTokens());
}
