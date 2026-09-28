import * as path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: {
        // The real `vscode` module only exists inside the editor
        alias: { vscode: path.resolve(__dirname, 'test/vscode-mock.ts') },
    },
});
