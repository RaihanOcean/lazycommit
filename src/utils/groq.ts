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
		.replace(/^["']|["']\.?$/g, '')
		.replace(/[\n\r]/g, '')
		.replace(/(\w)\.$/, '$1');

const enforceMaxLength = (message: string, maxLength: number): string => {
    if (message.length <= maxLength) return message;
    
    // Try to find a good breaking point that preserves meaning
    const cut = message.slice(0, maxLength);
    
    // Look for sentence endings first (., !, ?)
    const sentenceEnd = Math.max(
        cut.lastIndexOf('. '),
        cut.lastIndexOf('! '),
        cut.lastIndexOf('? ')
    );
    
    if (sentenceEnd > maxLength * 0.7) {
        return cut.slice(0, sentenceEnd + 1);
    }
    
    // Look for comma or semicolon as secondary break point
    const clauseEnd = Math.max(
        cut.lastIndexOf(', '),
        cut.lastIndexOf('; ')
    );
    
    if (clauseEnd > maxLength * 0.6) {
        return cut.slice(0, clauseEnd + 1);
    }
    
    // Fall back to word boundary
    const lastSpace = cut.lastIndexOf(' ');
    if (lastSpace > maxLength * 0.5) {
        return cut.slice(0, lastSpace);
    }
    
    // Last resort: hard cut but add ellipsis if it seems incomplete
    if (message.length > maxLength + 10) {
        return cut + '...';
    }
    
    return cut;
};

const deduplicateMessages = (array: string[]) => Array.from(new Set(array));

const conventionalPrefixes = [
    'feat:', 'fix:', 'docs:', 'style:', 'refactor:', 'perf:', 'test:', 'build:', 'ci:', 'chore:', 'revert:'
];

const deriveMessageFromReasoning = (text: string, maxLength: number): string | null => {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    
    // Try to find a conventional-style line inside reasoning
    const match = cleaned.match(/\b(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)\b\s*:?\s+[^.\n]+/i);
    let candidate = match ? match[0] : cleaned.split(/[.!?]/)[0];
    
    // If no conventional prefix found, try to extract a meaningful sentence
    if (!match && candidate.length < 10) {
        const sentences = cleaned.split(/[.!?]/).filter(s => s.trim().length > 10);
        if (sentences.length > 0) {
            candidate = sentences[0].trim();
        }
    }
    
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
    if (!candidate || candidate.length < 5) return null;
    
    // Only enforce max length if it's significantly over
    if (candidate.length > maxLength * 1.2) {
        candidate = enforceMaxLength(candidate, maxLength);
    }
    
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
	const prompt = summary;
	const completion = await createChatCompletion(
		apiKey,
		model,
		[
			{ role: 'system', content: generatePrompt(locale, maxLength, type) },
			{ role: 'user', content: prompt },
		],
		0.3, // Lower temperature for more consistent, focused responses
		1,
		0,
		0,
		Math.max(300, maxLength * 12),
		completions,
		timeout,
		proxy
	);

    const messages = (completion.choices || [])
        .map((c) => c.message?.content || '')
        .map((t) => sanitizeMessage(t as string))
        .filter(Boolean)
        .map((t) => {
            // Only enforce max length if significantly over limit
            if (t.length > maxLength * 1.1) {
                return enforceMaxLength(t, maxLength);
            }
            return t;
        })
        .filter(msg => msg.length >= 10); // Ensure minimum meaningful length

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
