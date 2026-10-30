/**
 * The settings document of an agent (L7). Its field list is the ENGINE's (Abdullah's
 * `agent_configs` model and his `lib/handoff` and `lib/collect` documents): the backend stores and
 * versions the document, checks its shape (`AgentSettingsValidator`) and hands it to the engine at
 * the start of every call. `collect` (what the agent collects for a request) is opaque to the
 * backend on purpose: its fields, catalogue and deeper validation belong to the engine.
 *
 * A document can hold forwarding phone numbers: it is never logged and never copied into the audit
 * log.
 */

export const AGENT_TONES = [
  'professional',
  'friendly',
  'concise',
  'formal',
] as const;
export type AgentTone = (typeof AGENT_TONES)[number];

/** The languages the dashboard and the agent's replies support today (the engine's `en` and `ur`). */
export const AGENT_LANGUAGES = ['en', 'ur'] as const;
export type AgentLanguage = (typeof AGENT_LANGUAGES)[number];

export const WEEKDAYS = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Opening hours in the document's `timezone`: per weekday a list of `["09:00", "17:00"]` ranges; no entry or an empty list = closed. */
export type AgentHours = Partial<Record<Weekday, Array<[string, string]>>>;

export const OUTSIDE_HOURS = ['callback', 'forward'] as const;
export type OutsideHours = (typeof OUTSIDE_HOURS)[number];

export interface EscalationContact {
  id: string;
  role: string;
  name: string;
  /** International form, `+` and 8 to 15 digits. */
  phone: string;
}

/** A text per spoken language; a language that is left out (or empty) uses the engine's built-in wording. */
export type LocalizedText = Partial<Record<AgentLanguage, string>>;

/** A document a profile summary was written from (recorded by the engine, shown by the dashboard). */
export interface ProfileSummarySource {
  id: string;
  title: string;
  hash: string;
}

/**
 * Call forwarding to a person (the engine's "handoff" document). The engine owns its field list: a
 * key this backend does not know is kept as it is (Phase 5B-3), so the type has an open end.
 */
export interface AgentEscalation {
  enabled: boolean;
  contacts: EscalationContact[];
  whenCallerAsks: boolean;
  /** How many times the agent may fail to help before it forwards (1 to 4). */
  afterMisses: number;
  topics: string[];
  outsideHours: OutsideHours;
  /** The owner's own line said before a transfer (`{name}` and `{role}`); empty = the engine's built-in one. */
  announce?: LocalizedText;
  [extra: string]: unknown;
}

export interface AgentSettingsDocument {
  businessName: string;
  purpose: string;
  tone: AgentTone;
  /** IANA name; the hours are read in it. */
  timezone: string;
  /** The language of the screens the owner reads. */
  uiLocale: AgentLanguage;
  /** What the agent replies in (it understands both whatever this is). */
  replyLanguage: AgentLanguage;
  hours: AgentHours | null;
  escalation: AgentEscalation;
  capabilities: Record<string, unknown>;
  /** Voice per spoken language, for example `{ "en": "…", "ur": "…" }`; the engine checks the ids. */
  voices: Record<string, string>;
  /** The engine's "what the agent collects" document. Opaque here; null = not set up. */
  collect: Record<string, unknown> | null;
  /** The call greeting per language (`{business}` is the engine's only placeholder); empty = the built-in greeting. */
  greeting?: LocalizedText;
  /** The owner switched call recording on for this agent. */
  recordCalls?: boolean;
  /** The call ends by itself once the conversation is over (the engine's default is on). */
  autoEndCalls?: boolean;
  /** Seconds of quiet before the call ends by itself, 2 to 10. */
  endCallDelaySeconds?: number;
  /** The business summary the owner approved; null = none. */
  profileSummary?: string | null;
  /** The documents the summary was written from. */
  profileSummarySources?: ProfileSummarySource[];
  /**
   * The engine owns the field list, so a key this backend does not know (for example
   * `collectVersion`) is kept exactly as it was sent and handed back to the engine (Phase 5B-3).
   */
  [extra: string]: unknown;
}

/** The top-level keys every document has (all required), in the order they are listed. */
export const AGENT_SETTINGS_KEYS = [
  'businessName',
  'purpose',
  'tone',
  'timezone',
  'uiLocale',
  'replyLanguage',
  'hours',
  'escalation',
  'capabilities',
  'voices',
  'collect',
] as const;

/**
 * Keys the engine added later (Phase 5B-3): optional, checked structurally when present, and absent
 * from the documents saved before. A new agent does not get them: the engine's own defaults apply
 * when they are missing (built-in greeting, recording off, the call ends by itself after 3 seconds).
 */
export const AGENT_OPTIONAL_KEYS = [
  'greeting',
  'recordCalls',
  'autoEndCalls',
  'endCallDelaySeconds',
  'profileSummary',
  'profileSummarySources',
] as const;

export const BUSINESS_NAME_MAX = 120;
export const AGENT_NAME_MAX = 80;
export const DEFAULT_AGENT_FALLBACK_NAME = 'Main agent';

/** What a new agent starts with: Monday to Friday, 09:00 to 17:00; call forwarding off. */
export function defaultHours(): AgentHours {
  const open: Array<[string, string]> = [['09:00', '17:00']];
  return {
    mon: open.map(([a, b]) => [a, b]),
    tue: open.map(([a, b]) => [a, b]),
    wed: open.map(([a, b]) => [a, b]),
    thu: open.map(([a, b]) => [a, b]),
    fri: open.map(([a, b]) => [a, b]),
    sat: [],
    sun: [],
  };
}

export function defaultEscalation(): AgentEscalation {
  return {
    enabled: false,
    contacts: [],
    whenCallerAsks: true,
    afterMisses: 2,
    topics: [],
    outsideHours: 'callback',
  };
}

export interface DefaultSettingsInput {
  /** The business: the tenant's name. */
  tenantName: string;
  /** The tenant's time zone. */
  timezone: string;
  /** The tenant's default locale; anything but `en` or `ur` becomes `en`. */
  defaultLocale: string;
}

/**
 * The first version of a new agent's settings. The business name is the TENANT's name (the agent
 * name is a label inside the dashboard, the business is what callers hear); the language of both the
 * screens and the replies follows the tenant's default locale when the engine supports it. The data
 * migration `20261028100100_phase5b1_agents_data` builds the same document in SQL for the tenants
 * that exist: change both together (a database test compares them).
 */
export function buildDefaultSettings(
  input: DefaultSettingsInput,
): AgentSettingsDocument {
  const language: AgentLanguage = (
    AGENT_LANGUAGES as readonly string[]
  ).includes(input.defaultLocale)
    ? (input.defaultLocale as AgentLanguage)
    : 'en';
  return {
    businessName:
      input.tenantName.trim().slice(0, BUSINESS_NAME_MAX).trim() ||
      DEFAULT_AGENT_FALLBACK_NAME,
    purpose: '',
    tone: 'professional',
    timezone: input.timezone,
    uiLocale: language,
    replyLanguage: language,
    hours: defaultHours(),
    escalation: defaultEscalation(),
    capabilities: {},
    voices: {},
    collect: null,
  };
}

/** The name of a tenant's default agent: the tenant's name, trimmed and cut to the agent name limit. */
export function defaultAgentName(tenantName: string): string {
  return (
    tenantName.trim().slice(0, AGENT_NAME_MAX).trim() ||
    DEFAULT_AGENT_FALLBACK_NAME
  );
}
