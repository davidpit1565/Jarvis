import crypto from "node:crypto";
import type { CanvaTokenStore } from "@/canva/CanvaTokenStore";
import type { CanvaBrandTemplate, CanvaCreatedDesign, CanvaDesignSummary, CanvaExport, CanvaExportFormat } from "@/types/canva";
import { apiError } from "@/core/net/apiError";

const CANVA_AUTHORIZE_URL = "https://www.canva.com/api/oauth/authorize";
const CANVA_TOKEN_URL = "https://api.canva.com/rest/v1/oauth/token";
const CANVA_API_BASE_URL = "https://api.canva.com/rest/v1";

const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 60_000;

// design:meta:read + brandtemplate:meta:read cover everything "show me my
// Canva" needs (list designs, list the brand templates available for
// autofill). design:content:write is required by the Autofill API itself
// (POST /v1/autofills) even though it conceptually reads as "create," per
// Canva's own scope documentation for that endpoint — not requesting
// asset:write/folder:write/comment:write etc., since nothing here uploads
// assets, moves folders, or comments. design:content:read was added for
// exportDesign (POST /v1/exports requires it per Canva's docs) — a real
// scope addition over the original Canva PR, so an account linked before
// this change needs to re-link (GET /canva/oauth/start) to pick it up;
// Canva's consent screen won't grant a scope the account never approved,
// and exportDesign will fail with a real 403 against a stale token rather
// than silently working.
const CANVA_SCOPES = "design:meta:read design:content:read design:content:write brandtemplate:meta:read";

// Canva's docs: "You might need to make multiple requests to this endpoint
// until you get a success or failed status" for the async autofill job —
// polled at a modest interval rather than hammering the (60/min) endpoint.
const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_MAX_POLL_ATTEMPTS = 20; // ~30s total, generous for a text-only autofill

interface RawTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

interface RawDesignSummary {
  id: string;
  title?: string;
  urls: { edit_url: string; view_url: string };
  updated_at: number;
  design_types?: string[];
}

interface RawBrandTemplate {
  id: string;
  title: string;
  view_url: string;
  create_url: string;
}

interface RawAutofillJob {
  id: string;
  status: "in_progress" | "success" | "failed";
  result?: {
    type: "create_design" | "update_design";
    design: {
      id: string;
      title?: string;
      url?: string;
      urls: { edit_url: string; view_url: string };
    };
  };
  error?: { code: string; message: string };
}

interface RawExportJob {
  id: string;
  status: "in_progress" | "success" | "failed";
  urls?: string[];
  error?: { code: string; message: string };
}

// Canva requires an explicit `quality` (1-100) for a JPG export — no
// default exists on their side — so a sensible one is picked here rather
// than forcing the model to invent a number. 90 mirrors common "high
// quality, still compressed" presets (e.g. most image editors' own JPEG
// export defaults).
const DEFAULT_JPG_QUALITY = 90;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Canva Connect API access via raw fetch calls — no SDK dependency, same
 * style as SpotifyClient/GoogleCalendarClient. OAuth 2.0 Authorization
 * Code flow with PKCE (SHA-256), per Canva's own current docs
 * (canva.dev/docs/apps/rest-apis/authentication/) — unlike Spotify/Google
 * here, PKCE is mandatory, not optional, so `buildAuthUrl` generates and
 * returns a `code_verifier` the caller MUST persist (keyed by `state`,
 * alongside the state itself) and pass back into `exchangeCodeForTokens`.
 *
 * HONEST SCOPE NOTE (read before extending this further): Canva's Autofill
 * API — the only realistic way to generate a polished multi-element design
 * programmatically — only works against a pre-made "brand template" the
 * user designs once in the Canva UI and tags with named data fields (see
 * `createDesignFromBrandTemplate`'s own doc comment). There is no API that
 * reliably composes a good-looking multi-slide/multi-element design from
 * scratch the way GoogleSlidesClient does for Slides — Canva's Design API
 * can create a blank design, but filling it with real content requires
 * either Autofill against a template or hand-authoring Canva's own design
 * schema (not exposed here, and not attempted: it's a much harder, far
 * less reliable problem than Slides' simple title+bullets placeholders).
 * `createDesignFromBrandTemplate` is deliberately the ONLY "create" method
 * this client has.
 *
 * Also per Canva's docs: Autofill only works when the linked account is on
 * Canva Pro (incl. Education/Nonprofits), Teams, or Enterprise — a Canva
 * Free account can link (OAuth has no plan restriction) and list its own
 * designs/brand templates just fine, but `createDesignFromBrandTemplate`
 * will fail with a real, surfaced API error (not silently) on a Free plan.
 *
 * REQUIRES REAL VALIDATION: never exercised against a real Canva account.
 */
export class CanvaClient {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
    private readonly tokenStore: CanvaTokenStore,
    private readonly pollOptions: { pollIntervalMs?: number; maxPollAttempts?: number } = {}
  ) {}

  /**
   * Builds the URL to send the user to for Canva's consent screen, plus
   * the `code_verifier` the caller must store (e.g. alongside `state`, the
   * same way the OAuth `state` itself is held pending the callback) and
   * pass back into `exchangeCodeForTokens`. Canva's docs require the
   * `code_verifier`/`code_challenge` pair to be unique per request, so a
   * fresh one is generated on every call — never cache or reuse the
   * returned value across two different authorization attempts.
   */
  buildAuthUrl(state: string): { url: string; codeVerifier: string } {
    // Canva's spec: 43-128 chars, ASCII letters/digits/-._~ only.
    // base64url-encoding 96 random bytes yields 128 chars from exactly
    // that alphabet — the same approach Canva's own docs sample.
    const codeVerifier = crypto.randomBytes(96).toString("base64url");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

    const url = new URL(CANVA_AUTHORIZE_URL);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "s256");
    url.searchParams.set("scope", CANVA_SCOPES);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("state", state);
    url.searchParams.set("redirect_uri", this.redirectUri);
    return { url: url.toString(), codeVerifier };
  }

  private basicAuthHeader(): string {
    return `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`;
  }

  /** Exchanges an OAuth authorization code (plus its matching PKCE `code_verifier`) for tokens and persists them. */
  async exchangeCodeForTokens(code: string, codeVerifier: string): Promise<void> {
    const response = await fetch(CANVA_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: this.basicAuthHeader(),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        redirect_uri: this.redirectUri,
      }).toString(),
    });

    if (!response.ok) {
      throw await apiError("Canva OAuth code exchange failed", response);
    }

    const data = (await response.json()) as RawTokenResponse;
    if (!data.refresh_token) {
      throw new Error(
        "Canva didn't return a refresh token — revoke JARVIS's access at " +
          "https://www.canva.com/settings/apps and try linking again."
      );
    }

    this.tokenStore.save({
      refreshToken: data.refresh_token,
      accessToken: data.access_token,
      accessTokenExpiresAt: Date.now() + data.expires_in * 1000,
    });
  }

  private async refreshAccessToken(refreshToken: string): Promise<string> {
    const response = await fetch(CANVA_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: this.basicAuthHeader(),
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }).toString(),
    });

    if (!response.ok) {
      throw await apiError("Canva OAuth token refresh failed", response);
    }

    const data = (await response.json()) as RawTokenResponse;
    if (!data.refresh_token) {
      // Canva's docs say a refresh-grant response "always" includes a new
      // refresh token (each one is single-use) — if that's ever not true,
      // surface it loudly rather than silently reusing the now-spent one,
      // which would just fail on the *next* refresh with a confusing
      // invalid_grant far away from this call site.
      throw new Error(
        "Canva's token refresh response didn't include a new refresh token — Canva account may need re-linking " +
          "(see GET /canva/oauth/start)."
      );
    }
    const expiresAt = Date.now() + data.expires_in * 1000;
    this.tokenStore.updateAccessToken(data.access_token, expiresAt, data.refresh_token);
    return data.access_token;
  }

  private async getValidAccessToken(): Promise<string> {
    const tokens = this.tokenStore.get();
    if (!tokens) {
      throw new Error("No Canva account linked yet — visit GET /canva/oauth/start to connect one.");
    }

    const stillValid =
      tokens.accessToken !== null &&
      tokens.accessTokenExpiresAt !== null &&
      tokens.accessTokenExpiresAt - TOKEN_EXPIRY_SAFETY_MARGIN_MS > Date.now();

    if (stillValid) return tokens.accessToken!;
    return this.refreshAccessToken(tokens.refreshToken);
  }

  private parseDesign(raw: RawDesignSummary): CanvaDesignSummary {
    return {
      id: raw.id,
      title: raw.title ?? null,
      editUrl: raw.urls.edit_url,
      viewUrl: raw.urls.view_url,
      updatedAt: raw.updated_at,
      designTypes: raw.design_types ?? [],
    };
  }

  /** Lists the linked user's own Canva designs ("show me my Canva"), optionally filtered by a search term. */
  async listDesigns(query?: string, limit: number = 25): Promise<CanvaDesignSummary[]> {
    const accessToken = await this.getValidAccessToken();

    const url = new URL(`${CANVA_API_BASE_URL}/designs`);
    if (query) url.searchParams.set("query", query);
    url.searchParams.set("limit", String(Math.min(Math.max(limit, 1), 100)));
    url.searchParams.set("ownership", "owned");
    url.searchParams.set("sort_by", "modified_descending");

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw await apiError("Canva list designs failed", response);
    }

    const data = (await response.json()) as { items: RawDesignSummary[] };
    return data.items.map((item) => this.parseDesign(item));
  }

  /**
   * Lists the brand templates the linked user has access to — the only
   * realistic v1 "create a design" entry point (see this class's own doc
   * comment). David needs to have published at least one Brand Template
   * in the Canva UI first; this returns an empty list, not an error, when
   * none exist yet.
   */
  async listBrandTemplates(query?: string): Promise<CanvaBrandTemplate[]> {
    const accessToken = await this.getValidAccessToken();

    const url = new URL(`${CANVA_API_BASE_URL}/brand-templates`);
    if (query) url.searchParams.set("query", query);

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw await apiError("Canva list brand templates failed", response);
    }

    const data = (await response.json()) as { items: RawBrandTemplate[] };
    return data.items.map((item) => ({ id: item.id, title: item.title, viewUrl: item.view_url, createUrl: item.create_url }));
  }

  /**
   * Autofills a new design from an existing brand template's text data
   * fields (deliberately text-only in v1 — image/chart/sheet autofill
   * fields exist in Canva's API but need an already-uploaded Canva asset
   * id or tabular data the model has no reliable way to produce; a wrong
   * `asset_id` would silently fail per-field, not loudly, which is worse
   * than just not offering it yet). `fields` keys must match the data
   * field names David tagged in the Canva UI when he set up the template
   * (see `listBrandTemplates`'s own doc comment on that one-time setup);
   * an unknown field name is silently skipped by Canva itself, not an
   * error — there is no API to validate field names up front without also
   * calling the (separate) Get brand template dataset endpoint, which
   * this v1 client doesn't wrap.
   *
   * This is an asynchronous job on Canva's side: POST /v1/autofills
   * returns immediately with a job id, and this method polls
   * GET /v1/autofills/{jobId} until it reports `success` or `failed`
   * (or this gives up after `maxPollAttempts`, per the class's
   * `pollOptions`) — never a single round trip.
   */
  async createDesignFromBrandTemplate(brandTemplateId: string, fields: Record<string, string>): Promise<CanvaCreatedDesign> {
    const accessToken = await this.getValidAccessToken();

    const data: Record<string, { type: "text"; text: string }> = {};
    for (const [key, value] of Object.entries(fields)) {
      data[key] = { type: "text", text: value };
    }

    const createResponse = await fetch(`${CANVA_API_BASE_URL}/autofills`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "create_from_brand_template", brand_template_id: brandTemplateId, data }),
    });

    if (!createResponse.ok) {
      throw await apiError("Canva create design (autofill) failed", createResponse);
    }

    const created = (await createResponse.json()) as { job: RawAutofillJob };
    const jobId = created.job.id;

    const pollIntervalMs = this.pollOptions.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const maxPollAttempts = this.pollOptions.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;

    for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
      if (attempt > 0) await sleep(pollIntervalMs);

      const pollResponse = await fetch(`${CANVA_API_BASE_URL}/autofills/${jobId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!pollResponse.ok) {
        throw await apiError("Canva get autofill job status failed", pollResponse);
      }
      const polled = (await pollResponse.json()) as { job: RawAutofillJob };
      const job = polled.job;

      if (job.status === "failed") {
        throw new Error(`Canva autofill job failed: ${job.error?.message ?? job.error?.code ?? "unknown error"}`);
      }
      if (job.status === "success" && job.result) {
        const design = job.result.design;
        return {
          id: design.id,
          title: design.title ?? null,
          url: design.url ?? null,
          editUrl: design.urls.edit_url,
          viewUrl: design.urls.view_url,
        };
      }
      // status === "in_progress" — keep polling.
    }

    throw new Error(
      `Canva autofill job ${jobId} is still in progress after ${maxPollAttempts} polling attempts — it may still ` +
        "complete; check it later rather than assuming it failed."
    );
  }

  /**
   * Exports an existing design as a downloadable file — the read-adjacent
   * follow-up to `createDesignFromBrandTemplate`: this never changes
   * anything in David's Canva account, it just produces a copy. Same
   * async-job-start-then-poll shape as autofill (POST /v1/exports ->
   * GET /v1/exports/{exportId}), per Canva's current docs
   * (canva.dev/docs/apps/rest-apis/reference/exports/).
   *
   * v1 deliberately supports only `pdf`/`png`/`jpg`/`pptx`, not every
   * format Canva's API offers (`gif`/`mp4`/`csv`/`html_bundle`/
   * `html_standalone` also exist): `csv`/`html_*` only apply to Canva
   * Sheets/Docs-style designs this client has no other support for, and
   * `mp4` is deliberately excluded even though most designs can produce
   * one — video exports can run large, and this process runs on a small
   * Fly machine (see CLAUDE.md's BitNet research note on this box's real
   * memory budget); `gif` was left out too since it shares `mp4`'s
   * "designed for motion/video content" use case, which nothing else in
   * this codebase currently produces. All four supported formats stay
   * comfortably small and are handed to Telegram as a URL it fetches
   * itself (see ExportCanvaDesignTool), never buffered in this process.
   *
   * Only the two options worth exposing in a focused v1 are taken:
   * `pages` (which pages of a multi-page design to export — all pages by
   * default, matching Canva's own default) and `jpgQuality` (required by
   * Canva's own API for a `jpg` export with no server-side default, so
   * `DEFAULT_JPG_QUALITY` is used when omitted). Canva's `export_quality`
   * ("pro" vs "regular") and PNG's `lossless`/`transparent_background`/
   * `height`/`width` knobs are deliberately not exposed — real options
   * but not worth the added tool-surface for "export this design as a
   * file," and a `pro` export can fail outright for an account without
   * premium Canva features, which isn't a case worth defaulting into.
   *
   * Returned `urls` are Canva's own temporary download links — they
   * expire 24 hours after the job completes, so callers must use them
   * immediately (e.g. hand straight to Telegram) rather than store them.
   */
  async exportDesign(
    designId: string,
    format: CanvaExportFormat = "pdf",
    options: { pages?: number[]; jpgQuality?: number } = {}
  ): Promise<CanvaExport> {
    const accessToken = await this.getValidAccessToken();

    const formatPayload: Record<string, unknown> = { type: format };
    if (options.pages && options.pages.length > 0) formatPayload.pages = options.pages;
    if (format === "jpg") formatPayload.quality = options.jpgQuality ?? DEFAULT_JPG_QUALITY;

    const createResponse = await fetch(`${CANVA_API_BASE_URL}/exports`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ design_id: designId, format: formatPayload }),
    });

    if (!createResponse.ok) {
      throw await apiError("Canva create export failed", createResponse);
    }

    const created = (await createResponse.json()) as { job: RawExportJob };
    const jobId = created.job.id;

    const pollIntervalMs = this.pollOptions.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const maxPollAttempts = this.pollOptions.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;

    for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
      if (attempt > 0) await sleep(pollIntervalMs);

      const pollResponse = await fetch(`${CANVA_API_BASE_URL}/exports/${jobId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!pollResponse.ok) {
        throw await apiError("Canva get export job status failed", pollResponse);
      }
      const polled = (await pollResponse.json()) as { job: RawExportJob };
      const job = polled.job;

      if (job.status === "failed") {
        throw new Error(`Canva export job failed: ${job.error?.message ?? job.error?.code ?? "unknown error"}`);
      }
      if (job.status === "success" && job.urls) {
        return { id: job.id, format, urls: job.urls };
      }
      // status === "in_progress" — keep polling.
    }

    throw new Error(
      `Canva export job ${jobId} is still in progress after ${maxPollAttempts} polling attempts — it may still ` +
        "complete; check it later rather than assuming it failed."
    );
  }
}
