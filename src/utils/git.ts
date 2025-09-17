import { execa } from 'execa';
import { KnownError } from './error.js';

export const assertGitRepo = async () => {
	const { stdout, failed } = await execa(
		'git',
		['rev-parse', '--show-toplevel'],
		{ reject: false }
	);

	if (failed) {
		throw new KnownError('The current directory must be a Git repository!');
	}

	return stdout;
};

const excludeFromDiff = (path: string) => `:(exclude)${path}`;

const filesToExclude = [
	'package-lock.json',
	'pnpm-lock.yaml',
	'node_modules/**',
	'dist/**',
	'build/**',
	'.next/**',
	'coverage/**',
	'.nyc_output/**',
	'*.log',
	'*.tmp',
	'*.temp',
	'*.cache',
	'.DS_Store',
	'Thumbs.db',
	'*.min.js',
	'*.min.css',
	'*.bundle.js',
	'*.bundle.css',
	'*.lock',
].map(excludeFromDiff);

export const getStagedDiff = async (excludeFiles?: string[]) => {
	const diffCached = ['diff', '--cached', '--diff-algorithm=minimal'];
	const { stdout: files } = await execa('git', [
		...diffCached,
		'--name-only',
		...filesToExclude,
		...(excludeFiles ? excludeFiles.map(excludeFromDiff) : []),
	]);

	if (!files) {
		return;
	}

	const { stdout: diff } = await execa('git', [
		...diffCached,
		...filesToExclude,
		...(excludeFiles ? excludeFiles.map(excludeFromDiff) : []),
	]);

	return {
		files: files.split('\n'),
		diff,
	};
};

export const getDetectedMessage = (files: string[]) =>
	`Detected ${files.length.toLocaleString()} staged file${
		files.length > 1 ? 's' : ''
	}`;

// Rough estimation: 1 token ≈ 4 characters for English text
export const estimateTokenCount = (text: string): number => {
	return Math.ceil(text.length / 4);
};

// Split diff into chunks that fit within token limits
export const chunkDiff = (diff: string, maxTokens: number = 4000): string[] => {
	const estimatedTokens = estimateTokenCount(diff);
	
	if (estimatedTokens <= maxTokens) {
		return [diff];
	}

	const chunks: string[] = [];
	const lines = diff.split('\n');
	let currentChunk = '';
	let currentTokens = 0;

	for (const line of lines) {
		const lineTokens = estimateTokenCount(line);
		
		// If adding this line would exceed the limit, start a new chunk
		if (currentTokens + lineTokens > maxTokens && currentChunk.length > 0) {
			chunks.push(currentChunk.trim());
			currentChunk = line + '\n';
			currentTokens = lineTokens;
		} else {
			currentChunk += line + '\n';
			currentTokens += lineTokens;
		}
	}

	// Add the last chunk if it has content
	if (currentChunk.trim().length > 0) {
		chunks.push(currentChunk.trim());
	}

	return chunks;
};

// Get a summary of changes for very large diffs
export const getDiffSummary = async (excludeFiles?: string[]) => {
	const diffCached = ['diff', '--cached', '--diff-algorithm=minimal'];
	const { stdout: files } = await execa('git', [
		...diffCached,
		'--name-only',
		...filesToExclude,
		...(excludeFiles ? excludeFiles.map(excludeFromDiff) : []),
	]);

	if (!files) {
		return null;
	}

	const fileList = files.split('\n').filter(Boolean);
	
	// Get stats for each file
	const fileStats = await Promise.all(
		fileList.map(async (file) => {
			try {
				const { stdout: stat } = await execa('git', [
					...diffCached,
					'--numstat',
					'--',
					file
				]);
				const [additions, deletions] = stat.split('\t').slice(0, 2).map(Number);
				return {
					file,
					additions: additions || 0,
					deletions: deletions || 0,
					changes: (additions || 0) + (deletions || 0)
				};
			} catch {
				return { file, additions: 0, deletions: 0, changes: 0 };
			}
		})
	);

	return {
		files: fileList,
		fileStats,
		totalChanges: fileStats.reduce((sum, stat) => sum + stat.changes, 0)
	};
};

export const splitDiffByFile = (diff: string): string[] => {
	const parts: string[] = [];
	let current = '';
	const lines = diff.split('\n');
	for (const line of lines) {
		if (line.startsWith('diff --git ')) {
			if (current.trim().length > 0) parts.push(current.trim());
			current = line + '\n';
		} else {
			current += line + '\n';
		}
	}
	if (current.trim().length > 0) parts.push(current.trim());
	return parts;
};
