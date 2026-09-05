/**
 * Settings modal: this account's provider catalog (OpenAI-compatible endpoints)
 * and per-model metadata. Model *selection* lives in the chat header, so this
 * screen only owns provider configuration.
 */

import type { ProviderConfig, ProviderDetail, ProviderModelConfig, ProviderSummary } from "../../shared/protocol.ts";
import type { WebuiClient } from "../api.ts";

const CLOSE_ICON = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>`;

const DEFAULT_CONTEXT_WINDOW = "32768";
const DEFAULT_MAX_TOKENS = "4096";

type ProviderChangedHandler = () => void;
const providerChangedHandlers = new Set<ProviderChangedHandler>();

/** Subscribe to provider catalog changes so model pickers can refresh. */
export function onProvidersChanged(handler: ProviderChangedHandler): () => void {
	providerChangedHandlers.add(handler);
	return () => {
		providerChangedHandlers.delete(handler);
	};
}

function notifyProvidersChanged(): void {
	for (const handler of [...providerChangedHandlers]) handler();
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

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function field(label: string, input: HTMLInputElement): HTMLElement {
	const wrap = el("label", "field settings-field");
	wrap.append(el("span", "field-label", label), input);
	return wrap;
}

function textInput(type: "text" | "password", placeholder: string, value = ""): HTMLInputElement {
	const input = document.createElement("input");
	input.type = type;
	input.placeholder = placeholder;
	input.value = value;
	return input;
}

function numberInput(value: string): HTMLInputElement {
	const input = textInput("text", "");
	input.type = "number";
	input.min = "1";
	input.value = value;
	return input;
}

function checkboxInput(checked: boolean): HTMLInputElement {
	const input = document.createElement("input");
	input.type = "checkbox";
	input.checked = checked;
	return input;
}

function checkbox(label: string, checked: boolean): { readonly box: HTMLInputElement; readonly node: HTMLElement } {
	const box = checkboxInput(checked);
	const wrap = el("label");
	wrap.append(box, el("span", undefined, label));
	return { box, node: wrap };
}

function optionalNumber(value: string): number | undefined {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined;
}

interface ModelRowData {
	readonly id: HTMLInputElement;
	readonly contextWindow: HTMLInputElement;
	readonly maxTokens: HTMLInputElement;
	readonly image: HTMLInputElement;
	readonly reasoning: HTMLInputElement;
}

function makeModelRow(model: ProviderModelConfig | undefined): {
	readonly node: HTMLElement;
	readonly data: ModelRowData;
} {
	const row = el("div", "settings-model-row");
	const id = textInput("text", "model-id");
	const contextWindow = numberInput(
		model?.contextWindow !== undefined ? String(model.contextWindow) : DEFAULT_CONTEXT_WINDOW,
	);
	const maxTokens = numberInput(model?.maxTokens !== undefined ? String(model.maxTokens) : DEFAULT_MAX_TOKENS);
	const image = checkbox("image", model?.image === true);
	const reasoning = checkbox("reasoning", model?.reasoning === true);
	const remove = document.createElement("button");
	remove.className = "icon-btn";
	remove.type = "button";
	remove.setAttribute("aria-label", "Remove model");
	remove.innerHTML = CLOSE_ICON;
	remove.addEventListener("click", () => row.remove());
	row.append(id, contextWindow, maxTokens, image.node, reasoning.node, remove);
	return { node: row, data: { id, contextWindow, maxTokens, image: image.box, reasoning: reasoning.box } };
}

function readModels(rows: readonly ModelRowData[]): ProviderModelConfig[] {
	const models: ProviderModelConfig[] = [];
	for (const row of rows) {
		const id = row.id.value.trim();
		if (id.length === 0) continue;
		const contextWindow = optionalNumber(row.contextWindow.value);
		const maxTokens = optionalNumber(row.maxTokens.value);
		models.push({
			id,
			image: row.image.checked,
			reasoning: row.reasoning.checked,
			...(contextWindow === undefined ? {} : { contextWindow }),
			...(maxTokens === undefined ? {} : { maxTokens }),
		});
	}
	return models;
}

/** Open the settings modal. Returns a close function. */
export function openSettings(client: WebuiClient): () => void {
	const backdrop = el("div", "settings-backdrop");
	const modal = el("div", "settings-modal");
	backdrop.append(modal);
	document.body.append(backdrop);

	let closed = false;
	const close = (): void => {
		if (closed) return;
		closed = true;
		backdrop.remove();
		document.removeEventListener("keydown", onEscape);
	};
	const onEscape = (event: KeyboardEvent): void => {
		if (event.key === "Escape") close();
	};
	backdrop.addEventListener("click", (event) => {
		if (event.target === backdrop) close();
	});
	document.addEventListener("keydown", onEscape);

	const head = el("div", "settings-head");
	head.append(el("h2", "settings-title", "Settings"));
	const closeButton = document.createElement("button");
	closeButton.className = "icon-btn";
	closeButton.type = "button";
	closeButton.setAttribute("aria-label", "Close settings");
	closeButton.innerHTML = CLOSE_ICON;
	closeButton.addEventListener("click", close);
	head.append(closeButton);
	modal.append(head);

	const body = el("div");
	modal.append(body);

	const note = el("p", "settings-note");
	const error = el("p", "settings-error");
	body.append(note, error);

	void renderList();
	return close;

	async function renderList(): Promise<void> {
		note.textContent = "";
		error.textContent = "";
		for (const child of [...body.children]) {
			if (child !== note && child !== error) body.removeChild(child);
		}

		const section = el("div", "settings-section");
		const sectionHead = el("div", "settings-section-head");
		sectionHead.append(el("div", "settings-section-title", "Providers"));
		const addButton = el("button", "secondary", "Add provider");
		addButton.type = "button";
		addButton.addEventListener("click", () => void renderEditor(null));
		sectionHead.append(addButton);
		section.append(sectionHead);
		section.append(
			el(
				"p",
				"settings-hint",
				"OpenAI-compatible endpoints, stored on the server for this account. Builtin providers come from server credentials and cannot be edited here.",
			),
		);
		const list = el("div", "settings-provider-list");
		section.append(list);
		body.append(section);

		try {
			const providers = await client.listProviders();
			if (providers.length === 0) {
				list.append(el("div", "settings-empty", "No providers yet. Add one to create a chat."));
				return;
			}
			for (const provider of providers) {
				list.append(providerRow(provider));
			}
		} catch (err) {
			error.textContent = message(err);
		}
	}

	function providerRow(provider: ProviderSummary): HTMLElement {
		const row = el("div", "settings-provider-row");
		const info = el("div", "settings-provider-info");
		info.append(el("span", "settings-provider-name", provider.name));
		info.append(
			el(
				"span",
				"settings-provider-meta",
				`${provider.baseUrl} · ${provider.modelCount} ${provider.modelCount === 1 ? "model" : "models"}`,
			),
		);
		const actions = el("div", "settings-provider-actions");
		if (provider.custom) {
			const testButton = el("button", "chip", "Test");
			testButton.type = "button";
			testButton.addEventListener("click", () => void test(provider.id, testButton));
			const editButton = el("button", "chip", "Edit");
			editButton.type = "button";
			editButton.addEventListener("click", () => void renderEditor(provider));
			const deleteButton = el("button", "chip", "Delete");
			deleteButton.type = "button";
			deleteButton.addEventListener("click", () => void remove(provider.id));
			actions.append(testButton, editButton, deleteButton);
		} else {
			actions.append(el("span", "settings-provider-meta", "builtin"));
		}
		row.append(info, actions);
		return row;
	}

	async function test(id: string, button: HTMLButtonElement): Promise<void> {
		button.disabled = true;
		note.textContent = "Testing…";
		error.textContent = "";
		try {
			const result = await client.testProvider(id);
			if (result.ok) {
				note.textContent = result.modelIds.length > 0 ? result.modelIds.join(", ") : "reachable, no model list";
			} else {
				note.textContent = "";
				error.textContent = result.error ?? "unreachable";
			}
		} catch (err) {
			note.textContent = "";
			error.textContent = message(err);
		} finally {
			button.disabled = false;
		}
	}

	async function remove(id: string): Promise<void> {
		if (
			!confirm(
				"Delete this provider? Existing sessions keep their history, but new prompts using its models will fail.",
			)
		) {
			return;
		}
		error.textContent = "";
		try {
			await client.deleteProvider(id);
			notifyProvidersChanged();
			await renderList();
		} catch (err) {
			error.textContent = message(err);
		}
	}

	async function renderEditor(existing: ProviderSummary | null): Promise<void> {
		note.textContent = "";
		error.textContent = "";
		for (const child of [...body.children]) {
			if (child !== note && child !== error) body.removeChild(child);
		}

		let detail: ProviderDetail | null = null;
		if (existing !== null) {
			try {
				detail = (await client.provider(existing.id)) ?? null;
			} catch (err) {
				error.textContent = message(err);
				void renderList();
				return;
			}
			if (detail === null) {
				void renderList();
				return;
			}
		}

		const section = el("div", "settings-section");
		section.append(el("h2", "settings-section-title", detail === null ? "Add provider" : `Edit ${detail.name}`));

		const name = textInput("text", "My provider", detail?.name ?? "");
		const baseUrl = textInput("text", "https://api.example.com/v1", detail?.baseUrl ?? "");
		const apiKey = textInput("password", "sk-…", detail?.apiKey ?? "");
		section.append(field("Name", name), field("Base URL", baseUrl), field("API key", apiKey));
		section.append(
			el(
				"p",
				"settings-hint",
				"Base URL is the OpenAI-compatible root (ending in /v1 on most servers). Keyless local endpoints use a placeholder key such as ollama.",
			),
		);

		const header = el("div", "settings-model-row");
		header.append(
			el("span", "settings-model-label", "Model id"),
			el("span", "settings-model-label", "Context"),
			el("span", "settings-model-label", "Max out"),
			el("span", "settings-model-label", "Image"),
			el("span", "settings-model-label", "Reasoning"),
			el("span"),
		);
		const modelRows = el("div");
		const rows: ModelRowData[] = [];
		const addModelRow = (model: ProviderModelConfig | undefined): void => {
			const built = makeModelRow(model);
			rows.push(built.data);
			modelRows.append(built.node);
		};
		section.append(header, modelRows);
		const addModelButton = el("button", "chip", "Add model");
		addModelButton.type = "button";
		addModelButton.addEventListener("click", () => addModelRow(undefined));
		const fetchButton = el("button", "chip", "Fetch models");
		fetchButton.type = "button";
		fetchButton.addEventListener("click", () => void fetchModels(fetchButton));
		const editorActions = el("div", "settings-editor-actions");
		editorActions.append(addModelButton, fetchButton);
		section.append(editorActions);

		for (const model of detail?.models ?? []) addModelRow(model);
		if (rows.length === 0) addModelRow(undefined);

		const saveButton = el("button", "primary", detail === null ? "Save" : "Save changes");
		saveButton.type = "button";
		const cancelButton = el("button", "secondary", "Cancel");
		cancelButton.type = "button";
		cancelButton.addEventListener("click", () => void renderList());
		saveButton.addEventListener("click", () => void save());
		const buttons = el("div", "settings-buttons");
		buttons.append(saveButton, cancelButton);
		section.append(buttons);
		body.append(section);

		async function save(): Promise<void> {
			const models = readModels(rows);
			if (models.length === 0) {
				error.textContent = "Add at least one model.";
				return;
			}
			if (new Set(models.map((model) => model.id)).size !== models.length) {
				error.textContent = "Model ids must be unique.";
				return;
			}
			saveButton.disabled = true;
			error.textContent = "";
			const config: ProviderConfig = {
				...(detail === null ? {} : { id: detail.id }),
				name: name.value.trim(),
				baseUrl: baseUrl.value.trim().replace(/\/+$/, ""),
				apiKey: apiKey.value.trim(),
				models,
			};
			try {
				await client.saveProvider(config);
				notifyProvidersChanged();
				await renderList();
			} catch (err) {
				error.textContent = message(err);
				saveButton.disabled = false;
			}
		}

		/** Pull the endpoint's /models list into the model rows before saving. */
		async function fetchModels(button: HTMLButtonElement): Promise<void> {
			if (baseUrl.value.trim().length === 0) {
				error.textContent = "Enter a base URL first.";
				return;
			}
			button.disabled = true;
			button.textContent = "Fetching…";
			note.textContent = "";
			error.textContent = "";
			const config: ProviderConfig = {
				...(detail === null ? {} : { id: detail.id }),
				name: name.value.trim(),
				baseUrl: baseUrl.value.trim(),
				apiKey: apiKey.value.trim(),
				models: readModels(rows),
			};
			try {
				const result = await client.discoverModels(config);
				if (!result.ok) {
					error.textContent = result.error ?? "unreachable";
					return;
				}
				const listed = new Set(rows.map((row) => row.id.value.trim()).filter((id) => id.length > 0));
				let added = 0;
				for (const id of result.modelIds) {
					if (id.length === 0 || listed.has(id)) continue;
					listed.add(id);
					addModelRow({ id });
					added += 1;
				}
				if (added > 0) {
					note.textContent = `Fetched ${result.modelIds.length} models, added ${added}.`;
				} else if (result.modelIds.length > 0) {
					note.textContent = "All fetched models are already listed.";
				} else {
					note.textContent = "Endpoint reachable, but it returned no models.";
				}
			} catch (err) {
				error.textContent = message(err);
			} finally {
				button.textContent = "Fetch models";
				button.disabled = false;
			}
		}
	}
}
