import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { isKeyRelease, isKeyRepeat, matchesKey, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import {
	COLLAPSE_KEY_OFF,
	formatKeySpecForDisplay,
	loadConfig,
	resolveCollapseKey,
	validateGuidanceFields,
} from "./config.js";
import {
	ASK_USER_BLOCKED_EVENT,
	ASK_USER_PROMPT_EVENT,
	type AskUserBlockedEventPayload,
	type AskUserPromptEventPayload,
} from "./events.js";
// Static import is fine — rpc-fallback pulls only types + the i18n bridge,
// none of the ~560ms TUI render graph that QuestionnaireSession lazy-loads.
import { type DialogUI, hasDialogUI, runRpcQuestionnaire } from "./rpc-fallback.js";
import { displayLabel, t } from "./state/i18n-bridge.js";
import { sentinelsToAppend } from "./state/row-intent.js";
import { normalizeQuestionParams } from "./tool/normalize-params.js";
import { buildQuestionnaireResponse, buildToolResult } from "./tool/response-envelope.js";
import {
	MAX_OPTIONS,
	MAX_QUESTIONS,
	MIN_OPTIONS,
	type QuestionAnswer,
	type QuestionData,
	type QuestionnaireError,
	type QuestionnaireResult,
	type QuestionParams,
	QuestionParamsSchema,
} from "./tool/types.js";
import { validateQuestionnaire } from "./tool/validate-questionnaire.js";
import type { WrappingSelectItem } from "./view/components/wrapping-select.js";

/**
 * Temporary trace of the TUI dialog lifecycle (open/hide/reopen/done/editor),
 * mirroring the bridge's /tmp/pi-tg-bridge.log tracer. Used to diagnose
 * "TUI frozen until the Telegram answer" reports — remove once stable.
 */
function traceUi(msg: string): void {
	try {
		appendFileSync("/tmp/pi-ask-ui.log", `${new Date().toISOString()} ${msg}\n`);
	} catch {
		/* ignore */
	}
}

function emitAskUserPromptEvent(pi: ExtensionAPI, params: QuestionParams, toolCallId: string): void {
	const payload: AskUserPromptEventPayload = {
		toolCallId,
		questions: params.questions.map((q) => ({
			question: q.question,
			header: q.header,
			multiSelect: q.multiSelect ?? false,
			options: q.options.map((o) => ({
				label: o.label,
				description: o.description,
				hasPreview: typeof o.preview === "string" && o.preview.length > 0,
			})),
		})),
	};
	pi.events.emit(ASK_USER_PROMPT_EVENT, payload);
}

function emitAskUserBlockedEvent(
	pi: ExtensionAPI,
	active: boolean,
	summary?: string,
	perQuestion?: string[],
	selections?: number[][],
): void {
	const payload: AskUserBlockedEventPayload =
		summary === undefined
			? { active }
			: perQuestion === undefined
				? { active, summary }
				: selections === undefined
					? { active, summary, perQuestion }
					: { active, summary, perQuestion, selections };
	pi.events.emit(ASK_USER_BLOCKED_EVENT, payload);
}

/** Compact one-line rendering of a questionnaire outcome for external mirrors. */
function summarizeOutcome(result: QuestionnaireResult): string {
	if (result.cancelled) return "отменено пользователем";
	const parts = result.answers.map((a) => {
		const text = a.kind === "multi" && a.selected?.length ? a.selected.join(", ") : (a.answer ?? "—");
		return `${a.questionIndex + 1}) ${text}`;
	});
	return parts.length > 0 ? parts.join("; ") : "без ответа";
}

/** Per-question answer texts ("—" when a question has no answer). */
function summarizePerQuestion(result: QuestionnaireResult, total: number): string[] {
	if (result.cancelled) return [];
	const out = new Array<string>(total).fill("—");
	for (const a of result.answers) {
		const text = a.kind === "multi" && a.selected?.length ? a.selected.join(", ") : (a.answer ?? "—");
		if (a.questionIndex >= 0 && a.questionIndex < total) out[a.questionIndex] = text;
	}
	return out;
}

/**
 * Per-question selected option indices (1-based, matching the chat-server
 * `selections` convention used by permission cards: `[Allow(1), Deny(2)]`),
 * so an external mirror (pi-telegram-bridge → Telegram) can mark the chosen
 * option lines with a checkmark instead of appending only the text trail.
 * Empty array = custom-text answer, unanswered, or cancelled question.
 */
function summarizeSelections(result: QuestionnaireResult, typed: QuestionParams): number[][] {
	const out: number[][] = typed.questions.map(() => []);
	if (result.cancelled) return out;
	for (const a of result.answers) {
		if (a.questionIndex < 0 || a.questionIndex >= typed.questions.length) continue;
		const options = typed.questions[a.questionIndex].options;
		const indexOf = (label: string | null | undefined) =>
			label ? options.findIndex((o) => o.label === label) + 1 : 0;
		if (a.kind === "option") {
			const idx = indexOf(a.answer);
			if (idx > 0) out[a.questionIndex] = [idx];
		} else if (a.kind === "multi" && a.selected?.length) {
			const idxs = a.selected.map(indexOf).filter((i) => i > 0);
			if (idxs.length > 0) out[a.questionIndex] = idxs;
		}
	}
	return out;
}

/** Canonical tool name — single source of truth shared with the reconcile module. */
export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

/** Non-interactive host backstop (the reconciler normally strips the tool first). */
function rejectWithoutUi() {
	return buildToolResult(ERROR_NO_UI, { answers: [], cancelled: true, error: "no_ui" });
}

const ERROR_NO_UI = "Error: UI not available (running in non-interactive mode)";

const ERROR_NO_CUSTOM_UI =
	"Error: this client cannot render the questionnaire (custom UI is unavailable, e.g. RPC/ACP hosts such as Zed or Paseo). The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead, without using this tool.";

const ERROR_SESSION_LOAD_FAILED =
	"Error: the questionnaire UI failed to load — the host's installed dependencies were likely replaced or removed on disk while Pi was running (e.g. a package-manager install touched the store). The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead, and tell the user that restoring this tool requires repairing the install if needed and restarting Pi.";

const ERROR_STALE_MODULE_CACHE =
	"Error: the questionnaire UI cannot load — the host's module cache went stale after an earlier failed load (typically dependencies replaced on disk mid-session). This is unrecoverable within the current Pi process. The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead, and tell the user to restart Pi to restore this tool.";

/** Standard terminal bell — same byte rpiv-warp exports as OSC_TERMINATOR. */
export const BEL = "\x07";

/**
 * Shared event channel used by the optional Telegram bridge extension
 * (`pi-telegram-bridge`) to complete an in-flight ask_user_question dialog
 * programmatically after the user answers in Telegram.
 *
 * Payload: `{ toolCallId: string, answers: QuestionAnswer[] }`.
 * The dialog resolves with those answers (cancelled: false). A missing
 * listener is a no-op — the dialog stays open and answers on the terminal.
 */
export const ASK_EXTERNAL_RESOLVE_EVENT = "pi-telegram-bridge:resolve-ask" as const;

export interface ExternalResolvePayload {
	toolCallId: string;
	answers: QuestionAnswer[];
}

/**
 * Emit one portable terminal attention signal without touching redirected output.
 * Writes to stdout rather than rpiv-warp's `/dev/tty` transport: the `isTTY` gate
 * both proves an interactive terminal owns the coming wait and keeps the byte out
 * of piped RPC transports (VS Code pendant, Zed) — a `/dev/tty` write would ring
 * even when the questionnaire renders in a remote host's own UI.
 */
function emitTerminalAttention(): void {
	try {
		if (process.stdout.isTTY) process.stdout.write(BEL);
	} catch {
		// Terminal attention is best effort; the questionnaire must still proceed.
	}
}

/** Delay before the background session-graph pre-warm; mirrors rpiv-workflow's /wf prewarm. */
export const PREWARM_DELAY_MS = 2000;

type SessionModule = typeof import("./state/questionnaire-session.js");

type SessionRef = { current: import("./state/questionnaire-session.js").QuestionnaireSession | null };
type OverlayHandleRef = { current: OverlayHandle | undefined };

type SessionLoad =
	| { ok: true; module: SessionModule }
	| { ok: false, error: Extract<QuestionnaireError, "session_load_failed" | "stale_module_cache">; message: string };

/**
 * Lazy-load the ~560ms QuestionnaireSession view/TUI render graph, guarding
 * the two failure shapes of issue #107. Pi's jiti loader registers a module in
 * its graph cache BEFORE evaluating the body and does not evict it when
 * evaluation throws (jiti 2.7.0), so one failed load — e.g. `pnpm install
 * --force` replacing the store entry mid-session — leaves every later import
 * of this specifier resolving to a namespace without the class. That state is
 * unrecoverable in-process (cache-busting specifiers fail jiti resolution);
 * both branches therefore return an LLM-facing envelope that names the restart
 * requirement instead of leaking a bare "not a constructor" TypeError.
 */
export async function loadQuestionnaireSession(): Promise<SessionLoad> {
	let mod: SessionModule;
	try {
		mod = await import("./state/questionnaire-session.js");
	} catch (e) {
		const cause = e instanceof Error ? e.message : String(e);
		return { ok: false, error: "session_load_failed", message: `${ERROR_SESSION_LOAD_FAILED} (cause: ${cause})` };
	}
	if (typeof mod.QuestionnaireSession !== "function") {
		const keys = JSON.stringify(Object.keys(mod));
		return {
			ok: false,
			error: "stale_module_cache",
			message: `${ERROR_STALE_MODULE_CACHE} (resolved namespace keys: ${keys})`,
		};
	}
	return { ok: true, module: mod };
}

/**
 * Register the raw terminal listener that toggles collapse while the overlay is hidden.
 * Returns the remover, or undefined when the key is off / the host has no raw input hook —
 * callers derive `canReopenWhileHidden` from that.
 */
function registerCollapseKeyListener(
	ctx: ExtensionContext,
	collapseKey: string,
	sessionRef: SessionRef,
	overlayHandleRef: OverlayHandleRef,
): (() => void) | undefined {
	if (collapseKey === COLLAPSE_KEY_OFF || typeof ctx.ui.onTerminalInput !== "function") return undefined;
	let hasAnnouncedHide = false;
	return ctx.ui.onTerminalInput((data) => {
		const handle = overlayHandleRef.current;
		if (!handle) return undefined;
		// Only act while the questionnaire is hidden (its handleInput is
		// unreachable) or actually focused. When some other overlay is on
		// top (e.g. `/btw`), leave the keystroke to that overlay instead of
		// toggling the questionnaire from underneath it.
		if (!handle.isHidden() && !handle.isFocused()) return undefined;
		if (handle.isHidden()) {
			// Hidden overlay: pi-tui routes no input to it, so from the user's
			// point of view the TUI is dead until an external (Telegram) answer
			// resolves the dialog. The collapse binding keeps working (toggle/
			// consume repeat+release), and Esc — the universal "get me back" key
			// — reopens too. Every other key still passes through untouched.
			if (matchesKey(data, collapseKey as Parameters<typeof matchesKey>[1])) {
				if (isKeyRelease(data) || isKeyRepeat(data)) return { consume: true };
				traceUi(`toggle via ${collapseKey} -> visible`);
				sessionRef.current?.toggleCollapsedExternal();
				return { consume: true };
			}
			if (!matchesKey(data, "escape" as Parameters<typeof matchesKey>[1])) return undefined;
			if (isKeyRelease(data) || isKeyRepeat(data)) return { consume: true };
			traceUi("reopen via Esc while hidden");
			sessionRef.current?.toggleCollapsedExternal();
			return { consume: true };
		}
		if (!matchesKey(data, collapseKey as Parameters<typeof matchesKey>[1])) return undefined;
		// Kitty-protocol terminals report press, repeat, and release separately.
		// Toggle only on the initial press so a tap does not immediately reopen
		// the overlay and a held key does not toggle it repeatedly.
		if (isKeyRelease(data) || isKeyRepeat(data)) return { consume: true };
		traceUi(`toggle via ${collapseKey} -> hidden`);
		sessionRef.current?.toggleCollapsedExternal();
		if (handle.isHidden() && !hasAnnouncedHide) {
			hasAnnouncedHide = true;
			ctx.ui.notify?.(`ask_user_question hidden — press ${formatKeySpecForDisplay(collapseKey)} to reopen`, "info");
		}
		return { consume: true };
	});
}

/**
 * Build the `ctx.ui.custom` component factory: constructs the session (capturing it in
 * `sessionRef`) and exposes its component. `editInput` keeps its two dynamic imports —
 * they must stay lazy per-invocation.
 *
 * Telegram-bridge hook: before the session is constructed, `externalResolveRef` is
 * pointed at the factory's `done` so `ASK_EXTERNAL_RESOLVE_EVENT` can complete the
 * dialog with injected answers; the session's own `done` wrapper clears the ref so a
 * late bridge event is a no-op once the user answered on the terminal.
 */
function makeSessionFactory(config: {
	ctx: ExtensionContext;
	typed: QuestionParams;
	itemsByTab: WrappingSelectItem[][];
	collapseKey: string;
	canReopenWhileHidden: boolean;
	sessionRef: SessionRef;
	externalResolveRef: { current: ((result: QuestionnaireResult) => void) | null };
	Session: SessionModule["QuestionnaireSession"];
}) {
	const { ctx, typed, itemsByTab, collapseKey, canReopenWhileHidden, sessionRef, externalResolveRef, Session } = config;
	return (
		tui: TUI,
		theme: Theme,
		keybindings: import("./state/questionnaire-session.js").QuestionnaireSessionConfig["keybindings"],
		done: (result: QuestionnaireResult) => void,
	): import("./state/questionnaire-session.js").QuestionnaireSessionComponent => {
		// Bridge hook: when the user answers in Telegram first, the bridge emits
		// ASK_EXTERNAL_RESOLVE_EVENT and the dialog's `done` is invoked with the
		// injected answers.
		externalResolveRef.current = (resolved) => done(resolved);
		const session = new Session({
			tui,
			theme,
			params: typed,
			itemsByTab,
			done: (resolved) => {
				externalResolveRef.current = null;
				done(resolved);
			},
			keybindings,
			editInput: async (value) => {
				try {
					const [{ SettingsManager }, { editWithExternalEditor }] = await Promise.all([
						import("@earendil-works/pi-coding-agent"),
						import("./state/external-editor.js"),
					]);
					const editorCommand = SettingsManager.create(ctx.cwd, undefined, {
						projectTrusted: ctx.isProjectTrusted(),
					}).getExternalEditorCommand();
					if (!editorCommand) throw new Error("No external editor command is configured");
					return await editWithExternalEditor(tui, editorCommand, value);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`${t("editor.failed", "External editor failed")}: ${message}`, "error");
					return undefined;
				}
			},
			collapseKey,
			canReopenWhileHidden,
		});
		sessionRef.current = session;
		return session.component;
	};
}

/**
 * Pre-warm the lazy session graph once startup settles (#107). A graph
 * evaluated while the paths Pi resolved at boot still exist stays in memory
 * for the process lifetime, so later on-disk dependency churn (e.g. `pnpm
 * install --force` replacing the store mid-session) can no longer poison
 * jiti's graph cache. Swallowed failure is safe: the first real call
 * re-imports and surfaces it through loadQuestionnaireSession's structured
 * envelope. unref keeps the timer from holding a non-TUI embedder's process
 * open.
 */
function prewarmSessionGraph(): void {
	const timer = setTimeout(() => void loadQuestionnaireSession().catch(() => undefined), PREWARM_DELAY_MS);
	timer.unref?.();
}

export function buildItemsForQuestion(question: QuestionData): WrappingSelectItem[] {
	const items: WrappingSelectItem[] = question.options.map((o) => ({
		kind: "option",
		label: o.label,
		description: o.description,
	}));
	for (const kind of sentinelsToAppend(question)) {
		items.push({ kind, label: displayLabel(kind) });
	}
	return items;
}

export const DEFAULT_PROMPT_SNIPPET = `Ask the user up to ${MAX_QUESTIONS} structured questions (${MIN_OPTIONS}-${MAX_OPTIONS} options each) when requirements are ambiguous`;
export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	`Use ask_user_question whenever the user's request is underspecified and you cannot proceed without concrete decisions — you can ask up to ${MAX_QUESTIONS} questions per invocation.`,
	`Each question MUST have ${MIN_OPTIONS}-${MAX_OPTIONS} options. Every option requires a concise label (1-5 words) and a description explaining what the choice means or its trade-offs. The user can additionally type a custom answer via the automatically appended "Type something." row on every question, or press Esc to abandon the questionnaire. Do NOT author "Other" or "Type something." labels yourself — reserved labels are rejected at runtime.`,
	`Set multiSelect: true when multiple answers are valid. Provide an options[].preview markdown string when an option benefits from richer side-by-side context (mockups, code snippets, diagrams, configs) — single-select only. The "Type something." row is appended to every question; in preview mode it expands to the full pane width while typing so the custom answer is not cramped into the narrow options column. If you recommend a specific option, make that the first option and append "(Recommended)" to its label.`,
	"Do not stack multiple ask_user_question calls back-to-back — group all clarifying questions into one invocation.",
];

export const DEFAULT_TOOL_DESCRIPTION = `Ask the user one or more structured questions during execution. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

Usage notes:
- Users can type a custom answer via the automatically appended "Type something." row on every question or press Esc to abandon the questionnaire. Do NOT author "Other" or "Type something." labels yourself — reserved labels are rejected at runtime.
- Use multiSelect: true when multiple answers are valid. The "Type something." row is available on every question, including when options carry a \`preview\`; in preview mode it expands to the full pane width while typing so the custom answer is not cramped into the narrow options column.
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label.

Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Preview content is rendered as markdown in a monospace box. Multi-line text with newlines is supported. When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).`;

export function registerAskUserQuestionTool(pi: ExtensionAPI): void {
	const guidance = validateGuidanceFields(loadConfig().guidance);
	pi.registerTool({
		name: ASK_USER_QUESTION_TOOL_NAME,
		label: "Ask User Question",
		description: guidance.description ?? DEFAULT_TOOL_DESCRIPTION,
		promptSnippet: guidance.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: guidance.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
		parameters: QuestionParamsSchema,

		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			// Line-terminator normalization runs once here, ahead of validation, so
			// every downstream consumer — validator, TUI, RPC walker, envelope, prompt
			// event — sees the same clean text (#192).
			const typed = normalizeQuestionParams(params as unknown as QuestionParams);
			if (!ctx.hasUI) return rejectWithoutUi();
			traceUi(`open toolCallId=${toolCallId} questions=${typed.questions.length} mode=${(ctx as { mode?: string }).mode ?? "tui"}`);

			const validation = validateQuestionnaire(typed);
			if (!validation.ok) {
				return buildToolResult(validation.message, {
					answers: [],
					cancelled: true,
					error: validation.error,
				});
			}

			// Emit event for external listeners (e.g., notification plugins)
			emitAskUserPromptEvent(pi, typed, toolCallId);

			// A per-call registry letting the Telegram bridge close this dialog
			// when the user answers there first. The resolver is installed in the
			// TUI factory below; a stale event for a finished call is ignored.
			const externalResolveRef: {
				current: ((result: QuestionnaireResult) => void) | null;
			} = { current: null };
			const onExternalResolve = (payload: ExternalResolvePayload) => {
				if (payload?.toolCallId !== toolCallId) return;
				const resolve = externalResolveRef.current;
				externalResolveRef.current = null;
				if (!resolve) return;
				resolve({ answers: payload.answers ?? [], cancelled: false });
			};
			pi.events.on(ASK_EXTERNAL_RESOLVE_EVENT, onExternalResolve);

			try {
				// RPC hosts (VSCode pendant, ACP clients like Zed/Paseo — issue #78):
				// ui.custom() cannot render there, but the select/input dialog
				// sub-protocol works. Hosts that advertise ctx.mode (pi ≥0.79) route to
				// the sequential dialog walker up front, skipping the TUI render-graph
				// import entirely; RPC builds that predate ctx.mode are caught by the
				// custom()-resolved-undefined backstop below. See ./rpc-fallback.ts.
				if ((ctx as { mode?: string }).mode === "rpc" && hasDialogUI(ctx.ui)) {
					return await runRpcPath(pi, ctx.ui, typed);
				}

				const itemsByTab: WrappingSelectItem[][] = typed.questions.map((q) => buildItemsForQuestion(q));

				// Lazy — QuestionnaireSession pulls the ~560ms view/TUI render graph;
				// load it only when the tool runs, not at extension registration.
				const sessionLoad = await loadQuestionnaireSession();
				if (!sessionLoad.ok) {
					return buildToolResult(sessionLoad.message, { answers: [], cancelled: true, error: sessionLoad.error });
				}
				const { QuestionnaireSession } = sessionLoad.module;
				// Resolve the collapse/expand key spec from config. Default is `ctrl+]`; users
				// with non-US layouts (e.g. Latin American, where `]` is shifted) can override
				// via the `collapseKey` config field. `resolveCollapseKey` also accepts the
				// sentinel value `"off"` to disable the shortcut entirely.
				const collapseKey = resolveCollapseKey(loadConfig());

				// Capture the overlay handle so the session can call `setHidden()` when the
				// user toggles collapse, and register a raw terminal input listener for the
				// same key so the toggle still works while the overlay is hidden (pi-tui does
				// not route input to a hidden overlay's `component.handleInput`).
				const sessionRef: SessionRef = { current: null };
				const overlayHandleRef: OverlayHandleRef = { current: undefined };
				const removeOverlayInputListener = registerCollapseKeyListener(ctx, collapseKey, sessionRef, overlayHandleRef);
				// Hiding the overlay is only reversible through the raw listener above, so
				// the session may emit `setHidden` only when it was actually registered;
				// otherwise collapse falls back to the visible one-line row.
				const canReopenWhileHidden = removeOverlayInputListener !== undefined;

				let outcome: QuestionnaireResult | undefined;
				emitAskUserBlockedEvent(pi, true);
				try {
					emitTerminalAttention();
					const result = await ctx.ui.custom<QuestionnaireResult>(
						makeSessionFactory({
							ctx,
							typed,
							itemsByTab,
							collapseKey,
							canReopenWhileHidden,
							sessionRef,
							externalResolveRef,
							Session: QuestionnaireSession,
						}),
						{
							overlay: true,
							overlayOptions: {
								anchor: "bottom-center",
								width: "100%",
								maxHeight: "100%",
								margin: { left: 0, right: 0, bottom: 0 },
							},
							onHandle: (handle) => {
								overlayHandleRef.current = handle;
								sessionRef.current?.setOverlayHandle(handle);
							},
						},
					);

					if (result === undefined) {
						traceUi(`custom resolved undefined toolCallId=${toolCallId}`);
						if (hasDialogUI(ctx.ui)) {
							// custom() resolved undefined: host cannot render the TUI — fall back
							// to the RPC dialog walker so the user still sees the questions.
							const rpcOutcome = await runRpcQuestionnaire(ctx.ui, typed);
							outcome = rpcOutcome;
							return buildQuestionnaireResponse(rpcOutcome, typed);
						}
						outcome = { answers: [], cancelled: true, error: "no_custom_ui" };
						return buildToolResult(ERROR_NO_CUSTOM_UI, { answers: [], cancelled: true, error: "no_custom_ui" });
					}

					outcome = result;
					traceUi(`done toolCallId=${toolCallId} cancelled=${result.cancelled} answers=${result.answers.length} selections=${JSON.stringify(summarizeSelections(result, typed))}`);
					return buildQuestionnaireResponse(result, typed);
				} finally {
					removeOverlayInputListener?.();
					externalResolveRef.current = null;
					emitAskUserBlockedEvent(
						pi,
						false,
						outcome && summarizeOutcome(outcome),
						outcome ? summarizePerQuestion(outcome, typed.questions.length) : undefined,
						outcome ? summarizeSelections(outcome, typed) : undefined,
					);
				}
			} finally {
				pi.events.off?.(ASK_EXTERNAL_RESOLVE_EVENT, onExternalResolve);
				externalResolveRef.current = null;
			}
		},
	});

	prewarmSessionGraph();
}

/** Sequential native-dialog walker for RPC hosts; brackets it with the blocked-event pair + terminal bell. */
async function runRpcPath(pi: ExtensionAPI, ui: DialogUI, typed: QuestionParams) {
	emitAskUserBlockedEvent(pi, true);
	let rpcOutcome: QuestionnaireResult | undefined;
	try {
		emitTerminalAttention();
		rpcOutcome = await runRpcQuestionnaire(ui, typed);
		return buildQuestionnaireResponse(rpcOutcome, typed);
	} finally {
		emitAskUserBlockedEvent(
			pi,
			false,
			rpcOutcome && summarizeOutcome(rpcOutcome),
			rpcOutcome ? summarizePerQuestion(rpcOutcome, typed.questions.length) : undefined,
			rpcOutcome ? summarizeSelections(rpcOutcome, typed) : undefined,
		);
	}
}

export { buildQuestionnaireResponse, buildToolResult };
