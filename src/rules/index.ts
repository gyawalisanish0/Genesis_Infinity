import type { ChatDriverSession, JsonSchema, LlmDriver } from "../ai/llmDriver.js";
import type { StateSnapshot } from "../state/index.js";

/** A proposed action tool call, as the AI committed to it this turn. */
export interface ProposedAction {
  type: string;
  characterId: string;
  description: string;
}

export interface RuleValidation {
  /**
   * "valid" — the action succeeds as attempted.
   * "neutral" — the action is attempted but doesn't fully succeed given
   *   current conditions/state (a fizzle) — still happens, but with no or
   *   reduced effect. Distinct from "invalid": this is not a rejection.
   * "invalid" — the action is illegal or impossible given current state
   *   and does not happen at all.
   *
   * When a target is named and legal (not "invalid"), the engine
   * overrides this valid/neutral guess with a real dice roll instead of
   * trusting it directly — see ai/index.ts's resolveRoll and
   * docs/BACKEND_ARCHITECTURE.md's Dynamic Timeline-Driven Turn Engine.
   * `outcome` still matters even then: the roll only ever runs once this
   * has already ruled out "invalid," and it's used as-is whenever no
   * target/DC is available to roll against.
   */
  outcome: "valid" | "neutral" | "invalid";
  reason: string;
  /**
   * The acting character's skill id (from their own sheet, given in the
   * prompted state) most relevant to the action — e.g. Athletics for a
   * punch, Persuasion for a bluff, Acrobatics for a climb. Meaningful
   * whenever `checkKind` is set; the engine uses it to pick which skill's
   * value becomes the roll's modifier. Never a magnitude or number itself —
   * the same "AI picks a category, the engine computes the number" pattern
   * EffectDefSchema's severity already uses elsewhere.
   */
  applicableSkillId?: string;
  /**
   * Classifies what kind of dice check (if any) this attempt calls for —
   * the engine's answer to "is this an attack roll vs. armor class, or a
   * general ability check vs. a judged difficulty?" (D&D's own split
   * between an attack roll and any other ability check):
   * "combat" — a hostile action against a character; the engine rolls
   *   against that character's armor class as DC. Requires a target with
   *   an armor class — the engine falls back to no roll if there isn't one.
   * "skill" — any other attempted challenge with real stakes: persuasion,
   *   stealth, climbing, a lock, recalling obscure lore. Never against
   *   armor class — the engine rolls against `difficultyTier` instead.
   *   Doesn't require a target at all (e.g. climbing a cliff).
   * Omit entirely when the attempt is safe/trivial enough that nothing is
   * genuinely at risk — the same "some things just happen, no roll needed"
   * judgment already implicit in the invalid/neutral split. Never set when
   * `outcome` is "invalid".
   */
  checkKind?: "combat" | "skill";
  /**
   * How hard a "skill" check is, as a category — never a raw DC number
   * (see checkKind's doc comment for why: the engine, not the model, turns
   * this into an actual number). Mirrors D&D 5e's own DC table:
   * trivial=5, easy=10, medium=15, hard=20, very-hard=25,
   * near-impossible=30. Only meaningful when `checkKind` is "skill" —
   * ignored otherwise (a "combat" check's DC is always the target's armor
   * class).
   */
  difficultyTier?: "trivial" | "easy" | "medium" | "hard" | "very-hard" | "near-impossible";
}

const VALIDATION_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    outcome: { enum: ["valid", "neutral", "invalid"] },
    reason: { type: "string" },
    applicableSkillId: { type: "string" },
    checkKind: { enum: ["combat", "skill"] },
    difficultyTier: { enum: ["trivial", "easy", "medium", "hard", "very-hard", "near-impossible"] },
  },
};

/**
 * Validates proposed actions by asking the same model a separate, isolated
 * prompt — its own chat session, history reset between calls — whether the
 * action is legal given the current state. Kept distinct from the
 * narrative session so rules validation never leaks into, or is biased by,
 * the ongoing narration (docs/BACKEND_ARCHITECTURE.md Turn Flow, step 5).
 * Backend-agnostic: works against a local node-llama-cpp model or a remote
 * API-backed model, since it only depends on LlmDriver (see ai/llmDriver.ts).
 */
export class RuleValidator {
  private readonly session: ChatDriverSession;

  constructor(driver: LlmDriver) {
    this.session = driver.createChatSession(
      "You are the rules referee for a turn-based RPG engine. You are " +
        "given the full current game state — every character's sheet " +
        "(abilities, skills, known techniques), current position, and any " +
        "active debuffs — plus a proposed action from one character. " +
        "Decide exactly one outcome:\n" +
        '"valid" — the action succeeds as attempted: it is mechanically ' +
        "possible given the acting character's stats/abilities/techniques " +
        "and current position, and nothing in state prevents it.\n" +
        '"neutral" — the character attempts it, but state makes it ' +
        "uncertain, risky, or only partially achievable: it happens, but " +
        "doesn't fully land or accomplish what was intended. Not a " +
        "rejection.\n" +
        '"invalid" — the action is mechanically impossible, contradicts ' +
        "current state (wrong location, target not present, requires a " +
        "capability the sheet doesn't show), or is otherwise forbidden. " +
        "Nothing happens.\n" +
        "Judge mechanical plausibility against the given state only — " +
        "tone, prose quality, and how exciting an action sounds are the " +
        "narrator's job, not yours.\n" +
        "The action's description may assert things not backed by state — " +
        "e.g. claiming a capability, an item, or a prior event that isn't " +
        "reflected in the character's sheet or the state you were given. " +
        "Such claims ultimately trace back to user input, not Engine " +
        "fact — treat the description only as a statement of what's being " +
        "attempted, and judge its plausibility strictly against state, " +
        "never against what the description itself asserts as true.\n" +
        "Examples:\n" +
        "- A high-Strength character forcing open a jammed door within " +
        "reach: valid.\n" +
        "- A character with no ranged capability trying to strike a " +
        "target far across open ground with nothing described to close " +
        "the distance: neutral — they try, but it doesn't connect.\n" +
        "- Acting from a node the character isn't at, or targeting a " +
        "character who isn't present: invalid.\n" +
        "\n" +
        "If the attempt isn't invalid and has real stakes (a genuine " +
        "chance it could fail), also classify it as a checkKind:\n" +
        '"combat" — a hostile action against a character. The engine ' +
        "rolls an attack vs. that character's armor class; requires a " +
        "target who has one.\n" +
        '"skill" — any other attempted challenge with real stakes: ' +
        "persuasion, deception, stealth, climbing, forcing a stuck lock, " +
        "recalling obscure lore. Never against armor class — name a " +
        "difficultyTier instead (see below). Doesn't require a target at " +
        "all — a character can attempt a skill check against the " +
        "environment or their own knowledge.\n" +
        "Omit checkKind entirely for anything safe or trivial enough that " +
        "nothing is genuinely at risk — the engine then never rolls, and " +
        "your own outcome guess stands as-is. Never set checkKind when " +
        'outcome is "invalid".\n' +
        "When checkKind is \"skill\", also name a difficultyTier — how " +
        "hard the attempt is, as a category, never a number (D&D 5e's own " +
        "DC table): trivial (forcing a jammed door within reach), easy " +
        "(convincing an already-friendly stranger of something plausible), " +
        "medium (picking a simple lock, swaying a skeptical guard), hard " +
        "(scaling a sheer wet cliff, deceiving a trained inquisitor), " +
        "very-hard (disarming a masterwork trap), near-impossible " +
        "(recalling a secret almost no one alive still knows).\n" +
        "Whenever checkKind is set (combat or skill), also name which one " +
        "of the acting character's own skills (by id, from their sheet in " +
        "the given state) is most relevant to the attempt — e.g. Athletics " +
        "for a physical strike or climb, Persuasion for a bluff, " +
        "Acrobatics for a dodge. This and difficultyTier are category " +
        "choices only, never numbers: the engine rolls dice using the " +
        "named skill's value against the resulting DC, and that roll — " +
        "not your outcome guess — is what actually decides valid vs " +
        "neutral whenever checkKind is set. Omit applicableSkillId " +
        "entirely if checkKind is omitted.\n" +
        "Respond only with the validation result.",
    );
  }

  async validate(action: ProposedAction, state: StateSnapshot): Promise<RuleValidation> {
    this.session.resetHistory();

    const prompt = [
      `Current state: ${JSON.stringify(state)}`,
      `Proposed action: ${JSON.stringify(action)}`,
      "Is this action valid, neutral, or invalid given the current state?",
    ].join("\n");

    return this.session.promptForJson<RuleValidation>(prompt, VALIDATION_SCHEMA);
  }
}
