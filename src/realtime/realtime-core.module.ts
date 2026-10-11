import { Module } from '@nestjs/common';
import { RealtimeHub } from './realtime.hub';
import { StreamRegistry } from './stream-registry';

/**
 * The in-process hub and the stream registry, with no imports of their own, so any module can
 * publish or subscribe without pulling in authentication (the HTTP side is `RealtimeModule`).
 */
@Module({
  providers: [RealtimeHub, StreamRegistry],
  exports: [RealtimeHub, StreamRegistry],
})
export class RealtimeCoreModule {}
