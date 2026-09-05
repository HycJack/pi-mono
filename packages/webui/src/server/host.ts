import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	type Context,
	createRemoteServiceEndpoint,
	type JsonValue,
	RemoteServiceProvider,
	replicatedState,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	AgentHarness,
	type AgentHarnessTool,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	formatSkillsForSystemPrompt,
	type HarnessEvent,
	type JsonlSessionMetadata,
	JsonlSessionRepo,
	type LaneSnapshot,
	type LaneTranscriptSnapshot,
	loadSkills,
	reduceLaneSnapshot,
	type Session,
	type Skill,
	type WatchHandle,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Api, ImageContent, Model, Models } from "@earendil-works/pi-ai";
import {
	type RoutedServerServiceAttachment,
	type RoutedServerServiceHost,
	type RoutedSessionAttachment,
	type RoutedSessionHandle,
	ServerError,
	type ServerHost,
} from "@earendil-works/pi-server";
import {
	AgentController,
	type AgentOperationResponse,
	ProviderSettings,
	SessionDirectory,
	SessionManagement,
	Transcript,
} from "../shared/protocol.ts";
import { createProviderRegistry, FileProviderStore } from "./providers.ts";

/**
 * Per-user agent host. One host serves exactly one authenticated user: it owns
 * that user's durable session repository and answers server-scoped services
 * (SessionDirectory/SessionManagement). Each opened session runs an in-process
 * AgentHarness with a "main" lane plus lazily created sub-agent lanes.
 *
 * This is the webui in-process analogue of the coding-agent experimental
 * `SessionWorkerManager`: sessions are created/attached through the same
 * pi-server routing, but the worker is this process instead of a child.
 */

export interface WebuiHostOptions {
	readonly sessionsRoot: string;
	readonly username: string;
	/**
	 * This user's provider config file (default `<sessionsRoot>/<username>/providers.json`).
	 * Configured providers are layered onto `models` and selectable per session.
	 */
	readonly providersPath?: string;
	/** Baseline catalog (builtin providers) whose providers are copied into this user's catalog. */
	readonly models?: Models;
	/** Explicit session default model; wins over catalog selection. */
	readonly model?: Model<Api>;
	readonly systemPrompt?: string;
	/** Extra tool extensions beyond the built-in read/write/edit/bash tools. */
	readonly tools?: readonly AgentHarnessTool<{ env: NodeExecutionEnv }>[];
	/** Skill extensions to advertise in the system prompt (model loads their files on demand). */
	readonly skills?: readonly Skill[];
	/** Directory to load SKILL.md skill extensions from (in addition to `skills`). */
	readonly skillsDir?: string;
}

export interface WebuiHost {
	readonly host: ServerHost<JsonlSessionMetadata>;
	readonly serverId: string;
	close(): Promise<void>;
}

interface SessionRuntime {
	readonly metadata: JsonlSessionMetadata;
	readonly session: Session<JsonlSessionMetadata>;
	readonly harness: Awaited<ReturnType<typeof AgentHarness.create>>["harness"];
	readonly open: Awaited<ReturnType<typeof AgentHarness.create>>["open"];
	readonly provider: RemoteServiceProvider;
	readonly sessionDir: string;
	close(context: Context): Promise<void>;
}

function defaultSystemPrompt(cwd: string): string {
	return [
		"You are a helpful agent running in a multi-user web session.",
		`Working directory: ${cwd}`,
		"Use the read, write, edit, and bash tools to inspect and change files.",
		"Keep answers short and technical.",
	].join("\n");
}

function toOperationResponse(
	value: { operationId: string } | { _tag: string; message: string },
): AgentOperationResponse {
	if ("operationId" in value) return { accepted: true, operationId: value.operationId };
	return { accepted: false, operationId: null, error: value.message };
}

export async function createWebuiHost(options: WebuiHostOptions): Promise<WebuiHost> {
	const serverId = randomUUID();
	const userRoot = join(options.sessionsRoot, options.username);
	const executionEnv = new NodeExecutionEnv({ cwd: userRoot });
	const repo = new JsonlSessionRepo({ fileSystem: executionEnv, sessionsRoot: userRoot });
	const sessions = new Map<string, SessionRuntime>();
	let closed = false;

	// Per-user provider catalog: configured OpenAI-compatible endpoints layered
	// onto the builtin catalog. Each user owns their own Models instance, so one
	// user's provider and API key are never visible to another user.
	const registry = await createProviderRegistry({
		store: new FileProviderStore({ path: options.providersPath ?? join(userRoot, "providers.json") }),
		baseline: options.models,
	});
	const models = registry.models;

	/** Seed model for new lanes; fails fast with an actionable error. */
	const resolveDefaultModel = async (): Promise<Model<Api>> => {
		const model = options.model ?? (await registry.defaultModel());
		if (model === undefined) {
			throw new ServerError("service_invalid_value", "No model available. Add a provider in Settings.");
		}
		return model;
	};

	// Skill + tool extensions. Skills advertise in the system prompt and the
	// model loads their files on demand with the read tool.
	const loadedSkills: Skill[] = [...(options.skills ?? [])];
	if (options.skillsDir !== undefined) {
		const { skills } = await loadSkills(executionEnv, options.skillsDir, BACKGROUND_CONTEXT);
		loadedSkills.push(...skills);
	}
	const skillsBlock = formatSkillsForSystemPrompt(loadedSkills);
	const baseTools = [createReadTool(), createWriteTool(), createEditTool(), createBashTool()];
	const tools = [...baseTools, ...(options.tools ?? [])];
	const systemPrompt = (): string => {
		const base = options.systemPrompt ?? defaultSystemPrompt(userRoot);
		return skillsBlock.length === 0 ? base : `${base}\n\n${skillsBlock}`;
	};

	const resolveSession = async (sessionId: string, context: Context): Promise<JsonlSessionMetadata> => {
		const matches = (await repo.list(undefined, context)).filter((m) => m.id === sessionId);
		if (matches.length === 0) throw new ServerError("session_not_found", `Unknown session: ${sessionId}`);
		if (matches.length > 1) throw new ServerError("session_ambiguous", `Ambiguous session: ${sessionId}`);
		return matches[0]!;
	};

	// --- Server-scoped services: SessionDirectory + SessionManagement -----------------

	const directory = replicatedState<{ revision: number; sessions: { sessionId: string; createdAt: number }[] }>({
		revision: 0,
		sessions: [],
	});
	const publishDirectory = async (context: Context): Promise<void> => {
		const listed = (await repo.list(undefined, context)).sort((a, b) => a.createdAt - b.createdAt);
		directory.state.revision += 1;
		directory.state.sessions = listed.map((metadata) => ({
			sessionId: metadata.id,
			createdAt: metadata.createdAt,
		}));
		directory.publish(context);
	};

	// --- Session-scoped services -----------------------------------------------------

	async function openSession(
		metadata: JsonlSessionMetadata,
		model: Model<Api>,
		context: Context,
	): Promise<SessionRuntime> {
		const existing = sessions.get(metadata.id);
		if (existing !== undefined) return existing;

		const session = await repo.open(metadata, context);
		const { harness, open } = await AgentHarness.create(
			{
				session,
				models,
				model,
				tools,
				toolContext: { env: executionEnv },
				systemPrompt: systemPrompt(),
			},
			context,
		);
		const mainLane = await harness.lane("main", context);
		// A session restored with a model that is no longer in the catalog would
		// fail every prompt; fall back to the seed model so it stays usable.
		if ((await mainLane.getModel(context)) === undefined) {
			await mainLane.setModel({ provider: model.provider, modelId: model.id }, context);
		}

		const snapshotState = replicatedState<{
			lane: string;
			sessionId: string;
			snapshot: JsonValue;
			event: unknown | null;
		}>({
			lane: "main",
			sessionId: metadata.id,
			snapshot: null,
			event: null,
		});
		let watch: WatchHandle<LaneSnapshot> | undefined;
		let rebase: Promise<void> | undefined;

		const publishSnapshot = (next: LaneSnapshot, event: HarnessEvent | null, ctx: Context): void => {
			snapshotState.state.lane = "main";
			snapshotState.state.sessionId = metadata.id;
			// The in-process bridge has no wire to strip non-JSON values (the
			// experimental worker gets this for free by crossing a JSON stdio
			// pipe). Round-trip through JSON so the protocol encoder accepts
			// the snapshot, discarding undefined/functions in streaming state.
			snapshotState.state.snapshot = toJson(next);
			snapshotState.state.event = event === null ? null : toJson(event);
			snapshotState.publish(ctx);
		};
		const scheduleRebase = (ctx: Context): void => {
			if (rebase !== undefined) return;
			const activeWatch = watch;
			if (activeWatch === undefined) return;
			const pending = activeWatch.resnapshot(ctx).then((refreshed) => {
				publishSnapshot(refreshed, null, ctx);
			});
			rebase = pending;
			void pending.then(
				() => {
					if (rebase === pending) rebase = undefined;
				},
				() => {
					if (rebase === pending) rebase = undefined;
				},
			);
		};
		const onEvent = (event: HarnessEvent, ctx: Context): void => {
			const snapshot = snapshotState.state.snapshot;
			if (snapshot === null) return;
			if (process.env.WEBUI_TRACE_EVENTS === "1") {
				console.error(`[webui trace] ${event.type} op=${(event as { runId?: string }).runId ?? "-"}`);
			}
			// Apply the event to the mutable snapshot in place; the harness
			// watch handle's own snapshot only updates on explicit resnapshot,
			// so the reducer is what keeps the published copy live.
			if (reduceLaneSnapshot(snapshot as LaneTranscriptSnapshot as LaneSnapshot, event) === "rebase") {
				scheduleRebase(ctx);
			} else {
				publishSnapshot(snapshot as LaneTranscriptSnapshot as LaneSnapshot, event, ctx);
			}
		};

		const provider = new RemoteServiceProvider([
			{ service: AgentController, mode: "singleton" },
			{ service: Transcript, mode: "singleton" },
		]);
		provider.provide(AgentController, {
			async prompt(request, callContext) {
				const context = callContext as Context;
				const images = toImageContent(request.images);
				if (images !== undefined) {
					const current = await mainLane.getModel(context);
					if (current === undefined || !current.input.includes("image")) {
						return {
							accepted: false,
							operationId: null,
							error: "The session model does not support image input",
						};
					}
				}
				const result = await mainLane.prompt(request.message, images, context);
				return result.ok ? toOperationResponse(result.value) : toOperationResponse(result.error);
			},
			async requestAbort(operationId, callContext) {
				const result = await mainLane.requestAbort(operationId, callContext as Context);
				if (!result.ok) throw new Error(result.error.message);
			},
			async resume(callContext) {
				const result = await mainLane.resume(callContext as Context);
				return result.ok ? toOperationResponse(result.value) : toOperationResponse(result.error);
			},
			async capabilities(_callContext) {
				const current = await mainLane.getModel(_callContext as Context);
				return { image: current?.input.includes("image") ?? false };
			},
			async acquireSubLane(name, callContext) {
				await harness.lane(name, callContext as Context);
				return { lane: name };
			},
			async listLanes(callContext) {
				const infos = await harness.lanes(callContext as Context);
				return infos.map((info) => info.name);
			},
			async setModel(model, callContext) {
				const identity = { provider: model.provider, modelId: model.modelId };
				if (models.getModel(identity.provider, identity.modelId) === undefined) {
					throw new ServerError(
						"service_invalid_value",
						`Unknown model: ${identity.provider}/${identity.modelId}`,
					);
				}
				await mainLane.setModel(identity, callContext as Context);
			},
		});
		provider.provide(Transcript, { state: snapshotState as never });

		const runtime: SessionRuntime = {
			metadata,
			session,
			harness,
			open,
			provider,
			sessionDir: userRoot,
			async close(closeContext) {
				watch?.unsubscribe();
				watch = undefined;
				await harness.close(closeContext).catch(() => {});
				await session.close(closeContext).catch(() => {});
				sessions.delete(metadata.id);
			},
		};

		watch = await mainLane.watch(context);
		publishSnapshot(watch.snapshot, null, context);
		watch.start((event) => onEvent(event, BACKGROUND_CONTEXT));

		sessions.set(metadata.id, runtime);

		// Recover durable operations left open by a previous process lifetime.
		for (const operation of open) {
			void harness
				.lane(operation.lane, context)
				.then((lane) => lane.resume(context))
				.catch((error: unknown) => {
					console.error(`Failed to resume ${operation.lane}/${operation.operationId}:`, error);
				});
		}
		return runtime;
	}

	// --- ServerHost wiring -----------------------------------------------------------

	// Provider settings are UI input: a rejected config or unreachable endpoint
	// is user-facing, so report the real message instead of "Internal server
	// error".
	const asInvalidValue = async <T>(operation: () => Promise<T>): Promise<T> => {
		try {
			return await operation();
		} catch (error) {
			throw new ServerError("service_invalid_value", error instanceof Error ? error.message : String(error));
		}
	};

	const serverServices: RoutedServerServiceHost = {
		attachClient(presentation) {
			return (async () => {
				const provider = new RemoteServiceProvider([
					{ service: SessionDirectory, mode: "singleton" },
					{ service: SessionManagement, mode: "singleton" },
					{ service: ProviderSettings, mode: "singleton" },
				]);
				provider.provide(SessionDirectory, { state: directory });
				provider.provide(ProviderSettings, {
					listProviders: () => registry.listProviders(),
					getProvider: async (id) => registry.getProvider(id) ?? null,
					listModels: async () => registry.listModels(),
					upsertProvider: (config) => asInvalidValue(() => registry.save(config)),
					deleteProvider: (id) => asInvalidValue(() => registry.delete(id)),
					testProvider: (id) => asInvalidValue(() => registry.test(id)),
					discoverModels: (config) => asInvalidValue(() => registry.probe(config)),
				});
				provider.provide(SessionManagement, {
					async create(options, context) {
						// Resolve the seed model before writing anything, so a user
						// with no configured provider gets an error and no empty session.
						const model = await resolveDefaultModel();
						const created = await repo.create({ cwd: userRoot, id: options.id }, context);
						const metadata = created.metadata;
						await created.close(context);
						// Keep the session resident so its harness is ready for attach.
						await openSession(metadata, model, context);
						await publishDirectory(context);
						return { sessionId: metadata.id, createdAt: metadata.createdAt };
					},
					async remove(sessionId, context) {
						const metadata = await resolveSession(sessionId, context);
						await presentation.prepareSessionRemoval(sessionId, context);
						const runtime = sessions.get(sessionId);
						if (runtime !== undefined) await runtime.close(context);
						await repo.delete(metadata, context);
						await publishDirectory(context);
					},
					async attach(sessionId, context) {
						// Route through the server session router: it resolves metadata,
						// opens the session handle, and installs the session attachment.
						await presentation.attachSession(sessionId, context);
					},
					async detach(context) {
						await presentation.detachSession(context);
					},
				});
				// Refresh the directory before serving so the first subscription
				// snapshot already reflects the persisted sessions.
				await publishDirectory(BACKGROUND_CONTEXT);
				const endpoint = createRemoteServiceEndpoint(provider);
				const attachment: RoutedServerServiceAttachment = {
					invokeService: (call, publish, context) => endpoint.invoke(call, publish, context),
					release: async () => {
						endpoint.dispose();
					},
				};
				return attachment;
			})();
		},
	};

	const host: ServerHost<JsonlSessionMetadata> = {
		serverServices,
		resolveSession,
		openSession: async (metadata, context) => {
			const model = await resolveDefaultModel();
			const runtime = await openSession(metadata, model, context);
			return {
				attachClient: () => {
					const endpoint = createRemoteServiceEndpoint(runtime.provider);
					return {
						invokeService: (call, publish, serviceContext) => endpoint.invoke(call, publish, serviceContext),
						release: async () => {
							endpoint.dispose();
						},
					} satisfies RoutedSessionAttachment;
				},
				close: (closeContext) => runtime.close(closeContext),
			} satisfies RoutedSessionHandle;
		},
	};

	return {
		host,
		serverId,
		async close() {
			if (closed) return;
			closed = true;
			const context = BACKGROUND_CONTEXT;
			for (const runtime of [...sessions.values()]) {
				await runtime.close(context);
			}
			await repo.close(context).catch(() => {});
			await executionEnv.cleanup(context).catch(() => {});
		},
	};
}

/** JSON round-trip: drop undefined/function values that the protocol encoder rejects. */
function toJson(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/** Convert protocol image attachments to pi-ai ImageContent blocks. */
function toImageContent(
	images: readonly { readonly type: "image"; readonly data: string; readonly mimeType: string }[] | null | undefined,
): ImageContent[] | undefined {
	if (images === undefined || images === null || images.length === 0) return undefined;
	return images.map(({ data, mimeType }) => ({ type: "image", data, mimeType }));
}
