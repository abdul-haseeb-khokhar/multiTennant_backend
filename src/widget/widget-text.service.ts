import { Injectable } from '@nestjs/common';
import { DEFAULT_LOCALE, LOCALE_CODES } from '../i18n/locales';
import { I18nService } from '../i18n/i18n.service';

/**
 * Why the end customer got a fallback instead of an AI answer. The codes are stable and
 * translated (`widget.fallback.<reason>`); they never reveal billing state to the customer.
 *
 *  - `service_unavailable`: the tenant is suspended or closed, or its plan has no chat (no engine call).
 *  - `limit_reached`: the plan's conversation limit is reached; the conversation goes to a human (I5).
 *  - `ai_unavailable`: the engine is down or too slow; the conversation goes to a human (D7).
 */
export const FALLBACK_REASONS = [
  'service_unavailable',
  'limit_reached',
  'ai_unavailable',
] as const;
export type FallbackReason = (typeof FALLBACK_REASONS)[number];

/** Tenant-specific wording of the widget. Phase 5 fills it from `agent_configs` (E1, H7). */
export interface TenantWidgetSettings {
  greeting?: string;
  personaName?: string;
  /** Shown for every fallback reason when set. */
  fallbackMessage?: string;
}

/** Where the tenant's own widget wording comes from. Until Phase 5 nobody has any. */
export abstract class WidgetSettingsProvider {
  abstract forTenant(tenantId: string): Promise<TenantWidgetSettings>;
}

@Injectable()
export class DefaultWidgetSettingsProvider extends WidgetSettingsProvider {
  forTenant(): Promise<TenantWidgetSettings> {
    return Promise.resolve({});
  }
}

/** Resolves the language and the texts the widget shows (the `widget` namespace, with tenant overrides). */
@Injectable()
export class WidgetTextService {
  constructor(
    private readonly i18n: I18nService,
    private readonly settings: WidgetSettingsProvider,
  ) {}

  /**
   * The visitor's language: the requested one if we have it (`ur-PK` becomes `ur`), else the
   * tenant's default, else English.
   */
  resolveLocale(requested: string | undefined, tenantDefault?: string) {
    const primary = requested?.trim().toLowerCase().split(/[-_]/)[0];
    if (primary && LOCALE_CODES.includes(primary)) return primary;
    if (tenantDefault && LOCALE_CODES.includes(tenantDefault)) {
      return tenantDefault;
    }
    return DEFAULT_LOCALE;
  }

  async fallback(tenantId: string, reason: FallbackReason, locale: string) {
    const tenant = await this.settings.forTenant(tenantId);
    return {
      reason,
      message:
        tenant.fallbackMessage ?? this.text(`fallback.${reason}`, locale),
    };
  }

  async greeting(tenantId: string, locale: string) {
    const tenant = await this.settings.forTenant(tenantId);
    return {
      greeting: tenant.greeting ?? this.text('greeting.default', locale),
      personaName: tenant.personaName ?? this.text('persona.default', locale),
    };
  }

  /** The note shown when a conversation is waiting for a human. */
  async escalatedNotice(tenantId: string, locale: string) {
    const tenant = await this.settings.forTenant(tenantId);
    return tenant.fallbackMessage ?? this.text('escalated.notice', locale);
  }

  private text(key: string, locale: string): string {
    return this.i18n.get(locale, 'widget').entries[key] ?? key;
  }
}
