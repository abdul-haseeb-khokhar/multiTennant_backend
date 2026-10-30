import { Injectable } from '@nestjs/common';
import { canonicalTimeZone } from '../common/validation/timezone';
import {
  AGENT_LANGUAGES,
  AGENT_OPTIONAL_KEYS,
  AGENT_SETTINGS_KEYS,
  AGENT_TONES,
  AgentEscalation,
  AgentHours,
  AgentSettingsDocument,
  BUSINESS_NAME_MAX,
  EscalationContact,
  LocalizedText,
  OUTSIDE_HOURS,
  ProfileSummarySource,
  WEEKDAYS,
} from './agent-settings.defaults';

/** The biggest settings document a save may carry (serialised). */
export const AGENT_SETTINGS_MAX_BYTES = 64 * 1024;
export const PURPOSE_MAX = 2000;
export const CONTACTS_MAX = 5;
export const CONTACT_TEXT_MAX = 60;
export const TOPICS_MAX = 10;
export const TOPIC_MAX = 40;
export const RANGES_PER_DAY_MAX = 5;
export const AFTER_MISSES_MIN = 1;
export const AFTER_MISSES_MAX = 4;
/** The engine's own limits for the texts it added (its `greeting`, `announce` and `profileSummary` rules); the engine checks the rest. */
export const GREETING_MAX = 400;
export const ANNOUNCE_MAX = 200;
export const PROFILE_SUMMARY_MAX = 1200;
export const PROFILE_SUMMARY_SOURCES_MAX = 10;
export const END_CALL_DELAY_MIN = 2;
export const END_CALL_DELAY_MAX = 10;
const SOURCE_ID_MAX = 100;
const SOURCE_TITLE_MAX = 300;
const SOURCE_HASH_MAX = 200;
const CAPABILITIES_MAX = 50;
const VOICES_MAX = 10;
const KEY_MAX = 60;
const VOICE_ID_MAX = 100;
/** Opaque documents (`collect`, `capabilities`): how deep and how big they may be besides the byte cap. */
const OPAQUE_MAX_DEPTH = 12;
const OPAQUE_MAX_NODES = 20_000;

/**
 * One thing wrong with a settings document. `field` is a path such as `escalation.contacts[0].phone`
 * (empty for the whole document); `code` is stable and translated in the `common` namespace as
 * `agent_settings.problem.<code>`; `params` fill placeholders such as `{max}`.
 */
export interface SettingsProblem {
  field: string;
  code: SettingsProblemCode;
  params?: Record<string, string | number>;
}

export type SettingsProblemCode =
  | 'required'
  | 'invalid_type'
  | 'unknown_field'
  | 'too_short'
  | 'too_long'
  | 'not_allowed'
  | 'invalid_timezone'
  | 'invalid_time'
  | 'end_before_start'
  | 'overlapping_ranges'
  | 'too_many'
  | 'invalid_phone'
  | 'duplicate_phone'
  | 'contact_incomplete'
  | 'enabled_needs_contact'
  | 'out_of_range'
  | 'too_large'
  | 'too_complex';

export type SettingsValidation =
  | { ok: true; document: AgentSettingsDocument }
  | { ok: false; problems: SettingsProblem[] };

/**
 * Checks a COMPLETE settings document and returns it normalised (text trimmed, phone numbers in
 * international form, a contact id filled in), or every problem found.
 *
 * The backend only checks the structure. The engine owns the field list in depth: the checklist of
 * what the agent collects, the catalogue of capabilities and the voice ids. A key the backend does not
 * know (at the top of the document, or inside `escalation`) is never refused: it is kept exactly as it
 * was sent, inside the size cap, so a field the engine adds tomorrow is not a bug here today
 * (Phase 5B-3). Hook for the engine's own checks: provide
 * another implementation of this class in `AgentsCoreModule` that calls the engine's validation
 * route once Abdullah offers it (Q28) and falls back to `StructuralAgentSettingsValidator` when the
 * engine is unreachable. No such route is called today.
 */
export abstract class AgentSettingsValidator {
  abstract validate(input: unknown): Promise<SettingsValidation>;
}

type Problems = SettingsProblem[];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

@Injectable()
export class StructuralAgentSettingsValidator extends AgentSettingsValidator {
  validate(input: unknown): Promise<SettingsValidation> {
    return Promise.resolve(this.check(input));
  }

  check(input: unknown): SettingsValidation {
    if (!isPlainObject(input)) {
      return {
        ok: false,
        problems: [{ field: '', code: 'invalid_type' }],
      };
    }
    const problems: Problems = [];
    // JSON.stringify can throw on a pathological structure; the opaque parts are measured below.
    const document: Partial<AgentSettingsDocument> = {};

    const businessName = this.text(
      input,
      'businessName',
      problems,
      1,
      BUSINESS_NAME_MAX,
    );
    if (businessName !== undefined) document.businessName = businessName;
    const purpose = this.text(input, 'purpose', problems, 0, PURPOSE_MAX);
    if (purpose !== undefined) document.purpose = purpose;
    document.tone = this.oneOf(input, 'tone', problems, AGENT_TONES);
    document.uiLocale = this.oneOf(
      input,
      'uiLocale',
      problems,
      AGENT_LANGUAGES,
    );
    document.replyLanguage = this.oneOf(
      input,
      'replyLanguage',
      problems,
      AGENT_LANGUAGES,
    );
    const timezone = this.timezone(input, problems);
    if (timezone !== undefined) document.timezone = timezone;
    document.hours = this.hours(input, problems);
    document.escalation = this.escalation(input, problems);
    document.capabilities = this.capabilities(input, problems);
    document.voices = this.voices(input, problems);
    document.collect = this.collect(input, problems);
    this.optionalFields(input, document, problems);
    this.keepUnknown(
      input,
      [...AGENT_SETTINGS_KEYS, ...AGENT_OPTIONAL_KEYS],
      document as Record<string, unknown>,
      '',
      problems,
    );

    if (problems.length === 0) {
      const size = Buffer.byteLength(JSON.stringify(document), 'utf8');
      if (size > AGENT_SETTINGS_MAX_BYTES) {
        problems.push({
          field: '',
          code: 'too_large',
          params: { max: AGENT_SETTINGS_MAX_BYTES },
        });
      }
    }
    if (problems.length > 0) return { ok: false, problems };
    return { ok: true, document: document as AgentSettingsDocument };
  }

  // ---- scalars -------------------------------------------------------------------------------

  private text(
    source: Record<string, unknown>,
    field: string,
    problems: Problems,
    min: number,
    max: number,
  ): string | undefined {
    const value = source[field];
    if (value === undefined) {
      problems.push({ field, code: 'required' });
      return undefined;
    }
    if (typeof value !== 'string') {
      problems.push({ field, code: 'invalid_type' });
      return undefined;
    }
    const text = value.trim();
    if (text.length < min) {
      problems.push({ field, code: 'too_short', params: { min } });
      return undefined;
    }
    if (text.length > max) {
      problems.push({ field, code: 'too_long', params: { max } });
      return undefined;
    }
    return text;
  }

  private oneOf<T extends string>(
    source: Record<string, unknown>,
    field: string,
    problems: Problems,
    allowed: readonly T[],
  ): T {
    const value = source[field];
    if (value === undefined) {
      problems.push({ field, code: 'required' });
    } else if (typeof value !== 'string' || !allowed.includes(value as T)) {
      problems.push({
        field,
        code: 'not_allowed',
        params: { allowed: allowed.join(', ') },
      });
    }
    return value as T;
  }

  private timezone(
    source: Record<string, unknown>,
    problems: Problems,
  ): string | undefined {
    const value = source.timezone;
    if (value === undefined) {
      problems.push({ field: 'timezone', code: 'required' });
      return undefined;
    }
    const canonical = canonicalTimeZone(value);
    if (canonical === null) {
      problems.push({ field: 'timezone', code: 'invalid_timezone' });
      return undefined;
    }
    return canonical;
  }

  // ---- hours ---------------------------------------------------------------------------------

  private hours(
    source: Record<string, unknown>,
    problems: Problems,
  ): AgentHours | null {
    const value = source.hours;
    if (value === undefined) {
      problems.push({ field: 'hours', code: 'required' });
      return null;
    }
    if (value === null) return null;
    if (!isPlainObject(value)) {
      problems.push({ field: 'hours', code: 'invalid_type' });
      return null;
    }
    const out: AgentHours = {};
    for (const [day, ranges] of Object.entries(value)) {
      const field = `hours.${day}`;
      if (!(WEEKDAYS as readonly string[]).includes(day)) {
        problems.push({ field, code: 'unknown_field' });
        continue;
      }
      if (!Array.isArray(ranges)) {
        problems.push({ field, code: 'invalid_type' });
        continue;
      }
      if (ranges.length > RANGES_PER_DAY_MAX) {
        problems.push({
          field,
          code: 'too_many',
          params: { max: RANGES_PER_DAY_MAX },
        });
        continue;
      }
      const clean: Array<[string, string]> = [];
      ranges.forEach((range: unknown, index) => {
        const at = `${field}[${index}]`;
        if (
          !Array.isArray(range) ||
          range.length !== 2 ||
          typeof range[0] !== 'string' ||
          typeof range[1] !== 'string'
        ) {
          problems.push({ field: at, code: 'invalid_type' });
          return;
        }
        const [start, end] = range as [string, string];
        if (!TIME.test(start) || !TIME.test(end)) {
          problems.push({ field: at, code: 'invalid_time' });
          return;
        }
        if (end <= start) {
          problems.push({ field: at, code: 'end_before_start' });
          return;
        }
        clean.push([start, end]);
      });
      clean.sort((a, b) => a[0].localeCompare(b[0]));
      for (let i = 1; i < clean.length; i++) {
        if (clean[i][0] < clean[i - 1][1]) {
          problems.push({ field, code: 'overlapping_ranges' });
          break;
        }
      }
      out[day as keyof AgentHours] = clean;
    }
    return out;
  }

  // ---- call forwarding -----------------------------------------------------------------------

  private escalation(
    source: Record<string, unknown>,
    problems: Problems,
  ): AgentEscalation {
    const empty: AgentEscalation = {
      enabled: false,
      contacts: [],
      whenCallerAsks: true,
      afterMisses: 2,
      topics: [],
      outsideHours: 'callback',
    };
    const value = source.escalation;
    if (value === undefined) {
      problems.push({ field: 'escalation', code: 'required' });
      return empty;
    }
    if (!isPlainObject(value)) {
      problems.push({ field: 'escalation', code: 'invalid_type' });
      return empty;
    }
    const out: AgentEscalation = { ...empty };

    for (const flag of ['enabled', 'whenCallerAsks'] as const) {
      if (value[flag] === undefined) {
        problems.push({ field: `escalation.${flag}`, code: 'required' });
      } else if (typeof value[flag] !== 'boolean') {
        problems.push({ field: `escalation.${flag}`, code: 'invalid_type' });
      } else {
        out[flag] = value[flag];
      }
    }

    const misses = value.afterMisses;
    if (misses === undefined) {
      problems.push({ field: 'escalation.afterMisses', code: 'required' });
    } else if (
      !Number.isInteger(misses) ||
      (misses as number) < AFTER_MISSES_MIN ||
      (misses as number) > AFTER_MISSES_MAX
    ) {
      problems.push({
        field: 'escalation.afterMisses',
        code: 'out_of_range',
        params: { min: AFTER_MISSES_MIN, max: AFTER_MISSES_MAX },
      });
    } else {
      out.afterMisses = misses as number;
    }

    if (value.outsideHours === undefined) {
      problems.push({ field: 'escalation.outsideHours', code: 'required' });
    } else if (
      typeof value.outsideHours !== 'string' ||
      !(OUTSIDE_HOURS as readonly string[]).includes(value.outsideHours)
    ) {
      problems.push({
        field: 'escalation.outsideHours',
        code: 'not_allowed',
        params: { allowed: OUTSIDE_HOURS.join(', ') },
      });
    } else {
      out.outsideHours = value.outsideHours as AgentEscalation['outsideHours'];
    }

    out.topics = this.topics(value.topics, problems);
    out.contacts = this.contacts(value.contacts, problems);
    const announce = this.localizedText(
      value.announce,
      'escalation.announce',
      ANNOUNCE_MAX,
      problems,
    );
    if (announce !== undefined) out.announce = announce;
    this.keepUnknown(
      value,
      [
        'enabled',
        'contacts',
        'whenCallerAsks',
        'afterMisses',
        'topics',
        'outsideHours',
        'announce',
      ],
      out,
      'escalation.',
      problems,
    );
    if (out.enabled && out.contacts.length === 0) {
      problems.push({
        field: 'escalation.contacts',
        code: 'enabled_needs_contact',
      });
    }
    return out;
  }

  private topics(value: unknown, problems: Problems): string[] {
    if (value === undefined) {
      problems.push({ field: 'escalation.topics', code: 'required' });
      return [];
    }
    if (!Array.isArray(value)) {
      problems.push({ field: 'escalation.topics', code: 'invalid_type' });
      return [];
    }
    if (value.length > TOPICS_MAX) {
      problems.push({
        field: 'escalation.topics',
        code: 'too_many',
        params: { max: TOPICS_MAX },
      });
      return [];
    }
    const out: string[] = [];
    const seen = new Set<string>();
    value.forEach((item: unknown, index) => {
      const field = `escalation.topics[${index}]`;
      if (typeof item !== 'string') {
        problems.push({ field, code: 'invalid_type' });
        return;
      }
      const topic = item.replace(/\s+/g, ' ').trim();
      if (topic.length === 0 || seen.has(topic.toLowerCase())) return;
      if (topic.length > TOPIC_MAX) {
        problems.push({ field, code: 'too_long', params: { max: TOPIC_MAX } });
        return;
      }
      seen.add(topic.toLowerCase());
      out.push(topic);
    });
    return out;
  }

  private contacts(value: unknown, problems: Problems): EscalationContact[] {
    if (value === undefined) {
      problems.push({ field: 'escalation.contacts', code: 'required' });
      return [];
    }
    if (!Array.isArray(value)) {
      problems.push({ field: 'escalation.contacts', code: 'invalid_type' });
      return [];
    }
    if (value.length > CONTACTS_MAX) {
      problems.push({
        field: 'escalation.contacts',
        code: 'too_many',
        params: { max: CONTACTS_MAX },
      });
      return [];
    }
    const out: EscalationContact[] = [];
    const phones = new Set<string>();
    const ids = new Set<string>();
    value.forEach((entry: unknown, index) => {
      const field = `escalation.contacts[${index}]`;
      if (!isPlainObject(entry)) {
        problems.push({ field, code: 'invalid_type' });
        return;
      }
      for (const key of Object.keys(entry)) {
        if (!['id', 'role', 'name', 'phone'].includes(key)) {
          problems.push({ field: `${field}.${key}`, code: 'unknown_field' });
        }
      }
      const clean = (v: unknown) =>
        typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : null;
      const role = entry.role === undefined ? '' : clean(entry.role);
      const name = entry.name === undefined ? '' : clean(entry.name);
      if (role === null || name === null) {
        problems.push({
          field: `${field}.${role === null ? 'role' : 'name'}`,
          code: 'invalid_type',
        });
        return;
      }
      if (role.length > CONTACT_TEXT_MAX || name.length > CONTACT_TEXT_MAX) {
        problems.push({
          field: `${field}.${role.length > CONTACT_TEXT_MAX ? 'role' : 'name'}`,
          code: 'too_long',
          params: { max: CONTACT_TEXT_MAX },
        });
        return;
      }
      if (!role && !name) {
        problems.push({ field, code: 'contact_incomplete' });
        return;
      }
      const phone = normalizePhone(entry.phone);
      if (phone === null) {
        problems.push({ field: `${field}.phone`, code: 'invalid_phone' });
        return;
      }
      if (phones.has(phone)) {
        problems.push({ field: `${field}.phone`, code: 'duplicate_phone' });
        return;
      }
      phones.add(phone);
      let id = typeof entry.id === 'string' ? entry.id.trim().slice(0, 30) : '';
      if (!id || ids.has(id)) id = `c${index + 1}`;
      while (ids.has(id)) id = `${id}_`;
      ids.add(id);
      out.push({ id, role, name, phone });
    });
    return out;
  }

  // ---- what the engine added later (optional) and what it may add tomorrow -------------------

  /** The optional fields: checked when present, left out of the document when absent. */
  private optionalFields(
    source: Record<string, unknown>,
    document: Partial<AgentSettingsDocument>,
    problems: Problems,
  ) {
    const greeting = this.localizedText(
      source.greeting,
      'greeting',
      GREETING_MAX,
      problems,
    );
    if (greeting !== undefined) document.greeting = greeting;

    for (const flag of ['recordCalls', 'autoEndCalls'] as const) {
      const value = source[flag];
      if (value === undefined) continue;
      if (typeof value === 'boolean') document[flag] = value;
      else problems.push({ field: flag, code: 'invalid_type' });
    }

    const delay = source.endCallDelaySeconds;
    if (delay !== undefined) {
      if (typeof delay !== 'number') {
        problems.push({ field: 'endCallDelaySeconds', code: 'invalid_type' });
      } else if (
        !Number.isInteger(delay) ||
        delay < END_CALL_DELAY_MIN ||
        delay > END_CALL_DELAY_MAX
      ) {
        problems.push({
          field: 'endCallDelaySeconds',
          code: 'out_of_range',
          params: { min: END_CALL_DELAY_MIN, max: END_CALL_DELAY_MAX },
        });
      } else {
        document.endCallDelaySeconds = delay;
      }
    }

    const summary = source.profileSummary;
    if (summary !== undefined) {
      if (summary === null) {
        document.profileSummary = null;
      } else if (typeof summary !== 'string') {
        problems.push({ field: 'profileSummary', code: 'invalid_type' });
      } else if (summary.trim().length > PROFILE_SUMMARY_MAX) {
        problems.push({
          field: 'profileSummary',
          code: 'too_long',
          params: { max: PROFILE_SUMMARY_MAX },
        });
      } else {
        document.profileSummary = summary.trim() || null;
      }
    }

    const sources = this.summarySources(source.profileSummarySources, problems);
    if (sources !== undefined) document.profileSummarySources = sources;
  }

  /** `{ en?, ur? }`: strings trimmed, an empty or null one left out (the engine's built-in wording applies). */
  private localizedText(
    value: unknown,
    field: string,
    max: number,
    problems: Problems,
  ): LocalizedText | undefined {
    if (value === undefined) return undefined;
    if (!isPlainObject(value)) {
      problems.push({ field, code: 'invalid_type' });
      return undefined;
    }
    const out: LocalizedText = {};
    for (const [language, text] of Object.entries(value)) {
      const at = `${field}.${language}`;
      if (!(AGENT_LANGUAGES as readonly string[]).includes(language)) {
        problems.push({ field: at, code: 'unknown_field' });
      } else if (text === null || text === undefined) {
        continue;
      } else if (typeof text !== 'string') {
        problems.push({ field: at, code: 'invalid_type' });
      } else if (text.trim().length > max) {
        problems.push({ field: at, code: 'too_long', params: { max } });
      } else if (text.trim()) {
        out[language as keyof LocalizedText] = text.trim();
      }
    }
    return out;
  }

  private summarySources(
    value: unknown,
    problems: Problems,
  ): ProfileSummarySource[] | undefined {
    const field = 'profileSummarySources';
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
      problems.push({ field, code: 'invalid_type' });
      return undefined;
    }
    if (value.length > PROFILE_SUMMARY_SOURCES_MAX) {
      problems.push({
        field,
        code: 'too_many',
        params: { max: PROFILE_SUMMARY_SOURCES_MAX },
      });
      return undefined;
    }
    const limits = {
      id: SOURCE_ID_MAX,
      title: SOURCE_TITLE_MAX,
      hash: SOURCE_HASH_MAX,
    } as const;
    const out: ProfileSummarySource[] = [];
    value.forEach((entry: unknown, index) => {
      const at = `${field}[${index}]`;
      if (!isPlainObject(entry)) {
        problems.push({ field: at, code: 'invalid_type' });
        return;
      }
      for (const key of ['id', 'title', 'hash'] as const) {
        const part = entry[key];
        if (typeof part !== 'string') {
          problems.push({
            field: `${at}.${key}`,
            code: part === undefined ? 'required' : 'invalid_type',
          });
        } else if (part.length > limits[key]) {
          problems.push({
            field: `${at}.${key}`,
            code: 'too_long',
            params: { max: limits[key] },
          });
        }
      }
      out.push(entry as unknown as ProfileSummarySource);
    });
    return out;
  }

  /**
   * Copies every key the backend does not know into `target`, as it was sent. The engine owns the
   * field list, so such a key is never refused; only its depth and size are bounded (and the whole
   * document by the byte cap). `defineProperty`, so even a key named `__proto__` stays plain data.
   */
  private keepUnknown(
    source: Record<string, unknown>,
    known: readonly string[],
    target: Record<string, unknown>,
    prefix: string,
    problems: Problems,
  ) {
    for (const [key, value] of Object.entries(source)) {
      if (known.includes(key)) continue;
      this.measure(value, `${prefix}${key}`, problems);
      Object.defineProperty(target, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }

  // ---- parts the engine owns in depth --------------------------------------------------------

  private capabilities(
    source: Record<string, unknown>,
    problems: Problems,
  ): Record<string, unknown> {
    const value = source.capabilities;
    if (value === undefined) {
      problems.push({ field: 'capabilities', code: 'required' });
      return {};
    }
    if (!isPlainObject(value)) {
      problems.push({ field: 'capabilities', code: 'invalid_type' });
      return {};
    }
    const entries = Object.entries(value);
    if (entries.length > CAPABILITIES_MAX) {
      problems.push({
        field: 'capabilities',
        code: 'too_many',
        params: { max: CAPABILITIES_MAX },
      });
      return {};
    }
    for (const [id, state] of entries) {
      if (id.length > KEY_MAX || !isPlainObject(state)) {
        problems.push({ field: `capabilities.${id}`, code: 'invalid_type' });
      }
    }
    this.measure(value, 'capabilities', problems);
    return value;
  }

  private voices(
    source: Record<string, unknown>,
    problems: Problems,
  ): Record<string, string> {
    const value = source.voices;
    if (value === undefined) {
      problems.push({ field: 'voices', code: 'required' });
      return {};
    }
    if (!isPlainObject(value)) {
      problems.push({ field: 'voices', code: 'invalid_type' });
      return {};
    }
    const entries = Object.entries(value);
    if (entries.length > VOICES_MAX) {
      problems.push({
        field: 'voices',
        code: 'too_many',
        params: { max: VOICES_MAX },
      });
      return {};
    }
    const out: Record<string, string> = {};
    for (const [language, voice] of entries) {
      const field = `voices.${language}`;
      if (!/^[a-z]{2,3}$/.test(language)) {
        problems.push({ field, code: 'unknown_field' });
      } else if (typeof voice !== 'string') {
        problems.push({ field, code: 'invalid_type' });
      } else if (voice.trim().length === 0) {
        problems.push({ field, code: 'too_short', params: { min: 1 } });
      } else if (voice.length > VOICE_ID_MAX) {
        problems.push({
          field,
          code: 'too_long',
          params: { max: VOICE_ID_MAX },
        });
      } else {
        out[language] = voice.trim();
      }
    }
    return out;
  }

  /** "What the agent collects": the engine's document, stored as it is (any JSON object, or null). */
  private collect(
    source: Record<string, unknown>,
    problems: Problems,
  ): Record<string, unknown> | null {
    const value = source.collect;
    if (value === undefined) {
      problems.push({ field: 'collect', code: 'required' });
      return null;
    }
    if (value === null) return null;
    if (!isPlainObject(value)) {
      problems.push({ field: 'collect', code: 'invalid_type' });
      return null;
    }
    this.measure(value, 'collect', problems);
    return value;
  }

  /** Bounds the depth and node count of an opaque document without recursion (a hostile body cannot overflow the stack). */
  private measure(value: unknown, field: string, problems: Problems) {
    const stack: Array<{ node: unknown; depth: number }> = [
      { node: value, depth: 1 },
    ];
    let nodes = 0;
    while (stack.length > 0) {
      const { node, depth } = stack.pop()!;
      nodes += 1;
      if (depth > OPAQUE_MAX_DEPTH || nodes > OPAQUE_MAX_NODES) {
        problems.push({ field, code: 'too_complex' });
        return;
      }
      if (Array.isArray(node)) {
        for (const item of node) stack.push({ node: item, depth: depth + 1 });
      } else if (isPlainObject(node)) {
        for (const item of Object.values(node)) {
          stack.push({ node: item, depth: depth + 1 });
        }
      }
    }
  }
}

/**
 * A phone number in international form: `+`, a non-zero digit and 7 to 14 more (E.164 allows 15 in
 * all). Spaces, dashes, dots and brackets are removed and a leading `00` counts as `+`. Returns null
 * when it is not one. Never logged.
 */
export function normalizePhone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let text = value.trim().replace(/[\s().-]/g, '');
  if (text.startsWith('00')) text = `+${text.slice(2)}`;
  return /^\+[1-9]\d{7,14}$/.test(text) ? text : null;
}
