import { testSuite } from 'manten';

export default testSuite(({ describe }) => {
	describe('Groq', ({ runTestSuite }) => {
		runTestSuite(import('./conventional-commits.js'));
	});
});
