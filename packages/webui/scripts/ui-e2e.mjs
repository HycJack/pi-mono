/**
 * Real-browser E2E: drives the actual webui UI in headless Chrome.
 *
 * Steps:
 *  1. Open the login page, log in as admin.
 *  2. Wait for the sessions list to render the persisted sessions.
 *  3. Reload the page: the session must be restored without re-login.
 *  4. Report page errors (console + uncaught exceptions).
 *
 * Usage: node scripts/ui-e2e.mjs [chrome-path] [base-url] [username] [password]
 */

import { chromium } from "playwright";

const chromeExec = process.argv[2] ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const baseUrl = process.argv[3] ?? "http://127.0.0.1:3112";
const username = process.argv[4] ?? "admin";
const password = process.argv[5] ?? "admin1234";

const browser = await chromium.launch({ executablePath: chromeExec, headless: true });
const page = await browser.newPage();

const consoleErrors = [];
const pageErrors = [];
page.on("console", (msg) => {
	if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (error) => pageErrors.push(String(error)));

try {
	// 1. Login
	await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
	await page.waitForSelector("input[placeholder='Username']", { timeout: 10_000 });
	await page.fill("input[placeholder='Username']", username);
	await page.fill("input[placeholder='Password']", password);
	await page.click("button:has-text('Log in')");

	// 2. Sessions list should render persisted sessions.
	await page.waitForSelector(".session-list .session-item", { timeout: 10_000 });
	const sessionItems = await page.locator(".session-list .session-item").count();
	console.log("sessions rendered:", sessionItems);

	// 3. Reload: must restore the session without the login form.
	await page.reload({ waitUntil: "domcontentloaded" });
	const loginShown = await page.locator("input[placeholder='Username']").count();
	const restoredItems = await page.locator(".session-list .session-item").count();
	console.log("after reload -> login form shown:", loginShown, "| sessions:", restoredItems);

	console.log("console errors:", JSON.stringify(consoleErrors));
	console.log("page errors:", JSON.stringify(pageErrors));

	const ok = sessionItems >= 1 && loginShown === 0 && restoredItems >= 1 && pageErrors.length === 0;
	console.log(ok ? "UI-E2E OK" : "UI-E2E FAILED");
	await browser.close();
	process.exit(ok ? 0 : 1);
} catch (error) {
	console.error("UI-E2E FAILED:", error);
	await browser.close();
	process.exit(1);
}