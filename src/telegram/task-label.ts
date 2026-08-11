import { safeCut } from "./report.js";

// What a task is called when a person reads about it.
//
// Reports used to be headlined with a uuid:
//
//   ⚠️ Task retry_wait
//   47a0ed46-7dc2-44ec-835f-a32e44f616db
//
// which tells the owner nothing they can act on and nothing they can remember.
// A task has two facts that are actually useful: what kind of work it is, and
// what it is about. Both are already in the database.
//
// The id is not dropped from the system, only from the headline. It stays
// wherever it is needed to act on something.

export interface TaskDescription {
  // "Chat reply", "Patch", "Blueprint translation".
  kind: string;
  // The owner's own question, the project name, the milestone. Optional
  // because some work genuinely has no subject worth a line.
  subject?: string;
}

// Driver ids are an internal enum; these are the words for them. An unknown
// driver falls back to "Task" rather than leaking the enum value, because a
// new driver appearing in a report as `blueprint_translation_v2` is a worse
// answer than a generic one.
const KIND_FOR: Record<string, string> = {
  conversation_reply: "Chat reply",
  ai_patch_executor: "Patch",
  blueprint_translation: "Blueprint translation",
  deterministic_sha256: "Verification",
};

export function kindOf(driver: string | undefined): string {
  return driver === undefined ? "Task" : (KIND_FOR[driver] ?? "Task");
}

const SUBJECT_LIMIT = 72;

// One line, collapsed, bounded. Subjects come from owner messages and project
// names, so they can contain newlines and can be arbitrarily long; a headline
// that wraps to six lines on a phone defeats the point of having one.
export function trimSubject(subject: string | undefined): string | undefined {
  if (subject === undefined) return undefined;
  const flat = subject.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return undefined;
  if (flat.length <= SUBJECT_LIMIT) return flat;
  // safeCut for the same reason splitForTelegram needs it: slicing at a UTF-16
  // index can land between the halves of an emoji, and owner questions contain
  // emoji. Cutting at a word boundary usually avoids it; the fallback does not.
  const cut = flat.slice(0, safeCut(flat, SUBJECT_LIMIT));
  const boundary = cut.lastIndexOf(" ");
  return (boundary > SUBJECT_LIMIT / 2 ? cut.slice(0, boundary) : cut) + "…";
}

// The headline: "Chat reply failed", "Patch succeeded".
export function taskHeadline(
  description: TaskDescription,
  outcome: string,
): string {
  const verb =
    outcome === "succeeded"
      ? "succeeded"
      : outcome === "failed"
        ? "failed"
        : outcome === "cancelled"
          ? "cancelled"
          : outcome;
  return `${description.kind} ${verb}`;
}

// The second line, quoted when it is something the owner said, so a question
// reads as a quotation rather than as the system's own words.
export function subjectLine(
  description: TaskDescription,
  quoted = false,
): string | undefined {
  const subject = trimSubject(description.subject);
  if (subject === undefined) return undefined;
  return quoted ? `"${subject}"` : subject;
}
