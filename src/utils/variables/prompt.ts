// Prompt syntax is retained only for backwards-compatible parsing. It is
// intentionally discarded locally and never invokes storage or the network.
export async function processPrompt(
	_match: string,
	_variables: { [key: string]: string },
	_currentUrl: string,
): Promise<string> {
	return '';
}
