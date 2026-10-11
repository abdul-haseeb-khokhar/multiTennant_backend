import { Injectable } from '@nestjs/common';

interface Entry {
  close: (reason: string) => void;
}

/**
 * Caps the number of open streams per owner (a staff member, a widget conversation). At the cap the
 * OLDEST stream is closed in favour of the new one, so a browser that reloads (leaving a stale
 * connection behind until the proxy notices) never locks itself out. In process memory, like the
 * hub it protects.
 */
@Injectable()
export class StreamRegistry {
  private readonly open = new Map<string, Entry[]>();

  /**
   * Registers a stream for `owner`. Returns the function to call when the stream ends. If `owner`
   * already has `max` streams, the oldest ones are closed with reason `limit`.
   */
  register(
    owner: string,
    max: number,
    close: (reason: string) => void,
  ): () => void {
    const entries = this.open.get(owner) ?? [];
    const entry: Entry = { close };
    entries.push(entry);
    this.open.set(owner, entries);
    while (entries.length > max) {
      const oldest = entries.shift()!;
      try {
        oldest.close('limit');
      } catch {
        // already gone
      }
    }
    return () => {
      const list = this.open.get(owner);
      if (!list) return;
      const index = list.indexOf(entry);
      if (index >= 0) list.splice(index, 1);
      if (list.length === 0) this.open.delete(owner);
    };
  }

  count(owner: string) {
    return this.open.get(owner)?.length ?? 0;
  }
}
