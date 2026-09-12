import type {ModApi} from '@commandcode/harness';
import {closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';

interface ModelMeta {
	context: number;
	input: number;
	output: number;
	cacheRead: number;
}

const META: Record<string, ModelMeta> = {
	'deepseek/deepseek-v4-pro': {context: 1_000_000, input: 0.66, output: 1.98, cacheRead: 0.022},
	'deepseek/deepseek-v4-flash': {context: 1_000_000, input: 0.15, output: 0.6, cacheRead: 0.003},
	'deepseek/deepseek-v4.1-flash': {context: 1_000_000, input: 0.15, output: 0.6, cacheRead: 0.003},
	'deepseek/deepseek-v4-flash-fast': {context: 1_000_000, input: 0.28, output: 0.56, cacheRead: 0.07},
	'deepseek/deepseek-v4-flash-vision-exp': {context: 1_000_000, input: 0.22, output: 0.66, cacheRead: 0.007},
	'meituan/LongCat-2.0:free': {context: 1_050_000, input: 0, output: 0, cacheRead: 0},
	'claude-sonnet-5': {context: 1_000_000, input: 2, output: 10, cacheRead: 0.2},
	'claude-sonnet-4-6': {context: 1_000_000, input: 3, output: 15, cacheRead: 0.3},
	'claude-opus-5': {context: 1_000_000, input: 5, output: 25, cacheRead: 0.5},
	'claude-opus-4-8': {context: 1_000_000, input: 5, output: 25, cacheRead: 0.5},
	'claude-haiku-4-5-20251001': {context: 200_000, input: 1, output: 5, cacheRead: 0.1},
	'gpt-5.6-sol': {context: 1_050_000, input: 5, output: 30, cacheRead: 0.5},
	'gpt-5.6-terra': {context: 1_050_000, input: 2, output: 12, cacheRead: 0.2},
	'gpt-5.6-luna': {context: 1_050_000, input: 0.2, output: 1.2, cacheRead: 0.02},
	'moonshotai/Kimi-K3': {context: 1_000_000, input: 3, output: 15, cacheRead: 0.3},
	'zai-org/GLM-5.3': {context: 1_000_000, input: 1.4, output: 4.4, cacheRead: 0.26},
	'xai/grok-4.5': {context: 500_000, input: 2, output: 6, cacheRead: 0.5},
	'google/gemini-3.8-flash': {context: 1_000_000, input: 1.5, output: 7.5, cacheRead: 0.15},
};

const DEFAULT_CONTEXT = 200_000;
const TAIL_BYTES = 1 << 20;
const MAX_WALK_BYTES = 32 << 20;
const MODEL_CHANGE = /^\{[^\n]*"type":"model_change"[^\n]*?"model":"([^"]+)"/gm;

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

function shortName(id: string): string {
	return id.replace(/^.*\//, '').replace(/:free$/, '');
}

function colorFor(pct: number): string {
	if (pct >= 0.85) return '\x1b[31m';
	if (pct >= 0.6) return '\x1b[33m';
	return '\x1b[32m';
}

function bar(pct: number): string {
	const filled = Math.max(0, Math.min(10, Math.round(pct * 10)));
	return colorFor(pct) + '█'.repeat(filled) + DIM + '░'.repeat(10 - filled) + RESET;
}

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
	return `${n}`;
}

/** Share of the current prompt served from cache. */
function hitPct(turn: Turn): number {
	return turn.context > 0 ? Math.round((turn.hit / turn.context) * 100) : 0;
}

function fmtCost(usd: number): string {
	if (usd === 0) return '$0';
	if (usd < 0.01) return `$${usd.toFixed(4)}`;
	return `$${usd.toFixed(3)}`;
}

interface Usage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd?: number;
}

/** Running session sums, accumulated across every request. */
interface Totals {
	in: number;
	out: number;
	cost: number;
}

/** One request's values: the current prompt breakdown. */
interface Turn {
	context: number;
	hit: number;
	miss: number;
}

interface Seed {
	model: string;
	effort: string;
	totals: Totals;
	turn: Turn;
}

function findSessionFile(sessionId: string): string | undefined {
	const root = join(homedir(), '.commandcode/projects');
	if (!existsSync(root)) return undefined;
	for (const dir of readdirSync(root)) {
		const candidate = join(root, dir, `${sessionId}.jsonl`);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

/**
 * The newest `model_change` in the session transcript. This is the authoritative
 * record of the session's model: /model writes one, and so does cmd.setModel() —
 * which is how automodel switches reach the session. meta.json is NOT updated by
 * setModel (a pick can sit there stale for a whole session), so it must not win.
 *
 * Reads the tail first and walks back only when a window has no entry, which keeps
 * a long transcript cheap to watch from the poll.
 */
function lastModelChange(file: string): string | undefined {
	try {
		let end = statSync(file).size;
		let budget = MAX_WALK_BYTES;
		while (end > 0 && budget > 0) {
			const length = Math.min(end, TAIL_BYTES, budget);
			const start = end - length;

			const fd = openSync(file, 'r');
			let text: string;
			try {
				const window = Buffer.alloc(length);
				readSync(fd, window, 0, length, start);
				text = window.toString('utf-8');
			} finally {
				closeSync(fd);
			}

			// Drop a leading partial line unless this window starts the file.
			if (start > 0) {
				const newline = text.indexOf('\n');
				text = newline === -1 ? '' : text.slice(newline + 1);
			}

			let last: string | undefined;
			for (const match of text.matchAll(MODEL_CHANGE)) last = match[1];
			if (last) return last;

			end = start;
			budget -= length;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

/**
 * Fallback for the window before the transcript exists: a fresh session gets no
 * `.jsonl` until its first commit, while `.meta.json` is already on disk.
 */
function readMetaModel(file: string): string | undefined {
	try {
		const meta = JSON.parse(readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf-8'));
		return typeof meta.model === 'string' ? meta.model : undefined;
	} catch {
		return undefined;
	}
}

/** Cost of one request: what the provider reported, else the model's rates. */
function requestCost(usage: Usage, model: string): number {
	if (typeof usage.costUsd === 'number' && usage.costUsd > 0) return usage.costUsd;

	const meta = META[model];
	if (!meta) return 0;

	const billed = Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens);
	return (
		(billed * meta.input +
			usage.outputTokens * meta.output +
			usage.cacheReadTokens * meta.cacheRead +
			usage.cacheWriteTokens * meta.input) /
		1_000_000
	);
}

/**
 * Fold one request into the session totals and return its per-turn values.
 * The live stream and the transcript replay both go through here, so a live
 * session and a resumed one can never drift apart.
 */
function fold(totals: Totals, usage: Usage, model: string): Turn {
	totals.in += usage.inputTokens;
	totals.out += usage.outputTokens;
	totals.cost += requestCost(usage, model);

	return {
		context: usage.inputTokens,
		hit: usage.cacheReadTokens,
		miss: Math.max(0, usage.inputTokens - usage.cacheReadTokens),
	};
}

/** Replay a transcript through fold() to restore a resumed session's numbers. */
function seedFromTranscript(sessionId: string): Seed {
	const seed: Seed = {
		model: '',
		effort: '',
		totals: {in: 0, out: 0, cost: 0},
		turn: {context: 0, hit: 0, miss: 0},
	};
	const file = findSessionFile(sessionId);
	if (!file) return seed;

	let text: string;
	try {
		text = readFileSync(file, 'utf-8');
	} catch {
		return seed;
	}

	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		let entry: {type?: string; model?: string; effort?: string; usage?: Usage};
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}

		if (entry.type === 'model_change') {
			seed.model = entry.model ?? '';
		} else if (entry.type === 'effort_change') {
			seed.effort = entry.effort ?? '';
		}

		const usage = entry.usage;
		if (usage && typeof usage.inputTokens === 'number') {
			// The model recorded on the message is the one actually used
			// (it also captures mod-driven switches, not just /model).
			if (entry.model) seed.model = entry.model;
			seed.turn = fold(seed.totals, usage, seed.model);
		}
	}

	return seed;
}

export default function (cmd: ModApi): void {
	let model = '';
	let effort = '';
	let lastSessionId = '';
	let sessionFile: string | undefined;
	let lastText: string | null = null;
	let liveCache: {size: number; model: string} | undefined;

	// Session sums (cumulative across requests) and the current prompt
	// breakdown (per turn), both maintained solely through fold().
	let totals: Totals = {in: 0, out: 0, cost: 0};
	let turn: Turn = {context: 0, hit: 0, miss: 0};

	function push(text: string | null): void {
		if (text === lastText) return;
		lastText = text;
		cmd.ui.setStatus(text);
	}

	/** The transcript's model, re-read only when the (append-only) file grew. */
	function transcriptModel(): string | undefined {
		if (!sessionFile) return undefined;
		try {
			const size = statSync(sessionFile).size;
			if (liveCache?.size !== size) {
				liveCache = {size, model: lastModelChange(sessionFile) ?? ''};
			}
			return liveCache.model || undefined;
		} catch {
			return undefined;
		}
	}

	function refresh(): void {
		// The transcript's last model_change is the live model (both /model and
		// automodel's setModel write it); meta.model only covers the window before a
		// fresh session has a transcript, and the request-tracked model is last resort.
		const current =
			transcriptModel() ?? (sessionFile ? readMetaModel(sessionFile) : undefined) ?? model;
		const meta = META[current];
		const max = meta?.context ?? DEFAULT_CONTEXT;
		const pct = Math.min(1, turn.context / max);

		const parts = [
			current ? shortName(current) : DIM + '—' + RESET,
			effort || DIM + '—' + RESET,
			`[${bar(pct)}] ${fmtTokens(turn.context)}/${fmtTokens(max)} ${Math.round(pct * 100)}%`,
			`In: ${fmtTokens(totals.in)} (Miss: ${fmtTokens(turn.miss)} ; Hit: ${fmtTokens(turn.hit)} ${hitPct(turn)}%)`,
			`Out: ${fmtTokens(totals.out)}`,
			fmtCost(totals.cost),
		];
		push(parts.join(DIM + ' | ' + RESET));
	}

	cmd.on('run_start', (event) => {
		if (event.type !== 'run_start') return;

		if (event.sessionId !== lastSessionId) {
			lastSessionId = event.sessionId;

			// Seed from the transcript so a resumed session shows the real
			// context size and accumulated cost instead of resetting to zero.
			const seed = seedFromTranscript(event.sessionId);
			model = seed.model;
			effort = seed.effort;
			totals = seed.totals;
			turn = seed.turn;
			liveCache = undefined;
		}

		// A fresh session's transcript does not exist until its first commit, so
		// keep re-resolving it - the poll below stays dead until this succeeds.
		if (!sessionFile) sessionFile = findSessionFile(event.sessionId);
		refresh();
	});

	cmd.on('model_request_start', (event) => {
		if (event.type !== 'model_request_start') return;
		if (event.model !== model) {
			model = event.model;
			effort = '';
		}
		refresh();
	});

	cmd.on('model_request_end', (event) => {
		if (event.type !== 'model_request_end') return;

		if (event.model !== model) effort = '';
		model = event.model;
		if (event.effort) effort = event.effort;

		turn = fold(totals, event.usage as Usage, model);
		refresh();
	});

	cmd.hooks({
		onSessionEnd: () => {
			sessionFile = undefined;
			liveCache = undefined;
			push(null);
		},
	});

	// Neither /model nor a mod's setModel fires an event a mod can see, so poll the
	// session files and repaint when the model actually changed. refresh() is
	// memoized, so this is a no-op unless something on the line differs.
	const poll = setInterval(() => {
		if (!sessionFile && lastSessionId) sessionFile = findSessionFile(lastSessionId);
		if (sessionFile) refresh();
	}, 1000);
	// Never keep the process alive just for the poll.
	if (typeof poll.unref === 'function') poll.unref();
}
