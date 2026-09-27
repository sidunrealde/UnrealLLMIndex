export interface SanitizedSource {
    /** Comments, string/char literal contents and preprocessor lines blanked. Used for structure. */
    code: string;
    /** Comments and preprocessor lines blanked, string literals kept. Used for display text. */
    display: string;
}

const isIdentChar = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_]/.test(c);

/**
 * Blanks out comments, literals and preprocessor directives while keeping every
 * character offset and newline in place, so offsets map 1:1 back to the original source.
 */
export function sanitize(src: string): SanitizedSource {
    const code = src.split('');
    const display = src.split('');
    const n = src.length;

    const blankCode = (i: number) => {
        if (code[i] !== '\n' && code[i] !== '\r') {
            code[i] = ' ';
        }
    };
    const blankBoth = (i: number) => {
        blankCode(i);
        if (display[i] !== '\n' && display[i] !== '\r') {
            display[i] = ' ';
        }
    };

    let i = 0;
    let atLineStart = true;
    while (i < n) {
        const c = src[i];
        const next = src[i + 1];

        if (c === '\n') {
            atLineStart = true;
            i++;
            continue;
        }

        // Preprocessor directive, including backslash-continued lines
        if (atLineStart && c === '#') {
            while (i < n) {
                if (src[i] === '\n') {
                    let j = i - 1;
                    if (src[j] === '\r') {
                        j--;
                    }
                    if (src[j] === '\\') {
                        i++;
                        continue;
                    }
                    break;
                }
                blankBoth(i);
                i++;
            }
            continue;
        }

        if (c !== ' ' && c !== '\t' && c !== '\r') {
            atLineStart = false;
        }

        // Line comment
        if (c === '/' && next === '/') {
            while (i < n && src[i] !== '\n') {
                blankBoth(i);
                i++;
            }
            continue;
        }

        // Block comment
        if (c === '/' && next === '*') {
            blankBoth(i);
            blankBoth(i + 1);
            i += 2;
            while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
                blankBoth(i);
                i++;
            }
            if (i < n) {
                blankBoth(i);
                blankBoth(i + 1);
                i += 2;
            }
            continue;
        }

        // Raw string literal R"delim( ... )delim"
        if (c === 'R' && next === '"' && !isIdentChar(src[i - 1])) {
            const open = src.indexOf('(', i + 2);
            if (open !== -1 && open - (i + 2) <= 16) {
                const delim = src.slice(i + 2, open);
                const close = src.indexOf(`)${delim}"`, open + 1);
                const end = close === -1 ? n : close + delim.length + 1;
                for (let k = i + 2; k < end; k++) {
                    blankCode(k);
                }
                i = end + 1;
                continue;
            }
        }

        // String literal, or char literal (but not a C++14 digit separator like 1'000)
        if (c === '"' || (c === '\'' && !(isIdentChar(src[i - 1]) && /[0-9A-Fa-f]/.test(next ?? '')))) {
            const quote = c;
            i++;
            while (i < n && src[i] !== quote && src[i] !== '\n') {
                if (src[i] === '\\') {
                    blankCode(i);
                    i++;
                }
                blankCode(i);
                i++;
            }
            i++;
            continue;
        }

        i++;
    }

    return { code: code.join(''), display: display.join('') };
}

/** Maps character offsets to 1-based line numbers. */
export class LineMap {
    private readonly starts: number[] = [0];

    constructor(text: string) {
        for (let i = 0; i < text.length; i++) {
            if (text[i] === '\n') {
                this.starts.push(i + 1);
            }
        }
    }

    lineOf(offset: number): number {
        let lo = 0;
        let hi = this.starts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (this.starts[mid] <= offset) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        return lo + 1;
    }
}
