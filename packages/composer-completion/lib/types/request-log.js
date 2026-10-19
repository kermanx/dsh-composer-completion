/** Self-contained JSON requests with a persistent, byte-bounded session LRU. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';
import { completionStoragePath } from "./storage.js";
export { buildCompletionPromptFromTranscript, completionTranscriptFromMessages } from "./prompt.js";
/** Hard ceiling for all JSON files, including session metadata (50 MiB). */
export const REQUEST_LOG_MAX_BYTES = 50 * 1024 * 1024;
const ID = /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const PAYLOAD = /^(\d{13}-[0-9a-f-]{36})\.(request|result)\.json$/u;
const TEMPORARY = /^\.\d{13}-[0-9a-f-]+\.tmp$/u;
const SESSION = /^session-[0-9a-f]{64}$/u;
const EVICTED = /^\.evicted-session-[0-9a-f]{64}-[0-9a-f-]{36}$/u;
function jsonBytes(value) {
    return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}
function sessionKey(sessionId) {
    return `session-${createHash('sha256').update(sessionId).digest('hex')}`;
}
/** DSH usage events replace the previous snapshot; they are not token deltas. */
export function completionTokenUsage(result) {
    if (result === undefined)
        return null;
    const last = result.chunks.findLast(value => value.chunk.type === 'usage');
    const usage = last?.chunk.type === 'usage' ? last.chunk.usage : result.usage;
    return usage == null ? null : structuredClone(usage);
}
function emptyTokenTotals() {
    return {
        requests: 0, requestsWithoutUsage: 0, requestsWithoutTotalTokens: 0,
        uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        reasoningTokens: 0, countedTokens: 0, knownTotalTokens: 0, totalTokens: 0,
    };
}
function tokenCount(value) {
    return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function addTokenUsage(totals, usage) {
    totals.requests += 1;
    const input = tokenCount(usage?.inputTokens);
    const output = tokenCount(usage?.outputTokens);
    if (input === undefined || output === undefined)
        totals.requestsWithoutUsage += 1;
    const cacheRead = tokenCount(usage?.cacheReadTokens) ?? 0;
    const cacheWrite = tokenCount(usage?.cacheWriteTokens) ?? 0;
    totals.uncachedInputTokens += input ?? 0;
    totals.outputTokens += output ?? 0;
    totals.cacheReadTokens += cacheRead;
    totals.cacheWriteTokens += cacheWrite;
    totals.reasoningTokens += tokenCount(usage?.reasoningTokens) ?? 0;
    totals.countedTokens += (input ?? 0) + (output ?? 0) + cacheRead + cacheWrite;
    const total = tokenCount(usage?.totalTokens);
    if (total === undefined)
        totals.requestsWithoutTotalTokens += 1;
    else
        totals.knownTotalTokens += total;
    totals.totalTokens = totals.requestsWithoutTotalTokens === 0 ? totals.knownTotalTokens : null;
}
/** A session must fit as a whole: its individual requests are never pruned. */
export class RequestLogCapacityError extends Error {
    constructor() {
        super('composer-completion: request log session exceeds its byte budget');
        this.name = 'RequestLogCapacityError';
    }
}
/** Capture ordinary and remote failures for later experiment inspection. */
export function loggedError(error) {
    if (!(error instanceof Error))
        return { name: 'Error', message: String(error) };
    const code = Reflect.get(error, 'code');
    return {
        name: error.name,
        message: error.message,
        ...(error.stack === undefined ? {} : { stack: error.stack }),
        ...(typeof code === 'string' ? { code } : {}),
    };
}
/**
 * Plain JSON request/result pairs grouped by session, coordinated by a directory lock.
 * session.json mtime is the durable access clock for every request in that session.
 */
export class CompletionRequestLog {
    directory;
    maxBytes;
    constructor(options = {}) {
        this.directory = options.directory ?? completionStoragePath('requests');
        this.maxBytes = options.maxBytes ?? REQUEST_LOG_MAX_BYTES;
        if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0 || this.maxBytes > REQUEST_LOG_MAX_BYTES) {
            throw new RangeError(`request log maxBytes must be between 1 and ${REQUEST_LOG_MAX_BYTES}`);
        }
    }
    /** Persist the full request before its model stream is opened. */
    async begin(snapshot) {
        const createdAt = Date.now();
        const id = `${createdAt}-${randomUUID()}`;
        const sessionId = snapshot.input.sessionId;
        const key = sessionKey(sessionId);
        // Serialize before yielding, so callers cannot mutate the admitted snapshot.
        const data = jsonBytes({ ...snapshot, version: 1, id, createdAt });
        const metadata = jsonBytes({ version: 1, sessionId });
        await this.locked(async (sessions) => {
            const session = sessions.find(value => value.sessionId === sessionId);
            const additional = data.length + (session === undefined ? metadata.length : 0);
            await this.checkSessionCapacity(session, additional);
            await this.makeRoom(sessions, additional, sessionId);
            await mkdir(join(this.directory, key), { recursive: true, mode: 0o700 });
            if (session === undefined)
                await this.write(this.metadataPath(key), metadata, id);
            await this.write(this.path(key, id, 'request'), data, id);
            await this.touch(key, sessions);
        });
        return id;
    }
    /** Attach one settlement; an evicted in-flight request is never resurrected. */
    async finish(id, result) {
        this.validateId(id);
        const data = jsonBytes({ version: 1, id, result: { ...result, usage: completionTokenUsage(result) } });
        return this.locked(async (sessions) => {
            const session = sessions.find(value => value.entries.some(entry => entry.id === id));
            const entry = session?.entries.find(value => value.id === id);
            if (session === undefined || entry === undefined)
                return false;
            if (entry.hasResult)
                throw new Error(`request log ${id} already has a result`);
            await this.checkSessionCapacity(session, data.length);
            await this.makeRoom(sessions, data.length, session.sessionId);
            await this.write(this.path(session.key, id, 'result'), data, id);
            await this.touch(session.key, sessions);
            return true;
        });
    }
    /** Read a self-contained request and refresh the entire session's LRU position. */
    async read(id) {
        this.validateId(id);
        return this.locked(async (sessions) => {
            const session = sessions.find(value => value.entries.some(entry => entry.id === id));
            const entry = session?.entries.find(value => value.id === id);
            if (session === undefined || entry === undefined) {
                throw new Error(`request log ${id} was not found (possibly evicted)`);
            }
            const record = JSON.parse(await readFile(this.path(session.key, id, 'request'), 'utf8'));
            if (record.version !== 1 || record.id !== id || record.input.sessionId !== session.sessionId) {
                throw new Error(`unsupported request log ${id}`);
            }
            let result;
            if (entry.hasResult) {
                result = await this.readResult(session.key, id);
            }
            await this.touch(session.key, sessions);
            return { ...record, ...(result === undefined ? {} : { result }) };
        });
    }
    /** Inspect newest requests first without refreshing any session's access time. */
    async list() {
        const sessions = await this.listSessions();
        return sessions.flatMap(session => session.entries)
            .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    }
    /** Inspect sessions and their complete byte cost, most recently accessed first. */
    async listSessions() {
        return this.locked(async (sessions) => {
            const retained = await this.makeRoom(sessions, 0);
            return retained.sort((a, b) => b.accessedAt - a.accessedAt || a.sessionId.localeCompare(b.sessionId))
                .map(session => ({
                sessionId: session.sessionId, accessedAt: session.accessedAt,
                bytes: session.bytes, entries: session.entries,
            }));
        });
    }
    /** Aggregate saved usage without refreshing session recency or making model calls. */
    async usage() {
        return this.locked(async (sessions) => {
            const total = emptyTokenTotals();
            const summaries = [];
            for (const session of sessions) {
                const summary = { sessionId: session.sessionId, ...emptyTokenTotals() };
                for (const entry of session.entries) {
                    const result = entry.hasResult ? await this.readResult(session.key, entry.id) : undefined;
                    const usage = completionTokenUsage(result);
                    addTokenUsage(summary, usage);
                    addTokenUsage(total, usage);
                }
                summaries.push(summary);
            }
            return { scope: 'retained-logs', total, sessions: summaries.sort((a, b) => a.sessionId.localeCompare(b.sessionId)) };
        });
    }
    async readResult(key, id) {
        const envelope = JSON.parse(await readFile(this.path(key, id, 'result'), 'utf8'));
        if (envelope.version !== 1 || envelope.id !== id)
            throw new Error(`unsupported request log result ${id}`);
        return envelope.result;
    }
    metadataPath(key) {
        return join(this.directory, key, 'session.json');
    }
    path(key, id, kind) {
        return join(this.directory, key, `${id}.${kind}.json`);
    }
    validateId(id) {
        if (!ID.test(id))
            throw new Error('invalid completion request log id');
    }
    async locked(operation) {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const release = await lockfile.lock(this.directory, {
            retries: { retries: 20, minTimeout: 20, maxTimeout: 250 },
        });
        try {
            return await operation(await this.scan());
        }
        finally {
            await release();
        }
    }
    async scan() {
        const sessions = [];
        for (const directory of await readdir(this.directory, { withFileTypes: true })) {
            if (!directory.isDirectory())
                continue;
            const path = join(this.directory, directory.name);
            // Finish deletions interrupted after the whole session was atomically evicted.
            if (EVICTED.test(directory.name)) {
                await rm(path, { recursive: true, force: true });
            }
            else if (SESSION.test(directory.name)) {
                const session = await this.scanSession(directory.name);
                if (session !== undefined)
                    sessions.push(session);
            }
        }
        return sessions;
    }
    async scanSession(key) {
        const requests = new Map();
        const results = new Map();
        const directory = join(this.directory, key);
        for (const file of await readdir(directory, { withFileTypes: true })) {
            if (!file.isFile())
                continue;
            const path = join(directory, file.name);
            // Under the lock, every leftover temporary belongs to an interrupted writer.
            if (TEMPORARY.test(file.name)) {
                await rm(path);
                continue;
            }
            const match = PAYLOAD.exec(file.name);
            if (match?.[1] === undefined || !ID.test(match[1]))
                continue;
            const info = await stat(path);
            if (match[2] === 'request')
                requests.set(match[1], info.size);
            else
                results.set(match[1], info.size);
        }
        for (const id of results.keys()) {
            if (!requests.has(id))
                await rm(this.path(key, id, 'result'));
        }
        if (requests.size === 0) {
            await rm(directory, { recursive: true, force: true });
            return undefined;
        }
        const metadata = JSON.parse(await readFile(this.metadataPath(key), 'utf8'));
        if (metadata.version !== 1 || typeof metadata.sessionId !== 'string' || sessionKey(metadata.sessionId) !== key) {
            throw new Error(`unsupported request log session ${key}`);
        }
        const info = await stat(this.metadataPath(key));
        const entries = [...requests].map(([id, bytes]) => ({
            id, sessionId: metadata.sessionId,
            createdAt: Number(id.slice(0, 13)), accessedAt: info.mtimeMs,
            bytes: bytes + (results.get(id) ?? 0), hasResult: results.has(id),
        }));
        return {
            key, sessionId: metadata.sessionId, accessedAt: info.mtimeMs, entries,
            bytes: info.size + entries.reduce((total, entry) => total + entry.bytes, 0),
        };
    }
    async checkSessionCapacity(session, additional) {
        if ((session?.bytes ?? 0) + additional <= this.maxBytes)
            return;
        // A session that cannot fit by itself is evicted whole, without discarding other sessions.
        if (session !== undefined)
            await this.removeSession(session);
        throw new RequestLogCapacityError();
    }
    async makeRoom(sessions, bytes, protectedSessionId) {
        let total = sessions.reduce((sum, session) => sum + session.bytes, 0);
        const removed = new Set();
        const oldest = [...sessions].sort((a, b) => a.accessedAt - b.accessedAt || a.sessionId.localeCompare(b.sessionId));
        for (const session of oldest) {
            if (total + bytes <= this.maxBytes)
                break;
            if (session.sessionId === protectedSessionId)
                continue;
            await this.removeSession(session);
            total -= session.bytes;
            removed.add(session.sessionId);
        }
        if (total + bytes > this.maxBytes)
            throw new RequestLogCapacityError();
        return sessions.filter(session => !removed.has(session.sessionId));
    }
    async removeSession(session) {
        const evicted = join(this.directory, `.evicted-${session.key}-${randomUUID()}`);
        // A crash during recursive removal must never expose a partially retained session.
        await rename(join(this.directory, session.key), evicted);
        await rm(evicted, { recursive: true, force: true });
    }
    async touch(key, sessions) {
        // Strictly increasing even when several accesses happen in one clock tick.
        const time = sessions.reduce((latest, session) => Math.max(latest, session.accessedAt + 1), Date.now()) / 1000;
        await utimes(this.metadataPath(key), time, time);
    }
    async write(path, data, id) {
        const temporary = join(dirname(path), `.${id}-${randomUUID()}.tmp`);
        try {
            const file = await open(temporary, 'wx', 0o600);
            try {
                await file.writeFile(data);
                await file.sync();
            }
            finally {
                await file.close();
            }
            await rename(temporary, path);
        }
        finally {
            await rm(temporary, { force: true });
        }
    }
}
/** Restore the exact saved request, with explicit experiment overrides and no live Session reads. */
export function requestForReplay(record, overrides = {}) {
    return structuredClone({ ...record.request, ...overrides });
}
/** Replay against a caller-supplied DSH runtime, using its current provider credentials. */
export async function* replayRequest(llm, log, id, overrides = {}, signal) {
    const record = await log.read(id);
    const timeout = AbortSignal.timeout(record.config.requestTimeoutMs);
    const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    requestSignal.throwIfAborted();
    yield* llm.stream({ ...requestForReplay(record, overrides), signal: requestSignal });
}
//# sourceMappingURL=request-log.js.map