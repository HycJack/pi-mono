import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/client/ui/markdown.ts";

describe("renderMarkdown", () => {
	it("renders inline formatting", () => {
		const html = renderMarkdown("**bold** and *italic* and `code`");
		expect(html).toContain("<strong>bold</strong>");
		expect(html).toContain("<em>italic</em>");
		expect(html).toContain("<code>code</code>");
	});

	it("renders headings and lists", () => {
		const html = renderMarkdown("# Title\n\n- a\n- b");
		expect(html).toContain("<h1>Title</h1>");
		expect(html).toContain("<ul>");
		expect(html).toContain("<li>a</li>");
		expect(html).toContain("<li>b</li>");
	});

	it("renders fenced code blocks with language class", () => {
		const html = renderMarkdown("```js\nconst a = 1 < 2;\n```");
		expect(html).toContain('<pre><code class="language-js">');
		// Angle brackets stay escaped inside code.
		expect(html).toContain("&lt;");
		expect(html).not.toContain("<const");
	});

	it("strips raw HTML to prevent injection", () => {
		const html = renderMarkdown('hello <script>alert("xss")</script>');
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("</script>");
		expect(html).toContain("hello");
	});

	it("wraps language-tagged HTML/SVG blocks in a preview toggle", () => {
		const html = renderMarkdown("```html\n<div>fragment</div>\n```");
		expect(html).toContain('<div class="md-code">');
		expect(html).toContain('<span class="md-code-lang">html</span>');
		expect(html).toContain("md-code-toggle");
		expect(html).toContain("fragment");
	});

	it("also wraps untagged complete documents", () => {
		const html = renderMarkdown("```\n<!doctype html><html><body>hi</body></html>\n```");
		expect(html).toContain('<div class="md-code">');
		expect(html).toContain('<span class="md-code-lang">html</span>');

		expect(renderMarkdown('```\n<svg width="1"><rect/></svg>\n```')).toContain("md-code");
	});

	it("keeps other code blocks plain", () => {
		const html = renderMarkdown("```js\nconst a = 1;\n```\n\n```\n<div>fragment</div>\n```");
		expect(html).not.toContain("md-code");
		expect(html).toContain('<pre><code class="language-js">');
	});

	it("escapes code content inside previewable blocks", () => {
		const html = renderMarkdown("```html\n<div>a < b & c></div>\n```");
		expect(html).toContain("a &lt; b &amp; c&gt;");
		expect(html).not.toContain("a < b");
	});

	it("renders tables with GFM", () => {
		const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |");
		expect(html).toContain("<table>");
		expect(html).toContain("<th>a</th>");
	});

	it("returns empty for nullish input", () => {
		expect(renderMarkdown(null)).toBe("");
		expect(renderMarkdown(undefined)).toBe("");
	});
});
