/**
 * The map stores COORDINATES, never meaning.
 *
 * Every field here is mechanically verifiable against the source tree:
 * a path, a line, a char-offset range, a content hash, an anchor snippet.
 * There is deliberately no `summary`, `intent`, or `description` field —
 * that interpretation is the LLM's job, performed fresh from the raw bytes
 * that `read()` hands back. The map's only promise is: it routes you to the
 * exact spot. What the spot *means* is never the map's claim.
 */
export const INDEX_VERSION = 18;
/** Entries have been globally ordered by file, then line, since this format. */
export const ORDERED_ENTRIES_VERSION = 13;
