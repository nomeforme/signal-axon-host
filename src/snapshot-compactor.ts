/**
 * Snapshot Compactor
 *
 * Compacts a snapshot file by keeping only facets referenced by recent frames.
 * Can be run as a subprocess to isolate memory usage from the main process.
 *
 * Usage: tsx src/snapshot-compactor.ts [snapshotDir] [maxFrames]
 */

import { readFile, writeFile, rename, stat, readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fork } from 'child_process';

interface CompactionConfig {
  maxFrames: number;  // Keep facets referenced by last N frames
  snapshotPath: string;
  outputPath?: string;  // If not provided, overwrites original
}

interface CompactionResult {
  originalFacets: number;
  keptFacets: number;
  originalSize: number;
  compactedSize: number;
  referencedFacetIds: Set<string>;
}

/**
 * Extract facet IDs referenced by frames in deltas
 */
function extractFacetIdsFromFrames(frames: any[]): Set<string> {
  const facetIds = new Set<string>();

  for (const frame of frames) {
    // Check deltas array
    if (frame.deltas && Array.isArray(frame.deltas)) {
      for (const delta of frame.deltas) {
        if (delta.type === 'addFacet' && delta.facet?.id) {
          facetIds.add(delta.facet.id);
        } else if (delta.type === 'rewriteFacet' && delta.id) {
          facetIds.add(delta.id);
        } else if (delta.type === 'removeFacet' && delta.id) {
          facetIds.add(delta.id);
        }
      }
    }

    // Check transition.veilOps for older format
    if (frame.transition?.veilOps && Array.isArray(frame.transition.veilOps)) {
      for (const op of frame.transition.veilOps) {
        if (op.type === 'addFacet' && op.facet?.id) {
          facetIds.add(op.facet.id);
        } else if (op.type === 'rewriteFacet' && op.id) {
          facetIds.add(op.id);
        } else if (op.type === 'removeFacet' && op.id) {
          facetIds.add(op.id);
        }
      }
    }

    // Check events for facet references
    if (frame.events && Array.isArray(frame.events)) {
      for (const event of frame.events) {
        if (event.payload?.facetId) {
          facetIds.add(event.payload.facetId);
        }
        if (event.payload?.facet?.id) {
          facetIds.add(event.payload.facet.id);
        }
      }
    }
  }

  return facetIds;
}

/**
 * Also include parent facet IDs (facets can have children relationships)
 */
function expandWithParentFacets(facetIds: Set<string>, facets: Array<[string, any]>): Set<string> {
  const expanded = new Set(facetIds);

  // Build a map of child -> parent relationships
  const childToParent = new Map<string, string>();
  for (const [id, facet] of facets) {
    if (facet.parentId) {
      childToParent.set(id, facet.parentId);
    }
    // Also check for children array and include those
    if (facet.children && Array.isArray(facet.children)) {
      for (const childId of facet.children) {
        if (typeof childId === 'string') {
          childToParent.set(childId, id);
        }
      }
    }
  }

  // For each referenced facet, also include its parents
  for (const id of facetIds) {
    let current = id;
    while (childToParent.has(current)) {
      const parent = childToParent.get(current)!;
      expanded.add(parent);
      current = parent;
    }
  }

  return expanded;
}

/**
 * Load frame bucket files to get full frame history
 */
async function loadFrameBuckets(snapshotDir: string, bucketRefs: any[]): Promise<any[]> {
  const frames: any[] = [];

  for (const ref of bucketRefs) {
    const bucketPath = join(snapshotDir, 'buckets', ref.hash + '.json');
    try {
      const data = await readFile(bucketPath, 'utf-8');
      const bucket = JSON.parse(data);
      if (bucket.frames && Array.isArray(bucket.frames)) {
        frames.push(...bucket.frames);
      }
    } catch (err) {
      console.warn(`[Compactor] Could not load bucket ${ref.hash}: ${err}`);
    }
  }

  return frames;
}

/**
 * Compact a snapshot file, keeping only facets referenced by recent frames
 */
export async function compactSnapshot(config: CompactionConfig): Promise<CompactionResult> {
  const { maxFrames, snapshotPath } = config;
  const outputPath = config.outputPath || snapshotPath;
  const snapshotDir = dirname(snapshotPath);

  console.log(`[Compactor] Starting compaction of ${snapshotPath}`);
  console.log(`[Compactor] Keeping facets from last ${maxFrames} frames`);

  // Get original file size
  const originalStat = await stat(snapshotPath);
  const originalSize = originalStat.size;
  console.log(`[Compactor] Original snapshot size: ${(originalSize / 1024 / 1024).toFixed(2)} MB`);

  // Step 1: Load the snapshot (we need to parse it to get frames and facets structure)
  // For now, do a regular JSON parse but we could optimize this later with streaming
  console.log(`[Compactor] Loading snapshot...`);
  const snapshotData = await readFile(snapshotPath, 'utf-8');
  const snapshot = JSON.parse(snapshotData);

  // Step 2: Get frames - either from frameHistory or from buckets
  let frames: any[] = [];
  if (snapshot.veilState?.frameHistory && Array.isArray(snapshot.veilState.frameHistory)) {
    frames = snapshot.veilState.frameHistory;
    console.log(`[Compactor] Found ${frames.length} frames in frameHistory`);
  }

  if (snapshot.veilState?.frameBucketRefs && Array.isArray(snapshot.veilState.frameBucketRefs)) {
    const bucketFrames = await loadFrameBuckets(snapshotDir, snapshot.veilState.frameBucketRefs);
    frames = [...frames, ...bucketFrames];
    console.log(`[Compactor] Loaded ${bucketFrames.length} frames from buckets, total: ${frames.length}`);
  }

  // Step 3: Get facets referenced by last N frames
  const recentFrames = frames.slice(-maxFrames);
  console.log(`[Compactor] Analyzing last ${recentFrames.length} frames for facet references`);

  let referencedFacetIds = extractFacetIdsFromFrames(recentFrames);
  console.log(`[Compactor] Found ${referencedFacetIds.size} directly referenced facets`);

  // Step 4: Expand to include parent facets
  const originalFacets = snapshot.veilState?.facets || [];
  referencedFacetIds = expandWithParentFacets(referencedFacetIds, originalFacets);
  console.log(`[Compactor] After parent expansion: ${referencedFacetIds.size} facets`);

  // Also keep certain facet types that are always needed
  const alwaysKeepTypes = new Set(['element-tree', 'host-state', 'config', 'agent-config']);

  // Step 5: Filter facets
  const keptFacets: Array<[string, any]> = [];
  let skippedCount = 0;

  for (const [id, facet] of originalFacets) {
    const shouldKeep = referencedFacetIds.has(id) ||
                       alwaysKeepTypes.has(facet.type) ||
                       facet.type?.startsWith('element-') ||
                       facet.type?.startsWith('component-');

    if (shouldKeep) {
      keptFacets.push([id, facet]);
    } else {
      skippedCount++;
    }
  }

  console.log(`[Compactor] Keeping ${keptFacets.length} facets, removing ${skippedCount}`);

  // Step 6: Create compacted snapshot
  const compactedSnapshot = {
    ...snapshot,
    veilState: {
      ...snapshot.veilState,
      facets: keptFacets,
      // Keep only recent frames in memory
      frameHistory: recentFrames
    },
    _compaction: {
      timestamp: new Date().toISOString(),
      originalFacets: originalFacets.length,
      keptFacets: keptFacets.length,
      maxFrames
    }
  };

  // Step 7: Write compacted snapshot
  const tempPath = outputPath + '.tmp';
  await writeFile(tempPath, JSON.stringify(compactedSnapshot, null, 2));

  // Get compacted size
  const compactedStat = await stat(tempPath);
  const compactedSize = compactedStat.size;

  // Rename temp to final
  await rename(tempPath, outputPath);

  console.log(`[Compactor] Compacted snapshot size: ${(compactedSize / 1024 / 1024).toFixed(2)} MB`);
  console.log(`[Compactor] Reduction: ${((1 - compactedSize / originalSize) * 100).toFixed(1)}%`);

  return {
    originalFacets: originalFacets.length,
    keptFacets: keptFacets.length,
    originalSize,
    compactedSize,
    referencedFacetIds
  };
}

/**
 * Find the latest snapshot file in a directory
 */
export async function findLatestSnapshot(snapshotDir: string): Promise<string | null> {
  const { readdir } = await import('fs/promises');

  try {
    const files = await readdir(snapshotDir);
    const snapshotFiles = files
      .filter(f => f.startsWith('snapshot-') && f.endsWith('.json'))
      .sort((a, b) => {
        // Parse sequence numbers from filenames like "snapshot-3038-1766674329616.json"
        const seqA = parseInt(a.split('-')[1]) || 0;
        const seqB = parseInt(b.split('-')[1]) || 0;
        return seqB - seqA;  // Descending order
      });

    if (snapshotFiles.length === 0) return null;
    return join(snapshotDir, snapshotFiles[0]);
  } catch (err) {
    return null;
  }
}

// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const snapshotDir = args[0] || './signal-bot-state/snapshots';
  const maxFrames = parseInt(args[1]) || 200;

  (async () => {
    const latestSnapshot = await findLatestSnapshot(snapshotDir);
    if (!latestSnapshot) {
      console.error('No snapshot found in', snapshotDir);
      process.exit(1);
    }

    console.log(`Found latest snapshot: ${latestSnapshot}`);

    try {
      const result = await compactSnapshot({
        snapshotPath: latestSnapshot,
        maxFrames
      });

      console.log('\nCompaction complete:');
      console.log(`  Facets: ${result.originalFacets} -> ${result.keptFacets}`);
      console.log(`  Size: ${(result.originalSize / 1024 / 1024).toFixed(2)} MB -> ${(result.compactedSize / 1024 / 1024).toFixed(2)} MB`);
    } catch (err) {
      console.error('Compaction failed:', err);
      process.exit(1);
    }
  })();
}
