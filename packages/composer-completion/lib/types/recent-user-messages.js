/** Cross-Session user-request references for composer completion. */
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
const FILE_VERSION = 1;
const REFERENCE_COUNT = 30;
const MAX_MESSAGE_CODE_POINTS = 100;
const RETAINED_CANDIDATE_COUNT = REFERENCE_COUNT * 4;
const storedMessageSchema = z.object({
    key: z.string().min(1),
    sessionId: z.string().min(1),
    messageId: z.string().min(1),
    text: z.string().refine(text => text.trim() !== '' && [...text].length <= MAX_MESSAGE_CODE_POINTS, `must contain 1-${MAX_MESSAGE_CODE_POINTS} Unicode code points`),
    sentAt: z.number().int().nonnegative(),
}).strict();
const persistedStateSchema = z.object({
    version: z.literal(FILE_VERSION),
    messages: z.array(storedMessageSchema),
    selectedKeys: z.array(z.string().min(1)).max(REFERENCE_COUNT),
    newMessagesSinceRotation: z.number().int().nonnegative(),
}).strict();
function expandHome(path) {
    if (path === '~')
        return homedir();
    if (path.startsWith('~/') || path.startsWith('~\\'))
        return join(homedir(), path.slice(2));
    return path;
}
function stateFilePath() {
    const configured = process.env.DSH_HOME;
    const root = configured === undefined || configured.trim() === ''
        ? join(homedir(), '.dsh')
        : resolve(expandHome(configured));
    return join(root, 'composer-completion', 'recent-user-messages.json');
}
function messageText(message) {
    return message.content
        .filter((block) => block.type === 'text')
        .map(block => block.text)
        .join('');
}
function storedMessage(sessionId, event) {
    if (event.data.source.kind !== 'user')
        return undefined;
    const text = messageText(event.data);
    if (text.trim() === '' || [...text].length > MAX_MESSAGE_CODE_POINTS)
        return undefined;
    const messageId = String(event.data.id);
    return {
        key: `${sessionId}:${messageId}`,
        sessionId,
        messageId,
        text,
        sentAt: event.time,
    };
}
function currentMessageIds(session) {
    const ids = new Set();
    for (const event of session.events) {
        if (event.type === 'user/message' && event.data.source.kind === 'user') {
            ids.add(String(event.data.id));
        }
    }
    return ids;
}
function selectionSignature(messages) {
    return messages.map(message => message.key).join('\n');
}
/** Persist, select, and cache-stabilize cross-Session user requests. */
export class RecentUserMessageStore {
    filePath;
    state;
    writes = Promise.resolve();
    writeFailure;
    lastSentSignature;
    constructor(filePath = stateFilePath()) {
        this.filePath = filePath;
        this.state = this.readState();
    }
    /** Record qualifying human messages only after their turn completes normally. */
    recordCompletedTurn(session, turnEnd) {
        if (turnEnd.data.reason.kind !== 'completed')
            return;
        const start = session.events.findLast(event => (event.seq < turnEnd.seq
            && event.type === 'turn/start'
            && event.data.turn === turnEnd.data.turn));
        if (start === undefined)
            return;
        const messages = [];
        for (const event of session.events) {
            if (event.seq <= start.seq || event.seq >= turnEnd.seq || event.type !== 'user/message')
                continue;
            const message = storedMessage(String(session.id), event);
            if (message !== undefined)
                messages.push(message);
        }
        if (this.addMessages(messages, true))
            this.scheduleWrite();
    }
    /** Select a frozen reference prefix, rotating only when a cache miss is expected. */
    async select(session, signal) {
        await this.flush();
        signal.throwIfAborted();
        const currentIds = currentMessageIds(session);
        const selected = this.selectedMessages(String(session.id), currentIds);
        const currentSignature = selectionSignature(selected);
        const cacheExpected = this.lastSentSignature !== undefined
            && this.lastSentSignature === currentSignature;
        if (!cacheExpected || this.state.newMessagesSinceRotation >= REFERENCE_COUNT) {
            this.rotate(String(session.id), currentIds);
            await this.flush();
        }
        const messages = this.selectedMessages(String(session.id), currentIds);
        return {
            messages: messages.map(message => ({ key: message.key, text: message.text })),
            signature: selectionSignature(messages),
        };
    }
    /** Mark the stable reference prefix as sent to the provider. */
    markSent(signature) {
        this.lastSentSignature = signature;
    }
    /** Wait for every admitted state-file replacement and surface write failures. */
    async flush() {
        await this.writes;
        if (this.writeFailure !== undefined)
            throw this.writeFailure;
    }
    readState() {
        try {
            return persistedStateSchema.parse(JSON.parse(readFileSync(this.filePath, 'utf8')));
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                return {
                    version: FILE_VERSION,
                    messages: [],
                    selectedKeys: [],
                    newMessagesSinceRotation: 0,
                };
            }
            throw new Error(`composer-completion: failed to read recent user messages from "${this.filePath}"`, { cause: error });
        }
    }
    addMessages(messages, countAsNew) {
        const known = new Set(this.state.messages.map(message => message.key));
        let added = 0;
        for (const message of messages) {
            if (known.has(message.key))
                continue;
            known.add(message.key);
            this.state.messages.push(message);
            added += 1;
        }
        if (added === 0)
            return false;
        if (countAsNew)
            this.state.newMessagesSinceRotation += added;
        this.retainCandidates();
        return true;
    }
    rotate(currentSessionId, currentIds) {
        const selected = this.eligibleMessages(currentSessionId, currentIds).slice(-REFERENCE_COUNT);
        this.state.selectedKeys = selected.map(message => message.key);
        this.state.newMessagesSinceRotation = 0;
        this.retainCandidates();
        this.scheduleWrite();
    }
    selectedMessages(currentSessionId, currentIds) {
        const byKey = new Map(this.state.messages.map(message => [message.key, message]));
        const seenMessageIds = new Set();
        const selected = [];
        for (const key of this.state.selectedKeys) {
            const message = byKey.get(key);
            if (message === undefined
                || message.sessionId === currentSessionId
                || currentIds.has(message.messageId)
                || seenMessageIds.has(message.messageId))
                continue;
            seenMessageIds.add(message.messageId);
            selected.push(message);
        }
        return selected;
    }
    eligibleMessages(currentSessionId, currentIds) {
        const seenMessageIds = new Set();
        return [...this.state.messages]
            .sort((left, right) => left.sentAt - right.sentAt || left.key.localeCompare(right.key))
            .filter((message) => {
            if (message.sessionId === currentSessionId
                || currentIds.has(message.messageId)
                || seenMessageIds.has(message.messageId))
                return false;
            seenMessageIds.add(message.messageId);
            return true;
        });
    }
    retainCandidates() {
        const selected = new Set(this.state.selectedKeys);
        const newest = [...this.state.messages]
            .sort((left, right) => right.sentAt - left.sentAt || right.key.localeCompare(left.key))
            .slice(0, RETAINED_CANDIDATE_COUNT);
        const keep = new Set([...selected, ...newest.map(message => message.key)]);
        this.state.messages = this.state.messages.filter(message => keep.has(message.key));
    }
    scheduleWrite() {
        const payload = `${JSON.stringify(this.state, null, 2)}\n`;
        const temporary = `${this.filePath}.${process.pid}.tmp`;
        this.writes = this.writes
            .then(async () => {
            await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
            await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 });
            await rename(temporary, this.filePath);
        })
            .catch((error) => {
            this.writeFailure ??= new Error(`composer-completion: failed to persist recent user messages to "${this.filePath}"`, { cause: error });
        });
    }
}
//# sourceMappingURL=recent-user-messages.js.map