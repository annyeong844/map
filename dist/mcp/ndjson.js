// oxlint-disable-next-line no-magic-numbers -- ASCII carriage return byte.
const CARRIAGE_RETURN_BYTE = 13;
// oxlint-disable-next-line no-magic-numbers -- ASCII line feed byte.
const LINE_FEED_BYTE = 10;
/**
 * Incremental newline-delimited JSON decoder with a byte ceiling.
 *
 * It retains at most maxLineBytes for an unfinished line, discards the rest of
 * an oversized record until the next newline, then resumes without poisoning
 * later requests.
 */
export class NdjsonDecoder {
    chunks = [];
    bytes = 0;
    discarding = false;
    maxLineBytes;
    constructor(maxLineBytes) {
        this.maxLineBytes = maxLineBytes;
    }
    append(segment, events) {
        if (this.discarding || segment.length === 0)
            return;
        if (this.bytes + segment.length > this.maxLineBytes) {
            this.chunks.length = 0;
            this.bytes = 0;
            this.discarding = true;
            events.push({ kind: 'oversized' });
            return;
        }
        this.chunks.push(segment);
        this.bytes += segment.length;
    }
    takeLine() {
        const line = this.chunks.length === 1
            ? this.chunks[0]
            : Buffer.concat(this.chunks, this.bytes);
        const end = line.length > 0 && line[line.length - 1] === CARRIAGE_RETURN_BYTE
            ? line.length - 1
            : line.length;
        this.chunks.length = 0;
        this.bytes = 0;
        return line.subarray(0, end).toString('utf8');
    }
    push(chunk) {
        const events = [];
        let start = 0;
        for (;;) {
            const newline = chunk.indexOf(LINE_FEED_BYTE, start);
            const end = newline === -1 ? chunk.length : newline;
            this.append(chunk.subarray(start, end), events);
            if (newline === -1)
                break;
            if (this.discarding) {
                this.discarding = false;
                this.chunks.length = 0;
                this.bytes = 0;
            }
            else {
                events.push({ kind: 'line', text: this.takeLine() });
            }
            start = newline + 1;
            if (start === chunk.length)
                break;
        }
        return events;
    }
    finish() {
        if (this.discarding) {
            this.discarding = false;
            this.chunks.length = 0;
            this.bytes = 0;
            return [];
        }
        return this.bytes > 0 ? [{ kind: 'line', text: this.takeLine() }] : [];
    }
}
