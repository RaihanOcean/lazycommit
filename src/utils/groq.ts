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
		// Groq doesn't support n > 1, so we need to make multiple requests
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
			
			// Combine all completions into a single response
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
			200,
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
