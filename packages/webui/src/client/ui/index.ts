import { type AgentPromptImage, type LaneStateSnapshot, type ModelInfo, Transcript } from "../../shared/protocol.ts";
import { connectWebui, login, register, type WebuiClient } from "../api.ts";
import { isPreviewableSource, renderMarkdown } from "./markdown.ts";
import { onProvidersChanged, openSettings } from "./settings.ts";

const SESSION_STORAGE_KEY = "pi-webui-session";

interface StoredSession {
	readonly serverId: string;
	readonly token: string;
	readonly username: string;
}

function persistSession(session: StoredSession): void {
	localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

function loadStoredSession(): StoredSession | undefined {
	const raw = localStorage.getItem(SESSION_STORAGE_KEY);
	if (raw === null) return undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			typeof (parsed as StoredSession).serverId === "string" &&
			typeof (parsed as StoredSession).token === "string" &&
			typeof (parsed as StoredSession).username === "string"
		) {
			return parsed as StoredSession;
		}
	} catch {
		// Corrupted storage; treat as logged out.
	}
	localStorage.removeItem(SESSION_STORAGE_KEY);
	return undefined;
}

function clearPersistedSession(): void {
	localStorage.removeItem(SESSION_STORAGE_KEY);
}

interface ClientMessagePart {
	readonly type: string;
	readonly text?: string;
	readonly signature?: string;
	readonly name?: string;
	readonly arguments?: unknown;
	readonly toolCallId?: string;
	readonly id?: string;
	readonly thinking?: string;
	readonly data?: string;
	readonly mimeType?: string;
}

interface ClientMessage {
	readonly role: string;
	readonly content: readonly ClientMessagePart[];
	readonly toolName?: string;
	readonly toolCallId?: string;
}

type TagElementMap = {
	button: HTMLButtonElement;
	input: HTMLInputElement;
	select: HTMLSelectElement;
	textarea: HTMLTextAreaElement;
};

function el<K extends keyof TagElementMap>(tag: K, className?: string, text?: string): TagElementMap[K];
function el(tag: string, className?: string, text?: string): HTMLElement;
function el(tag: string, className?: string, text?: string): HTMLElement {
	const node = document.createElement(tag);
	if (className !== undefined) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

/** Inline SVG icon (Lucide-style, 24px viewBox), decorative by default. */
function icon(svg: string): string {
	return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${svg}</svg>`;
}

/** Escape a plain string for safe use inside an HTML template. */
function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

const ICONS = {
	logo: icon(`<path d="M12 3 4 21h16L12 3z"/><path d="M12 3v6l4 3"/>`),
	tool: icon(
		`<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>`,
	),
	think: icon(`<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>`),
	chevronRight: icon(`<path d="m9 18 6-6-6-6"/>`),
	compose: icon(`<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/><path d="M15 5l3 3"/>`),
	send: icon(`<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>`),
	stop: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>`,
	arrowLeft: icon(`<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>`),
	refresh: icon(
		`<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/>`,
	),
	image: icon(
		`<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>`,
	),
	plus: icon(`<path d="M12 5v14M5 12h14"/>`),
	logout: icon(`<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>`),
	close: icon(`<path d="M18 6 6 18M6 6l12 12"/>`),
	menu: icon(`<path d="M4 6h16M4 12h16M4 18h16"/>`),
	trash: icon(
		`<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>`,
	),
	settings: icon(
		`<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>`,
	),
} as const;

// --- Lightbox (image zoom) ---------------------------------------------------

let lightboxEl: HTMLElement | undefined;

function ensureLightbox(): HTMLElement {
	if (lightboxEl !== undefined) return lightboxEl;
	lightboxEl = document.createElement("div");
	lightboxEl.className = "lightbox";
	lightboxEl.setAttribute("role", "dialog");
	lightboxEl.setAttribute("aria-label", "Image preview");
	lightboxEl.innerHTML = `<button class="lightbox-close" aria-label="Close">${ICONS.close}</button><img class="lightbox-img" alt="Preview">`;
	lightboxEl.addEventListener("click", (event) => {
		if (event.target === lightboxEl || (event.target as HTMLElement).classList.contains("lightbox-close")) {
			closeLightbox();
		}
	});
	document.body.append(lightboxEl);
	return lightboxEl;
}

function openLightbox(src: string, alt?: string): void {
	const box = ensureLightbox();
	const img = box.querySelector(".lightbox-img") as HTMLImageElement;
	img.src = src;
	img.alt = alt ?? "Preview";
	box.classList.add("open");
	document.body.style.overflow = "hidden";
}

function closeLightbox(): void {
	if (lightboxEl === undefined) return;
	lightboxEl.classList.remove("open");
	document.body.style.overflow = "";
}

document.addEventListener("keydown", (event) => {
	if (event.key === "Escape" && lightboxEl?.classList.contains("open")) {
		closeLightbox();
	}
});

// --- File preview -------------------------------------------------------------

/**
 * Sandboxed iframe preview for a complete HTML/SVG document. `allow-scripts`
 * without `allow-same-origin` keeps the preview in an opaque origin, so
 * rendered model output can never read this page's session token or cookies.
 */
function createPreviewIframe(html: string): HTMLElement {
	const panel = el("div", "preview-panel");
	const iframe = document.createElement("iframe");
	iframe.className = "preview-iframe";
	iframe.setAttribute("sandbox", "allow-scripts");
	iframe.setAttribute("loading", "lazy");
	iframe.setAttribute("title", "HTML/SVG preview");
	const trimmed = html.trim();
	if (/^<svg[\s>]/i.test(trimmed) || /^<\?xml\s/i.test(trimmed)) {
		iframe.srcdoc = `<!DOCTYPE html><html><head><style>body{margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;background:transparent;}svg{max-width:100%;max-height:80vh;}</style></head><body>${trimmed}</body></html>`;
	} else {
		iframe.srcdoc = trimmed;
	}
	panel.append(iframe);
	return panel;
}

interface PreviewToggle {
	readonly button: HTMLButtonElement;
	readonly panel: HTMLElement;
}

/** Source/Preview toggle that swaps `sourceElement` for a rendered iframe. */
function makePreviewToggle(source: string, sourceElement: HTMLElement): PreviewToggle {
	const button = document.createElement("button");
	button.className = "preview-toggle";
	button.type = "button";
	button.textContent = "Preview";
	const panel = createPreviewIframe(source);
	panel.hidden = true;
	let active = false;
	button.addEventListener("click", () => {
		active = !active;
		sourceElement.hidden = active;
		panel.hidden = !active;
		button.textContent = active ? "Source" : "Preview";
	});
	return { button, panel };
}

function renderPart(part: ClientMessagePart): string {
	switch (part.type) {
		case "text":
			return part.text ?? "";
		case "thinking":
			// Thinking is rendered separately by makeAssistantEntry as a
			// collapsible reasoning row; return nothing here to avoid duplication.
			return "";
		case "toolCall":
			return `tool(${part.name ?? "tool"}): ${formatToolArgs(part.arguments)}`;
		case "toolResult":
			return `${part.name ?? "result"}: ${(part.text ?? "").slice(0, 500)}`;
		default:
			return "";
	}
}

function formatToolArgs(value: unknown): string {
	if (value === undefined || value === null) return "";
	try {
		const text = typeof value === "string" ? value : JSON.stringify(value);
		return text.length > 200 ? `${text.slice(0, 200)}…` : text;
	} catch {
		return String(value);
	}
}

function messageText(message: ClientMessage): string {
	const parts = message.content.map(renderPart).filter(Boolean);
	const toolLabel = message.toolName !== undefined ? `tool: ${message.toolName}` : "";
	return toolLabel.length > 0 ? [toolLabel, ...parts].join("\n") : parts.join("\n");
}

/** Append a markdown block (sanitized HTML) to a parent, wiring code previews. */
function appendMarkdown(parent: HTMLElement, text: string): void {
	const md = el("div", "md");
	md.innerHTML = renderMarkdown(text);
	for (const placeholder of md.querySelectorAll<HTMLButtonElement>(".md-code-toggle")) {
		wireCodePreview(placeholder);
	}
	parent.append(md);
}

/** Swap the renderer's placeholder button for a live Source/Preview toggle. */
function wireCodePreview(placeholder: HTMLButtonElement): void {
	const block = placeholder.closest(".md-code");
	const pre = block?.querySelector("pre");
	if (block === null || block === undefined || pre === null || pre === undefined) return;
	const { button, panel } = makePreviewToggle(pre.textContent ?? "", pre);
	placeholder.replaceWith(button);
	block.append(panel);
}

/** Append a base64 image part as an <img> element. */
function appendImage(parent: HTMLElement, part: ClientMessagePart): void {
	const img = document.createElement("img");
	img.className = "bubble-image";
	img.src = `data:${part.mimeType};base64,${part.data}`;
	img.alt = "attached image";
	img.loading = "lazy";
	parent.append(img);
}

/** Collapsible reasoning/thinking disclosure row (DeepSeek-style). */
function makeReasoningRow(text: string, streaming = false): HTMLElement {
	const root = el("div", "reasoning-row");
	root.setAttribute("data-state", streaming ? "running" : "ok");

	const header = el("button", "reasoning-header");
	header.type = "button";
	const iconSpan = el("span", "reasoning-icon");
	iconSpan.innerHTML = ICONS.think;
	const label = el("span", "reasoning-label", "Think");
	const summary = el("span", "reasoning-summary");
	// Collapsed: show first line (settled) or last line (streaming).
	const lines = text.split("\n").filter((l) => l.trim().length > 0);
	if (lines.length > 0) {
		summary.textContent = streaming ? lines[lines.length - 1] : lines[0];
	}
	const chevron = el("span", "reasoning-chevron");
	chevron.innerHTML = ICONS.chevronRight;
	header.append(iconSpan, label, summary, chevron);

	const body = el("div", "reasoning-body");
	body.textContent = text;
	body.hidden = true;

	let expanded = false;
	header.addEventListener("click", () => {
		expanded = !expanded;
		body.hidden = !expanded;
		if (expanded) root.setAttribute("data-expanded", "");
		else root.removeAttribute("data-expanded");
		chevron.classList.toggle("open", expanded);
	});

	root.append(header, body);
	return root;
}

function avatarMark(): HTMLElement {
	const mark = el("div", "avatar-mark");
	mark.innerHTML = ICONS.logo;
	return mark;
}

/** User turn: right-aligned rounded bubble with markdown text and images. */
function makeUserEntry(message: ClientMessage): HTMLElement {
	const entry = el("div", "entry user");
	const bubble = el("div", "bubble");
	const textParts: string[] = [];
	const flush = (): void => {
		if (textParts.length === 0) return;
		appendMarkdown(bubble, textParts.join("\n"));
		textParts.length = 0;
	};
	for (const part of message.content) {
		if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
			flush();
			appendImage(bubble, part);
			continue;
		}
		const text = renderPart(part);
		if (text.length > 0) textParts.push(text);
	}
	flush();
	entry.append(bubble);
	return entry;
}

/** Assistant turn: flat markdown block (no bubble) with an avatar mark. */
function makeAssistantEntry(message: ClientMessage, streaming = false): HTMLElement {
	const entry = el("div", "entry assistant");
	entry.append(avatarMark());

	// Separate thinking parts from text/image parts.
	const thinkingParts: string[] = [];
	const textParts: string[] = [];
	for (const part of message.content) {
		if (part.type === "thinking") {
			const text = part.text ?? "";
			if (text.length > 0) thinkingParts.push(text);
			continue;
		}
		if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
			// Flush text before image.
			if (textParts.length > 0) {
				appendMarkdown(entry, textParts.join("\n"));
				textParts.length = 0;
			}
			appendImage(entry, part);
			continue;
		}
		const text = renderPart(part);
		if (text.length > 0) textParts.push(text);
	}
	// Render thinking as collapsible disclosure rows.
	if (thinkingParts.length > 0) {
		const combinedThinking = thinkingParts.join("\n");
		entry.append(makeReasoningRow(combinedThinking, streaming));
	}
	// Render remaining text as markdown.
	if (textParts.length > 0) {
		appendMarkdown(entry, textParts.join("\n"));
	}
	if (streaming) entry.classList.add("streaming");
	return entry;
}

/** Unpaired tool result: plain monospace block with optional HTML/SVG preview. */
function makeToolResultEntry(message: ClientMessage): HTMLElement {
	const entry = el("div", "entry tool");
	const text = messageText(message);
	const block = el("pre", "mono-block");
	block.textContent = text;
	entry.append(block);

	if (isPreviewableSource(text)) {
		const { button, panel } = makePreviewToggle(text, block);
		entry.append(button, panel);
	}
	return entry;
}

function makeSummaryEntry(summary: string): HTMLElement {
	const entry = el("div", "entry summary");
	entry.innerHTML = `${ICONS.refresh}<span>${escapeHtml(summary)}</span>`;
	return entry;
}

// Collapsed/expanded state for tool cards, keyed by the tool call id.
const toolCardState = new Map<string, boolean | undefined>();

function toolCardKey(id: string | undefined): string {
	return id ?? `tool:${Object.keys(toolCardState).length}`;
}

function formatToolArguments(value: unknown): string {
	if (value === undefined || value === null) return "";
	try {
		return typeof value === "string" ? value : JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function toolResultText(message: ClientMessage): string {
	const parts = message.content.map(renderPart).filter(Boolean);
	return parts.join("\n");
}

/** One collapsible tool call with its result. */
function makeToolCard(call: ClientMessagePart, result: ClientMessage | undefined): HTMLElement {
	const key = toolCardKey(call.id ?? call.toolCallId);
	const open = toolCardState.get(key) === true;

	const card = el("div", "tool-card");
	const header = el("button", "tool-card-header");
	header.type = "button";
	header.setAttribute("aria-expanded", String(open));
	const title = el("span", "tool-card-title");
	title.innerHTML = `${ICONS.tool}<span>${escapeHtml(call.name ?? "tool")}</span>`;
	const arrow = el("span", "tool-card-arrow");
	arrow.innerHTML = ICONS.chevronRight;
	arrow.classList.toggle("open", open);
	header.append(title, arrow);

	const body = el("div", "tool-card-body");
	if (call.arguments !== undefined && call.arguments !== null) {
		const params = el("div", "tool-card-section");
		const label = el("div", "tool-card-label", "Arguments");
		const pre = el("pre", undefined, formatToolArguments(call.arguments));
		params.append(label, pre);
		body.append(params);
	}
	if (result !== undefined) {
		const resultSection = el("div", "tool-card-section");
		const resultText = toolResultText(result);
		const label = el("div", "tool-card-label");
		label.textContent = result.toolName ?? "Result";
		const pre = el("pre", undefined, resultText);
		resultSection.append(label, pre);

		if (isPreviewableSource(resultText)) {
			const { button, panel } = makePreviewToggle(resultText, pre);
			label.append(button);
			resultSection.append(panel);
		}
		body.append(resultSection);
	}
	body.hidden = !open;
	header.addEventListener("click", () => {
		const next = !(toolCardState.get(key) === true);
		toolCardState.set(key, next);
		body.hidden = !next;
		header.setAttribute("aria-expanded", String(next));
		arrow.classList.toggle("open", next);
	});

	card.append(header, body);
	return card;
}

/** True when Enter should submit the field: not mid-IME-composition. */
function isEnterSubmit(event: KeyboardEvent): boolean {
	if (event.key !== "Enter") return false;
	// During IME composition (CJK input), Enter confirms the candidate; treat
	// 229 (old WebKit/Edge) and isComposing as a non-submitting Enter.
	if (event.isComposing) return false;
	if (event.keyCode === 229) return false;
	return true;
}

// --- App shell ------------------------------------------------------------------

interface AppShell {
	root?: HTMLElement;
	client?: WebuiClient;
	activeId?: string;
	sidebar?: HTMLElement;
	list?: HTMLElement;
	pane?: HTMLElement;
	backdrop?: HTMLElement;
	unsubDirectory?: () => void;
	unsubTranscript?: () => void;
	unsubProviders?: () => void;
}

const app: AppShell = {};

function sessionLabel(sessionId: string): string {
	return `Chat ${sessionId.slice(0, 8)}`;
}

function bucketLabel(createdAt: number, now: number): string {
	const day = 86_400_000;
	const start = new Date(now);
	start.setHours(0, 0, 0, 0);
	const today = start.getTime();
	if (createdAt >= today) return "Today";
	if (createdAt >= today - day) return "Yesterday";
	if (createdAt >= today - 7 * day) return "Previous 7 days";
	return "Older";
}

function refreshSessionList(): void {
	const list = app.list;
	const client = app.client;
	if (list === undefined || client === undefined) return;
	const sessions = [...client.listSessions()].sort((a, b) => b.createdAt - a.createdAt);
	list.textContent = "";
	if (sessions.length === 0) {
		list.append(el("div", "session-empty", "No chats yet. Start one to begin."));
		return;
	}
	let currentGroup: HTMLElement | undefined;
	let currentBucket = "";
	for (const session of sessions) {
		const bucket = bucketLabel(session.createdAt, Date.now());
		if (bucket !== currentBucket || currentGroup === undefined) {
			currentBucket = bucket;
			currentGroup = el("div", "session-group");
			currentGroup.append(el("div", "session-group-label", bucket));
			list.append(currentGroup);
		}
		const item = el("div", "session-item");
		if (session.sessionId === app.activeId) item.classList.add("active");
		const openBtn = el("button", "session-open");
		openBtn.type = "button";
		openBtn.append(el("span", "session-title", sessionLabel(session.sessionId)));
		const del = el("button", "session-del");
		del.type = "button";
		del.setAttribute("aria-label", `Delete session ${session.sessionId.slice(0, 8)}`);
		del.innerHTML = ICONS.trash;
		del.addEventListener("click", (event) => {
			event.stopPropagation();
			if (!confirm(`Delete session ${session.sessionId.slice(0, 8)}?`)) return;
			void client
				.removeSession(session.sessionId)
				.then(() => {
					if (app.activeId === session.sessionId) leaveChat(false);
				})
				.catch((err) => alert(err instanceof Error ? err.message : String(err)));
		});
		openBtn.addEventListener("click", () => void openSession(session.sessionId));
		item.append(openBtn, del);
		currentGroup.append(item);
	}
}

function closeDrawer(): void {
	app.sidebar?.classList.remove("open");
	app.backdrop?.classList.remove("open");
}

function openDrawer(): void {
	app.sidebar?.classList.add("open");
	app.backdrop?.classList.add("open");
}

function setUserChip(username: string): void {
	const chip = app.sidebar?.querySelector(".user-chip");
	if (chip === undefined || chip === null) return;
	const avatar = chip.querySelector(".avatar");
	const name = chip.querySelector(".user-name");
	if (avatar !== null) avatar.textContent = username.slice(0, 2);
	if (name !== null) name.textContent = username;
}

/** Build (once) the persistent sidebar + pane shell. */
function buildShell(root: HTMLElement): void {
	if (app.root === root && app.sidebar !== undefined && app.pane !== undefined) return;
	root.textContent = "";

	const sidebar = el("aside", "sidebar");
	const brand = el("div", "sidebar-brand");
	const logo = el("div", "logo");
	logo.innerHTML = ICONS.logo;
	brand.append(logo, el("span", "brand-name", "Pi"));
	sidebar.append(brand);

	const newButton = el("button", "new-chat");
	newButton.type = "button";
	newButton.innerHTML = `${ICONS.compose}<span>New chat</span>`;
	newButton.addEventListener("click", () => void createSession());
	sidebar.append(newButton);

	const list = el("nav", "session-list");
	list.setAttribute("aria-label", "Chats");
	sidebar.append(list);

	const footer = el("div", "sidebar-footer");
	const settingsButton = el("button", "icon-btn sidebar-settings");
	settingsButton.type = "button";
	settingsButton.setAttribute("aria-label", "Settings");
	settingsButton.title = "Settings";
	settingsButton.innerHTML = ICONS.settings;
	settingsButton.addEventListener("click", () => {
		const client = app.client;
		if (client !== undefined) openSettings(client);
	});
	const userChip = el("div", "user-chip");
	const avatar = el("span", "avatar");
	const userName = el("span", "user-name");
	const userLogout = el("button", "icon-btn user-logout");
	userLogout.type = "button";
	userLogout.setAttribute("aria-label", "Log out");
	userLogout.innerHTML = ICONS.logout;
	userLogout.addEventListener("click", () => logout());
	userChip.append(avatar, userName, userLogout);
	footer.append(settingsButton, userChip);
	sidebar.append(footer);

	const pane = el("main", "pane");
	const backdrop = el("div", "sidebar-backdrop");
	backdrop.addEventListener("click", closeDrawer);

	// The shell is one self-contained screen: the two-column grid lives here,
	// not on #app, so login/loading screens never share its columns.
	const shell = el("div", "app-shell");
	shell.append(sidebar, pane, backdrop);
	root.append(shell);
	app.root = root;
	app.sidebar = sidebar;
	app.list = list;
	app.pane = pane;
	app.backdrop = backdrop;
}

async function createSession(): Promise<void> {
	const client = app.client;
	if (client === undefined) return;
	// No configured model yet: go straight to the provider form instead of failing.
	if ((await client.listModels().catch(() => [] as readonly ModelInfo[])).length === 0) {
		openSettings(client);
		return;
	}
	try {
		const summary = await client.createSession();
		await openSession(summary.sessionId);
	} catch (err) {
		alert(err instanceof Error ? err.message : String(err));
	}
}

function logout(): void {
	clearPersistedSession();
	const root = app.root;
	app.client?.dispose().finally(() => {
		app.client = undefined;
		app.activeId = undefined;
		app.root = undefined;
		app.sidebar = undefined;
		app.pane = undefined;
		app.backdrop = undefined;
		app.unsubDirectory = undefined;
		app.unsubTranscript = undefined;
		app.unsubProviders?.();
		app.unsubProviders = undefined;
		if (root !== undefined) renderLogin(root);
	});
}

async function openSession(sessionId: string): Promise<void> {
	const client = app.client;
	if (client === undefined) return;
	try {
		await client.attach(sessionId);
		app.activeId = sessionId;
		renderChat(client, sessionId);
		closeDrawer();
		refreshSessionList();
	} catch (err) {
		alert(err instanceof Error ? err.message : String(err));
	}
}

/** Detach (optional) and return to the welcome pane. */
function leaveChat(detach: boolean): void {
	if (detach) void app.client?.detach().catch(() => {});
	app.activeId = undefined;
	app.unsubTranscript?.();
	app.unsubTranscript = undefined;
	app.unsubProviders?.();
	app.unsubProviders = undefined;
	refreshSessionList();
	showWelcome();
}

function showWelcome(): void {
	const pane = app.pane;
	if (pane === undefined) return;
	app.unsubTranscript?.();
	app.unsubTranscript = undefined;
	app.unsubProviders?.();
	app.unsubProviders = undefined;
	pane.textContent = "";

	// Slim header so the sidebar drawer stays reachable on mobile.
	const header = el("header", "chat-header");
	const menuToggle = el("button", "icon-btn menu-toggle");
	menuToggle.type = "button";
	menuToggle.setAttribute("aria-label", "Open sidebar");
	menuToggle.innerHTML = ICONS.menu;
	menuToggle.addEventListener("click", openDrawer);
	header.append(menuToggle, el("div", "header-spacer"));
	pane.append(header);

	const welcome = el("div", "pane-welcome");
	const inner = el("div", "welcome-inner");
	const logo = el("div", "welcome-logo");
	logo.innerHTML = ICONS.logo;
	const greeting = el("h1", undefined, "What can I help with?");
	const sub = el("p", undefined, "Start a new chat or pick a recent one from the sidebar.");
	const start = el("button", "primary welcome-cta");
	start.type = "button";
	start.innerHTML = `${ICONS.compose}<span>New chat</span>`;
	start.addEventListener("click", () => void createSession());
	inner.append(logo, greeting, sub, start);
	welcome.append(inner);
	pane.append(welcome);
}

function enterApp(root: HTMLElement, client: WebuiClient): void {
	app.client = client;
	app.activeId = undefined;
	buildShell(root);
	setUserChip(client.username);
	app.unsubDirectory?.();
	app.unsubDirectory = undefined;
	app.unsubDirectory = client.onSessionsChange(refreshSessionList);
	refreshSessionList();
	showWelcome();
}

// --- Login screen ---------------------------------------------------------------

function renderLogin(root: HTMLElement): void {
	root.textContent = "";
	const screen = el("div", "login-screen");
	const card = el("div", "login-card");

	const brand = el("div", "login-brand");
	const logo = el("div", "logo");
	logo.innerHTML = ICONS.logo;
	brand.append(logo, el("span", "brand-name", "Pi"));

	const title = el("h1", "login-title", "Sign in");
	const sub = el("p", "login-sub", "Log in or create an account to access your agent chats.");

	const usernameField = el("label", "field");
	usernameField.append(el("span", "field-label", "Username"));
	const username = document.createElement("input");
	username.type = "text";
	username.placeholder = "Username";
	username.autocomplete = "username";
	username.setAttribute("aria-label", "Username");
	usernameField.append(username);

	const passwordField = el("label", "field");
	passwordField.append(el("span", "field-label", "Password"));
	const password = document.createElement("input");
	password.type = "password";
	password.placeholder = "Password";
	password.autocomplete = "current-password";
	password.setAttribute("aria-label", "Password");
	passwordField.append(password);

	const error = el("div", "error");
	error.setAttribute("role", "alert");
	const loginButton = el("button", "primary", "Log in");
	loginButton.type = "button";
	const registerButton = el("button", "secondary", "Create account");
	registerButton.type = "button";

	const submit = async (mode: "login" | "register"): Promise<void> => {
		error.textContent = "";
		loginButton.disabled = true;
		registerButton.disabled = true;
		try {
			const result =
				mode === "login"
					? await login(username.value, password.value)
					: await register(username.value, password.value);
			const client = await connectWebui(result.serverId, result.token, username.value);
			persistSession({ serverId: result.serverId, token: result.token, username: username.value });
			enterApp(root, client);
		} catch (err) {
			error.textContent = err instanceof Error ? err.message : String(err);
			loginButton.disabled = false;
			registerButton.disabled = false;
		}
	};
	loginButton.addEventListener("click", () => void submit("login"));
	registerButton.addEventListener("click", () => void submit("register"));
	password.addEventListener("keydown", (event) => {
		if (isEnterSubmit(event)) void submit("login");
	});

	card.append(brand, title, sub, usernameField, passwordField, error, loginButton, registerButton);
	screen.append(card);
	root.append(screen);
}

// --- Chat screen ----------------------------------------------------------------

interface TranscriptSnapshot {
	transcript: readonly {
		type: string;
		message?: ClientMessage;
		summary?: string;
	}[];
	configuration?: { model?: { provider?: string; modelId?: string } };
	operation: {
		id: string;
		status: string;
		streamingMessage?: { content?: readonly ClientMessagePart[] } | null;
	} | null;
	faulted: boolean;
}

function renderChat(client: WebuiClient, sessionId: string): void {
	const pane = app.pane;
	if (pane === undefined) return;
	pane.textContent = "";
	app.unsubTranscript?.();
	app.unsubTranscript = undefined;
	app.unsubProviders?.();
	app.unsubProviders = undefined;

	// Top bar: drawer toggle (mobile), back to welcome, title, live status.
	const header = el("header", "chat-header");
	const menuToggle = el("button", "icon-btn menu-toggle");
	menuToggle.type = "button";
	menuToggle.setAttribute("aria-label", "Open sidebar");
	menuToggle.innerHTML = ICONS.menu;
	menuToggle.addEventListener("click", openDrawer);
	const back = el("button", "icon-btn header-back");
	back.type = "button";
	back.setAttribute("aria-label", "Back to start");
	back.innerHTML = ICONS.arrowLeft;
	back.addEventListener("click", () => leaveChat(true));
	const titleEl = el("h1", undefined, sessionLabel(sessionId));
	const modelSelect = document.createElement("select");
	modelSelect.className = "model-select";
	modelSelect.setAttribute("aria-label", "Model");
	const statusEl = el("div", "chat-status");
	const statusDot = el("span", "dot");
	const statusLabel = el("span");
	statusEl.append(statusDot, statusLabel);
	header.append(menuToggle, back, titleEl, modelSelect, el("div", "header-spacer"), statusEl);
	pane.append(header);

	// Sub-lanes: a slim chip bar, ChatGPT-style inline rather than a panel.
	const laneBar = el("div", "lane-bar");
	laneBar.append(el("span", "lane-label", "Lanes"));
	const laneChips = el("div", "lane-chips");
	const laneInput = document.createElement("input");
	laneInput.placeholder = "New lane";
	laneInput.setAttribute("aria-label", "New sub-lane name");
	const laneAdd = el("button", "icon-btn lane-add");
	laneAdd.type = "button";
	laneAdd.setAttribute("aria-label", "Add sub-lane");
	laneAdd.innerHTML = ICONS.plus;
	laneBar.append(laneChips, laneInput, laneAdd);
	pane.append(laneBar);
	const refreshLanes = async (): Promise<void> => {
		const names = await client.listLanes();
		laneChips.textContent = "";
		for (const name of names) {
			const isMain = name === "main";
			const chip = el("span", `lane-chip${isMain ? " main" : ""}`, isMain ? "main" : name);
			laneChips.append(chip);
		}
	};
	laneAdd.addEventListener("click", () => {
		const name = laneInput.value.trim();
		if (name.length === 0) return;
		void client
			.acquireSubLane(name)
			.then(() => {
				laneInput.value = "";
				return refreshLanes();
			})
			.catch((err) => alert(err instanceof Error ? err.message : String(err)));
	});
	laneInput.addEventListener("keydown", (event) => {
		if (isEnterSubmit(event)) laneAdd.click();
	});
	void refreshLanes();

	const transcript = el("div", "transcript");
	transcript.addEventListener("click", (event) => {
		const target = event.target;
		if (target instanceof HTMLImageElement && (target.classList.contains("bubble-image") || target.closest(".md"))) {
			openLightbox(target.src, target.alt);
		}
	});
	pane.append(transcript);

	// Composer: rounded card with input, attachments, and a circular send/stop.
	const composerWrap = el("footer", "composer-wrap");
	const composer = el("div", "composer");
	const previewRow = el("div", "image-preview-row");
	previewRow.hidden = true;
	const input = document.createElement("textarea");
	input.className = "composer-input";
	input.rows = 1;
	input.placeholder = "Message the agent…";
	input.setAttribute("aria-label", "Message the agent");
	const actions = el("div", "composer-actions");
	const attachButton = el("button", "icon-btn attach-btn");
	attachButton.type = "button";
	attachButton.setAttribute("aria-label", "Add image");
	attachButton.innerHTML = ICONS.image;
	attachButton.hidden = true; // revealed only for multimodal models
	const resumeBtn = el("button", "chip resume-btn", "Resume");
	resumeBtn.type = "button";
	resumeBtn.hidden = true;
	const sendBtn = el("button", "send-btn");
	sendBtn.type = "button";
	sendBtn.setAttribute("aria-label", "Send message");
	sendBtn.innerHTML = ICONS.send;
	sendBtn.disabled = true;
	const stopBtn = el("button", "send-btn stop-btn");
	stopBtn.type = "button";
	stopBtn.setAttribute("aria-label", "Stop generating");
	stopBtn.innerHTML = ICONS.stop;
	stopBtn.hidden = true;
	actions.append(attachButton, el("div", "actions-spacer"), resumeBtn, stopBtn, sendBtn);
	composer.append(previewRow, input, actions);
	const note = el("div", "composer-note");
	const hint = el("div", "composer-hint", "Pi can make mistakes. Check important info.");
	composerWrap.append(composer, note, hint);
	pane.append(composerWrap);

	const autoGrow = (): void => {
		input.style.height = "auto";
		input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
		updateSendState();
	};

	// Image attachments (multimodal only): a hidden file input backed by a
	// visible picker, plus a thumbnail strip with per-image removal.
	const pendingImages: { data: string; mimeType: string }[] = [];
	const imagePicker = document.createElement("input");
	imagePicker.type = "file";
	imagePicker.accept = "image/*";
	imagePicker.multiple = true;
	imagePicker.hidden = true;

	const renderPreviews = (): void => {
		previewRow.textContent = "";
		previewRow.hidden = pendingImages.length === 0;
		for (let index = 0; index < pendingImages.length; index += 1) {
			const attachment = pendingImages[index]!;
			const thumb = el("div", "image-thumb");
			const img = document.createElement("img");
			img.src = `data:${attachment.mimeType};base64,${attachment.data}`;
			img.alt = "attachment";
			const remove = el("button", "image-thumb-remove");
			remove.type = "button";
			remove.setAttribute("aria-label", "Remove image");
			remove.innerHTML = ICONS.close;
			remove.addEventListener("click", () => {
				pendingImages.splice(index, 1);
				renderPreviews();
				updateSendState();
			});
			thumb.append(img, remove);
			previewRow.append(thumb);
		}
		updateSendState();
	};

	attachButton.addEventListener("click", () => imagePicker.click());
	imagePicker.addEventListener("change", () => {
		const files = [...(imagePicker.files ?? [])];
		imagePicker.value = "";
		for (const file of files) {
			if (!file.type.startsWith("image/")) continue;
			if (file.size > 8 * 1024 * 1024) {
				setNote(`Image too large (max 8 MB): ${file.name ?? file.type}`);
				continue;
			}
			void file
				.arrayBuffer()
				.then((buffer) => {
					const bytes = new Uint8Array(buffer);
					let binary = "";
					for (const byte of bytes) binary += String.fromCharCode(byte);
					pendingImages.push({ data: btoa(binary), mimeType: file.type });
					renderPreviews();
				})
				.catch((error: unknown) => setNote(error instanceof Error ? error.message : String(error)));
		}
	});
	composer.append(imagePicker);

	const setNote = (message: string): void => {
		note.textContent = message;
		note.hidden = message.length === 0;
	};

	// Whether this session's model can accept images; hides the picker when not.
	const syncCapabilities = (): void => {
		void client
			.capabilities()
			.then((caps) => {
				attachButton.hidden = !caps.image;
			})
			.catch(() => {
				attachButton.hidden = true;
			});
	};
	syncCapabilities();

	// Model picker: only models whose provider has configured credentials.
	const refreshModelList = async (): Promise<void> => {
		const models = await client.listModels();
		const previous = modelSelect.value;
		modelSelect.textContent = "";
		let group: HTMLOptGroupElement | undefined;
		for (const model of models) {
			if (group === undefined || group.dataset.provider !== model.provider) {
				group = document.createElement("optgroup");
				group.label = model.providerName;
				group.dataset.provider = model.provider;
				modelSelect.append(group);
			}
			const option = document.createElement("option");
			option.value = `${model.provider}/${model.modelId}`;
			option.textContent = model.name;
			group.append(option);
		}
		// Keep the current selection when it is still offered.
		if (previous !== "" && [...modelSelect.options].some((option) => option.value === previous)) {
			modelSelect.value = previous;
		}
		modelSelect.disabled = models.length === 0;
	};
	void refreshModelList().catch(() => {
		modelSelect.disabled = true;
	});
	modelSelect.addEventListener("change", () => {
		// Provider ids never contain "/"; model ids sometimes do (e.g. Ollama tags).
		const separator = modelSelect.value.indexOf("/");
		if (separator <= 0) return;
		const identity = {
			provider: modelSelect.value.slice(0, separator),
			modelId: modelSelect.value.slice(separator + 1),
		};
		void client
			.setModel(identity)
			.then(syncCapabilities)
			.catch((err) => alert(err instanceof Error ? err.message : String(err)));
	});

	// A provider saved or deleted in Settings changes which models are usable.
	app.unsubProviders = onProvidersChanged(() => {
		void refreshModelList().catch(() => {
			modelSelect.disabled = true;
		});
	});

	let currentSnapshot: LaneStateSnapshot | null = null;
	let running = false;

	function updateSendState(): void {
		if (running) {
			sendBtn.disabled = true;
			return;
		}
		sendBtn.disabled = input.value.trim().length === 0 && pendingImages.length === 0;
	}

	const renderMessages = (): void => {
		const wasNearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 120;
		transcript.textContent = "";
		// The replicated Transcript state is shared across attaches: right
		// after switching sessions it still holds the *previous* session's
		// snapshot. Only render envelopes whose sessionId matches this chat,
		// or the stale transcript leaks into the new view (layout jumps) and
		// the derived title gets written under the wrong session id.
		if (currentSnapshot === null || currentSnapshot.sessionId !== sessionId || currentSnapshot.snapshot === null) {
			running = false;
			statusEl.classList.remove("running", "faulted");
			statusLabel.textContent = "loading…";
			sendBtn.hidden = false;
			stopBtn.hidden = true;
			resumeBtn.hidden = true;
			updateSendState();
			return;
		}
		const snapshot = currentSnapshot.snapshot as unknown as TranscriptSnapshot;

		// Pre-scan: collect tool calls and pair them with their results by id.
		const calls: { part: ClientMessagePart; result?: ClientMessage }[] = [];
		const resultById = new Map<string, ClientMessage>();
		for (const entry of snapshot.transcript) {
			if (entry.type !== "message" || entry.message === undefined) continue;
			const message = entry.message;
			if (message.role === "assistant") {
				for (const part of message.content) {
					if (part.type === "toolCall") calls.push({ part });
				}
			} else if (message.role === "toolResult" && message.toolCallId !== undefined) {
				resultById.set(message.toolCallId, message);
			}
		}
		for (const call of calls) {
			const id = call.part.id ?? call.part.toolCallId;
			if (id !== undefined) {
				const result = resultById.get(id);
				if (result !== undefined) call.result = result;
			}
		}
		const resultConsumed = new Set<string>();
		for (const entry of snapshot.transcript) {
			if (entry.type === "compaction" || entry.type === "branch_summary") {
				transcript.append(makeSummaryEntry(entry.summary ?? ""));
				continue;
			}
			if (entry.type !== "message" || entry.message === undefined) continue;
			const message = entry.message;
			if (message.role === "toolResult") {
				// Rendered as part of its tool card (default) or standalone.
				if (message.toolCallId !== undefined && resultConsumed.has(message.toolCallId)) continue;
				transcript.append(makeToolResultEntry(message));
				continue;
			}
			if (message.role === "assistant") {
				const toolBlocks = message.content.filter((part) => part.type === "toolCall");
				for (const part of toolBlocks) {
					const id = part.id ?? part.toolCallId;
					const call = calls.find((c) => c.part === part);
					const card = makeToolCard(part, call?.result);
					if (id !== undefined) resultConsumed.add(id);
					transcript.append(card);
				}
				const textBlocks = message.content.filter((part) => part.type !== "toolCall");
				if (textBlocks.some((part) => part.type === "text" || part.type === "image")) {
					transcript.append(makeAssistantEntry({ ...message, content: textBlocks }));
				}
				continue;
			}
			if (message.role === "user") {
				transcript.append(makeUserEntry(message));
				continue;
			}
			transcript.append(makeToolResultEntry(message));
		}
		// Live stream: the in-flight assistant message renders as it grows.
		const streaming = snapshot.operation?.streamingMessage;
		if (streaming !== undefined && streaming !== null) {
			const text = messageText(streaming as unknown as ClientMessage);
			if (text.length > 0) {
				transcript.append(makeAssistantEntry(streaming as unknown as ClientMessage, true));
			}
		}

		// Header status + composer controls.
		running = snapshot.operation !== null;
		statusEl.classList.toggle("running", running);
		statusEl.classList.toggle("faulted", snapshot.faulted);
		if (running) statusLabel.textContent = snapshot.operation?.status ?? "running";
		else if (snapshot.faulted) statusLabel.textContent = "faulted";
		else statusLabel.textContent = "idle";

		// Keep the picker in sync with the session's configured model.
		const configuredModel = snapshot.configuration?.model;
		if (configuredModel?.provider !== undefined && configuredModel.modelId !== undefined) {
			const key = `${configuredModel.provider}/${configuredModel.modelId}`;
			if (modelSelect.value !== key) modelSelect.value = key;
		}
		sendBtn.hidden = running;
		stopBtn.hidden = !running;
		resumeBtn.hidden = !snapshot.faulted;
		updateSendState();

		if (wasNearBottom) transcript.scrollTop = transcript.scrollHeight;
	};

	const transcriptService = client.sessionServices.use(Transcript);
	const sync = (): void => {
		currentSnapshot = transcriptService.state.value ?? null;
		renderMessages();
	};
	sync();
	// Subscribe to the replicated transcript state directly; calling
	// `observe` here would reuse the same service in a second (keyed) mode.
	app.unsubTranscript = transcriptService.state.subscribe(() => sync());

	const send = (): void => {
		const text = input.value.trim();
		const images: readonly AgentPromptImage[] | null =
			pendingImages.length > 0
				? pendingImages.map(({ data, mimeType }): AgentPromptImage => ({ type: "image", data, mimeType }))
				: null;
		if (text.length === 0 && images === null) return;
		input.value = "";
		pendingImages.length = 0;
		renderPreviews();
		autoGrow();
		setNote("");
		void client
			.prompt(text, images)
			.then((result) => {
				if (!result.accepted && result.error !== null) setNote(`rejected: ${result.error}`);
			})
			.catch((err) => setNote(err instanceof Error ? err.message : String(err)));
	};
	input.addEventListener("keydown", (event) => {
		if (isEnterSubmit(event) && !event.shiftKey) {
			event.preventDefault();
			if (!sendBtn.disabled) send();
		}
	});
	input.addEventListener("input", autoGrow);
	sendBtn.addEventListener("click", send);
	stopBtn.addEventListener("click", () => {
		const raw = currentSnapshot?.snapshot;
		const operation =
			raw !== null && raw !== undefined ? (raw as { operation: { id: string } | null }).operation : null;
		if (operation !== null && operation !== undefined) {
			void client.abort(operation.id).catch((err) => alert(err instanceof Error ? err.message : String(err)));
		}
	});
	resumeBtn.addEventListener("click", () => {
		void client
			.resume()
			.then((result) => {
				if (!result.accepted && result.error !== null) setNote(`rejected: ${result.error}`);
			})
			.catch((err) => alert(err instanceof Error ? err.message : String(err)));
	});

	input.focus();
}

export function mount(root: HTMLElement): void {
	// Restore the persisted login (token + serverId) across page reloads.
	const stored = loadStoredSession();
	if (stored === undefined) {
		renderLogin(root);
		return;
	}
	const loading = el("div", "app-loading", "Reconnecting…");
	root.textContent = "";
	root.append(loading);
	void connectWebui(stored.serverId, stored.token, stored.username)
		.then((client) => enterApp(root, client))
		.catch((err) => {
			console.error("restore session failed:", err);
			clearPersistedSession();
			renderLogin(root);
		});
}
