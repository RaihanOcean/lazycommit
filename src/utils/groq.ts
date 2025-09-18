import Groq from 'groq-sdk';
import { KnownError } from './error.js';
import type { CommitType } from './config.js';
import { generatePrompt } from './prompt.js';

const createChatCompletion = async (
	apiKey: string,
	model: string,
	messages: Array<{ role: string; content: string }>,
	temperature: number,
	top_p: number,
	frequency_penalty: number,
	presence_penalty: number,
	max_tokens: number,
	n: number,
	timeout: number,
	proxy?: string
) => {
	const client = new Groq({
		apiKey,
		timeout,
	});

	try {
		if (n > 1) {
			const completions = await Promise.all(
				Array.from({ length: n }, () =>
					client.chat.completions.create({
						model,
						messages: messages as any,
						temperature,
						top_p,
						frequency_penalty,
						presence_penalty,
						max_tokens,
						n: 1,
					})
				)
			);
			
			return {
				choices: completions.flatMap(completion => completion.choices),
			};
		}

		const completion = await client.chat.completions.create({
			model,
			messages: messages as any,
			temperature,
			top_p,
			frequency_penalty,
			presence_penalty,
			max_tokens,
			n: 1,
		});

		return completion;
	} catch (error: any) {
		if (error instanceof Groq.APIError) {
			let errorMessage = `Groq API Error: ${error.status} - ${error.name}`;
			
			if (error.message) {
				errorMessage += `\n\n${error.message}`;
			}

			if (error.status === 500) {
				errorMessage += '\n\nCheck the API status: https://console.groq.com/status';
			}

			if (error.status === 413 || (error.message && error.message.includes('rate_limit_exceeded'))) {
				errorMessage += '\n\n💡 Tip: Your diff is too large. Try:\n' +
					'1. Commit files in smaller batches\n' +
					'2. Exclude large files with --exclude\n' +
					'3. Use a different model with --model\n' +
					'4. Check if you have build artifacts staged (dist/, .next/, etc.)';
			}

			throw new KnownError(errorMessage);
		}

		if (error.code === 'ENOTFOUND') {
			throw new KnownError(
				`Error connecting to ${error.hostname} (${error.syscall}). Are you connected to the internet?`
			);
		}

		throw error;
	}
};

const sanitizeMessage = (message: string) =>
	message
		.trim()
		.replace(/[\n\r]/g, '')
		.replace(/(\w)\.$/, '$1');

const deduplicateMessages = (array: string[]) => Array.from(new Set(array));

const conventionalPrefixes = [
    'feat:', 'fix:', 'docs:', 'style:', 'refactor:', 'perf:', 'test:', 'build:', 'ci:', 'chore:', 'revert:'
];

const deriveMessageFromReasoning = (text: string, maxLength: number): string | null => {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    // Try to find a conventional-style line inside reasoning
    const match = cleaned.match(/\b(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)\b\s*:?\s+[^.\n]+/i);
    let candidate = match ? match[0] : cleaned.split(/[.!?]/)[0];
    // Ensure prefix formatting: if starts with a known type w/o colon, add colon
    const lower = candidate.toLowerCase();
    for (const prefix of conventionalPrefixes) {
        const p = prefix.slice(0, -1); // without colon
        if (lower.startsWith(p + ' ') && !lower.startsWith(prefix)) {
            candidate = p + ': ' + candidate.slice(p.length + 1);
            break;
        }
    }
    candidate = sanitizeMessage(candidate);
    if (!candidate) return null;
    if (candidate.length > maxLength) candidate = candidate.slice(0, maxLength);
    return candidate;
};


export const generateCommitMessageFromSummary = async (
	apiKey: string,
	model: string,
	locale: string,
	summary: string,
	completions: number,
	maxLength: number,
	type: CommitType,
	timeout: number,
	proxy?: string
) => {
	const prompt = `This is a compact summary of staged changes. Generate a single, concise commit message within ${maxLength} characters that reflects the overall intent.\n\n${summary}`;
	const completion = await createChatCompletion(
		apiKey,
		model,
		[
			{ role: 'system', content: generatePrompt(locale, maxLength, type) },
			{ role: 'user', content: prompt },
		],
		0.7,
		1,
		0,
		0,
		Math.max(200, maxLength * 8),
		completions,
		timeout,
		proxy
	);

	const messages = (completion.choices || [])
		.map((c) => c.message?.content || '')
		.map((t) => sanitizeMessage(t as string))
		.filter(Boolean);

	if (messages.length > 0) return deduplicateMessages(messages);

	const reasons = (completion.choices as any[])
		.map((c:any)=>c.message?.reasoning || '')
		.filter(Boolean) as string[];
	for (const r of reasons) {
		const derived = deriveMessageFromReasoning(r, maxLength);
		if (derived) return [derived];
	}

	return [];
};
