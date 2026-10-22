export interface ApiError {
  code: string;
  message: string;
  statusCode?: number;
  /** When a used-up limit refills (QUOTA_EXCEEDED), ISO-8601. */
  resets_at?: string;
  /** Seconds to wait (RATE_LIMITED). */
  retry_after?: number;
}

export const API_ERRORS = {
  EMPTY_ACTION: { code: 'EMPTY_ACTION', message: 'Action is empty', statusCode: 400 },
  ACTION_TOO_LONG: { code: 'ACTION_TOO_LONG', message: 'Action too long (max 500 characters)', statusCode: 400 },
  PARSE_ERROR: { code: 'PARSE_ERROR', message: 'Failed to parse AI response', statusCode: 500 },
  AI_ERROR: { code: 'AI_ERROR', message: 'AI returned an error', statusCode: 400 },
  INVALID_FORMAT: { code: 'INVALID_FORMAT', message: 'Invalid response format', statusCode: 500 },
  TOO_MANY_COMMANDS: { code: 'TOO_MANY_COMMANDS', message: 'Too many commands (max 12)', statusCode: 400 },
  AI_REQUEST_FAILED: { code: 'AI_REQUEST_FAILED', message: 'AI request failed', statusCode: 503 },
  NETWORK_ERROR: { code: 'NETWORK_ERROR', message: 'Network request failed', statusCode: 503 },
  EMPTY_QUESTION: { code: 'EMPTY_QUESTION', message: 'Question is empty', statusCode: 400 },
  QUESTION_TOO_LONG: { code: 'QUESTION_TOO_LONG', message: 'Question too long (max 1000 characters)', statusCode: 400 },
  NO_AI_RESPONSE: { code: 'NO_AI_RESPONSE', message: 'No response from AI model', statusCode: 503 },
  BAD_REQUEST: { code: 'BAD_REQUEST', message: 'Invalid request body', statusCode: 400 },
  INVALID_JSON: { code: 'INVALID_JSON', message: 'Invalid JSON body', statusCode: 400 },
  METHOD_NOT_SUPPORTED: { code: 'METHOD_NOT_SUPPORTED', message: 'Method not supported', statusCode: 405 },
  PLATFORM_NOT_SUPPORTED: { code: 'PLATFORM_NOT_SUPPORTED', message: 'Platform not supported', statusCode: 400 },
  RUN_NOT_FOUND: { code: 'RUN_NOT_FOUND', message: 'No such run or tool call', statusCode: 404 },
  ALREADY_ANSWERED: { code: 'ALREADY_ANSWERED', message: 'This tool call already has a result', statusCode: 409 },
  CANCELLED: { code: 'CANCELLED', message: 'The request was cancelled', statusCode: 499 },
  MEMORY_NOT_FOUND: { code: 'MEMORY_NOT_FOUND', message: 'No such memory', statusCode: 404 },
  MEMORY_FULL: { code: 'MEMORY_FULL', message: 'Memory is full', statusCode: 409 },
  PROVIDER_AUTH_FAILED: { code: 'PROVIDER_AUTH_FAILED', message: 'The provider refused the API key', statusCode: 401 },
  MODEL_NOT_FOUND: { code: 'MODEL_NOT_FOUND', message: "The provider doesn't know this model", statusCode: 400 },
  MODEL_NO_TOOLS: { code: 'MODEL_NO_TOOLS', message: "The model can't call tools, and Allay needs them", statusCode: 400 },
  PROVIDER_URL_REJECTED: { code: 'PROVIDER_URL_REJECTED', message: 'The provider URL must be https and public', statusCode: 400 },
  RATE_LIMITED: { code: 'RATE_LIMITED', message: 'Too many questions from this server', statusCode: 429 },
  LICENSE_REQUIRED: { code: 'LICENSE_REQUIRED', message: "Send the server's license as Authorization: Bearer <license>; a server with its own key gets one free from POST /api/v2/license", statusCode: 401 },
  TOKEN_REQUIRED: { code: 'TOKEN_REQUIRED', message: "This backend wants its PLUGIN_TOKEN as Authorization: Bearer <token> (server.token in the plugin's config.yml)", statusCode: 401 },
  TOKEN_INVALID: { code: 'TOKEN_INVALID', message: "The token doesn't match this backend's PLUGIN_TOKEN", statusCode: 401 },
  TOKEN_NOT_SET: { code: 'TOKEN_NOT_SET', message: "This self-hosted backend has no PLUGIN_TOKEN of at least 24 characters, so it answers no plugin; set one and put it in the plugin's server.token", statusCode: 503 },
  LICENSE_INVALID: { code: 'LICENSE_INVALID', message: 'Unknown or revoked license', statusCode: 401 },
  SUBSCRIPTION_INACTIVE: { code: 'SUBSCRIPTION_INACTIVE', message: "This server's Allay subscription isn't active", statusCode: 402 },
  QUOTA_EXCEEDED: { code: 'QUOTA_EXCEEDED', message: "This server's Allay limit is used up", statusCode: 402 },
  PLAYER_BLOCKED: { code: 'PLAYER_BLOCKED', message: 'This player may not ask Allay on this server', statusCode: 403 },
  CONSENT_REQUIRED: { code: 'CONSENT_REQUIRED', message: "This player hasn't agreed to Allay's notice on this server", statusCode: 403 },
  BILLING_UNAVAILABLE: { code: 'BILLING_UNAVAILABLE', message: 'Payments are not set up on this backend', statusCode: 503 },
} as const;

export const apierror = (baseError: typeof API_ERRORS[keyof typeof API_ERRORS], details?: string): ApiError => ({
  ...baseError,
  message: details ? `${baseError.message}: ${details}` : baseError.message
});

/** An ApiError that can be thrown through async code and caught at the edge. */
export class ApiFailure extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly extra: Pick<ApiError, "resets_at" | "retry_after">;

  constructor(error: ApiError) {
    super(error.message);
    this.code = error.code;
    this.statusCode = error.statusCode ?? 500;
    this.extra = { ...(error.resets_at ? { resets_at: error.resets_at } : {}), ...(error.retry_after ? { retry_after: error.retry_after } : {}) };
  }

  toApiError(): ApiError {
    return { code: this.code, message: this.message, statusCode: this.statusCode, ...this.extra };
  }
}

export const fail = (base: typeof API_ERRORS[keyof typeof API_ERRORS], details?: string): never => {
  throw new ApiFailure(apierror(base, details));
};
