/**
 * Classifies AI SDK's structured error types into Squad's SquadError
 * hierarchy before falling through to ErrorFactory.wrap's message-based
 * pattern matching. Keeps errors.ts provider-agnostic while giving accurate
 * categorization (rate limits, auth) now that two live providers exist.
 *
 * @module adapter/ai-sdk-errors
 */

import { APICallError, LoadAPIKeyError } from 'ai';
import { ErrorFactory, RateLimitError, AuthenticationError, ModelAPIError, type ErrorContext, type SquadError } from './errors.js';

export function wrapAiSdkError(error: unknown, context: Partial<ErrorContext>): SquadError {
  const fullContext: ErrorContext = { timestamp: new Date(), ...context };

  if (error instanceof LoadAPIKeyError) {
    return new AuthenticationError(`API key error: ${error.message}`, fullContext, error);
  }

  if (error instanceof APICallError) {
    if (error.statusCode === 429) {
      const retryMatch = error.responseHeaders?.['retry-after']
        ? parseInt(error.responseHeaders['retry-after'], 10)
        : undefined;
      return new RateLimitError(`Rate limit exceeded: ${error.message}`, fullContext, retryMatch, error);
    }
    if (error.statusCode === 401 || error.statusCode === 403) {
      return new AuthenticationError(`Authentication failed: ${error.message}`, fullContext, error);
    }
    return new ModelAPIError(`Model API error: ${error.message}`, fullContext, error.isRetryable, error);
  }

  return ErrorFactory.wrap(error, context);
}
