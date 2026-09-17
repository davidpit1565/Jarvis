import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";
import type { WebAuthnStore } from "./WebAuthnStore";

const CHALLENGE_TTL_MS = 2 * 60 * 1000; // 2 minutes: how long a WebAuthn ceremony has to complete
const RP_NAME = "JARVIS";
const USER_NAME = "local-user";

interface PendingChallenge {
  challenge: string;
  expiresAt: number;
}

/**
 * Wraps @simplewebauthn/server's registration/authentication ceremonies so
 * JARVIS can be unlocked with Face ID / Touch ID / a platform passkey,
 * instead of (or alongside) the admin token. Single-user: there's one
 * logical account, which may hold more than one registered credential
 * (e.g. a MacBook's Touch ID and an iPhone's Face ID).
 *
 * rpID/origin are passed in per call rather than fixed at construction,
 * since JARVIS may be reached at different hostnames (localhost during
 * development, the deployed public URL in production) and WebAuthn
 * ceremonies must match the actual origin the browser used.
 */
export class WebAuthnService {
  private pendingRegistration: PendingChallenge | null = null;
  private pendingAuthentication: PendingChallenge | null = null;

  constructor(private readonly store: WebAuthnStore) {}

  hasCredentials(): boolean {
    return this.store.list().length > 0;
  }

  async createRegistrationOptions(rpID: string): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      userName: USER_NAME,
      attestationType: "none",
      excludeCredentials: this.store.list().map((c) => ({ id: c.id, transports: c.transports })),
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        userVerification: "required",
        residentKey: "preferred",
      },
    });
    this.pendingRegistration = { challenge: options.challenge, expiresAt: Date.now() + CHALLENGE_TTL_MS };
    return options;
  }

  async verifyRegistration(response: RegistrationResponseJSON, rpID: string, origin: string): Promise<boolean> {
    const pending = this.pendingRegistration;
    this.pendingRegistration = null;
    if (!pending || pending.expiresAt < Date.now()) return false;

    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });

    if (!result.verified || !result.registrationInfo) return false;
    this.store.save(result.registrationInfo.credential);
    return true;
  }

  async createAuthenticationOptions(rpID: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: "required",
      allowCredentials: this.store.list().map((c) => ({ id: c.id, transports: c.transports })),
    });
    this.pendingAuthentication = { challenge: options.challenge, expiresAt: Date.now() + CHALLENGE_TTL_MS };
    return options;
  }

  async verifyAuthentication(response: AuthenticationResponseJSON, rpID: string, origin: string): Promise<boolean> {
    const pending = this.pendingAuthentication;
    this.pendingAuthentication = null;
    if (!pending || pending.expiresAt < Date.now()) return false;

    const credential = this.store.get(response.id);
    if (!credential) return false;

    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential,
    });

    if (!result.verified) return false;
    this.store.updateCounter(credential.id, result.authenticationInfo.newCounter);
    return true;
  }
}
