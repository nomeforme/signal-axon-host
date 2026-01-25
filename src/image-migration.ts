/**
 * Image Migration Script
 *
 * Compresses existing images in facets to reduce snapshot size.
 * Runs once at startup if migration hasn't been completed.
 * Uses streaming JSON write to avoid OOM on large snapshots.
 */

import sharp from 'sharp';
import { createWriteStream } from 'fs';
import { readFile, writeFile, stat, rename } from 'fs/promises';
import { join } from 'path';

// Same settings as signal-afferent
const IMAGE_MAX_DIMENSION = 1024;
const IMAGE_JPEG_QUALITY = 80;

interface MigrationResult {
  facetsProcessed: number;
  imagesCompressed: number;
  bytesSaved: number;
  errors: number;
}

/**
 * Detect image type from base64 data
 */
function detectImageType(base64Data: string): string | null {
  try {
    const buffer = Buffer.from(base64Data.slice(0, 32), 'base64');

    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
      return 'png';
    }
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
      return 'jpeg';
    }
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
      return 'gif';
    }
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
        buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
      return 'webp';
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Compress an image buffer
 */
async function compressImage(buffer: Buffer): Promise<Buffer | null> {
  try {
    const metadata = await sharp(buffer).metadata();
    const { width, height, format } = metadata;

    if (!width || !height) {
      return null;
    }

    const maxDim = Math.max(width, height);
    const needsResize = maxDim > IMAGE_MAX_DIMENSION;

    // Skip if already optimized
    if (!needsResize && format === 'jpeg') {
      return buffer;
    }

    let pipeline = sharp(buffer);

    if (needsResize) {
      pipeline = pipeline.resize(IMAGE_MAX_DIMENSION, IMAGE_MAX_DIMENSION, {
        fit: 'inside',
        withoutEnlargement: true
      });
    }

    return await pipeline.jpeg({ quality: IMAGE_JPEG_QUALITY }).toBuffer();
  } catch (error) {
    console.error('[ImageMigration] Compression error:', error);
    return null;
  }
}

/**
 * Process a single facet's attachments
 */
async function processFacetAttachments(facet: any): Promise<{ compressed: number; saved: number }> {
  let compressed = 0;
  let saved = 0;

  // Check for attachments in the facet (stored in state.metadata.attachments)
  const attachments = facet.attachments || facet.state?.attachments || facet.state?.metadata?.attachments;
  if (!attachments || !Array.isArray(attachments)) {
    return { compressed, saved };
  }

  for (const attachment of attachments) {
    if (!attachment.data || typeof attachment.data !== 'string') {
      continue;
    }

    // Check if it's an image
    const imageType = detectImageType(attachment.data);
    if (!imageType) {
      continue;
    }

    try {
      const originalBuffer = Buffer.from(attachment.data, 'base64');
      const originalSize = originalBuffer.length;

      const compressedBuffer = await compressImage(originalBuffer);
      if (!compressedBuffer) {
        continue;
      }

      const newSize = compressedBuffer.length;

      // Only update if we actually saved space
      if (newSize < originalSize) {
        attachment.data = compressedBuffer.toString('base64');
        attachment.contentType = 'image/jpeg';
        compressed++;
        saved += originalSize - newSize;
        console.log(`[ImageMigration] Compressed ${imageType}: ${originalSize} -> ${newSize} bytes (saved ${Math.round((1 - newSize/originalSize) * 100)}%)`);
      }
    } catch (error) {
      console.error('[ImageMigration] Error processing attachment:', error);
    }
  }

  return { compressed, saved };
}

/**
 * Find the latest snapshot file
 */
async function findLatestSnapshot(snapshotDir: string): Promise<string | null> {
  const { readdir } = await import('fs/promises');

  try {
    const files = await readdir(snapshotDir);
    const snapshotFiles = files
      .filter(f => f.startsWith('snapshot-') && f.endsWith('.json'))
      .sort((a, b) => {
        const seqA = parseInt(a.split('-')[1]) || 0;
        const seqB = parseInt(b.split('-')[1]) || 0;
        return seqB - seqA;
      });

    if (snapshotFiles.length === 0) return null;
    return join(snapshotDir, snapshotFiles[0]);
  } catch {
    return null;
  }
}

/**
 * Check if migration has been completed
 */
async function isMigrationCompleted(stateDir: string): Promise<boolean> {
  const markerPath = join(stateDir, '.image-migration-complete');
  try {
    await stat(markerPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mark migration as completed
 */
async function markMigrationComplete(stateDir: string): Promise<void> {
  const markerPath = join(stateDir, '.image-migration-complete');
  await writeFile(markerPath, new Date().toISOString());
}

/**
 * Stream write a snapshot to avoid OOM on JSON.stringify
 * Writes the JSON structure piece by piece
 */
async function streamWriteSnapshot(snapshot: any, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = createWriteStream(outputPath, { encoding: 'utf8' });

    stream.on('error', reject);
    stream.on('finish', resolve);

    // Helper to write and handle backpressure
    const write = (data: string): Promise<void> => {
      return new Promise((res, rej) => {
        const ok = stream.write(data);
        if (ok) {
          res();
        } else {
          stream.once('drain', res);
          stream.once('error', rej);
        }
      });
    };

    (async () => {
      try {
        await write('{');

        const keys = Object.keys(snapshot);
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i];
          const value = snapshot[key];

          if (i > 0) {
            await write(',');
          }

          await write(`${JSON.stringify(key)}:`);

          // Special handling for veilState to stream facets array
          if (key === 'veilState' && value && typeof value === 'object') {
            await write('{');

            const veilKeys = Object.keys(value);
            for (let j = 0; j < veilKeys.length; j++) {
              const veilKey = veilKeys[j];
              const veilValue = value[veilKey];

              if (j > 0) {
                await write(',');
              }

              await write(`${JSON.stringify(veilKey)}:`);

              // Stream facets array one item at a time
              if (veilKey === 'facets' && Array.isArray(veilValue)) {
                await write('[');
                for (let k = 0; k < veilValue.length; k++) {
                  if (k > 0) {
                    await write(',');
                  }
                  // Write each facet individually
                  await write(JSON.stringify(veilValue[k]));
                }
                await write(']');
              } else {
                // Other veilState properties - stringify normally
                await write(JSON.stringify(veilValue));
              }
            }

            await write('}');
          } else {
            // Non-veilState properties - stringify normally
            await write(JSON.stringify(value));
          }
        }

        await write('}');
        stream.end();
      } catch (error) {
        stream.destroy();
        reject(error);
      }
    })();
  });
}

/**
 * Run the image migration on existing facets
 */
export async function migrateImages(stateDir: string): Promise<MigrationResult | null> {
  console.log('[ImageMigration] Checking if migration is needed...');

  // Check if already completed
  if (await isMigrationCompleted(stateDir)) {
    console.log('[ImageMigration] Migration already completed, skipping');
    return null;
  }

  const snapshotDir = join(stateDir, 'snapshots');
  const snapshotPath = await findLatestSnapshot(snapshotDir);

  if (!snapshotPath) {
    console.log('[ImageMigration] No snapshot found, skipping migration');
    return null;
  }

  console.log(`[ImageMigration] Loading snapshot: ${snapshotPath}`);

  const result: MigrationResult = {
    facetsProcessed: 0,
    imagesCompressed: 0,
    bytesSaved: 0,
    errors: 0
  };

  try {
    // Load snapshot
    const snapshotData = await readFile(snapshotPath, 'utf-8');
    const snapshot = JSON.parse(snapshotData);

    const facets = snapshot.veilState?.facets;
    if (!facets || !Array.isArray(facets)) {
      console.log('[ImageMigration] No facets found in snapshot');
      await markMigrationComplete(stateDir);
      return result;
    }

    console.log(`[ImageMigration] Processing ${facets.length} facets...`);

    // Process each facet
    for (const [id, facet] of facets) {
      try {
        const { compressed, saved } = await processFacetAttachments(facet);
        result.facetsProcessed++;
        result.imagesCompressed += compressed;
        result.bytesSaved += saved;
      } catch (error) {
        console.error(`[ImageMigration] Error processing facet ${id}:`, error);
        result.errors++;
      }
    }

    // Save modified snapshot if any images were compressed
    if (result.imagesCompressed > 0) {
      console.log(`[ImageMigration] Saving compressed snapshot (streaming)...`);
      const tempPath = snapshotPath + '.tmp';

      // Use streaming write to avoid OOM
      await streamWriteSnapshot(snapshot, tempPath);

      // Atomic rename
      await rename(tempPath, snapshotPath);

      console.log(`[ImageMigration] Saved. Compressed ${result.imagesCompressed} images, saved ${Math.round(result.bytesSaved / 1024 / 1024 * 10) / 10} MB`);
    } else {
      console.log('[ImageMigration] No images needed compression');
    }

    // Mark as complete
    await markMigrationComplete(stateDir);

    return result;
  } catch (error) {
    console.error('[ImageMigration] Migration failed:', error);
    throw error;
  }
}

// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
  const stateDir = process.argv[2] || './signal-bot-state';

  migrateImages(stateDir)
    .then(result => {
      if (result) {
        console.log('\nMigration complete:');
        console.log(`  Facets processed: ${result.facetsProcessed}`);
        console.log(`  Images compressed: ${result.imagesCompressed}`);
        console.log(`  Space saved: ${Math.round(result.bytesSaved / 1024 / 1024 * 10) / 10} MB`);
        console.log(`  Errors: ${result.errors}`);
      }
    })
    .catch(error => {
      console.error('Migration failed:', error);
      process.exit(1);
    });
}
