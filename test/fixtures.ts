import * as fs from 'fs';
import * as path from 'path';

export const SAMPLE_GAME = path.join(__dirname, 'fixtures/SampleGame');

/**
 * Copies a fixture without generated folders: an editor with the extension installed writes
 * .llm-index/ (and possibly .llm-memory/) into the fixture when this repo is open.
 */
export function copyFixture(from: string, to: string) {
    fs.cpSync(from, to, { recursive: true, filter: src => !/[\/]\.llm-(index|memory)([\/]|$)/.test(src) });
}
