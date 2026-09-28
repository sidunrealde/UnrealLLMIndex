import { parentPort } from 'worker_threads';
import { parseFileRows } from './rows';

/** Parses batches of engine files for syncEngineIndex. Bundled as dist/parseWorker.js. */
parentPort?.on('message', (message: { id: number; files: { abs: string; rel: string }[] }) => {
    parentPort!.postMessage({ id: message.id, results: message.files.map(f => parseFileRows(f.abs, f.rel)) });
});
