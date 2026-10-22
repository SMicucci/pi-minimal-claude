/**
 * Thin client for an optional local judge model (REST, `/v1/systemone`).
 *
 * Every feature that uses it degrades gracefully: when the judge is not
 * configured or not reachable, callers get `{ ok: false }` and fall back to
 * asking the user (or to their conservative default).
 */

export interface JudgeResult {
	ok: boolean;
	/** Probability of the "yes" answer. */
	p: number;
	conf: number;
}

export interface JudgeBinaryQuestion {
	state: unknown;
	key: string;
	question: string;
	yes: string;
	no: string;
}

const DEFAULT_TIMEOUT_MS = 4000;

function judgeUrl(): string | undefined {
	const raw = process.env.PI_JUDGE_URL;
	if (raw === undefined) return "http://127.0.0.1:11438/v1/systemone";
	const trimmed = raw.trim();
	if (!trimmed || trimmed.toLowerCase() === "off") return undefined;
	return trimmed;
}

export function judgeEnabled(): boolean {
	return judgeUrl() !== undefined;
}

export async function judge(
	state: unknown,
	key: string,
	question: string,
	yes: string,
	no: string,
	signal?: AbortSignal,
): Promise<JudgeResult> {
	const url = judgeUrl();
	if (!url) return { ok: false, p: Number.NaN, conf: 0 };

	const timeoutMs = Number(process.env.PI_JUDGE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
	const timeout = AbortSignal.timeout(Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				state,
				questions: { [key]: { type: "choice", instructions: question, criteria: { A: yes, B: no } } },
			}),
			signal: combined,
		});
		const payload = (await response.json()) as {
			answers?: Record<string, { probabilities?: { A?: number }; confidence?: number }>;
		};
		const answer = payload.answers?.[key];
		if (!answer) return { ok: false, p: Number.NaN, conf: 0 };
		return {
			ok: true,
			p: typeof answer.probabilities?.A === "number" ? answer.probabilities.A : Number.NaN,
			conf: typeof answer.confidence === "number" ? answer.confidence : 0,
		};
	} catch {
		return { ok: false, p: Number.NaN, conf: 0 };
	}
}
