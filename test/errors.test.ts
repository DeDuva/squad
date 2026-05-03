/**
 * Integration tests for error hierarchy and telemetry (M0-9, Issue #85)
 * 
 * Tests error classification, serialization, user messages, and telemetry tracking.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SquadError,
  SDKConnectionError,
  SessionLifecycleError,
  ToolExecutionError,
  ModelAPIError,
  ConfigurationError,
  AuthenticationError,
  RateLimitError,
  RuntimeError,
  ValidationError,
  ErrorFactory,
  ErrorSeverity,
  ErrorCategory,
  TelemetryCollector,
  type ErrorContext,
} from '@deduvafork/squad-sdk/adapter/errors';

describe('SquadError — Base Error', () => {
  it('should construct with all required fields', () => {
    const context: ErrorContext = {
      sessionId: 'session-1',
      agentName: 'Ralph',
      operation: 'test',
      timestamp: new Date(),
    };

    const error = new SquadError(
      'Test error',
      ErrorSeverity.ERROR,
      ErrorCategory.RUNTIME,
      context,
      false
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Test error');
    expect(error.severity).toBe(ErrorSeverity.ERROR);
    expect(error.category).toBe(ErrorCategory.RUNTIME);
    expect(error.context).toEqual(context);
    expect(error.recoverable).toBe(false);
  });

  it('should preserve original error', () => {
    const originalError = new Error('Original error');
    const context: ErrorContext = {
      timestamp: new Date(),
    };

    const error = new SquadError(
      'Wrapped error',
      ErrorSeverity.ERROR,
      ErrorCategory.UNKNOWN,
      context,
      false,
      originalError
    );

    expect(error.originalError).toBe(originalError);
    expect(error.context.originalStack).toBe(originalError.stack);
  });

  it('should serialize to JSON', () => {
    const context: ErrorContext = {
      sessionId: 'session-1',
      agentName: 'Ralph',
      timestamp: new Date(),
    };

    const error = new SquadError(
      'Test error',
      ErrorSeverity.ERROR,
      ErrorCategory.RUNTIME,
      context,
      true
    );

    const json = error.toJSON();

    expect(json.name).toBe('SquadError');
    expect(json.message).toBe('Test error');
    expect(json.severity).toBe(ErrorSeverity.ERROR);
    expect(json.category).toBe(ErrorCategory.RUNTIME);
    expect(json.recoverable).toBe(true);
    expect(json.context).toEqual(context);
  });

  it('should generate user-friendly message without context', () => {
    const error = new SquadError(
      'Test error',
      ErrorSeverity.ERROR,
      ErrorCategory.RUNTIME,
      { timestamp: new Date() },
      false
    );

    expect(error.getUserMessage()).toBe('Test error');
  });

  it('should generate user-friendly message with session context', () => {
    const error = new SquadError(
      'Test error',
      ErrorSeverity.ERROR,
      ErrorCategory.RUNTIME,
      { sessionId: 'session-1', timestamp: new Date() },
      false
    );

    expect(error.getUserMessage()).toContain('Test error');
    expect(error.getUserMessage()).toContain('Session: session-1');
  });

  it('should generate user-friendly message with agent context', () => {
    const error = new SquadError(
      'Test error',
      ErrorSeverity.ERROR,
      ErrorCategory.RUNTIME,
      { agentName: 'Ralph', timestamp: new Date() },
      false
    );

    expect(error.getUserMessage()).toContain('Agent: Ralph');
  });

  it('should include recovery hint for recoverable errors', () => {
    const error = new SquadError(
      'Test error',
      ErrorSeverity.ERROR,
      ErrorCategory.RUNTIME,
      { timestamp: new Date() },
      true
    );

    expect(error.getUserMessage()).toContain('recoverable');
    expect(error.getUserMessage()).toContain('retry');
  });
});

describe('Specific Error Types', () => {
  it('should create SDKConnectionError', () => {
    const error = new SDKConnectionError('Connection failed', { timestamp: new Date() });

    expect(error).toBeInstanceOf(SquadError);
    expect(error.name).toBe('SDKConnectionError');
    expect(error.severity).toBe(ErrorSeverity.ERROR);
    expect(error.category).toBe(ErrorCategory.SDK_CONNECTION);
    expect(error.recoverable).toBe(true);
  });

  it('should create SessionLifecycleError', () => {
    const error = new SessionLifecycleError('Session creation failed', { timestamp: new Date() });

    expect(error.name).toBe('SessionLifecycleError');
    expect(error.category).toBe(ErrorCategory.SESSION_LIFECYCLE);
  });

  it('should create ToolExecutionError', () => {
    const error = new ToolExecutionError('Tool failed', { 
      toolName: 'bash',
      timestamp: new Date() 
    });

    expect(error.name).toBe('ToolExecutionError');
    expect(error.category).toBe(ErrorCategory.TOOL_EXECUTION);
    expect(error.recoverable).toBe(false);
  });

  it('should create ModelAPIError', () => {
    const error = new ModelAPIError('Model API failed', {
      model: 'claude-sonnet-4.5',
      timestamp: new Date()
    });

    expect(error.name).toBe('ModelAPIError');
    expect(error.category).toBe(ErrorCategory.MODEL_API);
    expect(error.recoverable).toBe(true);
  });

  it('should create ConfigurationError', () => {
    const error = new ConfigurationError('Invalid config', { timestamp: new Date() });

    expect(error.name).toBe('ConfigurationError');
    expect(error.category).toBe(ErrorCategory.CONFIGURATION);
    expect(error.recoverable).toBe(false);
  });

  it('should create AuthenticationError', () => {
    const error = new AuthenticationError('Auth failed', { timestamp: new Date() });

    expect(error.name).toBe('AuthenticationError');
    expect(error.severity).toBe(ErrorSeverity.CRITICAL);
    expect(error.category).toBe(ErrorCategory.AUTH);
  });

  it('should create RateLimitError', () => {
    const error = new RateLimitError('Rate limit exceeded', { timestamp: new Date() }, 60);

    expect(error.name).toBe('RateLimitError');
    expect(error.severity).toBe(ErrorSeverity.WARNING);
    expect(error.category).toBe(ErrorCategory.RATE_LIMIT);
    expect(error.retryAfter).toBe(60);
  });

  it('should create RuntimeError', () => {
    const error = new RuntimeError('Runtime failure', { timestamp: new Date() });

    expect(error.name).toBe('RuntimeError');
    expect(error.severity).toBe(ErrorSeverity.CRITICAL);
    expect(error.category).toBe(ErrorCategory.RUNTIME);
  });

  it('should create ValidationError', () => {
    const error = new ValidationError('Invalid input', { timestamp: new Date() });

    expect(error.name).toBe('ValidationError');
    expect(error.category).toBe(ErrorCategory.VALIDATION);
  });
});

describe('RateLimitError', () => {
  it('should include retry-after in user message', () => {
    const error = new RateLimitError('Rate limit exceeded', { timestamp: new Date() }, 120);

    const message = error.getUserMessage();
    expect(message).toContain('Retry after 120 seconds');
  });

  it('should handle missing retry-after', () => {
    const error = new RateLimitError('Rate limit exceeded', { timestamp: new Date() });

    const message = error.getUserMessage();
    expect(message).not.toContain('Retry after');
  });
});

describe('ErrorFactory', () => {
  it('should wrap connection error', () => {
    const originalError = new Error('ECONNREFUSED: Connection refused');
    const error = ErrorFactory.wrap(originalError, { operation: 'connect' });

    expect(error).toBeInstanceOf(SDKConnectionError);
    expect(error.message).toContain('ECONNREFUSED');
    expect(error.originalError).toBe(originalError);
  });

  it('should wrap ETIMEDOUT error', () => {
    const originalError = new Error('ETIMEDOUT: Connection timed out');
    const error = ErrorFactory.wrap(originalError, { operation: 'connect' });

    expect(error).toBeInstanceOf(SDKConnectionError);
  });

  it('should wrap session creation error', () => {
    const originalError = new Error('Failed to create session');
    const error = ErrorFactory.wrap(originalError, { 
      operation: 'createSession',
      sessionId: 'session-1'
    });

    expect(error).toBeInstanceOf(SessionLifecycleError);
    expect(error.recoverable).toBe(true);
  });

  it('should wrap session resume error', () => {
    const originalError = new Error('Failed to resume session');
    const error = ErrorFactory.wrap(originalError, { operation: 'resumeSession' });

    expect(error).toBeInstanceOf(SessionLifecycleError);
  });

  it('should wrap authentication error', () => {
    const originalError = new Error('Unauthorized: Invalid token');
    const error = ErrorFactory.wrap(originalError, { operation: 'auth' });

    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.severity).toBe(ErrorSeverity.CRITICAL);
  });

  it('should wrap rate limit error', () => {
    const originalError = new Error('quota exceeded. retry after 60');
    const error = ErrorFactory.wrap(originalError, { operation: 'api_call' });

    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfter).toBe(60);
  });

  it('should wrap 429 error as rate limit', () => {
    const originalError = new Error('HTTP 429: Too many requests');
    const error = ErrorFactory.wrap(originalError, { operation: 'api_call' });

    expect(error).toBeInstanceOf(RateLimitError);
  });

  it('should wrap model API error', () => {
    const originalError = new Error('Model API error: Invalid request');
    const error = ErrorFactory.wrap(originalError, {
      operation: 'inference',
      model: 'claude-sonnet-4.5'
    });

    expect(error).toBeInstanceOf(ModelAPIError);
    expect(error.recoverable).toBe(true);
  });

  it('should wrap configuration error', () => {
    const originalError = new Error('Invalid config: missing required field');
    const error = ErrorFactory.wrap(originalError, { operation: 'init' });

    expect(error).toBeInstanceOf(ConfigurationError);
  });

  it('should wrap tool execution error when toolName is present', () => {
    const originalError = new Error('Command failed with exit code 1');
    const error = ErrorFactory.wrap(originalError, {
      operation: 'tool_call',
      toolName: 'bash'
    });

    expect(error).toBeInstanceOf(ToolExecutionError);
    expect(error.context.toolName).toBe('bash');
  });

  it('should default to generic SquadError for unknown errors', () => {
    const originalError = new Error('Something went wrong');
    const error = ErrorFactory.wrap(originalError, { operation: 'unknown' });

    expect(error).toBeInstanceOf(SquadError);
    expect(error.category).toBe(ErrorCategory.UNKNOWN);
  });

  it('should handle non-Error objects', () => {
    const error = ErrorFactory.wrap('String error', { operation: 'test' });

    expect(error).toBeInstanceOf(SquadError);
    expect(error.message).toBe('String error');
  });

  it('should handle null/undefined errors', () => {
    const error = ErrorFactory.wrap(undefined, { operation: 'test' });

    expect(error).toBeInstanceOf(SquadError);
  });
});

describe('TelemetryCollector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should construct without handlers', () => {
    const telemetry = new TelemetryCollector();
    expect(telemetry).toBeDefined();
  });

  it('should register and call data handler on success', () => {
    const telemetry = new TelemetryCollector();
    const handler = vi.fn();
    telemetry.onData(handler);

    const stopwatch = telemetry.start('test.operation', { sessionId: 'session-1' });
    stopwatch.success();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'test.operation',
        success: true,
        sessionId: 'session-1',
        duration: expect.any(Number),
      })
    );
  });

  it('should register and call data handler on failure', () => {
    const telemetry = new TelemetryCollector();
    const handler = vi.fn();
    telemetry.onData(handler);

    const stopwatch = telemetry.start('test.operation');
    const error = new SDKConnectionError('Connection failed', { timestamp: new Date() });
    stopwatch.failure(error);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'test.operation',
        success: false,
        errorCategory: ErrorCategory.SDK_CONNECTION,
        duration: expect.any(Number),
      })
    );
  });

  it('should track duration accurately', async () => {
    const telemetry = new TelemetryCollector();
    const handler = vi.fn();
    telemetry.onData(handler);

    const stopwatch = telemetry.start('test.delay');
    await new Promise(resolve => setTimeout(resolve, 50));
    stopwatch.success();

    const call = handler.mock.calls[0][0];
    expect(call.duration).toBeGreaterThanOrEqual(40); // Allow some variance
  });

  it('should return unsubscribe function', () => {
    const telemetry = new TelemetryCollector();
    const handler = vi.fn();
    const unsubscribe = telemetry.onData(handler);

    expect(unsubscribe).toBeInstanceOf(Function);

    unsubscribe();
    const stopwatch = telemetry.start('test.operation');
    stopwatch.success();

    expect(handler).not.toHaveBeenCalled();
  });

  it('should support multiple handlers', () => {
    const telemetry = new TelemetryCollector();
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    telemetry.onData(handler1);
    telemetry.onData(handler2);

    const stopwatch = telemetry.start('test.operation');
    stopwatch.success();

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it('should isolate handler errors', () => {
    const telemetry = new TelemetryCollector();
    const failingHandler = vi.fn(() => { throw new Error('Handler failed'); });
    const successHandler = vi.fn();
    
    telemetry.onData(failingHandler);
    telemetry.onData(successHandler);

    const stopwatch = telemetry.start('test.operation');
    stopwatch.success();

    expect(failingHandler).toHaveBeenCalled();
    expect(successHandler).toHaveBeenCalled();
  });

  it('should handle async handlers', async () => {
    const telemetry = new TelemetryCollector();
    const handler = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    telemetry.onData(handler);

    const stopwatch = telemetry.start('test.operation');
    stopwatch.success();

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should include metadata in telemetry points', () => {
    const telemetry = new TelemetryCollector();
    const handler = vi.fn();
    telemetry.onData(handler);

    const stopwatch = telemetry.start('test.operation', {
      sessionId: 'session-1',
      agentName: 'Ralph',
      metadata: { custom: 'data' }
    });
    stopwatch.success();

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        agentName: 'Ralph',
        metadata: { custom: 'data' }
      })
    );
  });

  it('should clear all handlers', () => {
    const telemetry = new TelemetryCollector();
    const handler = vi.fn();
    telemetry.onData(handler);

    telemetry.clear();

    const stopwatch = telemetry.start('test.operation');
    stopwatch.success();

    expect(handler).not.toHaveBeenCalled();
  });

  it('should categorize unknown errors as UNKNOWN', () => {
    const telemetry = new TelemetryCollector();
    const handler = vi.fn();
    telemetry.onData(handler);

    const stopwatch = telemetry.start('test.operation');
    stopwatch.failure(new Error('Generic error'));

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCategory: ErrorCategory.UNKNOWN
      })
    );
  });
});
