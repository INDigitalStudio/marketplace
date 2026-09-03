/** Self-contained terminal text utilities — avoids @earendil-works/pi-tui alias resolution issues. */

/** Strip ANSI escape sequences from a string. */
export function stripTerminalSequences(text: string): string {
	return text.replace(/\u001B\[[0-9;]*[a-zA-Z]/g, "");
}

/** Calculate the visible width of a string (ANSI sequences excluded, CJK counted as 2). */
export function visibleWidth(text: string): number {
	const plain = stripTerminalSequences(text);
	let width = 0;
	for (const ch of plain) {
		const code = ch.charCodeAt(0);
		if (
			(code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
			(code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) || // CJK Radicals
			(code >= 0xac00 && code <= 0xd7a3) || // Hangul Syllables
			(code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility
			(code >= 0xfe10 && code <= 0xfe19) || // Vertical Forms
			(code >= 0xfe30 && code <= 0xfe6f) || // CJK Compatibility Forms
			(code >= 0xff00 && code <= 0xff60) || // Fullwidth ASCII
			(code >= 0xffe0 && code <= 0xffe6) || // Fullwidth Symbols
			(code >= 0x20000 && code <= 0x2fffd) // CJK Unified Ideographs Extension B+
		) {
			width += 2;
		} else {
			width += 1;
		}
	}
	return width;
}

/** Truncate text to fit within the given visible width, appending suffix if truncated. */
export function truncateToWidth(text: string, maxVisibleWidth: number, suffix: string): string {
	if (maxVisibleWidth <= 0) return "";
	const suffixWidth = visibleWidth(suffix);
	const available = Math.max(0, maxVisibleWidth - suffixWidth);

	let current = "";
	let currentWidth = 0;
	const plain = stripTerminalSequences(text);

	// Walk the original text, tracking visible width of plain characters
	let plainIndex = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		// Skip ANSI escape sequences
		if (ch.charCodeAt(0) === 0x001b) {
			// Find end of escape sequence
			let j = i + 1;
			while (j < text.length && j - i < 20) {
				const nc = text.charCodeAt(j);
				if (nc >= 0x41 && nc <= 0x7a) break; // final letter
				j++;
			}
			i = j;
			continue;
		}
		if (plainIndex >= plain.length) break;
		const pch = plain[plainIndex];
		const code = pch.charCodeAt(0);
		const chWidth =
			(code >= 0x1100 && code <= 0x115f) ||
			(code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe10 && code <= 0xfe19) ||
			(code >= 0xfe30 && code <= 0xfe6f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6) ||
			(code >= 0x20000 && code <= 0x2fffd)
				? 2
				: 1;
		if (currentWidth + chWidth > available) break;
		current += text[i];
		currentWidth += chWidth;
		plainIndex++;
	}

	if (currentWidth + suffixWidth <= maxVisibleWidth) return text;
	return current + suffix;
}
