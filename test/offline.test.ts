/**
 * Offline Mode Tests — graceful degradation
 * Issue #142 (M5-14)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  detectConnectivity,
  OfflineManager,
  type PendingOperation,
} from '@deduvafork/squad-sdk/runtime/offline';

// --- Helpers ---

function makeOp(overrides: Partial<PendingOperation> = {}): PendingOperation {
  return {
    id: overrides.id ?? 'op-1',
    type: overrides.type ?? 'publish',
    payload: overrides.payload ?? { name: 'test' },
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    retries: overrides.retries ?? 0,
  };
}

// ============================================================================
// detectConnectivity
// ============================================================================

describe('detectConnectivity', () => {
  it('should return online with no checker', async () => {
    const status = await detectConnectivity();
    expect(status).toBe('online');
  });

  it('should return online when checker succeeds', async () => {
    const status = await detectConnectivity(async () => true);
    expect(status).toBe('online');
  });

  it('should return offline when checker returns false', async () => {
    const status = await detectConnectivity(async () => false);
    expect(status).toBe('offline');
  });

  it('should return offline when checker throws', async () => {
    const status = await detectConnectivity(async () => { throw new Error('fail'); });
    expect(status).toBe('offline');
  });
});

// ============================================================================
// OfflineManager
// ============================================================================

describe('OfflineManager', () => {
  let mgr: OfflineManager;

  beforeEach(() => {
    mgr = new OfflineManager();
  });

  describe('getOfflineCapabilities', () => {
    it('should report all capabilities online', () => {
      const caps = mgr.getOfflineCapabilities();
      expect(caps.localAgents).toBe(true);
      expect(caps.cachedSkills).toBe(true);
      expect(caps.configEditing).toBe(true);
      expect(caps.marketplaceBrowse).toBe(true);
      expect(caps.publishing).toBe(true);
      expect(caps.remoteAgents).toBe(true);
    });

    it('should limit capabilities when offline', () => {
      mgr.setConnectivity('offline');
      const caps = mgr.getOfflineCapabilities();
      expect(caps.localAgents).toBe(true);
      expect(caps.publishing).toBe(false);
      expect(caps.remoteAgents).toBe(false);
      expect(caps.marketplaceBrowse).toBe(false);
    });

    it('should allow browse in degraded mode', () => {
      mgr.setConnectivity('degraded');
      const caps = mgr.getOfflineCapabilities();
      expect(caps.marketplaceBrowse).toBe(true);
      expect(caps.publishing).toBe(false);
    });
  });

  describe('queueForSync', () => {
    it('should queue an operation', () => {
      mgr.queueForSync(makeOp());
      expect(mgr.getOfflineStatus().pendingOps).toBe(1);
    });

    it('should queue multiple operations', () => {
      mgr.queueForSync(makeOp({ id: 'a' }));
      mgr.queueForSync(makeOp({ id: 'b' }));
      expect(mgr.getOfflineStatus().pendingOps).toBe(2);
    });
  });

  describe('syncPending', () => {
    it('should not sync when offline', async () => {
      mgr.setConnectivity('offline');
      mgr.queueForSync(makeOp());
      const result = await mgr.syncPending();
      expect(result.synced).toBe(0);
      expect(result.remaining).toBe(1);
    });

    it('should sync all ops when online', async () => {
      mgr.queueForSync(makeOp({ id: 'a' }));
      mgr.queueForSync(makeOp({ id: 'b' }));
      const result = await mgr.syncPending();
      expect(result.synced).toBe(2);
      expect(result.remaining).toBe(0);
    });

    it('should handle sync handler failures', async () => {
      const mgr2 = new OfflineManager({
        syncHandler: async (op) => op.id !== 'fail',
      });
      mgr2.queueForSync(makeOp({ id: 'ok' }));
      mgr2.queueForSync(makeOp({ id: 'fail' }));
      const result = await mgr2.syncPending();
      expect(result.synced).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.remaining).toBe(1);
    });

    it('should update lastSync after sync', async () => {
      mgr.queueForSync(makeOp());
      expect(mgr.getOfflineStatus().lastSync).toBeNull();
      await mgr.syncPending();
      expect(mgr.getOfflineStatus().lastSync).not.toBeNull();
    });

    it('should increment retries on failed ops', async () => {
      const mgr2 = new OfflineManager({
        syncHandler: async () => false,
      });
      mgr2.queueForSync(makeOp({ id: 'x', retries: 0 }));
      await mgr2.syncPending();
      const pending = mgr2.getPendingOperations();
      expect(pending[0].retries).toBe(1);
    });
  });

  describe('getOfflineStatus', () => {
    it('should return default status', () => {
      const status = mgr.getOfflineStatus();
      expect(status.connectivity).toBe('online');
      expect(status.pendingOps).toBe(0);
      expect(status.lastSync).toBeNull();
      expect(status.cachedAgents).toEqual([]);
    });

    it('should reflect cached agents', () => {
      mgr.addCachedAgent('ralph');
      mgr.addCachedAgent('fenster');
      expect(mgr.getOfflineStatus().cachedAgents).toEqual(['ralph', 'fenster']);
    });

    it('should not duplicate cached agents', () => {
      mgr.addCachedAgent('ralph');
      mgr.addCachedAgent('ralph');
      expect(mgr.getOfflineStatus().cachedAgents).toEqual(['ralph']);
    });
  });

  describe('refreshConnectivity', () => {
    it('should update connectivity from checker', async () => {
      const mgr2 = new OfflineManager({
        connectivityChecker: async () => false,
      });
      const status = await mgr2.refreshConnectivity();
      expect(status).toBe('offline');
      expect(mgr2.getOfflineStatus().connectivity).toBe('offline');
    });
  });

  describe('clearPending', () => {
    it('should clear all pending operations', () => {
      mgr.queueForSync(makeOp({ id: 'a' }));
      mgr.queueForSync(makeOp({ id: 'b' }));
      mgr.clearPending();
      expect(mgr.getOfflineStatus().pendingOps).toBe(0);
    });
  });

  describe('constructor with options', () => {
    it('should accept initial cached agents', () => {
      const mgr2 = new OfflineManager({ cachedAgents: ['a', 'b'] });
      expect(mgr2.getOfflineStatus().cachedAgents).toEqual(['a', 'b']);
    });
  });
});
