import Groq from 'groq-sdk';
import { KnownError } from './error.js';
import type { CommitType } from './config.js';
import { generatePrompt } from './prompt.js';
import { chunkDiff } from './git.js';

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

export const generateCommitMessage = async (
	apiKey: string,
	model: string,
	locale: string,
	diff: string,
	completions: number,
	maxLength: number,
	type: CommitType,
	timeout: number,
	proxy?: string
) => {
	try {
		const completion = await createChatCompletion(
			apiKey,
			model,
			[
				{
					role: 'system',
					content: generatePrompt(locale, maxLength, type),
				},
				{
					role: 'user',
					content: diff,
				},
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

		return deduplicateMessages(
			completion.choices
				.filter((choice) => choice.message?.content)
				.map((choice) => sanitizeMessage(choice.message!.content as string))
		);
	} catch (error) {
		const errorAsAny = error as any;
		if (errorAsAny.code === 'ENOTFOUND') {
			throw new KnownError(
				`Error connecting to ${errorAsAny.hostname} (${errorAsAny.syscall}). Are you connected to the internet?`
			);
		}

		throw errorAsAny;
	}
};

export const generateCommitMessageFromChunks = async (
	apiKey: string,
	model: string,
	locale: string,
	diff: string,
	completions: number,
	maxLength: number,
	type: CommitType,
	timeout: number,
	proxy?: string,
	chunkSize: number = 6000
) => {
	const chunks = chunkDiff(diff, chunkSize);
	
	if (chunks.length === 1) {
		try {
			return await generateCommitMessage(
				apiKey,
				model,
				locale,
				diff,
				completions,
				maxLength,
				type,
				timeout,
				proxy
			);
		} catch (error) {
			throw new KnownError(`Failed to generate commit message: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	}

	// Multiple chunks - generate commit messages for each chunk
	const chunkMessages: string[] = [];
	
	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		const chunkPrompt = `This is part ${i + 1} of ${chunks.length} of a large diff. 
Please generate a commit message that describes the changes in this specific part.
Focus on the most significant changes in this chunk.

${chunk}`;

		try {
			const messages = await generateCommitMessage(
				apiKey,
				model,
				locale,
				chunkPrompt,
				1,
				maxLength,
				type,
				timeout,
				proxy
			);
			
			if (messages.length > 0) {
				chunkMessages.push(messages[0]);
			}
		} catch (error) {
			console.warn(`Failed to process chunk ${i + 1}:`, error instanceof Error ? error.message : 'Unknown error');
		}
	}

	if (chunkMessages.length === 0) {
		throw new KnownError('Failed to generate commit messages for any chunks');
	}

	// If we have multiple chunk messages, try to combine them intelligently
	if (chunkMessages.length > 1) {
		const combinedPrompt = `I have ${chunkMessages.length} commit messages for different parts of a large change:

${chunkMessages.map((msg, i) => `${i + 1}. ${msg}`).join('\n')}

Please generate a single, comprehensive commit message that captures the overall changes. 
The message should be concise but cover the main aspects of all the changes.`;

		try {
			const combinedMessages = await generateCommitMessage(
				apiKey,
				model,
				locale,
				combinedPrompt,
				completions,
				maxLength,
				type,
				timeout,
				proxy
			);
			
			return combinedMessages;
		} catch (error) {
			// If combining fails, return the individual chunk messages
			return chunkMessages;
		}
	}

	return chunkMessages;
};
