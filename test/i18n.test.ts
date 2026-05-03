/**
 * Tests for i18n and accessibility modules
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  I18nManager,
  defaultCatalog,
  auditAccessibility,
  type MessageCatalog,
  type AccessibilityReport,
} from '@deduvafork/squad-sdk/runtime/i18n';
import type { SquadConfig } from '@deduvafork/squad-sdk/config';

function makeConfig(overrides: Partial<SquadConfig> = {}): SquadConfig {
  return {
    version: '1.0.0',
    team: { name: 'Test Team' },
    routing: { rules: [] },
    models: { default: 'claude-sonnet-4.5', defaultTier: 'standard', tiers: {} },
    agents: [],
    ...overrides,
  };
}

describe('I18nManager', () => {
  let i18n: I18nManager;

  beforeEach(() => {
    i18n = new I18nManager();
  });

  it('should default to en locale', () => {
    expect(i18n.getLocale()).toBe('en');
  });

  it('should list available locales', () => {
    expect(i18n.getAvailableLocales()).toEqual(['en']);
  });

  it('should format a simple message without params', () => {
    expect(i18n.formatMessage('config.valid')).toBe('Configuration is valid.');
  });

  it('should interpolate params into a message', () => {
    const result = i18n.formatMessage('cli.version', { version: '0.6.0' });
    expect(result).toBe('squad 0.6.0');
  });

  it('should leave unknown placeholders intact', () => {
    const result = i18n.formatMessage('cli.version', {});
    expect(result).toBe('squad {version}');
  });

  it('should return the raw key when message is not found', () => {
    expect(i18n.formatMessage('nonexistent.key')).toBe('nonexistent.key');
  });

  it('should register and switch to a new locale', () => {
    const frCatalog: MessageCatalog = { 'config.valid': 'La configuration est valide.' };
    i18n.registerCatalog('fr', frCatalog);
    i18n.setLocale('fr');
    expect(i18n.getLocale()).toBe('fr');
    expect(i18n.formatMessage('config.valid')).toBe('La configuration est valide.');
  });

  it('should fall back to en when key is missing in active locale', () => {
    const frCatalog: MessageCatalog = { 'config.valid': 'Valide.' };
    i18n.registerCatalog('fr', frCatalog);
    i18n.setLocale('fr');
    expect(i18n.formatMessage('cli.version', { version: '1.0' })).toBe('squad 1.0');
  });

  it('should throw when setting an unregistered locale', () => {
    expect(() => i18n.setLocale('zz')).toThrow('No catalog registered for locale: zz');
  });

  it('should list multiple locales after registration', () => {
    i18n.registerCatalog('fr', {});
    i18n.registerCatalog('de', {});
    expect(i18n.getAvailableLocales()).toEqual(['en', 'fr', 'de']);
  });

  it('should interpolate multiple params', () => {
    const result = i18n.formatMessage('agent.spawned', { name: 'Keaton', model: 'opus' });
    expect(result).toBe('Agent Keaton spawned with model opus.');
  });

  it('should handle messages with no placeholders and params provided', () => {
    const result = i18n.formatMessage('config.valid', { unused: 'val' });
    expect(result).toBe('Configuration is valid.');
  });

  it('should allow overriding the en catalog', () => {
    i18n.registerCatalog('en', { 'config.valid': 'All good.' });
    expect(i18n.formatMessage('config.valid')).toBe('All good.');
  });

  it('should accept locale in constructor', () => {
    const custom = new I18nManager('en');
    expect(custom.getLocale()).toBe('en');
  });
});

describe('defaultCatalog', () => {
  it('should contain all expected top-level categories', () => {
    const keys = Object.keys(defaultCatalog);
    const categories = new Set(keys.map((k) => k.split('.')[0]));
    expect(categories).toContain('cli');
    expect(categories).toContain('config');
    expect(categories).toContain('routing');
    expect(categories).toContain('agent');
    expect(categories).toContain('migration');
    expect(categories).toContain('error');
    expect(categories).toContain('info');
  });

  it('should have non-empty string values for every key', () => {
    for (const [key, value] of Object.entries(defaultCatalog)) {
      expect(value, `Key "${key}" should be a non-empty string`).toBeTruthy();
      expect(typeof value).toBe('string');
    }
  });
});

describe('auditAccessibility', () => {
  it('should pass for a config with display names on all agents', () => {
    const config = makeConfig({
      agents: [{ name: 'keaton', role: 'lead', displayName: 'Keaton (Lead)' }],
    });
    const report = auditAccessibility(config);
    expect(report.passed).toBe(true);
  });

  it('should warn when an agent has no displayName', () => {
    const config = makeConfig({
      agents: [{ name: 'keaton', role: 'lead' }],
    });
    const report = auditAccessibility(config);
    const screenReaderFindings = report.findings.filter((f) => f.category === 'screen-reader');
    expect(screenReaderFindings.length).toBeGreaterThan(0);
    expect(screenReaderFindings[0].severity).toBe('warning');
  });

  it('should always include color-contrast info finding', () => {
    const report = auditAccessibility(makeConfig());
    expect(report.findings.some((f) => f.category === 'color-contrast')).toBe(true);
  });

  it('should always include verbose-mode info finding', () => {
    const report = auditAccessibility(makeConfig());
    expect(report.findings.some((f) => f.category === 'verbose-mode')).toBe(true);
  });

  it('should always include keyboard-nav info finding', () => {
    const report = auditAccessibility(makeConfig());
    expect(report.findings.some((f) => f.category === 'keyboard-nav')).toBe(true);
  });

  it('should return passed=true when no error-severity findings', () => {
    const report = auditAccessibility(makeConfig());
    expect(report.passed).toBe(true);
    expect(report.findings.every((f) => f.severity !== 'error')).toBe(true);
  });
});
