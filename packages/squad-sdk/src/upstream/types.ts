/**
 * Upstream types — configuration and resolved state for upstream Squad sources.
 *
 * An upstream is another Squad repo (org-level, team-level, or any repo with .squad/)
 * whose context (skills, decisions, wisdom, casting policy, routing) is read live
 * by the coordinator at session start.
 *
 * @module upstream/types
 */

/** Source type for an upstream Squad repo. */
export type UpstreamType = 'local' | 'git' | 'export';

/** A declared upstream source from upstream.json. */
export interface UpstreamSource {
  /** Display name for this upstream (e.g., "org", "team-platform"). */
  name: string;
  /** How to access this upstream. */
  type: UpstreamType;
  /** Path, URL, or export file location. */
  source: string;
  /** Git ref to use (only for type: "git"). */
  ref?: string;
  /** ISO timestamp of when this upstream was added. */
  added_at: string;
  /** ISO timestamp of last successful sync/validation. */
  last_synced: string | null;
}

/** The upstream.json config file format. */
export interface UpstreamConfig {
  upstreams: UpstreamSource[];
}

/** Resolved content from a single upstream source. */
export interface ResolvedUpstream {
  /** Name from the config. */
  name: string;
  /** Source type. */
  type: UpstreamType;
  /** Skills found in this upstream. */
  skills: Array<{ name: string; content: string }>;
  /** Decisions markdown content, or null if not found. */
  decisions: string | null;
  /** Wisdom markdown content, or null if not found. */
  wisdom: string | null;
  /** Casting policy object, or null if not found. */
  castingPolicy: Record<string, unknown> | null;
  /** Routing markdown content, or null if not found. */
  routing: string | null;
}

/** Result of resolving all upstreams for a squad directory. */
export interface UpstreamResolution {
  upstreams: ResolvedUpstream[];
}
