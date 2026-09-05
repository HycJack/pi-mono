import { Marked, Renderer } from "marked";

/**
 * Markdown → safe HTML for chat bubbles.
 *
 * Raw HTML in the source is discarded (`html()` returns nothing), so model
 * output can never inject markup. Code blocks keep correct escaping because
 * marked's own `code` renderer runs on the original fence content. Fenced
 * HTML/SVG blocks are wrapped in a container carrying a Source/Preview toggle
 * that the caller wires up after insertion.
 */

const PREVIEW_LANGUAGES = new Set(["html", "svg", "xml", "xhtml"]);

/** Escape a plain string for safe use inside an HTML template. */
function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/**
 * True for complete HTML/SVG documents. Never partial fragments — those need a
 * wrapper before they render as a document.
 */
export function isPreviewableSource(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length === 0) return false;
	if (/^<\?xml\s/i.test(trimmed)) return true;
	if (/^<svg[\s>]/i.test(trimmed)) return true;
	if (/^<!doctype\s+html/i.test(trimmed)) return true;
	if (/^<html[\s>]/i.test(trimmed)) return true;
	return false;
}

/** Fenced blocks are previewable when the language tag says so, or when the body is a full document. */
export function isPreviewableCodeBlock(language: string | undefined, source: string): boolean {
	if (PREVIEW_LANGUAGES.has((language ?? "").trim().toLowerCase())) return true;
	return isPreviewableSource(source);
}

const renderer = new Renderer();
renderer.html = (): string => "";
renderer.code = ({ text, lang, escaped }) => {
	const language = (lang ?? "").trim().split(/\s+/)[0] ?? "";
	const code = `${(escaped ? text : escapeHtml(text)).replace(/[\r\n]+$/, "")}\n`;
	const pre = `<pre><code${language.length > 0 ? ` class="language-${escapeHtml(language)}"` : ""}>${code}</code></pre>`;
	if (!isPreviewableCodeBlock(lang, text)) return `${pre}\n`;
	const bar = `<div class="md-code-bar"><span class="md-code-lang">${escapeHtml(
		language.length > 0 ? language : "html",
	)}</span><button type="button" class="preview-toggle md-code-toggle">Preview</button></div>`;
	return `<div class="md-code">${bar}${pre}</div>\n`;
};

const marked = new Marked({
	gfm: true,
	breaks: false,
	renderer,
});

/** Render markdown text to sanitized HTML, or an empty string when input is nullish. */
export function renderMarkdown(text: string | undefined | null): string {
	if (text === undefined || text === null) return "";
	return marked.parse(text) as string;
}
