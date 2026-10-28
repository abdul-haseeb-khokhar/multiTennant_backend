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

/** Call forwarding to a person (the engine's "handoff" document). */
export interface AgentEscalation {
  enabled: boolean;
  contacts: EscalationContact[];
  whenCallerAsks: boolean;
  /** How many times the agent may fail to help before it forwards (1 to 4). */
  afterMisses: number;
  topics: string[];
  outsideHours: OutsideHours;
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
}

/** The top-level keys of the document, in the order they are listed. */
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
] as const satisfies ReadonlyArray<keyof AgentSettingsDocument>;

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
