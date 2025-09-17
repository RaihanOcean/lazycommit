import { dim } from 'kolorist';
import packageJson from '../../package.json';

export class KnownError extends Error {}

const indent = '    ';

export const handleCliError = (error: any) => {
	if (error instanceof Error && !(error instanceof KnownError)) {
		if (error.stack) {
			console.error(dim(error.stack.split('\n').slice(1).join('\n')));
		}
		console.error(`\n${indent}${dim(`lazycommit v${packageJson.version}`)}`);
		console.error(
			`\n${indent}Please open a Bug report with the information above:`
		);
		console.error(
			`${indent}https://github.com/KartikLabhshetwar/lazycommit/issues/new/choose`
		);
	}
};
